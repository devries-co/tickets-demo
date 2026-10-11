import { type ChangeEvent, type FormEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { MAX_NAME, MAX_PHOTO_BYTES, MAX_WORDS, type Memorial, countWords } from "../shared/text";
import { BASE, api, message, mine } from "./api";
import { Panel, Portrait } from "./parts";

const VIEW = 220;
const OUTPUT = 512;

type Crop = { zoom: number; x: number; y: number };

/** Renders the chosen square of the image at 512px. Re-encoding also strips location and camera data from the file. */
function exportCrop(image: HTMLImageElement, crop: Crop) {
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = OUTPUT;
	const ctx = canvas.getContext("2d")!;
	const cover = Math.max(VIEW / image.naturalWidth, VIEW / image.naturalHeight) * crop.zoom;
	const k = OUTPUT / VIEW;
	ctx.fillStyle = "#000";
	ctx.fillRect(0, 0, OUTPUT, OUTPUT);
	ctx.drawImage(
		image,
		(VIEW / 2 + crop.x - (image.naturalWidth * cover) / 2) * k,
		(VIEW / 2 + crop.y - (image.naturalHeight * cover) / 2) * k,
		image.naturalWidth * cover * k,
		image.naturalHeight * cover * k,
	);
	for (const [type, quality] of [["image/webp", 0.86], ["image/jpeg", 0.86], ["image/jpeg", 0.7], ["image/jpeg", 0.5]] as const) {
		const url = canvas.toDataURL(type, quality);
		// Browsers without WebP encoding silently return a PNG; skip to JPEG in that case.
		if (url.startsWith(`data:${type}`) && url.length * 0.75 < MAX_PHOTO_BYTES) return url;
	}
	return "";
}

/** Drag to reposition, slide to zoom. Reports the cropped photo whenever the framing settles. */
function Cropper({ image, onCrop }: { image: HTMLImageElement; onCrop: (dataUrl: string) => void }) {
	const [crop, setCrop] = useState<Crop>({ zoom: 1, x: 0, y: 0 });
	const drag = useRef<{ x: number; y: number } | null>(null);
	const cover = Math.max(VIEW / image.naturalWidth, VIEW / image.naturalHeight) * crop.zoom;
	const w = image.naturalWidth * cover;
	const h = image.naturalHeight * cover;

	// Keep the photo covering the frame: no empty edges.
	const bound = (next: Crop): Crop => {
		const c = Math.max(VIEW / image.naturalWidth, VIEW / image.naturalHeight) * next.zoom;
		const mx = Math.max(0, (image.naturalWidth * c - VIEW) / 2);
		const my = Math.max(0, (image.naturalHeight * c - VIEW) / 2);
		return { zoom: next.zoom, x: Math.min(mx, Math.max(-mx, next.x)), y: Math.min(my, Math.max(-my, next.y)) };
	};
	const settle = (next: Crop) => onCrop(exportCrop(image, next));

	useEffect(() => {
		onCrop(exportCrop(image, { zoom: 1, x: 0, y: 0 }));
		// Only when a new image is chosen.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [image]);

	const onMove = (e: PointerEvent) => {
		if (!drag.current) return;
		const next = bound({ ...crop, x: crop.x + e.clientX - drag.current.x, y: crop.y + e.clientY - drag.current.y });
		drag.current = { x: e.clientX, y: e.clientY };
		setCrop(next);
	};

	return (
		<div className="nf-cropper">
			<div
				className="nf-crop-frame"
				style={{ width: VIEW, height: VIEW }}
				onPointerDown={(e) => {
					e.currentTarget.setPointerCapture(e.pointerId);
					drag.current = { x: e.clientX, y: e.clientY };
				}}
				onPointerMove={onMove}
				onPointerUp={() => {
					drag.current = null;
					settle(crop);
				}}
			>
				<img src={image.src} alt="" draggable={false} style={{ width: w, height: h, left: VIEW / 2 + crop.x - w / 2, top: VIEW / 2 + crop.y - h / 2 }} />
			</div>
			<label className="nf-zoom">
				Zoom
				<input
					type="range"
					min={1}
					max={4}
					step={0.01}
					value={crop.zoom}
					onChange={(e) => {
						const next = bound({ ...crop, zoom: Number(e.target.value) });
						setCrop(next);
						settle(next);
					}}
				/>
			</label>
			<p className="nf-muted">Drag the photo to reposition it.</p>
		</div>
	);
}

type Result = { token: string; status: "pending" | "published"; id?: string };

export default function AddForm({
	initialName,
	onClose,
	onFind,
}: {
	initialName: string;
	onClose: () => void;
	/** "Find Their Place on Earth" for a memorial that was published straight away. */
	onFind: (memorial: Memorial) => void;
}) {
	const [step, setStep] = useState<"edit" | "preview" | "done">("edit");
	const [form, setForm] = useState({ name: initialName, text: "", email: "", contactOk: false, isMinor: false, website: "" });
	const [image, setImage] = useState<HTMLImageElement | null>(null);
	const [photo, setPhoto] = useState("");
	const [consent, setConsent] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<Result | null>(null);
	const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
	const words = countWords(form.text);
	const statusLink = result ? `${window.location.origin}${BASE}/submission/${result.token}` : "";

	const choose = (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		setError("");
		if (!file) return;
		if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
			setError("Please choose a JPG, PNG or WebP photo.");
			return;
		}
		const img = new Image();
		img.onload = () => setImage(img);
		img.onerror = () => setError("That photo couldn't be opened. Please try another.");
		img.src = URL.createObjectURL(file);
	};

	const toPreview = (e: FormEvent) => {
		e.preventDefault();
		if (words > MAX_WORDS) return;
		setError("");
		setStep("preview");
	};

	const submit = async () => {
		setBusy(true);
		setError("");
		try {
			const res = await api<Result>("POST", "/memorials", { ...form, photo: image ? photo : null, consent });
			mine.add(res.token);
			setResult(res);
			setStep("done");
		} catch (err) {
			setError(message(err));
		} finally {
			setBusy(false);
		}
	};

	const find = async () => {
		if (!result?.id) return;
		try {
			const { memorial } = await api<{ memorial: Memorial }>("GET", `/memorial/${result.id}`);
			mine.remove(result.token);
			onFind(memorial);
		} catch (err) {
			setError(message(err));
		}
	};

	if (step === "done" && result) {
		return (
			<Panel title={result.status === "published" ? "Their name is now part of our world." : "Thank you."} onClose={onClose}>
				{result.status === "published" ? (
					<button type="button" className="nf-btn nf-gold" onClick={find}>
						Find Their Place on Earth
					</button>
				) : (
					<>
						<p>
							{form.name}'s memorial has been received. Each one is read by a person before it joins the Earth, to keep this
							a place of respect.
						</p>
						<p>
							Keep this private link. Once the memorial is published it will take you straight to their place on Earth,
							and this browser will offer it too.
						</p>
						<code className="nf-code">{statusLink}</code>
						<button type="button" className="nf-btn" onClick={() => navigator.clipboard.writeText(statusLink).catch(() => {})}>
							Copy link
						</button>
					</>
				)}
				{error && <p className="nf-error">{error}</p>}
			</Panel>
		);
	}

	if (step === "preview") {
		return (
			<Panel title="Does this look right?" onClose={onClose}>
				<div className="nf-preview">
					{image && photo ? <img className="nf-portrait" src={photo} alt="" width={132} height={132} /> : <Portrait memorial={null} size={132} />}
					<h3>{form.name}</h3>
					<p className="nf-words">{form.text}</p>
				</div>
				<label className="nf-check">
					<input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
					<span>I have permission to share this name{image ? ", photo" : ""} and memorial text, and I agree to it being shown publicly.</span>
				</label>
				{error && <p className="nf-error">{error}</p>}
				<div className="nf-actions">
					<button type="button" className="nf-btn nf-gold" disabled={!consent || busy} onClick={submit}>
						Add to Earth
					</button>
					<button type="button" className="nf-btn" onClick={() => setStep("edit")}>
						Edit Memorial
					</button>
				</div>
			</Panel>
		);
	}

	return (
		<Panel title="Add Someone to Our World" onClose={onClose}>
			<p className="nf-muted">Every name is a life remembered. Add someone you love to this growing memorial.</p>
			<form className="nf-form" onSubmit={toPreview}>
				<label>
					Their full name
					<input value={form.name} onChange={(e) => set({ name: e.target.value })} required maxLength={MAX_NAME} autoComplete="off" />
				</label>

				<div className="nf-field">
					<span>A photo (optional, but it means a lot)</span>
					{image ? <Cropper image={image} onCrop={setPhoto} /> : null}
					<label className="nf-file">
						<input type="file" accept="image/jpeg,image/png,image/webp" onChange={choose} />
						<span className="nf-btn">{image ? "Choose a different photo" : "Choose a photo"}</span>
					</label>
					{image && (
						<button type="button" className="nf-link" onClick={() => setImage(null)}>
							Remove photo
						</button>
					)}
				</div>

				<label>
					A few words of remembrance
					<textarea
						value={form.text}
						onChange={(e) => set({ text: e.target.value })}
						rows={3}
						required
						placeholder="Her kindness filled every room. She loved deeply, laughed often, and made everyone feel they belonged."
					/>
					<span className={words > MAX_WORDS ? "nf-count nf-over" : "nf-count"} aria-live="polite">
						{words} of {MAX_WORDS} words{words > MAX_WORDS ? ". Please shorten it a little." : ""}
					</span>
				</label>

				<label>
					Your email (optional, never shown publicly)
					<input type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} autoComplete="email" />
				</label>
				{form.email && (
					<label className="nf-check">
						<input type="checkbox" checked={form.contactOk} onChange={(e) => set({ contactOk: e.target.checked })} />
						<span>You may contact me about this memorial.</span>
					</label>
				)}
				<label className="nf-check">
					<input type="checkbox" checked={form.isMinor} onChange={(e) => set({ isMinor: e.target.checked })} />
					<span>This memorial is for a child (under 18). We review these with extra care.</span>
				</label>

				{/* Left empty by people; filled in by automated form-fillers. */}
				<input className="nf-trap" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={(e) => set({ website: e.target.value })} />

				{error && <p className="nf-error">{error}</p>}
				<button type="submit" className="nf-btn nf-gold" disabled={words > MAX_WORDS || (!!image && !photo)}>
					Preview Memorial
				</button>
			</form>
		</Panel>
	);
}
