import { useEffect, useReducer } from "react";
import {
	type Action,
	COLORS,
	SHAPES,
	dropY,
	newGame,
	reducer,
	tickMs,
} from "./tetris";
import "./App.css";

const BEST_KEY = "tetris-best";

const KEYS: Record<string, Action["type"]> = {
	ArrowLeft: "left",
	ArrowRight: "right",
	ArrowDown: "soft",
	ArrowUp: "rotate",
	x: "rotate",
	z: "rotateBack",
	" ": "hard",
	p: "pause",
	Escape: "pause",
	Enter: "start",
};

const OVERLAY = {
	ready: ["Tetris", "Press Enter to start"],
	paused: ["Paused", "Press P to resume"],
	over: ["Game over", "Press Enter to play again"],
};

function readBest() {
	try {
		return Number(localStorage.getItem(BEST_KEY)) || 0;
	} catch {
		return 0;
	}
}

function App() {
	const [game, dispatch] = useReducer(reducer, undefined, () =>
		newGame(0, readBest()),
	);
	const { board, piece, status, level, best } = game;

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const type = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
			if (!type) return;
			e.preventDefault();
			// Holding Space or Enter must not slam every following piece
			if (e.repeat && (type === "hard" || type === "start" || type === "pause")) return;
			dispatch({ type, rand: Math.random() });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	useEffect(() => {
		if (status !== "playing") return;
		const id = setInterval(
			() => dispatch({ type: "tick", rand: Math.random() }),
			tickMs(level),
		);
		return () => clearInterval(id);
	}, [status, level]);

	useEffect(() => {
		try {
			localStorage.setItem(BEST_KEY, String(best));
		} catch {
			// best score just won't persist
		}
	}, [best]);

	// Board cells, with the ghost (negative values) and the falling piece drawn on top
	const cells = board.map((row) => [...row]);
	if (status !== "ready") {
		const ghostY = dropY(board, piece);
		piece.shape.forEach((row, r) =>
			row.forEach((cell, c) => {
				if (!cell) return;
				if (ghostY + r >= 0) cells[ghostY + r][piece.x + c] = -cell;
			}),
		);
		piece.shape.forEach((row, r) =>
			row.forEach((cell, c) => {
				if (cell && piece.y + r >= 0) cells[piece.y + r][piece.x + c] = cell;
			}),
		);
	}

	const overlay = status === "playing" ? null : OVERLAY[status];
	const next = SHAPES[game.next].filter((row) => row.some(Boolean));

	return (
		<main className="game">
			<div className="board-wrap">
				<div className="board" role="img" aria-label="Tetris board">
					{cells.flatMap((row, r) =>
						row.map((cell, c) => (
							<div
								key={`${r}-${c}`}
								className={cell < 0 ? "cell ghost" : cell ? "cell filled" : "cell"}
								style={{ "--color": COLORS[Math.abs(cell)] } as React.CSSProperties}
							/>
						)),
					)}
				</div>
				{overlay && (
					<div className="overlay">
						<h1>{overlay[0]}</h1>
						{status === "over" && <p>Score {game.score}</p>}
						<p>{overlay[1]}</p>
					</div>
				)}
			</div>

			<aside className="side">
				<dl className="stats" aria-live="polite">
					<dt>Score</dt>
					<dd>{game.score}</dd>
					<dt>Best</dt>
					<dd>{best}</dd>
					<dt>Lines</dt>
					<dd>{game.lines}</dd>
					<dt>Level</dt>
					<dd>{level}</dd>
				</dl>

				<div className="panel">
					<h2>Next</h2>
					<div
						className="next"
						style={{ gridTemplateColumns: `repeat(${next[0].length}, var(--cell))` }}
					>
						{status !== "ready" &&
							next.flatMap((row, r) =>
								row.map((cell, c) => (
									<div
										key={`${r}-${c}`}
										className={cell ? "cell filled" : "cell empty"}
										style={{ "--color": COLORS[cell] } as React.CSSProperties}
									/>
								)),
							)}
					</div>
				</div>

				<div className="panel">
					<h2>Controls</h2>
					<ul className="controls">
						<li><kbd>←</kbd> <kbd>→</kbd> Move</li>
						<li><kbd>↑</kbd> / <kbd>X</kbd> Rotate</li>
						<li><kbd>Z</kbd> Rotate back</li>
						<li><kbd>↓</kbd> Soft drop</li>
						<li><kbd>Space</kbd> Hard drop</li>
						<li><kbd>P</kbd> Pause</li>
						<li><kbd>Enter</kbd> Start</li>
					</ul>
				</div>
			</aside>
		</main>
	);
}

export default App;
