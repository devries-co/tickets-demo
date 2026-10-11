import { type FormEvent, useState } from "react";
import { type Connection, type Invitation, KIND_LABEL, NEEDS, api, firstName, formatDay, formatWhen, useAction, useLoad } from "./lib";
import { Card, ConfirmButton, InviteLink, Notice, Status } from "./ui";

type Member = {
	id: string;
	name: string;
	email: string;
	role: "griever" | "supporter" | "admin";
	relationship: string;
	status: "invited" | "active";
	inviteToken: string | null;
};

type Data = {
	circle: { id: string; name: string; status: string; grieverName: string };
	myMemberId: string;
	members: Member[];
	connections: Connection[];
	invitations: Invitation[];
	activity: { id: string; actorName: string; kind: string; createdAt: string }[];
	checkins: { id: string; needs: string[]; createdAt: string }[] | null;
};

const ROLE_LABEL = { griever: "This circle is for them", supporter: "Supporter", admin: "Administrator" };

export default function Admin({ circleId }: { circleId: string }) {
	const base = `/circles/${circleId}`;
	const { data, error, reload } = useLoad<Data>(`${base}/admin`);
	const { act, busy, notice } = useAction(reload);
	const [form, setForm] = useState({ name: "", email: "", relationship: "" });

	if (error) return <Notice text={error} />;
	if (!data) return <p className="rp-quiet">Loading…</p>;

	const name = firstName(data.circle.grieverName);
	const invite = (e: FormEvent) => {
		e.preventDefault();
		void act(async () => {
			await api("POST", `${base}/members`, { ...form, role: "supporter" });
			setForm({ name: "", email: "", relationship: "" });
		}, "Invitation created. Share their private link below.");
	};

	return (
		<>
			{notice && <Notice text={notice} />}
			{data.circle.status === "pending_consent" && (
				<p className="rp-banner">
					Waiting for {name} to accept. Nothing is scheduled and no one is asked to reach out until {name} agrees to this
					circle.
				</p>
			)}
			{data.circle.status === "paused" && <p className="rp-banner">{name} has paused support for now. Nothing is being scheduled.</p>}

			<Card title={data.circle.name} intro={`You help coordinate this circle for ${name}. ${name} decides who may be asked to reach out.`}>
				{data.members.map((m) => (
					<article key={m.id} className="rp-item">
						<h3>
							{m.name}
							<span className="rp-quiet">
								{" "}
								· {ROLE_LABEL[m.role]}
								{m.relationship && ` · ${m.relationship}`}
							</span>
						</h3>
						{m.status === "invited" && m.inviteToken ? (
							<>
								<p className="rp-quiet">Invited, not yet joined.</p>
								<InviteLink token={m.inviteToken} name={firstName(m.name)} />
							</>
						) : (
							<p className="rp-quiet">In the circle.</p>
						)}
						{m.role === "supporter" && (
							<ConfirmButton
								label="Remove from circle"
								confirm={`Yes, remove ${firstName(m.name)}`}
								onConfirm={() => act(() => api("DELETE", `${base}/members/${m.id}`), `${firstName(m.name)} has been removed.`)}
							/>
						)}
					</article>
				))}
			</Card>

			<Card title="Invite a supporter" intro={`${name} chooses whether each new supporter may be asked to reach out.`}>
				<form className="rp-form" onSubmit={invite}>
					<label className="rp-field">
						Their name
						<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={80} />
					</label>
					<label className="rp-field">
						Their email
						<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
					</label>
					<label className="rp-field">
						How they know {name} (optional)
						<input value={form.relationship} onChange={(e) => setForm({ ...form, relationship: e.target.value })} maxLength={40} />
					</label>
					<button type="submit" className="rp-btn rp-primary" disabled={busy}>
						Create invitation
					</button>
				</form>
			</Card>

			<Card title="Where things stand" intro="Each connection and its status. You can see that something happened, not why.">
				{!data.connections.length && <p>Nothing yet.</p>}
				<ul className="rp-list">
					{data.connections.map((c) => (
						<li key={c.id}>
							<span>
								{KIND_LABEL[c.kind]}
								{c.supporterName && <span className="rp-quiet"> · {firstName(c.supporterName)}</span>}
							</span>
							<Status value={c.status} />
						</li>
					))}
				</ul>
			</Card>

			<Card title="Schedule">
				{!data.invitations.length && <p>No invitations yet.</p>}
				<ul className="rp-list">
					{data.invitations.map((i) => (
						<li key={i.id}>
							<span>
								{i.activity} with {firstName(i.fromName)}
								<span className="rp-quiet rp-block">{formatWhen(i.proposedFor)}</span>
							</span>
							<Status value={i.status} />
						</li>
					))}
				</ul>
			</Card>

			<Card title="Check-ins">
				{data.checkins === null ? (
					<p>Private. {name} hasn't chosen to share check-ins with you, and that's entirely their decision.</p>
				) : (
					<>
						<p className="rp-quiet">{name} has chosen to share these with you. Please keep them in confidence.</p>
						{!data.checkins.length && <p>None yet.</p>}
						<ul className="rp-list">
							{data.checkins.map((c) => (
								<li key={c.id}>
									<span>{c.needs.map((n) => NEEDS.find(([id]) => id === n)?.[1] ?? n).join(", ")}</span>
									<span className="rp-quiet">{formatDay(c.createdAt)}</span>
								</li>
							))}
						</ul>
					</>
				)}
			</Card>

			<Card title="Recent activity">
				{!data.activity.length && <p>Nothing yet.</p>}
				<ul className="rp-list">
					{data.activity.map((a) => (
						<li key={a.id}>
							<span>
								{firstName(a.actorName)} {a.kind}
							</span>
							<span className="rp-quiet">{formatDay(a.createdAt)}</span>
						</li>
					))}
				</ul>
			</Card>
		</>
	);
}
