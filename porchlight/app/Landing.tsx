import { useState, type FormEvent } from "react";
import { LIGHTS, type Light } from "../shared";
import { api, store } from "./api";
import { ErrorNote, Lamp } from "./ui";

export const ADMIN_KEY = "porchlight:admin";

export default function Landing() {
	const params = new URLSearchParams(window.location.search);
	const existing = store.get(ADMIN_KEY);
	const [form, setForm] = useState({
		grieverName: "",
		lovedOneName: "",
		relationship: "",
		lossDate: "",
		grieverPhone: "",
		sponsor: params.get("via") ?? "",
	});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [demo, setDemo] = useState<Light>("dim");

	const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
		setForm((f) => ({ ...f, [k]: e.target.value }));

	async function submit(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError("");
		try {
			const { adminToken } = await api.createCircle({
				...form,
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			});
			store.set(ADMIN_KEY, adminToken);
			window.location.href = `/porchlight/g/${adminToken}?new=1`;
		} catch (err) {
			setError((err as Error).message);
			setBusy(false);
		}
	}

	return (
		<div className="pl-page">
			<header className="pl-hero">
				<button
					type="button"
					className="pl-hero__lamp"
					onClick={() => setDemo((d) => (d === "on" ? "dim" : d === "dim" ? "off" : "on"))}
					aria-label="Try the light"
				>
					<Lamp light={demo} size={96} />
				</button>
				<h1>Porchlight</h1>
				<p className="pl-lede">
					One quiet signal to everyone who loves you, saying what kind of support you want right now.
				</p>
				<p className="pl-demo-caption">
					{LIGHTS[demo].emoji} <strong>{LIGHTS[demo].label}:</strong> “{LIGHTS[demo].meaning}”
				</p>
				{params.get("via") && <p className="pl-sponsor">Shared with care by {params.get("via")}</p>}
			</header>

			{existing && (
				<a className="pl-btn pl-btn--primary pl-btn--block" href={`/porchlight/g/${existing}`}>
					Go to my porch light
				</a>
			)}

			<section className="pl-card">
				<h2>How it works</h2>
				<ol className="pl-steps">
					<li>
						<strong>Set your light each day with one tap.</strong> On, dim, or off. No typing, no explaining.
					</li>
					<li>
						<strong>Share one link or QR code.</strong> Friends and family join by text. No app for them, nothing
						for you to manage.
					</li>
					<li>
						<strong>Porchlight does the reminding.</strong> Gentle coaching texts before hard days, and a nudge at
						week six, when most people stop checking in.
					</li>
				</ol>
				<p className="pl-hint">You never owe anyone an update. Turning your light off is always okay.</p>
			</section>

			<form className="pl-card" onSubmit={submit}>
				<h2>Light your porch</h2>
				<p className="pl-hint">Takes a minute. Only first names are needed.</p>
				<label className="pl-field">
					<span>Your first name</span>
					<input required maxLength={40} value={form.grieverName} onChange={set("grieverName")} autoComplete="given-name" />
				</label>
				<label className="pl-field">
					<span>The name of the person who died</span>
					<input required maxLength={40} value={form.lovedOneName} onChange={set("lovedOneName")} />
				</label>
				<label className="pl-field">
					<span>
						They were your… <em>(optional)</em>
					</span>
					<input
						maxLength={40}
						placeholder="husband, mom, best friend"
						value={form.relationship}
						onChange={set("relationship")}
					/>
				</label>
				<label className="pl-field">
					<span>
						Date they died <em>(optional, helps us time reminders for your circle)</em>
					</span>
					<input type="date" value={form.lossDate} onChange={set("lossDate")} />
				</label>
				<label className="pl-field">
					<span>
						Your mobile <em>(optional, for a few gentle notes just for you)</em>
					</span>
					<input type="tel" inputMode="tel" value={form.grieverPhone} onChange={set("grieverPhone")} autoComplete="tel" />
				</label>
				{!params.get("via") && (
					<label className="pl-field">
						<span>
							Funeral home or organization that shared this <em>(optional)</em>
						</span>
						<input maxLength={80} value={form.sponsor} onChange={set("sponsor")} />
					</label>
				)}
				<ErrorNote error={error} />
				<button className="pl-btn pl-btn--primary pl-btn--block" disabled={busy}>
					{busy ? "Lighting…" : "Light my porch"}
				</button>
				<p className="pl-hint pl-small">
					You'll get a private link that is your key. Bookmark it. Anyone with your circle link can see your light and
					card, so share it with people you trust.
				</p>
			</form>
			<footer className="pl-footer">A Grief Guide project</footer>
		</div>
	);
}
