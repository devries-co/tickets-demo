import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { earthColor, toHex } from "../shared/earth";
import { BASE_CELLS, levelOf, slotPosition, slotRect } from "../shared/grid";
import { MAX_NAME, MAX_PHOTO_BYTES, MAX_TEXT_CHARS, MAX_WORDS, type Memorial, cleanLine, countWords, normalizeName } from "../shared/text";
import { ensureSchema } from "./schema";

export type NfEnv = {
	NF_DB: D1Database;
	/** Worker secrets. Administration is disabled until NF_ADMIN_PASSWORD is set. */
	NF_ADMIN_PASSWORD?: string;
	NF_MODERATOR_PASSWORD?: string;
	/** "manual" (default): every submission waits for review. "auto": clean submissions publish at once. */
	NF_MODERATION?: string;
};

type Role = "admin" | "moderator";
type App = { Bindings: NfEnv; Variables: { role: Role | null } };
type Ctx = Context<App>;

const COOKIE = "nf_admin";
const SESSION_HOURS = 12;
const CONSENT = "I have permission to share this name, photo and memorial text, and I agree to it being shown publicly.";
const REPORT_REASONS = ["inappropriate", "not_a_memorial", "wrong_information", "privacy", "other"];

const encoder = new TextEncoder();
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (value: string) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

function randomId(length: number) {
	// No vowels or look-alikes, so an id can never spell a word.
	const alphabet = "23456789bcdfghjkmnpqrstvwxz";
	return [...crypto.getRandomValues(new Uint8Array(length))].map((b) => alphabet[b % alphabet.length]).join("");
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

const str = (value: unknown, max: number) => (typeof value === "string" ? cleanLine(value).slice(0, max) : "");
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/** Fixed-window limiter keyed on a hash of the visitor's address; the address itself is never stored. */
async function limit(c: Ctx, action: string, max: number, windowSeconds: number) {
	const ip = c.req.header("cf-connecting-ip") ?? "local";
	const key = `${action}:${(await sha256(`nf|${ip}`)).slice(0, 24)}`;
	const second = Math.floor(Date.now() / 1000);
	const row = await c.env.NF_DB
		.prepare(
			`INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
			 ON CONFLICT (key) DO UPDATE SET
				count = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END,
				window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END
			 RETURNING count`,
		)
		.bind(key, second, windowSeconds)
		.first<{ count: number }>();
	if ((row?.count ?? 0) > max) fail(429, "That's a lot in a short time. Please wait a little and try again.");
}

type Row = {
	id: string;
	name: string;
	text: string;
	has_photo: number;
	slot: number | null;
	color: string | null;
	status: string;
	published_at: string | null;
};

const publicMemorial = (row: Row): Memorial => ({
	id: row.id,
	name: row.name,
	text: row.text,
	hasPhoto: !!row.has_photo,
	slot: row.slot ?? -1,
	color: row.color ?? "#ffffff",
	publishedAt: row.published_at ?? "",
});

/** Things that suggest a submission is not a memorial. A match holds it for a person to review. */
function autoFlags(name: string, text: string) {
	const both = `${name} ${text}`;
	const flags: string[] = [];
	if (/https?:\/\/|www\.|\.(com|net|org|io|co)\b/i.test(both)) flags.push("link");
	if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(both)) flags.push("email");
	if (/(\+?\d[\s().-]?){9,}/.test(both)) flags.push("phone");
	if (/\b(buy|sale|discount|promo|crypto|casino|subscribe|follow me)\b/i.test(both)) flags.push("promotional");
	return flags;
}

function decodePhoto(value: unknown) {
	if (typeof value !== "string" || !value) return null;
	const match = value.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
	if (!match) return fail(400, "That photo couldn't be read. Please use a JPG, PNG or WebP image.");
	const bytes = Uint8Array.from(atob(match[2]), (ch) => ch.charCodeAt(0));
	if (bytes.length > MAX_PHOTO_BYTES) fail(400, "That photo is too large. Please try a smaller one.");
	// Trust the file's own signature, not the label it arrived with.
	const signature = String.fromCharCode(...bytes.slice(0, 12));
	const mime = signature.startsWith("\xff\xd8\xff")
		? "image/jpeg"
		: signature.startsWith("\x89PNG")
			? "image/png"
			: signature.startsWith("RIFF") && signature.slice(8) === "WEBP"
				? "image/webp"
				: fail(400, "That photo couldn't be read. Please use a JPG, PNG or WebP image.");
	return { bytes, mime };
}

/** Gives a memorial its permanent slot the first time it is published, and never again. */
async function publish(db: D1Database, id: string, existingSlot: number | null) {
	const at = now();
	if (existingSlot !== null) {
		await db.prepare("UPDATE memorials SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?").bind(at, at, id).run();
		return;
	}
	const counter = await db
		.prepare("INSERT INTO meta (key, value) VALUES ('next_slot', 1) ON CONFLICT (key) DO UPDATE SET value = value + 1 RETURNING value")
		.first<{ value: number }>();
	const slot = counter!.value - 1;
	const rect = slotRect(slot, levelOf(slot));
	const lat = rect.lat0 + rect.dLat / 2;
	const lon = rect.lon0 + rect.dLon / 2;
	await db
		.prepare("UPDATE memorials SET status = 'published', slot = ?, cell = ?, lat = ?, lon = ?, color = ?, published_at = ?, updated_at = ? WHERE id = ?")
		.bind(slot, slotPosition(slot).cell, lat, lon, toHex(earthColor(lat, lon)), at, at, id)
		.run();
}

const app = new Hono<App>();

app.onError((err, c) => {
	if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
	console.error("never-forgotten: unhandled error on", c.req.method, c.req.routePath);
	return c.json({ error: "Something went wrong on our side. Please try again." }, 500);
});

app.use("*", async (c, next) => {
	if (c.req.method !== "GET") {
		const origin = c.req.header("origin");
		if (origin && new URL(origin).host !== new URL(c.req.url).host) fail(403, "Cross-site requests are not allowed.");
	}
	await ensureSchema(c.env.NF_DB);
	const token = getCookie(c, COOKIE);
	const session = token
		? await c.env.NF_DB
				.prepare("SELECT role FROM admin_sessions WHERE token_hash = ? AND expires_at > ?")
				.bind(await sha256(token), now())
				.first<{ role: Role }>()
		: null;
	c.set("role", session?.role ?? null);
	await next();
});

// --------------------------------------------------------------------- public

app.get("/stats", async (c) => {
	const db = c.env.NF_DB;
	const [published, slots, vacant] = await Promise.all([
		db.prepare("SELECT COUNT(*) AS n FROM memorials WHERE status = 'published'").first<{ n: number }>(),
		db.prepare("SELECT value FROM meta WHERE key = 'next_slot'").first<{ value: number }>(),
		db
			.prepare("SELECT slot FROM memorials WHERE slot IS NOT NULL AND status != 'published' UNION SELECT slot FROM retired_slots")
			.all<{ slot: number }>(),
	]);
	c.header("Cache-Control", "public, max-age=15");
	return c.json({ published: published?.n ?? 0, slots: slots?.value ?? 0, vacant: vacant.results.map((r) => r.slot) });
});

app.get("/search", async (c) => {
	const q = normalizeName(c.req.query("q") ?? "").slice(0, 60);
	if (q.length < 2) return c.json({ results: [] });
	// Matches the start of the name or the start of any word in it.
	const { results } = await c.env.NF_DB
		.prepare(
			`SELECT id, name, text, has_photo, slot, color, status, published_at FROM memorials
			 WHERE status = 'published' AND (name_norm LIKE ?1 OR name_norm LIKE ?2)
			 ORDER BY (name_norm LIKE ?1) DESC, name_norm, published_at LIMIT 8`,
		)
		.bind(`${q}%`, `% ${q}%`)
		.all<Row>();
	return c.json({ results: results.map(publicMemorial) });
});

/**
 * Names for the part of the Earth being looked at: either a list of base
 * cells, or every slot below a small bound (the first, largest names, which
 * are legible from far away). Never the whole collection.
 */
app.get("/names", async (c) => {
	const db = c.env.NF_DB;
	let rows: { slot: number; name: string }[];
	const below = Number(c.req.query("below"));
	if (below > 0) {
		rows = (
			await db
				.prepare("SELECT slot, name FROM memorials WHERE status = 'published' AND slot < ? ORDER BY slot LIMIT 8000")
				.bind(Math.min(below, BASE_CELLS * 4))
				.all<{ slot: number; name: string }>()
		).results;
	} else {
		const cells = (c.req.query("cells") ?? "")
			.split(",")
			.map(Number)
			.filter((n) => Number.isInteger(n) && n >= 0 && n < BASE_CELLS)
			.slice(0, 90);
		if (!cells.length) return c.json({ names: [] });
		rows = (
			await db
				.prepare(`SELECT slot, name FROM memorials WHERE status = 'published' AND cell IN (${cells.map(() => "?").join(",")}) LIMIT 20000`)
				.bind(...cells)
				.all<{ slot: number; name: string }>()
		).results;
	}
	c.header("Cache-Control", "public, max-age=30");
	return c.json({ names: rows.map((r) => [r.slot, r.name]) });
});

const SELECT_PUBLIC = "SELECT id, name, text, has_photo, slot, color, status, published_at FROM memorials WHERE status = 'published'";

app.get("/memorial/:id", async (c) => {
	const row = await c.env.NF_DB.prepare(`${SELECT_PUBLIC} AND id = ?`).bind(c.req.param("id")).first<Row>();
	return row ? c.json({ memorial: publicMemorial(row) }) : fail(404, "We couldn't find that memorial.");
});

app.get("/slot/:slot", async (c) => {
	const row = await c.env.NF_DB.prepare(`${SELECT_PUBLIC} AND slot = ?`).bind(Number(c.req.param("slot"))).first<Row>();
	return row ? c.json({ memorial: publicMemorial(row) }) : fail(404, "No one is remembered here yet.");
});

async function sendPhoto(c: Ctx, id: string, publishedOnly: boolean) {
	const row = await c.env.NF_DB
		.prepare(
			`SELECT p.mime, p.bytes FROM photos p JOIN memorials m ON m.id = p.memorial_id
			 WHERE p.memorial_id = ? ${publishedOnly ? "AND m.status = 'published'" : ""}`,
		)
		.bind(id)
		.first<{ mime: string; bytes: ArrayBuffer | number[] }>();
	if (!row) return fail(404, "Not found.");
	// D1 hands BLOBs back as a plain array of byte values.
	return new Response(new Uint8Array(row.bytes), {
		headers: {
			"Content-Type": row.mime,
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": publishedOnly ? "public, max-age=3600" : "private, no-store",
		},
	});
}

app.get("/photo/:id", (c) => sendPhoto(c, c.req.param("id"), true));

app.post("/memorials", async (c) => {
	await limit(c, "submit", 6, 3600);
	const body = await json(c);
	// A field people never see. Automated form-fillers complete it; we quietly accept and discard.
	if (typeof body.website === "string" && body.website) return c.json({ token: randomId(32), status: "pending" });

	const name = str(body.name, MAX_NAME + 1);
	const text = str(body.text, MAX_TEXT_CHARS + 1);
	if (!name) fail(400, "Please add the name of the person you're remembering.");
	if (name.length > MAX_NAME) fail(400, `Names can be up to ${MAX_NAME} characters.`);
	if (!text) fail(400, "Please add a few words of remembrance.");
	if (text.length > MAX_TEXT_CHARS || countWords(text) > MAX_WORDS) fail(400, `The memorial text can be up to ${MAX_WORDS} words.`);
	if (body.consent !== true) fail(400, "Please confirm you have permission to share this memorial.");
	const email = str(body.email, 200).toLowerCase();
	if (email && !validEmail(email)) fail(400, "That email address doesn't look right. You can also leave it blank.");
	const photo = decodePhoto(body.photo);

	const db = c.env.NF_DB;
	const id = randomId(10);
	const token = randomId(32);
	const contributorId = uuid();
	const at = now();
	const isMinor = body.isMinor === true;
	const flags = autoFlags(name, text);
	const statements = [
		db.prepare("INSERT INTO contributors (id, email, contact_ok, created_at) VALUES (?, ?, ?, ?)").bind(contributorId, email || null, body.contactOk === true ? 1 : 0, at),
		db
			.prepare(
				`INSERT INTO memorials (id, name, name_norm, text, has_photo, status, is_minor, flags, contributor_id, status_token_hash, submitted_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
			)
			.bind(id, name, normalizeName(name), text, photo ? 1 : 0, isMinor ? 1 : 0, flags.join(","), contributorId, await sha256(token), at, at),
		db.prepare("INSERT INTO consent_records (id, memorial_id, statement, created_at) VALUES (?, ?, ?, ?)").bind(uuid(), id, CONSENT, at),
		db.prepare("INSERT INTO moderation_records (id, memorial_id, action, actor_role, created_at) VALUES (?, ?, 'submitted', 'contributor', ?)").bind(uuid(), id, at),
	];
	if (photo) {
		statements.push(db.prepare("INSERT INTO photos (memorial_id, mime, bytes, size, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, photo.mime, photo.bytes, photo.bytes.length, at));
	}
	await db.batch(statements);

	// Memorials for children and anything flagged always wait for a person, whatever the mode.
	if (c.env.NF_MODERATION === "auto" && !flags.length && !isMinor) {
		await publish(db, id, null);
		await db.prepare("INSERT INTO moderation_records (id, memorial_id, action, actor_role, created_at) VALUES (?, ?, 'published', 'automatic', ?)").bind(uuid(), id, now()).run();
		return c.json({ token, status: "published", id });
	}
	return c.json({ token, status: "pending" });
});

/** The contributor's private status link: tells them when their submission is published, and where it is. */
app.get("/submission/:token", async (c) => {
	const row = await c.env.NF_DB
		.prepare("SELECT id, name, text, has_photo, slot, color, status, published_at FROM memorials WHERE status_token_hash = ?")
		.bind(await sha256(c.req.param("token")))
		.first<Row>();
	if (!row) return fail(404, "We couldn't find that submission.");
	c.header("Cache-Control", "no-store");
	return c.json({ status: row.status, name: row.name, memorial: row.status === "published" ? publicMemorial(row) : null });
});

app.post("/memorial/:id/report", async (c) => {
	await limit(c, "report", 10, 3600);
	const body = await json(c);
	const reason = REPORT_REASONS.includes(str(body.reason, 40)) ? str(body.reason, 40) : "other";
	const email = str(body.email, 200).toLowerCase();
	const db = c.env.NF_DB;
	if (!(await db.prepare("SELECT 1 FROM memorials WHERE id = ? AND status = 'published'").bind(c.req.param("id")).first())) fail(404, "Not found.");
	await db
		.prepare("INSERT INTO abuse_reports (id, memorial_id, reason, details, reporter_email, created_at) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(uuid(), c.req.param("id"), reason, str(body.details, 600), validEmail(email) ? email : null, now())
		.run();
	return c.json({ ok: true });
});

app.post("/memorial/:id/request", async (c) => {
	await limit(c, "request", 6, 3600);
	const body = await json(c);
	const kind = body.kind === "removal" ? "removal" : "correction";
	const details = str(body.details, 800);
	const requester = str(body.name, 120);
	const email = str(body.email, 200).toLowerCase();
	if (!details) fail(400, "Please tell us what should change.");
	if (!requester) fail(400, "Please add your name.");
	if (!validEmail(email)) fail(400, "Please add an email address so we can reply to you.");
	const db = c.env.NF_DB;
	if (!(await db.prepare("SELECT 1 FROM memorials WHERE id = ? AND status = 'published'").bind(c.req.param("id")).first())) fail(404, "Not found.");
	await db
		.prepare(
			`INSERT INTO edit_requests (id, memorial_id, kind, details, requester_name, requester_email, relationship, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(uuid(), c.req.param("id"), kind, details, requester, email, str(body.relationship, 80), now())
		.run();
	return c.json({ ok: true });
});

// ------------------------------------------------------------- administration

function safeEqual(a: string, b: string) {
	let diff = a.length ^ b.length;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % (b.length || 1));
	return diff === 0;
}

app.post("/admin/login", async (c) => {
	await limit(c, "login", 8, 900);
	const password = (await json(c)).password;
	if (!c.env.NF_ADMIN_PASSWORD) return fail(503, "Administration isn't set up yet. Add the NF_ADMIN_PASSWORD secret to the Worker.");
	if (typeof password !== "string" || !password) return fail(401, "That password isn't right.");
	const [given, admin, moderator] = await Promise.all([sha256(password), sha256(c.env.NF_ADMIN_PASSWORD), sha256(c.env.NF_MODERATOR_PASSWORD ?? uuid())]);
	const role: Role | null = safeEqual(given, admin) ? "admin" : safeEqual(given, moderator) ? "moderator" : null;
	if (!role) return fail(401, "That password isn't right.");
	const token = randomId(40);
	await c.env.NF_DB
		.prepare("INSERT INTO admin_sessions (token_hash, role, expires_at) VALUES (?, ?, ?)")
		.bind(await sha256(token), role, new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString())
		.run();
	setCookie(c, COOKIE, token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_HOURS * 3600 });
	return c.json({ role });
});

app.post("/admin/logout", async (c) => {
	const token = getCookie(c, COOKIE);
	if (token) await c.env.NF_DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
	deleteCookie(c, COOKIE, { path: "/" });
	return c.json({ ok: true });
});

app.get("/admin/me", (c) => c.json({ role: c.get("role"), configured: !!c.env.NF_ADMIN_PASSWORD }));

// Everything below requires a signed-in administrator or moderator.
app.use("/admin/*", async (c, next) => {
	if (!c.get("role")) fail(401, "Please sign in.");
	c.header("Cache-Control", "no-store");
	await next();
});

const requireAdmin = (c: Ctx) => (c.get("role") === "admin" ? "admin" : fail(403, "Only an administrator can do that."));

function record(c: Ctx, memorialId: string, action: string, reason = "") {
	const db = c.env.NF_DB;
	const role = c.get("role")!;
	const at = now();
	return db.batch([
		db.prepare("INSERT INTO moderation_records (id, memorial_id, action, reason, actor_role, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(uuid(), memorialId, action, reason, role, at),
		db.prepare("INSERT INTO admin_log (id, role, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(uuid(), role, action, memorialId, reason, at),
	]);
}

app.get("/admin/summary", async (c) => {
	const db = c.env.NF_DB;
	const since = new Date(Date.now() - 14 * 86400_000).toISOString();
	const [statuses, reports, requests, daily] = await Promise.all([
		db.prepare("SELECT status, COUNT(*) AS n FROM memorials GROUP BY status").all<{ status: string; n: number }>(),
		db.prepare("SELECT COUNT(*) AS n FROM abuse_reports WHERE status = 'open'").first<{ n: number }>(),
		db.prepare("SELECT COUNT(*) AS n FROM edit_requests WHERE status = 'open'").first<{ n: number }>(),
		db.prepare("SELECT substr(submitted_at, 1, 10) AS day, COUNT(*) AS n FROM memorials WHERE submitted_at > ? GROUP BY day ORDER BY day").bind(since).all(),
	]);
	return c.json({
		counts: Object.fromEntries(statuses.results.map((r) => [r.status, r.n])),
		openReports: reports?.n ?? 0,
		openRequests: requests?.n ?? 0,
		daily: daily.results,
	});
});

app.get("/admin/memorials", async (c) => {
	const status = c.req.query("status") ?? "";
	const q = normalizeName(c.req.query("q") ?? "");
	const offset = Math.max(0, Number(c.req.query("offset")) || 0);
	const where: string[] = [];
	const args: (string | number)[] = [];
	if (["pending", "published", "rejected", "removed"].includes(status)) {
		where.push("status = ?");
		args.push(status);
	}
	if (q) {
		where.push("name_norm LIKE ?");
		args.push(`%${q}%`);
	}
	const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const db = c.env.NF_DB;
	const [rows, total] = await Promise.all([
		db
			.prepare(
				`SELECT id, name, text, has_photo AS "hasPhoto", status, is_minor AS "isMinor", flags, slot, submitted_at AS "submittedAt",
					(SELECT COUNT(*) FROM memorials d WHERE d.name_norm = memorials.name_norm AND d.id != memorials.id AND d.status IN ('pending', 'published')) AS duplicates
				 FROM memorials ${clause} ORDER BY submitted_at DESC LIMIT 40 OFFSET ?`,
			)
			.bind(...args, offset)
			.all(),
		db.prepare(`SELECT COUNT(*) AS n FROM memorials ${clause}`).bind(...args).first<{ n: number }>(),
	]);
	return c.json({ memorials: rows.results, total: total?.n ?? 0 });
});

app.get("/admin/memorials/:id", async (c) => {
	const db = c.env.NF_DB;
	const id = c.req.param("id");
	const memorial = await db
		.prepare(
			`SELECT m.id, m.name, m.name_norm, m.text, m.has_photo AS "hasPhoto", m.status, m.is_minor AS "isMinor", m.flags, m.slot,
				m.submitted_at AS "submittedAt", m.published_at AS "publishedAt", c.email AS "contributorEmail", c.contact_ok AS "contactOk"
			 FROM memorials m LEFT JOIN contributors c ON c.id = m.contributor_id WHERE m.id = ?`,
		)
		.bind(id)
		.first<{ name_norm: string }>();
	if (!memorial) return fail(404, "Not found.");
	const [history, duplicates] = await Promise.all([
		db.prepare(`SELECT action, reason, actor_role AS "actorRole", created_at AS "createdAt" FROM moderation_records WHERE memorial_id = ? ORDER BY created_at`).bind(id).all(),
		db.prepare(`SELECT id, name, text, status, submitted_at AS "submittedAt" FROM memorials WHERE name_norm = ? AND id != ? LIMIT 10`).bind(memorial.name_norm, id).all(),
	]);
	return c.json({ memorial, history: history.results, duplicates: duplicates.results });
});

app.get("/admin/photo/:id", (c) => sendPhoto(c, c.req.param("id"), false));

async function loadForAction(c: Ctx) {
	const row = await c.env.NF_DB.prepare("SELECT id, status, slot FROM memorials WHERE id = ?").bind(c.req.param("id")).first<{ id: string; status: string; slot: number | null }>();
	return row ?? fail(404, "Not found.");
}

app.post("/admin/memorials/:id/approve", async (c) => {
	const row = await loadForAction(c);
	if (row.status === "published") fail(409, "This memorial is already published.");
	await publish(c.env.NF_DB, row.id, row.slot);
	await record(c, row.id, row.status === "removed" ? "restored" : "approved");
	return c.json({ ok: true });
});

app.post("/admin/memorials/:id/reject", async (c) => {
	const row = await loadForAction(c);
	if (row.status !== "pending") fail(409, "Only a pending submission can be rejected.");
	const reason = str((await json(c)).reason, 300);
	await c.env.NF_DB.prepare("UPDATE memorials SET status = 'rejected', updated_at = ? WHERE id = ?").bind(now(), row.id).run();
	await record(c, row.id, "rejected", reason);
	return c.json({ ok: true });
});

/** Takes a memorial out of public view. Its slot stays reserved, so restoring it puts the name back in the same place. */
app.post("/admin/memorials/:id/remove", async (c) => {
	const row = await loadForAction(c);
	if (row.status !== "published") fail(409, "Only a published memorial can be removed.");
	const reason = str((await json(c)).reason, 300);
	await c.env.NF_DB.prepare("UPDATE memorials SET status = 'removed', updated_at = ? WHERE id = ?").bind(now(), row.id).run();
	await record(c, row.id, "removed", reason);
	return c.json({ ok: true });
});

app.patch("/admin/memorials/:id", async (c) => {
	const row = await loadForAction(c);
	const body = await json(c);
	const db = c.env.NF_DB;
	const changed: string[] = [];
	if (typeof body.name === "string") {
		const name = str(body.name, MAX_NAME);
		if (!name) fail(400, "A memorial needs a name.");
		await db.prepare("UPDATE memorials SET name = ?, name_norm = ?, updated_at = ? WHERE id = ?").bind(name, normalizeName(name), now(), row.id).run();
		changed.push("name");
	}
	if (typeof body.text === "string") {
		const text = str(body.text, MAX_TEXT_CHARS);
		if (!text || countWords(text) > MAX_WORDS) fail(400, `The memorial text must be 1 to ${MAX_WORDS} words.`);
		await db.prepare("UPDATE memorials SET text = ?, updated_at = ? WHERE id = ?").bind(text, now(), row.id).run();
		changed.push("text");
	}
	if (body.removePhoto === true) {
		await db.batch([
			db.prepare("DELETE FROM photos WHERE memorial_id = ?").bind(row.id),
			db.prepare("UPDATE memorials SET has_photo = 0, updated_at = ? WHERE id = ?").bind(now(), row.id),
		]);
		changed.push("photo removed");
	}
	if (changed.length) await record(c, row.id, "edited", changed.join(", "));
	return c.json({ ok: true });
});

/** Permanent deletion of the memorial, its photo, and the contributor's contact details. */
app.delete("/admin/memorials/:id", async (c) => {
	requireAdmin(c);
	const row = await loadForAction(c);
	const db = c.env.NF_DB;
	const statements = [
		db.prepare("DELETE FROM contributors WHERE id = (SELECT contributor_id FROM memorials WHERE id = ?)").bind(row.id),
		db.prepare("DELETE FROM memorials WHERE id = ?").bind(row.id),
		db.prepare("INSERT INTO admin_log (id, role, action, target, created_at) VALUES (?, 'admin', 'deleted permanently', ?, ?)").bind(uuid(), row.id, now()),
	];
	if (row.slot !== null) statements.unshift(db.prepare("INSERT OR IGNORE INTO retired_slots (slot) VALUES (?)").bind(row.slot));
	await db.batch(statements);
	return c.json({ ok: true });
});

app.get("/admin/reports", async (c) => {
	const { results } = await c.env.NF_DB
		.prepare(
			`SELECT r.id, r.reason, r.details, r.reporter_email AS "email", r.status, r.resolution, r.created_at AS "createdAt",
				m.id AS "memorialId", m.name AS "memorialName", m.status AS "memorialStatus"
			 FROM abuse_reports r JOIN memorials m ON m.id = r.memorial_id ORDER BY r.status, r.created_at DESC LIMIT 100`,
		)
		.all();
	return c.json({ reports: results });
});

app.get("/admin/requests", async (c) => {
	const { results } = await c.env.NF_DB
		.prepare(
			`SELECT r.id, r.kind, r.details, r.requester_name AS "name", r.requester_email AS "email", r.relationship, r.status, r.resolution,
				r.created_at AS "createdAt", m.id AS "memorialId", m.name AS "memorialName", m.status AS "memorialStatus"
			 FROM edit_requests r JOIN memorials m ON m.id = r.memorial_id ORDER BY r.status, r.created_at DESC LIMIT 100`,
		)
		.all();
	return c.json({ requests: results });
});

for (const [path, table] of [
	["reports", "abuse_reports"],
	["requests", "edit_requests"],
] as const) {
	app.post(`/admin/${path}/:id/resolve`, async (c) => {
		const resolution = str((await json(c)).resolution, 300);
		const result = await c.env.NF_DB
			.prepare(`UPDATE ${table} SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id = ? AND status = 'open'`)
			.bind(resolution, now(), c.req.param("id"))
			.run();
		if (!result.meta.changes) fail(404, "Not found.");
		await c.env.NF_DB
			.prepare("INSERT INTO admin_log (id, role, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
			.bind(uuid(), c.get("role"), `resolved ${path.slice(0, -1)}`, c.req.param("id"), resolution, now())
			.run();
		return c.json({ ok: true });
	});
}

app.get("/admin/log", async (c) => {
	const { results } = await c.env.NF_DB
		.prepare(`SELECT id, role, action, target, detail, created_at AS "createdAt" FROM admin_log ORDER BY created_at DESC LIMIT 100`)
		.all();
	return c.json({ log: results });
});

export default app;
