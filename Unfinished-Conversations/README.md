# Unfinished Conversations

"Some things still deserve to be said." A private place to keep talking to someone who has died: recorded messages,
letters and photographs, gathered into an archive, optionally carried forward into things to do, shared with family,
and made into a book. A MyGriefGuide project.

Served at `/unfinished-conversations`. Everything for it lives in this folder; the rest of the repo only mounts it
(`src/react-app/main.tsx`, `src/worker/index.ts`, `wrangler.json`).

## Routes

| Path | What |
| --- | --- |
| `/unfinished-conversations` | Landing and sign-in, then the private dashboard |
| `/unfinished-conversations/join/<token>` | Accept an invitation to an Our Stories collection |
| `/unfinished-conversations/listen/<token>` | Plays one recording: the page behind a Legacy Book QR code |

## Code

- `app/` — the React screens. `Recorder.tsx` is the voice recorder; `Compose.tsx` the letter and memory editors;
  `Archive.tsx`, `Forward.tsx`, `Stories.tsx`, `Book.tsx`, `Settings.tsx` are the sections; `exportArchive.ts` builds the export zip in the browser.
- `worker/api.ts` — the API (Hono on D1): accounts, loved ones, media, entries, activities, collections, books, listening links, export.
- `worker/ai.ts` — the remembrance assistant: categories, Carry It Forward suggestions, chapter suggestions, summaries.
- `worker/schema.ts` — the database. `shared.ts` — constants and types used by both sides.

## Privacy model

- Everything is private to the person who saved it. Every query for private data is scoped to the signed-in owner.
- The only things another person can ever read are stories in a shared collection they are an active member of
  (and the recordings and photographs attached to those stories), and a single recording behind a listening link its owner created.
- Sharing is always a deliberate act and always a copy: the private entry is never exposed or changed.
- AI assistance is off until the person turns it on, runs only when they save or ask, and every run is recorded in `ai_records`.
- Sessions are HttpOnly cookies; passwords are PBKDF2-hashed; media responses are private and tied to the session.

## The AI

With an `ANTHROPIC_API_KEY` Worker secret, suggestions come from Claude with structured JSON output, and every reply is
validated on the server (allowed categories only, length limits, and a filter that discards anything speaking for the
person who died). Without the key, or if a reply fails validation, the server falls back to simple keyword matching,
and the screens say so. Summaries need the key; there is no keyword substitute for those.

It never generates anything in the voice of the person who died, never changes a saved entry, and never runs in the background.

## Setup in Cloudflare

- The D1 database `unfinished-conversations` (binding `UC_DB`) is created on deploy. Tables are created on first request.
- Optional: the `ANTHROPIC_API_KEY` secret (shared with Ripple) turns on Claude-backed suggestions.

## Not built yet

- **Server-side transcription.** "Write down my words as I speak" uses the browser's own speech recognition where it exists
  (Chrome, Edge, Safari); a transcript can always be typed or edited by hand. There is no speech-to-text service on the server.
- **Media storage** is in D1, in half-megabyte chunks (recordings up to 24 MB / 15 minutes, photographs optimised in the browser).
  Move to R2 object storage before the collection grows large.
- **PDF export** uses the browser's print window ("Save as PDF") on a print-styled book, not a server-generated file.
- **Email.** Invitations are private links the owner passes on; nothing is emailed. Date reminders appear on the home page only, and only if switched on.
- Password reset, email verification and sign-in rate limiting.
- Printed-book ordering. The book is stored as its own records (`books`, `book_items`) so an order flow can be added later.
