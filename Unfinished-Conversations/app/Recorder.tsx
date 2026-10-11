import { useEffect, useRef, useState } from "react";
import { MAX_RECORDING_MINUTES, PROMPTS } from "../shared";
import { clock, message, upload } from "./lib";

type Phase = "ready" | "recording" | "paused" | "review" | "saving";
export type Recording = { assetId: string; durationMs: number; title: string; transcript: string };

// The browser's own speech recognition, where it has one. Not in the standard TypeScript library.
type Recognition = {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((e: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
};
const SpeechRecognition = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition
	?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;

const FORMATS = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

/**
 * Record, pause, resume, stop, listen back, record again, save.
 * `onSave` receives the uploaded recording; the caller decides what it becomes
 * (a private entry, or a story for a shared collection).
 */
export default function Recorder({ about, onSave, onCancel, saveLabel = "Save" }: { about: string; onSave: (recording: Recording) => Promise<void>; onCancel: () => void; saveLabel?: string }) {
	const [phase, setPhase] = useState<Phase>("ready");
	const [elapsed, setElapsed] = useState(0);
	const [error, setError] = useState("");
	const [prompt, setPrompt] = useState(-1);
	const [transcribe, setTranscribe] = useState(false);
	const [transcript, setTranscript] = useState("");
	const [title, setTitle] = useState("");
	const [progress, setProgress] = useState(0);
	const [preview, setPreview] = useState("");

	const canvas = useRef<HTMLCanvasElement>(null);
	const recorder = useRef<MediaRecorder | null>(null);
	const stream = useRef<MediaStream | null>(null);
	const audio = useRef<AudioContext | null>(null);
	const pieces = useRef<Blob[]>([]);
	const blob = useRef<Blob | null>(null);
	const levels = useRef<number[]>([]);
	const frame = useRef(0);
	const clockState = useRef({ started: 0, banked: 0, running: false });
	const recognition = useRef<Recognition | null>(null);
	const listening = useRef(false);

	const release = () => {
		cancelAnimationFrame(frame.current);
		listening.current = false;
		recognition.current?.stop();
		stream.current?.getTracks().forEach((track) => track.stop());
		void audio.current?.close().catch(() => {});
		stream.current = null;
		audio.current = null;
	};

	useEffect(() => release, []);
	useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

	const stop = () => {
		const state = clockState.current;
		if (state.running) state.banked += performance.now() - state.started;
		state.running = false;
		if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
	};

	const start = async () => {
		setError("");
		if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
			setError("This browser can't record audio. You can still write a letter or share a memory.");
			return;
		}
		try {
			stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
		} catch {
			setError("The microphone isn't available. Please allow microphone access for this site in your browser, then try again.");
			return;
		}
		const mimeType = FORMATS.find((type) => MediaRecorder.isTypeSupported(type));
		let rec: MediaRecorder;
		try {
			rec = new MediaRecorder(stream.current, { mimeType, audioBitsPerSecond: 64_000 });
		} catch {
			release();
			setError("Recording couldn't start on this device. You can still write a letter or share a memory.");
			return;
		}
		pieces.current = [];
		levels.current = [];
		rec.ondataavailable = (e) => e.data.size && pieces.current.push(e.data);
		rec.onstop = () => {
			const state = clockState.current;
			const total = state.banked + (state.running ? performance.now() - state.started : 0);
			blob.current = new Blob(pieces.current, { type: (rec.mimeType || "audio/webm").split(";")[0] });
			release();
			setElapsed(total);
			setPreview(URL.createObjectURL(blob.current));
			setPhase("review");
		};
		try {
			rec.start(1000);
		} catch {
			release();
			setError("Recording couldn't start. Please check your microphone and try again.");
			return;
		}
		recorder.current = rec;
		clockState.current = { started: performance.now(), banked: 0, running: true };

		// A quiet waveform: recent loudness as a row of soft bars.
		const ctx = new AudioContext();
		audio.current = ctx;
		const analyser = ctx.createAnalyser();
		analyser.fftSize = 1024;
		ctx.createMediaStreamSource(stream.current).connect(analyser);
		const samples = new Uint8Array(analyser.fftSize);
		let lastBar = 0;
		const draw = (now: number) => {
			const state = clockState.current;
			const total = state.banked + (state.running ? now - state.started : 0);
			setElapsed(total);
			if (total > MAX_RECORDING_MINUTES * 60_000) stop();
			analyser.getByteTimeDomainData(samples);
			let peak = 0;
			for (const s of samples) peak = Math.max(peak, Math.abs(s - 128) / 128);
			if (state.running && now - lastBar > 70) {
				lastBar = now;
				levels.current.push(peak);
				if (levels.current.length > 120) levels.current.shift();
			}
			const el = canvas.current;
			const g = el?.getContext("2d");
			if (el && g) {
				const w = (el.width = el.clientWidth * devicePixelRatio);
				const h = (el.height = el.clientHeight * devicePixelRatio);
				const bar = w / 120;
				g.clearRect(0, 0, w, h);
				g.fillStyle = getComputedStyle(el).color;
				levels.current.forEach((level, i) => {
					const size = Math.max(2 * devicePixelRatio, Math.min(1, level * 1.8) * h * 0.9);
					g.globalAlpha = 0.35 + 0.65 * (i / levels.current.length);
					g.beginPath();
					g.roundRect(w - (levels.current.length - i) * bar, (h - size) / 2, bar * 0.55, size, bar);
					g.fill();
				});
			}
			frame.current = requestAnimationFrame(draw);
		};
		frame.current = requestAnimationFrame(draw);

		if (transcribe && SpeechRecognition) {
			const speech = new SpeechRecognition();
			speech.continuous = true;
			speech.interimResults = false;
			speech.lang = navigator.language || "en-US";
			speech.onresult = (e) => {
				let heard = "";
				for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) heard += e.results[i][0].transcript;
				if (heard.trim()) setTranscript((prev) => `${prev} ${heard.trim()}`.trim());
			};
			// Browsers end recognition after a silence; keep it going for as long as we are recording.
			speech.onend = () => {
				if (listening.current) {
					try {
						speech.start();
					} catch {
						// already restarting
					}
				}
			};
			recognition.current = speech;
			listening.current = true;
			try {
				speech.start();
			} catch {
				listening.current = false;
			}
		}
		setPhase("recording");
	};

	const pause = () => {
		const state = clockState.current;
		recorder.current?.pause();
		state.banked += performance.now() - state.started;
		state.running = false;
		listening.current = false;
		recognition.current?.stop();
		setPhase("paused");
	};

	const resume = () => {
		recorder.current?.resume();
		clockState.current.started = performance.now();
		clockState.current.running = true;
		if (recognition.current) {
			listening.current = true;
			try {
				recognition.current.start();
			} catch {
				// still winding down from the pause; onend restarts it
			}
		}
		setPhase("recording");
	};

	const again = () => {
		blob.current = null;
		setPreview("");
		setTranscript("");
		setElapsed(0);
		setPhase("ready");
	};

	const save = async () => {
		if (!blob.current) return;
		setPhase("saving");
		setError("");
		try {
			const assetId = await upload(blob.current, "audio", { durationMs: elapsed }, setProgress);
			await onSave({ assetId, durationMs: elapsed, title: title.trim(), transcript: transcript.trim() });
		} catch (err) {
			setError(message(err));
			setPhase("review");
		}
	};

	const live = phase === "recording" || phase === "paused";

	return (
		<section className="uc-card uc-recorder">
			<h2>{phase === "review" || phase === "saving" ? "Listen back" : `A message for ${about}`}</h2>

			{phase === "ready" && (
				<>
					<p className="uc-quiet">Say whatever you'd like. You can pause, start over, or listen before anything is saved.</p>
					{prompt >= 0 && <p className="uc-prompt">{PROMPTS[prompt]}</p>}
					<button type="button" className="uc-link" onClick={() => setPrompt((prompt + 1) % PROMPTS.length)}>
						{prompt < 0 ? "Not sure where to begin? Show me a prompt" : "Another prompt"}
					</button>
					{SpeechRecognition && (
						<label className="uc-check">
							<input type="checkbox" checked={transcribe} onChange={(e) => setTranscribe(e.target.checked)} />
							<span>
								Write down my words as I speak
								<span className="uc-quiet uc-block">Uses your browser's speech recognition, which may send audio to the browser maker. You can edit the text before saving.</span>
							</span>
						</label>
					)}
				</>
			)}

			{live && (
				<>
					<canvas ref={canvas} className={phase === "paused" ? "uc-wave uc-wave-paused" : "uc-wave"} aria-hidden="true" />
					<p className="uc-clock" aria-live="off">
						{clock(elapsed)}
						<span className="uc-quiet"> {phase === "paused" ? "paused" : "recording"}</span>
					</p>
					{transcript && <p className="uc-quiet uc-transcribing">{transcript}</p>}
				</>
			)}

			{(phase === "review" || phase === "saving") && (
				<>
					<audio controls src={preview} className="uc-audio" />
					<p className="uc-quiet">{clock(elapsed)} recorded</p>
					<label className="uc-field">
						A title, if you'd like one
						<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="The day he made the team" />
					</label>
					<label className="uc-field">
						What you said, in writing (optional)
						<textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={4} placeholder="Type it out if you'd like to be able to search for it later." />
					</label>
					{phase === "saving" && <progress value={progress} max={1} aria-label="Saving" />}
				</>
			)}

			{error && <p className="uc-error" role="alert">{error}</p>}

			<div className="uc-row uc-center">
				{phase === "ready" && (
					<>
						<button type="button" className="uc-btn uc-record" onClick={start}>
							<span className="uc-dot" aria-hidden="true" /> Start recording
						</button>
						<button type="button" className="uc-btn" onClick={onCancel}>
							Not now
						</button>
					</>
				)}
				{phase === "recording" && (
					<>
						<button type="button" className="uc-btn" onClick={pause}>
							Pause
						</button>
						<button type="button" className="uc-btn uc-primary" onClick={stop}>
							Stop
						</button>
					</>
				)}
				{phase === "paused" && (
					<>
						<button type="button" className="uc-btn" onClick={resume}>
							Resume
						</button>
						<button type="button" className="uc-btn uc-primary" onClick={stop}>
							Stop
						</button>
					</>
				)}
				{phase === "review" && (
					<>
						<button type="button" className="uc-btn uc-primary" onClick={save}>
							{saveLabel}
						</button>
						<button type="button" className="uc-btn" onClick={again}>
							Record again
						</button>
						<button type="button" className="uc-btn" onClick={onCancel}>
							Discard
						</button>
					</>
				)}
			</div>
		</section>
	);
}
