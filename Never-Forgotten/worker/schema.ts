// Never Forgotten's relational schema (Cloudflare D1 / SQLite), in its own database.
//
// Only rows with status = 'published' are ever returned by the public API.
// Contributor contact details live in their own table and are read only by
// the administration routes.

const STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS contributors (
		id TEXT PRIMARY KEY,
		email TEXT,
		contact_ok INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS memorials (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		name_norm TEXT NOT NULL,
		text TEXT NOT NULL,
		has_photo INTEGER NOT NULL DEFAULT 0,
		slot INTEGER UNIQUE,
		cell INTEGER,
		lat REAL,
		lon REAL,
		color TEXT,
		status TEXT NOT NULL CHECK (status IN ('pending', 'published', 'rejected', 'removed')),
		is_minor INTEGER NOT NULL DEFAULT 0,
		flags TEXT NOT NULL DEFAULT '',
		contributor_id TEXT REFERENCES contributors(id) ON DELETE SET NULL,
		status_token_hash TEXT NOT NULL,
		submitted_at TEXT NOT NULL,
		published_at TEXT,
		updated_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_memorials_name ON memorials(name_norm)`,
	`CREATE INDEX IF NOT EXISTS idx_memorials_status ON memorials(status, submitted_at)`,
	`CREATE INDEX IF NOT EXISTS idx_memorials_cell ON memorials(cell, status)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_memorials_token ON memorials(status_token_hash)`,
	// Photos are small (cropped to 512px in the browser) and kept beside the data.
	// Swap this table for object storage (R2) before the collection grows large.
	`CREATE TABLE IF NOT EXISTS photos (
		memorial_id TEXT PRIMARY KEY REFERENCES memorials(id) ON DELETE CASCADE,
		mime TEXT NOT NULL,
		bytes BLOB NOT NULL,
		size INTEGER NOT NULL,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS moderation_records (
		id TEXT PRIMARY KEY,
		memorial_id TEXT NOT NULL REFERENCES memorials(id) ON DELETE CASCADE,
		action TEXT NOT NULL,
		reason TEXT NOT NULL DEFAULT '',
		actor_role TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS abuse_reports (
		id TEXT PRIMARY KEY,
		memorial_id TEXT NOT NULL REFERENCES memorials(id) ON DELETE CASCADE,
		reason TEXT NOT NULL,
		details TEXT NOT NULL DEFAULT '',
		reporter_email TEXT,
		status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
		resolution TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL,
		resolved_at TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS edit_requests (
		id TEXT PRIMARY KEY,
		memorial_id TEXT NOT NULL REFERENCES memorials(id) ON DELETE CASCADE,
		kind TEXT NOT NULL CHECK (kind IN ('correction', 'removal')),
		details TEXT NOT NULL,
		requester_name TEXT NOT NULL,
		requester_email TEXT NOT NULL,
		relationship TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
		resolution TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL,
		resolved_at TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS consent_records (
		id TEXT PRIMARY KEY,
		memorial_id TEXT NOT NULL REFERENCES memorials(id) ON DELETE CASCADE,
		statement TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS admin_log (
		id TEXT PRIMARY KEY,
		role TEXT NOT NULL,
		action TEXT NOT NULL,
		target TEXT NOT NULL DEFAULT '',
		detail TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS admin_sessions (
		token_hash TEXT PRIMARY KEY,
		role TEXT NOT NULL,
		expires_at TEXT NOT NULL
	)`,
	// Slots whose memorial was permanently deleted. Never reused, so no name ever moves.
	`CREATE TABLE IF NOT EXISTS retired_slots (slot INTEGER PRIMARY KEY)`,
	`CREATE TABLE IF NOT EXISTS rate_limits (
		key TEXT PRIMARY KEY,
		count INTEGER NOT NULL,
		window_start INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
];

let ready: Promise<unknown> | null = null;

/** Creates any missing tables. Runs once per worker isolate; every statement is idempotent. */
export function ensureSchema(db: D1Database) {
	ready ??= db.batch(STATEMENTS.map((sql) => db.prepare(sql))).catch((err) => {
		ready = null;
		throw err;
	});
	return ready;
}
