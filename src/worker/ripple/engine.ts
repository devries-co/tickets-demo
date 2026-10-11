import Anthropic from "@anthropic-ai/sdk";

export type Env = { DB: D1Database; ANTHROPIC_API_KEY?: string };
export type Kind = "message" | "visit" | "invite" | "quiet" | "remember";

const MODEL = "claude-opus-5-5";
const OPEN_STATUSES = "('suggested','offered','accepted_by_supporter','invitation_sent')";
const DAY = 24 * 60 * 60 * 1000;

export const now = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();
export const firstName = (name: string) => name.trim().split(/\s+/)[0] || "your friend";

// ---------------------------------------------------------------- notifications

/**
 * In-app notification. Callers pass only generic wording: nothing from a
 * check-in may ever appear in a title or body. `dedupeKey` makes retries safe.
 */
export async function notify(
	db: D1Database,
	userId: string | null,
	circleId: string,
	kind: string,
	title: string,
	body: string,
	dedupeKey: string,
) {
	if (!userId) return;
	const pref = await db
		.prepare("SELECT paused FROM notification_preferences WHERE user_id = ?")
		.bind(userId)
		.first<{ paused: number }>();
	if (pref?.paused) return;
	await db
		.prepare(
			`INSERT OR IGNORE INTO notifications (id, user_id, circle_id, kind, title, body, dedupe_key, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(uuid(), userId, circleId, kind, title, body, dedupeKey, now())
		.run();
}

export function logActivity(db: D1Database, circleId: string, actorName: string, kind: string) {
	return db
		.prepare("INSERT INTO activity (id, circle_id, actor_name, kind, created_at) VALUES (?, ?, ?, ?, ?)")
		.bind(uuid(), circleId, actorName, kind, now())
		.run();
}

// ------------------------------------------------------------- recommendations

type Facts = {
	name: string;
	relationship: string;
	kind: Kind;
	methods: string[];
	shareNeed: boolean;
	dateLabel: string | null;
};

type Recommendation = {
	title: string;
	body: string;
	suggestedMessage: string;
	source: "ai" | "template";
	model: string | null;
};

const KIND_DESCRIPTION: Record<Kind, string> = {
	message: "a simple message, with no reply expected",
	visit: "a short visit or coffee together",
	invite: "an invitation to do something simple together",
	quiet: "quiet company, with no need to talk about anything",
	remember: "a short note of remembrance around a meaningful date",
};

const SYSTEM = `You are the support coordination assistant inside Ripple, a grief support tool. You write one short suggestion for a supporter (a friend, relative or church member) about a small way to offer connection to someone who is grieving. The supporter then decides whether to act, and contacts the person themselves.

You are not a therapist and you do not assess anyone. Work only from the facts you are given.

Write three fields:
- title: three to six words, warm and plain. Example: "A Small Moment of Connection".
- body: two to four short sentences addressed to the supporter. Suggest the one kind of connection named in the facts. Make clear there is no need to ask difficult questions or to expect a response.
- suggested_message: one to three sentences the supporter could send in their own voice, addressed to the person by first name. It should offer, not ask for anything, and should make it easy to say no.

Rules:
- Never say or imply how the person feels, and never mention loneliness, struggling, sadness, mental health, or that the person asked for anything, unless the facts include "disclosed_context". If they do, you may refer to it gently, once, in the body only.
- Never diagnose, never suggest the person is at risk, and never draw conclusions from silence or from them not replying.
- No guilt, pressure, urgency, or obligation, toward either the supporter or the person.
- Do not write as if you are the supporter or the person, apart from the suggested_message draft.
- The person's pronouns are unknown: use their first name or "they".
- Plain, conversational language. No clichés about grief, no platitudes, no exclamation marks, no emoji.`;

const SCHEMA = {
	type: "object",
	properties: {
		title: { type: "string" },
		body: { type: "string" },
		suggested_message: { type: "string" },
	},
	required: ["title", "body", "suggested_message"],
	additionalProperties: false,
};

const NEVER = /diagnos|depress|suicid|mental health|disorder|at risk|worried about/i;
const NEED_WORDS = /lonel|alone|isolat|struggl|having a hard|hard time|asked for|reached out for/i;

/** The model's output is only used if it passes the same privacy rules the templates are written to. */
function passes(text: string, shareNeed: boolean) {
	if (NEVER.test(text)) return false;
	if (!shareNeed && NEED_WORDS.test(text)) return false;
	return true;
}

function template(f: Facts): Recommendation {
	const n = f.name;
	const closing = "No need to ask difficult questions or expect a response. Just offer connection.";
	const byKind: Record<Kind, [string, string, string]> = {
		message: [
			"A Small Moment of Connection",
			`It's a good week to let ${n} know they're remembered. Would you consider sending a short note? ${closing}`,
			`Hey ${n}, you crossed my mind today. No need to write back. I just wanted you to know I'm thinking of you.`,
		],
		visit: [
			"A Small Moment of Connection",
			`It's a good week to let ${n} know they're remembered. Would you consider inviting ${n} to coffee, or stopping by for a short visit? ${closing}`,
			`Hey ${n}, you crossed my mind today. I'd love to grab coffee sometime this week if you're up for it. No pressure at all.`,
		],
		invite: [
			"An Invitation to Share",
			`Would you consider inviting ${n} to do something simple with you this week, like a walk or a meal? An invitation still means something when the answer is "not this time."`,
			`Hey ${n}, I'm planning a walk this weekend and would love your company if you feel like it. No pressure either way.`,
		],
		quiet: [
			"Just Be There",
			`Would you consider offering ${n} some quiet company this week? You don't have to talk about anything. Sometimes just being together is enough.`,
			`Hey ${n}, would it be alright if I came by and kept you company for a little while? We don't have to talk about anything.`,
		],
		remember: [
			"A Day Worth Remembering",
			`${f.dateLabel ?? "A meaningful day"} is coming up for ${n}. A short note to say you remember can mean a great deal. ${closing}`,
			`Hey ${n}, I know ${f.dateLabel ?? "a meaningful day"} is coming up. I'm thinking of you, and remembering with you.`,
		],
	};
	const [title, body, suggestedMessage] = byKind[f.kind];
	return {
		title,
		body: f.shareNeed ? `${n} has shared that the days have felt lonely lately. ${body}` : body,
		suggestedMessage,
		source: "template",
		model: null,
	};
}

/**
 * Asks Claude for the suggestion, falling back to a written template when no
 * API key is configured, the call fails, or the output breaks a privacy rule.
 * The model receives a first name, a relationship label and the kind of
 * connection. It never receives check-in answers, notes, emails or surnames.
 */
export async function recommend(env: Env, facts: Facts): Promise<Recommendation> {
	const fallback = template(facts);
	if (!env.ANTHROPIC_API_KEY) return fallback;
	try {
		const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 20_000 });
		const response = await client.beta.messages.create({
			model: MODEL,
			max_tokens: 4000,
			system: SYSTEM,
			// If a safety classifier declines the request, let the API retry on its recommended model.
			betas: ["server-side-fallback-2026-07-01"],
			fallbacks: "default",
			output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
			messages: [
				{
					role: "user",
					content: JSON.stringify({
						person_first_name: facts.name,
						supporter_relationship: facts.relationship || "friend",
						connection_type: KIND_DESCRIPTION[facts.kind],
						preferred_contact_methods: facts.methods,
						...(facts.dateLabel ? { upcoming_date: facts.dateLabel } : {}),
						...(facts.shareNeed
							? { disclosed_context: `${facts.name} has chosen to share that they have been feeling alone.` }
							: {}),
					}),
				},
			],
		});
		if (response.stop_reason !== "end_turn") return fallback;
		const text = response.content.find((block) => block.type === "text")?.text;
		if (!text) return fallback;
		const out = JSON.parse(text) as { title: string; body: string; suggested_message: string };
		const title = out.title?.trim();
		const body = out.body?.trim();
		const message = out.suggested_message?.trim();
		if (!title || !body || !message) return fallback;
		if (title.length > 80 || body.length > 600 || message.length > 400) return fallback;
		if (![title, body, message].every((part) => passes(part, facts.shareNeed))) return fallback;
		// The disclosure belongs in the guidance to the supporter, never in the message they send.
		if (NEED_WORDS.test(message)) return fallback;
		return { title, body, suggestedMessage: message, source: "ai", model: response.model };
	} catch {
		// Deliberately not logging the error body: it can echo request content.
		console.warn("ripple: recommendation request failed, using template");
		return fallback;
	}
}

// ------------------------------------------------------------------ rotation

type OpportunityRow = {
	id: string;
	circle_id: string;
	kind: Kind;
	status: string;
	share_need: number;
	allowed_member_ids: string | null;
	date_label: string | null;
};

type Candidate = { id: string; user_id: string | null; relationship: string };

/**
 * Offers an opportunity to the next supporter in rotation. Skips anyone who
 * has already been offered this one, anyone without permission, and anyone
 * marked unavailable; prefers whoever has been asked least and declined least.
 * Returns false when nobody is eligible.
 */
export async function offerNext(env: Env, opportunityId: string) {
	const db = env.DB;
	const opp = await db.prepare("SELECT * FROM opportunities WHERE id = ?").bind(opportunityId).first<OpportunityRow>();
	if (!opp || !["suggested", "offered"].includes(opp.status)) return false;

	const since = new Date(Date.now() - 30 * DAY).toISOString();
	const { results } = await db
		.prepare(
			`SELECT m.id, m.user_id, m.relationship,
				(SELECT COUNT(*) FROM support_offers o WHERE o.member_id = m.id AND o.created_at > ?1) AS recent,
				(SELECT COUNT(*) FROM support_offers o WHERE o.member_id = m.id AND o.status = 'declined' AND o.created_at > ?1) AS declines,
				(SELECT MAX(o.created_at) FROM support_offers o WHERE o.member_id = m.id) AS last_offer
			 FROM circle_members m
			 JOIN member_permissions p ON p.member_id = m.id AND p.permission = 'personalized_outreach'
			 WHERE m.circle_id = ?2 AND m.status = 'active' AND m.role IN ('supporter', 'admin')
				AND m.availability != 'unavailable'
				AND m.id NOT IN (SELECT member_id FROM support_offers WHERE opportunity_id = ?3)
			 ORDER BY declines ASC, recent ASC, last_offer ASC`,
		)
		.bind(since, opp.circle_id, opp.id)
		.all<Candidate>();

	const allowed: string[] | null = opp.allowed_member_ids ? JSON.parse(opp.allowed_member_ids) : null;
	const next = results.find((m) => !allowed || allowed.includes(m.id));
	if (!next) {
		const tried = await db
			.prepare("SELECT COUNT(*) AS n FROM support_offers WHERE opportunity_id = ?")
			.bind(opp.id)
			.first<{ n: number }>();
		// Everyone has passed: close it. Nobody eligible yet: leave it for the scheduler to retry.
		await db
			.prepare("UPDATE opportunities SET status = ?, assigned_member_id = NULL, updated_at = ? WHERE id = ?")
			.bind(tried?.n ? "declined" : "suggested", now(), opp.id)
			.run();
		return false;
	}

	const circle = await db
		.prepare(
			`SELECT c.griever_name, p.methods FROM circles c
			 LEFT JOIN support_preferences p ON p.circle_id = c.id WHERE c.id = ?`,
		)
		.bind(opp.circle_id)
		.first<{ griever_name: string; methods: string | null }>();
	if (!circle) return false;
	const name = firstName(circle.griever_name);

	const rec = await recommend(env, {
		name,
		relationship: next.relationship,
		kind: opp.kind,
		methods: JSON.parse(circle.methods ?? '["text"]'),
		shareNeed: !!opp.share_need,
		dateLabel: opp.date_label,
	});

	const offerId = uuid();
	const at = now();
	await db.batch([
		db
			.prepare(
				"INSERT INTO support_offers (id, opportunity_id, member_id, status, created_at) VALUES (?, ?, ?, 'offered', ?)",
			)
			.bind(offerId, opp.id, next.id, at),
		db
			.prepare(
				`INSERT INTO recommendations (id, opportunity_id, member_id, title, body, suggested_message, source, model, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(uuid(), opp.id, next.id, rec.title, rec.body, rec.suggestedMessage, rec.source, rec.model, at),
		db
			.prepare("UPDATE opportunities SET status = 'offered', assigned_member_id = ?, updated_at = ? WHERE id = ?")
			.bind(next.id, at, opp.id),
	]);
	await notify(
		db,
		next.user_id,
		opp.circle_id,
		"opportunity",
		"A small moment of connection",
		`There's a new way to be there for ${name}, whenever you have a moment.`,
		`offer:${offerId}`,
	);
	return true;
}

/** Withdraws anything not yet claimed. Used when support is paused or space is requested. */
export async function cancelUnclaimed(db: D1Database, circleId: string) {
	const at = now();
	await db.batch([
		db
			.prepare(
				`UPDATE support_offers SET status = 'withdrawn', responded_at = ?
				 WHERE status = 'offered' AND opportunity_id IN
					(SELECT id FROM opportunities WHERE circle_id = ? AND status IN ('suggested', 'offered'))`,
			)
			.bind(at, circleId),
		db
			.prepare(
				`UPDATE opportunities SET status = 'canceled', updated_at = ?
				 WHERE circle_id = ? AND status IN ('suggested', 'offered')`,
			)
			.bind(at, circleId),
	]);
}

export async function hasOpenOpportunity(db: D1Database, circleId: string) {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM opportunities WHERE circle_id = ? AND status IN ${OPEN_STATUSES}`)
		.bind(circleId)
		.first<{ n: number }>();
	return !!row?.n;
}

// ----------------------------------------------------------------- scheduler

type CircleRow = {
	id: string;
	griever_name: string;
	frequency: string | null;
	support_types: string | null;
	allow_multiple: number | null;
	space_until: string | null;
};

/** Days until the next occurrence of a month/day, counted in UTC. */
export function daysUntil(month: number, day: number, from = new Date()) {
	const today = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
	let next = Date.UTC(from.getUTCFullYear(), month - 1, day);
	if (next < today) next = Date.UTC(from.getUTCFullYear() + 1, month - 1, day);
	return Math.round((next - today) / DAY);
}

function weekStart(from = new Date()) {
	const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
	d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
	return d;
}

/** Inserts an opportunity unless one with the same dedupe key already exists. */
async function createOnce(db: D1Database, circleId: string, kind: Kind, origin: string, key: string, dateLabel?: string) {
	const id = uuid();
	const at = now();
	const result = await db
		.prepare(
			`INSERT OR IGNORE INTO opportunities (id, circle_id, kind, origin, status, date_label, dedupe_key, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'suggested', ?, ?, ?, ?)`,
		)
		.bind(id, circleId, kind, origin, dateLabel ?? null, key, at, at)
		.run();
	return result.meta.changes ? id : null;
}

async function scheduleCircle(env: Env, circle: CircleRow) {
	const db = env.DB;
	const frequency = circle.frequency ?? "once";
	if (frequency === "paused") return;
	if (circle.space_until && circle.space_until > now()) return;

	// An offer nobody has answered in three days moves on to the next supporter.
	const stale = new Date(Date.now() - 3 * DAY).toISOString();
	const { results: waiting } = await db
		.prepare(
			`SELECT o.id AS offer_id, o.opportunity_id FROM support_offers o
			 JOIN opportunities p ON p.id = o.opportunity_id
			 WHERE p.circle_id = ? AND p.status = 'offered' AND o.status = 'offered' AND o.created_at < ?`,
		)
		.bind(circle.id, stale)
		.all<{ offer_id: string; opportunity_id: string }>();
	for (const w of waiting) {
		await db
			.prepare("UPDATE support_offers SET status = 'withdrawn', responded_at = ? WHERE id = ?")
			.bind(now(), w.offer_id)
			.run();
		await offerNext(env, w.opportunity_id);
	}

	// Retry anything that had no eligible supporter last time.
	const { results: unplaced } = await db
		.prepare("SELECT id FROM opportunities WHERE circle_id = ? AND status = 'suggested'")
		.bind(circle.id)
		.all<{ id: string }>();
	for (const o of unplaced) await offerNext(env, o.id);

	// Meaningful dates the grieving person chose to share, a week ahead.
	const { results: dates } = await db
		.prepare("SELECT id, label, month, day FROM meaningful_dates WHERE circle_id = ? AND shared = 1")
		.bind(circle.id)
		.all<{ id: string; label: string; month: number; day: number }>();
	for (const d of dates) {
		const away = daysUntil(d.month, d.day);
		if (away > 7) continue;
		const year = new Date(Date.now() + away * DAY).getUTCFullYear();
		const id = await createOnce(db, circle.id, "remember", "date", `date:${d.id}:${year}`, d.label);
		if (id) await offerNext(env, id);
	}

	// Recurring connection opportunities.
	const quota = frequency === "weekly" ? 1 : frequency === "twice_weekly" ? 2 : 0;
	if (!quota) return;
	const start = weekStart();
	const used = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM opportunities
			 WHERE circle_id = ? AND origin IN ('schedule', 'checkin') AND created_at >= ? AND status != 'canceled'`,
		)
		.bind(circle.id, start.toISOString())
		.first<{ n: number }>();
	// Twice a week means one early and one from Thursday on, not two at once.
	const dueByNow = quota === 2 && (new Date().getUTCDay() + 6) % 7 < 3 ? 1 : quota;
	if ((used?.n ?? 0) >= dueByNow) return;
	if (!circle.allow_multiple && (await hasOpenOpportunity(db, circle.id))) return;

	const types: Kind[] = JSON.parse(circle.support_types ?? '["message"]');
	if (!types.length) return;
	const total = await db
		.prepare("SELECT COUNT(*) AS n FROM opportunities WHERE circle_id = ? AND origin = 'schedule'")
		.bind(circle.id)
		.first<{ n: number }>();
	const kind = types[(total?.n ?? 0) % types.length];
	const slot = (used?.n ?? 0) + 1;
	const id = await createOnce(db, circle.id, kind, "schedule", `sched:${circle.id}:${start.toISOString().slice(0, 10)}:${slot}`);
	if (id) await offerNext(env, id);
}

/**
 * The background job. Runs daily from a cron trigger, and for a single circle
 * whenever its dashboards load. Every step is idempotent (dedupe keys, status
 * checks), so a failed run is simply retried by the next one, and one circle
 * failing never blocks the others.
 */
export async function runScheduler(env: Env, circleId?: string) {
	const { results } = await env.DB
		.prepare(
			`SELECT c.id, c.griever_name, p.frequency, p.support_types, p.allow_multiple, p.space_until
			 FROM circles c LEFT JOIN support_preferences p ON p.circle_id = c.id
			 WHERE c.status = 'active' ${circleId ? "AND c.id = ?" : ""}`,
		)
		.bind(...(circleId ? [circleId] : []))
		.all<CircleRow>();
	for (const circle of results) {
		try {
			await scheduleCircle(env, circle);
		} catch {
			console.warn("ripple: scheduling failed for one circle; it will be retried on the next run");
		}
	}
}
