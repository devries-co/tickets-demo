import { useEffect, useState } from "react";
import { CATEGORIES, type Category, type Entry, type Suggestion } from "../shared";
import { TYPE_LABEL, api, clock, dayTime, mediaUrl, message } from "./lib";
import { Card, Confirm, PhotoGrid, PhotoPicker } from "./ui";

type Collection = { id: string; name: string; role: string };

/**
 * "Would you like to carry this moment forward?" Shown after saving, or when
 * asked for from an entry. Every option is optional, and "keep this private"
 * is always one of them.
 */
export function CarryPrompt({ entry, about, ai, onDone }: { entry: Entry; about: string; ai: boolean; onDone: (saved: number) => void }) {
	const [suggestions, setSuggestions] = useState<Suggestion[] | null>(ai ? null : []);
	const [source, setSource] = useState("");
	const [chosen, setChosen] = useState<number[]>([]);
	const [own, setOwn] = useState("");
	const [error, setError] = useState("");

	useEffect(() => {
		if (!ai) return;
		let current = true;
		api<{ suggestions: Suggestion[]; source: string }>("POST", `/entries/${entry.id}/analyze`).then(
			(r) => {
				if (!current) return;
				setSuggestions(r.suggestions);
				setSource(r.source);
			},
			() => current && setSuggestions([]),
		);
		return () => {
			current = false;
		};
	}, [ai, entry.id]);

	const save = async () => {
		const picks: Suggestion[] = chosen.map((i) => suggestions![i]);
		if (own.trim()) picks.push({ text: own.trim(), kind: "someday" });
		try {
			for (const pick of picks) await api("POST", "/activities", { lovedOneId: entry.lovedOneId, entryId: entry.id, description: pick.text, kind: pick.kind });
			onDone(picks.length);
		} catch (err) {
			setError(message(err));
		}
	};

	return (
		<Card title="Would you like to carry this moment forward?" intro={`Only if it feels right. There is nothing you need to do with a memory of ${about}.`} className="uc-carry">
			{suggestions === null && <p className="uc-quiet">Reading what you saved…</p>}
			{suggestions?.map((s, i) => (
				<label key={s.text} className={chosen.includes(i) ? "uc-option uc-option-on" : "uc-option"}>
					<input type="checkbox" checked={chosen.includes(i)} onChange={() => setChosen(chosen.includes(i) ? chosen.filter((x) => x !== i) : [...chosen, i])} />
					{s.text}
				</label>
			))}
			<label className="uc-field">
				{suggestions?.length ? "Or something of your own" : "Something you'd like to do"}
				<input value={own} onChange={(e) => setOwn(e.target.value)} maxLength={300} placeholder="Tell this story at the next family dinner" />
			</label>
			{source === "basic" && <p className="uc-quiet">These ideas come from simple matching on your words, not from the AI service.</p>}
			{error && <p className="uc-error">{error}</p>}
			<div className="uc-row">
				<button type="button" className="uc-btn uc-primary" disabled={!chosen.length && !own.trim()} onClick={save}>
					Save {chosen.length + (own.trim() ? 1 : 0) > 1 ? "these" : "this"}
				</button>
				<button type="button" className="uc-btn" onClick={() => onDone(0)}>
					Keep this moment private
				</button>
			</div>
		</Card>
	);
}

function Categories({ entry, onChange }: { entry: Entry; onChange: () => void }) {
	const [adding, setAdding] = useState<"" | "pick" | "own">("");
	const [own, setOwn] = useState("");
	const decide = async (category: Category, status: "approved" | "rejected") => {
		await api("PATCH", `/categories/${category.id}`, { status }).catch(() => {});
		onChange();
	};
	const add = async (name: string) => {
		setAdding("");
		setOwn("");
		if (!name.trim()) return;
		await api("POST", `/entries/${entry.id}/categories`, { name }).catch(() => {});
		onChange();
	};
	return (
		<div className="uc-chips">
			{entry.categories.map((k) =>
				k.status === "approved" ? (
					<span key={k.id} className="uc-chip">
						{k.name}
						<button type="button" onClick={() => api("DELETE", `/categories/${k.id}`).then(onChange, onChange)} aria-label={`Remove ${k.name}`}>
							×
						</button>
					</span>
				) : (
					<span key={k.id} className="uc-chip uc-chip-suggested">
						Suggested: {k.name}
						<button type="button" onClick={() => decide(k, "approved")} aria-label={`Keep ${k.name}`}>
							✓
						</button>
						<button type="button" onClick={() => decide(k, "rejected")} aria-label={`Reject ${k.name}`}>
							×
						</button>
					</span>
				),
			)}
			{adding === "own" ? (
				<form
					className="uc-row"
					onSubmit={(e) => {
						e.preventDefault();
						void add(own);
					}}
				>
					<input autoFocus value={own} onChange={(e) => setOwn(e.target.value)} placeholder="Name the category" aria-label="Name the category" maxLength={60} />
					<button type="submit" className="uc-btn">
						Add
					</button>
				</form>
			) : adding === "pick" ? (
				<select autoFocus onChange={(e) => (e.target.value === "other" ? setAdding("own") : add(e.target.value))} onBlur={() => setAdding("")} aria-label="Add a category" defaultValue="">
					<option value="" disabled>
						Choose…
					</option>
					{CATEGORIES.filter((c) => !entry.categories.some((k) => k.name === c)).map((c) => (
						<option key={c}>{c}</option>
					))}
					<option value="other">Something else…</option>
				</select>
			) : (
				<button type="button" className="uc-chip uc-chip-add" onClick={() => setAdding("pick")}>
					+ Category
				</button>
			)}
		</div>
	);
}

/** One entry: listen, read, look; and everything the person can do with it. */
export function EntryCard({
	entry,
	about,
	ai,
	collections,
	onChange,
	onResume,
	select,
}: {
	entry: Entry;
	about: string;
	ai: boolean;
	collections: Collection[];
	onChange: () => void;
	/** Reopen a letter draft in the editor. */
	onResume?: (entry: Entry) => void;
	select?: { checked: boolean; toggle: () => void };
}) {
	const [mode, setMode] = useState<"" | "edit" | "carry" | "share">("");
	const [open, setOpen] = useState(false);
	const [form, setForm] = useState({ title: entry.title, content: entry.content, transcript: entry.transcript, tags: entry.tags.join(", "), photos: entry.photos });
	const [note, setNote] = useState("");

	const long = entry.content.length > 600;
	const text = long && !open ? `${entry.content.slice(0, 600).trimEnd()}…` : entry.content;

	const save = async () => {
		try {
			await api("PATCH", `/entries/${entry.id}`, { ...form, tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean) });
			setMode("");
			onChange();
		} catch (err) {
			setNote(message(err));
		}
	};

	const share = async (collectionId: string) => {
		try {
			await api("POST", `/collections/${collectionId}/contributions`, { fromEntryId: entry.id });
			setNote("A copy has been added to the shared collection. Your original stays private.");
			setMode("");
		} catch (err) {
			setNote(message(err));
		}
	};

	if (mode === "carry") {
		return (
			<CarryPrompt
				entry={entry}
				about={about}
				ai={ai}
				onDone={() => {
					setMode("");
					onChange();
				}}
			/>
		);
	}

	return (
		<article className="uc-entry">
			<header>
				{select && <input type="checkbox" checked={select.checked} onChange={select.toggle} aria-label="Select this memory" />}
				<div>
					<p className="uc-label">
						{entry.draft ? "Draft letter" : TYPE_LABEL[entry.type]} · {dayTime(entry.createdAt)}
						{entry.durationMs ? ` · ${clock(entry.durationMs)}` : ""}
					</p>
					{entry.title && <h3>{entry.title}</h3>}
				</div>
			</header>

			{mode === "edit" ? (
				<div className="uc-form">
					<label className="uc-field">
						Title
						<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={200} />
					</label>
					{entry.type !== "voice" && (
						<label className="uc-field">
							Your words
							<textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={8} />
						</label>
					)}
					{entry.type === "voice" && (
						<label className="uc-field">
							What you said, in writing
							<textarea value={form.transcript} onChange={(e) => setForm({ ...form, transcript: e.target.value })} rows={5} />
						</label>
					)}
					{entry.type !== "voice" && <PhotoPicker photos={form.photos} onChange={(photos) => setForm({ ...form, photos })} />}
					<label className="uc-field">
						Tags, separated by commas
						<input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="baseball, summer" />
					</label>
					<div className="uc-row">
						<button type="button" className="uc-btn uc-primary" onClick={save}>
							Save changes
						</button>
						<button type="button" className="uc-btn" onClick={() => setMode("")}>
							Cancel
						</button>
					</div>
				</div>
			) : (
				<>
					{entry.audioAssetId && <audio controls preload="none" src={mediaUrl(entry.audioAssetId)} className="uc-audio" />}
					<PhotoGrid photos={entry.photos} />
					{text && <p className="uc-words">{text}</p>}
					{long && (
						<button type="button" className="uc-link" onClick={() => setOpen(!open)}>
							{open ? "Show less" : "Read all of it"}
						</button>
					)}
					{entry.transcript && <p className="uc-words uc-transcript">{entry.transcript}</p>}
					{entry.tags.length > 0 && <p className="uc-quiet">{entry.tags.map((t) => `#${t}`).join("  ")}</p>}
					{!entry.draft && <Categories entry={entry} onChange={onChange} />}
				</>
			)}

			{note && <p className="uc-notice">{note}</p>}

			{mode === "share" && (
				<div className="uc-form">
					<p className="uc-quiet">Choose a collection. A copy of this memory is added there for its members; this original stays private and unchanged.</p>
					{!collections.length && <p>You don't have a shared collection yet. Create one under Our Stories.</p>}
					<div className="uc-row">
						{collections.filter((k) => k.role !== "viewer").map((k) => (
							<button key={k.id} type="button" className="uc-btn" onClick={() => share(k.id)}>
								Share to {k.name}
							</button>
						))}
						<button type="button" className="uc-btn" onClick={() => setMode("")}>
							Cancel
						</button>
					</div>
				</div>
			)}

			{mode === "" && (
				<footer className="uc-row">
					{entry.draft && onResume ? (
						<button type="button" className="uc-link" onClick={() => onResume(entry)}>
							Keep writing
						</button>
					) : (
						<>
							<button type="button" className="uc-link" onClick={() => setMode("edit")}>
								Edit
							</button>
							<button type="button" className="uc-link" onClick={() => setMode("carry")}>
								Carry forward
							</button>
							<button type="button" className="uc-link" onClick={() => setMode("share")}>
								Share with family
							</button>
						</>
					)}
					{entry.audioAssetId && (
						<a className="uc-link" href={mediaUrl(entry.audioAssetId, true)}>
							Download recording
						</a>
					)}
					<Confirm quiet label="Delete" confirm="Yes, delete this" onConfirm={() => api("DELETE", `/entries/${entry.id}`).then(onChange, (err) => setNote(message(err)))} />
				</footer>
			)}
		</article>
	);
}
