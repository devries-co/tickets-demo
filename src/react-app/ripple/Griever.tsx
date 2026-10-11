import { type FormEvent, useState } from "react";
import {
	type Connection,
	type Invitation,
	KIND_LABEL,
	MONTHS,
	NEEDS,
	api,
	firstName,
	formatDay,
	formatWhen,
	useAction,
	useLoad,
} from "./lib";
import { Card, Check, ConfirmButton, CrisisPanel, InviteLink, Notice, Status } from "./ui";

type Member = {
	id: string;
	name: string;
	email: string;
	role: "supporter" | "admin";
	relationship: string;
	status: "invited" | "active";
	inviteToken: string | null;
	personalized: number;
	viewCheckins: number;
};

type Preferences = {
	frequency: string;
	methods: string[];
	supportTypes: string[];
	allowMultiple: boolean;
	spaceUntil: string | null;
};

type Data = {
	circle: { id: string; name: string; status: string };
	preferences: Preferences;
	members: Member[];
	checkins: { id: string; needs: string[]; connection: string | null; createdAt: string }[];
	invitations: Invitation[];
	dates: { id: string; label: string; kind: string; month: number; day: number; shared: number }[];
	consents: { id: string; scope: string; detail: string; granted: number; createdAt: string }[];
	connections: Connection[];
};

type Actions = ReturnType<typeof useAction>;
type Props = { data: Data; base: string; actions: Actions };

const TABS = ["Today", "Invitations", "My circle", "Preferences", "Dates", "Privacy"] as const;

const CONNECTIONS: [string, string][] = [
	["message", "A simple message from someone I trust."],
	["visit", "A short visit or coffee together."],
	["invite", "Someone to invite me to do something."],
	["quiet", "Quiet company, without needing to talk."],
	["space", "Not today. I'd rather have space."],
];

const SCOPE_LABEL: Record<string, string> = {
	circle: "Care circle",
	personalized_outreach: "May receive opportunities",
	view_checkins: "May see check-ins",
	arrange_connection: "Arranged a connection",
	space: "Space",
	outreach_frequency: "Outreach frequency",
	all_support: "All support",
	share_date: "Shared a date",
};

export default function Griever({ circleId, userName }: { circleId: string; userName: string }) {
	const base = `/circles/${circleId}`;
	const { data, error, reload } = useLoad<Data>(`${base}/griever`);
	const actions = useAction(reload);
	const [tab, setTab] = useState<(typeof TABS)[number]>("Today");

	if (error) return <Notice text={error} />;
	if (!data) return <p className="rp-quiet">Loading…</p>;

	const waiting = data.invitations.filter((i) => i.status === "sent").length;
	const props = { data, base, actions };

	return (
		<>
			{data.circle.status === "paused" && (
				<p className="rp-banner">Support is paused. No one is being asked to reach out. You can resume under Privacy.</p>
			)}
			<nav className="rp-tabs" aria-label="Sections">
				{TABS.map((t) => (
					<button
						key={t}
						type="button"
						className={t === tab ? "rp-tab rp-tab-on" : "rp-tab"}
						aria-current={t === tab ? "page" : undefined}
						onClick={() => {
							actions.setNotice("");
							setTab(t);
						}}
					>
						{t}
						{t === "Invitations" && waiting > 0 && <span className="rp-dot">{waiting}</span>}
					</button>
				))}
			</nav>
			{actions.notice && <Notice text={actions.notice} />}
			{tab === "Today" && <Today {...props} userName={userName} />}
			{tab === "Invitations" && <Invitations {...props} />}
			{tab === "My circle" && <Circle {...props} />}
			{tab === "Preferences" && <PreferencesTab {...props} />}
			{tab === "Dates" && <Dates {...props} />}
			{tab === "Privacy" && <Privacy {...props} />}
		</>
	);
}

// ----------------------------------------------------------------------- today

type Step = "ask" | "alone" | "arrange" | "space" | "saved" | "arranged" | "waiting" | "private" | "space-set";

function Today({ data, base, actions, userName }: Props & { userName: string }) {
	const { act, busy } = actions;
	const [step, setStep] = useState<Step>("ask");
	const [needs, setNeeds] = useState<string[]>([]);
	const [note, setNote] = useState("");
	const [showNote, setShowNote] = useState(false);
	const [checkinId, setCheckinId] = useState("");
	const [crisis, setCrisis] = useState(false);
	const [choice, setChoice] = useState("");
	const [shareNeed, setShareNeed] = useState(false);

	const eligible = data.members.filter((m) => m.status === "active" && m.personalized);
	const [chosen, setChosen] = useState<string[] | null>(null);
	const selected = chosen ?? eligible.map((m) => m.id);

	const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

	const save = () =>
		act(async () => {
			const res = await api<{ id: string; crisis: boolean }>("POST", `${base}/checkins`, { needs, note });
			setCheckinId(res.id);
			setCrisis(res.crisis);
			setStep(needs.includes("alone") ? "alone" : needs.includes("space") ? "space" : "saved");
		});

	const choose = () =>
		act(async () => {
			await api("POST", `${base}/checkins/${checkinId}/connection`, { choice });
			setStep(choice === "space" ? "space" : "arrange");
		});

	const takeSpace = (days: number) =>
		act(async () => {
			await api("POST", `${base}/space`, { days });
			setStep("space-set");
		});

	const authorize = () =>
		act(async () => {
			const res = await api<{ offered: boolean }>("POST", `${base}/authorize`, { checkinId, shareNeed, memberIds: selected });
			setStep(res.offered ? "arranged" : "waiting");
		});

	const again = (
		<button
			type="button"
			className="rp-link"
			onClick={() => {
				setNeeds([]);
				setNote("");
				setChoice("");
				setShareNeed(false);
				setStep("ask");
			}}
		>
			Check in again
		</button>
	);

	return (
		<>
			{crisis && <CrisisPanel />}
			{data.preferences.spaceUntil && step !== "space-set" && (
				<p className="rp-banner">
					You've asked for space until {formatDay(data.preferences.spaceUntil)}. No one is being asked to reach out.{" "}
					<button type="button" className="rp-link" onClick={() => act(() => api("DELETE", `${base}/space`))}>
						End this early
					</button>
				</p>
			)}

			{step === "ask" && (
				<Card title="How are you today?" intro="Only if you'd like to. This is private, and there's no need to explain.">
					<fieldset className="rp-options">
						<legend>What feels hardest today?</legend>
						{NEEDS.map(([id, label]) => (
							<label key={id} className={needs.includes(id) ? "rp-option rp-option-on" : "rp-option"}>
								<input type="checkbox" checked={needs.includes(id)} onChange={() => setNeeds(toggle(needs, id))} />
								{label}
							</label>
						))}
					</fieldset>
					{showNote ? (
						<label className="rp-field">
							A private note, only for you
							<textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} />
						</label>
					) : (
						<button type="button" className="rp-link" onClick={() => setShowNote(true)}>
							Add a private note (optional)
						</button>
					)}
					<div className="rp-row">
						<button type="button" className="rp-btn rp-primary" disabled={!needs.length || busy} onClick={save}>
							Save privately
						</button>
					</div>
					<p className="rp-quiet">There's nothing to keep up with here. Come back whenever it helps.</p>
				</Card>
			)}

			{step === "alone" && (
				<Card title="You don't have to carry today alone.">
					<p>Sometimes company helps. Sometimes just knowing someone is thinking of you is enough.</p>
					<fieldset className="rp-options">
						<legend>Would any of these feel good right now?</legend>
						{CONNECTIONS.map(([id, label]) => (
							<label key={id} className={choice === id ? "rp-option rp-option-on" : "rp-option"}>
								<input type="radio" name="connection" checked={choice === id} onChange={() => setChoice(id)} />
								{label}
							</label>
						))}
					</fieldset>
					<div className="rp-row">
						<button type="button" className="rp-btn rp-primary" disabled={!choice || busy} onClick={choose}>
							Continue
						</button>
					</div>
				</Card>
			)}

			{step === "arrange" && (
				<Card title="Would you like Ripple to help arrange that?">
					<p>
						If you say yes, Ripple will quietly ask one person from your circle. They'll see a gentle suggestion to reach
						out to you, and they'll contact you themselves. Nothing is sent on your behalf.
					</p>
					<p className="rp-quiet">
						They will not see what you chose today. They'll only know it's a good week to be in touch.
					</p>
					{eligible.length ? (
						<fieldset className="rp-options">
							<legend>Who may be asked?</legend>
							{eligible.map((m) => (
								<Check key={m.id} checked={selected.includes(m.id)} onChange={() => setChosen(toggle(selected, m.id))}>
									{m.name}
									{m.relationship && <span className="rp-quiet"> · {m.relationship}</span>}
								</Check>
							))}
						</fieldset>
					) : (
						<p className="rp-banner">
							No one in your circle can receive opportunities yet. You can invite someone under My circle, then come back.
						</p>
					)}
					<Check checked={shareNeed} onChange={setShareNeed}>
						It's okay to let them know I've been feeling alone.
					</Check>
					<div className="rp-row">
						<button type="button" className="rp-btn rp-primary" disabled={!selected.length || busy} onClick={authorize}>
							Yes, ask someone for me
						</button>
						<button
							type="button"
							className="rp-btn"
							onClick={() => {
								actions.setNotice("");
								setStep("private");
							}}
						>
							No, keep this private
						</button>
					</div>
				</Card>
			)}

			{step === "space" && (
				<Card title="Of course. Space is a need too.">
					<p>How long would you like? No one will be asked to reach out during this time.</p>
					<div className="rp-row">
						<button type="button" className="rp-btn" disabled={busy} onClick={() => takeSpace(1)}>
							Just today
						</button>
						<button type="button" className="rp-btn" disabled={busy} onClick={() => takeSpace(3)}>
							A few days
						</button>
						<button type="button" className="rp-btn" disabled={busy} onClick={() => takeSpace(7)}>
							A week
						</button>
					</div>
				</Card>
			)}

			{step === "space-set" && (
				<Card title="You have your space.">
					<p>
						{data.preferences.spaceUntil
							? `No one will be asked to reach out until ${formatDay(data.preferences.spaceUntil)}.`
							: "No one will be asked to reach out."}{" "}
						You can end this early any time, and nobody is told why.
					</p>
					{again}
				</Card>
			)}

			{step === "arranged" && (
				<Card title="Done.">
					<p>
						One person from your circle has been asked. If they reach out, it's because they want to. You don't need to
						do anything, {firstName(userName)}.
					</p>
					{again}
				</Card>
			)}

			{step === "waiting" && (
				<Card title="Saved.">
					<p>No one is available at this moment. Ripple will try again and you don't need to do anything.</p>
					{again}
				</Card>
			)}

			{step === "private" && (
				<Card title="Kept private.">
					<p>Nothing was shared, and no one was asked. That's always your choice.</p>
					{again}
				</Card>
			)}

			{step === "saved" && (
				<Card title="Thank you.">
					<p>
						That's saved privately, just for you. Ripple can't yet arrange help with this, but your circle is still here
						under My circle.
					</p>
					{again}
				</Card>
			)}

			{data.checkins.length > 0 && (
				<Card title="Your recent check-ins" intro="Only you can see these.">
					<ul className="rp-list">
						{data.checkins.map((c) => (
							<li key={c.id}>
								<span>{c.needs.map((n) => NEEDS.find(([id]) => id === n)?.[1] ?? n).join(", ")}</span>
								<span className="rp-quiet">{formatDay(c.createdAt)}</span>
							</li>
						))}
					</ul>
				</Card>
			)}
		</>
	);
}

// ----------------------------------------------------------------- invitations

function Invitations({ data, actions }: Props) {
	const { act, busy } = actions;
	const pending = data.invitations.filter((i) => i.status === "sent");
	const confirmed = data.invitations.filter((i) => i.status === "accepted");
	const past = data.invitations.filter((i) => !["sent", "accepted"].includes(i.status));
	const respond = (id: string, accept: boolean) =>
		act(() => api("POST", `/invitations/${id}/respond`, { accept }), accept ? "Confirmed. They'll be glad." : "That's completely fine. They've been told gently.");

	return (
		<>
			<Card title="Invitations" intro="You don't have to talk about anything. Sometimes just being together is enough.">
				{!pending.length && <p>Nothing is waiting for an answer.</p>}
				{pending.map((i) => (
					<article key={i.id} className="rp-item">
						<h3>
							{firstName(i.fromName)} would like to: {i.activity.toLowerCase()}
						</h3>
						<p>{formatWhen(i.proposedFor)}</p>
						{i.note && <p className="rp-quote">{i.note}</p>}
						<div className="rp-row">
							<button type="button" className="rp-btn rp-primary" disabled={busy} onClick={() => respond(i.id, true)}>
								Yes, I'd like that
							</button>
							<button type="button" className="rp-btn" disabled={busy} onClick={() => respond(i.id, false)}>
								Not this time
							</button>
						</div>
					</article>
				))}
			</Card>

			{confirmed.length > 0 && (
				<Card title="Coming up">
					{confirmed.map((i) => (
						<article key={i.id} className="rp-item">
							<h3>
								{i.activity} with {firstName(i.fromName)}
							</h3>
							<p>{formatWhen(i.proposedFor)}</p>
							<div className="rp-row">
								<button type="button" className="rp-btn" disabled={busy} onClick={() => act(() => api("POST", `/invitations/${i.id}/complete`))}>
									We did this
								</button>
								<button type="button" className="rp-btn" disabled={busy} onClick={() => act(() => api("POST", `/invitations/${i.id}/cancel`), "Canceled. No explanation needed.")}>
									I need to cancel
								</button>
							</div>
						</article>
					))}
				</Card>
			)}

			<Card title="Where things stand" intro="Every connection Ripple has helped with, and its status.">
				{!data.connections.length && <p>Nothing yet.</p>}
				<ul className="rp-list">
					{data.connections.map((c) => (
						<li key={c.id}>
							<span>
								{KIND_LABEL[c.kind]}
								{c.supporterName && <span className="rp-quiet"> · {firstName(c.supporterName)}</span>}
							</span>
							<Status value={c.status} />
						</li>
					))}
				</ul>
			</Card>

			{past.length > 0 && (
				<Card title="Earlier invitations">
					<ul className="rp-list">
						{past.map((i) => (
							<li key={i.id}>
								<span>
									{i.activity} with {firstName(i.fromName)}
								</span>
								<Status value={i.status} />
							</li>
						))}
					</ul>
				</Card>
			)}
		</>
	);
}

// -------------------------------------------------------------------- my circle

function Circle({ data, base, actions }: Props) {
	const { act, busy } = actions;
	const [form, setForm] = useState({ name: "", email: "", relationship: "", role: "supporter", personalized: true });

	const invite = (e: FormEvent) => {
		e.preventDefault();
		void act(async () => {
			await api("POST", `${base}/members`, form);
			setForm({ name: "", email: "", relationship: "", role: "supporter", personalized: true });
		}, "Invitation created. Share their private link below.");
	};

	return (
		<>
			<Card title="My circle" intro="The people you trust. You decide what each of them can do, and you can change it any time.">
				{!data.members.length && <p>No one yet. Invite the first person below.</p>}
				{data.members.map((m) => (
					<article key={m.id} className="rp-item">
						<h3>
							{m.name}
							<span className="rp-quiet">
								{" "}
								· {m.role === "admin" ? "Administrator" : "Supporter"}
								{m.relationship && ` · ${m.relationship}`}
							</span>
						</h3>
						{m.status === "invited" && m.inviteToken ? (
							<>
								<p className="rp-quiet">Invited, not yet joined.</p>
								<InviteLink token={m.inviteToken} name={firstName(m.name)} />
							</>
						) : (
							<p className="rp-quiet">In your circle.</p>
						)}
						<Check checked={!!m.personalized} onChange={(v) => act(() => api("PATCH", `${base}/members/${m.id}`, { personalized: v }))}>
							May be asked to reach out to me
						</Check>
						{m.role === "admin" && (
							<Check checked={!!m.viewCheckins} onChange={(v) => act(() => api("PATCH", `${base}/members/${m.id}`, { viewCheckins: v }))}>
								May see what I select in my check-ins (never my notes)
							</Check>
						)}
						<ConfirmButton
							label="Remove from my circle"
							confirm={`Yes, remove ${firstName(m.name)}`}
							onConfirm={() => act(() => api("DELETE", `${base}/members/${m.id}`), `${firstName(m.name)} has been removed.`)}
						/>
					</article>
				))}
			</Card>

			<Card title="Invite someone" intro="A friend, a relative, someone from church. They'll only see what you choose to share.">
				<form className="rp-form" onSubmit={invite}>
					<label className="rp-field">
						Their name
						<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={80} />
					</label>
					<label className="rp-field">
						Their email
						<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
					</label>
					<label className="rp-field">
						How you know them (optional)
						<input value={form.relationship} onChange={(e) => setForm({ ...form, relationship: e.target.value })} placeholder="friend, sister, neighbor" maxLength={40} />
					</label>
					<label className="rp-field">
						Their role
						<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
							<option value="supporter">Supporter</option>
							<option value="admin">Administrator (helps coordinate the circle)</option>
						</select>
					</label>
					<Check checked={form.personalized} onChange={(v) => setForm({ ...form, personalized: v })}>
						They may be asked to reach out to me
					</Check>
					<button type="submit" className="rp-btn rp-primary" disabled={busy}>
						Create invitation
					</button>
				</form>
			</Card>
		</>
	);
}

// ------------------------------------------------------------------ preferences

const FREQUENCIES: [string, string, string][] = [
	["once", "One connection opportunity", "Only when I ask Ripple to arrange one."],
	["weekly", "One a week", "Ripple asks one person each week, taking turns."],
	["twice_weekly", "Two a week", "One early in the week, one later."],
	["paused", "Pause all suggestions", "No one is asked until I change this."],
];

const METHODS: [string, string][] = [
	["text", "Text message"],
	["call", "Phone call"],
	["email", "Email"],
	["in_person", "In person"],
];

function PreferencesTab({ data, base, actions }: Props) {
	const { act, busy } = actions;
	const [prefs, setPrefs] = useState(data.preferences);
	const toggle = (key: "methods" | "supportTypes", id: string) =>
		setPrefs({ ...prefs, [key]: prefs[key].includes(id) ? prefs[key].filter((x) => x !== id) : [...prefs[key], id] });

	return (
		<Card title="Connection preferences" intro="How often, and in what way, you'd like people to reach out.">
			<fieldset className="rp-options">
				<legend>How often</legend>
				{FREQUENCIES.map(([id, label, detail]) => (
					<label key={id} className={prefs.frequency === id ? "rp-option rp-option-on" : "rp-option"}>
						<input type="radio" name="frequency" checked={prefs.frequency === id} onChange={() => setPrefs({ ...prefs, frequency: id })} />
						<span>
							{label}
							<span className="rp-quiet rp-block">{detail}</span>
						</span>
					</label>
				))}
			</fieldset>
			<fieldset className="rp-options">
				<legend>What kinds of connection are welcome</legend>
				{(["message", "visit", "invite", "quiet"] as const).map((id) => (
					<Check key={id} checked={prefs.supportTypes.includes(id)} onChange={() => toggle("supportTypes", id)}>
						{KIND_LABEL[id]}
					</Check>
				))}
			</fieldset>
			<fieldset className="rp-options">
				<legend>How I prefer to be contacted</legend>
				{METHODS.map(([id, label]) => (
					<Check key={id} checked={prefs.methods.includes(id)} onChange={() => toggle("methods", id)}>
						{label}
					</Check>
				))}
			</fieldset>
			<Check checked={prefs.allowMultiple} onChange={(v) => setPrefs({ ...prefs, allowMultiple: v })}>
				It's fine to have more than one invitation open at a time
			</Check>
			<div className="rp-row">
				<button type="button" className="rp-btn rp-primary" disabled={busy} onClick={() => act(() => api("PUT", `${base}/preferences`, prefs), "Preferences saved.")}>
					Save preferences
				</button>
			</div>
		</Card>
	);
}

// ------------------------------------------------------------------------ dates

function Dates({ data, base, actions }: Props) {
	const { act, busy } = actions;
	const [form, setForm] = useState({ label: "", kind: "anniversary", month: 1, day: 1, shared: false });
	const add = (e: FormEvent) => {
		e.preventDefault();
		void act(async () => {
			await api("POST", `${base}/dates`, form);
			setForm({ ...form, label: "" });
		}, "Date added.");
	};

	return (
		<>
			<Card title="Meaningful dates" intro="Birthdays, anniversaries, days that matter. Each stays private unless you choose to share it.">
				{!data.dates.length && <p>No dates yet.</p>}
				{data.dates.map((d) => (
					<article key={d.id} className="rp-item">
						<h3>
							{d.label}
							<span className="rp-quiet">
								{" "}
								· {MONTHS[d.month - 1]} {d.day}
							</span>
						</h3>
						<Check checked={!!d.shared} onChange={(v) => act(() => api("PATCH", `${base}/dates/${d.id}`, { shared: v }))}>
							Share with my circle, so someone remembers with me
						</Check>
						<button type="button" className="rp-link" onClick={() => act(() => api("DELETE", `${base}/dates/${d.id}`))}>
							Remove this date
						</button>
					</article>
				))}
			</Card>
			<Card title="Add a date">
				<form className="rp-form" onSubmit={add}>
					<label className="rp-field">
						What is this day?
						<input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Our wedding anniversary" required maxLength={80} />
					</label>
					<label className="rp-field">
						Kind
						<select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
							<option value="anniversary">Anniversary</option>
							<option value="birthday">Birthday</option>
							<option value="other">Something else</option>
						</select>
					</label>
					<div className="rp-row">
						<label className="rp-field">
							Month
							<select value={form.month} onChange={(e) => setForm({ ...form, month: Number(e.target.value) })}>
								{MONTHS.map((m, i) => (
									<option key={m} value={i + 1}>
										{m}
									</option>
								))}
							</select>
						</label>
						<label className="rp-field">
							Day
							<input type="number" min={1} max={31} value={form.day} onChange={(e) => setForm({ ...form, day: Number(e.target.value) })} />
						</label>
					</div>
					<Check checked={form.shared} onChange={(v) => setForm({ ...form, shared: v })}>
						Share with my circle
					</Check>
					<button type="submit" className="rp-btn rp-primary" disabled={busy}>
						Add date
					</button>
				</form>
			</Card>
		</>
	);
}

// ---------------------------------------------------------------------- privacy

function Privacy({ data, base, actions }: Props) {
	const { act, busy } = actions;
	const paused = data.circle.status === "paused";
	return (
		<>
			<Card title="Privacy controls" intro="You are in charge of all of this, and every change takes effect immediately.">
				<ul className="rp-plain">
					<li>Your check-ins are private. Supporters can never see them.</li>
					<li>An administrator can see them only if you switch that on for them under My circle.</li>
					<li>No one is asked to reach out unless you say so, and they aren't told why unless you choose to share it.</li>
				</ul>
				<div className="rp-row">
					<button
						type="button"
						className={paused ? "rp-btn rp-primary" : "rp-btn"}
						disabled={busy}
						onClick={() => act(() => api("POST", `${base}/pause`, { paused: !paused }), paused ? "Support has resumed." : "Support is paused. Every open request has been withdrawn.")}
					>
						{paused ? "Resume support" : "Pause all support"}
					</button>
				</div>
			</Card>

			<Card title="What you've agreed to" intro="A record of each choice, with when you made it.">
				{!data.consents.length && <p>Nothing yet.</p>}
				<ul className="rp-list">
					{data.consents.map((c) => (
						<li key={c.id}>
							<span>
								{SCOPE_LABEL[c.scope] ?? c.scope}
								<span className="rp-quiet rp-block">{c.detail}</span>
							</span>
							<span className="rp-quiet">
								{c.granted ? "Allowed" : "Withdrawn"} · {new Date(c.createdAt).toLocaleDateString()}
							</span>
						</li>
					))}
				</ul>
			</Card>

			<Card title="Your data">
				<div className="rp-stack">
					<ConfirmButton
						label="Delete my check-in history"
						confirm="Yes, delete my check-ins"
						onConfirm={() => act(() => api("DELETE", `${base}/checkins`), "Your check-in history has been deleted.")}
					/>
					<ConfirmButton
						label="Delete this circle and everything in it"
						confirm="Yes, delete it all"
						onConfirm={() =>
							act(async () => {
								await api("DELETE", base);
								window.location.assign("/ripple");
							})
						}
					/>
				</div>
			</Card>
		</>
	);
}
