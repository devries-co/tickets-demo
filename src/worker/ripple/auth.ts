const encoder = new TextEncoder();
const SESSION_DAYS = 30;
// Cloudflare Workers caps PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100_000;

export const SESSION_COOKIE = "ripple_session";
export const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60;

const toHex = (buf: ArrayBuffer) =>
	[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export function randomToken(bytes = 32) {
	return toHex(crypto.getRandomValues(new Uint8Array(bytes)).buffer);
}

export async function sha256(value: string) {
	return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function hashPassword(password: string, salt: string) {
	const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: PBKDF2_ITERATIONS },
		key,
		256,
	);
	return toHex(bits);
}

/** Constant-time comparison so a login can't be timed to learn the hash. */
export function safeEqual(a: string, b: string) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** Stores only a hash of the session token, so a database leak can't be replayed as a login. */
export async function createSession(db: D1Database, userId: string) {
	const token = randomToken();
	const expires = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();
	await db
		.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
		.bind(await sha256(token), userId, expires)
		.run();
	return token;
}

export type User = { id: string; email: string; name: string };

export async function userForToken(db: D1Database, token: string | undefined) {
	if (!token) return null;
	return db
		.prepare(
			`SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
			 WHERE s.token_hash = ? AND s.expires_at > ?`,
		)
		.bind(await sha256(token), new Date().toISOString())
		.first<User>();
}
