// Where every name lives on the Earth.
//
// The sphere (between 84°S and 84°N) is divided into BASE_CELLS cells of
// roughly equal size, about six times wider than tall: the shape of a name.
// Slots are handed out in order, one per published memorial:
//
//   level 0  one slot per base cell, anchored at the cell's lower-left corner
//   level L  three new slots in every level L-1 cell, at the other corners of
//            its 2x2 subdivision
//
// A slot's anchor never moves. What changes is the shared text size: once
// level L is full, every name is drawn at 1/2^(L+1) of a base cell, so names
// get finer as the world fills, and no two ever overlap. Within a level, slots
// are visited in a golden-ratio stride so each new name lands far from the
// last and the whole Earth fills evenly.
//
// Everything here is pure arithmetic shared by the browser and the server, so
// a slot number alone is enough to find a name's place.

export const LAT_MAX = 84;
export const ROWS = 90;
export const ROW_H = (2 * LAT_MAX) / ROWS;
const EQUATOR_COLS = 32;
const PHI = 0.6180339887498949;

const rowCols: number[] = [];
const rowStart: number[] = [];
const cellRowIndex: number[] = [];
let total = 0;
for (let r = 0; r < ROWS; r++) {
	const lat = -LAT_MAX + (r + 0.5) * ROW_H;
	const cols = Math.max(4, Math.round(EQUATOR_COLS * Math.cos((lat * Math.PI) / 180)));
	rowStart.push(total);
	rowCols.push(cols);
	for (let c = 0; c < cols; c++) cellRowIndex.push(r);
	total += cols;
}

export const BASE_CELLS = total;
/** Deepest level the arithmetic below stays exact for (about 32 million names). */
export const MAX_LEVEL = 7;

export const capacity = (level: number) => BASE_CELLS * 4 ** level;

/** The level a slot was created at. */
export function levelOf(slot: number) {
	let level = 0;
	while (slot >= capacity(level)) level++;
	return level;
}

/** The level every name is currently drawn at, given how many slots have been handed out. */
export const currentLevel = (slotsUsed: number) => (slotsUsed <= 0 ? 0 : Math.min(MAX_LEVEL, levelOf(slotsUsed - 1)));

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

function modInverse(a: number, m: number) {
	let [r0, r1, t0, t1] = [m, a, 0, 1];
	while (r1) {
		const q = Math.floor(r0 / r1);
		[r0, r1] = [r1, r0 - q * r1];
		[t0, t1] = [t1, t0 - q * t1];
	}
	return ((t0 % m) + m) % m;
}

function mulmod(a: number, b: number, m: number) {
	const product = a * b;
	return product < Number.MAX_SAFE_INTEGER ? product % m : Number((BigInt(a) * BigInt(b)) % BigInt(m));
}

type Stride = { size: number; g: number; inverse: number };
const strides: Stride[] = [];

/** The permutation used within a level: slot order -> position order, and back. */
function stride(level: number): Stride {
	if (strides[level]) return strides[level];
	let size: number;
	let g: number;
	if (level === 0) {
		size = BASE_CELLS;
		g = Math.round(BASE_CELLS * PHI);
		while (gcd(g, size) !== 1) g++;
	} else {
		size = 3 * capacity(level - 1);
		// Congruent to the level-0 stride, so each run of BASE_CELLS new names touches every base cell once.
		g = stride(0).g + BASE_CELLS * Math.round(PHI * (size / BASE_CELLS));
		while (gcd(g, size) !== 1) g += BASE_CELLS;
		g %= size;
	}
	return (strides[level] = { size, g, inverse: modInverse(g, size) });
}

function morton(x: number, y: number) {
	let out = 0;
	for (let bit = 0; bit < MAX_LEVEL; bit++) out += (((x >> bit) & 1) + 2 * ((y >> bit) & 1)) * 4 ** bit;
	return out;
}

function demorton(q: number): [number, number] {
	let x = 0;
	let y = 0;
	for (let bit = 0; q > 0; bit++) {
		const digit = q % 4;
		x |= (digit & 1) << bit;
		y |= (digit >> 1) << bit;
		q = Math.floor(q / 4);
	}
	return [x, y];
}

export type SlotPosition = { cell: number; level: number; x: number; y: number };

/** A slot's anchor: its base cell, its level, and its corner (x, y) in that cell's 2^level grid. */
export function slotPosition(slot: number): SlotPosition {
	const level = levelOf(slot);
	if (level === 0) return { cell: mulmod(slot, stride(0).g, BASE_CELLS), level: 0, x: 0, y: 0 };
	const { size, g } = stride(level);
	const j = mulmod(slot - capacity(level - 1), g, size);
	const sub = Math.floor(j / BASE_CELLS);
	const child = sub % 3;
	const [px, py] = demorton(Math.floor(sub / 3));
	return { cell: j % BASE_CELLS, level, x: 2 * px + (child !== 1 ? 1 : 0), y: 2 * py + (child !== 0 ? 1 : 0) };
}

/** The slot whose name occupies position (x, y) of a base cell's 2^level grid. Inverse of slotPosition. */
export function slotAt(cell: number, level: number, x: number, y: number) {
	while (level > 0 && !(x & 1) && !(y & 1)) {
		x >>= 1;
		y >>= 1;
		level--;
	}
	if (level === 0) return mulmod(cell, stride(0).inverse, BASE_CELLS);
	const child = x & 1 ? (y & 1 ? 2 : 0) : 1;
	const j = (3 * morton(x >> 1, y >> 1) + child) * BASE_CELLS + cell;
	const { size, inverse } = stride(level);
	return capacity(level - 1) + mulmod(j, inverse, size);
}

export type Rect = { lat0: number; lon0: number; dLat: number; dLon: number };

export const cellRow = (cell: number) => cellRowIndex[cell];
export const colsInRow = (row: number) => rowCols[row];
export const firstCellInRow = (row: number) => rowStart[row];

export function cellRect(cell: number): Rect {
	const row = cellRowIndex[cell];
	const dLon = 360 / rowCols[row];
	return { lat0: -LAT_MAX + row * ROW_H, lon0: -180 + (cell - rowStart[row]) * dLon, dLat: ROW_H, dLon };
}

/** The rectangle a slot's name is drawn in when names are at `level`. */
export function slotRect(slot: number, level: number): Rect {
	const pos = slotPosition(slot);
	const base = cellRect(pos.cell);
	const own = 2 ** pos.level;
	const shown = 2 ** Math.max(level, pos.level);
	return {
		lat0: base.lat0 + (pos.y / own) * base.dLat,
		lon0: base.lon0 + (pos.x / own) * base.dLon,
		dLat: base.dLat / shown,
		dLon: base.dLon / shown,
	};
}

/** The slot drawn at a point on the Earth when names are at `level`, or -1 in the polar caps. */
export function slotAtPoint(lat: number, lon: number, level: number) {
	if (lat <= -LAT_MAX || lat >= LAT_MAX) return -1;
	const row = Math.min(ROWS - 1, Math.floor((lat + LAT_MAX) / ROW_H));
	const cols = rowCols[row];
	const fx = ((((lon + 180) % 360) + 360) % 360) / (360 / cols);
	const col = Math.min(cols - 1, Math.floor(fx));
	const n = 2 ** level;
	const x = Math.min(n - 1, Math.floor((fx - col) * n));
	const y = Math.min(n - 1, Math.floor(((lat + LAT_MAX) / ROW_H - row) * n));
	return slotAt(rowStart[row] + col, level, x, y);
}
