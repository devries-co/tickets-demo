// The drawings on the Labs page. Decorative only, so each is hidden from screen readers.

/** The two-stroke wave from the Grief Guide logo. */
export function Wave() {
	return (
		<svg className="labs-wave" viewBox="0 0 120 24" aria-hidden="true">
			<path d="M2 15c22-14 38-12 56-4s36 8 60-6" />
			<path d="M18 20c18-9 30-8 44-3s28 5 46-4" />
		</svg>
	);
}

const frame = { viewBox: "0 0 320 240", "aria-hidden": true, preserveAspectRatio: "xMidYMid slice" } as const;

/** Rings spreading from one person, with the people around them resting on the rings. */
export function RippleArt() {
	const people: [number, number][] = [
		[42, 20],
		[42, 205],
		[68, 110],
		[68, 300],
		[94, 160],
		[94, 345],
	];
	return (
		<svg className="labs-svg labs-svg--wash" {...frame}>
			{[16, 42, 68, 94, 120, 146].map((r, i) => (
				<circle key={r} cx="160" cy="120" r={r} className="ring" style={{ opacity: 1 - i * 0.15 }} />
			))}
			<circle cx="160" cy="120" r="7" className="solid" />
			{people.map(([r, deg]) => {
				const a = (deg * Math.PI) / 180;
				return <circle key={`${r}-${deg}`} cx={160 + r * Math.cos(a)} cy={120 + r * Math.sin(a)} r="5" className="person" />;
			})}
		</svg>
	);
}

/** A porch at dusk with its lamp lit, and the three settings of the light beneath. */
export function PorchArt() {
	return (
		<svg className="labs-svg labs-svg--deep" {...frame}>
			<defs>
				<radialGradient id="labs-glow">
					<stop offset="0" stopColor="#f6c56b" stopOpacity="0.7" />
					<stop offset="1" stopColor="#f6c56b" stopOpacity="0" />
				</radialGradient>
			</defs>
			<circle cx="160" cy="88" r="92" fill="url(#labs-glow)" />
			<path className="line" d="M84 190V104l76-46 76 46v86" />
			<path className="line" d="M140 190v-52h40v52" />
			<path className="line" d="M60 190h200" />
			<path className="line" d="M160 58v14" />
			<circle cx="160" cy="88" r="11" className="lamp" />
			<g transform="translate(160 216)">
				<circle cx="-22" r="5" className="lamp" />
				<circle r="5" className="lamp" style={{ opacity: 0.5 }} />
				<circle cx="22" r="5" className="off" />
			</g>
		</svg>
	);
}

/** A globe drawn from rows of small marks, one of them found. */
export function EarthArt() {
	const marks = [];
	const R = 88;
	for (let row = -7; row <= 7; row++) {
		const y = row * 11.5;
		const half = Math.sqrt(R * R - y * y);
		const count = Math.max(1, Math.floor((half * 2) / 13));
		for (let i = 0; i < count; i++) {
			const x = -half + ((i + 0.5) * half * 2) / count;
			// Shorter and fainter toward the edge, which is what makes it read as a sphere.
			const edge = Math.sqrt(1 - Math.min(1, (x * x + y * y) / (R * R)));
			const found = row === -2 && i === Math.floor(count * 0.62);
			marks.push(
				<rect
					key={`${row}-${i}`}
					x={160 + x - 4.5 * edge}
					y={120 + y - 1.5}
					width={9 * edge + 1}
					height="3"
					rx="1.5"
					className={found ? "found" : "name"}
					style={found ? undefined : { opacity: 0.25 + 0.6 * edge * ((row * 7 + i * 3) % 5 > 1 ? 1 : 0.45) }}
				/>,
			);
		}
	}
	return (
		<svg className="labs-svg labs-svg--deep" {...frame}>
			<circle cx="160" cy="120" r="104" className="halo" />
			{marks}
		</svg>
	);
}

/** A voice becoming a letter. */
export function ConversationsArt() {
	const bars = [10, 22, 36, 18, 44, 30, 52, 26, 40, 16, 34, 48, 22, 30, 12];
	return (
		<svg className="labs-svg labs-svg--paper" {...frame}>
			<g transform="translate(62 62)">
				{bars.map((h, i) => (
					<rect key={i} x={i * 13.5} y={-h / 2} width="5" height={h} rx="2.5" className="bar" />
				))}
			</g>
			<g transform="translate(70 104)">
				<rect width="180" height="110" rx="6" className="sheet" />
				{[22, 40, 58, 76].map((y, i) => (
					<path key={y} className="script" d={`M18 ${y}h${[144, 128, 138, 72][i]}`} />
				))}
				<path className="sign" d="M112 92c8-10 14 6 22-2s10-6 20 0" />
			</g>
		</svg>
	);
}
