import qrcode from "qrcode-generator";
import { useEffect, useMemo, useState } from "react";
import { CHAPTERS, type Entry, type LovedOne, type Photo, calls } from "../shared";
import { TYPE_LABEL, api, day, listenPageUrl, mediaUrl, message, useLoad } from "./lib";
import { Card, Confirm, Notice } from "./ui";

type Item = {
	id: string;
	entryId: string | null;
	chapter: string;
	title: string;
	text: string;
	showPhotos: boolean;
	showAudio: boolean;
	date: string | null;
	photos: Photo[];
	hasAudio: boolean;
	listenToken: string | null;
};
type BookData = { book: { id: string; title: string; status: string; config: { dedication?: string } }; items: Item[] };

/** A QR code drawn locally from a link we generated ourselves; nothing is fetched from anywhere. */
function Qr({ url }: { url: string }) {
	const svg = useMemo(() => {
		const code = qrcode(0, "M");
		code.addData(url);
		code.make();
		return code.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
	}, [url]);
	return <span className="uc-qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** The finished pages. On screen this is the preview; printed (or "Save as PDF") it is the book. */
function Pages({ title, dedication, items, about }: { title: string; dedication: string; items: Item[]; about: string }) {
	const chapters = [...new Set(items.map((i) => i.chapter))];
	return (
		<div className="uc-book">
			<section className="uc-book-cover">
				<h1>{title}</h1>
				<p>{about}</p>
			</section>
			{dedication && (
				<section className="uc-book-dedication">
					<p>{dedication}</p>
				</section>
			)}
			{chapters.map((chapter) => (
				<section key={chapter} className="uc-book-chapter">
					{chapter && <h2>{chapter}</h2>}
					{items
						.filter((i) => i.chapter === chapter)
						.map((i) => (
							<article key={i.id}>
								{i.title && <h3>{i.title}</h3>}
								{i.date && <p className="uc-book-date">{day(i.date)}</p>}
								{i.showPhotos &&
									i.photos.map((p) => (
										<figure key={p.assetId}>
											<img src={mediaUrl(p.assetId)} alt={p.caption} />
											{p.caption && <figcaption>{p.caption}</figcaption>}
										</figure>
									))}
								{i.text && <p className="uc-book-text">{i.text}</p>}
								{i.showAudio && i.listenToken && (
									<p className="uc-book-listen">
										<Qr url={listenPageUrl(i.listenToken)} />
										<span>Scan to hear this in the voice it was recorded in.</span>
									</p>
								)}
							</article>
						))}
				</section>
			))}
		</div>
	);
}

function Builder({ bookId, lovedOne, ai, onBack }: { bookId: string; lovedOne: LovedOne; ai: boolean; onBack: () => void }) {
	const { data, error, reload } = useLoad<BookData>(`/books/${bookId}`);
	const entries = useLoad<{ entries: Entry[] }>(`/loved-ones/${lovedOne.id}/entries?q=`);
	const [title, setTitle] = useState("");
	const [dedication, setDedication] = useState("");
	const [items, setItems] = useState<Item[] | null>(null);
	const [picking, setPicking] = useState(false);
	const [proposal, setProposal] = useState<{ chapters: Record<string, string>; source: string } | null>(null);
	const [preview, setPreview] = useState(false);
	const [notice, setNotice] = useState("");
	const about = calls(lovedOne);

	// Take the saved book as the starting point for editing, once, when it arrives.
	const [loadedFor, setLoadedFor] = useState("");
	if (data && loadedFor !== data.book.id + data.items.map((i) => i.listenToken ?? "").join()) {
		setLoadedFor(data.book.id + data.items.map((i) => i.listenToken ?? "").join());
		if (items === null) {
			setTitle(data.book.title);
			setDedication(data.book.config.dedication ?? "");
			setItems(data.items);
		} else {
			// A reload after creating listening links: keep the edits, take the new links.
			setItems(items.map((i) => ({ ...i, listenToken: data.items.find((d) => d.entryId === i.entryId)?.listenToken ?? i.listenToken })));
		}
	}

	useEffect(() => {
		if (!preview) return;
		document.body.classList.add("uc-printing");
		return () => document.body.classList.remove("uc-printing");
	}, [preview]);

	if (error) return <Notice text={error} />;
	if (!data || !items) return <p className="uc-quiet">Loading…</p>;

	const update = (id: string, patch: Partial<Item>) => setItems(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
	const move = (index: number, by: number) => {
		const next = [...items];
		const [item] = next.splice(index, 1);
		next.splice(index + by, 0, item);
		setItems(next);
	};
	const included = new Set(items.map((i) => i.entryId));

	const toggleEntry = (e: Entry) => {
		if (included.has(e.id)) return setItems(items.filter((i) => i.entryId !== e.id));
		setItems([
			...items,
			{
				id: `new-${e.id}`,
				entryId: e.id,
				chapter: "",
				title: e.title,
				// The book starts from a copy of the person's own words. Editing it here never changes the original.
				text: e.content || e.transcript,
				showPhotos: true,
				showAudio: true,
				date: e.createdAt,
				photos: e.photos,
				hasAudio: !!e.audioAssetId,
				listenToken: null,
			},
		]);
	};

	const save = async (quiet = false) => {
		try {
			await api("PUT", `/books/${bookId}`, { title, config: { dedication }, items });
			if (!quiet) setNotice("Saved. You can come back to this book any time.");
			return true;
		} catch (err) {
			setNotice(message(err));
			return false;
		}
	};

	const suggest = async () => {
		setNotice("");
		try {
			setProposal(await api<{ chapters: Record<string, string>; source: string }>("POST", `/books/${bookId}/chapters`, { items }));
		} catch (err) {
			setNotice(message(err));
		}
	};

	const openPreview = async () => {
		if (!(await save(true))) return;
		// Recordings shown with a QR code each need a listening link. Created here, on request, never automatically.
		try {
			for (const item of items) if (item.showAudio && item.hasAudio && !item.listenToken && item.entryId) await api("POST", `/entries/${item.entryId}/share-link`);
		} catch (err) {
			setNotice(message(err));
		}
		await reload();
		setPreview(true);
	};

	if (preview) {
		return (
			<div className="uc-preview">
				<div className="uc-preview-bar">
					<button type="button" className="uc-btn" onClick={() => setPreview(false)}>
						← Keep editing
					</button>
					<button type="button" className="uc-btn uc-primary" onClick={() => window.print()}>
						Export as PDF
					</button>
					<span className="uc-quiet">Opens your browser's print window. Choose “Save as PDF” as the destination, or print it.</span>
				</div>
				<Pages title={title} dedication={dedication} items={items} about={lovedOne.name} />
			</div>
		);
	}

	return (
		<>
			<button type="button" className="uc-link" onClick={onBack}>
				← All books
			</button>
			<Card title="Legacy Book" intro={`Choose memories of ${about}, arrange them into chapters, and keep them as a book.`}>
				<label className="uc-field">
					Title
					<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />
				</label>
				<label className="uc-field">
					A dedication or opening words (optional)
					<textarea value={dedication} onChange={(e) => setDedication(e.target.value)} rows={3} />
				</label>
				<div className="uc-row">
					<button type="button" className="uc-btn" onClick={() => setPicking(!picking)}>
						{picking ? "Done choosing" : "Choose memories"}
					</button>
					{ai && items.length > 0 && (
						<button type="button" className="uc-btn" onClick={suggest}>
							Suggest chapters
						</button>
					)}
					<button type="button" className="uc-btn uc-primary" onClick={() => save()}>
						Save book
					</button>
					<button type="button" className="uc-btn" disabled={!items.length} onClick={openPreview}>
						Preview and export
					</button>
				</div>
				<Notice text={notice} />
			</Card>

			{picking && (
				<Card title="Your memories" intro="Tick the ones to include. They stay exactly as they are in your archive.">
					{entries.data && !entries.data.entries.length && <p className="uc-quiet">There's nothing in the archive yet.</p>}
					{entries.data?.entries.map((e) => (
						<label key={e.id} className={included.has(e.id) ? "uc-option uc-option-on" : "uc-option"}>
							<input type="checkbox" checked={included.has(e.id)} onChange={() => toggleEntry(e)} />
							<span>
								{e.title || (e.content || e.transcript).slice(0, 80) || TYPE_LABEL[e.type]}
								<span className="uc-quiet uc-block">
									{TYPE_LABEL[e.type]} · {day(e.createdAt)}
									{e.photos.length ? ` · ${e.photos.length} photograph${e.photos.length === 1 ? "" : "s"}` : ""}
								</span>
							</span>
						</label>
					))}
				</Card>
			)}

			{proposal && (
				<Card title="Suggested chapters" intro={proposal.source === "ai" ? "Proposed by AI from your own words. Nothing changes unless you accept." : "Proposed by simple matching on your words and categories, not the AI service. Nothing changes unless you accept."}>
					<ul className="uc-list">
						{items.map((i) => (
							<li key={i.id}>
								<span>{i.title || i.text.slice(0, 60)}</span>
								<span className="uc-quiet">{proposal.chapters[i.id] ?? "—"}</span>
							</li>
						))}
					</ul>
					<div className="uc-row">
						<button
							type="button"
							className="uc-btn uc-primary"
							onClick={() => {
								setItems(items.map((i) => ({ ...i, chapter: proposal.chapters[i.id] ?? i.chapter })).sort((a, b) => CHAPTERS.indexOf(proposal.chapters[a.id]) - CHAPTERS.indexOf(proposal.chapters[b.id])));
								setProposal(null);
							}}
						>
							Use these chapters
						</button>
						<button type="button" className="uc-btn" onClick={() => setProposal(null)}>
							No, thank you
						</button>
					</div>
				</Card>
			)}

			{items.map((item, index) => (
				<article key={item.id} className="uc-entry">
					<p className="uc-label">
						{index + 1} of {items.length}
						{item.date ? ` · ${day(item.date)}` : ""}
						{!item.entryId && " · the original memory has since been deleted"}
					</p>
					<label className="uc-field">
						Chapter
						<input list="uc-chapters" value={item.chapter} onChange={(e) => update(item.id, { chapter: e.target.value })} placeholder="Our Favorite Memories" maxLength={120} />
					</label>
					<label className="uc-field">
						Title
						<input value={item.title} onChange={(e) => update(item.id, { title: e.target.value })} maxLength={200} />
					</label>
					<label className="uc-field">
						Words as they'll appear in the book
						<textarea value={item.text} onChange={(e) => update(item.id, { text: e.target.value })} rows={5} />
					</label>
					{item.photos.length > 0 && (
						<label className="uc-check">
							<input type="checkbox" checked={item.showPhotos} onChange={(e) => update(item.id, { showPhotos: e.target.checked })} />
							<span>
								Include its {item.photos.length} photograph{item.photos.length === 1 ? "" : "s"}
							</span>
						</label>
					)}
					{item.hasAudio && (
						<label className="uc-check">
							<input type="checkbox" checked={item.showAudio} onChange={(e) => update(item.id, { showAudio: e.target.checked })} />
							<span>
								Print a QR code that plays the recording
								<span className="uc-quiet uc-block">Anyone holding the book can listen. You can switch a code off later under Settings.</span>
							</span>
						</label>
					)}
					<footer className="uc-row">
						<button type="button" className="uc-link" disabled={index === 0} onClick={() => move(index, -1)}>
							Move earlier
						</button>
						<button type="button" className="uc-link" disabled={index === items.length - 1} onClick={() => move(index, 1)}>
							Move later
						</button>
						<button type="button" className="uc-link" onClick={() => setItems(items.filter((i) => i.id !== item.id))}>
							Take out of the book
						</button>
					</footer>
				</article>
			))}
			<datalist id="uc-chapters">
				{CHAPTERS.map((c) => (
					<option key={c} value={c} />
				))}
			</datalist>
		</>
	);
}

type BookSummary = { id: string; title: string; updatedAt: string };

export default function Book({ lovedOne, ai }: { lovedOne: LovedOne; ai: boolean }) {
	const { data, reload } = useLoad<{ books: BookSummary[] }>(`/loved-ones/${lovedOne.id}/home`);
	const [open, setOpen] = useState("");
	const [notice, setNotice] = useState("");

	if (open) {
		return (
			<Builder
				bookId={open}
				lovedOne={lovedOne}
				ai={ai}
				onBack={() => {
					setOpen("");
					void reload();
				}}
			/>
		);
	}

	const create = async () => {
		try {
			setOpen((await api<{ id: string }>("POST", "/books", { lovedOneId: lovedOne.id })).id);
		} catch (err) {
			setNotice(message(err));
		}
	};

	return (
		<Card title="Legacy Book" intro={`Gather letters, recordings and photographs of ${calls(lovedOne)} into a keepsake you can print or save as a PDF. Preserving and exporting your memories is always free.`}>
			<ul className="uc-list">
				{data?.books.map((b) => (
					<li key={b.id}>
						<button type="button" className="uc-link" onClick={() => setOpen(b.id)}>
							{b.title}
						</button>
						<span className="uc-row">
							<span className="uc-quiet">Edited {day(b.updatedAt)}</span>
							<Confirm quiet label="Delete" confirm="Yes, delete this book" onConfirm={() => api("DELETE", `/books/${b.id}`).then(reload, () => {})} />
						</span>
					</li>
				))}
			</ul>
			<button type="button" className="uc-btn uc-primary" onClick={create}>
				Create a Legacy Book
			</button>
			<Notice text={notice} />
		</Card>
	);
}
