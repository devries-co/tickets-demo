import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import Missiles from "./missiles/Missiles.tsx";

// Two pages, so plain path matching is enough; no router needed.
const isMissiles = window.location.pathname.replace(/\/+$/, "") === "/missiles";
if (isMissiles) document.title = "Missile Command";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<nav className="site-nav">
			<a href="/" aria-current={isMissiles ? undefined : "page"}>
				Tetris
			</a>
			<a href="/missiles" aria-current={isMissiles ? "page" : undefined}>
				Missile Command
			</a>
		</nav>
		{isMissiles ? <Missiles /> : <App />}
	</StrictMode>,
);
