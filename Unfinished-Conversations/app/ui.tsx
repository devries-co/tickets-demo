import { type ChangeEvent, type ReactNode, useState } from "react";
import type { Photo } from "../shared";
import { mediaUrl, message, optimizeImage, upload } from "./lib";

export function Card({ title, intro, children, className }: { title?: string; intro?: string; children: ReactNode; className?: string }) {
	return (
		<section className={className ? `uc-card ${className}` : "uc-card"}>
			{title && <h2>{title}</h2>}
			{intro && <p className="uc-quiet">{intro}</p>}
			{children}
		</section>
	);
}

export function Notice({ text }: { text: string }) {
	return text ? (
		<p className="uc-notice" role="status" aria-live="polite">
			{text}
		</p>
	) : null;
}

/** A destructive action that asks once more inline, instead of opening a pop-up. */
export function Confirm({ label, confirm, onConfirm, quiet }: { label: string; confirm: string; onConfirm: () => void; quiet?: boolean }) {
	const [asking, setAsking] = useState(false);
	if (!asking) {
		return (
			<button type="button" className={quiet ? "uc-link uc-danger" : "uc-btn uc-danger"} onClick={() => setAsking(true)}>
				{label}
			</button>
		);
	}
	return (
		<span className="uc-row">
			<button
				type="button"
				className="uc-btn uc-danger"
				onClick={() => {
					setAsking(false);
					onConfirm();
				}}
			>
				{confirm}
			</button>
			<button type="button" className="uc-btn" onClick={() => setAsking(false)}>
				Keep it
			</button>
		</span>
	);
}

export function CopyButton({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="uc-btn"
			onClick={async () => {
				await navigator.clipboard.writeText(text).catch(() => {});
				setCopied(true);
				setTimeout(() => setCopied(false), 2500);
			}}
		>
			{copied ? "Copied" : label}
		</button>
	);
}

/** Shown only when something saved directly states an intent to self-harm. Never for ordinary grief. */
export function CrisisPanel({ onClose }: { onClose: () => void }) {
	return (
		<section className="uc-card uc-crisis" role="alert">
			<h2>You deserve a person with you right now</h2>
			<p>What you wrote has been saved, and it's private. If you are thinking about ending your life or harming yourself, please reach out to someone now.</p>
			<ul>
				<li>
					In the US, call or text <a href="tel:988">988</a> (Suicide &amp; Crisis Lifeline), any time.
				</li>
				<li>
					If you are in immediate danger, call <a href="tel:911">911</a> or your local emergency number.
				</li>
				<li>
					Outside the US, find a local line at{" "}
					<a href="https://findahelpline.com" target="_blank" rel="noreferrer">
						findahelpline.com
					</a>
					.
				</li>
				<li>If you can, tell someone you trust how you are feeling, and ask them to stay with you.</li>
			</ul>
			<button type="button" className="uc-btn" onClick={onClose}>
				Close
			</button>
		</section>
	);
}

export function PhotoGrid({ photos }: { photos: Photo[] }) {
	const [open, setOpen] = useState<Photo | null>(null);
	if (!photos.length) return null;
	return (
		<>
			<div className={photos.length === 1 ? "uc-photos uc-photos-one" : "uc-photos"}>
				{photos.map((p) => (
					<figure key={p.assetId}>
						<button type="button" onClick={() => setOpen(p)} aria-label={p.caption ? `Open photograph: ${p.caption}` : "Open photograph"}>
							<img src={mediaUrl(p.assetId)} alt={p.caption} loading="lazy" />
						</button>
						{p.caption && <figcaption>{p.caption}</figcaption>}
					</figure>
				))}
			</div>
			{open && (
				<div className="uc-lightbox" role="dialog" aria-label="Photograph" onClick={() => setOpen(null)}>
					<img src={mediaUrl(open.assetId)} alt={open.caption} />
					{open.caption && <p>{open.caption}</p>}
					<button type="button" className="uc-btn">
						Close
					</button>
				</div>
			)}
		</>
	);
}

/** Choose one or several photographs; each is optimised, uploaded, and can be given a caption. */
export function PhotoPicker({ photos, onChange, single }: { photos: Photo[]; onChange: (photos: Photo[]) => void; single?: boolean }) {
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");

	const choose = async (e: ChangeEvent<HTMLInputElement>) => {
		const files = [...(e.target.files ?? [])];
		e.target.value = "";
		setError("");
		const added: Photo[] = [];
		for (const [i, file] of files.entries()) {
			setBusy(files.length > 1 ? `Adding photograph ${i + 1} of ${files.length}` : "Adding photograph");
			try {
				added.push({ assetId: await upload(await optimizeImage(file), "image", { name: file.name }), caption: "" });
			} catch (err) {
				setError(message(err));
			}
		}
		setBusy("");
		if (added.length) onChange(single ? added.slice(-1) : [...photos, ...added]);
	};

	return (
		<div className="uc-picker">
			{photos.map((p, i) => (
				<div key={p.assetId} className="uc-picked">
					<img src={mediaUrl(p.assetId)} alt="" />
					{!single && (
						<input
							value={p.caption}
							onChange={(e) => onChange(photos.map((x, n) => (n === i ? { ...x, caption: e.target.value } : x)))}
							placeholder="A caption, if you'd like"
							aria-label="Caption"
							maxLength={300}
						/>
					)}
					<button type="button" className="uc-link" onClick={() => onChange(photos.filter((_, n) => n !== i))}>
						Remove
					</button>
				</div>
			))}
			<label className="uc-file">
				<input type="file" accept="image/jpeg,image/png,image/webp" multiple={!single} onChange={choose} disabled={!!busy} />
				<span className="uc-btn">{busy || (photos.length ? (single ? "Choose a different photograph" : "Add more photographs") : single ? "Choose a photograph" : "Add photographs")}</span>
			</label>
			{error && <p className="uc-error">{error}</p>}
		</div>
	);
}
