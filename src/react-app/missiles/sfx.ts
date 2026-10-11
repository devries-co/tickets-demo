// Tiny synthesised sound effects; no audio files needed.
export class Sfx {
	muted = false;
	private ctx: AudioContext | null = null;
	private noise: AudioBuffer | null = null;

	// Browsers only allow audio after a user gesture, so call this from input handlers.
	unlock() {
		if (this.ctx) {
			if (this.ctx.state === "suspended") void this.ctx.resume();
			return;
		}
		try {
			const ctx = new AudioContext();
			const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
			const data = noise.getChannelData(0);
			for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
			this.ctx = ctx;
			this.noise = noise;
		} catch {
			// no audio available; the game plays silently
		}
	}

	close() {
		void this.ctx?.close();
		this.ctx = null;
	}

	launch() {
		this.tone(1200, 180, 0.22, 0.04, "sawtooth");
	}

	blip() {
		this.tone(880, 880, 0.05, 0.05, "square");
	}

	empty() {
		this.tone(140, 110, 0.08, 0.05, "square");
	}

	boom(big = false) {
		const ctx = this.ctx;
		if (!ctx || !this.noise || this.muted) return;
		const dur = big ? 0.9 : 0.45;
		const now = ctx.currentTime;
		const src = ctx.createBufferSource();
		src.buffer = this.noise;
		const filter = ctx.createBiquadFilter();
		filter.type = "lowpass";
		filter.frequency.setValueAtTime(big ? 900 : 1600, now);
		filter.frequency.exponentialRampToValueAtTime(60, now + dur);
		const gain = ctx.createGain();
		gain.gain.setValueAtTime(big ? 0.35 : 0.16, now);
		gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
		src.connect(filter).connect(gain).connect(ctx.destination);
		src.start(now);
		src.stop(now + dur);
	}

	private tone(from: number, to: number, dur: number, vol: number, type: OscillatorType) {
		const ctx = this.ctx;
		if (!ctx || this.muted) return;
		const now = ctx.currentTime;
		const osc = ctx.createOscillator();
		osc.type = type;
		osc.frequency.setValueAtTime(from, now);
		osc.frequency.exponentialRampToValueAtTime(to, now + dur);
		const gain = ctx.createGain();
		gain.gain.setValueAtTime(vol, now);
		gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
		osc.connect(gain).connect(ctx.destination);
		osc.start(now);
		osc.stop(now + dur);
	}
}
