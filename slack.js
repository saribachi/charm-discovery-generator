// Morning digest to Slack after the daily pre-warm run.
//
// Uses an Incoming Webhook rather than a bot token on purpose: a webhook is
// bound to exactly one channel, so a misconfiguration cannot post prospect
// names into an unrelated channel. This workspace is shared with other
// companies, which makes that blast radius worth constraining.
//
// Sends nothing unless SLACK_WEBHOOK_URL is set.

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

// Turn a pre-warm report into the exact text that would be posted.
export function buildDigest(report, tz = 'America/Los_Angeles') {
  const ready = [...(report.generated || []), ...(report.reused || [])].sort((a, b) =>
    String(a.when).localeCompare(String(b.when))
  );
  // Queued means the request is waiting on the Mac, which is a different state
  // from "we cannot do this", so it gets its own section.
  const queued = [...(report.queued || [])].sort((a, b) =>
    String(a.when).localeCompare(String(b.when))
  );
  const problems = [
    ...(report.skipped || []).map((s) => ({ ...s, kind: 'skipped' })),
    ...(report.failed || []).map((f) => ({ ...f, kind: 'failed' })),
  ].sort((a, b) => String(a.when).localeCompare(String(b.when)));

  const lines = [];
  lines.push(`*Today's readings* · ${dateLabel(report.date, tz)}`);

  const n = report.meetings || 0;
  lines.push(
    `${n} meeting${n === 1 ? '' : 's'} · ${ready.length} deck${ready.length === 1 ? '' : 's'} ready` +
      (queued.length ? ` · ${queued.length} building` : '') +
      (problems.length ? ` · ${problems.length} need${problems.length === 1 ? 's' : ''} a look` : '')
  );

  if (ready.length) {
    lines.push('');
    lines.push('*Ready*');
    for (const r of ready) {
      const who = (r.title || '').replace(/\s*&\s*Charm\s*$/i, '').replace(/\s+/g, ' ').trim() || r.domain;
      lines.push(`• ${timeLabel(r.when, tz)}  ${who} · ${r.domain}  <${BASE_URL}/d/${r.slug}|open deck>`);
    }
  }

  if (queued.length) {
    lines.push('');
    lines.push('*Building*');
    for (const q of queued) {
      const who = (q.title || '').replace(/\s*&\s*Charm\s*$/i, '').replace(/\s+/g, ' ').trim() || q.domain;
      lines.push(`• ${timeLabel(q.when, tz)}  ${who} · ${q.domain}  _queued, generating on the Mac_`);
    }
  }

  if (problems.length) {
    lines.push('');
    lines.push('*No deck*');
    for (const p of problems) {
      const who = (p.title || '').replace(/\s*&\s*Charm\s*$/i, '').replace(/\s+/g, ' ').trim() || p.who || p.domain || 'unknown';
      const why =
        p.kind === 'failed'
          ? `${p.domain ? p.domain + ': ' : ''}${humanError(p.error)}`
          : humanReason(p.reason, p);
      lines.push(`• ${timeLabel(p.when, tz)}  ${who} — ${why}`);
    }
  }

  if (!ready.length && !problems.length && !queued.length) {
    lines.push('');
    lines.push('_No meetings booked today._');
  }

  return lines.join('\n');
}

// Turn an API error into something a person reads at 8am. Raw JSON in a team
// channel is noise, and it leaks request ids into a shared surface.
function humanError(err) {
  const raw = String(err || 'unknown error');
  if (/credit balance is too low/i.test(raw)) {
    return 'out of Anthropic API credits, top up at platform.claude.com';
  }
  if (/rate.?limit|429/i.test(raw)) return 'hit the Anthropic rate limit, will retry tomorrow';
  if (/timed out|timeout/i.test(raw)) return 'research took too long and timed out';
  if (/authentication|invalid.?api.?key|401/i.test(raw)) return 'Anthropic API key was rejected';
  if (/overloaded|529/i.test(raw)) return 'Anthropic API was overloaded';
  if (/declined by safety|refusal/i.test(raw)) return 'the research was declined, try this one by hand';

  // Unknown error: pull the API's message field if there is one, and keep it short.
  const m = raw.match(/"message"\s*:\s*"([^"]+)"/);
  const text = (m ? m[1] : raw).replace(/\s+/g, ' ').trim();
  return 'generation failed: ' + (text.length > 140 ? text.slice(0, 137) + '...' : text);
}

function humanReason(reason, p) {
  const r = String(reason || '');
  if (r.startsWith('free email provider')) {
    return `booked with a personal email (${p.who || 'no company address'}), no company site to research`;
  }
  if (r === 'on the skip list') return 'domain is on the skip list';
  if (r === 'domain does not respond') return `${p.domain} did not respond, so it was not researched`;
  if (r.startsWith('no website field')) return 'no website on the contact and no email to work from';
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
