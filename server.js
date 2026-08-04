import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  initStore, saveDeck, getDeck, listDecks, deleteDeck,
  createJob, getJob, listJobs, claimJob, updateJob, requeueStale,
} from './store.js';
import { renderDeck } from './deck.js';
import { runPrewarm, startScheduler, prewarmState } from './prewarm.js';
import { checkGhl, todaysAppointments } from './ghl.js';
import { buildDigest, slackConfigured } from './slack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ---------------------------------------------------------------- auth
// The generator console is gated. Generated deck links are unlisted but open,
// so Chris can send one to a prospect without handing over a password.

const PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || 'cdg-session-' + PASSWORD;
const COOKIE = 'cdg_session';
const MAXAGE = 30 * 24 * 3600;

if (!PASSWORD) console.warn('APP_PASSWORD is not set. The generator console is OPEN.');

const sign = (ts) => crypto.createHmac('sha256', SECRET).update(String(ts)).digest('hex');
const makeToken = () => Date.now() + '.' + sign(Date.now());

function tokenValid(tok) {
  if (!tok) return false;
  const i = tok.indexOf('.');
  if (i < 0) return false;
  const ts = tok.slice(0, i);
  const sig = tok.slice(i + 1);
  if (!/^\d+$/.test(ts) || Date.now() - Number(ts) > MAXAGE * 1000) return false;
  const good = sign(ts);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

function pwMatch(input) {
  if (!PASSWORD) return false;
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function getCookie(req, name) {
  const h = req.headers.cookie;
  if (!h) return null;
  for (const part of h.split(';')) {
    const eq = part.indexOf('=');
    if (eq > -1 && part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function requireAuth(req, res, next) {
  if (!PASSWORD) return next();
  if (tokenValid(getCookie(req, COOKIE))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in.' });
  return res.redirect('/login');
}

app.get('/login', (req, res) => {
  res.type('html').send(loginPage(req.query.e === '1'));
});

app.post('/login', (req, res) => {
  if (!pwMatch(req.body.password)) return res.redirect('/login?e=1');
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAXAGE}` +
      (secure ? '; Secure' : '')
  );
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.redirect('/login');
});

// ---------------------------------------------------------------- helpers

function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return null;
  return d;
}

function slugify(company, domain) {
  const base = (company || domain)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return base || domain.replace(/\./g, '-');
}

const dateLabel = () =>
  new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

// ---------------------------------------------------------------- api

app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/decks', requireAuth, async (req, res) => {
  res.json({ decks: await listDecks() });
});

// Import or replace a deck from hand-written JSON. Lets a deck be built or
// corrected without a generation run, which also covers the case where the
// research pass is unavailable.
app.post('/api/decks/import', requireAuth, async (req, res) => {
  const { slug, domain, company, data } = req.body || {};
  if (!slug || !domain || !data) {
    return res.status(400).json({ error: 'slug, domain and data are required.' });
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return res.status(400).json({ error: 'slug must be lowercase letters, digits and hyphens.' });
  }
  try {
    await saveDeck({ slug, domain, company: company || data.company?.name || domain, data });
    res.json({ ok: true, url: `/d/${slug}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/decks/:slug', requireAuth, async (req, res) => {
  await deleteDeck(req.params.slug);
  res.json({ ok: true });
});

// Queues a generation request and streams its status until it resolves.
//
// The server deliberately holds no Anthropic API key and never generates
// anything itself. The Mac running Claude Code on the subscription claims the
// job and does the work, so opening this in a browser can never spend API
// credits. If no worker is running the job simply waits.
app.get('/api/generate', requireAuth, async (req, res) => {
  const domain = normalizeDomain(req.query.domain);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  if (!domain) {
    send('error', { message: 'That does not look like a domain. Try acme.com.' });
    return res.end();
  }

  // Already have it? Hand it straight back rather than queueing a rebuild.
  const existingSlug = (await listDecks(500)).find((d) => d.domain === domain);
  if (existingSlug && req.query.force !== '1') {
    send('progress', { message: `Already have a deck for ${domain}.` });
    send('done', { slug: existingSlug.slug, company: existingSlug.company, url: `/d/${existingSlug.slug}` });
    return res.end();
  }

  let job;
  try {
    const created = await createJob(domain);
    job = created.job;
    send('progress', {
      message: created.reused
        ? `Already queued for ${domain}, watching that one.`
        : `Queued ${domain}. The Mac picks this up on its next check.`,
    });
  } catch (err) {
    send('error', { message: err.message });
    return res.end();
  }

  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  let lastNote = null;
  let closed = false;
  req.on('close', () => { closed = true; });

  // Poll the job and report each change. The browser tab can be closed at any
  // point without affecting the work: the job lives in the database.
  const poll = setInterval(async () => {
    if (closed) { clearInterval(poll); clearInterval(heartbeat); return; }
    try {
      const j = await getJob(job.id);
      if (!j) return;
      if (j.note && j.note !== lastNote) {
        lastNote = j.note;
        send('progress', { message: j.note });
      }
      if (j.status === 'done') {
        clearInterval(poll); clearInterval(heartbeat);
        send('done', { slug: j.slug, company: j.domain, url: `/d/${j.slug}` });
        res.end();
      } else if (j.status === 'failed') {
        clearInterval(poll); clearInterval(heartbeat);
        send('error', { message: j.error || 'Generation failed on the worker.' });
        res.end();
      }
    } catch { /* transient, try again on the next tick */ }
  }, 3000);
});

// ---------------------------------------------------------------- worker api
// Used by local/daily-run.mjs on the Mac. Password gated like everything else.

app.post('/api/jobs/claim', requireAuth, async (req, res) => {
  await requeueStale();
  const job = await claimJob();
  res.json({ job: job || null });
});

app.patch('/api/jobs/:id', requireAuth, async (req, res) => {
  const { status, note, slug, error } = req.body || {};
  const job = await updateJob(req.params.id, { status, note, slug, error });
  if (!job) return res.status(404).json({ error: 'No such job.' });
  res.json({ job });
});

app.get('/api/jobs', requireAuth, async (req, res) => {
  res.json({ jobs: await listJobs() });
});

// ---------------------------------------------------------------- decks

app.get('/d/:slug', async (req, res) => {
  const row = await getDeck(req.params.slug);
  if (!row) return res.status(404).type('html').send(notFoundPage());
  res.type('html').send(
    renderDeck({
      slug: row.slug,
      domain: row.domain,
      data: row.data,
      dateLabel: new Date(row.created_at).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      }),
    })
  );
});

// The raw research brief, for Chris to skim before the call.
app.get('/d/:slug/brief', requireAuth, async (req, res) => {
  const row = await getDeck(req.params.slug);
  if (!row) return res.status(404).send('Not found');
  res.type('text/plain').send(row.data?._brief || 'No brief stored for this deck.');
});

// ---------------------------------------------------------------- prewarm

// Connectivity check: proves the token works and shows the shape GHL actually
// returns for this account. Generates nothing.
app.get('/api/prewarm/check', requireAuth, async (req, res) => {
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await checkGhl();
    res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    res.status(500).type('text/plain').send(lines.join('\n') + '\n\nERROR: ' + err.message);
  } finally {
    console.log = log;
  }
});

// Dry run: what would today's job do? Reads GHL, resolves domains, generates
// nothing and spends nothing.
app.get('/api/prewarm/dry', requireAuth, async (req, res) => {
  try {
    res.json(await runPrewarm({ dryRun: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fire the real job now. Returns immediately; generation continues in the
// background and decks appear in the console as they land.
app.post('/api/prewarm/run', requireAuth, (req, res) => {
  if (prewarmState().running) return res.status(409).json({ error: 'Already running.' });
  // notify must be asked for explicitly; the default posts nothing.
  const notify = req.query.notify === '1' || req.body?.notify === true;
  runPrewarm({ notify }).catch((e) => console.error('prewarm:', e.message));
  res.json({
    started: true,
    notify,
    note: 'Generating in the background. Decks appear in the list as they finish.',
  });
});

// Renders exactly what would be posted to Slack, using today's real data.
// Sends nothing. This is the approval surface before enabling the digest.
app.get('/api/prewarm/preview', requireAuth, async (req, res) => {
  try {
    const report = await runPrewarm({ dryRun: true });
    res.type('text/plain').send(
      buildDigest(report, prewarmState().tz) +
        `\n\n--- not sent. slack ${slackConfigured() ? 'IS' : 'is NOT'} configured. ---`
    );
  } catch (err) {
    res.status(500).type('text/plain').send('ERROR: ' + err.message);
  }
});

app.get('/api/prewarm/state', requireAuth, (req, res) =>
  res.json({ ...prewarmState(), slackConfigured: slackConfigured() })
);

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------- pages

function loginPage(err) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Charm</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
<style>
body{font-family:Poppins,Arial,sans-serif;background:linear-gradient(140deg,#380c83,#120a24 70%,#000);
color:#fff;height:100vh;margin:0;display:flex;align-items:center;justify-content:center}
form{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);padding:44px;border-radius:18px;width:340px;text-align:center}
img{width:56px;margin-bottom:26px}
h1{font-size:19px;font-weight:600;margin:0 0 22px}
input{width:100%;padding:13px 15px;border-radius:9px;border:1px solid rgba(255,255,255,.18);
background:rgba(0,0,0,.25);color:#fff;font:inherit;font-size:15px;margin-bottom:14px}
button{width:100%;padding:13px;border:0;border-radius:9px;background:#6f49b2;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:#ffb4b4;font-size:13px;margin-bottom:12px}
</style></head><body>
<form method="post" action="/login">
<img src="https://go.hirecharm.com/assets/charm-logo.svg" alt="Charm" style="filter:invert(1)">
<h1>Discovery asset generator</h1>
${err ? '<div class="err">Wrong password.</div>' : ''}
<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
<button type="submit">Enter</button>
</form></body></html>`;
}

function notFoundPage() {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Not found</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap" rel="stylesheet">
<style>body{font-family:Poppins,Arial,sans-serif;background:#f3edfb;color:#17181b;height:100vh;margin:0;
display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
a{color:#6f49b2}</style></head><body>
<h1>No reading here.</h1><p>That link has expired or was never cast.</p>
<p><a href="https://hirecharm.com">hirecharm.com</a></p></body></html>`;
}

// ---------------------------------------------------------------- boot

const PORT = process.env.PORT || 3000;
await initStore();
startScheduler();
app.listen(PORT, () => console.log('charm-discovery-generator listening on ' + PORT));
