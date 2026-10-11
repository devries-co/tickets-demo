import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { Memorial } from "../shared/text";
import { api, memorialUrl, message, photoUrl, search } from "./api";

/** Shown wherever a memorial has no photo: a quiet point of light, not a silhouette. */
export function Portrait({ memorial, size }: { memorial: { id: string; name: string; hasPhoto: boolean } | null; size: number }) {
	if (memorial?.hasPhoto) {
		return <img className="nf-portrait" src={photoUrl(memorial.id)} alt={`Photo of ${memorial.name}`} width={size} height={size} loading="lazy" />;
	}
	return (
		<span className="nf-portrait nf-portrait-empty" style={{ width: size, height: size }} aria-hidden="true">
			<span />
		</span>
	);
}

export function Panel({ title, onClose, children, wide }: { title: string; onClose?: () => void; children: ReactNode; wide?: boolean }) {
	return (
		<section className={wide ? "nf-panel nf-panel-wide" : "nf-panel"} aria-label={title}>
			<header className="nf-panel-head">
				<h2>{title}</h2>
				{onClose && (
					<button type="button" className="nf-icon" onClick={onClose} aria-label="Close">
						×
					</button>
				)}
			</header>
			{children}
		</section>
	);
}

export function SearchBox({
	onSelect,
	onAdd,
	autoFocus,
}: {
	onSelect: (memorial: Memorial) => void;
	onAdd: (name: string) => void;
	autoFocus?: boolean;
}) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<Memorial[] | null>(null);
	const [active, setActive] = useState(0);
	const latest = useRef(0);

	useEffect(() => {
		const q = query.trim();
		const ticket = ++latest.current;
		const timer = setTimeout(
			() => {
				// Only the newest request may update the list, so slow replies can't overwrite fresh ones.
				(q.length < 2 ? Promise.resolve(null) : search(q).catch(() => [])).then((found) => {
					if (ticket === latest.current) {
						setResults(found);
						setActive(0);
					}
				});
			},
			q.length < 2 ? 0 : 220,
		);
		return () => clearTimeout(timer);
	}, [query]);

	const onKey = (e: KeyboardEvent) => {
		if (!results?.length) return;
		if (e.key === "ArrowDown") setActive((active + 1) % results.length);
		else if (e.key === "ArrowUp") setActive((active - 1 + results.length) % results.length);
		else if (e.key === "Enter") onSelect(results[active]);
		else return;
		e.preventDefault();
	};

	return (
		<div className="nf-search">
			<input
				type="search"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={onKey}
				placeholder="Who would you like to remember?"
				aria-label="Who would you like to remember?"
				autoComplete="off"
				autoFocus={autoFocus}
				role="combobox"
				aria-expanded={!!results}
				aria-controls="nf-results"
			/>
			{results && (
				<ul className="nf-results" id="nf-results" role="listbox">
					{results.map((m, i) => (
						<li key={m.id} role="option" aria-selected={i === active}>
							<button type="button" className={i === active ? "nf-result nf-result-on" : "nf-result"} onClick={() => onSelect(m)} onMouseEnter={() => setActive(i)}>
								<Portrait memorial={m} size={40} />
								<span>
									<strong>{m.name}</strong>
									<span className="nf-excerpt">{m.text}</span>
								</span>
							</button>
						</li>
					))}
					{!results.length && (
						<li className="nf-noresult">
							<span>No one by that name is here yet.</span>
							<button type="button" className="nf-link" onClick={() => onAdd(query.trim())}>
								Add them to our world
							</button>
						</li>
					)}
				</ul>
			)}
		</div>
	);
}

const REASONS: [string, string][] = [
	["inappropriate", "It's inappropriate or offensive"],
	["not_a_memorial", "It isn't a memorial"],
	["wrong_information", "The information is wrong"],
	["privacy", "It shares something private"],
	["other", "Something else"],
];

/** "Report" and "request a correction or removal", folded under the memorial card. */
function CareForm({ memorial, kind, onDone }: { memorial: Memorial; kind: "report" | "request"; onDone: (text: string) => void }) {
	const [form, setForm] = useState({ reason: "inappropriate", kind: "correction", details: "", name: "", email: "", relationship: "" });
	const [error, setError] = useState("");
	const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		try {
			await api("POST", `/memorial/${memorial.id}/${kind}`, form);
			onDone(kind === "report" ? "Thank you. Someone will look at this memorial." : "Thank you. Your request has been sent, and we'll reply by email.");
		} catch (err) {
			setError(message(err));
		}
	};

	return (
		<form className="nf-form nf-care" onSubmit={submit}>
			{kind === "report" ? (
				<label>
					What's wrong?
					<select value={form.reason} onChange={(e) => set({ reason: e.target.value })}>
						{REASONS.map(([id, label]) => (
							<option key={id} value={id}>
								{label}
							</option>
						))}
					</select>
				</label>
			) : (
				<>
					<label>
						What would you like?
						<select value={form.kind} onChange={(e) => set({ kind: e.target.value })}>
							<option value="correction">A correction</option>
							<option value="removal">This memorial removed</option>
						</select>
					</label>
					<label>
						Your name
						<input value={form.name} onChange={(e) => set({ name: e.target.value })} required maxLength={120} />
					</label>
					<label>
						Your relationship to {memorial.name} (optional)
						<input value={form.relationship} onChange={(e) => set({ relationship: e.target.value })} maxLength={80} />
					</label>
				</>
			)}
			<label>
				{kind === "report" ? "Anything that would help us understand (optional)" : "What should change?"}
				<textarea value={form.details} onChange={(e) => set({ details: e.target.value })} rows={3} maxLength={600} required={kind === "request"} />
			</label>
			<label>
				Your email {kind === "report" ? "(optional)" : "(so we can reply; never shown publicly)"}
				<input type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} required={kind === "request"} />
			</label>
			{error && <p className="nf-error">{error}</p>}
			<button type="submit" className="nf-btn">
				Send
			</button>
		</form>
	);
}

export function MemorialCard({
	memorial,
	sample,
	onAnother,
	onReturn,
}: {
	memorial: Memorial | null;
	/** Set for a demonstration name: there is no memorial behind it. */
	sample?: string;
	onAnother: () => void;
	onReturn: () => void;
}) {
	const [shared, setShared] = useState("");
	const [care, setCare] = useState<"" | "report" | "request">("");
	const [thanks, setThanks] = useState("");

	const share = async () => {
		if (!memorial) return;
		const url = memorialUrl(memorial.id);
		try {
			if (navigator.share) {
				await navigator.share({ title: `${memorial.name} · Never Forgotten`, text: memorial.text, url });
				return;
			}
			await navigator.clipboard.writeText(url);
			setShared("Link copied");
		} catch {
			// The share sheet was dismissed, or copying is blocked: show the link to copy by hand.
			setShared(url);
		}
	};

	return (
		<article className="nf-card" aria-live="polite">
			<Portrait memorial={memorial} size={132} />
			<h2>{memorial?.name ?? sample}</h2>
			{memorial ? (
				<p className="nf-words">{memorial.text}</p>
			) : (
				<p className="nf-words nf-muted">A sample name, shown only to demonstrate the artwork. No memorial exists behind it.</p>
			)}
			{memorial && <p className="nf-forever">Forever part of our world.</p>}
			<div className="nf-actions">
				{memorial && (
					<button type="button" className="nf-btn nf-gold" onClick={share}>
						Share This Memorial
					</button>
				)}
				<button type="button" className="nf-btn" onClick={onAnother}>
					Find Another Name
				</button>
				<button type="button" className="nf-btn" onClick={onReturn}>
					Return to Earth
				</button>
			</div>
			{shared && <p className="nf-muted nf-break">{shared}</p>}
			{memorial && <p className="nf-among">Among millions of lives, this one changed yours.</p>}
			{memorial && !thanks && (
				<p className="nf-care-links">
					<button type="button" className="nf-link" onClick={() => setCare(care === "request" ? "" : "request")}>
						Request a correction or removal
					</button>
					<button type="button" className="nf-link" onClick={() => setCare(care === "report" ? "" : "report")}>
						Report
					</button>
				</p>
			)}
			{memorial && care && !thanks && (
				<CareForm
					key={care}
					memorial={memorial}
					kind={care}
					onDone={(text) => {
						setThanks(text);
						setCare("");
					}}
				/>
			)}
			{thanks && <p className="nf-muted">{thanks}</p>}
		</article>
	);
}
