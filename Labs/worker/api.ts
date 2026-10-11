import { Hono } from "hono";
import { ANSWERS, CONCEPT_IDS, MAX_EMAIL, MAX_NOTE } from "../shared";

export type LabsEnv = {
	LABS_DB: D1Database;
	/** Worker secret. The responses page is disabled until it is set. */
	LABS_ADMIN_PASSWORD?: string;
};

const STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS responses (
		id TEXT PRIMARY KEY,
		concept TEXT NOT NULL,
		answer TEXT,
		note TEXT,
		email TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS responses_created ON responses (created_at)`,
];

let ready: Promise<unknown> | null = null;
function ensureSchema(db: D1Database) {
	ready ??= db.batch(STATEMENTS.map((sql) => db.prepare(sql))).catch((err) => {
		ready = null;
		throw err;
	});
	return ready;
}

const esc = (value: string) =>
	value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const sha256 = async (value: string) =>
	[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].join(",");

type Fields = { concept: string; answer: string | null; note: string | null; email: string | null };

/** Returns the cleaned fields, or a message saying what is wrong. */
async function read(request: Request): Promise<Fields | string> {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== "object") return "Nothing was sent.";
	const concept = text(body.concept, 40);
	const answer = text(body.answer, 20);
	const email = text(body.email, MAX_EMAIL);
	if (!CONCEPT_IDS.includes(concept)) return "Unknown concept.";
	if (answer && !ANSWERS.includes(answer)) return "Unknown answer.";
	if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "That email address doesn't look right.";
	return { concept, answer: answer || null, note: text(body.note, MAX_NOTE) || null, email: email || null };
}

const app = new Hono<{ Bindings: LabsEnv }>();

app.post("/responses", async (c) => {
	const fields = await read(c.req.raw);
	if (typeof fields === "string") return c.json({ error: fields }, 400);
	if (!fields.answer && !fields.note && !fields.email) return c.json({ error: "Nothing was sent." }, 400);
	await ensureSchema(c.env.LABS_DB);
	const id = crypto.randomUUID();
	const at = new Date().toISOString();
	await c.env.LABS_DB
		.prepare("INSERT INTO responses (id, concept, answer, note, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.bind(id, fields.concept, fields.answer, fields.note, fields.email, at, at)
		.run();
	return c.json({ id });
});

// The id is random and only ever given to the browser that sent the first answer,
// so it doubles as permission to change that answer or add a note to it.
app.put("/responses/:id", async (c) => {
	const fields = await read(c.req.raw);
	if (typeof fields === "string") return c.json({ error: fields }, 400);
	await ensureSchema(c.env.LABS_DB);
	const result = await c.env.LABS_DB
		.prepare("UPDATE responses SET answer = ?, note = ?, email = ?, updated_at = ? WHERE id = ? AND concept = ?")
		.bind(fields.answer, fields.note, fields.email, new Date().toISOString(), c.req.param("id"), fields.concept)
		.run();
	if (!result.meta.changes) return c.json({ error: "That answer could not be found." }, 404);
	return c.json({ id: c.req.param("id") });
});

// A plain page of everything people have said, behind the browser's own password prompt.
app.get("/responses", async (c) => {
	const expected = c.env.LABS_ADMIN_PASSWORD;
	if (!expected) return c.text("Set the LABS_ADMIN_PASSWORD secret to read responses.", 503);
	const header = c.req.header("Authorization") ?? "";
	let given = "";
	try {
		given = header.startsWith("Basic ") ? atob(header.slice(6)).split(":").slice(1).join(":") : "";
	} catch {
		// not base64; treated as no password
	}
	if ((await sha256(given)) !== (await sha256(expected))) {
		return c.text("Password required.", 401, { "WWW-Authenticate": 'Basic realm="Grief Guide Labs", charset="UTF-8"' });
	}

	await ensureSchema(c.env.LABS_DB);
	const { results } = await c.env.LABS_DB
		.prepare("SELECT concept, answer, note, email, created_at FROM responses ORDER BY created_at DESC LIMIT 2000")
		.all<{ concept: string; answer: string | null; note: string | null; email: string | null; created_at: string }>();
	const tally = new Map<string, number>();
	for (const row of results) {
		if (row.answer) tally.set(`${row.concept} · ${row.answer}`, (tally.get(`${row.concept} · ${row.answer}`) ?? 0) + 1);
	}
	const cell = (value: string | null) => `<td>${esc(value ?? "")}</td>`;
	const html =
		`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Labs responses</title>` +
		`<style>body{font:15px/1.5 system-ui,sans-serif;margin:2rem;color:#22302e}table{border-collapse:collapse}` +
		`td,th{border-bottom:1px solid #e3dccf;padding:.4rem .8rem;text-align:left;vertical-align:top}td:nth-child(4){max-width:36rem;white-space:pre-wrap}</style>` +
		`<h1>Labs responses (${results.length})</h1>` +
		`<ul>${[...tally].sort().map(([key, count]) => `<li>${esc(key)}: ${count}</li>`).join("")}</ul>` +
		`<table><tr><th>When</th><th>Concept</th><th>Answer</th><th>Note</th><th>Email</th></tr>` +
		results
			.map((row) => `<tr>${cell(row.created_at.slice(0, 16).replace("T", " "))}${cell(row.concept)}${cell(row.answer)}${cell(row.note)}${cell(row.email)}</tr>`)
			.join("") +
		`</table>`;
	return c.html(html, 200, { "Cache-Control": "no-store" });
});

export default app;
