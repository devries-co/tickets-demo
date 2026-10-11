// The Earth colour map: what colour a name is, given where it sits.
// Derived from a land/ocean mask plus latitude, so the same function gives the
// same answer in the browser (drawing) and on the server (stored colour).

import { LANDMASK_B64, LANDMASK_H, LANDMASK_W } from "./landmask";

export type RGB = [number, number, number];

const W = LANDMASK_W;
const H = LANDMASK_H;
let land: Uint8Array | null = null;
/** Land fraction within about two degrees: 0 in open ocean, 1 deep inland. Used for coastal shallows. */
let coast: Float32Array | null = null;

function init() {
	const packed = Uint8Array.from(atob(LANDMASK_B64), (ch) => ch.charCodeAt(0));
	const mask = new Uint8Array(W * H);
	for (let i = 0; i < W * H; i++) mask[i] = (packed[i >> 3] >> (i & 7)) & 1;
	// The source polygons stop short of the south pole; it is all ice sheet.
	for (let y = Math.floor((172 / 180) * H); y < H; y++) mask.fill(1, y * W, (y + 1) * W);

	const R = 4;
	const horizontal = new Float32Array(W * H);
	const blurred = new Float32Array(W * H);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			let sum = 0;
			for (let d = -R; d <= R; d++) sum += mask[y * W + ((x + d + W) % W)];
			horizontal[y * W + x] = sum / (2 * R + 1);
		}
	}
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			let sum = 0;
			for (let d = -R; d <= R; d++) sum += horizontal[Math.min(H - 1, Math.max(0, y + d)) * W + x];
			blurred[y * W + x] = sum / (2 * R + 1);
		}
	}
	land = mask;
	coast = blurred;
}

function index(lat: number, lon: number) {
	const x = Math.floor(((((lon + 180) % 360) + 360) % 360) / 360 * W) % W;
	const y = Math.min(H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * H)));
	return y * W + x;
}

export function isLand(lat: number, lon: number) {
	if (!land) init();
	return land![index(lat, lon)] === 1;
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (lo: number, hi: number, v: number) => {
	const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
	return t * t * (3 - 2 * t);
};

function hash(x: number, y: number) {
	const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
	return s - Math.floor(s);
}

/** Smooth 0..1 noise so biomes blend instead of forming stripes. */
function noise(lat: number, lon: number, scale: number) {
	const x = lon / scale;
	const y = lat / scale;
	const ix = Math.floor(x);
	const iy = Math.floor(y);
	const fx = x - ix;
	const fy = y - iy;
	const u = fx * fx * (3 - 2 * fx);
	const v = fy * fy * (3 - 2 * fy);
	const top = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * u;
	const bottom = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * u;
	return top + (bottom - top) * v;
}

const OCEAN_DEEP: RGB = [26, 84, 186];
const OCEAN_MID: RGB = [28, 126, 212];
const OCEAN_SHALLOW: RGB = [38, 186, 204];
const OCEAN_CYAN: RGB = [118, 226, 236];
const SEA_ICE: RGB = [206, 230, 244];
const TROPICAL: RGB = [44, 158, 78];
const TEMPERATE: RGB = [98, 172, 82];
const BOREAL: RGB = [50, 128, 88];
const TUNDRA: RGB = [142, 150, 122];
const DESERT: RGB = [220, 182, 108];
const DRY_EARTH: RGB = [172, 124, 76];
const ICE: RGB = [240, 246, 252];
const ICE_SHADOW: RGB = [196, 222, 244];

// [lat south, lat north, lon west, lon east]: the world's large dry regions.
const ARID: [number, number, number, number][] = [
	[14, 33, -17, 60], // Sahara and Arabia
	[24, 46, 46, 78], // Iran to Central Asia
	[36, 48, 78, 112], // Taklamakan and Gobi
	[-31, -19, 116, 144], // Australian interior
	[23, 39, -119, -101], // American south-west
	[-30, -17, 12, 26], // Namib and Kalahari
	[-50, -18, -72, -65], // Atacama and Patagonia
];

function aridity(lat: number, lon: number) {
	let best = 0;
	for (const [s, n, w, e] of ARID) {
		const inLat = smooth(s - 4, s + 3, lat) * (1 - smooth(n - 3, n + 4, lat));
		const inLon = smooth(w - 5, w + 4, lon) * (1 - smooth(e - 4, e + 5, lon));
		best = Math.max(best, inLat * inLon);
	}
	return best;
}

/** The colour of the Earth at a point, 0-255 per channel. */
export function earthColor(lat: number, lon: number): RGB {
	if (!land) init();
	const i = index(lat, lon);
	const abs = Math.abs(lat);
	const wobble = noise(lat, lon, 7);
	const grain = noise(lat, lon, 1.7);

	if (land![i]) {
		const iceCap = lat < -60 || lat > 74 + wobble * 4 || (lat > 60 && lon > -58 && lon < -18);
		if (iceCap) return mix(ICE, ICE_SHADOW, grain * 0.7);

		let color = mix(TROPICAL, TEMPERATE, smooth(12, 34, abs + wobble * 8));
		color = mix(color, BOREAL, smooth(44, 56, abs + wobble * 6));
		color = mix(color, mix(DESERT, DRY_EARTH, grain), aridity(lat, lon) * (0.75 + 0.25 * wobble));
		color = mix(color, TUNDRA, smooth(60, 68, abs + wobble * 5));
		color = mix(color, ICE, smooth(69, 76, abs + wobble * 5));
		return mix(color, [color[0] * 0.8, color[1] * 0.8, color[2] * 0.8], grain * 0.5);
	}

	if (lat > 79 + wobble * 5 || lat < -68 - wobble * 4) return mix(SEA_ICE, ICE, grain * 0.5);
	const shelf = coast![i];
	let color = mix(OCEAN_DEEP, OCEAN_MID, smooth(0, 0.12, shelf) * 0.8 + wobble * 0.35);
	color = mix(color, OCEAN_SHALLOW, smooth(0.08, 0.38, shelf) * (1 - smooth(45, 70, abs) * 0.6));
	color = mix(color, OCEAN_CYAN, smooth(0.3, 0.55, shelf) * 0.7 * (1 - smooth(30, 55, abs)));
	return mix(color, SEA_ICE, smooth(66, 80, abs) * 0.45);
}

export const toHex = ([r, g, b]: RGB) =>
	"#" + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
