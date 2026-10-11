import { ensureSchema } from "./schema";

const esc = (value: string) =>
	value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/**
 * Serves the app shell for a memorial's permanent link with the person's name,
 * words and photo already in the HTML: link previews in messages and social
 * apps, search engines, and anyone without JavaScript get the memorial itself.
 * The app then starts as normal and replaces the static copy.
 */
export async function memorialPage(request: Request, env: { NF_DB: D1Database; ASSETS: Fetcher }, id: string) {
	const url = new URL(request.url);
	const shell = await env.ASSETS.fetch(new Request(new URL("/", url), { headers: request.headers }));
	await ensureSchema(env.NF_DB);
	const row = await env.NF_DB
		.prepare("SELECT name, text, has_photo FROM memorials WHERE id = ? AND status = 'published'")
		.bind(id)
		.first<{ name: string; text: string; has_photo: number }>();
	if (!row) return shell;

	const name = esc(row.name);
	const text = esc(row.text);
	const photo = `${url.origin}/api/never-forgotten/photo/${encodeURIComponent(id)}`;
	const meta = [
		`<meta name="description" content="${text}" />`,
		`<meta property="og:type" content="article" />`,
		`<meta property="og:site_name" content="Never Forgotten" />`,
		`<meta property="og:title" content="${name} · Never Forgotten" />`,
		`<meta property="og:description" content="${text}" />`,
		`<meta property="og:url" content="${esc(url.origin + url.pathname)}" />`,
		`<meta name="twitter:card" content="summary" />`,
		row.has_photo ? `<meta property="og:image" content="${esc(photo)}" />` : "",
		`<link rel="canonical" href="${esc(url.origin + url.pathname)}" />`,
	].join("");
	const article =
		`<article style="max-width:32rem;margin:15vh auto;padding:1.5rem;font-family:Georgia,serif;color:#e8edf5;text-align:center">` +
		(row.has_photo ? `<img src="${esc(photo)}" alt="${name}" width="160" height="160" style="border-radius:50%" />` : "") +
		`<h1>${name}</h1><p>${text}</p><p>Forever part of our world.</p></article>`;

	return new HTMLRewriter()
		.on("title", { element: (el) => void el.setInnerContent(`${row.name} · Never Forgotten`) })
		.on("head", { element: (el) => void el.append(meta, { html: true }) })
		.on("#root", { element: (el) => void el.append(article, { html: true }) })
		.transform(shell);
}
