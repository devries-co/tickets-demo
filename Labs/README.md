# Grief Guide Labs

One page that presents the four concepts (Ripple, Porchlight, Never Forgotten, Unfinished Conversations) as ideas being
explored, and asks of each: "Would this have helped you?" A MyGriefGuide project.

Served as the front page of `labs.mygriefguide.org`, and at `/labs` on any other address. Everything for it lives in this
folder; the rest of the repo only mounts it (`src/react-app/main.tsx`, `src/worker/index.ts`, `wrangler.json`).

## Routes

| Path | What |
| --- | --- |
| `labs.mygriefguide.org/` or `/labs` | The concepts page |
| `POST /api/labs/responses` | Saves an answer, a note, or an email |
| `PUT /api/labs/responses/<id>` | Changes an answer or adds a note to it |
| `GET /api/labs/responses` | Everything people have said, behind a password |

The four apps are reachable on the same address (`labs.mygriefguide.org/ripple` and so on), which is where the page links.

## Code

- `app/Labs.tsx` — the page and its copy. The concepts are the `CONCEPTS` list at the top.
- `app/art.tsx` — the drawings. `app/labs.css` — the styles; colours are taken from the Grief Guide logo.
- `worker/api.ts` — the API (Hono on D1). `worker/page.ts` — puts the Labs title, description and icon in the HTML for link previews.
- `shared.ts` — the allowed concepts and answers, used by both sides.

## Setup in Cloudflare

- The custom domain `labs.mygriefguide.org` is declared in `wrangler.json`. The `mygriefguide.org` zone has to be in the same Cloudflare account as the Worker.
- The D1 database `labs` (binding `LABS_DB`) is created on deploy. The table is created on first request.
- **Set a Worker secret `LABS_ADMIN_PASSWORD`** to read responses at `/api/labs/responses`. The browser asks for a name and password; any name works.

```bash
npx wrangler secret put LABS_ADMIN_PASSWORD
```

For local development, put `LABS_ADMIN_PASSWORD=...` in `.dev.vars` (git-ignored).

## Not built yet

- The page is marked `noindex` while the concepts are shared by invitation. Remove that line in `worker/page.ts` to let search engines list it.
- No link-preview image.
- No rate limiting on the response form.
- The preview links for Ripple, Porchlight and Unfinished Conversations go to the working apps, which still accept real sign-ups. Only Never Forgotten opens in a sample-data mode.
