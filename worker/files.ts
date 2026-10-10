import { Hono } from 'hono';
import { requireAuth } from './auth';
import type { Env, AuthUser } from './auth';
import { sanitizeSvg } from '../shared/svgSanitize';

/** SVG must be served inert: sandboxed, scripts/styles locked down. */
export const SVG_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
};

export function svgHeaders(mime: string | null | undefined): Record<string, string> {
  return mime === 'image/svg+xml' ? { 'Content-Type': 'image/svg+xml', ...SVG_HEADERS } : {};
}

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB per file
export const QUOTA_BYTES = 450 * 1024 * 1024; // 450 MB workspace quota
const MAX_CHUNK = 2 * 1024 * 1024; // D1 row limit; clients send 1 MiB
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
// Whisper-large-v3-turbo input ceiling; voice notes are also capped client-side at 5 min.
const MAX_TRANSCRIBE_BYTES = MAX_FILE_SIZE;

export interface FileRow {
  id: string;
  mime: string | null;
  size: number | null;
  chunks: number | null;
  complete: number;
}

/** D1 returns BLOBs as ArrayBuffer in production but Uint8Array/number[] in some local paths — normalize. */
function toBytes(d: unknown): Uint8Array {
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (d instanceof Uint8Array) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (Array.isArray(d)) return new Uint8Array(d);
  return new Uint8Array(0);
}

export function concatRows(results: { data: unknown }[]): Uint8Array<ArrayBuffer> {
  const parts = results.map((r) => toBytes(r.data));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export const files = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
files.use('*', requireAuth);

async function usageBytes(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE complete = 1').first<{ used: number }>();
  return row?.used ?? 0;
}

files.get('/usage', async (c) => {
  return c.json({ used: await usageBytes(c.env.DB), limit: QUOTA_BYTES });
});

/** Idempotent chunk upsert. Body is the raw chunk bytes. */
files.put('/:id/chunks/:idx', async (c) => {
  const id = c.req.param('id');
  const idx = Number(c.req.param('idx'));
  if (!ID_RE.test(id)) return c.json({ error: 'invalid file id' }, 400);
  if (!Number.isInteger(idx) || idx < 0 || idx > 4096) return c.json({ error: 'invalid chunk index' }, 400);

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return c.json({ error: 'empty chunk' }, 400);
  if (body.byteLength > MAX_CHUNK) return c.json({ error: 'chunk too large' }, 413);

  const db = c.env.DB;
  const existing = await db.prepare('SELECT id, complete FROM files WHERE id = ?').bind(id).first<{ id: string; complete: number }>();
  if (existing?.complete) return c.json({ error: 'file already complete' }, 409);
  if (!existing) {
    // Tentative quota check when a new upload starts (final check at complete).
    if ((await usageBytes(db)) >= QUOTA_BYTES) return c.json({ error: 'storage quota exceeded' }, 507);
    await db.prepare('INSERT INTO files (id, uploaded_by, created_at, complete) VALUES (?, ?, ?, 0)').bind(id, c.get('user').id, Date.now()).run();
  }
  await db.prepare('INSERT INTO file_chunks (file_id, idx, data) VALUES (?, ?, ?) ON CONFLICT(file_id, idx) DO UPDATE SET data = excluded.data').bind(id, idx, body).run();
  return c.json({ ok: true, idx, size: body.byteLength });
});

files.post('/:id/complete', async (c) => {
  const id = c.req.param('id');
  if (!ID_RE.test(id)) return c.json({ error: 'invalid file id' }, 400);
  const body = await c.req.json<{ mime?: string; size?: number; chunks?: number }>().catch(() => null);
  if (!body || typeof body.chunks !== 'number' || body.chunks < 1 || typeof body.size !== 'number' || body.size < 1) {
    return c.json({ error: 'invalid body' }, 400);
  }
  if (body.size > MAX_FILE_SIZE) return c.json({ error: 'file too large (max 20 MB)' }, 413);

  const db = c.env.DB;
  const meta = await db.prepare('SELECT * FROM files WHERE id = ?').bind(id).first<FileRow>();
  if (!meta) return c.json({ error: 'no chunks uploaded' }, 400);
  if (meta.complete) return c.json({ ok: true }); // idempotent

  const agg = await db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes, MIN(idx) AS lo, MAX(idx) AS hi FROM file_chunks WHERE file_id = ?')
    .bind(id)
    .first<{ n: number; bytes: number; lo: number; hi: number }>();
  if (!agg || agg.n !== body.chunks || agg.lo !== 0 || agg.hi !== body.chunks - 1) {
    return c.json({ error: 'missing chunks' }, 400);
  }
  // Ensure there are no gaps (indices are contiguous 0..chunks-1).
  const gaps = await db
    .prepare('SELECT COUNT(*) AS missing FROM (SELECT idx FROM file_chunks WHERE file_id = ?) WHERE idx NOT BETWEEN 0 AND ?')
    .bind(id, body.chunks - 1)
    .first<{ missing: number }>();
  if (gaps && gaps.missing > 0) return c.json({ error: 'missing chunks' }, 400);
  if (agg.bytes !== body.size) return c.json({ error: 'size mismatch' }, 400);

  if ((await usageBytes(db)) + body.size > QUOTA_BYTES) return c.json({ error: 'storage quota exceeded' }, 507);

  const mime = typeof body.mime === 'string' && body.mime.length <= 100 ? body.mime : 'application/octet-stream';

  // SVG is active markup: sanitize on write and store the canonical output.
  if (mime === 'image/svg+xml') {
    const { results } = await db.prepare('SELECT data FROM file_chunks WHERE file_id = ? ORDER BY idx').bind(id).all<{ data: unknown }>();
    const svg = sanitizeSvg(new TextDecoder().decode(concatRows(results)));
    if (!svg.ok) {
      await db.batch([db.prepare('DELETE FROM file_chunks WHERE file_id = ?').bind(id), db.prepare('DELETE FROM files WHERE id = ?').bind(id)]);
      return c.json({ error: 'svg failed sanitization', reasons: svg.reasons }, 400);
    }
    const bytes = new TextEncoder().encode(svg.svg);
    await db.prepare('DELETE FROM file_chunks WHERE file_id = ?').bind(id).run();
    const chunks: D1PreparedStatement[] = [];
    for (let off = 0, idx = 0; off < bytes.length; off += MAX_CHUNK, idx++) {
      chunks.push(db.prepare('INSERT INTO file_chunks (file_id, idx, data) VALUES (?, ?, ?)').bind(id, idx, bytes.slice(off, off + MAX_CHUNK)));
    }
    await db.batch(chunks);
    await db.prepare('UPDATE files SET mime = ?, size = ?, chunks = ?, complete = 1 WHERE id = ?').bind(mime, bytes.length, chunks.length, id).run();
    return c.json({ ok: true });
  }

  await db.prepare('UPDATE files SET mime = ?, size = ?, chunks = ?, complete = 1 WHERE id = ?').bind(mime, body.size, body.chunks, id).run();
  return c.json({ ok: true });
});

files.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!ID_RE.test(id)) return c.json({ error: 'invalid file id' }, 400);
  const meta = await c.env.DB.prepare('SELECT mime, size, complete FROM files WHERE id = ?').bind(id).first<FileRow>();
  if (!meta || !meta.complete) return c.json({ error: 'not found' }, 404);
  const { results } = await c.env.DB.prepare('SELECT data FROM file_chunks WHERE file_id = ? ORDER BY idx').bind(id).all<{ data: unknown }>();
  const out = concatRows(results);
  return new Response(out, {
    headers: {
      'Content-Type': meta.mime ?? 'application/octet-stream',
      'Content-Length': String(out.byteLength),
      'Cache-Control': 'private, max-age=31536000, immutable',
      ...svgHeaders(meta.mime),
    },
  });
});

files.delete('/:id', async (c) => {
  const id = c.req.param('id');
  if (!ID_RE.test(id)) return c.json({ error: 'invalid file id' }, 400);
  await c.env.DB.batch([c.env.DB.prepare('DELETE FROM file_chunks WHERE file_id = ?').bind(id), c.env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id)]);
  return c.json({ ok: true });
});

/** Transcribe an uploaded audio file with Workers AI Whisper. */
files.post('/:id/transcribe', async (c) => {
  const id = c.req.param('id');
  if (!ID_RE.test(id)) return c.json({ error: 'invalid file id' }, 400);
  const meta = await c.env.DB.prepare('SELECT mime, size, complete FROM files WHERE id = ?').bind(id).first<FileRow>();
  if (!meta || !meta.complete) return c.json({ error: 'not found' }, 404);
  if ((meta.size ?? 0) > MAX_TRANSCRIBE_BYTES) return c.json({ error: 'audio too large to transcribe' }, 413);
  const { results } = await c.env.DB.prepare('SELECT data FROM file_chunks WHERE file_id = ? ORDER BY idx').bind(id).all<{ data: unknown }>();
  const bytes = concatRows(results);
  // base64 in slices that are multiples of 3 so partials concatenate safely.
  let audio = '';
  const SLICE = 3 * 10922; // ~32KB
  for (let i = 0; i < bytes.length; i += SLICE) {
    const part = bytes.subarray(i, Math.min(i + SLICE, bytes.length));
    let bin = '';
    for (const b of part) bin += String.fromCharCode(b);
    audio += btoa(bin);
  }
  try {
    const res = (await c.env.AI.run(WHISPER_MODEL, { audio })) as { text?: string };
    return c.json({ text: res.text ?? '' });
  } catch (e) {
    return c.json({ error: `transcription failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
});
