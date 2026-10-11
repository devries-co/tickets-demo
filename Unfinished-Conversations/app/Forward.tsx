import { type FormEvent, useState } from "react";
import { type Activity, type LovedOne, type Photo, calls } from "../shared";
import { api, day, useAction, useLoad } from "./lib";
import { Card, Confirm, CrisisPanel, Notice, PhotoGrid, PhotoPicker } from "./ui";

function ActivityCard({ activity, act }: { activity: Activity; act: ReturnType<typeof useAction>["act"] }) {
	const [reflecting, setReflecting] = useState(false);
	const [text, setText] = useState("");
	const [photo, setPhoto] = useState<Photo[]>([]);
	const [crisis, setCrisis] = useState(false);
	const path = `/activities/${activity.id}`;
	const tradition = activity.kind === "tradition";

	const addNote = async () => {
		const ok = await act(async () => {
			const res = await api<{ crisis: boolean }>("POST", `${path}/notes`, { text, assetId: photo[0]?.assetId });
			setCrisis(res.crisis);
		});
		if (ok) {
			setText("");
			setPhoto([]);
			setReflecting(false);
		}
	};

	return (
		<article className="uc-entry">
			{crisis && <CrisisPanel onClose={() => setCrisis(false)} />}
			<p className="uc-label">
				{tradition ? "A tradition to remember" : activity.status === "done" ? "Something I did" : "Something I'd like to do"}
				{activity.plannedDate ? ` · ${day(activity.plannedDate + "T12:00:00")}` : activity.status === "open" ? " · Someday" : ""}
			</p>
			<h3>{activity.description}</h3>

			{activity.notes.map((n) => (
				<div key={n.id} className="uc-note">
					<p className="uc-label">{day(n.createdAt)}</p>
					{n.text && <p className="uc-words">{n.text}</p>}
					{n.assetId && <PhotoGrid photos={[{ assetId: n.assetId, caption: "" }]} />}
					<Confirm quiet label="Remove this reflection" confirm="Yes, remove" onConfirm={() => act(() => api("DELETE", `/activity-notes/${n.id}`))} />
				</div>
			))}

			{reflecting && (
				<div className="uc-form">
					<label className="uc-field">
						How it was, in your own words
						<textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} />
					</label>
					<PhotoPicker single photos={photo} onChange={setPhoto} />
					<div className="uc-row">
						<button type="button" className="uc-btn uc-primary" disabled={!text.trim() && !photo.length} onClick={addNote}>
							Save reflection
						</button>
						<button type="button" className="uc-btn" onClick={() => setReflecting(false)}>
							Cancel
						</button>
					</div>
				</div>
			)}

			{!reflecting && (
				<footer className="uc-row">
					{activity.status === "open" && !tradition && (
						<button type="button" className="uc-link" onClick={() => act(() => api("PATCH", path, { status: "done" }))}>
							I did this
						</button>
					)}
					{activity.status === "done" && (
						<button type="button" className="uc-link" onClick={() => act(() => api("PATCH", path, { status: "open" }))}>
							Return to this
						</button>
					)}
					<button type="button" className="uc-link" onClick={() => setReflecting(true)}>
						{tradition ? "Add this year's reflection" : "Add a reflection or photograph"}
					</button>
					<label className="uc-inline">
						<span className="uc-quiet">A date, if you'd like</span>
						<input type="date" value={activity.plannedDate ?? ""} onChange={(e) => act(() => api("PATCH", path, { plannedDate: e.target.value || null }))} />
					</label>
					<button type="button" className="uc-link" onClick={() => act(() => api("PATCH", path, { kind: tradition ? "someday" : "tradition" }))}>
						{tradition ? "Not a yearly tradition" : "Make this a tradition"}
					</button>
					{activity.status === "archived" ? (
						<button type="button" className="uc-link" onClick={() => act(() => api("PATCH", path, { status: "open" }))}>
							Bring back
						</button>
					) : (
						<button type="button" className="uc-link" onClick={() => act(() => api("PATCH", path, { status: "archived" }))}>
							Set aside
						</button>
					)}
					<Confirm quiet label="Delete" confirm="Yes, delete this" onConfirm={() => act(() => api("DELETE", path))} />
				</footer>
			)}
		</article>
	);
}

/** "Ways I'm Carrying Them Forward". No goals, no streaks: just things worth doing, whenever, or never. */
export default function Forward({ lovedOne }: { lovedOne: LovedOne }) {
	const { data, error, reload } = useLoad<{ activities: Activity[] }>(`/loved-ones/${lovedOne.id}/activities`);
	const { act, notice } = useAction(reload);
	const [description, setDescription] = useState("");
	const [tradition, setTradition] = useState(false);
	const [showAside, setShowAside] = useState(false);
	const about = calls(lovedOne);

	const add = (e: FormEvent) => {
		e.preventDefault();
		void act(() => api("POST", "/activities", { lovedOneId: lovedOne.id, description, kind: tradition ? "tradition" : "someday" })).then((ok) => ok && setDescription(""));
	};

	const all = data?.activities ?? [];
	const groups: [string, Activity[]][] = [
		["Someday", all.filter((a) => a.status === "open" && a.kind === "someday")],
		["Traditions to remember", all.filter((a) => a.status !== "archived" && a.kind === "tradition")],
		["Things I've done", all.filter((a) => a.status === "done" && a.kind === "someday")],
	];
	const aside = all.filter((a) => a.status === "archived");

	return (
		<>
			<Card title={`Ways I'm Carrying ${about} Forward`} intro="Small things that keep someone's influence alive. None of them are tasks, and there's no right time.">
				<form className="uc-form" onSubmit={add}>
					<label className="uc-field">
						Something I'd like to do
						<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={`Make ${about}'s cinnamon rolls on Christmas morning`} maxLength={300} required />
					</label>
					<label className="uc-check">
						<input type="checkbox" checked={tradition} onChange={(e) => setTradition(e.target.checked)} />
						<span>This is a tradition to return to each year</span>
					</label>
					<button type="submit" className="uc-btn uc-primary">
						Save this idea
					</button>
				</form>
				<Notice text={notice || error} />
			</Card>

			{data && !all.length && (
				<Card>
					<p className="uc-quiet">Nothing here yet, and that's fine. When you save a memory, you can choose to carry it forward.</p>
				</Card>
			)}

			{groups.map(
				([title, list]) =>
					list.length > 0 && (
						<section key={title} className="uc-month">
							<h2 className="uc-month-name">{title}</h2>
							{list.map((a) => (
								<ActivityCard key={a.id} activity={a} act={act} />
							))}
						</section>
					),
			)}

			{aside.length > 0 && (
				<section className="uc-month">
					<button type="button" className="uc-link" onClick={() => setShowAside(!showAside)}>
						{showAside ? "Hide" : "Show"} {aside.length} set aside
					</button>
					{showAside && aside.map((a) => <ActivityCard key={a.id} activity={a} act={act} />)}
				</section>
			)}
		</>
	);
}
