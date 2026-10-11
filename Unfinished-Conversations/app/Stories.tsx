import { type FormEvent, useEffect, useState } from "react";
import type { Photo } from "../shared";
import Recorder, { type Recording } from "./Recorder";
import { api, clock, day, inviteUrl, mediaUrl, useAction, useLoad } from "./lib";
import { Card, Confirm, CopyButton, Notice, PhotoGrid, PhotoPicker } from "./ui";

type Summary = { id: string; name: string; about: string; description: string; role: string; stories: number; people: number };
type Member = { id: string; name: string; email: string; role: "owner" | "contributor" | "viewer"; status: string; inviteToken: string | null };
type Story = { id: string; userId: string; authorName: string; title: string; content: string; audioAssetId: string | null; durationMs: number | null; createdAt: string; photos: Photo[] };
type Detail = { collection: { id: string; name: string; about: string; description: string }; role: Member["role"]; myUserId: string; members: Member[]; stories: Story[] };

const ROLE = { owner: "Owner", contributor: "Can add stories", viewer: "Can read and listen" };

function StoryCard({ story, mine, owner, act }: { story: Story; mine: boolean; owner: boolean; act: ReturnType<typeof useAction>["act"] }) {
	const [edit, setEdit] = useState<{ title: string; content: string } | null>(null);
	return (
		<article className="uc-entry">
			<p className="uc-label">
				Shared by {story.authorName} · {day(story.createdAt)}
				{story.durationMs ? ` · ${clock(story.durationMs)}` : ""}
			</p>
			{edit ? (
				<div className="uc-form">
					<input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="Title" aria-label="Title" />
					<textarea value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} rows={6} aria-label="Your story" />
					<div className="uc-row">
						<button type="button" className="uc-btn uc-primary" onClick={() => act(() => api("PATCH", `/contributions/${story.id}`, edit)).then((ok) => ok && setEdit(null))}>
							Save changes
						</button>
						<button type="button" className="uc-btn" onClick={() => setEdit(null)}>
							Cancel
						</button>
					</div>
				</div>
			) : (
				<>
					{story.title && <h3>{story.title}</h3>}
					{story.audioAssetId && <audio controls preload="none" src={mediaUrl(story.audioAssetId)} className="uc-audio" />}
					<PhotoGrid photos={story.photos} />
					{story.content && <p className="uc-words">{story.content}</p>}
				</>
			)}
			{!edit && (mine || owner) && (
				<footer className="uc-row">
					{mine && (
						<button type="button" className="uc-link" onClick={() => setEdit({ title: story.title, content: story.content })}>
							Edit
						</button>
					)}
					<Confirm quiet label="Remove from the collection" confirm="Yes, remove" onConfirm={() => act(() => api("DELETE", `/contributions/${story.id}`))} />
				</footer>
			)}
		</article>
	);
}

function Collection({ id, onBack }: { id: string; onBack: () => void }) {
	const [typed, setTyped] = useState("");
	const [q, setQ] = useState("");
	const { data, error, reload } = useLoad<Detail>(`/collections/${id}?q=${encodeURIComponent(q)}`);
	const { act, notice, setNotice } = useAction(reload);
	const [adding, setAdding] = useState<"" | "write" | "record">("");
	const [story, setStory] = useState({ title: "", content: "", photos: [] as Photo[] });
	const [invite, setInvite] = useState({ name: "", email: "", role: "contributor" });
	const [people, setPeople] = useState(false);

	useEffect(() => {
		const timer = setTimeout(() => setQ(typed.trim()), 300);
		return () => clearTimeout(timer);
	}, [typed]);

	if (error) return <Notice text={error} />;
	if (!data) return <p className="uc-quiet">Loading…</p>;
	const { collection, role, members, stories } = data;
	const canAdd = role !== "viewer";
	const base = `/collections/${id}`;

	const share = (e: FormEvent) => {
		e.preventDefault();
		void act(() => api("POST", `${base}/contributions`, story), "Shared with the collection.").then((ok) => {
			if (ok) {
				setStory({ title: "", content: "", photos: [] });
				setAdding("");
			}
		});
	};

	const shareRecording = async (rec: Recording) => {
		await api("POST", `${base}/contributions`, { title: rec.title, content: rec.transcript, audioAssetId: rec.assetId });
		setAdding("");
		setNotice("Your recording has been shared with the collection.");
		await reload();
	};

	return (
		<>
			<button type="button" className="uc-link" onClick={onBack}>
				← All collections
			</button>
			<Card title={collection.name} intro={collection.description || (collection.about ? `Stories about ${collection.about}, from the people who knew them.` : undefined)}>
				<input type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search these stories" aria-label="Search these stories" />
				{canAdd && adding === "" && (
					<div className="uc-row">
						<button type="button" className="uc-btn uc-primary" onClick={() => setAdding("write")}>
							Add a story or photographs
						</button>
						<button type="button" className="uc-btn" onClick={() => setAdding("record")}>
							Record a story
						</button>
					</div>
				)}
				{!canAdd && <p className="uc-quiet">You can read and listen here. The collection's owner can let you add stories too.</p>}
				<Notice text={notice} />
			</Card>

			{adding === "write" && (
				<Card title="A story for the family" intro="Everyone in this collection will be able to see it, with your name.">
					<form className="uc-form" onSubmit={share}>
						<input value={story.title} onChange={(e) => setStory({ ...story, title: e.target.value })} placeholder="A title, if you'd like one" aria-label="Title" maxLength={200} />
						<textarea value={story.content} onChange={(e) => setStory({ ...story, content: e.target.value })} rows={6} placeholder="The Christmas she…" aria-label="Your story" />
						<PhotoPicker photos={story.photos} onChange={(photos) => setStory({ ...story, photos })} />
						<div className="uc-row">
							<button type="submit" className="uc-btn uc-primary" disabled={!story.content.trim() && !story.photos.length}>
								Share with the collection
							</button>
							<button type="button" className="uc-btn" onClick={() => setAdding("")}>
								Cancel
							</button>
						</div>
					</form>
				</Card>
			)}
			{adding === "record" && <Recorder about={collection.about || "the family"} saveLabel="Share with the collection" onSave={shareRecording} onCancel={() => setAdding("")} />}

			{!stories.length && <Card>{q ? <p>Nothing matches “{q}”.</p> : <p className="uc-quiet">No stories yet. The first one is often the hardest, and the most welcome.</p>}</Card>}
			{stories.map((s) => (
				<StoryCard key={s.id} story={s} mine={s.userId === data.myUserId} owner={role === "owner"} act={act} />
			))}

			<Card>
				<button type="button" className="uc-link" onClick={() => setPeople(!people)}>
					{people ? "Hide" : "Show"} who's here ({members.filter((m) => m.status === "active").length})
				</button>
				{people && (
					<>
						<ul className="uc-list">
							{members.map((m) => (
								<li key={m.id} className="uc-member">
									<span>
										{m.name}
										<span className="uc-quiet uc-block">
											{m.status === "invited" ? "Invited, not yet joined" : ROLE[m.role]}
											{m.email && ` · ${m.email}`}
										</span>
									</span>
									{role === "owner" && m.role !== "owner" && (
										<span className="uc-row">
											{m.inviteToken && <CopyButton text={inviteUrl(m.inviteToken)} label="Copy invitation link" />}
											<select value={m.role} onChange={(e) => act(() => api("PATCH", `${base}/members/${m.id}`, { role: e.target.value }))} aria-label={`Access for ${m.name}`}>
												<option value="contributor">Can add stories</option>
												<option value="viewer">Can read and listen</option>
											</select>
											<Confirm quiet label="Remove access" confirm="Yes, remove" onConfirm={() => act(() => api("DELETE", `${base}/members/${m.id}`))} />
										</span>
									)}
								</li>
							))}
						</ul>

						{role === "owner" && (
							<form
								className="uc-form"
								onSubmit={(e) => {
									e.preventDefault();
									void act(() => api("POST", `${base}/members`, invite), "Invitation created. Copy their private link above and send it however you like.").then((ok) => ok && setInvite({ name: "", email: "", role: "contributor" }));
								}}
							>
								<h3>Invite someone</h3>
								<p className="uc-quiet">No email is sent for you. You'll get a private link to pass on yourself, and they'll also see the invitation if they sign in with this email address.</p>
								<input value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} placeholder="Their name" aria-label="Their name" required />
								<input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} placeholder="Their email" aria-label="Their email" required />
								<select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })} aria-label="What they can do">
									<option value="contributor">They can add their own stories</option>
									<option value="viewer">They can read and listen only</option>
								</select>
								<button type="submit" className="uc-btn uc-primary">
									Create invitation
								</button>
							</form>
						)}

						<h3>How sharing works here</h3>
						<ul className="uc-plain uc-quiet">
							<li>Only what someone deliberately adds is here. Nobody's private conversations are ever visible.</li>
							<li>Each story belongs to the person who shared it. Only they can change it; they or the owner can remove it.</li>
							<li>If someone leaves, they choose whether their stories stay with the family or leave with them.</li>
							<li>If the owner deletes the collection, it is gone for everyone. Private originals are not affected.</li>
						</ul>

						{role === "owner" ? (
							<Confirm label="Delete this collection for everyone" confirm="Yes, delete the collection" onConfirm={() => act(() => api("DELETE", base)).then((ok) => ok && onBack())} />
						) : (
							<div className="uc-row">
								<Confirm label="Leave, and keep my stories here" confirm="Yes, leave" onConfirm={() => api("POST", `${base}/leave`, { removeMine: false }).then(onBack, () => {})} />
								<Confirm label="Leave, and take my stories with me" confirm="Yes, leave and remove them" onConfirm={() => api("POST", `${base}/leave`, { removeMine: true }).then(onBack, () => {})} />
							</div>
						)}
					</>
				)}
			</Card>
		</>
	);
}

/** Our Stories: shared collections, entirely separate from anyone's private conversations. */
export default function Stories({ suggestedAbout, onChange }: { suggestedAbout: string; onChange: () => void }) {
	const { data, error, reload } = useLoad<{ collections: Summary[] }>("/collections");
	const { act, notice } = useAction(reload);
	const [open, setOpen] = useState("");
	const [form, setForm] = useState({ name: `Remembering ${suggestedAbout}`, about: suggestedAbout, description: "" });

	if (open) {
		return (
			<Collection
				id={open}
				onBack={() => {
					setOpen("");
					void reload();
					onChange();
				}}
			/>
		);
	}

	return (
		<>
			<Card title="Our Stories" intro="A shared place where family and friends each add their own memories of the same person. Your private conversations never appear here unless you choose to share a copy.">
				{data && !data.collections.length && <p className="uc-quiet">You're not part of a shared collection yet.</p>}
				<ul className="uc-list">
					{data?.collections.map((k) => (
						<li key={k.id}>
							<button type="button" className="uc-link" onClick={() => setOpen(k.id)}>
								{k.name}
							</button>
							<span className="uc-quiet">
								{k.stories} {k.stories === 1 ? "story" : "stories"} · {k.people} {k.people === 1 ? "person" : "people"}
							</span>
						</li>
					))}
				</ul>
				<Notice text={notice || error} />
			</Card>
			<Card title="Start a collection">
				<form
					className="uc-form"
					onSubmit={(e) => {
						e.preventDefault();
						void act(async () => {
							const created = await api<{ id: string }>("POST", "/collections", form);
							setOpen(created.id);
							onChange();
						});
					}}
				>
					<label className="uc-field">
						Its name
						<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={100} />
					</label>
					<label className="uc-field">
						Who it's about
						<input value={form.about} onChange={(e) => setForm({ ...form, about: e.target.value })} maxLength={120} />
					</label>
					<label className="uc-field">
						A few words for the people you invite (optional)
						<input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={400} />
					</label>
					<button type="submit" className="uc-btn uc-primary">
						Create collection
					</button>
				</form>
			</Card>
		</>
	);
}
