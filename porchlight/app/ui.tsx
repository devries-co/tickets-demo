import { useMemo, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import { LIGHTS, type Light } from "../shared";

export function Lamp({ light, size = 120 }: { light: Light | null; size?: number }) {
	return (
		<div
			className={`pl-lamp pl-lamp--${light ?? "unset"}`}
			style={{ width: size, height: size }}
			role="img"
			aria-label={light ? `Light ${LIGHTS[light].label}` : "No light set"}
		/>
	);
}

export function Qr({ value, size = 180 }: { value: string; size?: number }) {
	const svg = useMemo(() => {
		const qr = qrcode(0, "M");
		qr.addData(value);
		qr.make();
		return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
	}, [value]);
	return <div className="pl-qr" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function Spinner() {
	return (
		<div className="pl-center">
			<Lamp light="dim" size={56} />
		</div>
	);
}

export function ErrorNote({ error }: { error: string }) {
	if (!error) return null;
	return (
		<p className="pl-error" role="alert">
			{error}
		</p>
	);
}

export function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
	return (
		<section className="pl-card">
			<h2>{title}</h2>
			{hint && <p className="pl-hint">{hint}</p>}
			{children}
		</section>
	);
}

export function Flash({ msg }: { msg: string }) {
	return (
		<div className={`pl-flash ${msg ? "pl-flash--show" : ""}`} role="status" aria-live="polite">
			{msg}
		</div>
	);
}

export function Chips<T extends string>({
	options,
	value,
	onChange,
}: {
	options: readonly { id: T; label: string }[];
	value: string[];
	onChange: (v: T[]) => void;
}) {
	return (
		<div className="pl-chips">
			{options.map((o) => {
				const on = value.includes(o.id);
				return (
					<button
						type="button"
						key={o.id}
						className={`pl-chip ${on ? "pl-chip--on" : ""}`}
						aria-pressed={on}
						onClick={() => {
							const next = on ? value.filter((v) => v !== o.id) : [...value, o.id];
							onChange(next as T[]);
						}}
					>
						{o.label}
					</button>
				);
			})}
		</div>
	);
}

export function Segmented<T extends string>({
	options,
	value,
	onChange,
	name,
}: {
	options: readonly { id: T; label: string }[];
	value: T | null;
	onChange: (v: T | null) => void;
	name: string;
}) {
	return (
		<div className="pl-seg" role="radiogroup" aria-label={name}>
			{options.map((o) => (
				<button
					type="button"
					key={o.id}
					role="radio"
					aria-checked={value === o.id}
					className={`pl-seg__opt ${value === o.id ? "pl-seg__opt--on" : ""}`}
					onClick={() => onChange(value === o.id ? null : o.id)}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}
