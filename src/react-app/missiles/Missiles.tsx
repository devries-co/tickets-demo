import { useEffect, useRef } from "react";
import { Game, H, W } from "./game";
import "./Missiles.css";

const FIRE_KEYS: Record<string, number> = { "1": 0, a: 0, "2": 1, s: 1, "3": 2, d: 2 };
const AIM_KEYS: Record<string, "left" | "right" | "up" | "down"> = {
	ArrowLeft: "left",
	ArrowRight: "right",
	ArrowUp: "up",
	ArrowDown: "down",
};

function Missiles() {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;

		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		canvas.width = W * dpr;
		canvas.height = H * dpr;

		const game = new Game();
		let last = performance.now();
		let raf = requestAnimationFrame(function frame(now) {
			// Clamp so a background tab doesn't resume with one enormous step
			game.update(Math.min(0.05, (now - last) / 1000));
			last = now;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			game.draw(ctx);
			raf = requestAnimationFrame(frame);
		});

		const aimAt = (e: PointerEvent) => {
			const rect = canvas.getBoundingClientRect();
			game.aim.x = ((e.clientX - rect.left) / rect.width) * W;
			game.aim.y = ((e.clientY - rect.top) / rect.height) * H;
		};
		const onDown = (e: PointerEvent) => {
			e.preventDefault();
			game.sfx.unlock();
			aimAt(e);
			game.press();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
			if (key in AIM_KEYS) {
				game.keys[AIM_KEYS[key]] = true;
				e.preventDefault();
				return;
			}
			if (e.repeat) return;
			game.sfx.unlock();
			if (key in FIRE_KEYS) game.press(FIRE_KEYS[key]);
			else if (key === " ") game.press();
			else if (key === "Enter") game.confirm();
			else if (key === "p" || key === "Escape") game.togglePause();
			else if (key === "m") game.sfx.muted = !game.sfx.muted;
			else return;
			e.preventDefault();
		};
		const onKeyUp = (e: KeyboardEvent) => {
			if (e.key in AIM_KEYS) game.keys[AIM_KEYS[e.key]] = false;
		};

		canvas.addEventListener("pointermove", aimAt);
		canvas.addEventListener("pointerdown", onDown);
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		return () => {
			cancelAnimationFrame(raf);
			canvas.removeEventListener("pointermove", aimAt);
			canvas.removeEventListener("pointerdown", onDown);
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
			game.sfx.close();
		};
	}, []);

	return (
		<main className="missiles">
			<canvas ref={canvasRef} aria-label="Missile Command game" />
			<p className="missiles-help">
				<kbd>Mouse</kbd> / <kbd>Arrows</kbd> aim · <kbd>Click</kbd> / <kbd>Space</kbd> fire nearest ·{" "}
				<kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> fire left, centre, right · <kbd>P</kbd> pause ·{" "}
				<kbd>M</kbd> mute
			</p>
		</main>
	);
}

export default Missiles;
