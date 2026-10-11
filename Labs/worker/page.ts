const TITLE = "Grief Guide Labs";
const DESCRIPTION =
	"Four ideas we're exploring to help people who are grieving, and the people around them. None is finished. Tell us which would have helped.";

/** True for labs.mygriefguide.org (and labs.localhost in development). */
export const isLabsHost = (url: URL) => url.hostname.startsWith("labs.");

/**
 * Serves the app shell with the Labs title, description and icon already in the
 * HTML, so a link shared in a message previews as Grief Guide Labs and not as
 * whatever else this Worker hosts.
 */
export async function labsPage(request: Request, env: { ASSETS: Fetcher }) {
	const url = new URL(request.url);
	const shell = await env.ASSETS.fetch(new Request(new URL("/", url), { headers: request.headers }));
	const canonical = isLabsHost(url) ? `${url.origin}/` : `${url.origin}/labs`;
	const meta = [
		`<meta name="description" content="${DESCRIPTION}" />`,
		// Shared by invitation while these are concepts; remove this line to let search engines list the page.
		`<meta name="robots" content="noindex" />`,
		`<meta name="theme-color" content="#14736b" />`,
		`<meta property="og:type" content="website" />`,
		`<meta property="og:site_name" content="Grief Guide" />`,
		`<meta property="og:title" content="${TITLE}" />`,
		`<meta property="og:description" content="${DESCRIPTION}" />`,
		`<meta property="og:url" content="${canonical}" />`,
		`<meta name="twitter:card" content="summary" />`,
		`<link rel="canonical" href="${canonical}" />`,
	].join("");

	return new HTMLRewriter()
		.on("title", { element: (el) => void el.setInnerContent(TITLE) })
		.on('link[rel="icon"]', { element: (el) => void el.setAttribute("href", "/labs-icon.svg") })
		.on("head", { element: (el) => void el.append(meta, { html: true }) })
		.transform(shell);
}
