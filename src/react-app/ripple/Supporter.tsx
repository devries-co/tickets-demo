import { type FormEvent, useState } from "react";
import { MONTHS, api, firstName, formatWhen, useAction, useLoad } from "./lib";
import { Card, ConfirmButton, CopyButton, Notice, Status } from "./ui";

type Circle = {
	memberId: string;
	role: string;
	availability: string;
	circleId: string;
	circleName: string;
	grieverName: string;
	circleStatus: string;
};

type Opportunity = {
	id: string;
	kind: string;
	circleId: string;
	grieverName: string;
	title: string;
	body: string;
	suggestedMessage: string;
};

type Commitment = {
	opportunityId: string;
	kind: string;
	status: string;
	circleId: string;
	grieverName: string;
	title: string | null;
	suggestedMessage: string | null;
	invitationId: string | null;
	activity: string | null;
	proposedFor: string | null;
	invitationStatus: string | null;
};

type Data = {
	circles: Circle[];
	opportunities: Opportunity[];
	commitments: Commitment[];
	dates: { id: string; label: string; month: number; day: number; grieverName: string; daysAway: number }[];
	activities: string[];
};

const AVAILABILITY: [string, string][] = [
	["flexible", "Flexible"],
	["weekdays", "Weekdays"],
	["evenings", "Evenings"],
	["weekends", "Weekends"],
	["unavailable", "Not available right now"],
];

const GUIDANCE: [string, string][] = [
	["Show up without an agenda", "You don't need the right words. A short, honest \"thinking of you\" does more than a careful speech."],
	["Offer something specific", "\"I'm going to the store Thursday, can I bring you anything?\" is easier to answer than \"let me know if you need anything.\""],
	["Don't expect a reply", "Silence usually means tired, not ungrateful. Reach out again another time without mentioning the last one."],
	["Say their person's name", "People who are grieving often fear their loved one will be forgotten. A memory you share can be a gift."],
	["Keep going after the first weeks", "The casseroles stop long before the grief does. A note in month four can matter more than one in week one."],
	["Let tears be", "You don't have to fix them or stop them. Staying in the room is the help."],
];

/** Activity, date, time and an optional note. Used for "Just Be There" and for following up a commitment. */
function InviteForm({
	circleId,
	name,
	activities,
	opportunityId,
	onSend,
	busy,
}: {
	circleId: string;
	name: string;
	activities: string[];
	opportunityId?: string;
	onSend: (fn: () => Promise<unknown>, done: string) => Promise<boolean>;
	busy: boolean;
}) {
	const [activity, setActivity] = useState(activities[0] ?? "");
	const [date, setDate] = useState("");
	const [time, setTime] = useState("10:00");
	const [note, setNote] = useState("");

	const submit = (e: FormEvent) => {
		e.preventDefault();
		void onSend(
			() =>
				api("POST", `/circles/${circleId}/invitations`, {
					activity,
					proposedFor: new Date(`${date}T${time}`).toISOString(),
					note,
					opportunityId,
				}),
			`Invitation sent. ${name} can answer whenever they're ready, and no reply isn't a no.`,
		);
	};

	return (
		<form className="rp-form" onSubmit={submit}>
			<p className="rp-quiet">
				{name} doesn't have to talk about anything. Sometimes just being together is enough. Nothing is confirmed until{" "}
				{name} says yes.
			</p>
			<label className="rp-field">
				What would you like to do?
				<select value={activity} onChange={(e) => setActivity(e.target.value)}>
					{activities.map((a) => (
						<option key={a}>{a}</option>
					))}
				</select>
			</label>
			<div className="rp-row">
				<label className="rp-field">
					Day
					<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
				</label>
				<label className="rp-field">
					Time
					<input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
				</label>
			</div>
			<label className="rp-field">
				A short note (optional)
				<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="I'll bring the coffee." />
			</label>
			<button type="submit" className="rp-btn rp-primary" disabled={busy}>
				Send invitation
			</button>
		</form>
	);
}

export default function Supporter({ onChange }: { onChange: () => void }) {
	const { data, error, reload } = useLoad<Data>("/supporter");
	const { act, busy, notice } = useAction(reload);
	const [open, setOpen] = useState("");

	if (error) return <Notice text={error} />;
	if (!data) return <p className="rp-quiet">Loading…</p>;

	const send = async (fn: () => Promise<unknown>, done: string) => {
		const ok = await act(fn, done);
		if (ok) setOpen("");
		return ok;
	};

	return (
		<>
			{notice && <Notice text={notice} />}

			<Card title="Opportunities to connect" intro="Small, specific ways to be there. Take the ones you can, pass on the ones you can't.">
				{!data.opportunities.length && <p>Nothing right now. Ripple will let you know when there's a good moment.</p>}
				{data.opportunities.map((o) => (
					<article key={o.id} className="rp-item">
						<h3>{o.title}</h3>
						<p>{o.body}</p>
						<p className="rp-label">Suggested message</p>
						<p className="rp-quote">{o.suggestedMessage}</p>
						<p className="rp-quiet">Ripple never sends this for you. Use it, change it, or write your own.</p>
						<div className="rp-row">
							<CopyButton text={o.suggestedMessage} label="Copy suggested message" />
							<button type="button" className="rp-btn rp-primary" disabled={busy} onClick={() => act(() => api("POST", `/opportunities/${o.id}/respond`, { accept: true }), "Thank you. It's in your commitments below.")}>
								I'll reach out
							</button>
							<button type="button" className="rp-btn" disabled={busy} onClick={() => act(() => api("POST", `/opportunities/${o.id}/respond`, { accept: false }), "No problem at all.")}>
								Not this time
							</button>
						</div>
					</article>
				))}
			</Card>

			<Card title="My commitments" intro="What you've said yes to, and where each one stands.">
				{!data.commitments.length && <p>Nothing yet.</p>}
				{data.commitments.map((k) => {
					const name = firstName(k.grieverName);
					return (
						<article key={k.opportunityId} className="rp-item">
							<h3>
								{k.title ?? "Just Be There"} <span className="rp-quiet">· {name}</span>
							</h3>
							<Status value={k.status} />
							{k.activity && k.proposedFor && (
								<p>
									{k.activity}, {formatWhen(k.proposedFor)}
								</p>
							)}
							{k.status === "accepted_by_supporter" && (
								<>
									{k.suggestedMessage && <p className="rp-quote">{k.suggestedMessage}</p>}
									<div className="rp-row">
										{k.suggestedMessage && <CopyButton text={k.suggestedMessage} label="Copy suggested message" />}
										<button type="button" className="rp-btn rp-primary" disabled={busy} onClick={() => act(() => api("POST", `/opportunities/${k.opportunityId}/complete`), "Thank you for reaching out.")}>
											I reached out
										</button>
										<button type="button" className="rp-btn" onClick={() => setOpen(open === k.opportunityId ? "" : k.opportunityId)}>
											Propose a time together
										</button>
										<button type="button" className="rp-btn" disabled={busy} onClick={() => act(() => api("POST", `/opportunities/${k.opportunityId}/release`), "That's okay. Someone else will be asked.")}>
											I can't after all
										</button>
									</div>
									{open === k.opportunityId && (
										<InviteForm circleId={k.circleId} name={name} activities={data.activities} opportunityId={k.opportunityId} onSend={send} busy={busy} />
									)}
								</>
							)}
							{k.status === "invitation_sent" && k.invitationId && (
								<>
									<p className="rp-quiet">Waiting for {name} to answer. Taking a while doesn't mean anything is wrong.</p>
									<button type="button" className="rp-btn" disabled={busy} onClick={() => act(() => api("POST", `/invitations/${k.invitationId}/cancel`), "Invitation canceled.")}>
										Cancel invitation
									</button>
								</>
							)}
							{k.status === "accepted_by_griever" && k.invitationId && (
								<div className="rp-row">
									<button type="button" className="rp-btn rp-primary" disabled={busy} onClick={() => act(() => api("POST", `/invitations/${k.invitationId}/complete`), "Thank you for being there.")}>
										We did this
									</button>
									<button type="button" className="rp-btn" disabled={busy} onClick={() => act(() => api("POST", `/invitations/${k.invitationId}/cancel`), "Canceled.")}>
										I need to cancel
									</button>
								</div>
							)}
							{k.status === "declined" && <p className="rp-quiet">{name} wasn't up for it this time. Offering still mattered.</p>}
						</article>
					);
				})}
			</Card>

			<Card title="My care circles" intro="The people you've agreed to support.">
				{data.circles.map((c) => {
					const name = firstName(c.grieverName);
					const key = `circle:${c.circleId}`;
					return (
						<article key={c.circleId} className="rp-item">
							<h3>
								{c.grieverName} <span className="rp-quiet">· {c.circleName}</span>
							</h3>
							{c.circleStatus === "pending_consent" && <p className="rp-quiet">Waiting for {name} to accept this circle.</p>}
							<label className="rp-field">
								When I'm usually free
								<select value={c.availability} onChange={(e) => act(() => api("PATCH", `/circles/${c.circleId}/membership`, { availability: e.target.value }))}>
									{AVAILABILITY.map(([id, label]) => (
										<option key={id} value={id}>
											{label}
										</option>
									))}
								</select>
							</label>
							<div className="rp-row">
								<button type="button" className="rp-btn" onClick={() => setOpen(open === key ? "" : key)}>
									Just Be There: offer time together
								</button>
								<ConfirmButton
									label="Leave this circle"
									confirm="Yes, leave"
									onConfirm={() =>
										act(async () => {
											await api("POST", `/circles/${c.circleId}/leave`);
											onChange();
										}, "You've left the circle.")
									}
								/>
							</div>
							{open === key && <InviteForm circleId={c.circleId} name={name} activities={data.activities} onSend={send} busy={busy} />}
						</article>
					);
				})}
			</Card>

			<Card title="Important dates" intro="Days they've chosen to share with their circle.">
				{!data.dates.length && <p>No shared dates yet.</p>}
				<ul className="rp-list">
					{data.dates.map((d) => (
						<li key={d.id}>
							<span>
								{d.label}
								<span className="rp-quiet"> · {firstName(d.grieverName)}</span>
							</span>
							<span className="rp-quiet">
								{MONTHS[d.month - 1]} {d.day}
								{d.daysAway === 0 ? " · today" : d.daysAway <= 14 ? ` · in ${d.daysAway} day${d.daysAway === 1 ? "" : "s"}` : ""}
							</span>
						</li>
					))}
				</ul>
			</Card>

			<Card title="Support guidance" intro="Short, practical reminders for being alongside someone who is grieving.">
				<dl className="rp-guidance">
					{GUIDANCE.map(([title, text]) => (
						<div key={title}>
							<dt>{title}</dt>
							<dd>{text}</dd>
						</div>
					))}
				</dl>
				<p className="rp-quiet">
					For more, see <em>Never Apologize For Your Tears</em> by Lisa Orris, the book behind MyGriefGuide.{" "}
					<a href="https://amzn.to/4aQVmyH" target="_blank" rel="noreferrer">
						Find the book
					</a>
				</p>
			</Card>
		</>
	);
}
