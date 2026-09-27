import { Hono } from 'hono';
import { isCollection } from '../shared/collections';
import type { Mutation } from '../shared/types';
import { mergeRecord } from './merge';
import { requireAuth } from './auth';
import type { Env, AuthUser } from './auth';

const MAX_CHANGES = 500;
const MAX_ID_LEN = 64;

interface RecordRow {
  id: string;
  collection: string;
  data: string;
  field_ts: string;
  seq: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validChange(ch: unknown): ch is Mutation {
  if (!isPlainObject(ch)) return false;
  return (
    typeof ch.id === 'string' &&
    ch.id.length > 0 &&
    ch.id.length <= MAX_ID_LEN &&
    typeof ch.collection === 'string' &&
    isCollection(ch.collection) &&
    isPlainObject(ch.patch) &&
    typeof ch.ts === 'number' &&
    Number.isFinite(ch.ts)
  );
}

export const sync = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
sync.use('*', requireAuth);

sync.post('/push', async (c) => {
  const body = await c.req.json<{ changes?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.changes)) return c.json({ error: 'invalid body' }, 400);
  if (body.changes.length > MAX_CHANGES) return c.json({ error: `max ${MAX_CHANGES} changes per request` }, 400);
  const changes = body.changes;
  if (!changes.every(validChange)) return c.json({ error: 'invalid change' }, 400);
  if (changes.length === 0) return c.json({ ok: true, serverTime: Date.now() });

  const db = c.env.DB;
  const user = c.get('user');
  const now = Date.now();

  const existing = new Map<string, RecordRow>();
  const ids = [...new Set(changes.map((ch) => ch.id))];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await db
      .prepare(`SELECT id, collection, data, field_ts, seq FROM records WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<RecordRow>();
    for (const row of results) existing.set(row.id, row);
  }

  const statements: D1PreparedStatement[] = [];
  for (const change of changes) {
    const row = existing.get(change.id);
    if (row && row.collection !== change.collection) continue;
    const prev = row ? { data: JSON.parse(row.data) as Record<string, unknown>, field_ts: JSON.parse(row.field_ts) as Record<string, number> } : null;
    const merged = mergeRecord(prev, change);
    if (!merged.changed) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO records (id, collection, data, field_ts, seq, updated_by, updated_at)
           VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM records), ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             data = excluded.data,
             field_ts = excluded.field_ts,
             seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM records),
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
        )
        .bind(change.id, change.collection, JSON.stringify(merged.data), JSON.stringify(merged.field_ts), user.id, now),
    );
    existing.set(change.id, {
      id: change.id,
      collection: change.collection,
      data: JSON.stringify(merged.data),
      field_ts: JSON.stringify(merged.field_ts),
      seq: row?.seq ?? 0,
    });
  }

  for (let i = 0; i < statements.length; i += 100) {
    await db.batch(statements.slice(i, i + 100));
  }

  return c.json({ ok: true, serverTime: Date.now() });
});

sync.get('/pull', async (c) => {
  const since = Number(c.req.query('since') ?? '0');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '500') || 500, 1), 500);
  const { results } = await c.env.DB
    .prepare('SELECT id, collection, data, field_ts, seq FROM records WHERE seq > ? ORDER BY seq LIMIT ?')
    .bind(Number.isFinite(since) ? since : 0, limit + 1)
    .all<RecordRow>();
  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  const records = page.map((r) => ({
    id: r.id,
    collection: r.collection,
    data: JSON.parse(r.data) as Record<string, unknown>,
    field_ts: JSON.parse(r.field_ts) as Record<string, number>,
    seq: r.seq,
  }));
  return c.json({ records, cursor: page.length ? page[page.length - 1].seq : since, hasMore });
});
