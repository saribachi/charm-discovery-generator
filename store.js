// Deck storage. Uses Postgres when DATABASE_URL is set (Coolify prod),
// otherwise falls back to a JSON file on disk so local dev needs no database.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_PATH = path.join(__dirname, 'data', 'decks.json');
const usePg = Boolean(process.env.DATABASE_URL);

let pool = null;

export async function initStore() {
  if (usePg) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS decks (
        slug        TEXT PRIMARY KEY,
        domain      TEXT NOT NULL,
        company     TEXT NOT NULL,
        data        JSONB NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Generation requests waiting for a worker. The server never generates:
    // it queues, and the Mac running Claude Code on the subscription drains it.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id          TEXT PRIMARY KEY,
        domain      TEXT NOT NULL,
        status      TEXT NOT NULL,
        note        TEXT,
        slug        TEXT,
        error       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    console.log('store: postgres');
  } else {
    await fs.mkdir(path.dirname(FILE_PATH), { recursive: true });
    try {
      await fs.access(FILE_PATH);
    } catch {
      await fs.writeFile(FILE_PATH, '{}');
    }
    console.log('store: file (' + FILE_PATH + ')');
  }
}

async function readFileStore() {
  try {
    return JSON.parse(await fs.readFile(FILE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveDeck({ slug, domain, company, data }) {
  if (usePg) {
    await pool.query(
      `INSERT INTO decks (slug, domain, company, data)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE
         SET domain = EXCLUDED.domain,
             company = EXCLUDED.company,
             data = EXCLUDED.data,
             created_at = now()`,
      [slug, domain, company, data]
    );
    return;
  }
  const all = await readFileStore();
  all[slug] = { slug, domain, company, data, created_at: new Date().toISOString() };
  await fs.writeFile(FILE_PATH, JSON.stringify(all, null, 2));
}

export async function getDeck(slug) {
  if (usePg) {
    const { rows } = await pool.query('SELECT * FROM decks WHERE slug = $1', [slug]);
    return rows[0] || null;
  }
  const all = await readFileStore();
  return all[slug] || null;
}

export async function listDecks(limit = 60) {
  if (usePg) {
    const { rows } = await pool.query(
      'SELECT slug, domain, company, created_at FROM decks ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    return rows;
  }
  const all = await readFileStore();
  return Object.values(all)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, limit)
    .map(({ slug, domain, company, created_at }) => ({ slug, domain, company, created_at }));
}

// ---------------------------------------------------------------- job queue
//
// The server has no way to generate a deck: it holds no API key by design.
// A request from the browser becomes a job here, and the Mac running Claude
// Code on the subscription claims it, generates, and imports the result.

const JOBS_PATH = path.join(__dirname, 'data', 'jobs.json');

async function readJobs() {
  try {
    return JSON.parse(await fs.readFile(JOBS_PATH, 'utf8'));
  } catch {
    return {};
  }
}
async function writeJobs(all) {
  await fs.mkdir(path.dirname(JOBS_PATH), { recursive: true });
  await fs.writeFile(JOBS_PATH, JSON.stringify(all, null, 2));
}

export async function createJob(domain) {
  const id = 'job_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const now = new Date().toISOString();
  if (usePg) {
    // One live job per domain: re-asking while one is in flight returns it.
    const existing = await pool.query(
      `SELECT * FROM jobs WHERE domain = $1 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`,
      [domain]
    );
    if (existing.rows[0]) return { job: existing.rows[0], reused: true };
    const { rows } = await pool.query(
      `INSERT INTO jobs (id, domain, status, note) VALUES ($1, $2, 'queued', $3) RETURNING *`,
      [id, domain, 'Waiting for the Mac to pick this up.']
    );
    return { job: rows[0], reused: false };
  }
  const all = await readJobs();
  const live = Object.values(all).find((j) => j.domain === domain && ['queued', 'running'].includes(j.status));
  if (live) return { job: live, reused: true };
  all[id] = { id, domain, status: 'queued', note: 'Waiting for the Mac to pick this up.', created_at: now, updated_at: now };
  await writeJobs(all);
  return { job: all[id], reused: false };
}

export async function getJob(id) {
  if (usePg) {
    const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
    return rows[0] || null;
  }
  return (await readJobs())[id] || null;
}

export async function listJobs(limit = 50) {
  if (usePg) {
    const { rows } = await pool.query('SELECT * FROM jobs ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows;
  }
  return Object.values(await readJobs())
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, limit);
}

// Atomically hand the oldest queued job to a worker.
export async function claimJob() {
  if (usePg) {
    const { rows } = await pool.query(
      `UPDATE jobs SET status = 'running', note = 'Researching and writing on the Mac.', updated_at = now()
         WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1
                     FOR UPDATE SKIP LOCKED)
       RETURNING *`
    );
    return rows[0] || null;
  }
  const all = await readJobs();
  const next = Object.values(all)
    .filter((j) => j.status === 'queued')
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0];
  if (!next) return null;
  next.status = 'running';
  next.note = 'Researching and writing on the Mac.';
  next.updated_at = new Date().toISOString();
  await writeJobs(all);
  return next;
}

export async function updateJob(id, patch) {
  if (usePg) {
    const { rows } = await pool.query(
      `UPDATE jobs SET status = COALESCE($2, status), note = COALESCE($3, note),
              slug = COALESCE($4, slug), error = COALESCE($5, error), updated_at = now()
         WHERE id = $1 RETURNING *`,
      [id, patch.status ?? null, patch.note ?? null, patch.slug ?? null, patch.error ?? null]
    );
    return rows[0] || null;
  }
  const all = await readJobs();
  if (!all[id]) return null;
  Object.assign(all[id], patch, { updated_at: new Date().toISOString() });
  await writeJobs(all);
  return all[id];
}

// Anything left running far longer than a generation takes is a worker that
// died or a Mac that went to sleep mid-job. Put it back so it is not stuck.
export async function requeueStale(maxMinutes = 40) {
  const cutoff = Date.now() - maxMinutes * 60000;
  if (usePg) {
    const { rowCount } = await pool.query(
      `UPDATE jobs SET status = 'queued', note = 'Requeued after the worker went away.', updated_at = now()
         WHERE status = 'running' AND updated_at < $1`,
      [new Date(cutoff).toISOString()]
    );
    return rowCount;
  }
  const all = await readJobs();
  let n = 0;
  for (const j of Object.values(all)) {
    if (j.status === 'running' && new Date(j.updated_at).getTime() < cutoff) {
      j.status = 'queued';
      j.note = 'Requeued after the worker went away.';
      j.updated_at = new Date().toISOString();
      n++;
    }
  }
  if (n) await writeJobs(all);
  return n;
}

export async function deleteDeck(slug) {
  if (usePg) {
    await pool.query('DELETE FROM decks WHERE slug = $1', [slug]);
    return;
  }
  const all = await readFileStore();
  delete all[slug];
  await fs.writeFile(FILE_PATH, JSON.stringify(all, null, 2));
}
