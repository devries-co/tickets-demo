import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { MAX_NOTE } from "../shared";
import { ConversationsArt, EarthArt, PorchArt, RippleArt, Wave } from "./art";
import "./labs.css";

type Concept = {
	id: string;
	name: string;
	promise: string;
	body: string;
	points: string[];
	who: string;
	preview: { href: string; label: string };
	art: ReactNode;
};

const CONCEPTS: Concept[] = [
	{
		id: "ripple",
		name: "Ripple",
		promise: "Because grief doesn't end when everyone else goes home.",
		body: "In the first weeks, help arrives all at once. Then it thins out, often just as the hardest stretch begins. Ripple helps the people who love you keep showing up, without you having to ask, explain, or manage anyone.",
		points: [
			"You check in privately, in a few taps. No one in your circle ever sees what you wrote.",
			"When some company would help, Ripple quietly asks one person in your circle. Only if you say so.",
			"They get a suggestion for what to do or say. Ripple never sends anything in their name.",
		],
		who: "For someone grieving, and the handful of people who want to be there for them.",
		preview: { href: "/ripple", label: "Open the early preview" },
		art: <RippleArt />,
	},
	{
		id: "porchlight",
		name: "Porchlight",
		promise: "One light that says how today is, so you don't have to.",
		body: "Answering “how are you?” a dozen times a day is its own kind of work. With Porchlight you set a single light, and everyone who cares about you can see it: on, dim, or off.",
		points: [
			"Set your light each day with one tap. No typing, no explaining. Off is always okay.",
			"Share one link or QR code. Friends and family follow by text, with no app to install.",
			"Your circle gets a gentle nudge before the hard days: an anniversary, week six, month three.",
		],
		who: "For someone grieving, their circle, and funeral homes who want to offer families something lasting.",
		preview: { href: "/porchlight", label: "Open the early preview" },
		art: <PorchArt />,
	},
	{
		id: "never-forgotten",
		name: "Never Forgotten",
		promise: "Every life leaves a mark on our world.",
		body: "An Earth made entirely of names. Each person who is remembered is given one place on the globe, and that place is theirs. Together the names draw the continents and the seas.",
		points: [
			"Add a name, a few words, and a photograph if you'd like.",
			"Every name is read by a person before it appears. Nothing is published automatically.",
			"Each memorial has its own link to share with family, on the days you want to visit.",
		],
		who: "For anyone who wants a name to be somewhere it can be found.",
		preview: { href: "/never-forgotten?demo=4000", label: "See it with sample names" },
		art: <EarthArt />,
	},
	{
		id: "unfinished-conversations",
		name: "Unfinished Conversations",
		promise: "Some things still deserve to be said.",
		body: "Life keeps happening, and there are still things you wish they could hear. This is a private place to keep talking to someone who has died: in your own voice, in a letter, or with a photograph and the story behind it.",
		points: [
			"Record a message, write a letter, or save a memory, whenever something happens you'd have told them.",
			"Everything gathers into an archive that is yours alone, unless you choose to share a story with family.",
			"It will never pretend to be them, speak for them, or imitate their voice.",
		],
		who: "For anyone who didn't get to say everything.",
		preview: { href: "/unfinished-conversations", label: "Open the early preview" },
		art: <ConversationsArt />,
	},
];

const ANSWER_LABELS: [string, string][] = [
	["yes", "Yes, it would have"],
	["maybe", "Maybe"],
	["no", "Not for me"],
];

type Saved = { id: string; answer: string };

// Remembering an answer is a convenience; the page works the same without storage.
function recall(concept: string): Saved | null {
	try {
		return JSON.parse(localStorage.getItem(`labs:${concept}`) ?? "null");
	} catch {
		return null;
	}
}
function remember(concept: string, saved: Saved) {
	try {
		localStorage.setItem(`labs:${concept}`, JSON.stringify(saved));
	} catch {
		// private window or blocked storage
	}
}

async function send(id: string | null, body: Record<string, string>) {
	const response = await fetch(id ? `/api/labs/responses/${id}` : "/api/labs/responses", {
		method: id ? "PUT" : "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
	if (!response.ok || !data.id) throw new Error(data.error ?? "That didn't go through. Please try again in a moment.");
	return data.id;
}

function Reaction({ concept }: { concept: Concept }) {
	const [saved, setSaved] = useState<Saved | null>(null);
	const [note, setNote] = useState("");
	const [email, setEmail] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [thanked, setThanked] = useState(false);

	useEffect(() => setSaved(recall(concept.id)), [concept.id]);

	async function save(answer: string, extra: Record<string, string> = {}) {
		setBusy(true);
		setError("");
		try {
			const id = await send(saved?.id ?? null, { concept: concept.id, answer, ...extra }).catch((err) => {
				// The remembered answer may be gone (previews get reset); start a new one.
				if (saved) return send(null, { concept: concept.id, answer, ...extra });
				throw err;
			});
			const next = { id, answer };
			setSaved(next);
			remember(concept.id, next);
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : "That didn't go through.");
			return false;
		} finally {
			setBusy(false);
		}
	}

	async function addNote(event: FormEvent) {
		event.preventDefault();
		if (saved && (await save(saved.answer, { note, email }))) setThanked(true);
	}

	return (
		<div className="labs-react">
			<p className="labs-ask" id={`ask-${concept.id}`}>
				Would this have helped you?
			</p>
			<div className="labs-answers" role="group" aria-labelledby={`ask-${concept.id}`}>
				{ANSWER_LABELS.map(([value, label]) => (
					<button
						key={value}
						type="button"
						className="labs-answer"
						aria-pressed={saved?.answer === value}
						disabled={busy}
						onClick={() => {
							setThanked(false);
							void save(value);
						}}
					>
						{label}
					</button>
				))}
			</div>
			{error && (
				<p className="labs-error" role="alert">
					{error}
				</p>
			)}
			{saved && !thanked && (
				<form className="labs-more" onSubmit={addNote}>
					<p className="labs-noted">Thank you. That's noted, and you can change it any time.</p>
					<label>
						<span>
							Anything you'd like us to know? <em>Optional</em>
						</span>
						<textarea
							rows={3}
							maxLength={MAX_NOTE}
							value={note}
							onChange={(e) => setNote(e.target.value)}
							placeholder={saved.answer === "no" ? "What would have helped instead?" : "What about it speaks to you? What's missing?"}
						/>
					</label>
					<label>
						<span>
							Your email, if you'd like to hear when {concept.name} is ready <em>Optional</em>
						</span>
						<input type="email" autoComplete="email" maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} />
					</label>
					<button className="labs-button" disabled={busy || (!note.trim() && !email.trim())}>
						Send
					</button>
				</form>
			)}
			{thanked && (
				<p className="labs-noted" role="status">
					Thank you for taking the time. We read every note.
				</p>
			)}
		</div>
	);
}

function KeepInTouch() {
	const [email, setEmail] = useState("");
	const [state, setState] = useState<"idle" | "busy" | "done">("idle");
	const [error, setError] = useState("");

	async function submit(event: FormEvent) {
		event.preventDefault();
		setState("busy");
		setError("");
		try {
			await send(null, { concept: "general", email });
			setState("done");
		} catch (err) {
			setError(err instanceof Error ? err.message : "That didn't go through.");
			setState("idle");
		}
	}

	if (state === "done") {
		return (
			<p className="labs-noted" role="status">
				Thank you. We'll write only when there's something real to tell you.
			</p>
		);
	}
	return (
		<form className="labs-touch" onSubmit={submit}>
			<label htmlFor="labs-email">Your email</label>
			<div>
				<input id="labs-email" type="email" required autoComplete="email" maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} />
				<button className="labs-button" disabled={state === "busy"}>
					Keep me posted
				</button>
			</div>
			{error && (
				<p className="labs-error" role="alert">
					{error}
				</p>
			)}
		</form>
	);
}

export default function Labs() {
	return (
		<div className="labs">
			<header className="labs-top">
				<a className="labs-mark" href="https://mygriefguide.org/">
					<span>Grief Guide</span>
					<Wave />
					<small>Labs</small>
				</a>
				<a className="labs-home" href="https://mygriefguide.org/">
					mygriefguide.org
				</a>
			</header>

			<main>
				<section className="labs-hero">
					<p className="labs-eyebrow">Four concepts, shared early</p>
					<h1>Ideas we're exploring, shown before they're finished.</h1>
					<p className="labs-lede">
						Grief Guide helps people, families and communities through grief. These are four new things we're thinking
						about building. Before we commit to any of them, we'd like to know which would truly have helped you, or
						someone you love.
					</p>
					<nav className="labs-index" aria-label="The four concepts">
						{CONCEPTS.map((concept) => (
							<a key={concept.id} href={`#${concept.id}`}>
								{concept.name}
							</a>
						))}
					</nav>
				</section>

				<aside className="labs-note">
					<h2>Before you look</h2>
					<p>
						These are early previews, not finished services. They may change or be reset, so please don't keep anything
						in them that you couldn't bear to lose. You don't need to try them to tell us what you think.
					</p>
				</aside>

				{CONCEPTS.map((concept, index) => (
					<section key={concept.id} id={concept.id} className="labs-concept">
						<div className="labs-art">{concept.art}</div>
						<div className="labs-words">
							<p className="labs-number">Concept {index + 1} of {CONCEPTS.length}</p>
							<h2>{concept.name}</h2>
							<p className="labs-promise">{concept.promise}</p>
							<p>{concept.body}</p>
							<ul>
								{concept.points.map((point) => (
									<li key={point}>{point}</li>
								))}
							</ul>
							<p className="labs-who">{concept.who}</p>
							<a className="labs-preview" href={concept.preview.href}>
								{concept.preview.label}
								<span aria-hidden="true"> &rarr;</span>
							</a>
							<Reaction concept={concept} />
						</div>
					</section>
				))}

				<section className="labs-promises">
					<h2>How we're going about this</h2>
					<dl>
						<div>
							<dt>We're listening first</dt>
							<dd>What you tell us here decides what we build. An idea that doesn't help anyone won't be built.</dd>
						</div>
						<div>
							<dt>We'll only launch what we can look after</dt>
							<dd>
								People would trust these with names, voices and letters. We won't open one for real until we know we can
								care for it for years.
							</dd>
						</div>
						<div>
							<dt>What you share stays with us</dt>
							<dd>Your answers and notes are read by the Grief Guide team and no one else. An email is used only to write to you about this.</dd>
						</div>
					</dl>
				</section>

				<section className="labs-close">
					<Wave />
					<h2>Would you like to hear what comes of this?</h2>
					<p>Leave an email and we'll tell you which of these we decide to build.</p>
					<KeepInTouch />
				</section>
			</main>

			<footer className="labs-foot">
				<p>
					A <a href="https://mygriefguide.org/">Grief Guide</a> project.
				</p>
				<p>
					If you are in crisis or thinking about harming yourself, call or text <a href="tel:988">988</a> in the United
					States, or your local emergency number.
				</p>
			</footer>
		</div>
	);
}
