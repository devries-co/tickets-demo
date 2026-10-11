export const COLS = 10;
export const ROWS = 20;

export type Matrix = number[][];
export type Piece = { shape: Matrix; x: number; y: number };
export type Status = "ready" | "playing" | "paused" | "over";

export type Game = {
	board: Matrix;
	piece: Piece;
	next: number;
	score: number;
	best: number;
	lines: number;
	level: number;
	status: Status;
};

// `rand` is a Math.random() value supplied by the caller so the reducer stays pure.
export type Action = {
	type: "start" | "pause" | "left" | "right" | "rotate" | "rotateBack" | "soft" | "hard" | "tick";
	rand: number;
};

// Cell values are 1-based indexes into COLORS; 0 is empty.
export const SHAPES: Matrix[] = [
	[
		[0, 0, 0, 0],
		[1, 1, 1, 1],
		[0, 0, 0, 0],
		[0, 0, 0, 0],
	],
	[
		[2, 2],
		[2, 2],
	],
	[
		[0, 3, 0],
		[3, 3, 3],
		[0, 0, 0],
	],
	[
		[0, 4, 4],
		[4, 4, 0],
		[0, 0, 0],
	],
	[
		[5, 5, 0],
		[0, 5, 5],
		[0, 0, 0],
	],
	[
		[6, 0, 0],
		[6, 6, 6],
		[0, 0, 0],
	],
	[
		[0, 0, 7],
		[7, 7, 7],
		[0, 0, 0],
	],
];

export const COLORS = [
	"transparent",
	"#22d3ee",
	"#facc15",
	"#c084fc",
	"#4ade80",
	"#f87171",
	"#60a5fa",
	"#fb923c",
];

const LINE_POINTS = [0, 100, 300, 500, 800];
const KICKS = [0, -1, 1, -2, 2];

const emptyBoard = (): Matrix =>
	Array.from({ length: ROWS }, () => Array<number>(COLS).fill(0));

const pickType = (rand: number) => Math.floor(rand * SHAPES.length) % SHAPES.length;

function spawn(type: number): Piece {
	const shape = SHAPES[type];
	return { shape, x: Math.floor((COLS - shape[0].length) / 2), y: 0 };
}

export function collides(board: Matrix, shape: Matrix, x: number, y: number) {
	for (let r = 0; r < shape.length; r++) {
		for (let c = 0; c < shape[r].length; c++) {
			if (!shape[r][c]) continue;
			const nx = x + c;
			const ny = y + r;
			if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
			if (ny >= 0 && board[ny][nx]) return true;
		}
	}
	return false;
}

export function dropY(board: Matrix, piece: Piece) {
	let y = piece.y;
	while (!collides(board, piece.shape, piece.x, y + 1)) y++;
	return y;
}

export const tickMs = (level: number) => Math.max(100, 800 - (level - 1) * 70);

export function newGame(rand: number, best = 0): Game {
	return {
		board: emptyBoard(),
		piece: spawn(pickType(rand)),
		next: pickType((rand * SHAPES.length) % 1),
		score: 0,
		best,
		lines: 0,
		level: 1,
		status: "ready",
	};
}

function withScore(game: Game, points: number): Game {
	const score = game.score + points;
	return { ...game, score, best: Math.max(game.best, score) };
}

function move(game: Game, dx: number): Game {
	const { board, piece } = game;
	if (collides(board, piece.shape, piece.x + dx, piece.y)) return game;
	return { ...game, piece: { ...piece, x: piece.x + dx } };
}

function rotate(game: Game, clockwise: boolean): Game {
	const { board, piece } = game;
	const old = piece.shape;
	const last = old.length - 1;
	const shape = old[0].map((_, i) =>
		old.map((row, j) => (clockwise ? old[last - j][i] : row[last - i])),
	);
	for (const dx of KICKS) {
		if (!collides(board, shape, piece.x + dx, piece.y)) {
			return { ...game, piece: { ...piece, shape, x: piece.x + dx } };
		}
	}
	return game;
}

function lock(game: Game, rand: number): Game {
	const { piece } = game;
	const merged = game.board.map((row) => [...row]);
	piece.shape.forEach((row, r) =>
		row.forEach((cell, c) => {
			if (cell && piece.y + r >= 0) merged[piece.y + r][piece.x + c] = cell;
		}),
	);

	const kept = merged.filter((row) => row.some((cell) => !cell));
	const cleared = ROWS - kept.length;
	const board = [
		...Array.from({ length: cleared }, () => Array<number>(COLS).fill(0)),
		...kept,
	];

	const lines = game.lines + cleared;
	const nextPiece = spawn(game.next);
	const scored = withScore(game, LINE_POINTS[cleared] * game.level);
	return {
		...scored,
		board,
		lines,
		level: Math.floor(lines / 10) + 1,
		piece: nextPiece,
		next: pickType(rand),
		status: collides(board, nextPiece.shape, nextPiece.x, nextPiece.y)
			? "over"
			: "playing",
	};
}

function stepDown(game: Game, rand: number, points: number): Game {
	const { board, piece } = game;
	if (collides(board, piece.shape, piece.x, piece.y + 1)) return lock(game, rand);
	return withScore({ ...game, piece: { ...piece, y: piece.y + 1 } }, points);
}

export function reducer(game: Game, action: Action): Game {
	if (action.type === "start") {
		if (game.status === "playing" || game.status === "paused") return game;
		return { ...newGame(action.rand, game.best), status: "playing" };
	}
	if (action.type === "pause") {
		if (game.status === "playing") return { ...game, status: "paused" };
		if (game.status === "paused") return { ...game, status: "playing" };
		return game;
	}
	if (game.status !== "playing") return game;

	switch (action.type) {
		case "left":
			return move(game, -1);
		case "right":
			return move(game, 1);
		case "rotate":
			return rotate(game, true);
		case "rotateBack":
			return rotate(game, false);
		case "soft":
			return stepDown(game, action.rand, 1);
		case "tick":
			return stepDown(game, action.rand, 0);
		case "hard": {
			const y = dropY(game.board, game.piece);
			const dropped = withScore(
				{ ...game, piece: { ...game.piece, y } },
				(y - game.piece.y) * 2,
			);
			return lock(dropped, action.rand);
		}
	}
}
