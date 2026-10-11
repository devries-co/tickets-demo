import { type ReactNode, useState } from "react";
import { STATUS_LABEL, inviteLink } from "./lib";

export function Card({ title, intro, children }: { title?: string; intro?: string; children: ReactNode }) {
	return (
		<section className="rp-card">
			{title && <h2>{title}</h2>}
			{intro && <p className="rp-quiet">{intro}</p>}
			{children}
		</section>
	);
}

export function Notice({ text }: { text: string }) {
	return (
		<p className="rp-notice" role="status" aria-live="polite">
			{text}
		</p>
	);
}

export function Status({ value }: { value: string }) {
	return <span className={`rp-status rp-status-${value}`}>{STATUS_LABEL[value] ?? value}</span>;
}

export function CopyButton({ text, label, primary }: { text: string; label: string; primary?: boolean }) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// Clipboard API unavailable (older browser or blocked): fall back to a hidden field.
			const field = document.createElement("textarea");
			field.value = text;
			document.body.appendChild(field);
			field.select();
			document.execCommand("copy");
			field.remove();
		}
		setCopied(true);
		setTimeout(() => setCopied(false), 2500);
	};
	return (
		<button type="button" className={primary ? "rp-btn rp-primary" : "rp-btn"} onClick={copy}>
			{copied ? "Copied" : label}
		</button>
	);
}

export function InviteLink({ token, name }: { token: string; name: string }) {
	return (
		<div className="rp-invite-link">
			<p className="rp-quiet">
				Ripple doesn't send emails. Share this private link with {name} yourself, however feels natural.
			</p>
			<code>{inviteLink(token)}</code>
			<CopyButton text={inviteLink(token)} label="Copy invitation link" />
		</div>
	);
}

/** A destructive action that asks once more inline, instead of opening a pop-up. */
export function ConfirmButton({ label, confirm, onConfirm }: { label: string; confirm: string; onConfirm: () => void }) {
	const [asking, setAsking] = useState(false);
	if (!asking) {
		return (
			<button type="button" className="rp-btn rp-danger" onClick={() => setAsking(true)}>
				{label}
			</button>
		);
	}
	return (
		<span className="rp-row">
			<button
				type="button"
				className="rp-btn rp-danger"
				onClick={() => {
					setAsking(false);
					onConfirm();
				}}
			>
				{confirm}
			</button>
			<button type="button" className="rp-btn" onClick={() => setAsking(false)}>
				Keep it
			</button>
		</span>
	);
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (value: boolean) => void; children: ReactNode }) {
	return (
		<label className="rp-check">
			<input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
			<span>{children}</span>
		</label>
	);
}

/** Shown when a private note directly mentions self-harm, and always reachable from the footer. */
export function CrisisPanel() {
	return (
		<section className="rp-card rp-crisis" role="alert">
			<h2>You deserve support right now</h2>
			<p>
				If you are thinking about harming yourself, please reach out to a person now. You don't have to face this
				moment by yourself.
			</p>
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
				<li>If you can, tell someone you trust how you are feeling and ask them to stay with you.</li>
			</ul>
			<p className="rp-quiet">Ripple has not shared this with anyone. Only you can see your note.</p>
		</section>
	);
}
