import { Hono } from "hono";
import neverForgotten from "../../Never-Forgotten/worker/api";
import { memorialPage } from "../../Never-Forgotten/worker/page";
import { PorchlightStore } from "../../porchlight/worker/store";
import { runScheduler } from "./ripple/engine";
import ripple from "./ripple/routes";

export { PorchlightStore };

const RIPPLE_CRON = "0 14 * * *";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/", (c) => c.json({ name: "Cloudflare" }));
app.route("/api/ripple", ripple);
app.route("/api/never-forgotten", neverForgotten);
// A memorial's permanent link is answered here first (see run_worker_first in wrangler.json)
// so the page arrives with that person's name, words and photo in it.
app.get("/never-forgotten/remember/:id", (c) => memorialPage(c.req.raw, c.env, c.req.param("id")));

// Porchlight keeps all of its state in a single Durable Object.
const porchlight = (env: Env) => env.PORCHLIGHT.get(env.PORCHLIGHT.idFromName("global"));

app.all("/api/porchlight/*", (c) => porchlight(c.env).fetch(c.req.raw));

export default {
	fetch: app.fetch,
	// Crons (see wrangler.json): the daily one runs Ripple's scheduled opportunities
	// and date reminders; the hourly one sends Porchlight's hard-date coaching, the
	// week-6 nudge, and the other cliff-aware texts once each circle's local morning arrives.
	scheduled(controller, env, ctx) {
		if (controller.cron === RIPPLE_CRON) ctx.waitUntil(runScheduler(env));
		else ctx.waitUntil(porchlight(env).tick());
	},
} satisfies ExportedHandler<Env>;
