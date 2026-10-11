import { useCallback, useEffect, useState } from "react";
import {
	HELP_OPTIONS,
	LIGHTS,
	WORK_HELPS,
	WORK_MENTION,
	type AdminCircle,
	type Card,
	type HardDate,
	type Light,
	type PlannedMessage,
	type WorkCard,
	type WorkMention,
} from "../shared";
import { api, store } from "./api";
import { ADMIN_KEY } from "./Landing";
import { Chips, ErrorNote, Flash, Lamp, Qr, Section, Segmented, Spinner } from "./ui";
import { copyText, nextFixed, nextOccurrence, prettyDate, timeAgo, todayIso, upcomingHoliday, addDays, useFlash } from "./util";

type Tab = "light" | "card" | "circle" | "timeline" | "work" | "settings";
const TABS: { id: Tab; label: string }[] = [
	{ id: "light", label: "Light" },
	{ id: "card", label: "My card" },
	{ id: "circle", label: "Circle" },
	{ id: "timeline", label: "Timeline" },
	{ id: "work", label: "Work" },
	{ id: "settings", label: "Settings" },
];
const NOTIFY_PREF = "porchlight:notify";

export default function Griever({ token, away }: { token: string; away: boolean }) {
	const [data, setData] = useState<AdminCircle | null>(null);
	const [error, setError] = useState("");
	const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || "light");
	const [flash, setFlash] = useFlash();

	const load = useCallback(() => {
		api.admin(token).then(
			(d) => {
				setData(d);
				store.set(ADMIN_KEY, token);
			},
			(e: Error) => setError(e.message),
		);
	}, [token]);

	useEffect(() => {
		load();
		const t = setInterval(load, 30_000);
		return () => clearInterval(t);
	}, [load]);

	useEffect(() => {
		history.replaceState(null, "", `${location.pathname}${location.search}#${tab}`);
		window.scrollTo(0, 0);
	}, [tab]);

	if (error && !data)
		return (
			<div className="pl-page">
				<ErrorNote error={error} />
				<a href="/porchlight">Back to Porchlight</a>
			</div>
		);
	if (!data) return <Spinner />;

	if (away) return <StepAwayOnly token={token} data={data} />;

	const isNew = new URLSearchParams(location.search).has("new");

	return (
		<div className="pl-page pl-page--app">
			<header className="pl-topbar">
				<a href="/porchlight" className="pl-wordmark">
					Porchlight
				</a>
				<span className="pl-topbar__who">
					{data.grieverName}, for {data.lovedOneName}
				</span>
			</header>
			<nav className="pl-tabs" aria-label="Sections">
				{TABS.map((t) => (
					<button
						key={t.id}
						className={`pl-tab ${tab === t.id ? "pl-tab--on" : ""}`}
						aria-current={tab === t.id ? "page" : undefined}
						onClick={() => setTab(t.id)}
					>
						{t.label}
					</button>
				))}
			</nav>
			{isNew && tab === "light" && (
				<div className="pl-card pl-card--welcome">
					<h2>Your porch light is ready</h2>
					<p>
						This page is your private key. <strong>Bookmark it</strong> or add it to your home screen. Next: set your
						light, then share your circle link from the <button className="pl-link" onClick={() => setTab("circle")}>Circle</button> tab.
					</p>
				</div>
			)}
			{tab === "light" && <LightTab token={token} data={data} setData={setData} flash={setFlash} goCard={() => setTab("card")} />}
			{tab === "card" && <CardTab token={token} data={data} setData={setData} flash={setFlash} />}
			{tab === "circle" && <CircleTab token={token} data={data} setData={setData} flash={setFlash} />}
			{tab === "timeline" && <TimelineTab token={token} data={data} />}
			{tab === "work" && <WorkTab token={token} data={data} setData={setData} flash={setFlash} />}
			{tab === "settings" && <SettingsTab token={token} data={data} setData={setData} flash={setFlash} />}
			<Flash msg={flash} />
		</div>
	);
}

interface TabProps {
	token: string;
	data: AdminCircle;
	setData: (d: AdminCircle) => void;
	flash: (m: string) => void;
}

// ---------- Light ----------

function LightTab({ token, data, setData, flash, goCard }: TabProps & { goCard: () => void }) {
	const [notify, setNotify] = useState(() => store.get(NOTIFY_PREF) !== "0");
	const [note, setNote] = useState(data.lightNote);
	const [showNote, setShowNote] = useState(Boolean(data.lightNote));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [groupsDismissed, setGroupsDismissed] = useState(() => store.get("porchlight:groups-dismissed") === "1");

	async function choose(light: Light) {
		setBusy(true);
		setError("");
		try {
			const d = await api.setLight(token, light, showNote ? note : "", !notify);
			setData(d);
			flash(notify && data.circleSize ? "Light set. Your circle will hear in a couple of minutes." : "Light set.");
		} catch (e) {
			setError((e as Error).message);
		}
		setBusy(false);
	}

	const showGroups = (data.daysSinceLoss ?? 0) >= 90 && !groupsDismissed;

	return (
		<>
			<section className="pl-card pl-lightpanel">
				<Lamp light={data.light} size={110} />
				<h2 className="pl-lightpanel__title">How would you like support today?</h2>
				<div className="pl-lights">
					{(Object.keys(LIGHTS) as Light[]).map((l) => (
						<button
							key={l}
							className={`pl-lightbtn pl-lightbtn--${l} ${data.light === l ? "pl-lightbtn--on" : ""}`}
							aria-pressed={data.light === l}
							disabled={busy}
							onClick={() => choose(l)}
						>
							<span className="pl-lightbtn__label">
								{LIGHTS[l].emoji} {LIGHTS[l].label}
							</span>
							<span className="pl-lightbtn__meaning">{LIGHTS[l].meaning}</span>
						</button>
					))}
				</div>
				<ErrorNote error={error} />
				{data.light === "off" && (
					<p className="pl-reassure">
						Turning your light off is always okay. Nobody is told why, and nobody needs to hear from you.
					</p>
				)}
				<label className="pl-toggle">
					<input
						type="checkbox"
						checked={notify}
						onChange={(e) => {
							setNotify(e.target.checked);
							store.set(NOTIFY_PREF, e.target.checked ? "1" : "0");
						}}
					/>
					<span>Text my circle when I change it</span>
				</label>
				<p className="pl-hint pl-small">
					{notify
						? "Texts wait two minutes, so changing your mind doesn't send extra messages."
						: "Changes will show on your circle's page quietly, with no texts."}
					{data.pendingNotify && notify ? " A text is waiting to go out." : ""}
				</p>
				{showNote ? (
					<label className="pl-field">
						<span>
							A few words <em>(optional, shown with your next change)</em>
						</span>
						<input maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Rough morning. Evenings are better." />
					</label>
				) : (
					<button className="pl-link" onClick={() => setShowNote(true)}>
						Add a few words (optional)
					</button>
				)}
			</section>

			{showGroups && (
				<section className="pl-card pl-card--soft">
					<h2>When you're ready</h2>
					<p>
						Some people find it helps to sit with others who understand. There are support groups near you, whenever
						you want them.
					</p>
					<div className="pl-row">
						<a className="pl-btn" href={data.supportDirectoryUrl} target="_blank" rel="noreferrer">
							Find a group
						</a>
						<button
							className="pl-btn pl-btn--ghost"
							onClick={() => {
								store.set("porchlight:groups-dismissed", "1");
								setGroupsDismissed(true);
							}}
						>
							Not now
						</button>
					</div>
				</section>
			)}

			<section className="pl-card">
				<h2>Your circle sees</h2>
				<p>
					{data.circleSize === 0
						? "No one has joined yet."
						: `${data.circleSize} ${data.circleSize === 1 ? "person" : "people"} in your circle.`}{" "}
					They see your light and your card. Never when you last opened the app.
				</p>
				<button className="pl-btn pl-btn--ghost" onClick={goCard}>
					Update my card
				</button>
			</section>
		</>
	);
}

// ---------- Card ----------

const SAY_NAME = [
	{ id: "yes", label: "Please say their name" },
	{ id: "not_yet", label: "Not yet, please" },
] as const;
const MEALS = [
	{ id: "yes", label: "Yes, please" },
	{ id: "no", label: "No, thank you" },
] as const;

function CardTab({ token, data, setData, flash }: TabProps) {
	const [card, setCard] = useState<Card>(data.card);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const dirty = JSON.stringify(card) !== JSON.stringify(data.card);
	const up = (patch: Partial<Card>) => setCard((c) => ({ ...c, ...patch }));

	async function save() {
		setBusy(true);
		setError("");
		try {
			const d = await api.saveCard(token, card);
			setData(d);
			setCard(d.card);
			flash("Card saved. Your circle sees it now.");
		} catch (e) {
			setError((e as Error).message);
		}
		setBusy(false);
	}

	return (
		<>
			<p className="pl-intro">Fill in only what you want. Change it anytime; what you need will change too.</p>
			<Section title={`Saying ${data.lovedOneName}'s name`}>
				<Segmented name="Say their name" options={SAY_NAME} value={card.sayName} onChange={(v) => up({ sayName: v })} />
			</Section>
			<Section title="Meals">
				<Segmented name="Meals" options={MEALS} value={card.meals} onChange={(v) => up({ meals: v })} />
				{card.meals === "yes" && (
					<label className="pl-field">
						<span>Allergies or preferences</span>
						<input maxLength={200} value={card.allergies} onChange={(e) => up({ allergies: e.target.value })} placeholder="No nuts. Kids love pasta." />
					</label>
				)}
			</Section>
			<Section title="What I could use help with">
				<Chips
					options={HELP_OPTIONS}
					value={card.help}
					onChange={(v) => up({ help: v.includes("nothing") && !card.help.includes("nothing") ? ["nothing"] : v.filter((x) => x !== "nothing" || v.length === 1) })}
				/>
			</Section>
			<Section title="Days that will be hard" hint="Porchlight texts your circle the day before, with gentle advice that follows your light.">
				<HardDates lovedOne={data.lovedOneName} griever={data.grieverName} dates={card.hardDates} onChange={(hardDates) => up({ hardDates })} />
			</Section>
			<Section title="Anything else (optional)">
				<textarea maxLength={400} rows={3} value={card.note} onChange={(e) => up({ note: e.target.value })} placeholder="Walks help. Please don't ask how I'm doing; ask what I had for lunch." />
			</Section>
			<ErrorNote error={error} />
			<div className="pl-savebar">
				<button className="pl-btn pl-btn--primary pl-btn--block" disabled={!dirty || busy} onClick={save}>
					{busy ? "Saving…" : dirty ? "Save my card" : "Saved"}
				</button>
			</div>
		</>
	);
}

function HardDates({
	lovedOne,
	griever,
	dates,
	onChange,
}: {
	lovedOne: string;
	griever: string;
	dates: HardDate[];
	onChange: (d: HardDate[]) => void;
}) {
	const [label, setLabel] = useState("");
	const [date, setDate] = useState("");
	const [yearly, setYearly] = useState(true);

	const presets: { label: string; date?: string; yearly: boolean }[] = [
		{ label: `${lovedOne}'s birthday`, yearly: true },
		{ label: `${griever} and ${lovedOne}'s anniversary`, yearly: true },
		{ label: "Thanksgiving", date: upcomingHoliday("thanksgiving"), yearly: false },
		{ label: "Christmas", date: nextFixed("12-25"), yearly: true },
		{ label: "New Year's Eve", date: nextFixed("12-31"), yearly: true },
		{ label: "Mother's Day", date: upcomingHoliday("mothers"), yearly: false },
		{ label: "Father's Day", date: upcomingHoliday("fathers"), yearly: false },
	].filter((p) => !dates.some((d) => d.label === p.label));

	const add = () => {
		if (!label.trim() || !date) return;
		onChange([...dates, { id: Math.random().toString(36).slice(2, 10), label: label.trim(), date, yearly }]);
		setLabel("");
		setDate("");
		setYearly(true);
	};

	const sorted = [...dates].sort((a, b) => (nextOccurrence(a) ?? "9999").localeCompare(nextOccurrence(b) ?? "9999"));

	return (
		<div>
			{sorted.length > 0 && (
				<ul className="pl-dates">
					{sorted.map((d) => {
						const next = nextOccurrence(d);
						return (
							<li key={d.id}>
								<span>
									<strong>{d.label}</strong>
									<span className="pl-muted">
										{" "}
										· {next ? prettyDate(next) : prettyDate(d.date)}
										{d.yearly ? " · every year" : next ? "" : " · passed"}
									</span>
								</span>
								<button className="pl-x" aria-label={`Remove ${d.label}`} onClick={() => onChange(dates.filter((x) => x.id !== d.id))}>
									×
								</button>
							</li>
						);
					})}
				</ul>
			)}
			<div className="pl-chips">
				{presets.map((p) => (
					<button
						type="button"
						key={p.label}
						className="pl-chip"
						onClick={() => {
							setLabel(p.label);
							setDate(p.date ?? "");
							setYearly(p.yearly);
						}}
					>
						+ {p.label}
					</button>
				))}
			</div>
			<div className="pl-adddate">
				<input aria-label="What day is it" placeholder="What day is it?" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
				<input aria-label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
				<label className="pl-toggle pl-small">
					<input type="checkbox" checked={yearly} onChange={(e) => setYearly(e.target.checked)} />
					<span>Every year</span>
				</label>
				<button type="button" className="pl-btn" disabled={!label.trim() || !date} onClick={add}>
					Add
				</button>
			</div>
			<p className="pl-hint pl-small">
				Write it the way your circle would say it, like “{lovedOne}'s birthday”. Remember to save your card.
			</p>
		</div>
	);
}

// ---------- Circle ----------

function CircleTab({ token, data, setData, flash }: TabProps) {
	const link = `${location.origin}/porchlight/c/${data.joinCode}`;
	const [confirming, setConfirming] = useState<string | null>(null);

	const share = async () => {
		if (navigator.share) {
			try {
				await navigator.share({
					title: `${data.grieverName}'s Porchlight`,
					text: `${data.grieverName} is using Porchlight to let people know what kind of support helps right now. Join here:`,
					url: link,
				});
				return;
			} catch {
				/* cancelled, fall through to copy */
			}
		}
		if (await copyText(link)) flash("Link copied.");
	};

	async function remove(id: string) {
		setData(await api.removeSupporter(token, id));
		setConfirming(null);
		flash("Removed. They won't get any more texts.");
	}

	return (
		<>
			<Section title="Invite your circle" hint="Friends join with their phone number. No app, no account.">
				<div className="pl-invite">
					<Qr value={link} size={168} />
					<div className="pl-invite__actions">
						<code className="pl-linkbox">{link.replace(/^https?:\/\//, "")}</code>
						<button className="pl-btn pl-btn--primary" onClick={share}>
							Share link
						</button>
						<button
							className="pl-btn"
							onClick={async () => {
								if (await copyText(link)) flash("Link copied.");
							}}
						>
							Copy link
						</button>
						<a className="pl-btn pl-btn--ghost" href={`/porchlight/print/${data.joinCode}`} target="_blank" rel="noreferrer">
							Print cards
						</a>
					</div>
				</div>
				<p className="pl-hint pl-small">
					Tip: ask one close friend to share it for you, at the service or in the family group chat.
				</p>
			</Section>

			<Section title={`In your circle (${data.supporters.filter((s) => s.active).length})`}>
				{data.supporters.length === 0 ? (
					<p className="pl-muted">No one yet. When people join, they'll show up here.</p>
				) : (
					<ul className="pl-people">
						{data.supporters.map((s) => (
							<li key={s.id} className={s.active ? "" : "pl-muted"}>
								<span>
									<strong>{s.name}</strong>
									{s.relationship && <span className="pl-muted"> · {s.relationship}</span>}
									{!s.active && " · left"}
								</span>
								{confirming === s.id ? (
									<span className="pl-row">
										<button className="pl-btn pl-btn--small" onClick={() => remove(s.id)}>
											Remove
										</button>
										<button className="pl-btn pl-btn--small pl-btn--ghost" onClick={() => setConfirming(null)}>
											Keep
										</button>
									</span>
								) : (
									<button className="pl-link" onClick={() => setConfirming(s.id)}>
										Remove
									</button>
								)}
							</li>
						))}
					</ul>
				)}
				<p className="pl-hint pl-small">Removing someone is silent. They aren't told.</p>
			</Section>

			<Outbox data={data} />
		</>
	);
}

function Outbox({ data }: { data: AdminCircle }) {
	const [open, setOpen] = useState(!data.smsLive);
	return (
		<Section title="Texts Porchlight has sent">
			{!data.smsLive && (
				<p className="pl-banner">
					<strong>Demo mode.</strong> Texts are recorded here but not actually sent. Add Twilio credentials to the
					Worker to send real SMS.
				</p>
			)}
			<button className="pl-link" onClick={() => setOpen((o) => !o)}>
				{open ? "Hide" : `Show (${data.outbox.length})`}
			</button>
			{open &&
				(data.outbox.length === 0 ? (
					<p className="pl-muted">Nothing yet.</p>
				) : (
					<ul className="pl-outbox">
						{data.outbox.map((m) => (
							<li key={m.id}>
								<div className="pl-outbox__meta">
									<span>
										To <strong>{m.recipientName}</strong> · {kindLabel(m.kind)}
									</span>
									<span className={`pl-status pl-status--${m.status}`}>
										{!m.phone ? "in app" : m.status === "demo" ? "demo" : m.status}
									</span>
								</div>
								<p className="pl-sms">{m.body}</p>
								<div className="pl-muted pl-small">
									{timeAgo(m.createdAt)}
									{m.error && ` · ${m.error}`}
								</div>
							</li>
						))}
					</ul>
				))}
		</Section>
	);
}

function kindLabel(kind: string): string {
	if (kind.startsWith("light-")) return "light changed";
	if (kind.startsWith("hard-date-eve")) return "hard day tomorrow";
	if (kind.startsWith("hard-date-day")) return "hard day";
	return (
		{
			welcome: "welcome",
			"week-6": "week 6 nudge",
			"month-3": "three months",
			"month-3-groups": "support groups",
			"year-1-week-before": "one year, a week out",
			"year-1-eve": "one year tomorrow",
			"year-1-day": "one year",
			"step-away": "step away",
		}[kind] ?? kind
	);
}

// ---------- Timeline ----------

function TimelineTab({ token, data }: { token: string; data: AdminCircle }) {
	const today = todayIso();
	const milestones: { date: string; label: string }[] = [];
	for (const hd of data.card.hardDates) {
		const next = nextOccurrence(hd);
		if (next) milestones.push({ date: addDays(next, -1), label: `Day before ${hd.label}` });
		if (next) milestones.push({ date: next, label: hd.label });
	}
	if (data.lossDate) {
		const add = (n: number, label: string) => {
			const d = addDays(data.lossDate, n);
			if (d >= today) milestones.push({ date: d, label });
		};
		add(42, "Week 6: the cliff");
		add(90, "Three months");
		add(358, "A week before one year");
		add(364, "Day before one year");
		add(365, "One year");
	}
	milestones.sort((a, b) => a.date.localeCompare(b.date));

	const [date, setDate] = useState(milestones[0]?.date ?? today);
	const [result, setResult] = useState<{ date: string; messages?: PlannedMessage[]; error?: string } | null>(null);
	const plan = result?.date === date ? (result.messages ?? []) : null;
	const error = result?.date === date ? (result.error ?? "") : "";

	useEffect(() => {
		api.preview(token, date).then(
			(r) => setResult({ date, messages: r.messages }),
			(e: Error) => setResult({ date, error: e.message }),
		);
	}, [token, date]);

	return (
		<>
			<p className="pl-intro">
				Porchlight expects the cliff instead of reacting to it. Here's what it will send, and when. Messages follow
				whatever your light is set to on the day.
			</p>
			<Section title="Coming up">
				{!data.lossDate && (
					<p className="pl-hint">
						Add the date {data.lovedOneName} died in Settings to see the week-6, three-month and one-year reminders.
					</p>
				)}
				{milestones.length === 0 ? (
					<p className="pl-muted">Add hard days to your card to see them here.</p>
				) : (
					<ul className="pl-timeline">
						{milestones.map((m) => (
							<li key={m.date + m.label}>
								<button className={`pl-timeline__item ${m.date === date ? "pl-timeline__item--on" : ""}`} onClick={() => setDate(m.date)}>
									<span className="pl-timeline__date">{prettyDate(m.date)}</span>
									<span>{m.label}</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</Section>
			<Section title="Preview any day">
				<input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
				<ErrorNote error={error} />
				{plan === null ? (
					<p className="pl-muted">Loading…</p>
				) : plan.length === 0 ? (
					<p className="pl-muted">Nothing scheduled for {prettyDate(date, { weekday: "long", month: "long", day: "numeric" })}.</p>
				) : (
					<ul className="pl-outbox">
						{plan.map((m, i) => (
							<li key={i}>
								<div className="pl-outbox__meta">
									<span>
										To <strong>{m.audience === "circle" ? "your circle" : "you"}</strong> · {kindLabel(m.kind)}
									</span>
								</div>
								<p className="pl-sms">{m.body}</p>
							</li>
						))}
					</ul>
				)}
				<p className="pl-hint pl-small">Scheduled texts go out in the morning, your time.</p>
			</Section>
		</>
	);
}

// ---------- Work ----------

const MENTION_OPTIONS = (Object.keys(WORK_MENTION) as WorkMention[]).map((id) => ({ id, label: WORK_MENTION[id] }));

function WorkTab({ token, data, setData, flash }: TabProps) {
	const [work, setWork] = useState<WorkCard>(data.work);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const dirty = JSON.stringify(work) !== JSON.stringify(data.work);
	const up = (p: Partial<WorkCard>) => setWork((w) => ({ ...w, ...p }));
	const link = `${location.origin}/porchlight/w/${data.workCode}`;

	async function save() {
		setBusy(true);
		setError("");
		try {
			const d = await api.saveWork(token, work);
			setData(d);
			setWork(d.work);
			flash("Work card saved.");
		} catch (e) {
			setError((e as Error).message);
		}
		setBusy(false);
	}

	return (
		<>
			<p className="pl-intro">
				Going back to work? Share a limited card with your manager and team, so they know whether to mention it and
				how. Your light, hard days and circle stay private.
			</p>
			{data.work.managerPhone && <StepAwayButton token={token} managerName={data.work.managerName} />}
			<Section title="Share with work">
				<label className="pl-toggle">
					<input type="checkbox" checked={work.enabled} onChange={(e) => up({ enabled: e.target.checked })} />
					<span>Share my work card</span>
				</label>
			</Section>
			<Section title="Should coworkers mention it?">
				<Segmented name="Mention" options={MENTION_OPTIONS} value={work.mention} onChange={(v) => up({ mention: v })} />
			</Section>
			<Section title="What helps at work">
				<Chips options={WORK_HELPS} value={work.helps} onChange={(v) => up({ helps: v })} />
				<label className="pl-field">
					<span>
						A note for the team <em>(optional)</em>
					</span>
					<textarea rows={2} maxLength={300} value={work.note} onChange={(e) => up({ note: e.target.value })} />
				</label>
			</Section>
			<Section title="Step away button" hint="One tap texts your manager “I need 15 minutes.” No explanation, no conversation.">
				<label className="pl-field">
					<span>Manager's first name</span>
					<input maxLength={60} value={work.managerName} onChange={(e) => up({ managerName: e.target.value })} />
				</label>
				<label className="pl-field">
					<span>Manager's mobile</span>
					<input type="tel" inputMode="tel" value={work.managerPhone} onChange={(e) => up({ managerPhone: e.target.value })} />
				</label>
			</Section>
			<ErrorNote error={error} />
			<div className="pl-savebar">
				<button className="pl-btn pl-btn--primary pl-btn--block" disabled={!dirty || busy} onClick={save}>
					{busy ? "Saving…" : dirty ? "Save work card" : "Saved"}
				</button>
			</div>
			{data.work.enabled && (
				<Section title="Work link">
					<code className="pl-linkbox">{link.replace(/^https?:\/\//, "")}</code>
					<div className="pl-row">
						<button
							className="pl-btn"
							onClick={async () => {
								if (await copyText(link)) flash("Link copied.");
							}}
						>
							Copy link
						</button>
						<a className="pl-btn pl-btn--ghost" href={link} target="_blank" rel="noreferrer">
							Preview
						</a>
					</div>
				</Section>
			)}
			{data.work.managerPhone && (
				<p className="pl-hint pl-small">
					For a discreet shortcut, bookmark{" "}
					<a href={`/porchlight/g/${token}/away`}>this step-away page</a> on your phone's home screen.
				</p>
			)}
		</>
	);
}

function StepAwayButton({ token, managerName }: { token: string; managerName: string }) {
	const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
	const [error, setError] = useState("");
	async function go() {
		setState("busy");
		setError("");
		try {
			await api.stepAway(token);
			setState("sent");
			setTimeout(() => setState("idle"), 60_000);
		} catch (e) {
			setError((e as Error).message);
			setState("idle");
		}
	}
	return (
		<div className="pl-stepaway">
			<button className="pl-stepaway__btn" disabled={state !== "idle"} onClick={go}>
				{state === "sent" ? "Sent. Take your time." : state === "busy" ? "…" : "Step away"}
			</button>
			<p className="pl-hint pl-small">
				{state === "sent"
					? `${managerName || "Your manager"} knows you need 15 minutes. Nothing else was said.`
					: `Quietly tells ${managerName || "your manager"} you need 15 minutes.`}
			</p>
			<ErrorNote error={error} />
		</div>
	);
}

function StepAwayOnly({ token, data }: { token: string; data: AdminCircle }) {
	return (
		<div className="pl-page pl-away">
			{data.work.managerPhone ? (
				<StepAwayButton token={token} managerName={data.work.managerName} />
			) : (
				<p>
					Add your manager's number in <a href={`/porchlight/g/${token}#work`}>Work mode</a> first.
				</p>
			)}
		</div>
	);
}

// ---------- Settings ----------

function SettingsTab({ token, data, setData, flash }: TabProps) {
	const [f, setF] = useState({
		grieverName: data.grieverName,
		lovedOneName: data.lovedOneName,
		relationship: data.relationship,
		lossDate: data.lossDate,
		grieverPhone: data.grieverPhone,
		sponsor: data.sponsor,
		timezone: data.timezone,
	});
	const [error, setError] = useState("");
	const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

	async function save() {
		setError("");
		try {
			setData(await api.saveProfile(token, f));
			flash("Saved.");
		} catch (e) {
			setError((e as Error).message);
		}
	}

	return (
		<>
			<Section title="About">
				<label className="pl-field">
					<span>Your first name</span>
					<input maxLength={40} value={f.grieverName} onChange={set("grieverName")} />
				</label>
				<label className="pl-field">
					<span>Their name</span>
					<input maxLength={40} value={f.lovedOneName} onChange={set("lovedOneName")} />
				</label>
				<label className="pl-field">
					<span>They were your…</span>
					<input maxLength={40} value={f.relationship} onChange={set("relationship")} />
				</label>
				<label className="pl-field">
					<span>Date they died</span>
					<input type="date" value={f.lossDate} onChange={set("lossDate")} />
				</label>
				<label className="pl-field">
					<span>Your mobile (for notes just for you)</span>
					<input type="tel" value={f.grieverPhone} onChange={set("grieverPhone")} />
				</label>
				<label className="pl-field">
					<span>Shared by (funeral home or organization)</span>
					<input maxLength={80} value={f.sponsor} onChange={set("sponsor")} />
				</label>
				<label className="pl-field">
					<span>Time zone</span>
					<input value={f.timezone} onChange={set("timezone")} />
				</label>
				<ErrorNote error={error} />
				<button className="pl-btn pl-btn--primary" onClick={save}>
					Save
				</button>
			</Section>
			<Section title="Your private link">
				<p>
					This page's address is your key. Anyone with it can change your light, so keep it to yourself. Bookmark it to
					find it again.
				</p>
				<button
					className="pl-btn"
					onClick={async () => {
						if (await copyText(location.origin + location.pathname)) flash("Private link copied.");
					}}
				>
					Copy my private link
				</button>
			</Section>
		</>
	);
}
