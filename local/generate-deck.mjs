// Generate one deck by driving Claude Code headlessly on this Mac, using the
// Claude subscription rather than an API key.
//
//   node local/generate-deck.mjs acme.com
//
// Claude Code has WebSearch and WebFetch built in, so research and writing
// happen in a single pass rather than the two API calls the server uses.

import { spawn } from 'child_process';
import { VOICE, NARRATIVE } from '../brand.js';

const MODEL = process.env.LOCAL_DECK_MODEL || 'claude-opus-5';

const SCHEMA_SHAPE = `{
  "company":        { "name", "one_liner", "industry", "what_they_sell" },
  "icp":            { "who_they_sell_to", "buyer_titles": [], "deal_shape" },
  "tam":            { "headline", "reasoning", "segments": [ { "name", "size_note", "why" } ] },
  "channels":       { "email", "linkedin", "phone" },
  "three_things":   { "leads", "words", "signals_teaser", "infrastructure" },
  "sequence":       { "headline", "body", "touches": [ { "day", "channel", "what" } ] },
  "signals":        [ { "name", "loudness": "screaming" | "wincing", "what_it_looks_like", "how_we_act" } ],
  "sample_email":   { "subject", "body", "signal_used" },
  "sample_linkedin":{ "connection_note", "follow_up", "signal_used" },
  "read":           { "observed": [], "gap", "question" },
  "sources":        [ { "title", "url" } ]
}`;

function buildPrompt(domain, extra = '') {
  return `Research the company at ${domain} and write a Charm discovery deck for them.

STEP 1, RESEARCH. Fetch their site and search the web. Establish: what they do,
who they sell to and which buyer titles sign, the shape of their TAM, their deal
size and sales motion, what outbound they visibly run today, what pressure is
building in their market, and five or more observable events in THEIR BUYERS'
world that indicate rising pain. Never invent a customer, headcount, funding
round or metric. If you cannot verify something, work around it rather than
filling it in.

STEP 2, WRITE. Turn that into deck copy following the Charm rules below.

${VOICE}

${NARRATIVE}

RULES FOR THE COPY:
- Every field is prospect-specific. If a line would read the same for any
  company, rewrite it.
- Deck copy, not prose. Slide lines are short.
- The deck no longer shows their ICP, their TAM size, or a market segmentation.
  You still produce icp and tam below and should use them to reason, but do
  NOT write copy that points at them as if the prospect has seen them. No "your
  three segments", no "the 11,400 companies we mapped". Nothing on a slide may
  assume the prospect has been shown a breakdown of their own market.
- signals is the heart of the deck. Mix loud signals ("screaming": stated
  openly, a job post, an RFP, a public award) with quiet ones ("wincing": only
  visible if you are watching, headcount drift, a quiet tooling swap, a
  leadership change, a title change). Include at least three "wincing" signals,
  because the whole point of the reveal is that most pain is never stated.
- how_we_act is what Charm's team does when the signal fires. An operator
  action, not a product feature.
- three_things.signals_teaser is ONE short sentence that sits under "write the
  words". It hints the words change based on what we see in their buyers'
  world, without explaining the mechanism. The reveal comes later in the deck.
- sample_email is a real cold email to one of their buyers, triggered by one of
  the signals you listed. Four sentences maximum, no pleasantries, no link dump.
  Subject lowercase and under seven words.
- sample_linkedin follows the same trigger. Connection note under 300 characters
  and does not pitch.
- read.observed is three to five things you noticed about their current
  outbound. read.gap is one sentence naming the gap. read.question is the
  gap-sell question Chris asks out loud, in his voice.
- sources are the pages you actually used.
- CHECK EVERY FIELD FOR EM DASHES BEFORE RETURNING. There must be none.
${extra}

OUTPUT. Return ONLY a single JSON object, no markdown fence and no commentary
before or after, in exactly this shape:

${SCHEMA_SHAPE}`;
}

export function runClaude(prompt, { model = MODEL, timeoutMs = 25 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--model', model,
      '--allowed-tools', 'WebSearch,WebFetch',
    ];
    const env = { ...process.env };
    // Force the subscription path: an API key in the environment would be used
    // instead, which is the whole thing we are avoiding here.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const child = spawn('claude', args, { env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude timed out after ${Math.round(timeoutMs / 60000)} minutes`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 400)}`));
      resolve(out);
    });
  });
}

// Claude Code wraps the answer in an envelope; the deck JSON is inside .result.
// Pull the first balanced object out of it, tolerating stray prose or a fence.
export function extractDeck(rawStdout) {
  let payload;
  try {
    payload = JSON.parse(rawStdout);
  } catch {
    throw new Error('claude did not return JSON on stdout');
  }
  if (payload.is_error) throw new Error(`claude reported an error: ${payload.result || 'unknown'}`);

  const text = String(payload.result ?? '');
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON object found in the response');

  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      return { deck: JSON.parse(text.slice(start, i + 1)), cost: payload.total_cost_usd, turns: payload.num_turns };
    }
  }
  throw new Error('JSON object in the response was not closed');
}

const EM_DASH = /[—–]/g;
function scrub(v) {
  if (typeof v === 'string') return v.replace(EM_DASH, ',');
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
  return v;
}

export async function generateDeck(domain, extra = '') {
  const raw = await runClaude(buildPrompt(domain, extra));
  const { deck, cost, turns } = extractDeck(raw);
  const required = ['company', 'icp', 'tam', 'channels', 'three_things', 'sequence', 'signals', 'sample_email', 'sample_linkedin', 'read'];
  const missing = required.filter((k) => !deck[k]);
  if (missing.length) throw new Error(`deck is missing: ${missing.join(', ')}`);
  return { deck: scrub(deck), cost, turns };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const domain = process.argv[2];
  if (!domain) {
    console.error('usage: node local/generate-deck.mjs <domain>');
    process.exit(1);
  }
  generateDeck(domain)
    .then(({ deck, cost, turns }) => {
      console.error(`done: ${turns} turns, cost reported as $${(cost ?? 0).toFixed(4)}`);
      process.stdout.write(JSON.stringify(deck, null, 2));
    })
    .catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}
