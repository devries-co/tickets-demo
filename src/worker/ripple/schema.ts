// Ripple's relational schema (Cloudflare D1 / SQLite).
//
// Private emotional data lives only in `checkins`. Everything supporters can
// read (`opportunities`, `recommendations`, `invitations`, `notifications`)
// is stored separately and never contains check-in content.

const STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS users (
		id TEXT PRIMARY KEY,
		email TEXT NOT NULL UNIQUE,
		name TEXT NOT NULL,
		password_hash TEXT NOT NULL,
		password_salt TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS sessions (
		token_hash TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		expires_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS roles (
		role TEXT PRIMARY KEY,
		description TEXT NOT NULL
	)`,
	`INSERT OR IGNORE INTO roles (role, description) VALUES
		('griever', 'The grieving person. Owns the circle, its private check-ins and every consent decision.'),
		('supporter', 'Invited to the circle. Sees only opportunities offered to them and what the grieving person shares.'),
		('admin', 'Coordinates the circle. Manages supporters and sees scheduling, never private check-ins unless granted.')`,
	`CREATE TABLE IF NOT EXISTS circles (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		griever_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
		griever_name TEXT NOT NULL,
		created_by TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('pending_consent', 'active', 'paused')),
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS circle_members (
		id TEXT PRIMARY KEY,
		circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
		user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
		email TEXT NOT NULL,
		name TEXT NOT NULL,
		role TEXT NOT NULL REFERENCES roles(role),
		relationship TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'removed', 'left')),
		invite_token TEXT UNIQUE,
		availability TEXT NOT NULL DEFAULT 'flexible',
		created_at TEXT NOT NULL,
		joined_at TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS idx_members_user ON circle_members(user_id, status)`,
	`CREATE INDEX IF NOT EXISTS idx_members_circle ON circle_members(circle_id, status)`,
	// Per-member grants the grieving person controls:
	//   personalized_outreach - may be offered support opportunities
	//   view_checkins         - an administrator may read private check-ins
	`CREATE TABLE IF NOT EXISTS member_permissions (
		member_id TEXT NOT NULL REFERENCES circle_members(id) ON DELETE CASCADE,
		permission TEXT NOT NULL CHECK (permission IN ('personalized_outreach', 'view_checkins')),
		granted_at TEXT NOT NULL,
		PRIMARY KEY (member_id, permission)
	)`,
	`CREATE TABLE IF NOT EXISTS checkins (
		id TEXT PRIMARY KEY,
		circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		needs TEXT NOT NULL,
		connection TEXT,
		note TEXT,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS support_preferences (
		circle_id TEXT PRIMARY KEY REFERENCES circles(id) ON DELETE CASCADE,
		frequency TEXT NOT NULL DEFAULT 'once' CHECK (frequency IN ('once', 'weekly', 'twice_weekly', 'paused')),
		methods TEXT NOT NULL DEFAULT '["text"]',
		support_types TEXT NOT NULL DEFAULT '["message","visit","invite","quiet"]',
		allow_multiple INTEGER NOT NULL DEFAULT 0,
		space_until TEXT,
		updated_at TEXT NOT NULL
	)`,
	// Append-only: a withdrawal is a new row with granted = 0.
	`CREATE TABLE IF NOT EXISTS consent_records (
		id TEXT PRIMARY KEY,
		circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
		user_id TEXT NOT NULL,
		scope TEXT NOT NULL,
		detail TEXT NOT NULL DEFAULT '',
		granted INTEGER NOT NULL,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS opportunities (
		id TEXT PRIMARY KEY,
		circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
		kind TEXT NOT NULL CHECK (kind IN ('message', 'visit', 'invite', 'quiet', 'remember')),
		origin TEXT NOT NULL CHECK (origin IN ('checkin', 'schedule', 'date', 'supporter')),
		status TEXT NOT NULL CHECK (status IN ('suggested', 'offered', 'accepted_by_supporter', 'invitation_sent',
			'accepted_by_griever', 'declined', 'completed', 'canceled')),
		share_need INTEGER NOT NULL DEFAULT 0,
		allowed_member_ids TEXT,
		date_label TEXT,
		assigned_member_id TEXT REFERENCES circle_members(id) ON DELETE SET NULL,
		dedupe_key TEXT UNIQUE,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_opps_circle ON opportunities(circle_id, status)`,
	`CREATE TABLE IF NOT EXISTS recommendations (
		id TEXT PRIMARY KEY,
		opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
		member_id TEXT NOT NULL REFERENCES circle_members(id) ON DELETE CASCADE,
		title TEXT NOT NULL,
		body TEXT NOT NULL,
		suggested_message TEXT NOT NULL,
		source TEXT NOT NULL CHECK (source IN ('ai', 'template')),
		model TEXT,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS support_offers (
		id TEXT PRIMARY KEY,
		opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
		member_id TEXT NOT NULL REFERENCES circle_members(id) ON DELETE CASCADE,
		status TEXT NOT NULL CHECK (status IN ('offered', 'accepted', 'declined', 'withdrawn')),
		created_at TEXT NOT NULL,
		responded_at TEXT,
		UNIQUE (opportunity_id, member_id)
	)`,
	`CREATE TABLE IF NOT EXISTS commitments (
		id TEXT PRIMARY KEY,
		opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
		circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
		member_id TEXT NOT NULL REFERENCES circle_members(id) ON DELETE CASCADE,
		status TEXT NOT NULL CHECK (status IN ('accepted', 'completed', 'canceled')),
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS invitations (
		id TEXT PRIMARY KEY,
		circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
		opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
		from_member_id TEXT NOT NULL REFERENCES circle_members(id) ON DELETE CASCADE,
		activity TEXT NOT NULL,
		proposed_for TEXT NOT NULL,
		note TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL CHECK (status IN ('sent', 'accepted', 'declined', 'completed', 'canceled')),
		created_at TEXT NOT NULL,
		responded_at TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS meaningful_dates (
		id TEXT PRIMARY KEY,
		circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
		label TEXT NOT NULL,
		kind TEXT NOT NULL DEFAULT 'other',
		month INTEGER NOT NULL,
		day INTEGER NOT NULL,
		shared INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS notification_preferences (
		user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
		paused INTEGER NOT NULL DEFAULT 0,
		updated_at TEXT NOT NULL
	)`,
	// Notification history. Titles and bodies are deliberately generic: they
	// never carry check-in content, so previews are safe to show anywhere.
	`CREATE TABLE IF NOT EXISTS notifications (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		circle_id TEXT REFERENCES circles(id) ON DELETE CASCADE,
		kind TEXT NOT NULL,
		title TEXT NOT NULL,
		body TEXT NOT NULL,
		dedupe_key TEXT UNIQUE,
		read_at TEXT,
		created_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at)`,
	// Activity history records that something happened, never what was felt.
	`CREATE TABLE IF NOT EXISTS activity (
		id TEXT PRIMARY KEY,
		circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
		actor_name TEXT NOT NULL,
		kind TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_activity_circle ON activity(circle_id, created_at)`,
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
