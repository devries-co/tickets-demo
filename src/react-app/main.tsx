import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import Missiles from "./missiles/Missiles.tsx";
import Ripple from "./ripple/Ripple.tsx";

// A handful of pages, so plain path matching is enough; no router needed.
const path = window.location.pathname.replace(/\/+$/, "");
const isMissiles = path === "/missiles";
const isRipple = path === "/ripple" || path.startsWith("/ripple/");
if (isMissiles) document.title = "Missile Command";
if (isRipple) document.title = "Ripple · MyGriefGuide";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{isRipple ? (
			<Ripple />
		) : (
			<>
				<nav className="site-nav">
					<a href="/" aria-current={isMissiles ? undefined : "page"}>
						Tetris
					</a>
					<a href="/missiles" aria-current={isMissiles ? "page" : undefined}>
						Missile Command
					</a>
					<a href="/ripple">Ripple</a>
				</nav>
				{isMissiles ? <Missiles /> : <App />}
			</>
		)}
	</StrictMode>,
);
