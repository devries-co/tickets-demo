import { useEffect, useState } from "react";
import { WORK_HELPS, WORK_MENTION, type WorkView } from "../shared";
import { api } from "./api";
import { ErrorNote, Spinner } from "./ui";

export default function WorkPage({ code }: { code: string }) {
	const [w, setW] = useState<WorkView | null>(null);
	const [error, setError] = useState("");

	useEffect(() => {
		api.work(code).then(setW, (e: Error) => setError(e.message));
	}, [code]);

	if (error)
		return (
			<div className="pl-page">
				<ErrorNote error={error} />
			</div>
		);
	if (!w) return <Spinner />;
	const helps = w.helps.map((h) => WORK_HELPS.find((o) => o.id === h)?.label).filter(Boolean);

	return (
		<div className="pl-page">
			<header className="pl-circlehead">
				<span className="pl-wordmark">Porchlight · Work</span>
				<h1>Welcoming {w.grieverName} back</h1>
				<p className="pl-muted">{w.grieverName} chose to share this so the team knows what helps.</p>
			</header>
			{w.mention && (
				<section className="pl-card">
					<h2>Should I mention it?</h2>
					<p className="pl-big">{WORK_MENTION[w.mention]}</p>
				</section>
			)}
			{helps.length > 0 && (
				<section className="pl-card">
					<h2>What helps</h2>
					<ul className="pl-tips">
						{helps.map((h) => (
							<li key={h}>{h}</li>
						))}
					</ul>
				</section>
			)}
			{w.note && (
				<section className="pl-card">
					<h2>From {w.grieverName}</h2>
					<p>“{w.note}”</p>
				</section>
			)}
			<section className="pl-card pl-card--soft">
				<h2>For managers and teammates</h2>
				<ul className="pl-tips">
					<li>Grief comes in waves for months. Focus and energy may come and go; that's normal.</li>
					<li>If {w.grieverName} steps away, no follow-up is needed. Just let it be.</li>
					<li>Follow the card above, and keep it private.</li>
				</ul>
			</section>
			<footer className="pl-footer">Porchlight by Grief Guide</footer>
		</div>
	);
}
