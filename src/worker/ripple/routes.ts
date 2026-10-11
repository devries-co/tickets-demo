import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
	SESSION_COOKIE,
	SESSION_MAX_AGE,
	type User,
	createSession,
	hashPassword,
	randomToken,
	safeEqual,
	sha256,
	userForToken,
} from "./auth";
import {
	type Env,
	type Kind,
	cancelUnclaimed,
	daysUntil,
	firstName,
	hasOpenOpportunity,
	logActivity,
	notify,
	now,
	offerNext,
	runScheduler,
	uuid,
} from "./engine";
import { ensureSchema } from "./schema";

type App = { Bindings: Env; Variables: { user: User | null } };
type Ctx = Context<App>;

type Member = {
	id: string;
	circle_id: string;
	user_id: string | null;
	email: string;
	name: string;
	role: "griever" | "supporter" | "admin";
	relationship: string;
	status: string;
	availability: string;
};

type Circle = {
	id: string;
	name: string;
	griever_user_id: string | null;
	griever_name: string;
	status: "pending_consent" | "active" | "paused";
};

type Prefs = {
	frequency: string;
	methods: string;
	support_types: string;
	allow_multiple: number;
	space_until: string | null;
};

const NEEDS = ["alone", "household", "decisions", "remembering", "space"];
const CONNECTIONS = ["message", "visit", "invite", "quiet", "space"];
const KINDS: Kind[] = ["message", "visit", "invite", "quiet"];
const METHODS = ["text", "call", "email", "in_person"];
const FREQUENCIES = ["once", "weekly", "twice_weekly", "paused"];
const AVAILABILITY = ["flexible", "weekdays", "evenings", "weekends", "unavailable"];
const ACTIVITIES = [
	"Take a short walk",
	"Sit together over coffee",
	"Watch a movie",
	"Share a meal",
	"Work on a puzzle",
	"Sit quietly together",
	"Run errands together",
];

// Direct statements of imminent self-harm risk in the optional private note.
// A match never notifies anyone; it only shows the person crisis resources.
const CRISIS =
	/kill(ing)? myself|end(ing)? my (own )?life|suicid|want to die|wish i (was|were) dead|better off dead|(don'?t|do not) want to (live|be here|be alive)|hurt(ing)? myself|harm(ing)? myself|no reason to live|end it all|take my (own )?life/i;

const fail = (status: ContentfulStatusCode, message: string): never => {
	throw new HTTPException(status, { message });
};

const text = (value: unknown, max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const subset = (value: unknown, allowed: string[]) =>
	Array.isArray(value) ? allowed.filter((item) => value.includes(item)) : [];

async function json(c: Ctx) {
	try {
		const body = await c.req.json();
		if (body && typeof body === "object") return body as Record<string, unknown>;
	} catch {
		// fall through
	}
	return fail(400, "That request couldn't be read.");
}

function requireUser(c: Ctx) {
	return c.get("user") ?? fail(401, "Please sign in.");
}

/**
 * Server-side authorization for everything inside a circle. Anyone who is not
 * an active member with one of the allowed roles gets the same 404 as a
 * circle that doesn't exist.
 */
async function requireMember(c: Ctx, circleId: string, roles: Member["role"][]) {
	const user = requireUser(c);
	const member = await c.env.DB
		.prepare("SELECT * FROM circle_members WHERE circle_id = ? AND user_id = ? AND status = 'active'")
		.bind(circleId, user.id)
		.first<Member>();
	if (!member || !roles.includes(member.role)) return fail(404, "Not found.");
	return member;
}

async function getCircle(db: D1Database, id: string) {
	return (await db.prepare("SELECT * FROM circles WHERE id = ?").bind(id).first<Circle>()) ?? fail(404, "Not found.");
}

async function getPrefs(db: D1Database, circleId: string) {
	const prefs = await db.prepare("SELECT * FROM support_preferences WHERE circle_id = ?").bind(circleId).first<Prefs>();
	return prefs ?? { frequency: "once", methods: '["text"]', support_types: "[]", allow_multiple: 0, space_until: null };
}

const inSpace = (prefs: Prefs) => !!prefs.space_until && prefs.space_until > now();

function recordConsent(db: D1Database, circleId: string, userId: string, scope: string, detail: string, granted: boolean) {
	return db
		.prepare(
			"INSERT INTO consent_records (id, circle_id, user_id, scope, detail, granted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(uuid(), circleId, userId, scope, detail, granted ? 1 : 0, now())
		.run();
}

/** Takes a supporter out of everything in flight: open offers rotate on, commitments and invitations are canceled. */
async function detachMember(env: Env, memberId: string) {
	const db = env.DB;
	const at = now();
	const { results: offered } = await db
		.prepare(
			`SELECT o.opportunity_id FROM support_offers o JOIN opportunities p ON p.id = o.opportunity_id
			 WHERE o.member_id = ? AND o.status = 'offered' AND p.status = 'offered'`,
		)
		.bind(memberId)
		.all<{ opportunity_id: string }>();
	await db.batch([
		db.prepare("UPDATE support_offers SET status = 'withdrawn', responded_at = ? WHERE member_id = ? AND status = 'offered'").bind(at, memberId),
		db.prepare("UPDATE commitments SET status = 'canceled', updated_at = ? WHERE member_id = ? AND status = 'accepted'").bind(at, memberId),
		db.prepare("UPDATE invitations SET status = 'canceled', responded_at = ? WHERE from_member_id = ? AND status IN ('sent', 'accepted')").bind(at, memberId),
		db
			.prepare(
				`UPDATE opportunities SET status = 'canceled', updated_at = ?
				 WHERE assigned_member_id = ? AND status IN ('accepted_by_supporter', 'invitation_sent', 'accepted_by_griever')`,
			)
			.bind(at, memberId),
	]);
	for (const o of offered) await offerNext(env, o.opportunity_id);
}

const app = new Hono<App>();

app.onError((err, c) => {
	if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
	// Never log request bodies or error details: they may contain private check-in content.
	console.error("ripple: unhandled error on", c.req.method, c.req.routePath);
	return c.json({ error: "Something went wrong on our side. Please try again." }, 500);
});

app.use("*", async (c, next) => {
	// Cookies are SameSite=Lax; this also rejects any cross-origin write that slips through.
	if (c.req.method !== "GET") {
		const origin = c.req.header("origin");
		if (origin && new URL(origin).host !== new URL(c.req.url).host) fail(403, "Cross-site requests are not allowed.");
	}
	await ensureSchema(c.env.DB);
	c.set("user", await userForToken(c.env.DB, getCookie(c, SESSION_COOKIE)));
	c.header("Cache-Control", "no-store");
	await next();
});

// ------------------------------------------------------------------- account

function startSession(c: Ctx, token: string) {
	setCookie(c, SESSION_COOKIE, token, {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: "/",
		maxAge: SESSION_MAX_AGE,
	});
}

app.post("/auth/signup", async (c) => {
	const body = await json(c);
	const name = text(body.name, 80);
	const email = text(body.email, 200).toLowerCase();
	const password = typeof body.password === "string" ? body.password : "";
	if (!name) fail(400, "Please tell us your name.");
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "That email address doesn't look right.");
	if (password.length < 8) fail(400, "Please choose a password of at least 8 characters.");

	const db = c.env.DB;
	if (await db.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) {
		fail(409, "There's already an account with that email. Try signing in.");
	}
	const id = uuid();
	const salt = randomToken(16);
	await db
		.prepare("INSERT INTO users (id, email, name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(id, email, name, await hashPassword(password, salt), salt, now())
		.run();
	startSession(c, await createSession(db, id));
	return c.json({ ok: true });
});

app.post("/auth/login", async (c) => {
	const body = await json(c);
	const email = text(body.email, 200).toLowerCase();
	const password = typeof body.password === "string" ? body.password : "";
	const db = c.env.DB;
	const row = await db
		.prepare("SELECT id, password_hash, password_salt FROM users WHERE email = ?")
		.bind(email)
		.first<{ id: string; password_hash: string; password_salt: string }>();
	// Hash even when the account doesn't exist so both cases take the same time.
	const hash = await hashPassword(password, row?.password_salt ?? "no-such-account");
	if (!row || !safeEqual(hash, row.password_hash)) return fail(401, "That email and password don't match.");
	startSession(c, await createSession(db, row.id));
	return c.json({ ok: true });
});

app.post("/auth/logout", async (c) => {
	const token = getCookie(c, SESSION_COOKIE);
	if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
	deleteCookie(c, SESSION_COOKIE, { path: "/" });
	return c.json({ ok: true });
});

app.get("/me", async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ user: null, memberships: [], invites: [], unread: 0, notificationsPaused: false });
	const db = c.env.DB;
	const [memberships, invites, unread, pref] = await Promise.all([
		db
			.prepare(
				`SELECT m.id AS "memberId", m.role, c.id AS "circleId", c.name AS "circleName",
					c.griever_name AS "grieverName", c.status AS "circleStatus"
				 FROM circle_members m JOIN circles c ON c.id = m.circle_id
				 WHERE m.user_id = ? AND m.status = 'active' ORDER BY m.created_at`,
			)
			.bind(user.id)
			.all(),
		db
			.prepare(
				`SELECT m.invite_token AS token, m.role, c.name AS "circleName", c.griever_name AS "grieverName"
				 FROM circle_members m JOIN circles c ON c.id = m.circle_id
				 WHERE m.email = ? AND m.status = 'invited' AND m.invite_token IS NOT NULL`,
			)
			.bind(user.email)
			.all(),
		db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").bind(user.id).first<{ n: number }>(),
		db.prepare("SELECT paused FROM notification_preferences WHERE user_id = ?").bind(user.id).first<{ paused: number }>(),
	]);
	return c.json({
		user,
		memberships: memberships.results,
		invites: invites.results,
		unread: unread?.n ?? 0,
		notificationsPaused: !!pref?.paused,
	});
});

/** Deletes the account and, by cascade, every circle this person is the grieving member of. */
app.delete("/me", async (c) => {
	const user = requireUser(c);
	const { results } = await c.env.DB
		.prepare("SELECT id FROM circle_members WHERE user_id = ? AND status = 'active' AND role != 'griever'")
		.bind(user.id)
		.all<{ id: string }>();
	for (const m of results) await detachMember(c.env, m.id);
	await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
	deleteCookie(c, SESSION_COOKIE, { path: "/" });
	return c.json({ ok: true });
});

app.get("/notifications", async (c) => {
	const user = requireUser(c);
	const { results } = await c.env.DB
		.prepare(
			`SELECT id, kind, title, body, read_at AS "readAt", created_at AS "createdAt"
			 FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`,
		)
		.bind(user.id)
		.all();
	return c.json({ notifications: results });
});

app.post("/notifications/read", async (c) => {
	const user = requireUser(c);
	await c.env.DB.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").bind(now(), user.id).run();
	return c.json({ ok: true });
});

app.put("/notifications/preferences", async (c) => {
	const user = requireUser(c);
	const body = await json(c);
	await c.env.DB
		.prepare(
			`INSERT INTO notification_preferences (user_id, paused, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT (user_id) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at`,
		)
		.bind(user.id, body.paused ? 1 : 0, now())
		.run();
	return c.json({ ok: true });
});

// ------------------------------------------------------------------- circles

app.post("/circles", async (c) => {
	const user = requireUser(c);
	const body = await json(c);
	const forSelf = body.forSelf !== false;
	const db = c.env.DB;
	const id = uuid();
	const at = now();

	if (forSelf) {
		const name = text(body.name, 80) || `${firstName(user.name)}'s circle`;
		await db.batch([
			db
				.prepare("INSERT INTO circles (id, name, griever_user_id, griever_name, created_by, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)")
				.bind(id, name, user.id, user.name, user.id, at),
			db
				.prepare(
					`INSERT INTO circle_members (id, circle_id, user_id, email, name, role, status, created_at, joined_at)
					 VALUES (?, ?, ?, ?, ?, 'griever', 'active', ?, ?)`,
				)
				.bind(uuid(), id, user.id, user.email, user.name, at, at),
			db.prepare("INSERT INTO support_preferences (circle_id, updated_at) VALUES (?, ?)").bind(id, at),
		]);
		await recordConsent(db, id, user.id, "circle", "Created own care circle", true);
		return c.json({ circleId: id });
	}

	// Creating a circle for someone else: nothing happens in it until they accept.
	const grieverName = text(body.grieverName, 80);
	const grieverEmail = text(body.grieverEmail, 200).toLowerCase();
	if (!grieverName) fail(400, "Please add the name of the person this circle is for.");
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(grieverEmail)) fail(400, "Please add their email address so they can give consent.");
	if (grieverEmail === user.email) fail(400, "That's your own email. Choose \"for me\" instead.");
	const name = text(body.name, 80) || `${firstName(grieverName)}'s circle`;
	const token = randomToken(24);
	await db.batch([
		db
			.prepare("INSERT INTO circles (id, name, griever_name, created_by, status, created_at) VALUES (?, ?, ?, ?, 'pending_consent', ?)")
			.bind(id, name, grieverName, user.id, at),
		db
			.prepare(
				`INSERT INTO circle_members (id, circle_id, user_id, email, name, role, status, created_at, joined_at)
				 VALUES (?, ?, ?, ?, ?, 'admin', 'active', ?, ?)`,
			)
			.bind(uuid(), id, user.id, user.email, user.name, at, at),
		db
			.prepare(
				`INSERT INTO circle_members (id, circle_id, email, name, role, status, invite_token, created_at)
				 VALUES (?, ?, ?, ?, 'griever', 'invited', ?, ?)`,
			)
			.bind(uuid(), id, grieverEmail, grieverName, token, at),
		db.prepare("INSERT INTO support_preferences (circle_id, updated_at) VALUES (?, ?)").bind(id, at),
	]);
	return c.json({ circleId: id, inviteToken: token });
});

app.get("/invites/:token", async (c) => {
	const row = await c.env.DB
		.prepare(
			`SELECT m.role, m.name, c.name AS "circleName", c.griever_name AS "grieverName"
			 FROM circle_members m JOIN circles c ON c.id = m.circle_id
			 WHERE m.invite_token = ? AND m.status = 'invited'`,
		)
		.bind(c.req.param("token"))
		.first();
	return row ? c.json({ invite: row }) : fail(404, "This invitation is no longer active.");
});

app.post("/invites/:token/accept", async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	const member = await db
		.prepare("SELECT * FROM circle_members WHERE invite_token = ? AND status = 'invited'")
		.bind(c.req.param("token"))
		.first<Member>();
	if (!member) return fail(404, "This invitation is no longer active.");
	const existing = await db
		.prepare("SELECT 1 FROM circle_members WHERE circle_id = ? AND user_id = ? AND status = 'active'")
		.bind(member.circle_id, user.id)
		.first();
	if (existing) fail(409, "You're already part of this circle.");

	const at = now();
	await db
		.prepare("UPDATE circle_members SET user_id = ?, name = ?, status = 'active', invite_token = NULL, joined_at = ? WHERE id = ?")
		.bind(user.id, user.name, at, member.id)
		.run();
	const circle = await getCircle(db, member.circle_id);
	if (member.role === "griever") {
		await db
			.prepare("UPDATE circles SET griever_user_id = ?, griever_name = ?, status = 'active' WHERE id = ? AND status = 'pending_consent'")
			.bind(user.id, user.name, circle.id)
			.run();
		await recordConsent(db, circle.id, user.id, "circle", "Agreed to a care circle created on their behalf", true);
	} else {
		await notify(db, circle.griever_user_id, circle.id, "joined", "Someone joined your circle", `${firstName(user.name)} is now part of your circle.`, `joined:${member.id}`);
	}
	await logActivity(db, circle.id, user.name, "joined the circle");
	return c.json({ circleId: circle.id, role: member.role });
});

app.post("/circles/:id/members", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["griever", "admin"]);
	const user = requireUser(c);
	const body = await json(c);
	const name = text(body.name, 80);
	const email = text(body.email, 200).toLowerCase();
	const role = body.role === "admin" && me.role === "griever" ? "admin" : "supporter";
	if (!name) fail(400, "Please add their name.");
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "That email address doesn't look right.");

	const db = c.env.DB;
	const dup = await db
		.prepare("SELECT 1 FROM circle_members WHERE circle_id = ? AND email = ? AND status IN ('invited', 'active')")
		.bind(me.circle_id, email)
		.first();
	if (dup) fail(409, "That person is already in this circle or has an open invitation.");

	const id = uuid();
	const token = randomToken(24);
	await db
		.prepare(
			`INSERT INTO circle_members (id, circle_id, email, name, role, relationship, status, invite_token, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'invited', ?, ?)`,
		)
		.bind(id, me.circle_id, email, name, role, text(body.relationship, 40), token, now())
		.run();
	// Only the grieving person can decide who may receive personalized opportunities.
	if (me.role === "griever" && body.personalized !== false) {
		await db.prepare("INSERT INTO member_permissions (member_id, permission, granted_at) VALUES (?, 'personalized_outreach', ?)").bind(id, now()).run();
		await recordConsent(db, me.circle_id, user.id, "personalized_outreach", name, true);
	}
	await logActivity(db, me.circle_id, me.name, `invited ${firstName(name)}`);
	return c.json({ memberId: id, inviteToken: token });
});

app.patch("/circles/:id/members/:mid", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["griever"]);
	const user = requireUser(c);
	const body = await json(c);
	const db = c.env.DB;
	const target = await db
		.prepare("SELECT * FROM circle_members WHERE id = ? AND circle_id = ? AND status IN ('invited', 'active')")
		.bind(c.req.param("mid"), me.circle_id)
		.first<Member>();
	if (!target || target.role === "griever") return fail(404, "Not found.");

	const setPermission = async (permission: string, granted: boolean) => {
		if (granted) {
			await db.prepare("INSERT OR IGNORE INTO member_permissions (member_id, permission, granted_at) VALUES (?, ?, ?)").bind(target.id, permission, now()).run();
		} else {
			await db.prepare("DELETE FROM member_permissions WHERE member_id = ? AND permission = ?").bind(target.id, permission).run();
		}
		await recordConsent(db, me.circle_id, user.id, permission, target.name, granted);
	};

	if (typeof body.personalized === "boolean") {
		await setPermission("personalized_outreach", body.personalized);
		// Revoking takes effect immediately: anything waiting on them moves on.
		if (!body.personalized) {
			const { results } = await db
				.prepare(
					`SELECT o.opportunity_id FROM support_offers o JOIN opportunities p ON p.id = o.opportunity_id
					 WHERE o.member_id = ? AND o.status = 'offered' AND p.status = 'offered'`,
				)
				.bind(target.id)
				.all<{ opportunity_id: string }>();
			await db.prepare("UPDATE support_offers SET status = 'withdrawn', responded_at = ? WHERE member_id = ? AND status = 'offered'").bind(now(), target.id).run();
			for (const o of results) await offerNext(c.env, o.opportunity_id);
		}
	}
	if (typeof body.viewCheckins === "boolean") {
		if (target.role !== "admin") fail(400, "Only an administrator can be given access to check-ins.");
		await setPermission("view_checkins", body.viewCheckins);
	}
	return c.json({ ok: true });
});

app.delete("/circles/:id/members/:mid", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["griever", "admin"]);
	const db = c.env.DB;
	const target = await db
		.prepare("SELECT * FROM circle_members WHERE id = ? AND circle_id = ? AND status IN ('invited', 'active')")
		.bind(c.req.param("mid"), me.circle_id)
		.first<Member>();
	if (!target || target.role === "griever" || target.id === me.id) return fail(404, "Not found.");
	if (me.role === "admin" && target.role !== "supporter") fail(403, "Only the person this circle is for can remove an administrator.");

	await detachMember(c.env, target.id);
	await db.batch([
		db.prepare("UPDATE circle_members SET status = 'removed', invite_token = NULL WHERE id = ?").bind(target.id),
		db.prepare("DELETE FROM member_permissions WHERE member_id = ?").bind(target.id),
	]);
	await logActivity(db, me.circle_id, me.name, `removed ${firstName(target.name)}`);
	return c.json({ ok: true });
});

app.post("/circles/:id/leave", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["supporter", "admin"]);
	await detachMember(c.env, me.id);
	await c.env.DB.batch([
		c.env.DB.prepare("UPDATE circle_members SET status = 'left' WHERE id = ?").bind(me.id),
		c.env.DB.prepare("DELETE FROM member_permissions WHERE member_id = ?").bind(me.id),
	]);
	await logActivity(c.env.DB, me.circle_id, me.name, "left the circle");
	return c.json({ ok: true });
});

app.patch("/circles/:id/membership", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["supporter", "admin"]);
	const body = await json(c);
	const availability = text(body.availability, 20);
	if (!AVAILABILITY.includes(availability)) fail(400, "Unknown availability.");
	await c.env.DB.prepare("UPDATE circle_members SET availability = ? WHERE id = ?").bind(availability, me.id).run();
	if (availability === "unavailable") {
		const { results } = await c.env.DB
			.prepare(
				`SELECT o.opportunity_id FROM support_offers o JOIN opportunities p ON p.id = o.opportunity_id
				 WHERE o.member_id = ? AND o.status = 'offered' AND p.status = 'offered'`,
			)
			.bind(me.id)
			.all<{ opportunity_id: string }>();
		await c.env.DB.prepare("UPDATE support_offers SET status = 'withdrawn', responded_at = ? WHERE member_id = ? AND status = 'offered'").bind(now(), me.id).run();
		for (const o of results) await offerNext(c.env, o.opportunity_id);
	}
	return c.json({ ok: true });
});

// -------------------------------------------------- the grieving person's view

const connectionsQuery = `
	SELECT o.id, o.kind, o.origin, o.status, o.updated_at AS "updatedAt", m.name AS "supporterName"
	FROM opportunities o LEFT JOIN circle_members m ON m.id = o.assigned_member_id
	WHERE o.circle_id = ? ORDER BY o.updated_at DESC LIMIT 30`;

const invitationsQuery = `
	SELECT i.id, i.activity, i.proposed_for AS "proposedFor", i.note, i.status,
		i.created_at AS "createdAt", m.name AS "fromName"
	FROM invitations i JOIN circle_members m ON m.id = i.from_member_id
	WHERE i.circle_id = ? ORDER BY i.created_at DESC LIMIT 30`;

app.get("/circles/:id/griever", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["griever"]);
	const db = c.env.DB;
	await runScheduler(c.env, me.circle_id);
	const [circle, prefs, members, checkins, invitations, dates, consents, connections] = await Promise.all([
		getCircle(db, me.circle_id),
		getPrefs(db, me.circle_id),
		db
			.prepare(
				`SELECT m.id, m.name, m.email, m.role, m.relationship, m.status, m.invite_token AS "inviteToken",
					EXISTS (SELECT 1 FROM member_permissions p WHERE p.member_id = m.id AND p.permission = 'personalized_outreach') AS personalized,
					EXISTS (SELECT 1 FROM member_permissions p WHERE p.member_id = m.id AND p.permission = 'view_checkins') AS "viewCheckins"
				 FROM circle_members m
				 WHERE m.circle_id = ? AND m.status IN ('invited', 'active') AND m.role != 'griever' ORDER BY m.created_at`,
			)
			.bind(me.circle_id)
			.all(),
		db
			.prepare(`SELECT id, needs, connection, note, created_at AS "createdAt" FROM checkins WHERE circle_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 10`)
			.bind(me.circle_id, me.user_id)
			.all<{ id: string; needs: string; connection: string | null; note: string | null; createdAt: string }>(),
		db.prepare(invitationsQuery).bind(me.circle_id).all(),
		db.prepare(`SELECT id, label, kind, month, day, shared FROM meaningful_dates WHERE circle_id = ? ORDER BY month, day`).bind(me.circle_id).all(),
		db.prepare(`SELECT id, scope, detail, granted, created_at AS "createdAt" FROM consent_records WHERE circle_id = ? ORDER BY created_at DESC LIMIT 25`).bind(me.circle_id).all(),
		db.prepare(connectionsQuery).bind(me.circle_id).all(),
	]);
	return c.json({
		circle: { id: circle.id, name: circle.name, status: circle.status },
		preferences: {
			frequency: prefs.frequency,
			methods: JSON.parse(prefs.methods),
			supportTypes: JSON.parse(prefs.support_types),
			allowMultiple: !!prefs.allow_multiple,
			spaceUntil: inSpace(prefs) ? prefs.space_until : null,
		},
		members: members.results,
		checkins: checkins.results.map((row) => ({ ...row, needs: JSON.parse(row.needs) })),
		invitations: invitations.results,
		dates: dates.results,
		consents: consents.results,
		connections: connections.results,
	});
});

app.post("/circles/:id/checkins", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["griever"]);
	const body = await json(c);
	const needs = subset(body.needs, NEEDS);
	if (!needs.length) fail(400, "Choose anything that fits, or skip today. Either is fine.");
	const note = text(body.note, 1000);
	const id = uuid();
	await c.env.DB
		.prepare("INSERT INTO checkins (id, circle_id, user_id, needs, note, created_at) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(id, me.circle_id, me.user_id, JSON.stringify(needs), note || null, now())
		.run();
	return c.json({ id, crisis: CRISIS.test(note) });
});

app.post("/circles/:id/checkins/:cid/connection", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["griever"]);
	const body = await json(c);
	const choice = text(body.choice, 20);
	if (!CONNECTIONS.includes(choice)) fail(400, "Unknown choice.");
	const result = await c.env.DB
		.prepare("UPDATE checkins SET connection = ? WHERE id = ? AND circle_id = ? AND user_id = ?")
		.bind(choice, c.req.param("cid"), me.circle_id, me.user_id)
		.run();
	if (!result.meta.changes) fail(404, "Not found.");
	return c.json({ ok: true });
});

/** "I'd rather have space": suppresses all outreach for the chosen period, effective immediately. */
app.post("/circles/:id/space", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["griever"]);
	const user = requireUser(c);
	const body = await json(c);
	const days = [1, 3, 7, 14].includes(Number(body.days)) ? Number(body.days) : 1;
	const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
	await c.env.DB.prepare("UPDATE support_preferences SET space_until = ?, updated_at = ? WHERE circle_id = ?").bind(until, now(), me.circle_id).run();
	await cancelUnclaimed(c.env.DB, me.circle_id);
	await recordConsent(c.env.DB, me.circle_id, user.id, "space", `Asked for space for ${days} day${days === 1 ? "" : "s"}`, true);
	return c.json({ spaceUntil: until });
});

app.delete("/circles/:id/space", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["griever"]);
	const user = requireUser(c);
	await c.env.DB.prepare("UPDATE support_preferences SET space_until = NULL, updated_at = ? WHERE circle_id = ?").bind(now(), me.circle_id).run();
	await recordConsent(c.env.DB, me.circle_id, user.id, "space", "Ended the request for space early", false);
	return c.json({ ok: true });
});

/**
 * The only path from a private check-in to a supporter. Nothing is created
 * until the grieving person explicitly authorizes it here, and the need
 * itself is passed on only if they also tick "share_need".
 */
app.post("/circles/:id/authorize", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["griever"]);
	const user = requireUser(c);
	const body = await json(c);
	const db = c.env.DB;

	const checkin = await db
		.prepare("SELECT connection FROM checkins WHERE id = ? AND circle_id = ? AND user_id = ?")
		.bind(text(body.checkinId, 40), me.circle_id, me.user_id)
		.first<{ connection: string | null }>();
	const kind = KINDS.find((k) => k === checkin?.connection);
	if (!kind) return fail(400, "Choose what kind of connection would feel good first.");

	const circle = await getCircle(db, me.circle_id);
	if (circle.status !== "active") fail(409, "Support is paused right now. You can resume it under Privacy controls.");
	const prefs = await getPrefs(db, me.circle_id);
	if (!prefs.allow_multiple && (await hasOpenOpportunity(db, me.circle_id))) {
		fail(409, "A connection is already being arranged. You'll see it under Invitations when someone reaches out.");
	}

	const { results: eligible } = await db
		.prepare(
			`SELECT m.id FROM circle_members m
			 JOIN member_permissions p ON p.member_id = m.id AND p.permission = 'personalized_outreach'
			 WHERE m.circle_id = ? AND m.status = 'active' AND m.role IN ('supporter', 'admin')`,
		)
		.bind(me.circle_id)
		.all<{ id: string }>();
	const chosen = Array.isArray(body.memberIds) ? eligible.filter((m) => (body.memberIds as unknown[]).includes(m.id)) : eligible;
	if (!chosen.length) {
		fail(409, "No one in your circle can receive opportunities yet. Invite someone, or wait for them to accept, under My circle.");
	}

	const shareNeed = body.shareNeed === true;
	const id = uuid();
	const at = now();
	await db
		.prepare(
			`INSERT INTO opportunities (id, circle_id, kind, origin, status, share_need, allowed_member_ids, created_at, updated_at)
			 VALUES (?, ?, ?, 'checkin', 'suggested', ?, ?, ?, ?)`,
		)
		.bind(id, me.circle_id, kind, shareNeed ? 1 : 0, JSON.stringify(chosen.map((m) => m.id)), at, at)
		.run();
	await recordConsent(
		db,
		me.circle_id,
		user.id,
		"arrange_connection",
		`Asked Ripple to arrange: ${kind}. Offered to ${chosen.length} supporter${chosen.length === 1 ? "" : "s"}. Reason shared: ${shareNeed ? "yes" : "no"}.`,
		true,
	);
	// Having asked for a connection, any earlier request for space no longer applies.
	await db.prepare("UPDATE support_preferences SET space_until = NULL WHERE circle_id = ?").bind(me.circle_id).run();
	const offered = await offerNext(c.env, id);
	return c.json({ offered });
});

app.put("/circles/:id/preferences", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["griever"]);
	const user = requireUser(c);
	const body = await json(c);
	const db = c.env.DB;
	const current = await getPrefs(db, me.circle_id);
	const frequency = FREQUENCIES.includes(text(body.frequency, 20)) ? text(body.frequency, 20) : current.frequency;
	const methods = Array.isArray(body.methods) ? subset(body.methods, METHODS) : JSON.parse(current.methods);
	const types = Array.isArray(body.supportTypes) ? subset(body.supportTypes, KINDS) : JSON.parse(current.support_types);
	const allowMultiple = typeof body.allowMultiple === "boolean" ? body.allowMultiple : !!current.allow_multiple;
	await db
		.prepare("UPDATE support_preferences SET frequency = ?, methods = ?, support_types = ?, allow_multiple = ?, updated_at = ? WHERE circle_id = ?")
		.bind(frequency, JSON.stringify(methods), JSON.stringify(types), allowMultiple ? 1 : 0, now(), me.circle_id)
		.run();
	if (frequency !== current.frequency) {
		await recordConsent(db, me.circle_id, user.id, "outreach_frequency", `Set to: ${frequency.replace("_", " ")}`, frequency !== "paused");
		if (frequency === "paused") await cancelUnclaimed(db, me.circle_id);
	}
	return c.json({ ok: true });
});

/** Pauses or resumes everything. Pausing withdraws every unclaimed opportunity at once. */
app.post("/circles/:id/pause", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["griever"]);
	const user = requireUser(c);
	const body = await json(c);
	const paused = body.paused === true;
	const db = c.env.DB;
	await db
		.prepare("UPDATE circles SET status = ? WHERE id = ? AND status IN ('active', 'paused')")
		.bind(paused ? "paused" : "active", me.circle_id)
		.run();
	if (paused) await cancelUnclaimed(db, me.circle_id);
	await recordConsent(db, me.circle_id, user.id, "all_support", paused ? "Paused all support" : "Resumed support", !paused);
	await logActivity(db, me.circle_id, me.name, paused ? "paused support" : "resumed support");
	return c.json({ ok: true });
});

app.post("/circles/:id/dates", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["griever"]);
	const body = await json(c);
	const label = text(body.label, 80);
	const month = Number(body.month);
	const day = Number(body.day);
	if (!label) fail(400, "Please give this date a name.");
	if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) fail(400, "Please choose a month and day.");
	const kind = ["birthday", "anniversary", "other"].includes(text(body.kind, 20)) ? text(body.kind, 20) : "other";
	await c.env.DB
		.prepare("INSERT INTO meaningful_dates (id, circle_id, label, kind, month, day, shared, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(uuid(), me.circle_id, label, kind, month, day, body.shared === true ? 1 : 0, now())
		.run();
	return c.json({ ok: true });
});

app.patch("/circles/:id/dates/:did", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["griever"]);
	const user = requireUser(c);
	const body = await json(c);
	const shared = body.shared === true;
	const row = await c.env.DB
		.prepare("UPDATE meaningful_dates SET shared = ? WHERE id = ? AND circle_id = ? RETURNING label")
		.bind(shared ? 1 : 0, c.req.param("did"), me.circle_id)
		.first<{ label: string }>();
	if (!row) return fail(404, "Not found.");
	await recordConsent(c.env.DB, me.circle_id, user.id, "share_date", row.label, shared);
	return c.json({ ok: true });
});

app.delete("/circles/:id/dates/:did", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["griever"]);
	await c.env.DB.prepare("DELETE FROM meaningful_dates WHERE id = ? AND circle_id = ?").bind(c.req.param("did"), me.circle_id).run();
	return c.json({ ok: true });
});

app.delete("/circles/:id/checkins", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["griever"]);
	await c.env.DB.prepare("DELETE FROM checkins WHERE circle_id = ? AND user_id = ?").bind(me.circle_id, me.user_id).run();
	return c.json({ ok: true });
});

/** Deletes the circle and, by cascade, every check-in, consent record, opportunity and invitation in it. */
app.delete("/circles/:id", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["griever"]);
	await c.env.DB.prepare("DELETE FROM circles WHERE id = ?").bind(me.circle_id).run();
	return c.json({ ok: true });
});

// ---------------------------------------------------------------- invitations

type Invitation = {
	id: string;
	circle_id: string;
	opportunity_id: string;
	from_member_id: string;
	activity: string;
	status: string;
};

async function loadInvitation(c: Ctx) {
	const user = requireUser(c);
	const db = c.env.DB;
	const invitation = await db.prepare("SELECT * FROM invitations WHERE id = ?").bind(c.req.param("id")).first<Invitation>();
	if (!invitation) return fail(404, "Not found.");
	const me = await db
		.prepare("SELECT * FROM circle_members WHERE circle_id = ? AND user_id = ? AND status = 'active'")
		.bind(invitation.circle_id, user.id)
		.first<Member>();
	if (!me || (me.role !== "griever" && me.id !== invitation.from_member_id)) return fail(404, "Not found.");
	const sender = await db.prepare("SELECT * FROM circle_members WHERE id = ?").bind(invitation.from_member_id).first<Member>();
	const circle = await getCircle(db, invitation.circle_id);
	return { invitation, me, sender, circle };
}

async function settleInvitation(db: D1Database, invitation: Invitation, status: string, oppStatus: string, commitment: string | null) {
	const at = now();
	const statements = [
		db.prepare("UPDATE invitations SET status = ?, responded_at = ? WHERE id = ?").bind(status, at, invitation.id),
		db.prepare("UPDATE opportunities SET status = ?, updated_at = ? WHERE id = ?").bind(oppStatus, at, invitation.opportunity_id),
	];
	if (commitment) {
		statements.push(
			db.prepare("UPDATE commitments SET status = ?, updated_at = ? WHERE opportunity_id = ? AND status = 'accepted'").bind(commitment, at, invitation.opportunity_id),
		);
	}
	await db.batch(statements);
}

app.post("/invitations/:id/respond", async (c) => {
	const { invitation, me, sender, circle } = await loadInvitation(c);
	if (me.role !== "griever") fail(403, "Only the person invited can answer this.");
	if (invitation.status !== "sent") fail(409, "This invitation has already been answered.");
	const accept = (await json(c)).accept === true;
	const db = c.env.DB;
	const name = firstName(circle.griever_name);
	if (accept) {
		await settleInvitation(db, invitation, "accepted", "accepted_by_griever", null);
		await notify(db, sender?.user_id ?? null, circle.id, "invitation", `${name} said yes`, `${name} would like to: ${invitation.activity.toLowerCase()}.`, `inv-yes:${invitation.id}`);
	} else {
		await settleInvitation(db, invitation, "declined", "declined", "canceled");
		await notify(db, sender?.user_id ?? null, circle.id, "invitation", "Not this time", `${name} isn't up for it this time. Offering still mattered.`, `inv-no:${invitation.id}`);
	}
	await logActivity(db, circle.id, me.name, accept ? "accepted an invitation" : "declined an invitation");
	return c.json({ ok: true });
});

app.post("/invitations/:id/complete", async (c) => {
	const { invitation, me, circle } = await loadInvitation(c);
	if (invitation.status !== "accepted") fail(409, "Only a confirmed activity can be marked as done.");
	await settleInvitation(c.env.DB, invitation, "completed", "completed", "completed");
	await logActivity(c.env.DB, circle.id, me.name, "marked time together as done");
	return c.json({ ok: true });
});

app.post("/invitations/:id/cancel", async (c) => {
	const { invitation, me, sender, circle } = await loadInvitation(c);
	if (!["sent", "accepted"].includes(invitation.status)) fail(409, "This can no longer be canceled.");
	const db = c.env.DB;
	await settleInvitation(db, invitation, "canceled", "canceled", "canceled");
	const other = me.role === "griever" ? (sender?.user_id ?? null) : circle.griever_user_id;
	await notify(db, other, circle.id, "invitation", "A plan was canceled", `${firstName(me.name)} needed to cancel: ${invitation.activity.toLowerCase()}. No explanation needed.`, `inv-cancel:${invitation.id}`);
	await logActivity(db, circle.id, me.name, "canceled an invitation");
	return c.json({ ok: true });
});

/** "Just Be There": a supporter proposes an activity and time. It is only confirmed once the grieving person accepts. */
app.post("/circles/:id/invitations", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["supporter", "admin"]);
	const body = await json(c);
	const db = c.env.DB;
	const activity = text(body.activity, 60);
	if (!ACTIVITIES.includes(activity)) fail(400, "Please choose an activity.");
	const when = new Date(text(body.proposedFor, 40));
	if (Number.isNaN(when.getTime())) fail(400, "Please choose a date and time.");
	if (when.getTime() < Date.now()) fail(400, "That time has already passed.");

	const circle = await getCircle(db, me.circle_id);
	const prefs = await getPrefs(db, me.circle_id);
	const name = firstName(circle.griever_name);
	// Deliberately the same wording whether support is paused or space was asked for.
	if (circle.status !== "active" || prefs.frequency === "paused" || inSpace(prefs)) {
		fail(409, `${name} isn't receiving invitations right now. It's nothing you did. Ripple will let you know when there's a good moment.`);
	}
	if (!prefs.allow_multiple) {
		const pending = await db.prepare("SELECT 1 FROM invitations WHERE circle_id = ? AND status = 'sent'").bind(circle.id).first();
		if (pending) fail(409, `${name} already has an invitation to consider. Ripple keeps these to one at a time so it never feels like too much.`);
	}

	const at = now();
	const invitationId = uuid();
	let opportunityId = text(body.opportunityId, 40);
	const statements = [];
	if (opportunityId) {
		const opp = await db
			.prepare("SELECT id FROM opportunities WHERE id = ? AND circle_id = ? AND assigned_member_id = ? AND status = 'accepted_by_supporter'")
			.bind(opportunityId, circle.id, me.id)
			.first();
		if (!opp) return fail(404, "Not found.");
		statements.push(db.prepare("UPDATE opportunities SET status = 'invitation_sent', updated_at = ? WHERE id = ?").bind(at, opportunityId));
	} else {
		opportunityId = uuid();
		statements.push(
			db
				.prepare(
					`INSERT INTO opportunities (id, circle_id, kind, origin, status, assigned_member_id, created_at, updated_at)
					 VALUES (?, ?, 'quiet', 'supporter', 'invitation_sent', ?, ?, ?)`,
				)
				.bind(opportunityId, circle.id, me.id, at, at),
			db
				.prepare("INSERT INTO commitments (id, opportunity_id, circle_id, member_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'accepted', ?, ?)")
				.bind(uuid(), opportunityId, circle.id, me.id, at, at),
		);
	}
	statements.push(
		db
			.prepare(
				`INSERT INTO invitations (id, circle_id, opportunity_id, from_member_id, activity, proposed_for, note, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', ?)`,
			)
			.bind(invitationId, circle.id, opportunityId, me.id, activity, when.toISOString(), text(body.note, 300), at),
	);
	await db.batch(statements);
	await notify(db, circle.griever_user_id, circle.id, "invitation", "An invitation, if you'd like it", `${firstName(me.name)} would like to spend a little time together. There's no pressure to say yes.`, `inv:${invitationId}`);
	await logActivity(db, circle.id, me.name, "sent an invitation");
	return c.json({ invitationId });
});

// ------------------------------------------------------- the supporter's view

app.get("/supporter", async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	const { results: circles } = await db
		.prepare(
			`SELECT m.id AS "memberId", m.role, m.availability, c.id AS "circleId", c.name AS "circleName",
				c.griever_name AS "grieverName", c.status AS "circleStatus"
			 FROM circle_members m JOIN circles c ON c.id = m.circle_id
			 WHERE m.user_id = ? AND m.status = 'active' AND m.role IN ('supporter', 'admin') ORDER BY m.created_at`,
		)
		.bind(user.id)
		.all<{ memberId: string; circleId: string; grieverName: string }>();
	for (const circle of circles) await runScheduler(c.env, circle.circleId);

	// Everything below is keyed on this user's own member rows. Check-ins are never joined.
	const [opportunities, commitments, dates] = await Promise.all([
		db
			.prepare(
				`SELECT o.id, o.kind, c.id AS "circleId", c.griever_name AS "grieverName",
					r.title, r.body, r.suggested_message AS "suggestedMessage", s.created_at AS "createdAt"
				 FROM support_offers s
				 JOIN circle_members m ON m.id = s.member_id AND m.user_id = ?1 AND m.status = 'active'
				 JOIN opportunities o ON o.id = s.opportunity_id AND o.status = 'offered' AND o.assigned_member_id = m.id
				 JOIN circles c ON c.id = o.circle_id
				 JOIN recommendations r ON r.opportunity_id = o.id AND r.member_id = m.id
				 WHERE s.status = 'offered' ORDER BY s.created_at DESC`,
			)
			.bind(user.id)
			.all(),
		db
			.prepare(
				`SELECT o.id AS "opportunityId", o.kind, o.status, o.updated_at AS "updatedAt",
					c.id AS "circleId", c.griever_name AS "grieverName",
					r.title, r.suggested_message AS "suggestedMessage",
					i.id AS "invitationId", i.activity, i.proposed_for AS "proposedFor", i.status AS "invitationStatus"
				 FROM commitments k
				 JOIN circle_members m ON m.id = k.member_id AND m.user_id = ?1 AND m.status = 'active'
				 JOIN opportunities o ON o.id = k.opportunity_id
				 JOIN circles c ON c.id = o.circle_id
				 LEFT JOIN recommendations r ON r.opportunity_id = o.id AND r.member_id = m.id
				 LEFT JOIN invitations i ON i.opportunity_id = o.id AND i.from_member_id = m.id
					AND i.id = (SELECT id FROM invitations WHERE opportunity_id = o.id ORDER BY created_at DESC LIMIT 1)
				 ORDER BY o.updated_at DESC LIMIT 30`,
			)
			.bind(user.id)
			.all(),
		db
			.prepare(
				`SELECT d.id, d.label, d.kind, d.month, d.day, c.griever_name AS "grieverName"
				 FROM meaningful_dates d
				 JOIN circles c ON c.id = d.circle_id AND c.status = 'active'
				 JOIN circle_members m ON m.circle_id = c.id AND m.user_id = ?1 AND m.status = 'active' AND m.role IN ('supporter', 'admin')
				 WHERE d.shared = 1`,
			)
			.bind(user.id)
			.all<{ month: number; day: number }>(),
	]);
	return c.json({
		circles,
		opportunities: opportunities.results,
		commitments: commitments.results,
		dates: dates.results
			.map((d) => ({ ...d, daysAway: daysUntil(d.month, d.day) }))
			.sort((a, b) => a.daysAway - b.daysAway),
		activities: ACTIVITIES,
	});
});

async function loadOpportunity(c: Ctx, statuses: string[]) {
	const user = requireUser(c);
	const row = await c.env.DB
		.prepare(
			`SELECT o.id, o.circle_id, o.status, m.id AS member_id, m.name AS member_name
			 FROM opportunities o
			 JOIN circle_members m ON m.id = o.assigned_member_id AND m.user_id = ? AND m.status = 'active'
			 WHERE o.id = ?`,
		)
		.bind(user.id, c.req.param("id"))
		.first<{ id: string; circle_id: string; status: string; member_id: string; member_name: string }>();
	if (!row) return fail(404, "Not found.");
	if (!statuses.includes(row.status)) return fail(409, "This has already been updated. Refresh to see where it stands.");
	return row;
}

app.post("/opportunities/:id/respond", async (c) => {
	const opp = await loadOpportunity(c, ["offered"]);
	const accept = (await json(c)).accept === true;
	const db = c.env.DB;
	const at = now();
	if (accept) {
		// Claimed: it leaves everyone else's list, so the same request isn't sent twice.
		await db.batch([
			db.prepare("UPDATE support_offers SET status = 'accepted', responded_at = ? WHERE opportunity_id = ? AND member_id = ?").bind(at, opp.id, opp.member_id),
			db.prepare("UPDATE opportunities SET status = 'accepted_by_supporter', updated_at = ? WHERE id = ? AND status = 'offered'").bind(at, opp.id),
			db
				.prepare("INSERT INTO commitments (id, opportunity_id, circle_id, member_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'accepted', ?, ?)")
				.bind(uuid(), opp.id, opp.circle_id, opp.member_id, at, at),
		]);
		await logActivity(db, opp.circle_id, opp.member_name, "offered to reach out");
	} else {
		await db.prepare("UPDATE support_offers SET status = 'declined', responded_at = ? WHERE opportunity_id = ? AND member_id = ?").bind(at, opp.id, opp.member_id).run();
		await offerNext(c.env, opp.id);
	}
	return c.json({ ok: true });
});

app.post("/opportunities/:id/complete", async (c) => {
	const opp = await loadOpportunity(c, ["accepted_by_supporter", "accepted_by_griever"]);
	const db = c.env.DB;
	const at = now();
	await db.batch([
		db.prepare("UPDATE opportunities SET status = 'completed', updated_at = ? WHERE id = ?").bind(at, opp.id),
		db.prepare("UPDATE commitments SET status = 'completed', updated_at = ? WHERE opportunity_id = ? AND status = 'accepted'").bind(at, opp.id),
		db.prepare("UPDATE invitations SET status = 'completed', responded_at = ? WHERE opportunity_id = ? AND status = 'accepted'").bind(at, opp.id),
	]);
	await logActivity(db, opp.circle_id, opp.member_name, "reached out");
	return c.json({ ok: true });
});

/** A supporter who can't follow through hands the opportunity back, and it rotates to someone else. */
app.post("/opportunities/:id/release", async (c) => {
	const opp = await loadOpportunity(c, ["accepted_by_supporter"]);
	const db = c.env.DB;
	const at = now();
	await db.batch([
		db.prepare("UPDATE commitments SET status = 'canceled', updated_at = ? WHERE opportunity_id = ? AND status = 'accepted'").bind(at, opp.id),
		db.prepare("UPDATE support_offers SET status = 'declined', responded_at = ? WHERE opportunity_id = ? AND member_id = ?").bind(at, opp.id, opp.member_id),
		db.prepare("UPDATE opportunities SET status = 'offered', updated_at = ? WHERE id = ?").bind(at, opp.id),
	]);
	await offerNext(c.env, opp.id);
	return c.json({ ok: true });
});

// -------------------------------------------------------- the administrator's view

app.get("/circles/:id/admin", async (c) => {
	const me = await requireMember(c, c.req.param("id"), ["admin"]);
	const db = c.env.DB;
	const circle = await getCircle(db, me.circle_id);
	const canViewCheckins = !!(await db
		.prepare("SELECT 1 FROM member_permissions WHERE member_id = ? AND permission = 'view_checkins'")
		.bind(me.id)
		.first());
	const [members, connections, invitations, activity, checkins] = await Promise.all([
		db
			.prepare(
				`SELECT id, name, email, role, relationship, status, invite_token AS "inviteToken"
				 FROM circle_members WHERE circle_id = ? AND status IN ('invited', 'active') ORDER BY created_at`,
			)
			.bind(circle.id)
			.all(),
		db.prepare(connectionsQuery).bind(circle.id).all(),
		db.prepare(invitationsQuery).bind(circle.id).all(),
		db.prepare(`SELECT id, actor_name AS "actorName", kind, created_at AS "createdAt" FROM activity WHERE circle_id = ? ORDER BY created_at DESC LIMIT 40`).bind(circle.id).all(),
		// Check-ins are queried only when the grieving person has granted this administrator access.
		canViewCheckins
			? db.prepare(`SELECT id, needs, connection, created_at AS "createdAt" FROM checkins WHERE circle_id = ? ORDER BY created_at DESC LIMIT 10`).bind(circle.id).all<{ needs: string }>()
			: null,
	]);
	return c.json({
		circle: { id: circle.id, name: circle.name, status: circle.status, grieverName: circle.griever_name },
		myMemberId: me.id,
		members: members.results,
		connections: connections.results,
		invitations: invitations.results,
		activity: activity.results,
		checkins: checkins ? checkins.results.map((row) => ({ ...row, needs: JSON.parse(row.needs) })) : null,
	});
});

export default app;
