import { type FormEvent, useState } from "react";
import Admin from "./Admin";
import Griever from "./Griever";
import Supporter from "./Supporter";
import { type Me, api, firstName, message, useLoad } from "./lib";
import { Card, Check, ConfirmButton, InviteLink, Notice } from "./ui";
import "./ripple.css";

const joinToken = () => window.location.pathname.match(/^\/ripple\/join\/([a-f0-9]+)/)?.[1] ?? "";

function AuthForm({ onDone, startWith }: { onDone: () => void; startWith: "signup" | "login" }) {
	const [mode, setMode] = useState(startWith);
	const [form, setForm] = useState({ name: "", email: "", password: "" });
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		try {
			await api("POST", `/auth/${mode}`, form);
			onDone();
		} catch (err) {
			setError(message(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card title={mode === "signup" ? "Create your account" : "Welcome back"}>
			<form className="rp-form" onSubmit={submit}>
				{mode === "signup" && (
					<label className="rp-field">
						Your name
						<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" required maxLength={80} />
					</label>
				)}
				<label className="rp-field">
					Email
					<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" required />
				</label>
				<label className="rp-field">
					Password
					<input
						type="password"
						value={form.password}
						onChange={(e) => setForm({ ...form, password: e.target.value })}
						autoComplete={mode === "signup" ? "new-password" : "current-password"}
						minLength={8}
						required
					/>
				</label>
				{error && <Notice text={error} />}
				<button type="submit" className="rp-btn rp-primary" disabled={busy}>
					{mode === "signup" ? "Create account" : "Sign in"}
				</button>
			</form>
			<button
				type="button"
				className="rp-link"
				onClick={() => {
					setError("");
					setMode(mode === "signup" ? "login" : "signup");
				}}
			>
				{mode === "signup" ? "I already have an account" : "I need to create an account"}
			</button>
		</Card>
	);
}

function CreateCircle({ onDone }: { onDone: () => void }) {
	const [forSelf, setForSelf] = useState(true);
	const [form, setForm] = useState({ name: "", grieverName: "", grieverEmail: "" });
	const [error, setError] = useState("");
	const [created, setCreated] = useState("");

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		try {
			const res = await api<{ inviteToken?: string }>("POST", "/circles", { forSelf, ...form });
			if (res.inviteToken) setCreated(res.inviteToken);
			else onDone();
		} catch (err) {
			setError(message(err));
		}
	};

	if (created) {
		return (
			<Card title="Circle created">
				<p>
					Nothing happens in this circle until {firstName(form.grieverName)} accepts. It's theirs to say yes or no to.
				</p>
				<InviteLink token={created} name={firstName(form.grieverName)} />
				<button type="button" className="rp-btn rp-primary" onClick={onDone}>
					Continue
				</button>
			</Card>
		);
	}

	return (
		<Card title="Start a care circle" intro="A small, private group of people who will keep showing up.">
			<form className="rp-form" onSubmit={submit}>
				<fieldset className="rp-options">
					<legend>Who is this circle for?</legend>
					<label className={forSelf ? "rp-option rp-option-on" : "rp-option"}>
						<input type="radio" name="for" checked={forSelf} onChange={() => setForSelf(true)} />
						For me. I'm grieving.
					</label>
					<label className={forSelf ? "rp-option" : "rp-option rp-option-on"}>
						<input type="radio" name="for" checked={!forSelf} onChange={() => setForSelf(false)} />
						For someone I care about. I'll help coordinate, with their consent.
					</label>
				</fieldset>
				{!forSelf && (
					<>
						<label className="rp-field">
							Their name
							<input value={form.grieverName} onChange={(e) => setForm({ ...form, grieverName: e.target.value })} required maxLength={80} />
						</label>
						<label className="rp-field">
							Their email
							<input type="email" value={form.grieverEmail} onChange={(e) => setForm({ ...form, grieverEmail: e.target.value })} required />
						</label>
					</>
				)}
				<label className="rp-field">
					A name for the circle (optional)
					<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} placeholder="Sarah's circle" />
				</label>
				{error && <Notice text={error} />}
				<button type="submit" className="rp-btn rp-primary">
					Create circle
				</button>
			</form>
		</Card>
	);
}

type Invite = { role: string; name: string; circleName: string; grieverName: string };

/** The page behind a private invitation link. */
function Join({ token, me, reload }: { token: string; me: Me; reload: () => Promise<void> }) {
	const { data, error } = useLoad<{ invite: Invite }>(`/invites/${token}`);
	const [failure, setFailure] = useState("");

	const leave = () => {
		window.history.replaceState(null, "", "/ripple");
		void reload();
	};
	const accept = async () => {
		try {
			await api("POST", `/invites/${token}/accept`);
			leave();
		} catch (err) {
			setFailure(message(err));
		}
	};

	if (error) {
		return (
			<Card title="This invitation isn't active">
				<p>It may have been used already or withdrawn.</p>
				<button type="button" className="rp-btn" onClick={leave}>
					Go to Ripple
				</button>
			</Card>
		);
	}
	if (!data) return <p className="rp-quiet">Loading…</p>;

	const { invite } = data;
	const forThem = invite.role === "griever";
	return (
		<>
			<Card title={forThem ? "Someone who cares about you set this up" : `You're invited to ${invite.circleName}`}>
				{forThem ? (
					<p>
						A care circle has been prepared for you. If you accept, you decide who is in it, what they can see, and
						whether anyone is ever asked to reach out. You can pause or delete it at any time.
					</p>
				) : (
					<p>
						{invite.grieverName} would like you in their care circle. From time to time Ripple will suggest a small way to
						be there. You're always free to say "not this time."
					</p>
				)}
				{failure && <Notice text={failure} />}
				{me.user && (
					<div className="rp-row">
						<button type="button" className="rp-btn rp-primary" onClick={accept}>
							{forThem ? "Accept this circle" : "Join the circle"}
						</button>
						<button type="button" className="rp-btn" onClick={leave}>
							Not now
						</button>
					</div>
				)}
			</Card>
			{!me.user && <AuthForm startWith="signup" onDone={reload} />}
		</>
	);
}

type Notification = { id: string; title: string; body: string; readAt: string | null; createdAt: string };

function Notifications({ paused, onChange }: { paused: boolean; onChange: () => void }) {
	const { data } = useLoad<{ notifications: Notification[] }>("/notifications");
	return (
		<Card title="Notifications">
			{data && !data.notifications.length && <p>Nothing new.</p>}
			<ul className="rp-list">
				{data?.notifications.map((n) => (
					<li key={n.id}>
						<span>
							{n.title}
							<span className="rp-quiet rp-block">{n.body}</span>
						</span>
						<span className="rp-quiet">{new Date(n.createdAt).toLocaleDateString()}</span>
					</li>
				))}
			</ul>
			<Check
				checked={paused}
				onChange={async (v) => {
					await api("PUT", "/notifications/preferences", { paused: v });
					onChange();
				}}
			>
				Pause my notifications
			</Check>
		</Card>
	);
}

export default function Ripple() {
	const { data: me, error, reload } = useLoad<Me>("/me");
	const [view, setView] = useState("");
	const [panel, setPanel] = useState<"" | "notifications" | "account">("");
	const [token, setToken] = useState(joinToken);

	if (error) {
		return (
			<main className="ripple">
				<Notice text={error} />
			</main>
		);
	}
	if (!me) return <main className="ripple" />;

	const refresh = async () => {
		setToken(joinToken());
		await reload();
	};

	const grieving = me.memberships.filter((m) => m.role === "griever");
	const supporting = me.memberships.some((m) => m.role !== "griever");
	const coordinating = me.memberships.filter((m) => m.role === "admin");
	const views: [string, string][] = [
		...grieving.map((m): [string, string] => [`griever:${m.circleId}`, grieving.length > 1 ? m.circleName : "My support"]),
		...(supporting ? [["supporter", "Supporting others"] as [string, string]] : []),
		...coordinating.map((m): [string, string] => [`admin:${m.circleId}`, `Coordinate: ${m.circleName}`]),
		["new", "New circle"],
	];
	const current = views.some(([id]) => id === view) ? view : views[0][0];
	const [kind, circleId] = current.split(":");

	const togglePanel = async (next: "notifications" | "account") => {
		setPanel(panel === next ? "" : next);
		if (next === "notifications" && panel !== next && me.unread) {
			await api("POST", "/notifications/read");
			void reload();
		}
	};

	return (
		<main className="ripple">
			<header className="rp-header">
				<a className="rp-brand" href="/ripple">
					<span className="rp-mark" aria-hidden="true" />
					Ripple
					<span className="rp-by">by MyGriefGuide</span>
				</a>
				{me.user && (
					<div className="rp-row">
						<button type="button" className="rp-link" onClick={() => togglePanel("notifications")}>
							Notifications{me.unread > 0 && <span className="rp-dot">{me.unread}</span>}
						</button>
						<button type="button" className="rp-link" onClick={() => togglePanel("account")}>
							{firstName(me.user.name)}
						</button>
					</div>
				)}
			</header>

			{!me.user && !token && (
				<>
					<section className="rp-hero">
						<h1>Because grief doesn't end when everyone else goes home.</h1>
						<p>
							Ripple helps the people who love you keep showing up, without you having to ask, explain, or manage anyone.
						</p>
					</section>
					<AuthForm startWith="signup" onDone={reload} />
					<p className="rp-quiet rp-center">Ripple doesn't replace human connection. It makes sure human connection doesn't disappear.</p>
				</>
			)}

			{token && <Join token={token} me={me} reload={refresh} />}

			{me.user && !token && (
				<>
					{panel === "notifications" && <Notifications paused={me.notificationsPaused} onChange={reload} />}
					{panel === "account" && (
						<Card title={me.user.name} intro={me.user.email}>
							<div className="rp-stack">
								<button
									type="button"
									className="rp-btn"
									onClick={async () => {
										await api("POST", "/auth/logout");
										setPanel("");
										void reload();
									}}
								>
									Sign out
								</button>
								<ConfirmButton
									label="Delete my account and data"
									confirm="Yes, delete everything"
									onConfirm={async () => {
										await api("DELETE", "/me");
										setPanel("");
										void reload();
									}}
								/>
							</div>
						</Card>
					)}

					{me.invites.map((invite) => (
						<Card key={invite.token} title={invite.role === "griever" ? "A care circle has been prepared for you" : `You're invited to ${invite.circleName}`}>
							<p>{invite.role === "griever" ? "It only becomes active if you accept, and you stay in charge of it." : `${invite.grieverName} would like you in their care circle.`}</p>
							<button
								type="button"
								className="rp-btn rp-primary"
								onClick={() => {
									window.history.replaceState(null, "", `/ripple/join/${invite.token}`);
									setToken(invite.token);
								}}
							>
								See the invitation
							</button>
						</Card>
					))}

					{views.length > 1 && (
						<nav className="rp-views" aria-label="Your circles">
							{views.map(([id, label]) => (
								<button key={id} type="button" className={id === current ? "rp-view rp-view-on" : "rp-view"} onClick={() => setView(id)}>
									{label}
								</button>
							))}
						</nav>
					)}

					{kind === "griever" && <Griever key={circleId} circleId={circleId} userName={me.user.name} />}
					{kind === "supporter" && <Supporter onChange={reload} />}
					{kind === "admin" && <Admin key={circleId} circleId={circleId} />}
					{kind === "new" && (
						<CreateCircle
							onDone={() => {
								setView("");
								void reload();
							}}
						/>
					)}
				</>
			)}

			<footer className="rp-footer">
				<p>
					If you ever feel you might harm yourself, call or text <a href="tel:988">988</a> in the US, or your local
					emergency number. You deserve a person on the line, right away.
				</p>
			</footer>
		</main>
	);
}
