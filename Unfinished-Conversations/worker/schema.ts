// Unfinished Conversations' relational schema (Cloudflare D1 / SQLite), in its own database.
//
// Everything a person records, writes or uploads is private to them. The only
// rows another person can ever read are `contributions` (and the media they
// reference) in a shared collection that person is an active member of, and a
// single recording behind a share link its owner created.

const STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS users (
		id TEXT PRIMARY KEY,
		email TEXT NOT NULL UNIQUE,
		name TEXT NOT NULL,
		password_hash TEXT NOT NULL,
		password_salt TEXT NOT NULL,
		prefs TEXT NOT NULL DEFAULT '{}',
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS sessions (
		token_hash TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		expires_at TEXT NOT NULL
	)`,
	// Recordings and photographs. Bytes are stored in ~half-megabyte chunks so a
	// long recording uploads piece by piece and a failed piece can be retried.
	`CREATE TABLE IF NOT EXISTS assets (
		id TEXT PRIMARY KEY,
		owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		kind TEXT NOT NULL CHECK (kind IN ('audio', 'image')),
		mime TEXT NOT NULL,
		size INTEGER NOT NULL,
		duration_ms INTEGER,
		name TEXT NOT NULL DEFAULT '',
		complete INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS asset_chunks (
		asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
		idx INTEGER NOT NULL,
		bytes BLOB NOT NULL,
		PRIMARY KEY (asset_id, idx)
	)`,
	`CREATE TABLE IF NOT EXISTS loved_ones (
		id TEXT PRIMARY KEY,
		owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		nickname TEXT NOT NULL DEFAULT '',
		relationship TEXT NOT NULL DEFAULT '',
		photo_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
		birth_date TEXT,
		death_date TEXT,
		created_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_loved_owner ON loved_ones(owner_id)`,
	`CREATE TABLE IF NOT EXISTS entries (
		id TEXT PRIMARY KEY,
		owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		loved_one_id TEXT NOT NULL REFERENCES loved_ones(id) ON DELETE CASCADE,
		type TEXT NOT NULL CHECK (type IN ('voice', 'letter', 'memory')),
		title TEXT NOT NULL DEFAULT '',
		content TEXT NOT NULL DEFAULT '',
		transcript TEXT NOT NULL DEFAULT '',
		audio_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
		tags TEXT NOT NULL DEFAULT '[]',
		privacy TEXT NOT NULL DEFAULT 'private' CHECK (privacy IN ('private')),
		draft INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_entries_loved ON entries(loved_one_id, created_at)`,
	`CREATE TABLE IF NOT EXISTS entry_photos (
		entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
		asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
		caption TEXT NOT NULL DEFAULT '',
		position INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (entry_id, asset_id)
	)`,
	// status: 'suggested' (from AI, awaiting the person's decision), 'approved', or 'rejected'.
	`CREATE TABLE IF NOT EXISTS categories (
		id TEXT PRIMARY KEY,
		entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		source TEXT NOT NULL CHECK (source IN ('ai', 'user')),
		status TEXT NOT NULL CHECK (status IN ('suggested', 'approved', 'rejected')),
		UNIQUE (entry_id, name)
	)`,
	`CREATE TABLE IF NOT EXISTS activities (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		loved_one_id TEXT NOT NULL REFERENCES loved_ones(id) ON DELETE CASCADE,
		entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
		description TEXT NOT NULL,
		kind TEXT NOT NULL DEFAULT 'someday' CHECK (kind IN ('someday', 'tradition')),
		planned_date TEXT,
		status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'archived')),
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_activities_loved ON activities(loved_one_id, status)`,
	// Reflections and photographs added afterwards, including in later years.
	`CREATE TABLE IF NOT EXISTS activity_notes (
		id TEXT PRIMARY KEY,
		activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
		text TEXT NOT NULL DEFAULT '',
		asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS important_dates (
		id TEXT PRIMARY KEY,
		owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		loved_one_id TEXT NOT NULL REFERENCES loved_ones(id) ON DELETE CASCADE,
		label TEXT NOT NULL,
		month INTEGER NOT NULL,
		day INTEGER NOT NULL,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS collections (
		id TEXT PRIMARY KEY,
		owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		about TEXT NOT NULL DEFAULT '',
		description TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS collection_members (
		id TEXT PRIMARY KEY,
		collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
		user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
		email TEXT NOT NULL,
		name TEXT NOT NULL,
		role TEXT NOT NULL CHECK (role IN ('owner', 'contributor', 'viewer')),
		status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'left', 'removed')),
		invite_token TEXT UNIQUE,
		created_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_members_user ON collection_members(user_id, status)`,
	`CREATE TABLE IF NOT EXISTS contributions (
		id TEXT PRIMARY KEY,
		collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		author_name TEXT NOT NULL,
		title TEXT NOT NULL DEFAULT '',
		content TEXT NOT NULL DEFAULT '',
		audio_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_contributions_collection ON contributions(collection_id, created_at)`,
	`CREATE TABLE IF NOT EXISTS contribution_photos (
		contribution_id TEXT NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
		asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
		caption TEXT NOT NULL DEFAULT '',
		position INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (contribution_id, asset_id)
	)`,
	`CREATE TABLE IF NOT EXISTS books (
		id TEXT PRIMARY KEY,
		owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		loved_one_id TEXT NOT NULL REFERENCES loved_ones(id) ON DELETE CASCADE,
		title TEXT NOT NULL,
		config TEXT NOT NULL DEFAULT '{}',
		status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finished')),
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	// A book holds its own edited copy of each memory's words; the original entry is never changed by it.
	`CREATE TABLE IF NOT EXISTS book_items (
		id TEXT PRIMARY KEY,
		book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
		entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
		chapter TEXT NOT NULL DEFAULT '',
		position INTEGER NOT NULL DEFAULT 0,
		title TEXT NOT NULL DEFAULT '',
		text TEXT NOT NULL DEFAULT '',
		show_photos INTEGER NOT NULL DEFAULT 1,
		show_audio INTEGER NOT NULL DEFAULT 1
	)`,
	`CREATE INDEX IF NOT EXISTS idx_book_items ON book_items(book_id, position)`,
	// One row per AI request, recording that consent was in place when it ran.
	`CREATE TABLE IF NOT EXISTS ai_records (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		entry_id TEXT REFERENCES entries(id) ON DELETE CASCADE,
		kind TEXT NOT NULL,
		consent INTEGER NOT NULL,
		source TEXT NOT NULL,
		result TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`,
	// Listening links for one recording (the QR codes in a Legacy Book). The token is kept so the
	// owner's book can show the same code again; revoking the link makes it useless.
	`CREATE TABLE IF NOT EXISTS share_links (
		id TEXT PRIMARY KEY,
		token TEXT NOT NULL UNIQUE,
		owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
		created_at TEXT NOT NULL,
		revoked_at TEXT
	)`,
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
