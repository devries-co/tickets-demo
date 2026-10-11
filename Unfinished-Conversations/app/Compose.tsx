import { useEffect, useRef, useState } from "react";
import type { Entry, Photo } from "../shared";
import { api, message } from "./lib";
import { Card, PhotoPicker } from "./ui";

type Saved = { id: string; crisis: boolean };

/**
 * A letter: nothing but a title, a page, and optional photographs. The draft
 * is saved a moment after each pause in typing, so nothing is lost if the
 * person closes the window part-way through.
 */
export function Letter({ lovedOneId, about, draft, onSaved, onClose }: { lovedOneId: string; about: string; draft?: Entry; onSaved: (saved: Saved) => void; onClose: () => void }) {
	const [title, setTitle] = useState(draft?.title ?? "");
	const [content, setContent] = useState(draft?.content ?? "");
	const [photos, setPhotos] = useState<Photo[]>(draft?.photos ?? []);
	const [status, setStatus] = useState(draft ? "Draft opened" : "");
	const [error, setError] = useState("");
	const id = useRef(draft?.id ?? "");
	const dirty = useRef(false);
	const saving = useRef<Promise<unknown>>(Promise.resolve());

	/** Writes the current page to the server, creating the draft the first time. Calls are queued so they never overlap. */
	const persist = (asDraft: boolean) => {
		const body = { lovedOneId, type: "letter", title, content, photos, draft: asDraft };
		saving.current = saving.current
			.catch(() => {})
			.then(async () => {
				if (id.current) return api<Saved>("PATCH", `/entries/${id.current}`, body);
				const created = await api<Saved>("POST", "/entries", body);
				id.current = created.id;
				return created;
			});
		return saving.current as Promise<Saved>;
	};

	useEffect(() => {
		if (!dirty.current || (!content.trim() && !title.trim() && !photos.length)) return;
		const timer = setTimeout(() => {
			persist(true).then(
				() => setStatus(`Draft saved at ${new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`),
				() => setStatus("Couldn't save the draft just now. It will try again as you keep writing."),
			);
		}, 1500);
		return () => clearTimeout(timer);
		// persist reads the latest values through this effect's own closure.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [title, content, photos]);

	const edit = <T,>(set: (value: T) => void) => (value: T) => {
		dirty.current = true;
		set(value);
	};

	const finish = async () => {
		setError("");
		if (!content.trim() && !photos.length) {
			setError("There's nothing on the page yet.");
			return;
		}
		try {
			const saved = await persist(false);
			onSaved({ id: id.current, crisis: saved.crisis });
		} catch (err) {
			setError(message(err));
		}
	};

	return (
		<Card className="uc-letter">
			<input className="uc-title-input" value={title} onChange={(e) => edit(setTitle)(e.target.value)} placeholder="A title, if you'd like one" aria-label="Title" maxLength={200} />
			<textarea
				className="uc-page"
				value={content}
				onChange={(e) => edit(setContent)(e.target.value)}
				placeholder={`Dear ${about},`}
				aria-label={`Your letter to ${about}`}
				autoFocus
			/>
			<PhotoPicker photos={photos} onChange={edit(setPhotos)} />
			<p className="uc-quiet" aria-live="polite">
				{status || "Your letter saves itself as a draft while you write."}
			</p>
			{error && <p className="uc-error">{error}</p>}
			<div className="uc-row">
				<button type="button" className="uc-btn uc-primary" onClick={finish}>
					Save letter
				</button>
				<button type="button" className="uc-btn" onClick={onClose}>
					{id.current || dirty.current ? "Finish later" : "Close"}
				</button>
			</div>
		</Card>
	);
}

/** A memory: photographs, a few words, or both. */
export function Memory({ lovedOneId, about, onSaved, onClose }: { lovedOneId: string; about: string; onSaved: (saved: Saved) => void; onClose: () => void }) {
	const [title, setTitle] = useState("");
	const [content, setContent] = useState("");
	const [photos, setPhotos] = useState<Photo[]>([]);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const save = async () => {
		setBusy(true);
		setError("");
		try {
			onSaved(await api<Saved>("POST", "/entries", { lovedOneId, type: "memory", title, content, photos }));
		} catch (err) {
			setError(message(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card title={`A memory of ${about}`} intro="A photograph, a story, a small moment. As much or as little as you like.">
			<PhotoPicker photos={photos} onChange={setPhotos} />
			<label className="uc-field">
				A title, if you'd like one
				<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
			</label>
			<label className="uc-field">
				The memory
				<textarea value={content} onChange={(e) => setContent(e.target.value)} rows={5} placeholder="Every Christmas morning she made cinnamon rolls…" />
			</label>
			{error && <p className="uc-error">{error}</p>}
			<div className="uc-row">
				<button type="button" className="uc-btn uc-primary" onClick={save} disabled={busy || (!content.trim() && !photos.length)}>
					Save memory
				</button>
				<button type="button" className="uc-btn" onClick={onClose}>
					Not now
				</button>
			</div>
		</Card>
	);
}
