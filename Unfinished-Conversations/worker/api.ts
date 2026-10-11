import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { CATEGORIES, CHUNK_BYTES, MAX_AUDIO_BYTES, MAX_IMAGE_BYTES, type Activity, type Category, type Entry, type Photo, calls } from "../shared";
import { type AiEnv, analyzeMemory, suggestChapters, summarize } from "./ai";
import { ensureSchema } from "./schema";

export type UcEnv = AiEnv & { UC_DB: D1Database };

type User = { id: string; email: string; name: string; prefs: string };
type App = { Bindings: UcEnv; Variables: { user: User | null } };
type Ctx = Context<App>;

const COOKIE = "uc_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const AUDIO_TYPES = ["audio/webm", "audio/mp4", "audio/ogg", "audio/mpeg", "audio/wav", "audio/aac", "audio/x-m4a"];

// Direct statements of imminent self-harm intent. Ordinary sadness, longing and
// "I miss you so much it hurts" are grief, not emergencies, and never match.
const CRISIS =
	/kill(ing)? myself|end(ing)? my (own )?life|suicid|i want to die|wish i (was|were) dead|better off dead|(don'?t|do not) want to (live|be here|be alive)|(hurt|harm)(ing)? myself|no reason to live|end it all|take my (own )?life|join you soon/i;

const encoder = new TextEncoder();
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomToken = (bytes = 32) => toHex(crypto.getRandomValues(new Uint8Array(bytes)).buffer);
const sha256 = async (value: string) => toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

async function hashPassword(password: string, salt: string) {
	const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
	// 100,000 iterations is the most Cloudflare Workers allows.
	return toHex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: 100_000 }, key, 256));
}

function safeEqual(a: string, b: string) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

const fail = (status: ContentfulStatusCode, message: string): never => {
	throw new HTTPException(status, { message });
};

async function json(c: Ctx) {
	try {
		const body = await c.req.json();
		if (body && typeof body === "object") return body as Record<string, unknown>;
	} catch {
		// fall through
	}
	return fail(400, "That request couldn't be read.");
}

const line = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
/** Long text keeps its line breaks. There is no word limit; the cap only stops abuse. */
const prose = (value: unknown, max = 200_000) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const dateOnly = (value: unknown) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
const placeholders = (n: number) => Array(n).fill("?").join(",");

const requireUser = (c: Ctx) => c.get("user") ?? fail(401, "Please sign in.");
const prefsOf = (user: User) => ({ ai: false, reminders: false, ...(JSON.parse(user.prefs || "{}") as object) }) as { ai: boolean; reminders: boolean };

type LovedRow = { id: string; owner_id: string; name: string; nickname: string; relationship: string; photo_asset_id: string | null; birth_date: string | null; death_date: string | null };

const lovedOut = (r: LovedRow) => ({
	id: r.id,
	name: r.name,
	nickname: r.nickname,
	relationship: r.relationship,
	photoAssetId: r.photo_asset_id,
	birthDate: r.birth_date,
	deathDate: r.death_date,
});

/** Every lookup of someone's private data goes through an owner check like this one. */
async function ownLovedOne(c: Ctx, id: string) {
	const user = requireUser(c);
	const row = await c.env.UC_DB.prepare("SELECT * FROM loved_ones WHERE id = ? AND owner_id = ?").bind(id, user.id).first<LovedRow>();
	return row ?? fail(404, "Not found.");
}

type EntryRow = {
	id: string;
	owner_id: string;
	loved_one_id: string;
	type: Entry["type"];
	title: string;
	content: string;
	transcript: string;
	audio_asset_id: string | null;
	duration_ms: number | null;
	tags: string;
	draft: number;
	created_at: string;
	updated_at: string;
};

const ENTRY_SELECT = "SELECT e.*, a.duration_ms FROM entries e LEFT JOIN assets a ON a.id = e.audio_asset_id";

async function ownEntry(c: Ctx, id: string) {
	const user = requireUser(c);
	const row = await c.env.UC_DB.prepare(`${ENTRY_SELECT} WHERE e.id = ? AND e.owner_id = ?`).bind(id, user.id).first<EntryRow>();
	return row ?? fail(404, "Not found.");
}

/** Attaches photographs and categories to a page of entries in two queries. */
async function hydrate(db: D1Database, rows: EntryRow[]): Promise<Entry[]> {
	if (!rows.length) return [];
	const ids = rows.map((r) => r.id);
	const [photos, categories] = await Promise.all([
		db.prepare(`SELECT entry_id, asset_id, caption FROM entry_photos WHERE entry_id IN (${placeholders(ids.length)}) ORDER BY position`).bind(...ids).all<{ entry_id: string; asset_id: string; caption: string }>(),
		db.prepare(`SELECT id, entry_id, name, source, status FROM categories WHERE entry_id IN (${placeholders(ids.length)}) AND status != 'rejected'`).bind(...ids).all<Category & { entry_id: string }>(),
	]);
	return rows.map((r) => ({
		id: r.id,
		lovedOneId: r.loved_one_id,
		type: r.type,
		title: r.title,
		content: r.content,
		transcript: r.transcript,
		audioAssetId: r.audio_asset_id,
		durationMs: r.duration_ms,
		tags: JSON.parse(r.tags || "[]"),
		draft: !!r.draft,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		photos: photos.results.filter((p) => p.entry_id === r.id).map((p) => ({ assetId: p.asset_id, caption: p.caption })),
		categories: categories.results.filter((k) => k.entry_id === r.id).map(({ id, name, source, status }) => ({ id, name, source, status })),
	}));
}

/** Photographs the person actually owns, in the order given. */
async function ownPhotos(c: Ctx, value: unknown): Promise<Photo[]> {
	const user = requireUser(c);
	if (!Array.isArray(value)) return [];
	const wanted = value.slice(0, 40).map((p) => ({ assetId: line((p as Photo)?.assetId, 40), caption: line((p as Photo)?.caption, 300) })).filter((p) => p.assetId);
	if (!wanted.length) return [];
	const { results } = await c.env.UC_DB
		.prepare(`SELECT id FROM assets WHERE owner_id = ? AND kind = 'image' AND complete = 1 AND id IN (${placeholders(wanted.length)})`)
		.bind(user.id, ...wanted.map((p) => p.assetId))
		.all<{ id: string }>();
	const mine = new Set(results.map((r) => r.id));
	return wanted.filter((p) => mine.has(p.assetId));
}

async function ownAsset(c: Ctx, id: unknown, kind: "audio" | "image") {
	const user = requireUser(c);
	const assetId = line(id, 40);
	if (!assetId) return null;
	const row = await c.env.UC_DB.prepare("SELECT id FROM assets WHERE id = ? AND owner_id = ? AND kind = ? AND complete = 1").bind(assetId, user.id, kind).first();
	return row ? assetId : fail(400, "That file couldn't be found. Please try uploading it again.");
}

/** Removes a file once nothing refers to it any more, so sharing a memory never leaves a broken copy behind. */
async function releaseAssets(db: D1Database, ids: (string | null)[]) {
	for (const id of new Set(ids.filter((x): x is string => !!x))) {
		const used = await db
			.prepare(
				`SELECT 1 WHERE EXISTS (SELECT 1 FROM entries WHERE audio_asset_id = ?1) OR EXISTS (SELECT 1 FROM entry_photos WHERE asset_id = ?1)
				 OR EXISTS (SELECT 1 FROM contributions WHERE audio_asset_id = ?1) OR EXISTS (SELECT 1 FROM contribution_photos WHERE asset_id = ?1)
				 OR EXISTS (SELECT 1 FROM loved_ones WHERE photo_asset_id = ?1) OR EXISTS (SELECT 1 FROM activity_notes WHERE asset_id = ?1)`,
			)
			.bind(id)
			.first();
		if (!used) await db.prepare("DELETE FROM assets WHERE id = ?").bind(id).run();
	}
}

const app = new Hono<App>();

app.onError((err, c) => {
	if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
	// Never log request bodies: they are someone's private words.
	console.error("unfinished-conversations: unhandled error on", c.req.method, c.req.routePath);
	return c.json({ error: "Something went wrong on our side. Please try again." }, 500);
});

app.use("*", async (c, next) => {
	if (c.req.method !== "GET") {
		const origin = c.req.header("origin");
		if (origin && new URL(origin).host !== new URL(c.req.url).host) fail(403, "Cross-site requests are not allowed.");
	}
	await ensureSchema(c.env.UC_DB);
	const token = getCookie(c, COOKIE);
	const user = token
		? await c.env.UC_DB
				.prepare("SELECT u.id, u.email, u.name, u.prefs FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?")
				.bind(await sha256(token), now())
				.first<User>()
		: null;
	c.set("user", user);
	c.header("Cache-Control", "no-store");
	await next();
});

// ------------------------------------------------------------------ account

async function startSession(c: Ctx, userId: string) {
	const token = randomToken();
	await c.env.UC_DB
		.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
		.bind(await sha256(token), userId, new Date(Date.now() + SESSION_SECONDS * 1000).toISOString())
		.run();
	setCookie(c, COOKIE, token, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_SECONDS });
}

app.post("/auth/signup", async (c) => {
	const body = await json(c);
	const name = line(body.name, 80);
	const email = line(body.email, 200).toLowerCase();
	const password = typeof body.password === "string" ? body.password : "";
	if (!name) fail(400, "Please tell us your name.");
	if (!validEmail(email)) fail(400, "That email address doesn't look right.");
	if (password.length < 8) fail(400, "Please choose a password of at least 8 characters.");
	const db = c.env.UC_DB;
	if (await db.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) fail(409, "There's already an account with that email. Try signing in.");
	const id = uuid();
	const salt = randomToken(16);
	await db
		.prepare("INSERT INTO users (id, email, name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(id, email, name, await hashPassword(password, salt), salt, now())
		.run();
	await startSession(c, id);
	return c.json({ ok: true });
});

app.post("/auth/login", async (c) => {
	const body = await json(c);
	const row = await c.env.UC_DB
		.prepare("SELECT id, password_hash, password_salt FROM users WHERE email = ?")
		.bind(line(body.email, 200).toLowerCase())
		.first<{ id: string; password_hash: string; password_salt: string }>();
	// Hash even when the account doesn't exist so both cases take the same time.
	const hash = await hashPassword(typeof body.password === "string" ? body.password : "", row?.password_salt ?? "no-such-account");
	if (!row || !safeEqual(hash, row.password_hash)) return fail(401, "That email and password don't match.");
	await startSession(c, row.id);
	return c.json({ ok: true });
});

app.post("/auth/logout", async (c) => {
	const token = getCookie(c, COOKIE);
	if (token) await c.env.UC_DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
	deleteCookie(c, COOKIE, { path: "/" });
	return c.json({ ok: true });
});

app.get("/me", async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ user: null, prefs: { ai: false, reminders: false }, lovedOnes: [], invites: [], aiService: false });
	const db = c.env.UC_DB;
	const [loved, invites] = await Promise.all([
		db.prepare("SELECT * FROM loved_ones WHERE owner_id = ? ORDER BY created_at").bind(user.id).all<LovedRow>(),
		db
			.prepare(
				`SELECT m.invite_token AS token, m.role, c.name AS "collectionName", u.name AS "inviterName"
				 FROM collection_members m JOIN collections c ON c.id = m.collection_id JOIN users u ON u.id = c.owner_id
				 WHERE m.email = ? AND m.status = 'invited' AND m.invite_token IS NOT NULL`,
			)
			.bind(user.email)
			.all(),
	]);
	return c.json({
		user: { id: user.id, name: user.name, email: user.email },
		prefs: prefsOf(user),
		lovedOnes: loved.results.map(lovedOut),
		invites: invites.results,
		// Whether suggestions come from Claude or from basic keyword matching.
		aiService: !!c.env.ANTHROPIC_API_KEY,
	});
});

app.patch("/me", async (c) => {
	const user = requireUser(c);
	const body = await json(c);
	const prefs = prefsOf(user);
	if (typeof body.ai === "boolean") prefs.ai = body.ai;
	if (typeof body.reminders === "boolean") prefs.reminders = body.reminders;
	const name = line(body.name, 80) || user.name;
	await c.env.UC_DB.prepare("UPDATE users SET name = ?, prefs = ? WHERE id = ?").bind(name, JSON.stringify(prefs), user.id).run();
	// Turning AI off also withdraws anything it suggested that was never accepted.
	if (body.ai === false) {
		await c.env.UC_DB.prepare("DELETE FROM categories WHERE status = 'suggested' AND entry_id IN (SELECT id FROM entries WHERE owner_id = ?)").bind(user.id).run();
	}
	return c.json({ ok: true });
});

/**
 * Deletes the account and, by cascade, everything in it: loved ones, entries,
 * recordings, photographs, activities, books, and every contribution this
 * person made to a shared collection. Collections they own are deleted for all
 * members. Files other people already downloaded or printed are beyond reach.
 */
app.delete("/me", async (c) => {
	const user = requireUser(c);
	await c.env.UC_DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
	deleteCookie(c, COOKIE, { path: "/" });
	return c.json({ ok: true });
});

// -------------------------------------------------------------------- media

app.post("/assets", async (c) => {
	const user = requireUser(c);
	const body = await json(c);
	const kind = body.kind === "audio" ? "audio" : "image";
	const mime = line(body.mime, 60).split(";")[0].toLowerCase();
	const size = Number(body.size);
	const allowed = kind === "audio" ? AUDIO_TYPES : ["image/jpeg", "image/png", "image/webp"];
	if (!allowed.includes(mime)) fail(400, kind === "audio" ? "That recording format isn't supported." : "Please use a JPG, PNG or WebP photograph.");
	const max = kind === "audio" ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES;
	if (!(size > 0 && size <= max)) fail(400, kind === "audio" ? "That recording is too long to save. Please keep each one under 15 minutes." : "That photograph is too large.");
	const id = uuid();
	await c.env.UC_DB
		.prepare("INSERT INTO assets (id, owner_id, kind, mime, size, duration_ms, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(id, user.id, kind, mime, size, Number(body.durationMs) > 0 ? Math.round(Number(body.durationMs)) : null, line(body.name, 120), now())
		.run();
	return c.json({ id, chunkBytes: CHUNK_BYTES });
});

app.put("/assets/:id/chunks/:idx", async (c) => {
	const user = requireUser(c);
	const db = c.env.UC_DB;
	const asset = await db.prepare("SELECT size FROM assets WHERE id = ? AND owner_id = ? AND complete = 0").bind(c.req.param("id"), user.id).first<{ size: number }>();
	if (!asset) return fail(404, "Not found.");
	const idx = Number(c.req.param("idx"));
	const bytes = await c.req.arrayBuffer();
	if (!Number.isInteger(idx) || idx < 0 || idx >= Math.ceil(asset.size / CHUNK_BYTES) || !bytes.byteLength || bytes.byteLength > CHUNK_BYTES) fail(400, "That piece of the file couldn't be saved.");
	// Sending the same piece twice simply replaces it, so a retry is always safe.
	await db.prepare("INSERT OR REPLACE INTO asset_chunks (asset_id, idx, bytes) VALUES (?, ?, ?)").bind(c.req.param("id"), idx, bytes).run();
	return c.json({ ok: true });
});

app.post("/assets/:id/complete", async (c) => {
	const user = requireUser(c);
	const db = c.env.UC_DB;
	const id = c.req.param("id");
	const asset = await db.prepare("SELECT size, kind FROM assets WHERE id = ? AND owner_id = ?").bind(id, user.id).first<{ size: number; kind: string }>();
	if (!asset) return fail(404, "Not found.");
	const [stored, first] = await Promise.all([
		db.prepare("SELECT SUM(LENGTH(bytes)) AS n FROM asset_chunks WHERE asset_id = ?").bind(id).first<{ n: number }>(),
		db.prepare("SELECT bytes FROM asset_chunks WHERE asset_id = ? AND idx = 0").bind(id).first<{ bytes: number[] }>(),
	]);
	let valid = stored?.n === asset.size && !!first;
	if (valid && asset.kind === "image") {
		// Trust the file's own signature, not the label it arrived with.
		const head = String.fromCharCode(...first!.bytes.slice(0, 12));
		valid = head.startsWith("\xff\xd8\xff") || head.startsWith("\x89PNG") || (head.startsWith("RIFF") && head.slice(8) === "WEBP");
	}
	if (!valid) {
		await db.prepare("DELETE FROM assets WHERE id = ?").bind(id).run();
		return fail(400, "That file didn't arrive intact. Please try again.");
	}
	await db.prepare("UPDATE assets SET complete = 1 WHERE id = ?").bind(id).run();
	return c.json({ ok: true });
});

type AssetRow = { id: string; owner_id: string; mime: string; size: number; kind: string; name: string };

/** Streams a stored file piece by piece, so a long recording never has to fit in memory. */
function sendAsset(c: Ctx, asset: AssetRow, download: boolean) {
	const db = c.env.UC_DB;
	let idx = 0;
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const row = await db.prepare("SELECT bytes FROM asset_chunks WHERE asset_id = ? AND idx = ?").bind(asset.id, idx++).first<{ bytes: number[] }>();
			if (row) controller.enqueue(new Uint8Array(row.bytes));
			else controller.close();
		},
	});
	const extension = asset.mime.split("/")[1].replace("x-m4a", "m4a").replace("mpeg", "mp3");
	return new Response(stream, {
		headers: {
			"Content-Type": asset.mime,
			"Content-Length": String(asset.size),
			"X-Content-Type-Options": "nosniff",
			// Cached for the signed-in person only: signing out, or anyone else using the browser, gets a fresh check.
			"Cache-Control": "private, max-age=3600",
			Vary: "Cookie",
			...(download ? { "Content-Disposition": `attachment; filename="${asset.kind === "audio" ? "recording" : "photo"}-${asset.id.slice(0, 8)}.${extension}"` } : {}),
		},
	});
}

/**
 * The one door to stored media. A file is served to its owner, or to an active
 * member of a shared collection that includes it. Nobody else, ever.
 */
app.get("/media/:id", async (c) => {
	const user = requireUser(c);
	const db = c.env.UC_DB;
	const asset = await db.prepare("SELECT id, owner_id, mime, size, kind, name FROM assets WHERE id = ? AND complete = 1").bind(c.req.param("id")).first<AssetRow>();
	if (!asset) return fail(404, "Not found.");
	if (asset.owner_id !== user.id) {
		const shared = await db
			.prepare(
				`SELECT 1 FROM contributions k
				 JOIN collection_members m ON m.collection_id = k.collection_id AND m.user_id = ?1 AND m.status = 'active'
				 WHERE k.audio_asset_id = ?2 OR k.id IN (SELECT contribution_id FROM contribution_photos WHERE asset_id = ?2) LIMIT 1`,
			)
			.bind(user.id, asset.id)
			.first();
		if (!shared) return fail(404, "Not found.");
	}
	return sendAsset(c, asset, c.req.query("download") === "1");
});

// --------------------------------------------------------------- loved ones

app.post("/loved-ones", async (c) => {
	const user = requireUser(c);
	const body = await json(c);
	const name = line(body.name, 120);
	if (!name) fail(400, "Please tell us their name.");
	const id = uuid();
	await c.env.UC_DB
		.prepare("INSERT INTO loved_ones (id, owner_id, name, nickname, relationship, photo_asset_id, birth_date, death_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(id, user.id, name, line(body.nickname, 60), line(body.relationship, 60), await ownAsset(c, body.photoAssetId, "image"), dateOnly(body.birthDate), dateOnly(body.deathDate), now())
		.run();
	return c.json({ id });
});

app.patch("/loved-ones/:id", async (c) => {
	const row = await ownLovedOne(c, c.req.param("id"));
	const body = await json(c);
	const photo = "photoAssetId" in body ? await ownAsset(c, body.photoAssetId, "image") : row.photo_asset_id;
	await c.env.UC_DB
		.prepare("UPDATE loved_ones SET name = ?, nickname = ?, relationship = ?, photo_asset_id = ?, birth_date = ?, death_date = ? WHERE id = ?")
		.bind(
			line(body.name, 120) || row.name,
			"nickname" in body ? line(body.nickname, 60) : row.nickname,
			"relationship" in body ? line(body.relationship, 60) : row.relationship,
			photo,
			"birthDate" in body ? dateOnly(body.birthDate) : row.birth_date,
			"deathDate" in body ? dateOnly(body.deathDate) : row.death_date,
			row.id,
		)
		.run();
	if (photo !== row.photo_asset_id) await releaseAssets(c.env.UC_DB, [row.photo_asset_id]);
	return c.json({ ok: true });
});

/** Deletes the conversation space and everything in it. */
app.delete("/loved-ones/:id", async (c) => {
	const row = await ownLovedOne(c, c.req.param("id"));
	const db = c.env.UC_DB;
	const { results } = await db
		.prepare(
			`SELECT audio_asset_id AS id FROM entries WHERE loved_one_id = ?1 AND audio_asset_id IS NOT NULL
			 UNION SELECT asset_id FROM entry_photos WHERE entry_id IN (SELECT id FROM entries WHERE loved_one_id = ?1)`,
		)
		.bind(row.id)
		.all<{ id: string }>();
	await db.prepare("DELETE FROM loved_ones WHERE id = ?").bind(row.id).run();
	await releaseAssets(db, [...results.map((r) => r.id), row.photo_asset_id]);
	return c.json({ ok: true });
});

/** Days until the next occurrence of a month and day. */
function daysUntil(month: number, day: number) {
	const today = new Date();
	const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
	let next = Date.UTC(today.getUTCFullYear(), month - 1, day);
	if (next < start) next = Date.UTC(today.getUTCFullYear() + 1, month - 1, day);
	return Math.round((next - start) / 86_400_000);
}

async function loadActivities(db: D1Database, lovedOneId: string, where = ""): Promise<Activity[]> {
	const { results } = await db
		.prepare(`SELECT id, entry_id, description, kind, planned_date, status, created_at FROM activities WHERE loved_one_id = ? ${where} ORDER BY status = 'open' DESC, created_at DESC`)
		.bind(lovedOneId)
		.all<{ id: string; entry_id: string | null; description: string; kind: Activity["kind"]; planned_date: string | null; status: Activity["status"]; created_at: string }>();
	if (!results.length) return [];
	const notes = await db
		.prepare(`SELECT id, activity_id, text, asset_id, created_at FROM activity_notes WHERE activity_id IN (${placeholders(results.length)}) ORDER BY created_at`)
		.bind(...results.map((r) => r.id))
		.all<{ id: string; activity_id: string; text: string; asset_id: string | null; created_at: string }>();
	return results.map((r) => ({
		id: r.id,
		entryId: r.entry_id,
		description: r.description,
		kind: r.kind,
		plannedDate: r.planned_date,
		status: r.status,
		createdAt: r.created_at,
		notes: notes.results.filter((n) => n.activity_id === r.id).map((n) => ({ id: n.id, text: n.text, assetId: n.asset_id, createdAt: n.created_at })),
	}));
}

app.get("/loved-ones/:id/home", async (c) => {
	const loved = await ownLovedOne(c, c.req.param("id"));
	const db = c.env.UC_DB;
	const [recent, drafts, activities, dates, books] = await Promise.all([
		db.prepare(`${ENTRY_SELECT} WHERE e.loved_one_id = ? AND e.draft = 0 ORDER BY e.created_at DESC LIMIT 4`).bind(loved.id).all<EntryRow>(),
		db.prepare(`${ENTRY_SELECT} WHERE e.loved_one_id = ? AND e.draft = 1 ORDER BY e.updated_at DESC LIMIT 5`).bind(loved.id).all<EntryRow>(),
		loadActivities(db, loved.id, "AND status = 'open'"),
		db.prepare("SELECT id, label, month, day FROM important_dates WHERE loved_one_id = ?").bind(loved.id).all<{ id: string; label: string; month: number; day: number }>(),
		db.prepare(`SELECT id, title, updated_at AS "updatedAt" FROM books WHERE loved_one_id = ? ORDER BY updated_at DESC`).bind(loved.id).all(),
	]);
	return c.json({
		recent: await hydrate(db, recent.results),
		drafts: await hydrate(db, drafts.results),
		activities: activities.slice(0, 4),
		dates: dates.results.map((d) => ({ ...d, daysAway: daysUntil(d.month, d.day) })).sort((a, b) => a.daysAway - b.daysAway),
		books: books.results,
	});
});

// ------------------------------------------------------------------ entries

app.get("/loved-ones/:id/entries", async (c) => {
	const loved = await ownLovedOne(c, c.req.param("id"));
	const q = line(c.req.query("q"), 80);
	const category = line(c.req.query("category"), 60);
	const where = ["e.loved_one_id = ?", "e.draft = 0"];
	const args: string[] = [loved.id];
	if (q) {
		// Words, transcripts, tags, categories, and dates written as 2024, 2024-06 or 2024-06-14.
		where.push(
			`(e.title LIKE ?2 OR e.content LIKE ?2 OR e.transcript LIKE ?2 OR e.tags LIKE ?2 OR e.created_at LIKE ?3
			  OR e.id IN (SELECT entry_id FROM categories WHERE name LIKE ?2 AND status = 'approved')
			  OR e.id IN (SELECT entry_id FROM entry_photos WHERE caption LIKE ?2))`,
		);
		args.push(`%${q}%`, `${q}%`);
	}
	if (category) {
		where.push(`e.id IN (SELECT entry_id FROM categories WHERE name = ?${args.length + 1} AND status = 'approved')`);
		args.push(category);
	}
	const { results } = await c.env.UC_DB
		.prepare(`${ENTRY_SELECT} WHERE ${where.join(" AND ").replace("e.loved_one_id = ?", "e.loved_one_id = ?1")} ORDER BY e.created_at DESC LIMIT 300`)
		.bind(...args)
		.all<EntryRow>();
	return c.json({ entries: await hydrate(c.env.UC_DB, results) });
});

async function savePhotos(db: D1Database, entryId: string, photos: Photo[]) {
	await db.batch([
		db.prepare("DELETE FROM entry_photos WHERE entry_id = ?").bind(entryId),
		...photos.map((p, i) => db.prepare("INSERT INTO entry_photos (entry_id, asset_id, caption, position) VALUES (?, ?, ?, ?)").bind(entryId, p.assetId, p.caption, i)),
	]);
}

const tagList = (value: unknown) => (Array.isArray(value) ? [...new Set(value.map((t) => line(t, 40)).filter(Boolean))].slice(0, 20) : []);

app.post("/entries", async (c) => {
	const user = requireUser(c);
	const body = await json(c);
	const loved = await ownLovedOne(c, line(body.lovedOneId, 40));
	const type = body.type === "voice" || body.type === "memory" ? body.type : "letter";
	const audio = type === "voice" ? await ownAsset(c, body.audioAssetId, "audio") : null;
	if (type === "voice" && !audio) fail(400, "The recording wasn't saved. Please try again.");
	const photos = await ownPhotos(c, body.photos);
	const content = prose(body.content);
	const transcript = prose(body.transcript);
	const draft = body.draft === true;
	if (!draft && type !== "voice" && !content && !photos.length) fail(400, "There's nothing to save yet.");
	const id = uuid();
	const at = now();
	await c.env.UC_DB
		.prepare(
			`INSERT INTO entries (id, owner_id, loved_one_id, type, title, content, transcript, audio_asset_id, tags, draft, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(id, user.id, loved.id, type, line(body.title, 200), content, transcript, audio, JSON.stringify(tagList(body.tags)), draft ? 1 : 0, at, at)
		.run();
	await savePhotos(c.env.UC_DB, id, photos);
	return c.json({ id, crisis: CRISIS.test(`${content} ${transcript}`) });
});

app.patch("/entries/:id", async (c) => {
	const row = await ownEntry(c, c.req.param("id"));
	const body = await json(c);
	const db = c.env.UC_DB;
	const content = "content" in body ? prose(body.content) : row.content;
	const transcript = "transcript" in body ? prose(body.transcript) : row.transcript;
	const draft = "draft" in body ? body.draft === true : !!row.draft;
	await db
		.prepare("UPDATE entries SET title = ?, content = ?, transcript = ?, tags = ?, draft = ?, created_at = ?, updated_at = ? WHERE id = ?")
		.bind(
			"title" in body ? line(body.title, 200) : row.title,
			content,
			transcript,
			"tags" in body ? JSON.stringify(tagList(body.tags)) : row.tags,
			draft ? 1 : 0,
			// A letter is dated when it is finished, not when the first draft was started.
			row.draft && !draft ? now() : row.created_at,
			now(),
			row.id,
		)
		.run();
	if ("photos" in body) {
		const before = await db.prepare("SELECT asset_id FROM entry_photos WHERE entry_id = ?").bind(row.id).all<{ asset_id: string }>();
		await savePhotos(db, row.id, await ownPhotos(c, body.photos));
		await releaseAssets(db, before.results.map((r) => r.asset_id));
	}
	return c.json({ ok: true, crisis: CRISIS.test(`${content} ${transcript}`) });
});

app.delete("/entries/:id", async (c) => {
	const row = await ownEntry(c, c.req.param("id"));
	const db = c.env.UC_DB;
	const photos = await db.prepare("SELECT asset_id FROM entry_photos WHERE entry_id = ?").bind(row.id).all<{ asset_id: string }>();
	await db.prepare("DELETE FROM entries WHERE id = ?").bind(row.id).run();
	await releaseAssets(db, [row.audio_asset_id, ...photos.results.map((p) => p.asset_id)]);
	return c.json({ ok: true });
});

// ------------------------------------------------------- AI: organise, carry forward

/**
 * Looks at one saved entry and proposes themes and ways to carry it forward.
 * Runs only if this person has switched AI assistance on, and only when they
 * save or ask; nothing is analysed in the background.
 */
app.post("/entries/:id/analyze", async (c) => {
	const user = requireUser(c);
	const row = await ownEntry(c, c.req.param("id"));
	if (!prefsOf(user).ai) return fail(403, "AI assistance is switched off. You can turn it on in Settings.");
	const db = c.env.UC_DB;
	const loved = await ownLovedOne(c, row.loved_one_id);
	const text = [row.title, row.content, row.transcript].filter(Boolean).join("\n\n");
	if (text.trim().length < 12) return c.json({ suggestions: [], categories: [], source: "basic" });

	const analysis = await analyzeMemory(c.env, { text, name: calls(loved), relationship: loved.relationship });
	const statements = analysis.categories.map((name) =>
		db.prepare("INSERT OR IGNORE INTO categories (id, entry_id, name, source, status) VALUES (?, ?, ?, 'ai', 'suggested')").bind(uuid(), row.id, name),
	);
	statements.push(
		db
			.prepare("INSERT INTO ai_records (id, user_id, entry_id, kind, consent, source, result, status, created_at) VALUES (?, ?, ?, 'analyze', 1, ?, ?, 'complete', ?)")
			.bind(uuid(), user.id, row.id, analysis.source, JSON.stringify({ categories: analysis.categories, suggestions: analysis.suggestions.length }), now()),
	);
	await db.batch(statements);
	const [entry] = await hydrate(db, [row]);
	return c.json({ suggestions: analysis.suggestions, categories: entry.categories, source: analysis.source });
});

app.post("/entries/:id/categories", async (c) => {
	const row = await ownEntry(c, c.req.param("id"));
	const name = line((await json(c)).name, 60);
	if (!name) fail(400, "Please name the category.");
	await c.env.UC_DB
		.prepare(
			`INSERT INTO categories (id, entry_id, name, source, status) VALUES (?, ?, ?, 'user', 'approved')
			 ON CONFLICT (entry_id, name) DO UPDATE SET status = 'approved'`,
		)
		.bind(uuid(), row.id, name)
		.run();
	return c.json({ ok: true });
});

/** Accept, reject or rename a category. The person has the last word on every one. */
app.patch("/categories/:id", async (c) => {
	const user = requireUser(c);
	const body = await json(c);
	const db = c.env.UC_DB;
	const row = await db
		.prepare("SELECT k.id, k.name, k.status FROM categories k JOIN entries e ON e.id = k.entry_id WHERE k.id = ? AND e.owner_id = ?")
		.bind(c.req.param("id"), user.id)
		.first<{ id: string; name: string; status: string }>();
	if (!row) return fail(404, "Not found.");
	const status = ["approved", "rejected"].includes(line(body.status, 20)) ? line(body.status, 20) : row.status;
	await db.prepare("UPDATE OR REPLACE categories SET name = ?, status = ? WHERE id = ?").bind(line(body.name, 60) || row.name, status, row.id).run();
	return c.json({ ok: true });
});

app.delete("/categories/:id", async (c) => {
	const user = requireUser(c);
	await c.env.UC_DB.prepare("DELETE FROM categories WHERE id = ? AND entry_id IN (SELECT id FROM entries WHERE owner_id = ?)").bind(c.req.param("id"), user.id).run();
	return c.json({ ok: true });
});

app.post("/loved-ones/:id/summary", async (c) => {
	const user = requireUser(c);
	const loved = await ownLovedOne(c, c.req.param("id"));
	if (!prefsOf(user).ai) return fail(403, "AI assistance is switched off. You can turn it on in Settings.");
	const ids = ((await json(c)).entryIds as unknown[] | undefined)?.map((x) => line(x, 40)).filter(Boolean).slice(0, 30) ?? [];
	if (!ids.length) return fail(400, "Choose the memories you'd like summarised.");
	const { results } = await c.env.UC_DB
		.prepare(`SELECT title, content, transcript FROM entries WHERE owner_id = ? AND loved_one_id = ? AND id IN (${placeholders(ids.length)})`)
		.bind(user.id, loved.id, ...ids)
		.all<{ title: string; content: string; transcript: string }>();
	const summary = await summarize(c.env, calls(loved), results.map((r) => [r.title, r.content, r.transcript].filter(Boolean).join("\n")).filter(Boolean));
	if (!summary) return fail(503, c.env.ANTHROPIC_API_KEY ? "A summary couldn't be written just now. Please try again." : "Summaries need the AI service, which hasn't been connected yet.");
	await c.env.UC_DB
		.prepare("INSERT INTO ai_records (id, user_id, kind, consent, source, result, status, created_at) VALUES (?, ?, 'summary', 1, 'ai', '', 'complete', ?)")
		.bind(uuid(), user.id, now())
		.run();
	return c.json({ summary });
});

// --------------------------------------------------------- carry it forward

app.get("/loved-ones/:id/activities", async (c) => {
	const loved = await ownLovedOne(c, c.req.param("id"));
	return c.json({ activities: await loadActivities(c.env.UC_DB, loved.id) });
});

app.post("/activities", async (c) => {
	const user = requireUser(c);
	const body = await json(c);
	const loved = await ownLovedOne(c, line(body.lovedOneId, 40));
	const description = line(body.description, 300);
	if (!description) fail(400, "Please describe what you'd like to do.");
	const entryId = line(body.entryId, 40);
	if (entryId) await ownEntry(c, entryId);
	const id = uuid();
	const at = now();
	await c.env.UC_DB
		.prepare("INSERT INTO activities (id, user_id, loved_one_id, entry_id, description, kind, planned_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(id, user.id, loved.id, entryId || null, description, body.kind === "tradition" ? "tradition" : "someday", dateOnly(body.plannedDate), at, at)
		.run();
	return c.json({ id });
});

async function ownActivity(c: Ctx, id: string) {
	const user = requireUser(c);
	const row = await c.env.UC_DB
		.prepare("SELECT id, description, kind, planned_date, status FROM activities WHERE id = ? AND user_id = ?")
		.bind(id, user.id)
		.first<{ id: string; description: string; kind: string; planned_date: string | null; status: string }>();
	return row ?? fail(404, "Not found.");
}

app.patch("/activities/:id", async (c) => {
	const row = await ownActivity(c, c.req.param("id"));
	const body = await json(c);
	await c.env.UC_DB
		.prepare("UPDATE activities SET description = ?, kind = ?, planned_date = ?, status = ?, updated_at = ? WHERE id = ?")
		.bind(
			line(body.description, 300) || row.description,
			body.kind === "tradition" || body.kind === "someday" ? body.kind : row.kind,
			"plannedDate" in body ? dateOnly(body.plannedDate) : row.planned_date,
			["open", "done", "archived"].includes(line(body.status, 20)) ? line(body.status, 20) : row.status,
			now(),
			row.id,
		)
		.run();
	return c.json({ ok: true });
});

app.delete("/activities/:id", async (c) => {
	const row = await ownActivity(c, c.req.param("id"));
	const db = c.env.UC_DB;
	const notes = await db.prepare("SELECT asset_id FROM activity_notes WHERE activity_id = ?").bind(row.id).all<{ asset_id: string | null }>();
	await db.prepare("DELETE FROM activities WHERE id = ?").bind(row.id).run();
	await releaseAssets(db, notes.results.map((n) => n.asset_id));
	return c.json({ ok: true });
});

app.post("/activities/:id/notes", async (c) => {
	const row = await ownActivity(c, c.req.param("id"));
	const body = await json(c);
	const text = prose(body.text, 20_000);
	const asset = await ownAsset(c, body.assetId, "image");
	if (!text && !asset) fail(400, "Add a few words or a photograph.");
	await c.env.UC_DB.prepare("INSERT INTO activity_notes (id, activity_id, text, asset_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(uuid(), row.id, text, asset, now()).run();
	return c.json({ ok: true, crisis: CRISIS.test(text) });
});

app.delete("/activity-notes/:id", async (c) => {
	const user = requireUser(c);
	const db = c.env.UC_DB;
	const note = await db
		.prepare("SELECT n.id, n.asset_id FROM activity_notes n JOIN activities a ON a.id = n.activity_id WHERE n.id = ? AND a.user_id = ?")
		.bind(c.req.param("id"), user.id)
		.first<{ id: string; asset_id: string | null }>();
	if (!note) return fail(404, "Not found.");
	await db.prepare("DELETE FROM activity_notes WHERE id = ?").bind(note.id).run();
	await releaseAssets(db, [note.asset_id]);
	return c.json({ ok: true });
});

// ----------------------------------------------------------- important dates

app.post("/loved-ones/:id/dates", async (c) => {
	const user = requireUser(c);
	const loved = await ownLovedOne(c, c.req.param("id"));
	const body = await json(c);
	const label = line(body.label, 80);
	const month = Number(body.month);
	const day = Number(body.day);
	if (!label) fail(400, "Please give this date a name.");
	if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) fail(400, "Please choose a month and day.");
	await c.env.UC_DB.prepare("INSERT INTO important_dates (id, owner_id, loved_one_id, label, month, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(uuid(), user.id, loved.id, label, month, day, now()).run();
	return c.json({ ok: true });
});

app.delete("/dates/:id", async (c) => {
	const user = requireUser(c);
	await c.env.UC_DB.prepare("DELETE FROM important_dates WHERE id = ? AND owner_id = ?").bind(c.req.param("id"), user.id).run();
	return c.json({ ok: true });
});

// --------------------------------------------------------------- our stories

type MemberRow = { id: string; collection_id: string; user_id: string | null; email: string; name: string; role: "owner" | "contributor" | "viewer"; status: string };

/** Access to a shared collection: an active member with one of the allowed roles, or a 404. */
async function member(c: Ctx, collectionId: string, roles: MemberRow["role"][] = ["owner", "contributor", "viewer"]) {
	const user = requireUser(c);
	const row = await c.env.UC_DB
		.prepare("SELECT * FROM collection_members WHERE collection_id = ? AND user_id = ? AND status = 'active'")
		.bind(collectionId, user.id)
		.first<MemberRow>();
	if (!row || !roles.includes(row.role)) return fail(404, "Not found.");
	return row;
}

app.get("/collections", async (c) => {
	const user = requireUser(c);
	const { results } = await c.env.UC_DB
		.prepare(
			`SELECT c.id, c.name, c.about, c.description, m.role,
				(SELECT COUNT(*) FROM contributions k WHERE k.collection_id = c.id) AS stories,
				(SELECT COUNT(*) FROM collection_members x WHERE x.collection_id = c.id AND x.status = 'active') AS people
			 FROM collection_members m JOIN collections c ON c.id = m.collection_id
			 WHERE m.user_id = ? AND m.status = 'active' ORDER BY c.created_at DESC`,
		)
		.bind(user.id)
		.all();
	return c.json({ collections: results });
});

app.post("/collections", async (c) => {
	const user = requireUser(c);
	const body = await json(c);
	const name = line(body.name, 100);
	if (!name) fail(400, "Please name the collection.");
	const id = uuid();
	const at = now();
	const db = c.env.UC_DB;
	await db.batch([
		db.prepare("INSERT INTO collections (id, owner_id, name, about, description, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, user.id, name, line(body.about, 120), line(body.description, 400), at),
		db.prepare("INSERT INTO collection_members (id, collection_id, user_id, email, name, role, status, created_at) VALUES (?, ?, ?, ?, ?, 'owner', 'active', ?)").bind(uuid(), id, user.id, user.email, user.name, at),
	]);
	return c.json({ id });
});

app.get("/collections/:id", async (c) => {
	const me = await member(c, c.req.param("id"));
	const db = c.env.UC_DB;
	const q = line(c.req.query("q"), 80);
	const [collection, members, stories] = await Promise.all([
		db.prepare("SELECT id, name, about, description FROM collections WHERE id = ?").bind(me.collection_id).first(),
		db
			.prepare(`SELECT id, name, email, role, status, invite_token AS "inviteToken" FROM collection_members WHERE collection_id = ? AND status IN ('invited', 'active') ORDER BY created_at`)
			.bind(me.collection_id)
			.all<{ id: string; email: string; inviteToken: string | null }>(),
		db
			.prepare(
				`SELECT k.id, k.user_id AS "userId", k.author_name AS "authorName", k.title, k.content, k.audio_asset_id AS "audioAssetId",
					k.created_at AS "createdAt", a.duration_ms AS "durationMs"
				 FROM contributions k LEFT JOIN assets a ON a.id = k.audio_asset_id
				 WHERE k.collection_id = ?1 ${q ? "AND (k.title LIKE ?2 OR k.content LIKE ?2 OR k.author_name LIKE ?2)" : ""}
				 ORDER BY k.created_at DESC LIMIT 300`,
			)
			.bind(...(q ? [me.collection_id, `%${q}%`] : [me.collection_id]))
			.all<{ id: string }>(),
	]);
	const ids = stories.results.map((s) => s.id);
	const photos = ids.length
		? (await db.prepare(`SELECT contribution_id, asset_id, caption FROM contribution_photos WHERE contribution_id IN (${placeholders(ids.length)}) ORDER BY position`).bind(...ids).all<{ contribution_id: string; asset_id: string; caption: string }>()).results
		: [];
	return c.json({
		collection,
		role: me.role,
		myUserId: me.user_id,
		// Only the owner sees email addresses and invitation links.
		members: members.results.map((m) => (me.role === "owner" ? m : { ...m, email: "", inviteToken: null })),
		stories: stories.results.map((s) => ({ ...s, photos: photos.filter((p) => p.contribution_id === s.id).map((p) => ({ assetId: p.asset_id, caption: p.caption })) })),
	});
});

app.patch("/collections/:id", async (c) => {
	const me = await member(c, c.req.param("id"), ["owner"]);
	const body = await json(c);
	const name = line(body.name, 100);
	if (!name) fail(400, "Please name the collection.");
	await c.env.UC_DB.prepare("UPDATE collections SET name = ?, about = ?, description = ? WHERE id = ?").bind(name, line(body.about, 120), line(body.description, 400), me.collection_id).run();
	return c.json({ ok: true });
});

async function collectionAssets(db: D1Database, where: string, ...args: string[]) {
	const { results } = await db
		.prepare(
			`SELECT audio_asset_id AS id FROM contributions WHERE ${where} AND audio_asset_id IS NOT NULL
			 UNION SELECT asset_id FROM contribution_photos WHERE contribution_id IN (SELECT id FROM contributions WHERE ${where})`,
		)
		.bind(...args)
		.all<{ id: string }>();
	return results.map((r) => r.id);
}

/** Deletes the shared collection for everyone. Each person's private originals are untouched. */
app.delete("/collections/:id", async (c) => {
	const me = await member(c, c.req.param("id"), ["owner"]);
	const db = c.env.UC_DB;
	const assets = await collectionAssets(db, "collection_id = ?1", me.collection_id);
	await db.prepare("DELETE FROM collections WHERE id = ?").bind(me.collection_id).run();
	await releaseAssets(db, assets);
	return c.json({ ok: true });
});

app.post("/collections/:id/members", async (c) => {
	const me = await member(c, c.req.param("id"), ["owner"]);
	const body = await json(c);
	const name = line(body.name, 80);
	const email = line(body.email, 200).toLowerCase();
	if (!name) fail(400, "Please add their name.");
	if (!validEmail(email)) fail(400, "That email address doesn't look right.");
	const db = c.env.UC_DB;
	if (await db.prepare("SELECT 1 FROM collection_members WHERE collection_id = ? AND email = ? AND status IN ('invited', 'active')").bind(me.collection_id, email).first()) {
		fail(409, "That person is already in this collection or has an open invitation.");
	}
	const token = randomToken(24);
	await db
		.prepare("INSERT INTO collection_members (id, collection_id, email, name, role, status, invite_token, created_at) VALUES (?, ?, ?, ?, ?, 'invited', ?, ?)")
		.bind(uuid(), me.collection_id, email, name, body.role === "viewer" ? "viewer" : "contributor", token, now())
		.run();
	return c.json({ inviteToken: token });
});

app.patch("/collections/:id/members/:mid", async (c) => {
	const me = await member(c, c.req.param("id"), ["owner"]);
	const role = (await json(c)).role === "viewer" ? "viewer" : "contributor";
	const result = await c.env.UC_DB
		.prepare("UPDATE collection_members SET role = ? WHERE id = ? AND collection_id = ? AND role != 'owner' AND status IN ('invited', 'active')")
		.bind(role, c.req.param("mid"), me.collection_id)
		.run();
	return result.meta.changes ? c.json({ ok: true }) : fail(404, "Not found.");
});

/**
 * Removes someone's access. Their stories stay in the collection, credited to
 * them, unless they take them out themselves: a memory someone chose to give
 * the family isn't the owner's to erase by removing the person.
 */
app.delete("/collections/:id/members/:mid", async (c) => {
	const me = await member(c, c.req.param("id"), ["owner"]);
	const result = await c.env.UC_DB
		.prepare("UPDATE collection_members SET status = 'removed', invite_token = NULL WHERE id = ? AND collection_id = ? AND role != 'owner'")
		.bind(c.req.param("mid"), me.collection_id)
		.run();
	return result.meta.changes ? c.json({ ok: true }) : fail(404, "Not found.");
});

/** Leaving: the person chooses whether the stories they shared stay with the family or leave with them. */
app.post("/collections/:id/leave", async (c) => {
	const me = await member(c, c.req.param("id"), ["contributor", "viewer"]);
	const db = c.env.UC_DB;
	if ((await json(c)).removeMine === true) {
		const assets = await collectionAssets(db, "collection_id = ?1 AND user_id = ?2", me.collection_id, me.user_id!);
		await db.prepare("DELETE FROM contributions WHERE collection_id = ? AND user_id = ?").bind(me.collection_id, me.user_id).run();
		await releaseAssets(db, assets);
	}
	await db.prepare("UPDATE collection_members SET status = 'left' WHERE id = ?").bind(me.id).run();
	return c.json({ ok: true });
});

app.get("/invites/:token", async (c) => {
	const row = await c.env.UC_DB
		.prepare(
			`SELECT m.role, m.name, c.name AS "collectionName", c.about, u.name AS "inviterName"
			 FROM collection_members m JOIN collections c ON c.id = m.collection_id JOIN users u ON u.id = c.owner_id
			 WHERE m.invite_token = ? AND m.status = 'invited'`,
		)
		.bind(c.req.param("token"))
		.first();
	return row ? c.json({ invite: row }) : fail(404, "This invitation is no longer active.");
});

app.post("/invites/:token/accept", async (c) => {
	const user = requireUser(c);
	const db = c.env.UC_DB;
	const row = await db.prepare("SELECT id, collection_id FROM collection_members WHERE invite_token = ? AND status = 'invited'").bind(c.req.param("token")).first<{ id: string; collection_id: string }>();
	if (!row) return fail(404, "This invitation is no longer active.");
	if (await db.prepare("SELECT 1 FROM collection_members WHERE collection_id = ? AND user_id = ? AND status = 'active'").bind(row.collection_id, user.id).first()) {
		fail(409, "You're already part of this collection.");
	}
	await db.prepare("UPDATE collection_members SET user_id = ?, name = ?, status = 'active', invite_token = NULL WHERE id = ?").bind(user.id, user.name, row.id).run();
	return c.json({ collectionId: row.collection_id });
});

async function saveContributionPhotos(db: D1Database, id: string, photos: Photo[]) {
	await db.batch([
		db.prepare("DELETE FROM contribution_photos WHERE contribution_id = ?").bind(id),
		...photos.map((p, i) => db.prepare("INSERT INTO contribution_photos (contribution_id, asset_id, caption, position) VALUES (?, ?, ?, ?)").bind(id, p.assetId, p.caption, i)),
	]);
}

/**
 * Adds a story to a shared collection. This is the only way anything becomes
 * visible to other people, and it is always a deliberate act: either new words
 * written for the family, or a copy of a private entry the person picked.
 * The private entry itself stays private and unchanged.
 */
app.post("/collections/:id/contributions", async (c) => {
	const user = requireUser(c);
	const me = await member(c, c.req.param("id"), ["owner", "contributor"]);
	const body = await json(c);
	const db = c.env.UC_DB;
	let title = line(body.title, 200);
	let content = prose(body.content);
	let audio = await ownAsset(c, body.audioAssetId, "audio");
	let photos = await ownPhotos(c, body.photos);
	const fromEntry = line(body.fromEntryId, 40);
	if (fromEntry) {
		const [entry] = await hydrate(db, [await ownEntry(c, fromEntry)]);
		title ||= entry.title;
		content ||= entry.content || entry.transcript;
		audio ??= entry.audioAssetId;
		if (!photos.length) photos = entry.photos;
	}
	if (!content && !audio && !photos.length) fail(400, "There's nothing to share yet.");
	const id = uuid();
	const at = now();
	await db
		.prepare("INSERT INTO contributions (id, collection_id, user_id, author_name, title, content, audio_asset_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(id, me.collection_id, user.id, user.name, title, content, audio, at, at)
		.run();
	await saveContributionPhotos(db, id, photos);
	return c.json({ id });
});

async function ownContribution(c: Ctx) {
	const user = requireUser(c);
	const row = await c.env.UC_DB
		.prepare("SELECT id, collection_id, user_id, title, content, audio_asset_id FROM contributions WHERE id = ?")
		.bind(c.req.param("id"))
		.first<{ id: string; collection_id: string; user_id: string; title: string; content: string; audio_asset_id: string | null }>();
	if (!row) return fail(404, "Not found.");
	const me = await member(c, row.collection_id);
	return { row, me, mine: row.user_id === user.id };
}

app.patch("/contributions/:id", async (c) => {
	const { row, mine } = await ownContribution(c);
	if (!mine) fail(403, "Only the person who shared this can change it.");
	const body = await json(c);
	await c.env.UC_DB
		.prepare("UPDATE contributions SET title = ?, content = ?, updated_at = ? WHERE id = ?")
		.bind("title" in body ? line(body.title, 200) : row.title, "content" in body ? prose(body.content) : row.content, now(), row.id)
		.run();
	return c.json({ ok: true });
});

/** A story can be removed by the person who shared it, or by the collection's owner. */
app.delete("/contributions/:id", async (c) => {
	const { row, me, mine } = await ownContribution(c);
	if (!mine && me.role !== "owner") fail(403, "Only the person who shared this, or the collection's owner, can remove it.");
	const db = c.env.UC_DB;
	const photos = await db.prepare("SELECT asset_id FROM contribution_photos WHERE contribution_id = ?").bind(row.id).all<{ asset_id: string }>();
	await db.prepare("DELETE FROM contributions WHERE id = ?").bind(row.id).run();
	await releaseAssets(db, [row.audio_asset_id, ...photos.results.map((p) => p.asset_id)]);
	return c.json({ ok: true });
});

// -------------------------------------------------------------- legacy book

app.post("/books", async (c) => {
	const user = requireUser(c);
	const body = await json(c);
	const loved = await ownLovedOne(c, line(body.lovedOneId, 40));
	const id = uuid();
	const at = now();
	await c.env.UC_DB
		.prepare("INSERT INTO books (id, owner_id, loved_one_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(id, user.id, loved.id, line(body.title, 160) || `Remembering ${calls(loved)}`, at, at)
		.run();
	return c.json({ id });
});

async function ownBook(c: Ctx, id: string) {
	const user = requireUser(c);
	const row = await c.env.UC_DB.prepare("SELECT id, loved_one_id, title, config, status FROM books WHERE id = ? AND owner_id = ?").bind(id, user.id).first<{ id: string; loved_one_id: string; title: string; config: string; status: string }>();
	return row ?? fail(404, "Not found.");
}

type ItemRow = { id: string; entry_id: string | null; chapter: string; position: number; title: string; text: string; show_photos: number; show_audio: number };

app.get("/books/:id", async (c) => {
	const book = await ownBook(c, c.req.param("id"));
	const db = c.env.UC_DB;
	const items = await db.prepare("SELECT * FROM book_items WHERE book_id = ? ORDER BY position").bind(book.id).all<ItemRow>();
	const entryIds = items.results.map((i) => i.entry_id).filter((x): x is string => !!x);
	const entries = entryIds.length
		? await hydrate(db, (await db.prepare(`${ENTRY_SELECT} WHERE e.id IN (${placeholders(entryIds.length)})`).bind(...entryIds).all<EntryRow>()).results)
		: [];
	const links = await db.prepare("SELECT entry_id, token FROM share_links WHERE owner_id = (SELECT owner_id FROM books WHERE id = ?) AND revoked_at IS NULL").bind(book.id).all<{ entry_id: string; token: string }>();
	return c.json({
		book: { id: book.id, lovedOneId: book.loved_one_id, title: book.title, status: book.status, config: JSON.parse(book.config || "{}") },
		items: items.results.map((i) => {
			const entry = entries.find((e) => e.id === i.entry_id) ?? null;
			return {
				id: i.id,
				entryId: i.entry_id,
				chapter: i.chapter,
				title: i.title,
				text: i.text,
				showPhotos: !!i.show_photos,
				showAudio: !!i.show_audio,
				date: entry?.createdAt ?? null,
				photos: entry?.photos ?? [],
				hasAudio: !!entry?.audioAssetId,
				listenToken: links.results.find((l) => l.entry_id === i.entry_id)?.token ?? null,
			};
		}),
	});
});

/** Saves the whole arrangement: title, dedication, and every item's chapter, order and edited words. */
app.put("/books/:id", async (c) => {
	const book = await ownBook(c, c.req.param("id"));
	const body = await json(c);
	const db = c.env.UC_DB;
	const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]).slice(0, 400) : [];
	const statements = [
		db
			.prepare("UPDATE books SET title = ?, config = ?, status = ?, updated_at = ? WHERE id = ?")
			.bind(line(body.title, 160) || book.title, JSON.stringify({ dedication: prose((body.config as { dedication?: string })?.dedication, 2000) }), body.status === "finished" ? "finished" : "draft", now(), book.id),
		db.prepare("DELETE FROM book_items WHERE book_id = ?").bind(book.id),
	];
	for (const [position, item] of items.entries()) {
		const entryId = line(item.entryId, 40);
		// Only the person's own memories for this loved one can be placed in their book.
		const entry = entryId ? await db.prepare("SELECT id FROM entries WHERE id = ? AND loved_one_id = ?").bind(entryId, book.loved_one_id).first() : null;
		statements.push(
			db
				.prepare("INSERT INTO book_items (id, book_id, entry_id, chapter, position, title, text, show_photos, show_audio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
				.bind(uuid(), book.id, entry ? entryId : null, line(item.chapter, 120), position, line(item.title, 200), prose(item.text), item.showPhotos === false ? 0 : 1, item.showAudio === false ? 0 : 1),
		);
	}
	await db.batch(statements);
	return c.json({ ok: true });
});

app.delete("/books/:id", async (c) => {
	const book = await ownBook(c, c.req.param("id"));
	await c.env.UC_DB.prepare("DELETE FROM books WHERE id = ?").bind(book.id).run();
	return c.json({ ok: true });
});

/** Proposes chapters for memories being placed in a book. The builder shows them for approval; nothing is saved here. */
app.post("/books/:id/chapters", async (c) => {
	const user = requireUser(c);
	await ownBook(c, c.req.param("id"));
	if (!prefsOf(user).ai) return fail(403, "AI assistance is switched off. You can turn it on in Settings.");
	const items = ((await json(c)).items as Record<string, unknown>[] | undefined)?.slice(0, 120) ?? [];
	const db = c.env.UC_DB;
	const prepared = [];
	for (const item of items) {
		const entryId = line(item.entryId, 40);
		const cats = entryId ? (await db.prepare("SELECT name FROM categories WHERE entry_id = ? AND status = 'approved' AND entry_id IN (SELECT id FROM entries WHERE owner_id = ?)").bind(entryId, user.id).all<{ name: string }>()).results : [];
		prepared.push({ id: line(item.id, 40), title: line(item.title, 200), excerpt: prose(item.text, 800), categories: cats.map((k) => k.name) });
	}
	const result = await suggestChapters(c.env, prepared.filter((p) => p.id));
	await db.prepare("INSERT INTO ai_records (id, user_id, kind, consent, source, result, status, created_at) VALUES (?, ?, 'chapters', 1, ?, '', 'complete', ?)").bind(uuid(), user.id, result.source, now()).run();
	return c.json(result);
});

// ---------------------------------------------------------- listening links

app.post("/entries/:id/share-link", async (c) => {
	const user = requireUser(c);
	const row = await ownEntry(c, c.req.param("id"));
	if (!row.audio_asset_id) return fail(400, "Only a recording can have a listening link.");
	const db = c.env.UC_DB;
	const existing = await db.prepare("SELECT token FROM share_links WHERE entry_id = ? AND revoked_at IS NULL").bind(row.id).first<{ token: string }>();
	if (existing) return c.json(existing);
	const token = randomToken(20);
	await db.prepare("INSERT INTO share_links (id, token, owner_id, entry_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(uuid(), token, user.id, row.id, now()).run();
	return c.json({ token });
});

app.get("/share-links", async (c) => {
	const user = requireUser(c);
	const { results } = await c.env.UC_DB
		.prepare(
			`SELECT s.id, s.token, s.created_at AS "createdAt", e.title, e.created_at AS "recordedAt", l.name AS "lovedOneName"
			 FROM share_links s JOIN entries e ON e.id = s.entry_id JOIN loved_ones l ON l.id = e.loved_one_id
			 WHERE s.owner_id = ? AND s.revoked_at IS NULL ORDER BY s.created_at DESC`,
		)
		.bind(user.id)
		.all();
	return c.json({ links: results });
});

/** Switches a listening link off. Any QR code already printed with it stops working. */
app.delete("/share-links/:id", async (c) => {
	const user = requireUser(c);
	await c.env.UC_DB.prepare("UPDATE share_links SET revoked_at = ? WHERE id = ? AND owner_id = ?").bind(now(), c.req.param("id"), user.id).run();
	return c.json({ ok: true });
});

const LISTEN_SELECT = `
	SELECT e.title, e.created_at AS "recordedAt", l.name AS "lovedOneName", u.name AS "from", a.id, a.owner_id, a.mime, a.size, a.kind, a.name
	FROM share_links s JOIN entries e ON e.id = s.entry_id JOIN assets a ON a.id = e.audio_asset_id
	JOIN loved_ones l ON l.id = e.loved_one_id JOIN users u ON u.id = s.owner_id
	WHERE s.token = ? AND s.revoked_at IS NULL`;

/** What someone who scans a QR code sees: who recorded it, about whom, and when. Not the words, not anything else. */
app.get("/listen/:token", async (c) => {
	const row = await c.env.UC_DB.prepare(LISTEN_SELECT).bind(c.req.param("token")).first<{ title: string; recordedAt: string; lovedOneName: string; from: string }>();
	if (!row) return fail(404, "This recording is no longer available.");
	return c.json({ title: row.title, recordedAt: row.recordedAt, lovedOneName: row.lovedOneName, from: row.from });
});

app.get("/listen/:token/audio", async (c) => {
	const row = await c.env.UC_DB.prepare(LISTEN_SELECT).bind(c.req.param("token")).first<AssetRow>();
	return row ? sendAsset(c, row, false) : fail(404, "This recording is no longer available.");
});

// -------------------------------------------------------------------- export

/** Everything this person has saved, as data. The browser pairs it with the media files and builds one archive. */
app.get("/export", async (c) => {
	const user = requireUser(c);
	const db = c.env.UC_DB;
	const loved = await db.prepare("SELECT * FROM loved_ones WHERE owner_id = ? ORDER BY created_at").bind(user.id).all<LovedRow>();
	const lovedOnes = [];
	for (const row of loved.results) {
		const entries = await db.prepare(`${ENTRY_SELECT} WHERE e.loved_one_id = ? ORDER BY e.created_at`).bind(row.id).all<EntryRow>();
		const dates = await db.prepare("SELECT label, month, day FROM important_dates WHERE loved_one_id = ?").bind(row.id).all();
		lovedOnes.push({ ...lovedOut(row), entries: await hydrate(db, entries.results), activities: await loadActivities(db, row.id), importantDates: dates.results });
	}
	const [shared, assets] = await Promise.all([
		db
			.prepare(`SELECT k.title, k.content, k.audio_asset_id AS "audioAssetId", k.created_at AS "createdAt", c.name AS "collection" FROM contributions k JOIN collections c ON c.id = k.collection_id WHERE k.user_id = ?`)
			.bind(user.id)
			.all(),
		db.prepare(`SELECT id, kind, mime, size FROM assets WHERE owner_id = ? AND complete = 1`).bind(user.id).all(),
	]);
	return c.json({
		exportedAt: now(),
		account: { name: user.name, email: user.email },
		lovedOnes,
		sharedStories: shared.results,
		media: assets.results,
		categoriesInUse: CATEGORIES,
	});
});

export default app;
