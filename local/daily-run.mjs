// Daily pre-warm driven by the Claude subscription on this Mac.
//
// Reads today's GHL meetings, works out who still needs a deck, generates each
// one by driving Claude Code headlessly, and pushes the result to the server
// through the import endpoint. Then asks the server to post the Slack digest,
// which by then reports everything as ready.
//
//   node local/daily-run.mjs            generate and import
//   node local/daily-run.mjs --dry-run  show what it would do, generate nothing
//   node local/daily-run.mjs --no-slack skip the digest
//
// Credentials come from the macOS Keychain, so nothing sensitive lives on disk.

import { execFileSync } from 'child_process';
import { generateDeck } from './generate-deck.mjs';

const BASE = process.env.DISCOVERY_BASE || 'https://discovery.hirecharm.com';
const TZ = 'America/Los_Angeles';
const DRY = process.argv.includes('--dry-run');
const NO_SLACK = process.argv.includes('--no-slack');

// Scheduled mode. The job runs every 30 minutes so it can catch up whenever the
// Mac happens to be on, so it has to be cheap and quiet when there is nothing
// to do, and it must not re-announce a digest the server already sent.
const CATCH_UP = process.argv.includes('--catch-up');

// Outside these hours a scheduled run exits immediately. No point researching
// at 2am, and a deck generated after the last call of the day is wasted.
const ACTIVE_FROM = Number(process.env.PREWARM_ACTIVE_FROM ?? 5);
const ACTIVE_UNTIL = Number(process.env.PREWARM_ACTIVE_UNTIL ?? 18);

function hourIn(tz) {
  return Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false, hour: '2-digit' })
      .formatToParts(new Date())
      .find((p) => p.type === 'hour').value
  ) % 24;
}

const keychain = (service, account) => {
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
};

process.env.GHL_TOKEN ||= keychain('charm-discovery', 'ghl-token');
process.env.GHL_LOCATION_ID ||= keychain('charm-discovery', 'ghl-location');
const APP_PASSWORD = process.env.APP_PASSWORD || keychain('charm-discovery', 'app-password');

const log = (...a) => console.log(new Date().toISOString(), ...a);

// The server owns domain resolution, duplicate collapsing and the skip list, so
// ask it what today looks like rather than reimplementing any of that here.
async function serverSession() {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: APP_PASSWORD }),
    redirect: 'manual',
  });
  const cookie = (res.headers.getSetCookie?.() || [])
    .map((c) => c.split(';')[0])
    .join('; ');
  if (!cookie) throw new Error('could not sign in to the server, check APP_PASSWORD');
  return cookie;
}

// Claim and run queued jobs one at a time until the queue is empty. Each job
// reports progress back so the browser tab that asked for it sees movement.
async function drainJobs(cookie) {
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${BASE}/api/jobs/claim`, { method: 'POST', headers: { cookie } });
    if (!res.ok) { log(`  could not claim a job: ${res.status}`); return; }
    const { job } = await res.json();
    if (!job) return;

    const patch = (body) =>
      fetch(`${BASE}/api/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(body),
      }).catch(() => {});

    const started = Date.now();
    log(`  job ${job.id}: generating ${job.domain}`);
    try {
      await patch({ note: `Researching ${job.domain} on the Mac. This takes a few minutes.` });
      const { deck, cost, turns } = await generateDeck(job.domain);

      const company = deck.company?.name || job.domain;
      const slug = (company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)) ||
        job.domain.replace(/\./g, '-');

      const imp = await fetch(`${BASE}/api/decks/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ slug, domain: job.domain, company, data: deck }),
      });
      const body = await imp.json().catch(() => ({}));
      if (!imp.ok || !body.ok) throw new Error(`import failed: ${imp.status}`);

      await patch({ status: 'done', slug, note: `Ready: ${company}` });
      log(`  job ${job.id}: done in ${Math.round((Date.now() - started) / 1000)}s, ${turns} turns -> ${BASE}${body.url}`);
    } catch (err) {
      await patch({ status: 'failed', error: err.message, note: `Failed: ${err.message}` });
      log(`  job ${job.id}: FAILED ${err.message}`);
    }
  }
}

// The queue is drained every couple of minutes so a request from the browser
// is picked up quickly. The GHL calendar check is far less urgent and is rate
// limited to this interval so we are not hitting their API 30 times an hour.
const GHL_CHECK_EVERY_MIN = Number(process.env.PREWARM_GHL_CHECK_MIN ?? 20);
const STAMP = new URL('./.last-ghl-check', import.meta.url).pathname;

async function ghlCheckDue() {
  try {
    const { mtimeMs } = await (await import('fs/promises')).stat(STAMP);
    return Date.now() - mtimeMs > GHL_CHECK_EVERY_MIN * 60000;
  } catch {
    return true; // never run before
  }
}
async function markGhlChecked() {
  const fs = await import('fs/promises');
  await fs.writeFile(STAMP, new Date().toISOString());
}

async function main() {
  const hour = hourIn(TZ);
  if (CATCH_UP && (hour < ACTIVE_FROM || hour >= ACTIVE_UNTIL)) {
    // Quiet exit: this runs often and should say nothing overnight.
    return;
  }
  if (!process.env.GHL_TOKEN || !process.env.GHL_LOCATION_ID) {
    throw new Error('GHL credentials not found in Keychain (charm-discovery / ghl-token, ghl-location)');
  }
  const cookie = await serverSession();

  // Always drain the queue: this is the cheap, time-sensitive half.
  if (!DRY) await drainJobs(cookie);

  // The calendar half runs on its own slower clock.
  if (CATCH_UP && !(await ghlCheckDue())) return;
  if (CATCH_UP) await markGhlChecked();

  const dryRes = await fetch(`${BASE}/api/prewarm/dry`, { headers: { cookie } });
  if (!dryRes.ok) throw new Error(`server dry run failed: ${dryRes.status}`);
  const plan = await dryRes.json();

  // A dry run reports what it would ask for as "queued", since queueing is all a
  // real run can do. Older servers put these under "generated", so accept both.
  const needed = (plan.queued?.length ? plan.queued : plan.generated) || [];

  // Scheduled runs happen every 30 minutes, so they only narrate when there is
  // actually work to do. Otherwise the log is unreadable within a day.
  if (!CATCH_UP || needed.length) {
    log(`${plan.date}: ${plan.meetings} meeting(s)` +
        (plan.duplicatesCollapsed ? `, ${plan.duplicatesCollapsed} duplicate(s) collapsed` : ''));
    for (const r of plan.reused || []) log(`  already have ${r.domain} -> /d/${r.slug}`);
    for (const s of plan.skipped || []) log(`  skipping ${s.domain || s.who}: ${s.reason}`);
  }

  if (!needed.length) {
    // In catch-up mode this is the overwhelmingly common case, so stay quiet
    // and stop here: there is nothing new to announce.
    if (CATCH_UP) return;
    log('nothing to generate');
  } else {
    log(`generating ${needed.length} deck(s) via the Claude subscription`);
  }

  let totalCost = 0;
  for (const item of needed) {
    const domain = item.domain;
    if (DRY) { log(`  [dry run] would generate ${domain}`); continue; }
    const started = Date.now();
    try {
      log(`  ${domain}: researching and writing...`);
      const { deck, cost, turns } = await generateDeck(domain);
      totalCost += cost || 0;

      const company = deck.company?.name || domain;
      const slug = (company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)) ||
        domain.replace(/\./g, '-');

      const imp = await fetch(`${BASE}/api/decks/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ slug, domain, company, data: deck }),
      });
      const body = await imp.json().catch(() => ({}));
      if (!imp.ok || !body.ok) throw new Error(`import failed: ${imp.status} ${JSON.stringify(body)}`);

      log(`  ${domain}: done in ${Math.round((Date.now() - started) / 1000)}s, ${turns} turns -> ${BASE}${body.url}`);
    } catch (err) {
      log(`  ${domain}: FAILED ${err.message}`);
    }
  }

  if (totalCost) log(`subscription usage reported for this run: $${totalCost.toFixed(4)} equivalent`);

  if (NO_SLACK || DRY) {
    log('skipping the Slack digest');
    return;
  }
  // Scheduled mode: before the server's 08:00 digest there is nothing to say,
  // it will report everything as ready on its own. Only speak up when decks
  // landed AFTER that digest already went out saying they were missing.
  if (CATCH_UP && hour < 8) {
    log('generated before the 08:00 digest, letting the server announce it');
    return;
  }
  // Everything generated above is now stored, so the server's own run finds it
  // all as fresh and reuses it. No API key is touched.
  const run = await fetch(`${BASE}/api/prewarm/run?notify=1`, { method: 'POST', headers: { cookie } });
  log(`digest triggered: ${run.status} ${JSON.stringify(await run.json().catch(() => ({})))}`);
}

main().catch((e) => { log('RUN FAILED:', e.message); process.exit(1); });
