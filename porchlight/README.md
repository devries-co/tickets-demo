# Porchlight

A griever sets one light (on / dim / off) and a short preference card; everyone in their circle sees it and gets gentle, cliff-aware texts.

## Routes

| Path | Who | What |
| --- | --- | --- |
| `/porchlight` | griever | Landing + setup (`?via=Funeral%20Home` pre-fills the sponsor) |
| `/porchlight/g/<token>` | griever | Private dashboard: Light, My card, Circle, Timeline, Work, Settings |
| `/porchlight/g/<token>/away` | griever | Just the discreet "Step away" button (save to home screen) |
| `/porchlight/c/<code>` | circle | See the light and card, join by SMS |
| `/porchlight/w/<code>` | work | Limited work card for manager and team |
| `/porchlight/print/<code>` | griever / funeral home | Printable sheet of QR cards |

## Code

- UI: `porchlight/app/`
- API, storage and scheduler: `porchlight/worker/` (one SQLite-backed Durable Object, `PorchlightStore`)
- Coaching copy and the calendar (hard-date eve, week 6, month 3, year one): `porchlight/worker/coaching.ts`. The texts are placeholders to replace with Lisa's library in Glimmer's voice.
- Shared types: `porchlight/shared.ts`

## How texts go out

- Light change: waits 2 minutes (Durable Object alarm) so a few taps send one text. "Text my circle" can be turned off for silent changes.
- Calendar: an hourly cron sends each circle's messages once its local time is between 9am and 8pm. Messages are deduplicated, and the circle gets at most one coaching text per day.
- Without Twilio credentials, everything runs in **demo mode**: texts are recorded in the griever's Circle tab but not sent.

## Turning on real SMS

```bash
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_FROM_NUMBER        # or TWILIO_MESSAGING_SERVICE_SID
```

Optional: `PUBLIC_BASE_URL` (links in texts), `SUPPORT_DIRECTORY_URL` (month-3 support group link; defaults to mygriefguide.com).

Point the Twilio number's incoming-message webhook at `POST /api/porchlight/sms/inbound` so STOP/START also update the circle.
