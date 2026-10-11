import { useCallback, useEffect, useRef, useState } from "react";
import { BASE_CELLS } from "../shared/grid";
import type { Memorial, Stats } from "../shared/text";
import AddForm from "./AddForm";
import Admin from "./Admin";
import { BASE, api, getMemorial, getMemorialAtSlot, getStats, mine } from "./api";
import { demoName } from "./demo";
import { Globe } from "./globe";
import { MemorialCard, Panel, SearchBox } from "./parts";
import "./nf.css";

type Mode = "home" | "journey" | "memorial";
type Submission = { token: string; status: string; name: string; memorial: Memorial | null };

// How many sample names each preview size shows: enough to fill one more level of the Earth each time.
const SAMPLE_SIZES = [0, BASE_CELLS, BASE_CELLS * 16, BASE_CELLS * 256, BASE_CELLS * 4096];

const route = () => window.location.pathname.slice(BASE.length).replace(/\/+$/, "");

function canRender3d() {
	try {
		return !!document.createElement("canvas").getContext("webgl2");
	} catch {
		return false;
	}
}

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function Experience() {
	const holder = useRef<HTMLDivElement>(null);
	const globe = useRef<Globe | null>(null);
	const pick = useRef<(slot: number, sample: boolean) => void>(() => {});
	const begun = useRef(false);
	const [webgl] = useState(() => canRender3d() && !new URLSearchParams(window.location.search).has("static"));
	const [calm] = useState(prefersReducedMotion);
	const [stats, setStats] = useState<Stats | null>(null);
	const [samples, setSamples] = useState(() => {
		const asked = Number(new URLSearchParams(window.location.search).get("demo"));
		return asked > 0 ? (SAMPLE_SIZES.find((n) => n >= asked) ?? SAMPLE_SIZES[SAMPLE_SIZES.length - 1]) : 0;
	});
	const [mode, setMode] = useState<Mode>("home");
	const [memorial, setMemorial] = useState<Memorial | null>(null);
	const [sample, setSample] = useState("");
	const [adding, setAdding] = useState<string | null>(null);
	const [searching, setSearching] = useState(false);
	const [notice, setNotice] = useState("");
	const [submissions, setSubmissions] = useState<Submission[]>([]);

	/** Travels to a memorial, then reveals its card. The card's content is in the page (for screen readers) from the start. */
	const reveal = useCallback(async (m: Memorial, cinematic: boolean) => {
		setAdding(null);
		setSample("");
		setNotice("");
		setMemorial(m);
		setMode("journey");
		window.history.replaceState(null, "", `${BASE}/remember/${m.id}`);
		document.title = `${m.name} · Never Forgotten`;
		await globe.current?.flyToSlot(m.slot, m.name, cinematic);
		setMode("memorial");
	}, []);

	const goHome = useCallback((search: boolean) => {
		setMode("home");
		setMemorial(null);
		setSample("");
		setSearching(search);
		window.history.replaceState(null, "", BASE + window.location.search);
		document.title = "Never Forgotten";
		void globe.current?.home();
	}, []);

	useEffect(() => {
		pick.current = (slot, isSample) => {
			if (isSample) {
				const name = demoName(slot);
				setMemorial(null);
				setSample(name);
				setMode("journey");
				void globe.current?.flyToSlot(slot, name, false).then(() => setMode("memorial"));
				return;
			}
			getMemorialAtSlot(slot).then(
				(m) => reveal(m, false),
				() => {},
			);
		};
	}, [reveal]);

	useEffect(() => {
		if (!webgl || !holder.current) return;
		const instance = new Globe(holder.current, { reducedMotion: calm, onPick: (slot, isSample) => pick.current(slot, isSample) });
		globe.current = instance;
		return () => {
			instance.dispose();
			globe.current = null;
		};
	}, [webgl, calm]);

	// Load the real counts, then follow a direct link if this page was opened on one.
	useEffect(() => {
		let current = true;
		(async () => {
			const loaded = await getStats().catch(() => ({ published: 0, slots: 0, vacant: [] }));
			if (!current) return;
			setStats(loaded);
			if (begun.current) return;
			begun.current = true;

			const path = route();
			const direct = path.match(/^\/remember\/([a-z0-9]+)$/)?.[1];
			const token = path.match(/^\/submission\/([a-z0-9]+)$/)?.[1];
			if (direct) {
				globe.current?.setStats(loaded, 0);
				getMemorial(direct).then(
					(m) => reveal(m, true),
					() => setNotice("We couldn't find that memorial. It may have been removed."),
				);
			}
			const tokens = [...new Set([...(token ? [token] : []), ...mine.list()])];
			const found: Submission[] = [];
			for (const t of tokens) {
				try {
					found.push({ token: t, ...(await api<Omit<Submission, "token">>("GET", `/submission/${t}`)) });
				} catch {
					mine.remove(t);
				}
			}
			if (current) setSubmissions(found.filter((s) => s.status === "pending" || s.status === "published"));
		})();
		return () => {
			current = false;
		};
	}, [reveal]);

	useEffect(() => {
		if (stats) globe.current?.setStats(stats, samples);
	}, [stats, samples]);

	const found = (s: Submission) => {
		mine.remove(s.token);
		setSubmissions((list) => list.filter((x) => x.token !== s.token));
		if (s.memorial) void reveal(s.memorial, true);
	};

	const home = mode === "home";
	const count = stats?.published ?? 0;

	return (
		<main className={webgl ? "nf" : "nf nf-flat"}>
			<div className="nf-globe" ref={holder} aria-hidden="true" />

			{/* Always in the page, whatever the animation is doing, so assistive technology never waits for it. */}
			{memorial && mode === "journey" && (
				<div className="nf-sr" role="status">
					{memorial.name}. {memorial.text} Forever part of our world.
				</div>
			)}

			<header className={home ? "nf-top" : "nf-top nf-faded"}>
				<a className="nf-wordmark" href={BASE}>
					Never Forgotten
				</a>
				<button type="button" className="nf-btn" onClick={() => setAdding("")}>
					Add a Name
				</button>
			</header>

			{home && adding === null && (
				<section className="nf-hero">
					<h1>Every life leaves a mark on our world.</h1>
					<p>Together, we are creating an Earth made of the names of those we love and remember.</p>
					{searching ? (
						<SearchBox autoFocus onSelect={(m) => reveal(m, true)} onAdd={(name) => setAdding(name)} />
					) : (
						<div className="nf-actions">
							<button type="button" className="nf-btn nf-gold" onClick={() => setSearching(true)}>
								Find a Loved One
							</button>
							<button type="button" className="nf-btn" onClick={() => setAdding("")}>
								Add a Name
							</button>
						</div>
					)}
					<p className="nf-counter">
						<strong>{count.toLocaleString()}</strong> {count === 1 ? "Life" : "Lives"} Remembered
					</p>
					{notice && <p className="nf-error">{notice}</p>}
					{submissions.map((s) =>
						s.status === "published" ? (
							<p key={s.token} className="nf-status">
								{s.name} is now part of our world.{" "}
								<button type="button" className="nf-link" onClick={() => found(s)}>
									Find Their Place on Earth
								</button>
							</p>
						) : (
							<p key={s.token} className="nf-status nf-muted">
								{s.name}'s memorial is waiting to be read before it joins the Earth.
							</p>
						),
					)}
					{!webgl && (
						<p className="nf-muted">
							This device can't show the interactive Earth, but every memorial is still here. Search for a name to read it.
						</p>
					)}
				</section>
			)}

			{adding !== null && <AddForm key={adding} initialName={adding} onClose={() => setAdding(null)} onFind={(m) => reveal(m, true)} />}

			{mode === "journey" && !calm && webgl && (
				<button type="button" className="nf-btn nf-skip" onClick={() => globe.current?.skip()}>
					Skip
				</button>
			)}

			{mode === "memorial" && <MemorialCard key={memorial?.id ?? sample} memorial={memorial} sample={sample} onAnother={() => goHome(true)} onReturn={() => goHome(false)} />}

			{webgl && mode !== "journey" && adding === null && (
				<div className="nf-zoom-controls">
					<button type="button" className="nf-icon" onClick={() => globe.current?.zoomBy(0.6)} aria-label="Zoom in">
						+
					</button>
					<button type="button" className="nf-icon" onClick={() => globe.current?.zoomBy(1.6)} aria-label="Zoom out">
						−
					</button>
				</div>
			)}

			{samples > 0 && (
				<Panel title="Demonstration">
					<p className="nf-muted">
						{samples.toLocaleString()} sample names are shown to preview the artwork. They are not memorials and are not
						stored, searchable or counted.
					</p>
					<div className="nf-actions">
						{SAMPLE_SIZES.slice(1).map((n) => (
							<button key={n} type="button" className={n === samples ? "nf-btn nf-gold" : "nf-btn"} onClick={() => setSamples(n)}>
								{n.toLocaleString()}
							</button>
						))}
						<button type="button" className="nf-btn" onClick={() => setSamples(0)}>
							Turn off
						</button>
					</div>
				</Panel>
			)}

			<footer className={home ? "nf-foot" : "nf-foot nf-faded"}>
				<span>
					Created with care by{" "}
					<a href="https://www.mygriefguide.com" target="_blank" rel="noreferrer">
						MyGriefGuide
					</a>
					.
				</span>
				{webgl && samples === 0 && (
					<button type="button" className="nf-link" onClick={() => setSamples(SAMPLE_SIZES[2])}>
						Preview with sample names
					</button>
				)}
			</footer>
		</main>
	);
}

export default function NeverForgotten() {
	return route() === "/admin" ? <Admin /> : <Experience />;
}
