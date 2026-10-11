import { type FormEvent, useState } from "react";
import { type Activity, type Entry, type ImportantDate, type LovedOne, calls } from "../shared";
import Archive from "./Archive";
import Book from "./Book";
import { Letter, Memory } from "./Compose";
import { CarryPrompt, EntryCard } from "./Entries";
import Forward from "./Forward";
import Recorder from "./Recorder";
import Settings, { LovedOneForm } from "./Settings";
import Stories from "./Stories";
import { BASE, type Me, MONTHS, api, day, daysUntil, listenAudioUrl, mediaUrl, message, store, useLoad } from "./lib";
import { Card, CrisisPanel, Notice } from "./ui";
import "./uc.css";

type Section = "home" | "record" | "write" | "memory" | "archive" | "forward" | "stories" | "book" | "settings";
type Collection = { id: string; name: string; role: string };
type Home = { recent: Entry[]; drafts: Entry[]; activities: Activity[]; dates: ImportantDate[]; books: { id: string; title: string }[] };

const NAV: [Section, string][] = [
	["home", "Home"],
	["archive", "Living Archive"],
	["forward", "Carry It Forward"],
	["stories", "Our Stories"],
	["book", "Legacy Book"],
	["settings", "Settings"],
];

const path = () => window.location.pathname.slice(BASE.length).replace(/\/+$/, "");

function AuthForm({ onDone, startWith }: { onDone: () => void; startWith: "signup" | "login" }) {
	const [mode, setMode] = useState(startWith);
	const [form, setForm] = useState({ name: "", email: "", password: "" });
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		try {
			await api("POST", `/auth/${mode}`, form);
			onDone();
		} catch (err) {
			setError(message(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card title={mode === "signup" ? "Create your private space" : "Welcome back"}>
			<form className="uc-form" onSubmit={submit}>
				{mode === "signup" && (
					<label className="uc-field">
						Your name
						<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" required maxLength={80} />
					</label>
				)}
				<label className="uc-field">
					Email
					<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" required />
				</label>
				<label className="uc-field">
					Password
					<input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={8} required />
				</label>
				{error && <p className="uc-error">{error}</p>}
				<button type="submit" className="uc-btn uc-primary" disabled={busy}>
					{mode === "signup" ? "Create account" : "Sign in"}
				</button>
			</form>
			<button
				type="button"
				className="uc-link"
				onClick={() => {
					setError("");
					setMode(mode === "signup" ? "login" : "signup");
				}}
			>
				{mode === "signup" ? "I already have an account" : "I need to create an account"}
			</button>
		</Card>
	);
}

function Landing({ onDone }: { onDone: () => void }) {
	const [step, setStep] = useState<"" | "start" | "how">("");
	return (
		<>
			<section className="uc-hero">
				<h1>Unfinished Conversations</h1>
				<p className="uc-tagline">Some things still deserve to be said.</p>
				<p>Life keeps happening. There are still stories to tell, moments to share, and things you wish they could hear. This is a place for all of them.</p>
				<div className="uc-row uc-center">
					<button type="button" className="uc-btn uc-primary" onClick={() => setStep("start")}>
						Start a Conversation
					</button>
					<button type="button" className="uc-btn" onClick={() => setStep(step === "how" ? "" : "how")}>
						Learn How It Works
					</button>
				</div>
			</section>
			{step === "how" && (
				<Card title="How it works">
					<dl className="uc-how">
						<dt>Say it</dt>
						<dd>Record a message in your own voice, write a letter, or save a photograph with the story behind it. Whenever something happens you wish they could hear.</dd>
						<dt>Keep it</dt>
						<dd>Everything gathers into a private archive you can search, listen back to, and download. It is yours, and only yours, unless you choose to share something.</dd>
						<dt>Carry it forward</dt>
						<dd>If you'd like, a memory can become something you do: a recipe written down, a tradition kept, a story told to someone who needs to hear it. Never an obligation.</dd>
						<dt>Share it, if you want</dt>
						<dd>Invite family to add their own memories of the same person, and gather the ones that matter most into a book.</dd>
					</dl>
					<p className="uc-quiet">This is a place to speak to someone you miss. It will never pretend to be them, speak for them, or imitate their voice.</p>
					<button type="button" className="uc-btn uc-primary" onClick={() => setStep("start")}>
						Start a Conversation
					</button>
				</Card>
			)}
			{step === "start" && <AuthForm startWith="signup" onDone={onDone} />}
			<p className="uc-quiet uc-center">You may not have gotten to say everything. But your love still has somewhere to go.</p>
		</>
	);
}

type Invite = { role: string; name: string; collectionName: string; about: string; inviterName: string };

function Join({ token, me, reload }: { token: string; me: Me; reload: () => Promise<void> }) {
	const { data, error } = useLoad<{ invite: Invite }>(`/invites/${token}`);
	const [failure, setFailure] = useState("");
	const leave = () => {
		window.history.replaceState(null, "", BASE);
		void reload();
	};
	if (error) {
		return (
			<Card title="This invitation isn't active">
				<p>It may have been used already or withdrawn.</p>
				<button type="button" className="uc-btn" onClick={leave}>
					Continue
				</button>
			</Card>
		);
	}
	if (!data) return <p className="uc-quiet">Loading…</p>;
	const { invite } = data;
	return (
		<>
			<Card title={`You're invited to ${invite.collectionName}`}>
				<p>
					{invite.inviterName} is gathering memories{invite.about ? ` of ${invite.about}` : ""} from the people who knew them, and would like yours to be among them.{" "}
					{invite.role === "viewer" ? "You'll be able to read and listen." : "You can read, listen, and add stories, photographs and recordings of your own."}
				</p>
				{failure && <p className="uc-error">{failure}</p>}
				{me.user && (
					<div className="uc-row">
						<button type="button" className="uc-btn uc-primary" onClick={() => api("POST", `/invites/${token}/accept`).then(leave, (err) => setFailure(message(err)))}>
							Join the collection
						</button>
						<button type="button" className="uc-btn" onClick={leave}>
							Not now
						</button>
					</div>
				)}
			</Card>
			{!me.user && <AuthForm startWith="signup" onDone={reload} />}
		</>
	);
}

/** The page behind a Legacy Book's QR code: one recording, and nothing else. */
function Listen({ token }: { token: string }) {
	const { data, error } = useLoad<{ title: string; recordedAt: string; lovedOneName: string; from: string }>(`/listen/${token}`);
	if (error) return <Card title="This recording is no longer available">The person who shared it has switched this link off.</Card>;
	if (!data) return <p className="uc-quiet">Loading…</p>;
	return (
		<Card title={data.title || `A message for ${data.lovedOneName}`} className="uc-listen">
			<p className="uc-quiet">
				Recorded by {data.from} on {day(data.recordedAt)}, for {data.lovedOneName}.
			</p>
			<audio controls src={listenAudioUrl(token)} className="uc-audio" />
		</Card>
	);
}

function HomeView({ me, lovedOne, collections, go, resume, home, reload }: { me: Me; lovedOne: LovedOne; collections: Collection[]; go: (s: Section) => void; resume: (e: Entry) => void; home: Home | null; reload: () => void }) {
	const about = calls(lovedOne);
	// Counted in the browser so "today" means the person's today, not the server's.
	const near = me.prefs.reminders ? (home?.dates.map((d) => ({ ...d, daysAway: daysUntil(d.month, d.day) })).filter((d) => d.daysAway <= 14) ?? []) : [];
	return (
		<>
			<section className="uc-welcome">
				{lovedOne.photoAssetId && <img className="uc-portrait" src={mediaUrl(lovedOne.photoAssetId)} alt={lovedOne.name} />}
				<p className="uc-label">Your Conversations with {about}</p>
				<h1>What's something you wish you could tell {about} today?</h1>
				<div className="uc-actions">
					<button type="button" className="uc-action uc-action-record" onClick={() => go("record")}>
						<span className="uc-dot" aria-hidden="true" />
						Record a Message
					</button>
					<button type="button" className="uc-action" onClick={() => go("write")}>
						Write a Letter
					</button>
					<button type="button" className="uc-action" onClick={() => go("memory")}>
						Share a Memory
					</button>
				</div>
			</section>

			{near.map((d) => (
				<p key={d.id} className="uc-notice">
					{d.label} is {d.daysAway === 0 ? "today" : `on ${MONTHS[d.month - 1]} ${d.day}`}.
				</p>
			))}

			{!!home?.drafts.length && (
				<section className="uc-month">
					<h2 className="uc-month-name">Letters you started</h2>
					{home.drafts.map((e) => (
						<EntryCard key={e.id} entry={e} about={about} ai={me.prefs.ai} collections={collections} onChange={reload} onResume={resume} />
					))}
				</section>
			)}

			{!!home?.recent.length && (
				<section className="uc-month">
					<h2 className="uc-month-name">Recent conversations</h2>
					{home.recent.map((e) => (
						<EntryCard key={e.id} entry={e} about={about} ai={me.prefs.ai} collections={collections} onChange={reload} />
					))}
					<button type="button" className="uc-link" onClick={() => go("archive")}>
						Open your Living Archive
					</button>
				</section>
			)}

			{home && !home.recent.length && !home.drafts.length && (
				<Card>
					<p className="uc-quiet">Nothing has been said here yet. There's no right first thing; start anywhere.</p>
				</Card>
			)}

			<div className="uc-tiles">
				<button type="button" className="uc-tile" onClick={() => go("forward")}>
					<strong>Carry It Forward</strong>
					<span>{home?.activities.length ? home.activities.map((a) => a.description).slice(0, 2).join(" · ") : "Ways to keep their influence alive, if and when you'd like."}</span>
				</button>
				<button type="button" className="uc-tile" onClick={() => go("stories")}>
					<strong>Our Stories</strong>
					<span>{collections.length ? collections.map((k) => k.name).join(" · ") : "Gather memories from family and friends."}</span>
				</button>
				<button type="button" className="uc-tile" onClick={() => go("book")}>
					<strong>Legacy Book</strong>
					<span>{home?.books.length ? home.books.map((b) => b.title).join(" · ") : "Turn chosen memories into a keepsake."}</span>
				</button>
			</div>
		</>
	);
}

function App({ me, reloadMe }: { me: Me; reloadMe: () => Promise<void> }) {
	const [lovedId, setLovedId] = useState(() => store.get("uc-loved") ?? "");
	const [section, setSection] = useState<Section>("home");
	const [adding, setAdding] = useState(false);
	const [draft, setDraft] = useState<Entry | undefined>();
	const [saved, setSaved] = useState<{ entry: Entry | null; crisis: boolean; note: string } | null>(null);
	const [more, setMore] = useState(false);

	const lovedOne = me.lovedOnes.find((l) => l.id === lovedId) ?? me.lovedOnes[0];
	const home = useLoad<Home>(lovedOne ? `/loved-ones/${lovedOne.id}/home` : null);
	const collections = useLoad<{ collections: Collection[] }>("/collections");
	const shared = collections.data?.collections ?? [];

	const choose = (id: string) => {
		store.set("uc-loved", id);
		setLovedId(id);
		setSection("home");
	};

	if (!lovedOne || adding) {
		return (
			<Card title="Who would you like to remember?" intro="Only their name is needed. Everything else can wait, or be left out.">
				<LovedOneForm
					onCancel={lovedOne ? () => setAdding(false) : undefined}
					onSaved={async (id) => {
						await reloadMe();
						setAdding(false);
						choose(id);
					}}
				/>
			</Card>
		);
	}

	const about = calls(lovedOne);
	const go = (next: Section) => {
		setSaved(null);
		setDraft(undefined);
		setMore(false);
		setSection(next);
		window.scrollTo(0, 0);
	};

	/** After anything is saved: back home, with the carry-forward question if AI is on, or the offer to turn it on the first time. */
	const afterSave = async (id: string, crisis: boolean) => {
		await home.reload();
		const { entries } = await api<{ entries: Entry[] }>("GET", `/loved-ones/${lovedOne.id}/entries?q=`);
		setSaved({ entry: entries.find((e) => e.id === id) ?? null, crisis, note: "Saved. It's in your Living Archive, private to you." });
		setDraft(undefined);
		setSection("home");
		window.scrollTo(0, 0);
	};

	const askAboutAi = !me.prefs.ai && !store.get("uc-ai-asked");

	return (
		<>
			<nav className="uc-nav" aria-label="Sections">
				{NAV.map(([id, label]) => (
					<button key={id} type="button" className={section === id ? "uc-nav-item uc-nav-on" : "uc-nav-item"} onClick={() => go(id)}>
						{label}
					</button>
				))}
			</nav>

			{me.lovedOnes.length > 1 && (
				<label className="uc-switch">
					<span className="uc-quiet">Conversations with</span>
					<select value={lovedOne.id} onChange={(e) => choose(e.target.value)}>
						{me.lovedOnes.map((l) => (
							<option key={l.id} value={l.id}>
								{calls(l)}
							</option>
						))}
					</select>
				</label>
			)}

			{me.invites.map((invite) => (
				<p key={invite.token} className="uc-notice">
					{invite.inviterName} has invited you to {invite.collectionName}.{" "}
					<a className="uc-link" href={`${BASE}/join/${invite.token}`}>
						See the invitation
					</a>
				</p>
			))}

			{section === "home" && saved && (
				<>
					{saved.crisis && <CrisisPanel onClose={() => setSaved({ ...saved, crisis: false })} />}
					<Notice text={saved.note} />
					{saved.entry && me.prefs.ai && (
						<CarryPrompt entry={saved.entry} about={about} ai onDone={(n) => setSaved({ entry: null, crisis: saved.crisis, note: n ? "Saved to Ways I'm Carrying Them Forward." : "Kept private." })} />
					)}
					{saved.entry && askAboutAi && (
						<Card title="Would you like a little help with your memories?" intro="Optional, and off unless you say yes.">
							<p>
								With your permission, each memory you save can be read by an assistant that suggests a category for it and a few gentle ways to carry it
								forward. It never speaks for {about}, and never changes what you saved. You can switch it off at any time in Settings.
							</p>
							<div className="uc-row">
								<button
									type="button"
									className="uc-btn uc-primary"
									onClick={async () => {
										store.set("uc-ai-asked", "1");
										await api("PATCH", "/me", { ai: true });
										await reloadMe();
									}}
								>
									Yes, turn it on
								</button>
								<button
									type="button"
									className="uc-btn"
									onClick={() => {
										store.set("uc-ai-asked", "1");
										setSaved({ ...saved, entry: null });
									}}
								>
									Not now
								</button>
							</div>
						</Card>
					)}
				</>
			)}

			{section === "home" && <HomeView me={me} lovedOne={lovedOne} collections={shared} go={go} resume={(e) => (setDraft(e), setSection("write"))} home={home.data} reload={home.reload} />}
			{section === "record" && (
				<Recorder
					about={about}
					onCancel={() => go("home")}
					onSave={async (rec) => {
						const res = await api<{ id: string; crisis: boolean }>("POST", "/entries", { lovedOneId: lovedOne.id, type: "voice", title: rec.title, transcript: rec.transcript, audioAssetId: rec.assetId });
						await afterSave(res.id, res.crisis);
					}}
				/>
			)}
			{section === "write" && <Letter key={draft?.id ?? "new"} lovedOneId={lovedOne.id} about={about} draft={draft} onSaved={(s) => afterSave(s.id, s.crisis)} onClose={() => (void home.reload(), go("home"))} />}
			{section === "memory" && <Memory lovedOneId={lovedOne.id} about={about} onSaved={(s) => afterSave(s.id, s.crisis)} onClose={() => go("home")} />}
			{section === "archive" && <Archive key={lovedOne.id} lovedOne={lovedOne} ai={me.prefs.ai} collections={shared} onResume={(e) => (setDraft(e), setSection("write"))} />}
			{section === "forward" && <Forward key={lovedOne.id} lovedOne={lovedOne} />}
			{section === "stories" && <Stories suggestedAbout={about} onChange={collections.reload} />}
			{section === "book" && <Book key={lovedOne.id} lovedOne={lovedOne} ai={me.prefs.ai} />}
			{section === "settings" && <Settings key={lovedOne.id} me={me} lovedOne={lovedOne} onChange={reloadMe} onAddLovedOne={() => setAdding(true)} />}

			{/* Phones: a short bar with recording always one tap away. */}
			<nav className="uc-bar" aria-label="Quick navigation">
				<button type="button" className={section === "home" ? "uc-bar-on" : ""} onClick={() => go("home")}>
					Home
				</button>
				<button type="button" className={section === "archive" ? "uc-bar-on" : ""} onClick={() => go("archive")}>
					Archive
				</button>
				<button type="button" className="uc-bar-record" onClick={() => go("record")} aria-label="Record a message">
					<span className="uc-dot" aria-hidden="true" />
				</button>
				<button type="button" className={section === "forward" ? "uc-bar-on" : ""} onClick={() => go("forward")}>
					Forward
				</button>
				<button type="button" className={more ? "uc-bar-on" : ""} onClick={() => setMore(!more)} aria-expanded={more}>
					More
				</button>
			</nav>
			{more && (
				<div className="uc-more">
					{NAV.slice(3).map(([id, label]) => (
						<button key={id} type="button" className="uc-btn" onClick={() => go(id)}>
							{label}
						</button>
					))}
				</div>
			)}
		</>
	);
}

export default function UnfinishedConversations() {
	const { data: me, error, reload } = useLoad<Me>("/me");
	const [route, setRoute] = useState(path);
	const join = route.match(/^\/join\/([a-f0-9]+)$/)?.[1];
	const listen = route.match(/^\/listen\/([a-f0-9]+)$/)?.[1];

	const refresh = async () => {
		setRoute(path());
		await reload();
	};

	return (
		<main className="uc">
			<header className="uc-top">
				<a className="uc-brand" href={BASE}>
					Unfinished Conversations
				</a>
				<span className="uc-quiet">a MyGriefGuide space</span>
			</header>
			{error && <Notice text={error} />}
			{listen ? (
				<Listen token={listen} />
			) : !me ? null : join ? (
				<Join token={join} me={me} reload={refresh} />
			) : me.user ? (
				<App me={me} reloadMe={reload} />
			) : (
				<Landing onDone={reload} />
			)}
			<footer className="uc-foot">
				<p>Your words here are private. This space will never speak for the person you miss.</p>
				<p>
					If you are thinking about harming yourself, call or text <a href="tel:988">988</a> in the US, or your local emergency number.
				</p>
			</footer>
		</main>
	);
}
