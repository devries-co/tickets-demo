import { Sfx } from "./sfx";

export const W = 960;
export const H = 600;

const GROUND = 548;
const MOUND = 26;
const BATTERY_X = [80, 480, 880];
const CITY_X = [196, 284, 372, 588, 676, 764];
const AMMO = 10;
const BONUS_CITY_EVERY = 10000;
const BEST_KEY = "missiles-best";
const FONT = 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';

// [x offset, height, width] of each building in a city skyline
const BUILDINGS = [
	[-24, 10, 7],
	[-16, 20, 8],
	[-7, 15, 7],
	[1, 27, 9],
	[11, 18, 8],
	[20, 11, 6],
];

type Palette = {
	skyTop: string;
	skyBottom: string;
	glow: string;
	ground: string;
	edge: string;
	city: string;
	window: string;
	enemy: string;
	shot: string;
};

// The colour scheme changes every two waves, as in the arcade original.
const PALETTES: Palette[] = [
	{ skyTop: "#03040f", skyBottom: "#1a1147", glow: "#ff5fa2", ground: "#f2b84b", edge: "#ffe7a3", city: "#4cc9f0", window: "#fff3b0", enemy: "#ff4d6d", shot: "#7df9ff" },
	{ skyTop: "#020b12", skyBottom: "#06373f", glow: "#3df5c4", ground: "#2ec4b6", edge: "#b8fff3", city: "#ffd166", window: "#ffffff", enemy: "#ff7b00", shot: "#e0fbfc" },
	{ skyTop: "#0d0211", skyBottom: "#4a0d3a", glow: "#ff9e00", ground: "#c9184a", edge: "#ffb3c6", city: "#a0e426", window: "#fdffb6", enemy: "#ffd60a", shot: "#caf0f8" },
	{ skyTop: "#000814", skyBottom: "#003566", glow: "#90e0ef", ground: "#8d99ae", edge: "#edf2f4", city: "#ff70a6", window: "#ffffff", enemy: "#70e000", shot: "#ffd6ff" },
	{ skyTop: "#0b0500", skyBottom: "#5a1a00", glow: "#ffba08", ground: "#6a4c93", edge: "#d0bdf4", city: "#f8f9fa", window: "#ffd166", enemy: "#48cae4", shot: "#ffffff" },
];

type Phase = "title" | "playing" | "tally" | "over";
type City = { x: number; alive: boolean };
type Battery = { x: number; ammo: number; alive: boolean };
type Flight = { x0: number; y0: number; x: number; y: number; tx: number; ty: number; vx: number; vy: number };
type Enemy = Flight & { target: number; splitY: number | null; dead: boolean };
type Shot = Flight & { speed: number };
type Blast = { x: number; y: number; age: number; dur: number; max: number; r: number };
type Spark = { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string };
type Star = { x: number; y: number; r: number; phase: number; speed: number };

function rgba(hex: string, a: number) {
	const n = parseInt(hex.slice(1), 16);
	return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

// Deterministic 0..1 noise so city windows don't flicker between frames
function hash(a: number, b: number, c: number) {
	const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
	return s - Math.floor(s);
}

const pad = (n: number) => String(n).padStart(6, "0");

export class Game {
	phase: Phase = "title";
	paused = false;
	score = 0;
	best = 0;
	wave = 1;
	aim = { x: W / 2, y: H / 2 };
	keys = { left: false, right: false, up: false, down: false };
	readonly sfx = new Sfx();

	private cities: City[] = CITY_X.map((x) => ({ x, alive: true }));
	private batteries: Battery[] = BATTERY_X.map((x) => ({ x, ammo: AMMO, alive: true }));
	private enemies: Enemy[] = [];
	private shots: Shot[] = [];
	private blasts: Blast[] = [];
	private sparks: Spark[] = [];
	private stars: Star[] = [];
	private pending = 0;
	private spawnIn = 0;
	private time = 0;
	private phaseTime = 0;
	private shake = 0;
	private flash = 0;
	private notice = 0;
	private bonusBank = 0;
	private nextBonusAt = BONUS_CITY_EVERY;
	private tally = { ammo: 0, cities: 0, timer: 0, done: false };

	constructor() {
		try {
			this.best = Number(localStorage.getItem(BEST_KEY)) || 0;
		} catch {
			// best score just won't persist
		}
		for (let i = 0; i < 120; i++) {
			this.stars.push({
				x: Math.random() * W,
				y: Math.random() * (GROUND - 60),
				r: 0.4 + Math.random() * 1.1,
				phase: Math.random() * Math.PI * 2,
				speed: 0.6 + Math.random() * 2.4,
			});
		}
	}

	private get palette() {
		return PALETTES[Math.floor((this.wave - 1) / 2) % PALETTES.length];
	}

	private get multiplier() {
		return Math.min(6, Math.ceil(this.wave / 2));
	}

	/** Enter / click on the title or game-over screen. Returns true if a game started. */
	confirm() {
		if (this.phase === "title" || (this.phase === "over" && this.phaseTime > 1.2)) {
			this.score = 0;
			this.wave = 1;
			this.bonusBank = 0;
			this.nextBonusAt = BONUS_CITY_EVERY;
			this.cities.forEach((c) => (c.alive = true));
			this.beginWave();
			return true;
		}
		return false;
	}

	/** Click or fire key: starts the game if it isn't running, otherwise launches a missile. */
	press(battery?: number) {
		if (this.phase === "playing") this.fire(battery);
		else this.confirm();
	}

	togglePause() {
		if (this.phase === "playing" || this.phase === "tally") this.paused = !this.paused;
	}

	private beginWave() {
		this.phase = "playing";
		this.phaseTime = 0;
		this.paused = false;
		this.enemies = [];
		this.shots = [];
		this.blasts = [];
		this.batteries.forEach((b) => {
			b.ammo = AMMO;
			b.alive = true;
		});
		while (this.bonusBank > 0) {
			const dead = this.cities.filter((c) => !c.alive);
			if (!dead.length) break;
			dead[Math.floor(Math.random() * dead.length)].alive = true;
			this.bonusBank--;
		}
		this.pending = Math.min(8 + this.wave * 2, 30);
		this.spawnIn = 1.6;
	}

	private addScore(points: number) {
		this.score += points;
		while (this.score >= this.nextBonusAt) {
			this.bonusBank++;
			this.nextBonusAt += BONUS_CITY_EVERY;
			this.notice = 2.5;
		}
		if (this.score > this.best) this.best = this.score;
	}

	private saveBest() {
		try {
			localStorage.setItem(BEST_KEY, String(this.best));
		} catch {
			// ignore
		}
	}

	private fire(index?: number) {
		const ty = Math.min(this.aim.y, GROUND - 40);
		const tx = this.aim.x;
		let battery: Battery | undefined;
		if (index !== undefined) {
			battery = this.batteries[index];
		} else {
			battery = this.batteries
				.filter((b) => b.alive && b.ammo > 0)
				.sort((a, b) => Math.abs(a.x - tx) - Math.abs(b.x - tx))[0];
		}
		if (!battery || !battery.alive || battery.ammo <= 0) {
			this.sfx.empty();
			return;
		}
		battery.ammo--;
		const x0 = battery.x;
		const y0 = GROUND - MOUND - 6;
		const speed = battery === this.batteries[1] ? 760 : 560;
		const d = Math.hypot(tx - x0, ty - y0) || 1;
		this.shots.push({
			x0, y0, x: x0, y: y0, tx, ty, speed,
			vx: ((tx - x0) / d) * speed,
			vy: ((ty - y0) / d) * speed,
		});
		this.sfx.launch();
	}

	private spawnEnemy(from?: { x: number; y: number }) {
		// Targets 0-5 are cities, 6-8 are batteries; mostly aim at something still standing.
		const alive: number[] = [];
		this.cities.forEach((c, i) => c.alive && alive.push(i));
		this.batteries.forEach((b, i) => b.alive && alive.push(6 + i));
		const target =
			alive.length && Math.random() < 0.85
				? alive[Math.floor(Math.random() * alive.length)]
				: Math.floor(Math.random() * 9);
		const tx = target < 6 ? CITY_X[target] : BATTERY_X[target - 6];
		const ty = target < 6 ? GROUND : GROUND - MOUND;
		const x0 = from ? from.x : 20 + Math.random() * (W - 40);
		const y0 = from ? from.y : -6;
		const speed = Math.min(30 + this.wave * 8, 150) * (0.85 + Math.random() * 0.3);
		const d = Math.hypot(tx - x0, ty - y0) || 1;
		const splits = !from && Math.random() < Math.min(0.12 + this.wave * 0.04, 0.5);
		this.enemies.push({
			x0, y0, x: x0, y: y0, tx, ty, target,
			vx: ((tx - x0) / d) * speed,
			vy: ((ty - y0) / d) * speed,
			splitY: splits ? 110 + Math.random() * 200 : null,
			dead: false,
		});
	}

	private addBlast(x: number, y: number, max: number, dur = 1.1) {
		this.blasts.push({ x, y, age: 0, dur, max, r: 0 });
	}

	private addSparks(x: number, y: number, count: number, color: string, power = 1) {
		for (let i = 0; i < count; i++) {
			const a = Math.random() * Math.PI * 2;
			const v = (40 + Math.random() * 160) * power;
			const max = 0.4 + Math.random() * 0.7;
			this.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, life: max, max, color });
		}
	}

	private impact(e: Enemy) {
		this.addBlast(e.tx, e.ty, 38, 1);
		// On the title and game-over screens the falling missiles are just scenery.
		if (this.phase !== "playing") return;
		const p = this.palette;
		if (e.target < 6) {
			const city = this.cities[e.target];
			if (city.alive) {
				city.alive = false;
				this.shake = 14;
				this.flash = 0.5;
				this.addSparks(e.tx, e.ty - 10, 50, p.city, 1.3);
				this.sfx.boom(true);
				return;
			}
		} else {
			const battery = this.batteries[e.target - 6];
			if (battery.alive) {
				battery.alive = false;
				battery.ammo = 0;
				this.shake = 8;
				this.addSparks(e.tx, e.ty - 8, 30, p.shot, 1.1);
				this.sfx.boom(true);
				return;
			}
		}
		this.sfx.boom();
	}

	update(dt: number) {
		if (this.paused) return;
		this.time += dt;
		this.phaseTime += dt;
		this.shake = Math.max(0, this.shake - dt * 30);
		this.flash = Math.max(0, this.flash - dt * 1.6);
		this.notice = Math.max(0, this.notice - dt);

		const k = this.keys;
		this.aim.x = Math.max(0, Math.min(W, this.aim.x + (+k.right - +k.left) * 520 * dt));
		this.aim.y = Math.max(0, Math.min(H, this.aim.y + (+k.down - +k.up) * 520 * dt));

		const playing = this.phase === "playing";

		// Spawning: scripted volleys while playing, a light drizzle as scenery otherwise.
		this.spawnIn -= dt;
		if (this.spawnIn <= 0) {
			if (playing && this.pending > 0) {
				const volley = Math.min(this.pending, 1 + Math.floor(Math.random() * Math.min(4, 1 + this.wave / 2)));
				for (let i = 0; i < volley; i++) this.spawnEnemy();
				this.pending -= volley;
				this.spawnIn = Math.max(0.5, 2.6 - this.wave * 0.15) * (0.5 + Math.random());
			} else if (this.phase === "title" || this.phase === "over") {
				if (this.enemies.length < 6) this.spawnEnemy();
				this.spawnIn = 0.7 + Math.random() * 0.9;
			}
		}

		for (const s of this.shots) {
			s.x += s.vx * dt;
			s.y += s.vy * dt;
		}
		this.shots = this.shots.filter((s) => {
			if (Math.hypot(s.tx - s.x, s.ty - s.y) > s.speed * dt && s.y > s.ty) return true;
			this.addBlast(s.tx, s.ty, 42);
			this.sfx.boom();
			return false;
		});

		const split: Enemy[] = [];
		for (const e of this.enemies) {
			e.x += e.vx * dt;
			e.y += e.vy * dt;
			if (e.splitY !== null && e.y >= e.splitY) {
				e.splitY = null;
				split.push(e);
			}
			if (e.y >= e.ty) {
				e.dead = true;
				this.impact(e);
			}
		}
		for (const e of split) {
			const extra = 1 + Math.floor(Math.random() * 2);
			for (let i = 0; i < extra; i++) this.spawnEnemy(e);
		}

		for (const b of this.blasts) {
			b.age += dt;
			b.r = b.max * Math.sin(Math.PI * Math.pow(Math.min(1, b.age / b.dur), 0.7));
		}
		this.blasts = this.blasts.filter((b) => b.age < b.dur);

		// Anything caught in a fireball goes up too, which is what makes chain reactions.
		const p = this.palette;
		const chained: Enemy[] = [];
		for (const e of this.enemies) {
			if (e.dead) continue;
			if (this.blasts.some((b) => Math.hypot(e.x - b.x, e.y - b.y) <= b.r)) {
				e.dead = true;
				chained.push(e);
			}
		}
		for (const e of chained) {
			this.addBlast(e.x, e.y, 30, 0.9);
			this.addSparks(e.x, e.y, 14, p.enemy);
			if (playing) {
				this.addScore(25 * this.multiplier);
				this.sfx.boom();
			}
		}
		this.enemies = this.enemies.filter((e) => !e.dead);

		for (const s of this.sparks) {
			s.life -= dt;
			s.vy += 220 * dt;
			s.x += s.vx * dt;
			s.y += s.vy * dt;
		}
		this.sparks = this.sparks.filter((s) => s.life > 0 && s.y < GROUND + 4);

		if (
			playing &&
			this.phaseTime > 1 &&
			this.pending === 0 &&
			!this.enemies.length &&
			!this.shots.length &&
			!this.blasts.length
		) {
			this.phase = "tally";
			this.phaseTime = 0;
			this.tally = { ammo: 0, cities: 0, timer: 0.7, done: false };
		}

		if (this.phase === "tally") this.updateTally(dt);
	}

	private updateTally(dt: number) {
		const t = this.tally;
		t.timer -= dt;
		if (t.timer > 0) return;

		const loaded = this.batteries.find((b) => b.ammo > 0);
		const standing = this.cities.filter((c) => c.alive).length;
		if (loaded) {
			loaded.ammo--;
			t.ammo++;
			this.addScore(5 * this.multiplier);
			this.sfx.blip();
			t.timer = 0.06;
		} else if (t.cities < standing) {
			t.cities++;
			this.addScore(100 * this.multiplier);
			this.sfx.blip();
			t.timer = 0.28;
		} else if (!t.done) {
			t.done = true;
			t.timer = 1.6;
		} else if (standing === 0 && this.bonusBank === 0) {
			this.phase = "over";
			this.phaseTime = 0;
			this.spawnIn = 1;
			this.saveBest();
		} else {
			this.saveBest();
			this.wave++;
			this.beginWave();
		}
	}

	draw(ctx: CanvasRenderingContext2D) {
		const p = this.palette;
		ctx.save();
		if (this.shake > 0) {
			ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
		}

		this.drawSky(ctx, p);
		this.drawGround(ctx, p);
		this.cities.forEach((c, i) => drawCity(ctx, c.x, GROUND, i, p, c.alive));
		this.batteries.forEach((b) => this.drawBattery(ctx, b, p));
		this.drawFlights(ctx, p);
		this.drawBlasts(ctx, p);

		ctx.restore();

		if (this.flash > 0) {
			ctx.fillStyle = `rgba(255,255,255,${this.flash})`;
			ctx.fillRect(0, 0, W, H);
		}

		const vignette = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.75);
		vignette.addColorStop(0, "rgba(0,0,0,0)");
		vignette.addColorStop(1, "rgba(0,0,0,0.55)");
		ctx.fillStyle = vignette;
		ctx.fillRect(0, 0, W, H);

		this.drawHud(ctx, p);
		this.drawOverlay(ctx, p);
		this.drawCrosshair(ctx, p);
	}

	private drawSky(ctx: CanvasRenderingContext2D, p: Palette) {
		const sky = ctx.createLinearGradient(0, 0, 0, GROUND);
		sky.addColorStop(0, p.skyTop);
		sky.addColorStop(1, p.skyBottom);
		ctx.fillStyle = sky;
		ctx.fillRect(-20, -20, W + 40, H + 40);

		const glow = ctx.createRadialGradient(W / 2, GROUND + 40, 20, W / 2, GROUND + 40, 520);
		glow.addColorStop(0, rgba(p.glow, 0.38));
		glow.addColorStop(1, rgba(p.glow, 0));
		ctx.fillStyle = glow;
		ctx.fillRect(-20, 0, W + 40, GROUND);

		for (const s of this.stars) {
			const a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this.time * s.speed + s.phase));
			ctx.fillStyle = `rgba(255,255,255,${a * (1 - (s.y / GROUND) * 0.6)})`;
			ctx.beginPath();
			ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
			ctx.fill();
		}
	}

	private drawGround(ctx: CanvasRenderingContext2D, p: Palette) {
		ctx.beginPath();
		ctx.moveTo(-20, H + 20);
		ctx.lineTo(-20, GROUND);
		for (const x of BATTERY_X) {
			ctx.lineTo(x - 58, GROUND);
			ctx.lineTo(x - 34, GROUND - MOUND);
			ctx.lineTo(x + 34, GROUND - MOUND);
			ctx.lineTo(x + 58, GROUND);
		}
		ctx.lineTo(W + 20, GROUND);
		ctx.lineTo(W + 20, H + 20);
		ctx.closePath();
		const fill = ctx.createLinearGradient(0, GROUND - MOUND, 0, H);
		fill.addColorStop(0, p.ground);
		fill.addColorStop(1, rgba(p.ground, 0.35));
		ctx.fillStyle = "#000";
		ctx.fill();
		ctx.fillStyle = fill;
		ctx.fill();
		ctx.save();
		ctx.shadowColor = p.edge;
		ctx.shadowBlur = 10;
		ctx.strokeStyle = p.edge;
		ctx.lineWidth = 1.5;
		ctx.stroke();
		ctx.restore();
	}

	private drawBattery(ctx: CanvasRenderingContext2D, b: Battery, p: Palette) {
		// Remaining missiles stacked in a 1-2-3-4 pyramid on top of the mound
		let i = 0;
		for (let row = 0; row < 4; row++) {
			for (let col = 0; col <= row; col++, i++) {
				if (i >= b.ammo) continue;
				drawMissile(ctx, b.x + (col - row / 2) * 10, GROUND - MOUND - 30 + row * 7, p.shot);
			}
		}
		ctx.font = `700 12px ${FONT}`;
		ctx.textAlign = "center";
		ctx.fillStyle = "rgba(0,0,0,0.7)";
		ctx.fillText(b.ammo > 0 ? String(b.ammo) : "OUT", b.x, GROUND - 6);
	}

	private drawFlights(ctx: CanvasRenderingContext2D, p: Palette) {
		ctx.save();
		ctx.globalCompositeOperation = "lighter";
		ctx.lineCap = "round";

		const trail = (f: Flight, color: string, width: number) => {
			const g = ctx.createLinearGradient(f.x0, f.y0, f.x, f.y);
			g.addColorStop(0, rgba(color, 0));
			g.addColorStop(1, rgba(color, 0.95));
			ctx.strokeStyle = g;
			ctx.lineWidth = width;
			ctx.shadowColor = color;
			ctx.shadowBlur = 10;
			ctx.beginPath();
			ctx.moveTo(f.x0, f.y0);
			ctx.lineTo(f.x, f.y);
			ctx.stroke();
			ctx.fillStyle = "#fff";
			ctx.beginPath();
			ctx.arc(f.x, f.y, 1.6 + Math.random() * 1.2, 0, Math.PI * 2);
			ctx.fill();
		};

		for (const e of this.enemies) trail(e, p.enemy, 2);
		for (const s of this.shots) trail(s, p.shot, 1.6);

		// Blinking X where each defensive missile will detonate
		ctx.shadowBlur = 0;
		if (Math.floor(this.time * 12) % 2 === 0) {
			ctx.strokeStyle = p.shot;
			ctx.lineWidth = 1.5;
			for (const s of this.shots) {
				ctx.beginPath();
				ctx.moveTo(s.tx - 4, s.ty - 4);
				ctx.lineTo(s.tx + 4, s.ty + 4);
				ctx.moveTo(s.tx + 4, s.ty - 4);
				ctx.lineTo(s.tx - 4, s.ty + 4);
				ctx.stroke();
			}
		}
		ctx.restore();
	}

	private drawBlasts(ctx: CanvasRenderingContext2D, p: Palette) {
		const colors = ["#ffffff", p.shot, "#ffd166", p.enemy];
		ctx.save();
		ctx.globalCompositeOperation = "lighter";
		this.blasts.forEach((b, i) => {
			if (b.r <= 0.5) return;
			const color = colors[(Math.floor(this.time * 18) + i) % colors.length];
			const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
			g.addColorStop(0, "rgba(255,255,255,0.95)");
			g.addColorStop(0.45, rgba(color, 0.8));
			g.addColorStop(1, rgba(color, 0));
			ctx.fillStyle = g;
			ctx.beginPath();
			ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
			ctx.fill();
			ctx.strokeStyle = rgba(color, 0.5);
			ctx.lineWidth = 1;
			ctx.stroke();
		});
		for (const s of this.sparks) {
			ctx.fillStyle = rgba(s.color, s.life / s.max);
			ctx.fillRect(s.x - 1, s.y - 1, 2.2, 2.2);
		}
		ctx.restore();
	}

	private drawHud(ctx: CanvasRenderingContext2D, p: Palette) {
		ctx.font = `700 17px ${FONT}`;
		ctx.fillStyle = p.edge;
		ctx.shadowColor = p.glow;
		ctx.shadowBlur = 8;
		ctx.textAlign = "left";
		ctx.fillText(`SCORE ${pad(this.score)}`, 24, 32);
		ctx.textAlign = "center";
		ctx.fillText(`HIGH ${pad(this.best)}`, W / 2, 32);
		ctx.textAlign = "right";
		ctx.fillText(`WAVE ${this.wave}  ×${this.multiplier}`, W - 24, 32);
		if (this.notice > 0) {
			ctx.textAlign = "center";
			ctx.globalAlpha = Math.min(1, this.notice);
			ctx.fillText("BONUS CITY EARNED", W / 2, 58);
			ctx.globalAlpha = 1;
		}
		ctx.shadowBlur = 0;
	}

	private drawOverlay(ctx: CanvasRenderingContext2D, p: Palette) {
		const text = (s: string, y: number, size: number, color: string, alpha = 1) => {
			ctx.save();
			ctx.globalAlpha = alpha;
			ctx.font = `800 ${size}px ${FONT}`;
			ctx.textAlign = "center";
			ctx.shadowColor = color;
			ctx.shadowBlur = size * 0.5;
			ctx.fillStyle = color;
			ctx.fillText(s, W / 2, y);
			ctx.shadowBlur = 0;
			ctx.fillStyle = "rgba(255,255,255,0.75)";
			ctx.fillText(s, W / 2, y);
			ctx.restore();
		};
		const blink = 0.55 + 0.45 * Math.sin(this.time * 4);

		if (this.paused) {
			text("PAUSED", 280, 54, p.shot);
			text("PRESS P TO RESUME", 330, 18, p.edge, blink);
			return;
		}

		if (this.phase === "title") {
			text("MISSILE", 220, 86, p.enemy);
			text("COMMAND", 300, 86, p.shot);
			text("CLICK OR PRESS ENTER TO DEFEND", 370, 20, p.edge, blink);
			text("AIM WITH THE MOUSE · CLICK TO FIRE · 1 2 3 PICK A BATTERY", 410, 14, p.edge, 0.8);
		} else if (this.phase === "playing" && this.phaseTime < 2.4) {
			const a = Math.min(1, (2.4 - this.phaseTime) * 1.5);
			text(`WAVE ${this.wave}`, 250, 56, p.shot, a);
			text(`${this.multiplier}× POINTS · DEFEND YOUR CITIES`, 295, 18, p.edge, a);
		} else if (this.phase === "tally") {
			const m = this.multiplier;
			text("BONUS POINTS", 190, 40, p.shot);
			text(String(this.tally.ammo * 5 * m), 250, 24, p.edge);
			for (let i = 0; i < this.tally.ammo; i++) {
				drawMissile(ctx, W / 2 - (this.tally.ammo - 1) * 5 + i * 10, 262, p.shot);
			}
			text(String(this.tally.cities * 100 * m), 320, 24, p.edge);
			for (let i = 0; i < this.tally.cities; i++) {
				drawCity(ctx, W / 2 - (this.tally.cities - 1) * 32 + i * 64, 372, i, p, true);
			}
		} else if (this.phase === "over") {
			const grow = Math.min(1, this.phaseTime / 1.4);
			const r = 60 + grow * 240;
			const g = ctx.createRadialGradient(W / 2, 270, 0, W / 2, 270, r);
			g.addColorStop(0, rgba(p.enemy, 0.85));
			g.addColorStop(0.6, rgba(p.enemy, 0.3));
			g.addColorStop(1, rgba(p.enemy, 0));
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, W, H);
			text("THE END", 285, 92, "#ffffff", grow);
			if (this.phaseTime > 1.2) {
				text(`FINAL SCORE ${this.score}`, 345, 24, p.edge);
				text("CLICK OR PRESS ENTER TO PLAY AGAIN", 385, 18, p.edge, blink);
			}
		}
	}

	private drawCrosshair(ctx: CanvasRenderingContext2D, p: Palette) {
		const { x, y } = this.aim;
		ctx.save();
		ctx.strokeStyle = p.shot;
		ctx.shadowColor = p.shot;
		ctx.shadowBlur = 6;
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			ctx.moveTo(x + dx * 4, y + dy * 4);
			ctx.lineTo(x + dx * 11, y + dy * 11);
		}
		ctx.stroke();
		ctx.restore();
	}
}

function drawMissile(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.moveTo(x, y - 3.5);
	ctx.lineTo(x + 2, y);
	ctx.lineTo(x + 2, y + 3);
	ctx.lineTo(x - 2, y + 3);
	ctx.lineTo(x - 2, y);
	ctx.closePath();
	ctx.fill();
}

function drawCity(ctx: CanvasRenderingContext2D, x: number, base: number, seed: number, p: Palette, alive: boolean) {
	if (!alive) {
		ctx.fillStyle = "rgba(0,0,0,0.55)";
		for (const [dx, h, w] of BUILDINGS) ctx.fillRect(x + dx, base - h * 0.18, w, h * 0.18);
		return;
	}
	const fill = ctx.createLinearGradient(0, base - 28, 0, base);
	fill.addColorStop(0, p.city);
	fill.addColorStop(1, rgba(p.city, 0.45));
	ctx.save();
	ctx.shadowColor = p.city;
	ctx.shadowBlur = 8;
	ctx.fillStyle = fill;
	for (const [dx, h, w] of BUILDINGS) ctx.fillRect(x + dx, base - h, w, h);
	ctx.restore();

	ctx.fillStyle = p.window;
	BUILDINGS.forEach(([dx, h, w], b) => {
		for (let wy = 3; wy < h - 2; wy += 4) {
			for (let wx = 1.5; wx < w - 2; wx += 3) {
				if (hash(seed + 1, b + wx, wy) > 0.5) ctx.fillRect(x + dx + wx, base - h + wy, 1.5, 2);
			}
		}
	});
}
