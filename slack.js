// Morning digest to Slack after the daily pre-warm run.
//
// Uses an Incoming Webhook rather than a bot token on purpose: a webhook is
// bound to exactly one channel, so a misconfiguration cannot post prospect
// names into an unrelated channel. This workspace is shared with other
// companies, which makes that blast radius worth constraining.
//
// Sends nothing unless SLACK_WEBHOOK_URL is set.
//
// The message is a pre-call brief, not a pipeline status report. Everything
// substantive in it is read out of the deck JSON that was already generated on
// the Mac via the Claude subscription. Building this message calls no model and
// needs no API key.

const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://discovery.hirecharm.com';

function timeLabel(iso, tz) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return String(iso);
  }
}

function dateLabel(ymd, tz) {
  try {
    // Parse as local noon so the weekday cannot slip across a timezone edge.
    return new Date(`${ymd}T12:00:00`).toLocaleDateString('en-US', {
      timeZone: tz,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return ymd;
  }
}

// "Acme Corp & Charm" is how the booking calendar names every meeting, so the
// suffix carries no information and costs a line of width.
function personName(item) {
  return (
    (item.title || '')
      .replace(/\s*&\s*Charm\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim() ||
    item.who ||
    item.domain ||
    'unknown'
  );
}

function trim(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '...' : s;
}

// Turn a pre-warm report into the exact text that would be posted.
//
// One chronological list of today's calls, because that is the order the day
// actually happens in. Each call carries its own state rather than being sorted
// into Ready / Building / No deck buckets, which made a three-call day read as
// three unrelated lists.
export function buildDigest(report, tz = 'America/Los_Angeles') {
  const calls = [
    ...(report.generated || []).map((c) => ({ ...c, state: 'ready' })),
    ...(report.reused || []).map((c) => ({ ...c, state: 'ready' })),
    ...(report.queued || []).map((c) => ({ ...c, state: 'building' })),
    ...(report.skipped || []).map((c) => ({ ...c, state: 'skipped' })),
    ...(report.failed || []).filter((f) => f.when || f.domain).map((c) => ({ ...c, state: 'failed' })),
  ].sort((a, b) => String(a.when).localeCompare(String(b.when)));

  // A run-level failure has no meeting attached to it. It has to be said before
  // any count, because a calendar that did not answer means "0 calls" is not a
  // fact about the day, it is the absence of one.
  const runLevel = (report.failed || []).filter((f) => !f.when && !f.domain);

  const lines = [];
  lines.push(`*Today's calls* · ${dateLabel(report.date, tz)}`);

  if (runLevel.length) {
    lines.push('');
    for (const f of runLevel) lines.push(`:warning: ${humanError(f.error)}`);
    if (!calls.length) return lines.join('\n');
  }

  if (!calls.length) {
    lines.push('');
    lines.push('_Nothing booked today._');
    return lines.join('\n');
  }

  const ready = calls.filter((c) => c.state === 'ready').length;
  const n = calls.length;
  lines.push(
    `${n} call${n === 1 ? '' : 's'} · ${ready} deck${ready === 1 ? '' : 's'} ready`
  );

  for (const c of calls) {
    lines.push('');
    const head = `*${timeLabel(c.when, tz)}  ${personName(c)}*${c.domain ? ` · ${c.domain}` : ''}`;
    lines.push(head);

    if (c.state === 'ready' && c.brief) {
      renderBrief(lines, c);
    } else if (c.state === 'ready') {
      // A deck exists but its JSON could not be summarised. Still give the link.
      lines.push(`<${BASE_URL}/d/${c.slug}|open deck>`);
    } else if (c.state === 'building') {
      lines.push('_No deck yet. Queued, and the Mac builds it in about ten minutes._');
    } else if (c.state === 'skipped') {
      lines.push(`_${humanReason(c.reason, c)}_`);
    } else {
      lines.push(`_${humanError(c.error)}_`);
    }
  }

  return lines.join('\n');
}

// The substance of the message. Everything here was written during generation
// and is only being read back out of storage.
function renderBrief(lines, c) {
  const b = c.brief || {};

  if (b.oneLiner) lines.push(trim(b.oneLiner, 160));
  if (b.gap) lines.push(`*The read:* ${trim(b.gap, 220)}`);
  if (b.question) lines.push(`*Ask:* ${trim(b.question, 220)}`);

  const bits = [];
  if (b.signals) {
    bits.push(
      b.wincing
        ? `${b.signals} signals, ${b.wincing} of them wincing`
        : `${b.signals} signals`
    );
  }
  if (b.sources) bits.push(`${b.sources} sources`);
  bits.push(`<${BASE_URL}/d/${c.slug}|open deck>`);
  if (b.hasBrief) bits.push(`<${BASE_URL}/d/${c.slug}/brief|research>`);
  lines.push(bits.join(' · '));
}

// Pull the handful of fields worth reading at 8am out of a stored deck. Kept
// here so the shape of the message and the shape of its inputs live together.
export function summarizeDeck(row) {
  const d = row?.data;
  if (!d) return null;
  const signals = Array.isArray(d.signals) ? d.signals : [];
  return {
    company: d.company?.name || row.company || row.domain,
    oneLiner: d.company?.one_liner || '',
    gap: d.read?.gap || '',
    question: d.read?.question || '',
    signals: signals.length,
    wincing: signals.filter((s) => s?.loudness === 'wincing').length,
    sources: Array.isArray(d.sources) ? d.sources.length : 0,
    hasBrief: Boolean(d._brief),
  };
}

// The server holds no Anthropic API key and never calls the model: generation
// happens on the Mac against the Claude subscription. So the only failures that
// can reach this digest are the calendar and the database. Anything mentioning
// API keys, credits or rate limits was left over from the old architecture and
// was reported every morning for a failure that could not be acted on.
function humanError(err) {
  const raw = String(err || 'unknown error');
  if (/ghl|leadconnector|calendar|appointment/i.test(raw)) {
    return 'could not read the booking calendar, so today may be incomplete';
  }
  if (/econnrefused|etimedout|database|postgres|pool/i.test(raw)) {
    return 'could not reach the database, so no deck was requested';
  }
  const m = raw.match(/"message"\s*:\s*"([^"]+)"/);
  return 'could not be queued: ' + trim(m ? m[1] : raw, 140);
}

function humanReason(reason, p) {
  const r = String(reason || '');
  if (r.startsWith('free email provider')) {
    return `Booked from a personal address (${p.who || 'no company email'}), so there is no company site to research. Add a mapping to PREWARM_EMAIL_DOMAINS if you want a deck.`;
  }
  if (r === 'on the skip list') return 'Domain is on the skip list, no deck built.';
  if (r === 'domain does not respond') {
    return `${p.domain || 'That domain'} did not respond, so it was not researched.`;
  }
  if (r.startsWith('no website field')) {
    return 'No website on the contact and no company email to work from.';
  }
  return r;
}

export function slackConfigured() {
  return Boolean(process.env.SLACK_WEBHOOK_URL);
}

export async function sendDigest(report, tz = 'America/Los_Angeles') {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.log('slack: SLACK_WEBHOOK_URL not set, digest not sent');
    return { sent: false, reason: 'not configured' };
  }
  const text = buildDigest(report, tz);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mrkdwn: true }),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      console.error(`slack: digest failed ${res.status}: ${body.slice(0, 200)}`);
      return { sent: false, status: res.status, body: body.slice(0, 200) };
    }
    console.log('slack: digest sent');
    return { sent: true };
  } catch (err) {
    console.error('slack: digest failed:', err.message);
    return { sent: false, error: err.message };
  }
}
