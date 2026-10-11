import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import Missiles from "./missiles/Missiles.tsx";
import Porchlight from "../../porchlight/app/Porchlight.tsx";
import Ripple from "./ripple/Ripple.tsx";

// Loaded only when visited: it brings a 3D engine the other pages don't need.
const NeverForgotten = lazy(() => import("../../Never-Forgotten/app/NeverForgotten.tsx"));
const UnfinishedConversations = lazy(() => import("../../Unfinished-Conversations/app/UnfinishedConversations.tsx"));

// A handful of pages, so plain path matching is enough; no router needed.
const path = window.location.pathname.replace(/\/+$/, "");
const isMissiles = path === "/missiles";
const isPorchlight = path === "/porchlight" || path.startsWith("/porchlight/");
const isNeverForgotten = path === "/never-forgotten" || path.startsWith("/never-forgotten/");
const isUnfinished = path === "/unfinished-conversations" || path.startsWith("/unfinished-conversations/");
const isRipple = path === "/ripple" || path.startsWith("/ripple/");
if (isMissiles) document.title = "Missile Command";
if (isRipple) document.title = "Ripple · MyGriefGuide";
if (isNeverForgotten) document.title = "Never Forgotten";
if (isUnfinished) document.title = "Unfinished Conversations";
if (isPorchlight) {
	document.title = "Porchlight";
	document.body.classList.add("porchlight");
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{isNeverForgotten ? (
			<Suspense fallback={null}>
				<NeverForgotten />
			</Suspense>
		) : isUnfinished ? (
			<Suspense fallback={null}>
				<UnfinishedConversations />
			</Suspense>
		) : isPorchlight ? (
			<Porchlight path={path} />
		) : isRipple ? (
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
