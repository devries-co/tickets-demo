import { type FormEvent, useCallback, useEffect, useState } from "react";
import { MAX_WORDS, countWords } from "../shared/text";
import { BASE, api, message } from "./api";
import "./nf.css";

type Role = "admin" | "moderator";
type Item = {
	id: string;
	name: string;
	text: string;
	hasPhoto: number;
	status: string;
	isMinor: number;
	flags: string;
	slot: number | null;
	submittedAt: string;
	duplicates: number;
};
type Detail = {
	memorial: Item & { publishedAt: string | null; contributorEmail: string | null; contactOk: number | null };
	history: { action: string; reason: string; actorRole: string; createdAt: string }[];
	duplicates: { id: string; name: string; text: string; status: string; submittedAt: string }[];
};
type Summary = { counts: Record<string, number>; openReports: number; openRequests: number; daily: { day: string; n: number }[] };
type Report = { id: string; reason: string; details: string; email: string | null; status: string; resolution: string; createdAt: string; memorialId: string; memorialName: string; memorialStatus: string };
type Request = Report & { kind: string; name: string; relationship: string };
type LogEntry = { id: string; role: string; action: string; target: string; detail: string; createdAt: string };

const TABS = ["Queue", "All memorials", "Reports", "Requests", "Activity"] as const;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Login({ configured, onDone }: { configured: boolean; onDone: () => void }) {
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		try {
			await api("POST", "/admin/login", { password });
			onDone();
		} catch (err) {
			setError(message(err));
		}
	};
	return (
		<section className="nf-admin-card nf-admin-login">
			<h1>Never Forgotten administration</h1>
			{!configured && (
				<p className="nf-error">
					Administration isn't set up yet. Add a Worker secret named NF_ADMIN_PASSWORD in Cloudflare, then sign in with it here.
				</p>
			)}
			<form className="nf-form" onSubmit={submit}>
				<label>
					Password
					<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
				</label>
				{error && <p className="nf-error">{error}</p>}
				<button type="submit" className="nf-btn nf-gold">
					Sign in
				</button>
			</form>
		</section>
	);
}

/** One memorial, with everything a reviewer needs and every action they can take. */
function Review({ id, role, onChange, onClose }: { id: string; role: Role; onChange: () => void; onClose: () => void }) {
	const [detail, setDetail] = useState<Detail | null>(null);
	const [edit, setEdit] = useState<{ name: string; text: string } | null>(null);
	const [reason, setReason] = useState("");
	const [error, setError] = useState("");

	const load = useCallback(() => api<Detail>("GET", `/admin/memorials/${id}`).then(setDetail, (err) => setError(message(err))), [id]);
	useEffect(() => {
		void load();
	}, [load]);

	const act = async (fn: () => Promise<unknown>, closes = false) => {
		setError("");
		try {
			await fn();
			onChange();
			if (closes) onClose();
			else await load();
		} catch (err) {
			setError(message(err));
		}
	};

	if (!detail) return <section className="nf-admin-card">{error || "Loading…"}</section>;
	const m = detail.memorial;
	const path = `/admin/memorials/${m.id}`;

	return (
		<section className="nf-admin-card">
			<header className="nf-panel-head">
				<h2>{m.name}</h2>
				<button type="button" className="nf-icon" onClick={onClose} aria-label="Close">
					×
				</button>
			</header>
			<div className="nf-review">
				{m.hasPhoto ? <img className="nf-portrait" src={`/api/never-forgotten/admin/photo/${m.id}`} alt="" width={160} height={160} /> : <p className="nf-muted">No photo</p>}
				<div>
					<p className="nf-words">{m.text}</p>
					<p className="nf-muted">
						{countWords(m.text)} words · {m.status} · submitted {when(m.submittedAt)}
						{m.slot !== null && ` · place ${m.slot.toLocaleString()}`}
					</p>
					{!!m.isMinor && <p className="nf-flag">Marked as a memorial for a child. Please review with extra care.</p>}
					{m.flags && <p className="nf-flag">Held automatically: contains {m.flags.split(",").join(", ")}.</p>}
					<p className="nf-muted">
						Contributor: {m.contributorEmail ?? "no email given"}
						{m.contributorEmail && (m.contactOk ? " (may be contacted)" : " (did not agree to be contacted)")}
					</p>
				</div>
			</div>

			{detail.duplicates.length > 0 && (
				<div className="nf-admin-block">
					<h3>Other submissions with this name</h3>
					<ul className="nf-admin-list">
						{detail.duplicates.map((d) => (
							<li key={d.id}>
								<span>
									{d.name} <em>({d.status})</em>
									<span className="nf-muted nf-block">{d.text}</span>
								</span>
								<span className="nf-muted">{when(d.submittedAt)}</span>
							</li>
						))}
					</ul>
					<p className="nf-muted">The same name can belong to different people. Compare the words and photos before treating one as a duplicate.</p>
				</div>
			)}

			{edit ? (
				<form
					className="nf-form"
					onSubmit={(e) => {
						e.preventDefault();
						void act(() => api("PATCH", path, edit)).then(() => setEdit(null));
					}}
				>
					<label>
						Name
						<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required />
					</label>
					<label>
						Memorial text ({countWords(edit.text)} of {MAX_WORDS} words)
						<textarea value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} rows={3} required />
					</label>
					<div className="nf-actions">
						<button type="submit" className="nf-btn nf-gold" disabled={countWords(edit.text) > MAX_WORDS}>
							Save changes
						</button>
						<button type="button" className="nf-btn" onClick={() => setEdit(null)}>
							Cancel
						</button>
					</div>
				</form>
			) : (
				<>
					<label className="nf-form">
						Reason (kept in the record; used for reject and remove)
						<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
					</label>
					<div className="nf-actions">
						{m.status !== "published" && (
							<button type="button" className="nf-btn nf-gold" onClick={() => act(() => api("POST", `${path}/approve`))}>
								{m.status === "removed" ? "Restore" : "Approve and publish"}
							</button>
						)}
						{m.status === "pending" && (
							<button type="button" className="nf-btn" onClick={() => act(() => api("POST", `${path}/reject`, { reason }))}>
								Reject
							</button>
						)}
						{m.status === "published" && (
							<button type="button" className="nf-btn" onClick={() => act(() => api("POST", `${path}/remove`, { reason }))}>
								Remove from the Earth
							</button>
						)}
						<button type="button" className="nf-btn" onClick={() => setEdit({ name: m.name, text: m.text })}>
							Edit
						</button>
						{!!m.hasPhoto && (
							<button type="button" className="nf-btn" onClick={() => act(() => api("PATCH", path, { removePhoto: true }))}>
								Remove photo
							</button>
						)}
						{m.status === "published" && (
							<a className="nf-btn" href={`${BASE}/remember/${m.id}`} target="_blank" rel="noreferrer">
								View on Earth
							</a>
						)}
						{role === "admin" && (
							<button
								type="button"
								className="nf-btn nf-danger"
								onClick={() => {
									if (reason.trim().toLowerCase() === "delete") void act(() => api("DELETE", path), true);
									else setError('To delete this memorial and its contributor details permanently, type "delete" in the reason box, then press this again.');
								}}
							>
								Delete permanently
							</button>
						)}
					</div>
				</>
			)}
			{error && <p className="nf-error">{error}</p>}

			<div className="nf-admin-block">
				<h3>History</h3>
				<ul className="nf-admin-list">
					{detail.history.map((h, i) => (
						<li key={i}>
							<span>
								{h.action} by {h.actorRole}
								{h.reason && <span className="nf-muted nf-block">{h.reason}</span>}
							</span>
							<span className="nf-muted">{when(h.createdAt)}</span>
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}

function Memorials({ status, role, onChange }: { status: string; role: Role; onChange: () => void }) {
	const [filter, setFilter] = useState(status);
	const [q, setQ] = useState("");
	const [offset, setOffset] = useState(0);
	const [data, setData] = useState<{ memorials: Item[]; total: number } | null>(null);
	const [open, setOpen] = useState("");

	const load = useCallback(
		() => api<{ memorials: Item[]; total: number }>("GET", `/admin/memorials?status=${filter}&q=${encodeURIComponent(q)}&offset=${offset}`).then(setData, () => {}),
		[filter, q, offset],
	);
	useEffect(() => {
		const timer = setTimeout(load, 200);
		return () => clearTimeout(timer);
	}, [load]);

	if (open) {
		return (
			<Review
				id={open}
				role={role}
				onClose={() => setOpen("")}
				onChange={() => {
					void load();
					onChange();
				}}
			/>
		);
	}

	return (
		<section className="nf-admin-card">
			<div className="nf-actions">
				<input className="nf-admin-search" type="search" placeholder="Search by name" value={q} onChange={(e) => (setOffset(0), setQ(e.target.value))} aria-label="Search by name" />
				{status === "" && (
					<select value={filter} onChange={(e) => (setOffset(0), setFilter(e.target.value))} aria-label="Status">
						<option value="">Every status</option>
						<option value="pending">Pending</option>
						<option value="published">Published</option>
						<option value="rejected">Rejected</option>
						<option value="removed">Removed</option>
					</select>
				)}
			</div>
			{data && !data.memorials.length && <p className="nf-muted">{status === "pending" ? "Nothing is waiting for review." : "No memorials match."}</p>}
			<ul className="nf-admin-list">
				{data?.memorials.map((m) => (
					<li key={m.id}>
						<button type="button" className="nf-admin-row" onClick={() => setOpen(m.id)}>
							<span>
								<strong>{m.name}</strong> <em>({m.status})</em>
								{!!m.isMinor && <span className="nf-flag"> child</span>}
								{m.flags && <span className="nf-flag"> held: {m.flags}</span>}
								{m.duplicates > 0 && <span className="nf-flag"> same name ×{m.duplicates}</span>}
								<span className="nf-muted nf-block">{m.text}</span>
							</span>
							<span className="nf-muted">
								{m.hasPhoto ? "photo · " : ""}
								{when(m.submittedAt)}
							</span>
						</button>
					</li>
				))}
			</ul>
			{data && data.total > 40 && (
				<div className="nf-actions">
					<button type="button" className="nf-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 40))}>
						Newer
					</button>
					<span className="nf-muted">
						{offset + 1} to {Math.min(data.total, offset + 40)} of {data.total.toLocaleString()}
					</span>
					<button type="button" className="nf-btn" disabled={offset + 40 >= data.total} onClick={() => setOffset(offset + 40)}>
						Older
					</button>
				</div>
			)}
		</section>
	);
}

/** Abuse reports, and correction or removal requests: the same shape, so one list serves both. */
function Inbox({ kind, onChange, onOpen }: { kind: "reports" | "requests"; onChange: () => void; onOpen: (id: string) => void }) {
	const [items, setItems] = useState<(Report | Request)[] | null>(null);
	const [notes, setNotes] = useState<Record<string, string>>({});
	const load = useCallback(() => api<Record<string, (Report | Request)[]>>("GET", `/admin/${kind}`).then((r) => setItems(r[kind]), () => {}), [kind]);
	useEffect(() => {
		void load();
	}, [load]);

	const resolve = async (id: string) => {
		await api("POST", `/admin/${kind}/${id}/resolve`, { resolution: notes[id] ?? "" }).catch(() => {});
		await load();
		onChange();
	};

	return (
		<section className="nf-admin-card">
			{items && !items.length && <p className="nf-muted">Nothing here.</p>}
			<ul className="nf-admin-list">
				{items?.map((r) => (
					<li key={r.id} className="nf-admin-inbox">
						<p>
							<strong>{"kind" in r ? (r.kind === "removal" ? "Removal request" : "Correction request") : `Report: ${r.reason.replace(/_/g, " ")}`}</strong> about{" "}
							<button type="button" className="nf-link" onClick={() => onOpen(r.memorialId)}>
								{r.memorialName}
							</button>{" "}
							<em>({r.memorialStatus})</em>
						</p>
						{r.details && <p>{r.details}</p>}
						<p className="nf-muted">
							{"name" in r && `${r.name}${r.relationship ? `, ${r.relationship}` : ""} · `}
							{r.email ?? "no email"} · {when(r.createdAt)}
						</p>
						{r.status === "open" ? (
							<div className="nf-actions">
								<input placeholder="What was done (kept in the record)" value={notes[r.id] ?? ""} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} aria-label="Resolution" />
								<button type="button" className="nf-btn" onClick={() => resolve(r.id)}>
									Mark resolved
								</button>
							</div>
						) : (
							<p className="nf-muted">Resolved{r.resolution && `: ${r.resolution}`}</p>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}

function Activity({ summary }: { summary: Summary | null }) {
	const [log, setLog] = useState<LogEntry[]>([]);
	useEffect(() => {
		api<{ log: LogEntry[] }>("GET", "/admin/log").then((r) => setLog(r.log), () => {});
	}, []);
	const peak = Math.max(1, ...(summary?.daily.map((d) => d.n) ?? []));
	return (
		<section className="nf-admin-card">
			<h3>Submissions, last 14 days</h3>
			{!summary?.daily.length && <p className="nf-muted">None yet.</p>}
			<ul className="nf-admin-bars">
				{summary?.daily.map((d) => (
					<li key={d.day}>
						<span>{d.day}</span>
						<span className="nf-bar" style={{ width: `${(d.n / peak) * 100}%` }} />
						<span>{d.n}</span>
					</li>
				))}
			</ul>
			<h3>Administrative log</h3>
			{!log.length && <p className="nf-muted">Nothing yet.</p>}
			<ul className="nf-admin-list">
				{log.map((entry) => (
					<li key={entry.id}>
						<span>
							{entry.role} {entry.action} <code>{entry.target}</code>
							{entry.detail && <span className="nf-muted nf-block">{entry.detail}</span>}
						</span>
						<span className="nf-muted">{when(entry.createdAt)}</span>
					</li>
				))}
			</ul>
		</section>
	);
}

export default function Admin() {
	const [me, setMe] = useState<{ role: Role | null; configured: boolean } | null>(null);
	const [summary, setSummary] = useState<Summary | null>(null);
	const [tab, setTab] = useState<(typeof TABS)[number]>("Queue");
	const [open, setOpen] = useState("");

	const refresh = useCallback(async () => {
		const who = await api<{ role: Role | null; configured: boolean }>("GET", "/admin/me");
		setMe(who);
		if (who.role) setSummary(await api<Summary>("GET", "/admin/summary"));
	}, []);
	useEffect(() => {
		document.title = "Administration · Never Forgotten";
		const timer = setTimeout(() => void refresh().catch(() => {}), 0);
		return () => clearTimeout(timer);
	}, [refresh]);

	if (!me) return <main className="nf nf-admin" />;
	if (!me.role) {
		return (
			<main className="nf nf-admin">
				<Login configured={me.configured} onDone={refresh} />
			</main>
		);
	}

	const counts = summary?.counts ?? {};
	const badge: Record<string, number> = { Queue: counts.pending ?? 0, Reports: summary?.openReports ?? 0, Requests: summary?.openRequests ?? 0 };

	return (
		<main className="nf nf-admin">
			<header className="nf-admin-head">
				<h1>Never Forgotten administration</h1>
				<span className="nf-muted">Signed in as {me.role}</span>
				<button
					type="button"
					className="nf-btn"
					onClick={async () => {
						await api("POST", "/admin/logout");
						void refresh();
					}}
				>
					Sign out
				</button>
			</header>
			<dl className="nf-admin-stats">
				{(["published", "pending", "rejected", "removed"] as const).map((s) => (
					<div key={s}>
						<dt>{s}</dt>
						<dd>{(counts[s] ?? 0).toLocaleString()}</dd>
					</div>
				))}
			</dl>
			<nav className="nf-admin-tabs">
				{TABS.map((t) => (
					<button
						key={t}
						type="button"
						className={t === tab ? "nf-btn nf-gold" : "nf-btn"}
						onClick={() => {
							setOpen("");
							setTab(t);
						}}
					>
						{t}
						{badge[t] > 0 && ` (${badge[t]})`}
					</button>
				))}
			</nav>
			{open ? (
				<Review id={open} role={me.role} onClose={() => setOpen("")} onChange={refresh} />
			) : (
				<>
					{tab === "Queue" && <Memorials key="queue" status="pending" role={me.role} onChange={refresh} />}
					{tab === "All memorials" && <Memorials key="all" status="" role={me.role} onChange={refresh} />}
					{tab === "Reports" && <Inbox key="reports" kind="reports" onChange={refresh} onOpen={setOpen} />}
					{tab === "Requests" && <Inbox key="requests" kind="requests" onChange={refresh} onOpen={setOpen} />}
					{tab === "Activity" && <Activity summary={summary} />}
				</>
			)}
		</main>
	);
}
