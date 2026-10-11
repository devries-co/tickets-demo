import { useCallback, useEffect, useState, type FormEvent } from "react";
import { HELP_OPTIONS, LIGHTS, type PublicCircle } from "../shared";
import { api, store } from "./api";
import { ErrorNote, Lamp, Spinner } from "./ui";
import { nextOccurrence, prettyDate } from "./util";

function guidance(c: PublicCircle): { title: string; tips: string[] } {
	const g = c.grieverName;
	switch (c.light) {
		case "on":
			return {
				title: "Reach out today",
				tips: [
					"Call, or offer to stop by. Short visits are best.",
					`Offer something specific ("Can I bring dinner Thursday?") instead of "let me know if you need anything."`,
					"You don't have to fix anything. Listening is the help.",
				],
			};
		case "off":
			return {
				title: "Give some space today",
				tips: [
					`${g} is okay and has asked for space. It isn't about you.`,
					"No calls or visits today. If you want to send something, keep it to one line with no need to reply.",
					"The light will come back on. Keep showing up when it does.",
				],
			};
		case "dim":
			return {
				title: "A text is perfect",
				tips: [
					"Send a short text. Don't call, and don't expect a reply.",
					`Try: "Thinking of you today. No need to write back."`,
					"Two lines that show you remember mean more than you think.",
				],
			};
		default:
			return {
				title: "When in doubt",
				tips: [
					`${g} hasn't set a light yet, and doesn't owe anyone one.`,
					`A short text with no need to reply is always safe: "Thinking of you. No need to write back."`,
				],
			};
	}
}

export default function CirclePage({ code }: { code: string }) {
	const key = `porchlight:supporter:${code}`;
	const [c, setC] = useState<PublicCircle | null>(null);
	const [error, setError] = useState("");
	const [supporterToken, setSupporterToken] = useState(() => store.get(key));
	// null while checking a remembered supporter token with the server
	const [checked, setJoined] = useState<boolean | null>(null);
	const joined = supporterToken ? checked : false;

	const load = useCallback(() => {
		api.circle(code).then(setC, (e: Error) => setError(e.message));
	}, [code]);

	useEffect(() => {
		load();
		const t = setInterval(load, 60_000);
		return () => clearInterval(t);
	}, [load]);

	useEffect(() => {
		if (!supporterToken) return;
		api.supporter(supporterToken).then(
			(s) => setJoined(s.active),
			() => {
				store.set(key, null);
				setSupporterToken(null);
				setJoined(false);
			},
		);
	}, [supporterToken, key]);

	if (error && !c)
		return (
			<div className="pl-page">
				<ErrorNote error={error} />
			</div>
		);
	if (!c) return <Spinner />;

	const g = c.grieverName;
	const tips = guidance(c);
	const card = c.card;
	const upcoming = card.hardDates
		.map((d) => ({ ...d, next: nextOccurrence(d) }))
		.filter((d): d is typeof d & { next: string } => Boolean(d.next))
		.sort((a, b) => a.next.localeCompare(b.next))
		.slice(0, 6);
	const help = card.help.map((h) => HELP_OPTIONS.find((o) => o.id === h)?.label).filter(Boolean);

	return (
		<div className="pl-page">
			<header className="pl-circlehead">
				<span className="pl-wordmark">Porchlight</span>
				<Lamp light={c.light} size={120} />
				<h1>{g}'s porch light</h1>
				{c.light ? (
					<p className="pl-lightquote">
						<span className={`pl-pill pl-pill--${c.light}`}>
							{LIGHTS[c.light].emoji} {LIGHTS[c.light].label}
						</span>
						<span>“{LIGHTS[c.light].meaning}”</span>
					</p>
				) : (
					<p className="pl-muted">No light set right now.</p>
				)}
				{c.lightNote && <p className="pl-note">“{c.lightNote}”</p>}
			</header>

			<section className="pl-card">
				<h2>{tips.title}</h2>
				<ul className="pl-tips">
					{tips.tips.map((t) => (
						<li key={t}>{t}</li>
					))}
				</ul>
			</section>

			{(card.sayName || card.meals || help.length > 0 || upcoming.length > 0 || card.note) && (
				<section className="pl-card">
					<h2>What {g} would like you to know</h2>
					<dl className="pl-facts">
						{card.sayName && (
							<>
								<dt>{c.lovedOneName}'s name</dt>
								<dd>
									{card.sayName === "yes"
										? `Please say ${c.lovedOneName}'s name. Share memories and stories.`
										: "Not yet, please. Keep it simple for now."}
								</dd>
							</>
						)}
						{card.meals && (
							<>
								<dt>Meals</dt>
								<dd>
									{card.meals === "yes" ? "Yes, welcome." : "No, thank you, not right now."}
									{card.meals === "yes" && card.allergies && <> Note: {card.allergies}</>}
								</dd>
							</>
						)}
						{help.length > 0 && (
							<>
								<dt>Could use help with</dt>
								<dd>{help.join(", ")}</dd>
							</>
						)}
						{upcoming.length > 0 && (
							<>
								<dt>Days that will be hard</dt>
								<dd>
									<ul className="pl-plain">
										{upcoming.map((d) => (
											<li key={d.id}>
												<strong>{prettyDate(d.next)}</strong> · {d.label}
											</li>
										))}
									</ul>
									<span className="pl-muted pl-small">Porchlight will text you a reminder the day before.</span>
								</dd>
							</>
						)}
						{card.note && (
							<>
								<dt>Also</dt>
								<dd>{card.note}</dd>
							</>
						)}
					</dl>
				</section>
			)}

			{joined === null ? null : joined ? (
				<Joined g={g} token={supporterToken!} onLeft={() => setJoined(false)} />
			) : (
				<JoinForm
					code={code}
					c={c}
					onJoined={(t) => {
						store.set(key, t);
						setSupporterToken(t);
						setJoined(true);
						load();
					}}
				/>
			)}

			<section className="pl-card pl-card--soft">
				<h2>Sitting with grief</h2>
				<ul className="pl-tips">
					<li>Grief doesn't follow a schedule. Weeks 6 to 8 are often heavier than the first days.</li>
					<li>You can't say the wrong thing by showing you remember. Silence hurts more.</li>
					<li>Skip “everything happens for a reason.” Try “I'm here” instead.</li>
					<li>The light is a hint, not a test. Follow it and you're doing it right.</li>
				</ul>
			</section>

			{c.sponsor && <p className="pl-sponsor">Shared with care by {c.sponsor}</p>}
			<footer className="pl-footer">
				Porchlight by Grief Guide · <a href="/porchlight">Start your own</a>
			</footer>
		</div>
	);
}

function JoinForm({ code, c, onJoined }: { code: string; c: PublicCircle; onJoined: (token: string) => void }) {
	const [f, setF] = useState({ name: "", phone: "", relationship: "", consent: false });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	async function submit(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError("");
		try {
			const r = await api.join(code, f);
			onJoined(r.supporterToken);
		} catch (err) {
			setError((err as Error).message);
		}
		setBusy(false);
	}

	return (
		<form className="pl-card pl-card--join" onSubmit={submit}>
			<h2>Join {c.grieverName}'s circle</h2>
			<p className="pl-hint">
				Get a text when {c.grieverName}'s light changes, and a gentle tip before the hard days. No app needed.
				{c.circleSize > 0 && ` ${c.circleSize} ${c.circleSize === 1 ? "person has" : "people have"} joined.`}
			</p>
			<label className="pl-field">
				<span>Your name</span>
				<input required maxLength={40} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" />
			</label>
			<label className="pl-field">
				<span>Mobile number</span>
				<input required type="tel" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} autoComplete="tel" />
			</label>
			<label className="pl-field">
				<span>
					How you know {c.grieverName} <em>(optional)</em>
				</span>
				<input maxLength={40} placeholder="sister, neighbor, coworker" value={f.relationship} onChange={(e) => setF({ ...f, relationship: e.target.value })} />
			</label>
			<label className="pl-toggle pl-small">
				<input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} />
				<span>
					Text me updates from Porchlight. A few messages a month at most. Reply STOP anytime. Msg &amp; data rates may
					apply.
				</span>
			</label>
			<ErrorNote error={error} />
			<button className="pl-btn pl-btn--primary pl-btn--block" disabled={busy || !f.consent}>
				{busy ? "Joining…" : "Join the circle"}
			</button>
		</form>
	);
}

function Joined({ g, token, onLeft }: { g: string; token: string; onLeft: () => void }) {
	const [confirm, setConfirm] = useState(false);
	return (
		<section className="pl-card pl-card--soft">
			<h2>You're in {g}'s circle</h2>
			<p>You'll get a text when the light changes, and a reminder before hard days. Come back here anytime.</p>
			{confirm ? (
				<div className="pl-row">
					<button
						className="pl-btn pl-btn--small"
						onClick={async () => {
							await api.leave(token);
							onLeft();
						}}
					>
						Stop my texts
					</button>
					<button className="pl-btn pl-btn--small pl-btn--ghost" onClick={() => setConfirm(false)}>
						Stay
					</button>
				</div>
			) : (
				<button className="pl-link" onClick={() => setConfirm(true)}>
					Leave the circle
				</button>
			)}
		</section>
	);
}
