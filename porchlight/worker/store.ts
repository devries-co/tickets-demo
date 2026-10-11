// One Durable Object holds every circle in its SQLite storage. The Worker
// forwards /api/porchlight/* here, so all reads and writes happen next to the
// data, and the DO's alarm handles debounced light-change texts.

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import {
	EMPTY_CARD,
	EMPTY_WORK,
	HELP_OPTIONS,
	WORK_HELPS,
	WORK_MENTION,
	type AdminCircle,
	type Card,
	type Light,
	type OutboxMessage,
	type PlannedMessage,
	type PublicCircle,
	type WorkCard,
	type WorkView,
} from "../shared";
import { daysBetween, lightChangeText, planForDate, stepAwayText, welcomeText, type PlanCircle } from "./coaching";
import { normalizePhone, sendSms, smsLive, type SmsEnv } from "./sms";

export interface PorchlightEnv extends SmsEnv {
	PUBLIC_BASE_URL?: string;
	SUPPORT_DIRECTORY_URL?: string;
}

/** Wait this long after the last light change before texting the circle, so a few taps don't become a few texts. */
const NOTIFY_DELAY_MS = 2 * 60_000;
const STEP_AWAY_COOLDOWN_MS = 5 * 60_000;
const MAX_SUPPORTERS = 250;
/** Scheduled coaching only goes out between these local hours. */
const SEND_FROM_HOUR = 9;
const SEND_UNTIL_HOUR = 20;
const DEFAULT_DIRECTORY = "https://www.mygriefguide.com";

type Row = Record<string, SqlStorageValue>;

interface CircleRow {
	id: string;
	admin_token: string;
	join_code: string;
	work_code: string;
	griever_name: string;
	griever_phone: string;
	loved_one_name: string;
	relationship: string;
	loss_date: string;
	timezone: string;
	light: string | null;
	light_note: string;
	light_notified: string | null;
	pending_notify: number | null;
	card: string;
	work: string;
	sponsor: string;
	base_url: string;
	last_step_away: number;
	created_at: number;
}

class HttpError extends Error {
	constructor(
		public status: 400 | 404 | 429,
		message: string,
	) {
		super(message);
	}
}

function token(bytes: number): string {
	const buf = crypto.getRandomValues(new Uint8Array(bytes));
	return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Short, unambiguous, easy to read off a printed card. */
function shortCode(len: number): string {
	const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
	const buf = crypto.getRandomValues(new Uint8Array(len));
	return Array.from(buf, (b) => alphabet[b % alphabet.length]).join("");
}

function text(v: unknown, max: number): string {
	return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function isLight(v: unknown): v is Light {
	return v === "on" || v === "dim" || v === "off";
}

function isIsoDate(v: unknown): v is string {
	return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}

function validTimezone(tz: unknown): string {
	if (typeof tz !== "string") return "America/Chicago";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return tz;
	} catch {
		return "America/Chicago";
	}
}

function localNow(tz: string, now: number): { date: string; hour: number } {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(new Date(now))
			.map((p) => [p.type, p.value]),
	);
	return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function sanitizeCard(input: unknown): Card {
	const c = (input ?? {}) as Partial<Card>;
	const helpIds = new Set<string>(HELP_OPTIONS.map((h) => h.id));
	return {
		sayName: c.sayName === "yes" || c.sayName === "not_yet" ? c.sayName : null,
		meals: c.meals === "yes" || c.meals === "no" ? c.meals : null,
		allergies: text(c.allergies, 200),
		help: Array.isArray(c.help) ? c.help.filter((h) => typeof h === "string" && helpIds.has(h)) : [],
		hardDates: (Array.isArray(c.hardDates) ? c.hardDates : [])
			.filter((d) => d && isIsoDate(d.date) && text(d.label, 80))
			.slice(0, 30)
			.map((d) => ({
				id: text(d.id, 40) || shortCode(8),
				label: text(d.label, 80),
				date: d.date,
				yearly: d.yearly !== false,
			})),
		note: text(c.note, 400),
	};
}

function sanitizeWork(input: unknown): WorkCard {
	const w = (input ?? {}) as Partial<WorkCard>;
	const helpIds = new Set<string>(WORK_HELPS.map((h) => h.id));
	const phone = text(w.managerPhone, 40);
	if (phone && !normalizePhone(phone)) throw new HttpError(400, "That manager phone number doesn't look right.");
	return {
		enabled: Boolean(w.enabled),
		mention: w.mention && w.mention in WORK_MENTION ? w.mention : null,
		helps: Array.isArray(w.helps) ? w.helps.filter((h) => typeof h === "string" && helpIds.has(h)) : [],
		note: text(w.note, 300),
		managerName: text(w.managerName, 60),
		managerPhone: phone ? normalizePhone(phone)! : "",
	};
}

export class PorchlightStore extends DurableObject<PorchlightEnv> {
	private sql: SqlStorage;
	private app = new Hono();

	constructor(ctx: DurableObjectState, env: PorchlightEnv) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS circles (
				id TEXT PRIMARY KEY,
				admin_token TEXT NOT NULL UNIQUE,
				join_code TEXT NOT NULL UNIQUE,
				work_code TEXT NOT NULL UNIQUE,
				griever_name TEXT NOT NULL,
				griever_phone TEXT NOT NULL DEFAULT '',
				loved_one_name TEXT NOT NULL,
				relationship TEXT NOT NULL DEFAULT '',
				loss_date TEXT NOT NULL DEFAULT '',
				timezone TEXT NOT NULL,
				light TEXT,
				light_note TEXT NOT NULL DEFAULT '',
				light_notified TEXT,
				pending_notify INTEGER,
				card TEXT NOT NULL,
				work TEXT NOT NULL,
				sponsor TEXT NOT NULL DEFAULT '',
				base_url TEXT NOT NULL,
				last_step_away INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS supporters (
				id TEXT PRIMARY KEY,
				circle_id TEXT NOT NULL,
				token TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				phone TEXT NOT NULL,
				relationship TEXT NOT NULL DEFAULT '',
				active INTEGER NOT NULL DEFAULT 1,
				joined_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS supporters_circle ON supporters(circle_id);
			CREATE INDEX IF NOT EXISTS supporters_phone ON supporters(phone);
			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				circle_id TEXT NOT NULL,
				recipient_name TEXT NOT NULL,
				phone TEXT NOT NULL,
				kind TEXT NOT NULL,
				body TEXT NOT NULL,
				status TEXT NOT NULL,
				error TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL,
				dedupe TEXT UNIQUE
			);
			CREATE INDEX IF NOT EXISTS messages_circle ON messages(circle_id, id);
		`);
		this.routes();
	}

	fetch(request: Request): Promise<Response> {
		return Promise.resolve(this.app.fetch(request));
	}

	// ---------- helpers ----------

	private one<T>(query: string, ...binds: SqlStorageValue[]): T | null {
		const rows = this.sql.exec(query, ...binds).toArray();
		return (rows[0] as T | undefined) ?? null;
	}

	private circleBy(column: "admin_token" | "join_code" | "work_code" | "id", value: string): CircleRow {
		const row = this.one<CircleRow>(`SELECT * FROM circles WHERE ${column} = ?`, value);
		if (!row) throw new HttpError(404, "We couldn't find that porch light. The link may be incomplete.");
		return row;
	}

	private baseUrl(c: CircleRow): string {
		return (this.env.PUBLIC_BASE_URL || c.base_url).replace(/\/+$/, "");
	}

	private planCircle(c: CircleRow): PlanCircle {
		const base = this.baseUrl(c);
		return {
			grieverName: c.griever_name,
			lovedOneName: c.loved_one_name,
			lossDate: c.loss_date,
			light: isLight(c.light) ? c.light : null,
			card: { ...EMPTY_CARD, ...(JSON.parse(c.card) as Card) },
			circleUrl: `${base}/porchlight/c/${c.join_code}`,
			adminUrl: `${base}/porchlight/g/${c.admin_token}`,
			supportDirectoryUrl: this.env.SUPPORT_DIRECTORY_URL || DEFAULT_DIRECTORY,
		};
	}

	private activeSupporters(circleId: string): { id: string; name: string; phone: string }[] {
		return this.sql
			.exec("SELECT id, name, phone FROM supporters WHERE circle_id = ? AND active = 1", circleId)
			.toArray() as { id: string; name: string; phone: string }[];
	}

	/**
	 * Record and send one text. With a dedupe key, a message that was already
	 * recorded is skipped, which makes the hourly scheduler safe to re-run.
	 */
	private async deliver(
		circleId: string,
		recipientName: string,
		phone: string,
		kind: string,
		body: string,
		dedupe: string | null = null,
	): Promise<void> {
		const now = Date.now();
		const inserted = this.sql
			.exec(
				`INSERT OR IGNORE INTO messages (circle_id, recipient_name, phone, kind, body, status, created_at, dedupe)
				 VALUES (?, ?, ?, ?, ?, 'demo', ?, ?) RETURNING id`,
				circleId,
				recipientName,
				phone,
				kind,
				body,
				now,
				dedupe,
			)
			.toArray();
		if (!inserted.length || !phone) return; // duplicate, or an in-app-only note
		const result = await sendSms(this.env, phone, body);
		this.sql.exec("UPDATE messages SET status = ?, error = ? WHERE id = ?", result.status, result.error, inserted[0].id);
	}

	private async deliverPlanned(c: CircleRow, plan: PlannedMessage[], day: string): Promise<void> {
		for (const m of plan) {
			if (m.audience === "griever") {
				await this.deliver(c.id, "You", c.griever_phone, m.kind, m.body, `${c.id}:${m.kind}:${day}:griever`);
			} else {
				for (const s of this.activeSupporters(c.id)) {
					await this.deliver(c.id, s.name, s.phone, m.kind, m.body, `${c.id}:${m.kind}:${day}:${s.id}`);
				}
			}
		}
	}

	private publicView(c: CircleRow): PublicCircle {
		const plan = this.planCircle(c);
		const size = this.one<{ n: number }>(
			"SELECT COUNT(*) AS n FROM supporters WHERE circle_id = ? AND active = 1",
			c.id,
		)!.n;
		const today = localNow(c.timezone, Date.now()).date;
		return {
			grieverName: c.griever_name,
			lovedOneName: c.loved_one_name,
			light: plan.light,
			lightNote: c.light_note,
			card: plan.card,
			sponsor: c.sponsor,
			circleSize: size,
			daysSinceLoss: c.loss_date ? daysBetween(c.loss_date, today) : null,
		};
	}

	private adminView(c: CircleRow): AdminCircle {
		const supporters = this.sql
			.exec(
				"SELECT id, name, relationship, active, joined_at FROM supporters WHERE circle_id = ? ORDER BY joined_at",
				c.id,
			)
			.toArray()
			.map((r: Row) => ({
				id: r.id as string,
				name: r.name as string,
				relationship: r.relationship as string,
				active: r.active === 1,
				joinedAt: r.joined_at as number,
			}));
		const outbox = this.sql
			.exec("SELECT * FROM messages WHERE circle_id = ? ORDER BY id DESC LIMIT 60", c.id)
			.toArray()
			.map(
				(r: Row): OutboxMessage => ({
					id: r.id as number,
					recipientName: r.recipient_name as string,
					phone: r.phone as string,
					kind: r.kind as string,
					body: r.body as string,
					status: r.status as OutboxMessage["status"],
					error: r.error as string,
					createdAt: r.created_at as number,
				}),
			);
		return {
			...this.publicView(c),
			joinCode: c.join_code,
			workCode: c.work_code,
			grieverPhone: c.griever_phone,
			relationship: c.relationship,
			lossDate: c.loss_date,
			timezone: c.timezone,
			work: { ...EMPTY_WORK, ...(JSON.parse(c.work) as WorkCard) },
			supporters,
			outbox,
			smsLive: smsLive(this.env),
			supportDirectoryUrl: this.env.SUPPORT_DIRECTORY_URL || DEFAULT_DIRECTORY,
			pendingNotify: c.pending_notify !== null,
		};
	}

	private async scheduleAlarm(): Promise<void> {
		const next = this.one<{ t: number | null }>("SELECT MIN(pending_notify) AS t FROM circles")?.t;
		if (next) await this.ctx.storage.setAlarm(next);
	}

	/** Texts the circle about light changes that have settled. */
	async alarm(): Promise<void> {
		const now = Date.now();
		const due = this.sql
			.exec("SELECT * FROM circles WHERE pending_notify IS NOT NULL AND pending_notify <= ?", now)
			.toArray() as unknown as CircleRow[];
		for (const c of due) {
			this.sql.exec("UPDATE circles SET pending_notify = NULL WHERE id = ?", c.id);
			if (!isLight(c.light) || c.light === c.light_notified) continue; // toggled back; nothing to say
			this.sql.exec("UPDATE circles SET light_notified = ? WHERE id = ?", c.light, c.id);
			const body = lightChangeText(this.planCircle(c), c.light, c.light_note);
			for (const s of this.activeSupporters(c.id)) {
				await this.deliver(c.id, s.name, s.phone, `light-${c.light}`, body);
			}
		}
		await this.scheduleAlarm();
	}

	/** Called by the hourly cron: sends whatever the calendar holds for each circle's local today. */
	async tick(now = Date.now()): Promise<void> {
		const circles = this.sql.exec("SELECT * FROM circles").toArray() as unknown as CircleRow[];
		for (const c of circles) {
			const { date, hour } = localNow(c.timezone, now);
			if (hour < SEND_FROM_HOUR || hour > SEND_UNTIL_HOUR) continue;
			await this.deliverPlanned(c, planForDate(this.planCircle(c), date), date);
		}
	}

	// ---------- HTTP API ----------

	private routes(): void {
		const api = this.app.basePath("/api/porchlight");
		const json = async <T>(req: Request): Promise<T> => {
			try {
				return (await req.json()) as T;
			} catch {
				throw new HttpError(400, "Invalid request.");
			}
		};

		this.app.onError((err, c) => {
			if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
			console.error(err);
			return c.json({ error: "Something went wrong on our end." }, 500);
		});

		api.get("/status", (c) => c.json({ smsLive: smsLive(this.env) }));

		api.post("/circles", async (c) => {
			const b = await json<Record<string, unknown>>(c.req.raw);
			const grieverName = text(b.grieverName, 40);
			const lovedOneName = text(b.lovedOneName, 40);
			if (!grieverName || !lovedOneName) throw new HttpError(400, "We just need your first name and theirs.");
			const phoneRaw = text(b.grieverPhone, 40);
			const grieverPhone = phoneRaw ? normalizePhone(phoneRaw) : "";
			if (grieverPhone === null) throw new HttpError(400, "That phone number doesn't look right.");
			const id = token(12);
			const adminToken = token(24);
			const joinCode = shortCode(8);
			this.sql.exec(
				`INSERT INTO circles (id, admin_token, join_code, work_code, griever_name, griever_phone, loved_one_name,
					relationship, loss_date, timezone, card, work, sponsor, base_url, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				adminToken,
				joinCode,
				shortCode(10),
				grieverName,
				grieverPhone,
				lovedOneName,
				text(b.relationship, 40),
				isIsoDate(b.lossDate) ? b.lossDate : "",
				validTimezone(b.timezone),
				JSON.stringify(EMPTY_CARD),
				JSON.stringify(EMPTY_WORK),
				text(b.sponsor, 80),
				new URL(c.req.url).origin,
				Date.now(),
			);
			return c.json({ adminToken, joinCode });
		});

		// ----- griever (secret admin link) -----

		api.get("/g/:token", (c) => c.json(this.adminView(this.circleBy("admin_token", c.req.param("token")))));

		api.put("/g/:token/light", async (c) => {
			const circle = this.circleBy("admin_token", c.req.param("token"));
			const b = await json<{ light?: unknown; note?: unknown; quiet?: unknown }>(c.req.raw);
			if (!isLight(b.light)) throw new HttpError(400, "Pick on, dim, or off.");
			const note = text(b.note, 140);
			if (b.quiet) {
				// Silent change: the circle page updates, nobody gets a text.
				this.sql.exec(
					"UPDATE circles SET light = ?, light_note = ?, light_notified = ?, pending_notify = NULL WHERE id = ?",
					b.light,
					note,
					b.light,
					circle.id,
				);
			} else {
				this.sql.exec(
					"UPDATE circles SET light = ?, light_note = ?, pending_notify = ? WHERE id = ?",
					b.light,
					note,
					Date.now() + NOTIFY_DELAY_MS,
					circle.id,
				);
				await this.scheduleAlarm();
			}
			return c.json(this.adminView(this.circleBy("id", circle.id)));
		});

		api.put("/g/:token/card", async (c) => {
			const circle = this.circleBy("admin_token", c.req.param("token"));
			const card = sanitizeCard(await json(c.req.raw));
			this.sql.exec("UPDATE circles SET card = ? WHERE id = ?", JSON.stringify(card), circle.id);
			return c.json(this.adminView(this.circleBy("id", circle.id)));
		});

		api.put("/g/:token/profile", async (c) => {
			const circle = this.circleBy("admin_token", c.req.param("token"));
			const b = await json<Record<string, unknown>>(c.req.raw);
			const grieverName = text(b.grieverName, 40) || circle.griever_name;
			const lovedOneName = text(b.lovedOneName, 40) || circle.loved_one_name;
			const phoneRaw = text(b.grieverPhone, 40);
			const grieverPhone = phoneRaw ? normalizePhone(phoneRaw) : "";
			if (grieverPhone === null) throw new HttpError(400, "That phone number doesn't look right.");
			this.sql.exec(
				`UPDATE circles SET griever_name = ?, loved_one_name = ?, griever_phone = ?, relationship = ?,
					loss_date = ?, timezone = ?, sponsor = ? WHERE id = ?`,
				grieverName,
				lovedOneName,
				grieverPhone,
				text(b.relationship, 40),
				isIsoDate(b.lossDate) ? b.lossDate : "",
				validTimezone(b.timezone ?? circle.timezone),
				text(b.sponsor, 80),
				circle.id,
			);
			return c.json(this.adminView(this.circleBy("id", circle.id)));
		});

		api.put("/g/:token/work", async (c) => {
			const circle = this.circleBy("admin_token", c.req.param("token"));
			const work = sanitizeWork(await json(c.req.raw));
			this.sql.exec("UPDATE circles SET work = ? WHERE id = ?", JSON.stringify(work), circle.id);
			return c.json(this.adminView(this.circleBy("id", circle.id)));
		});

		api.post("/g/:token/step-away", async (c) => {
			const circle = this.circleBy("admin_token", c.req.param("token"));
			const work = JSON.parse(circle.work) as WorkCard;
			if (!work.managerPhone) throw new HttpError(400, "Add your manager's number in Work mode first.");
			const now = Date.now();
			if (now - circle.last_step_away < STEP_AWAY_COOLDOWN_MS) {
				return c.json({ ok: true, alreadySent: true });
			}
			this.sql.exec("UPDATE circles SET last_step_away = ? WHERE id = ?", now, circle.id);
			await this.deliver(
				circle.id,
				work.managerName || "Manager",
				work.managerPhone,
				"step-away",
				stepAwayText(circle.griever_name),
			);
			return c.json({ ok: true, alreadySent: false });
		});

		api.delete("/g/:token/supporters/:id", (c) => {
			const circle = this.circleBy("admin_token", c.req.param("token"));
			this.sql.exec("DELETE FROM supporters WHERE id = ? AND circle_id = ?", c.req.param("id"), circle.id);
			return c.json(this.adminView(circle));
		});

		/** Dry run of the calendar for any date, so the cliff-aware texts can be seen without waiting weeks. */
		api.get("/g/:token/preview", (c) => {
			const circle = this.circleBy("admin_token", c.req.param("token"));
			const date = c.req.query("date");
			if (!isIsoDate(date)) throw new HttpError(400, "Pick a date.");
			return c.json({ date, messages: planForDate(this.planCircle(circle), date) });
		});

		// ----- circle (anyone with the join link) -----

		api.get("/c/:code", (c) => c.json(this.publicView(this.circleBy("join_code", c.req.param("code")))));

		api.post("/c/:code/join", async (c) => {
			const circle = this.circleBy("join_code", c.req.param("code"));
			const b = await json<Record<string, unknown>>(c.req.raw);
			const name = text(b.name, 40);
			const phone = normalizePhone(text(b.phone, 40));
			if (!name) throw new HttpError(400, "What should we call you?");
			if (!phone) throw new HttpError(400, "That phone number doesn't look right.");
			if (!b.consent) throw new HttpError(400, "Please agree to receive texts so we can keep you posted.");
			const existing = this.one<{ id: string; token: string }>(
				"SELECT id, token FROM supporters WHERE circle_id = ? AND phone = ?",
				circle.id,
				phone,
			);
			if (existing) {
				this.sql.exec(
					"UPDATE supporters SET active = 1, name = ?, relationship = ? WHERE id = ?",
					name,
					text(b.relationship, 40),
					existing.id,
				);
				return c.json({ supporterToken: existing.token, rejoined: true });
			}
			const count = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM supporters WHERE circle_id = ?", circle.id)!.n;
			if (count >= MAX_SUPPORTERS) throw new HttpError(429, "This circle is full.");
			const supporterToken = token(18);
			const id = token(9);
			this.sql.exec(
				"INSERT INTO supporters (id, circle_id, token, name, phone, relationship, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				id,
				circle.id,
				supporterToken,
				name,
				phone,
				text(b.relationship, 40),
				Date.now(),
			);
			await this.deliver(circle.id, name, phone, "welcome", welcomeText(this.planCircle(circle), name));
			return c.json({ supporterToken, rejoined: false });
		});

		api.get("/s/:token", (c) => {
			const s = this.one<{ name: string; active: number }>(
				"SELECT name, active FROM supporters WHERE token = ?",
				c.req.param("token"),
			);
			if (!s) throw new HttpError(404, "Not found.");
			return c.json({ name: s.name, active: s.active === 1 });
		});

		api.post("/s/:token/leave", (c) => {
			this.sql.exec("UPDATE supporters SET active = 0 WHERE token = ?", c.req.param("token"));
			return c.json({ ok: true });
		});

		// ----- work mode (limited card for manager and team) -----

		api.get("/w/:code", (c) => {
			const circle = this.circleBy("work_code", c.req.param("code"));
			const work = JSON.parse(circle.work) as WorkCard;
			if (!work.enabled) throw new HttpError(404, "This work card isn't being shared right now.");
			const view: WorkView = {
				grieverName: circle.griever_name,
				mention: work.mention,
				helps: work.helps,
				note: work.note,
			};
			return c.json(view);
		});

		// ----- Twilio inbound webhook: honor STOP / START -----

		api.post("/sms/inbound", async (c) => {
			const form = await c.req.formData();
			const from = normalizePhone(String(form.get("From") ?? ""));
			const body = String(form.get("Body") ?? "")
				.trim()
				.toUpperCase();
			if (from) {
				if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(body)) {
					this.sql.exec("UPDATE supporters SET active = 0 WHERE phone = ?", from);
				} else if (["START", "UNSTOP", "YES"].includes(body)) {
					this.sql.exec("UPDATE supporters SET active = 1 WHERE phone = ?", from);
				}
			}
			// Twilio sends its own STOP/START confirmations, so reply with nothing.
			return c.body("<Response></Response>", 200, { "Content-Type": "text/xml" });
		});
	}
}
