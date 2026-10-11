import { Hono } from "hono";
import { runScheduler } from "./ripple/engine";
import ripple from "./ripple/routes";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/", (c) => c.json({ name: "Cloudflare" }));
app.route("/api/ripple", ripple);

export default {
	fetch: app.fetch,
	// Daily cron (see wrangler.json): Ripple's scheduled opportunities and date reminders.
	scheduled(_controller, env, ctx) {
		ctx.waitUntil(runScheduler(env));
	},
} satisfies ExportedHandler<Env>;
