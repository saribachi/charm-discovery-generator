# Charm Discovery Asset Generator

Enter a prospect's domain, get a personalized top-of-funnel discovery deck.
Built for `discovery.hirecharm.com`.

Chris enters a domain before a call. Claude researches the company and its
market, then writes the personalized slots of the Charm discovery narrative.
The output is a hosted, keyboard-driven deck at `/d/<slug>` that Chris presents
from and can send afterwards.

## The narrative

The deck spine is fixed. Only the copy inside it is personalized.

1. Cover
2. What are we doing at top of funnel? Generate awareness. Educate.
3. How do we do that? Channels.
4. Charm runs outbound: email, LinkedIn, phone.
5. The turn: we are here to talk about driving awareness using email and LinkedIn.
6. Your world: who you are, who you sell to, your TAM.
7. Where the TAM splits.
8. What we do for you: 1) get the leads, 2) write the words, 3) **read the
   signals** (teased), 4) manage the infrastructure.
9. All at once: intertwined multi-touch sequences for every prospect in your TAM.
10. "But this is where it gets cool."
11. Pain is not always stated. The scream versus the wince.
12. Signals we would watch for this prospect.
13. The signal fires, the words change: real sample email and LinkedIn touches.
14. The read: what we noticed, the gap, the question.
15. Two calls. The read, then the remedy.

Presenter notes live on every slide. Press **N**.

## Deck controls

| Key | Action |
| --- | --- |
| `→` `space` | Next slide |
| `←` | Previous slide |
| `N` | Toggle presenter notes |
| `M` | Slide menu |
| `Home` / `End` | First / last slide |
| swipe | Next / previous on touch |

The URL carries the slide number (`/d/acme#7`), so you can send someone straight
to a slide.

## How generation works

**The server holds no Anthropic API key and cannot generate anything.** Opening
the console in a browser can never spend API credits. A request becomes a job in
a queue; the Mac running Claude Code on the Claude subscription claims it, does
the work, and imports the result. See `local/README.md`.

Historically this ran as two API passes on the server (`research.js`, removed in
Aug 2026). Git history has it if the API route is ever wanted again.

Generation is a single Claude Code pass, because Claude Code has WebSearch and
WebFetch built in. The prompt carries the Charm brand kit, lexicon and fixed
narrative from `brand.js`, forbids inventing customers, headcounts, funding or
metrics, and requires the model to work around anything it cannot verify.

Everything is scrubbed for em dashes on the way out, because the model will
occasionally sneak one in despite the instruction.

### The queue

| Step | Where |
| --- | --- |
| Browser asks for a domain, or the 08:00 run finds a meeting without a deck | Server: creates a job |
| Job is claimed and generated | Mac: Claude Code on the subscription |
| Finished deck is imported | Mac posts to `/api/decks/import` |
| Browser sees it appear | Server streams job status over SSE |

Closing the browser tab does not cancel anything: the job lives in the database.
If the Mac is off, jobs simply wait. A job stuck `running` for more than 40
minutes is automatically requeued, on the assumption the worker went away.

## Daily GHL pre-warm

Each morning the app reads that day's GoHighLevel appointments, resolves each
booker's website, and queues a deck for anyone who does not already
have a fresh one. Decks land silently in the console. Nothing is sent anywhere.

**Off by default.** With no `GHL_TOKEN` the scheduler never starts and the app
behaves exactly as before.

**Setup.** In GHL: Settings > Private Integrations > create a token scoped to
`calendars.readonly`, `calendars/events.readonly`, `contacts.readonly`. Then set
`GHL_TOKEN` and `GHL_LOCATION_ID` (the id in the GHL URL,
`/v2/location/<this>/dashboard`).

**Domain resolution**, in order: the contact's website field (GHL's native
`contact.website`, which is what the booking form's website field writes to),
then any custom field whose name looks like website / url / domain, then the
email domain, skipping free providers like gmail and outlook. Anything
unresolved is listed in the run report rather than guessed at, because inferring
a company from a personal email produces confidently wrong decks.

Contacts created before the booking form had a website field will not resolve if
they used a personal address. Map those explicitly with `PREWARM_EMAIL_DOMAINS`
(`someone@gmail.com=acme.com,other@gmail.com=foo.io`) rather than guessing.

A domain with a deck younger than `PREWARM_FRESH_DAYS` (default 14) is reused
rather than regenerated, since signals go stale and that is the premise of the
pitch.

**Endpoints** (all password gated):

| Route | Does |
| --- | --- |
| `GET /api/prewarm/check` | Proves the token works and prints what GHL returns. Generates nothing. |
| `GET /api/prewarm/dry` | Full run without generating: which meetings, which domains, what it would skip. Spends nothing. |
| `POST /api/prewarm/run` | Fires the real run now. Queues anything missing. |
| `GET /api/prewarm/state` | Whether a run is in flight and when it last ran. |
| `GET /api/jobs` | The generation queue and its status. |

**Timing.** Defaults to 08:00 `America/Los_Angeles` via `PREWARM_HOUR` /
`PREWARM_MINUTE` / `PREWARM_TZ`. The Mac checks the queue every two minutes, so
in practice decks are usually already built by then. A deck takes 4 to 13
minutes to generate.

DST is handled by reading the real UTC offset from `Intl`, so the day window is
23 hours on spring-forward and 25 on fall-back rather than a naive 24.

## Auth

- `/` (the generator console) and `/api/*` are gated by `APP_PASSWORD`.
- `/d/<slug>` is **open**. Deck links are unlisted, not authenticated, so Chris can
  send one to a prospect without handing over a password. Decks are `noindex`.
- `/d/<slug>/brief` is gated. The internal research notes stay internal.

## Local development

```sh
npm install
cp .env.example .env      # fill in APP_PASSWORD (no API key: see local/README.md)
export $(grep -v '^#' .env | xargs)
npm start                 # http://localhost:3000
```

Without `DATABASE_URL`, decks are stored in `./data/decks.json`. No database
needed to run locally.

## Deploying to Coolify

Matches the pattern used by `charm-content-pipeline` and `charm-disco-booked`.

1. Push this directory to a GitHub repo.
2. New application in Coolify, Dockerfile buildpack, port 3000.
3. Environment variables: `APP_PASSWORD`, `SESSION_SECRET`, `GHL_TOKEN`,
   `GHL_LOCATION_ID`, `SLACK_WEBHOOK_URL`. **Deliberately no `ANTHROPIC_API_KEY`**:
   the server must not be able to spend API credits.
4. Link a Postgres service so Coolify injects `DATABASE_URL`. Without it the
   file store works but decks are lost on redeploy, since there is no volume.
5. DNS: `discovery` A record on the `hirecharm.com` Cloudflare zone pointing at
   the Coolify host, DNS only (not proxied), mirroring how `go` was set up. The
   zone id and DNS token are in the Charm disco-booked notes.
6. If Let's Encrypt does not issue on the first try, redeploy once to force the
   ACME challenge after the record resolves. That was needed for `go`.

## Cost

Roughly $1 to $3 of usage per deck, measured on real runs. This is charged
against the Claude subscription rather than billed as API spend, because the
server has no API key.

## Files

| File | What it does |
| --- | --- |
| `server.js` | Routes, auth, job queue, SSE status stream |
| `deck.js` | Renders deck data into a self-contained HTML deck |
| `brand.js` | Brand tokens, voice rules, the fixed narrative |
| `store.js` | Postgres, or a JSON file when there is no `DATABASE_URL` |
| `public/index.html` | The generator console |

## Known gaps

- No editing. If a generated line is wrong, regenerate or edit the stored JSON.
  An edit view is the obvious next build.
- Phone is named as a channel but has no personalized content, by design. The
  deck is email and LinkedIn.
- No client logos, testimonials, or case-study numbers on the deck. Those are
  still blocked on real assets, same as the disco-booked deck.
