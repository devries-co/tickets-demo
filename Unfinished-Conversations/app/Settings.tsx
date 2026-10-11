import { type FormEvent, useState } from "react";
import { type ImportantDate, type LovedOne, type Photo, calls } from "../shared";
import { exportEverything } from "./exportArchive";
import { type Me, MONTHS, api, day, listenPageUrl, message, useAction, useLoad } from "./lib";
import { Card, Confirm, CopyButton, Notice, PhotoPicker } from "./ui";

type Link = { id: string; token: string; title: string; recordedAt: string; lovedOneName: string };

/** The form used both to begin ("Who would you like to remember?") and to edit a loved one later. */
export function LovedOneForm({ lovedOne, onSaved, onCancel }: { lovedOne?: LovedOne; onSaved: (id: string) => void; onCancel?: () => void }) {
	const [form, setForm] = useState({
		name: lovedOne?.name ?? "",
		nickname: lovedOne?.nickname ?? "",
		relationship: lovedOne?.relationship ?? "",
		birthDate: lovedOne?.birthDate ?? "",
		deathDate: lovedOne?.deathDate ?? "",
	});
	const [photo, setPhoto] = useState<Photo[]>(lovedOne?.photoAssetId ? [{ assetId: lovedOne.photoAssetId, caption: "" }] : []);
	const [more, setMore] = useState(!!lovedOne);
	const [error, setError] = useState("");

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const body = { ...form, photoAssetId: photo[0]?.assetId ?? null };
		try {
			if (lovedOne) {
				await api("PATCH", `/loved-ones/${lovedOne.id}`, body);
				onSaved(lovedOne.id);
			} else {
				onSaved((await api<{ id: string }>("POST", "/loved-ones", body)).id);
			}
		} catch (err) {
			setError(message(err));
		}
	};

	return (
		<form className="uc-form" onSubmit={submit}>
			<label className="uc-field">
				Their name
				<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={120} autoFocus={!lovedOne} />
			</label>
			<label className="uc-field">
				What you call them (optional)
				<input value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} placeholder="Dad, Nana, Sam" maxLength={60} />
			</label>
			{more ? (
				<>
					<label className="uc-field">
						Who they are to you (optional)
						<input value={form.relationship} onChange={(e) => setForm({ ...form, relationship: e.target.value })} placeholder="my father" maxLength={60} />
					</label>
					<div className="uc-field">
						<span>A photograph (optional)</span>
						<PhotoPicker single photos={photo} onChange={setPhoto} />
					</div>
					<div className="uc-row">
						<label className="uc-field">
							Born (optional)
							<input type="date" value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.target.value })} />
						</label>
						<label className="uc-field">
							Died (optional)
							<input type="date" value={form.deathDate} onChange={(e) => setForm({ ...form, deathDate: e.target.value })} />
						</label>
					</div>
				</>
			) : (
				<button type="button" className="uc-link" onClick={() => setMore(true)}>
					Add a photograph or dates (optional)
				</button>
			)}
			{error && <p className="uc-error">{error}</p>}
			<div className="uc-row">
				<button type="submit" className="uc-btn uc-primary">
					{lovedOne ? "Save changes" : "Begin"}
				</button>
				{onCancel && (
					<button type="button" className="uc-btn" onClick={onCancel}>
						Cancel
					</button>
				)}
			</div>
		</form>
	);
}

export default function Settings({ me, lovedOne, onChange, onAddLovedOne }: { me: Me; lovedOne: LovedOne; onChange: () => Promise<void>; onAddLovedOne: () => void }) {
	const home = useLoad<{ dates: ImportantDate[] }>(`/loved-ones/${lovedOne.id}/home`);
	const links = useLoad<{ links: Link[] }>("/share-links");
	const { act, notice, setNotice } = useAction(async () => {
		await Promise.all([onChange(), home.reload(), links.reload()]);
	});
	const [editing, setEditing] = useState(false);
	const [date, setDate] = useState({ label: "", month: 1, day: 1 });
	const [exporting, setExporting] = useState("");
	const about = calls(lovedOne);

	const runExport = async () => {
		setNotice("");
		try {
			await exportEverything(setExporting);
			setNotice("Your archive has been downloaded.");
		} catch (err) {
			setNotice(message(err));
		}
		setExporting("");
	};

	return (
		<>
			<Notice text={notice} />

			<Card title="AI assistance" intro="Off unless you turn it on. You can change your mind at any time.">
				<label className="uc-check">
					<input type="checkbox" checked={me.prefs.ai} onChange={(e) => act(() => api("PATCH", "/me", { ai: e.target.checked }), e.target.checked ? "AI assistance is on." : "AI assistance is off. Suggestions you hadn't accepted have been removed.")} />
					<span>Help me organise memories and suggest ways to carry them forward</span>
				</label>
				<ul className="uc-plain uc-quiet">
					<li>It only looks at an entry when you save it or ask. Nothing is analysed in the background.</li>
					<li>
						{me.aiService
							? "The words of that entry are sent to Anthropic's Claude to produce the suggestion, and are not used to train AI models."
							: "The AI service isn't connected yet, so suggestions currently come from simple keyword matching on our own server. Nothing is sent anywhere else."}
					</li>
					<li>It suggests categories and ideas. It never writes as {about}, never guesses what {about} would say, and never changes what you saved.</li>
					<li>Your memories are never sold, never used for advertising, and never shared unless you share them.</li>
				</ul>
			</Card>

			<Card title={`About ${about}`}>
				{editing ? (
					<LovedOneForm
						lovedOne={lovedOne}
						onCancel={() => setEditing(false)}
						onSaved={() => {
							setEditing(false);
							void onChange();
						}}
					/>
				) : (
					<div className="uc-row">
						<button type="button" className="uc-btn" onClick={() => setEditing(true)}>
							Edit name, photograph or dates
						</button>
						<button type="button" className="uc-btn" onClick={onAddLovedOne}>
							Remember someone else too
						</button>
					</div>
				)}
			</Card>

			<Card title="Important dates" intro="Birthdays, anniversaries, days that matter. Kept for you; shown on your home page only if you turn reminders on.">
				<label className="uc-check">
					<input type="checkbox" checked={me.prefs.reminders} onChange={(e) => act(() => api("PATCH", "/me", { reminders: e.target.checked }))} />
					<span>
						Show a gentle note on my home page when a date is near
						<span className="uc-quiet uc-block">Nothing is ever emailed, texted or pushed to your device.</span>
					</span>
				</label>
				<ul className="uc-list">
					{home.data?.dates.map((d) => (
						<li key={d.id}>
							<span>
								{d.label}
								<span className="uc-quiet"> · {MONTHS[d.month - 1]} {d.day}</span>
							</span>
							<button type="button" className="uc-link" onClick={() => act(() => api("DELETE", `/dates/${d.id}`))}>
								Remove
							</button>
						</li>
					))}
				</ul>
				<form
					className="uc-row"
					onSubmit={(e) => {
						e.preventDefault();
						void act(() => api("POST", `/loved-ones/${lovedOne.id}/dates`, date)).then((ok) => ok && setDate({ ...date, label: "" }));
					}}
				>
					<input value={date.label} onChange={(e) => setDate({ ...date, label: e.target.value })} placeholder={`${about}'s birthday`} aria-label="What is this day?" required maxLength={80} />
					<select value={date.month} onChange={(e) => setDate({ ...date, month: Number(e.target.value) })} aria-label="Month">
						{MONTHS.map((m, i) => (
							<option key={m} value={i + 1}>
								{m}
							</option>
						))}
					</select>
					<input type="number" min={1} max={31} value={date.day} onChange={(e) => setDate({ ...date, day: Number(e.target.value) })} aria-label="Day" />
					<button type="submit" className="uc-btn">
						Add date
					</button>
				</form>
			</Card>

			<Card title="Listening links" intro="Each QR code in a Legacy Book plays one recording for anyone who scans it. Switch one off here and its code stops working.">
				{links.data && !links.data.links.length && <p className="uc-quiet">There are none.</p>}
				<ul className="uc-list">
					{links.data?.links.map((l) => (
						<li key={l.id}>
							<span>
								{l.title || "Recorded message"}
								<span className="uc-quiet uc-block">
									For {l.lovedOneName} · recorded {day(l.recordedAt)}
								</span>
							</span>
							<span className="uc-row">
								<CopyButton text={listenPageUrl(l.token)} label="Copy link" />
								<Confirm quiet label="Switch off" confirm="Yes, switch it off" onConfirm={() => act(() => api("DELETE", `/share-links/${l.id}`))} />
							</span>
						</li>
					))}
				</ul>
			</Card>

			<Card title="Your memories are yours" intro="Take a complete copy whenever you like: every letter and transcript as text, and every recording and photograph as its original file.">
				<div className="uc-row">
					<button type="button" className="uc-btn uc-primary" onClick={runExport} disabled={!!exporting}>
						{exporting || "Export everything"}
					</button>
				</div>
			</Card>

			<Card title="Your account" intro={`Signed in as ${me.user?.email}`}>
				<div className="uc-stack">
					<button
						type="button"
						className="uc-btn"
						onClick={async () => {
							await api("POST", "/auth/logout");
							await onChange();
						}}
					>
						Sign out
					</button>
					<Confirm label={`Delete my conversations with ${about}`} confirm={`Yes, delete everything for ${about}`} onConfirm={() => act(() => api("DELETE", `/loved-ones/${lovedOne.id}`), "Deleted.")} />
					<Confirm
						label="Delete my account and everything in it"
						confirm="Yes, delete it all permanently"
						onConfirm={async () => {
							await api("DELETE", "/me").catch(() => {});
							await onChange();
						}}
					/>
				</div>
				<p className="uc-quiet">
					Deleting your account permanently removes every loved one, letter, recording, photograph, activity and book, and every story you added
					to a shared collection. Collections you own are deleted for all their members. Copies that you or others have already downloaded, printed
					or exported can't be recalled. It can't be undone, so consider exporting first.
				</p>
			</Card>
		</>
	);
}
