import { useEffect, useMemo, useState } from "react";
import { CATEGORIES, type Entry, type LovedOne, calls } from "../shared";
import { EntryCard } from "./Entries";
import { api, message, monthOf, useLoad } from "./lib";
import { Card, Notice, PhotoGrid } from "./ui";

type View = "Timeline" | "Categories" | "Photographs";
type Collection = { id: string; name: string; role: string };

/** The Living Archive: everything saved for one person, by time, by theme, or as photographs, and searchable. */
export default function Archive({ lovedOne, ai, collections, onResume }: { lovedOne: LovedOne; ai: boolean; collections: Collection[]; onResume: (entry: Entry) => void }) {
	const [view, setView] = useState<View>("Timeline");
	const [typed, setTyped] = useState("");
	const [q, setQ] = useState("");
	const [category, setCategory] = useState("");
	const [selected, setSelected] = useState<string[] | null>(null);
	const [summary, setSummary] = useState("");
	const [notice, setNotice] = useState("");
	const { data, error, reload } = useLoad<{ entries: Entry[] }>(`/loved-ones/${lovedOne.id}/entries?q=${encodeURIComponent(q)}`);
	const about = calls(lovedOne);

	useEffect(() => {
		const timer = setTimeout(() => setQ(typed.trim()), 300);
		return () => clearTimeout(timer);
	}, [typed]);

	const entries = useMemo(() => data?.entries ?? [], [data]);
	const approved = (e: Entry) => e.categories.filter((k) => k.status === "approved").map((k) => k.name);
	const counts = useMemo(() => {
		const map = new Map<string, number>();
		for (const e of entries) for (const name of approved(e)) map.set(name, (map.get(name) ?? 0) + 1);
		return map;
	}, [entries]);
	const names = [...new Set([...CATEGORIES, ...counts.keys()])];
	const shown = category ? entries.filter((e) => approved(e).includes(category)) : entries;
	const months = [...new Set(shown.map((e) => monthOf(e.createdAt)))];
	const photos = entries.flatMap((e) => e.photos);

	const summarise = async () => {
		setNotice("");
		setSummary("");
		try {
			setSummary((await api<{ summary: string }>("POST", `/loved-ones/${lovedOne.id}/summary`, { entryIds: selected })).summary);
		} catch (err) {
			setNotice(message(err));
		}
	};

	return (
		<>
			<Card title="Your Living Archive" intro={`Everything you've shared with ${about}, kept exactly as you made it.`}>
				<input type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search your words, transcripts, tags, or a date like 2024-06" aria-label="Search your archive" />
				<nav className="uc-tabs" aria-label="Archive views">
					{(["Timeline", "Categories", "Photographs"] as const).map((v) => (
						<button
							key={v}
							type="button"
							className={v === view ? "uc-tab uc-tab-on" : "uc-tab"}
							onClick={() => {
								setView(v);
								setCategory("");
							}}
						>
							{v}
						</button>
					))}
				</nav>
				{ai && view !== "Photographs" && (
					<div className="uc-row">
						{selected === null ? (
							<button type="button" className="uc-link" onClick={() => setSelected([])}>
								Summarise a few memories
							</button>
						) : (
							<>
								<button type="button" className="uc-btn" disabled={!selected.length} onClick={summarise}>
									Summarise {selected.length || ""} selected
								</button>
								<button
									type="button"
									className="uc-link"
									onClick={() => {
										setSelected(null);
										setSummary("");
									}}
								>
									Done
								</button>
							</>
						)}
					</div>
				)}
				{summary && (
					<blockquote className="uc-summary">
						<p className="uc-label">A summary of your own words, written by AI</p>
						{summary}
					</blockquote>
				)}
				<Notice text={notice || error} />
			</Card>

			{view === "Categories" && !category && (
				<Card>
					<ul className="uc-list">
						{names.map((name) => (
							<li key={name}>
								<button type="button" className="uc-link" disabled={!counts.get(name)} onClick={() => setCategory(name)}>
									{name}
								</button>
								<span className="uc-quiet">{counts.get(name) ?? 0}</span>
							</li>
						))}
					</ul>
					<p className="uc-quiet">A memory appears here once a category has been added to it, by you or, with your say-so, from an AI suggestion.</p>
				</Card>
			)}

			{view === "Photographs" && (
				<Card>
					{photos.length ? <PhotoGrid photos={photos} /> : <p className="uc-quiet">No photographs yet.</p>}
				</Card>
			)}

			{view !== "Photographs" && (view === "Timeline" || category) && (
				<>
					{category && (
						<p className="uc-row">
							<strong>{category}</strong>
							<button type="button" className="uc-link" onClick={() => setCategory("")}>
								All categories
							</button>
						</p>
					)}
					{data && !shown.length && <Card>{q ? <p>Nothing matches “{q}”.</p> : <p>Nothing here yet. Whatever you record, write or share will be kept here.</p>}</Card>}
					{months.map((month) => (
						<section key={month} className="uc-month">
							<h2 className="uc-month-name">{month}</h2>
							{shown
								.filter((e) => monthOf(e.createdAt) === month)
								.map((e) => (
									<EntryCard
										key={e.id}
										entry={e}
										about={about}
										ai={ai}
										collections={collections}
										onChange={reload}
										onResume={onResume}
										select={selected ? { checked: selected.includes(e.id), toggle: () => setSelected(selected.includes(e.id) ? selected.filter((x) => x !== e.id) : [...selected, e.id]) } : undefined}
									/>
								))}
						</section>
					))}
				</>
			)}
		</>
	);
}
