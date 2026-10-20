import { accessEnabled } from './readAccess';
import { Hono } from 'hono';
import { requireAuth } from './auth';
import type { Env, AuthUser } from './auth';
import { sanitizeSvg } from '../shared/svgSanitize';
import { authorizeFile, fileBatch, FileAccessError, readableFileUsage } from './fileAccess';
import { syncFailure } from './syncAccess';
import { isInlineSafeMime } from '../shared/filekinds';

/** SVG must be served inert: sandboxed, scripts/styles locked down. */
export const SVG_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
};

export function svgHeaders(mime: string | null | undefined): Record<string, string> {
  return mime === 'image/svg+xml' ? { 'Content-Type': 'image/svg+xml', ...SVG_HEADERS } : {};
}

/**
 * The ONLY place a stored file's `Content-Type` is decided. The uploader
 * supplies the MIME string at `complete`, so it is untrusted: serving
 * `text/html` (or xhtml/xml/js) from the application origin would execute an
 * attachment as a page — directly through the unauthenticated share routes, or
 * through a `blob:` URL (which inherits this origin) in the in-app preview.
 * Anything outside the inline-safe allowlist is served as an opaque download.
 */
export function servedFileHeaders(mime: string | null | undefined): Record<string, string> {
  const type = String(mime ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'image/svg+xml') return svgHeaders(type);
  if (isInlineSafeMime(type)) return { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' };
  return { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment' };
}

/**
 * Body + headers for stored bytes. SVG is re-sanitized at serve time: bytes
 * stored by a path that predates sanitization (public form upload, remote
 * import) are never trusted. A document the sanitizer rejects is served as an
 * opaque download. Everything else follows servedFileHeaders.
 */
export function servedFile(mime: string | null | undefined, bytes: Uint8Array<ArrayBuffer>): { body: Uint8Array<ArrayBuffer>; headers: Record<string, string> } {
  const type = String(mime ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'image/svg+xml') {
    const svg = sanitizeSvg(new TextDecoder().decode(bytes));
    if (!svg.ok) return { body: bytes, headers: servedFileHeaders('application/octet-stream') };
    const body = new TextEncoder().encode(svg.svg);
    return { body, headers: servedFileHeaders(type) };
  }
  return { body: bytes, headers: servedFileHeaders(type) };
}

/** Unfinished uploads older than this are swept when no synced record claims
 * them (worker/reminders.ts); the same window bounds what they cost in quota,
 * so an abandoned upload whose record exists cannot hold quota forever. */
export const UNFINISHED_UPLOAD_WINDOW_MS = 7 * 24 * 3600_000;

/** Bytes held by a file's own other chunks and by everyone's recent unfinished
 * chunks, plus completed bytes. Replacing chunk `idx` of `id` is not growth. */
export async function heldBytes(db: D1Database, id: string, idx: number, now = Date.now()): Promise<{ done: number; own: number; pending: number }> {
  const row = await db.prepare(`SELECT (SELECT COALESCE(SUM(size),0) FROM files WHERE complete=1) AS done,
      COALESCE(SUM(CASE WHEN c.file_id=? THEN LENGTH(c.data) ELSE 0 END),0) AS own,
      COALESCE(SUM(CASE WHEN f.created_at>=? THEN LENGTH(c.data) ELSE 0 END),0) AS pending
    FROM file_chunks c JOIN files f ON f.id=c.file_id WHERE f.complete=0 AND NOT (c.file_id=? AND c.idx=?)`)
    .bind(id, now - UNFINISHED_UPLOAD_WINDOW_MS, id, idx).first<{ done: number; own: number; pending: number }>();
  return { done: row?.done ?? 0, own: row?.own ?? 0, pending: row?.pending ?? 0 };
}

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB per file
export const QUOTA_BYTES = 450 * 1024 * 1024; // 450 MB workspace quota
/** Cloudflare D1 rejects a single string/BLOB/row at or above this size. */
export const D1_MAX_ROW_BYTES = 2_000_000;
/** Shared chunk contract. 1 MiB is under the D1 row ceiling; 2 MiB is not. */
export const FILE_CHUNK_BYTES = 1_048_576;

/** Split bytes into consecutive chunks that are each safe to bind as a D1 BLOB.
 * Each slice owns its buffer. A view over the original file would let a binding
 * send the whole file as one row and exceed D1's per-row maximum. */
export function fileChunkSlices(bytes: Uint8Array): Uint8Array[] {
  if (FILE_CHUNK_BYTES >= D1_MAX_ROW_BYTES) throw new Error('chunk contract exceeds D1 row limit');
  const slices: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += FILE_CHUNK_BYTES) {
    const end = Math.min(offset + FILE_CHUNK_BYTES, bytes.byteLength);
    const part = new Uint8Array(end - offset);
    part.set(bytes.subarray(offset, end));
    if (part.byteLength === 0 || part.byteLength >= D1_MAX_ROW_BYTES || part.buffer.byteLength !== part.byteLength) {
      throw new Error('chunk exceeds D1 row limit');
    }
    slices.push(part);
  }
  return slices;
}
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
files.onError((error, c) => {
  if (error instanceof FileAccessError) return c.json({ error: error.message }, error.status);
  const failure = syncFailure(error);
  if (failure) return c.json({ error: failure.error }, failure.status);
  throw error;
});

async function usageBytes(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE complete = 1').first<{ used: number }>();
  return row?.used ?? 0;
}

files.get('/usage', async (c) => {
  const scoped = await readableFileUsage(c.env.DB, c.get('user'));
  return c.json({ used: scoped ?? await usageBytes(c.env.DB), limit: QUOTA_BYTES, ...(scoped !== null ? { scope: 'readable', quotaShared: true } : {}) });
});

/** Idempotent chunk upsert. Body is the raw chunk bytes. */
files.put('/:id/chunks/:idx', async (c) => {
  const id = c.req.param('id');
  const idx = Number(c.req.param('idx'));
  if (!ID_RE.test(id)) return c.json({ error: 'invalid file id' }, 400);
  if (!Number.isInteger(idx) || idx < 0 || idx > 4096) return c.json({ error: 'invalid chunk index' }, 400);
  const authority = await authorizeFile(c.env.DB, c.get('user'), id, true);

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return c.json({ error: 'empty chunk' }, 400);
  if (body.byteLength > FILE_CHUNK_BYTES || body.byteLength >= D1_MAX_ROW_BYTES) return c.json({ error: 'chunk too large' }, 413);

  const db = c.env.DB;
  if (await db.prepare('SELECT id FROM file_deletions WHERE id=?').bind(id).first()) return c.json({ error: 'file deleted' }, 410);
  const existing = await db.prepare('SELECT id, complete FROM files WHERE id = ?').bind(id).first<{ id: string; complete: number }>();
  if (existing?.complete) return c.json({ error: 'file already complete' }, 409);
  if (!existing) {
    // Tentative quota check when a new upload starts (final check at complete).
    if ((await usageBytes(db)) >= QUOTA_BYTES) return c.json({ error: 'storage quota exceeded' }, 507);
  }
  // Bound what an unfinished upload may hold. Chunks of uploads that never
  // complete were outside every limit (one id accepted 4096 chunks; unfinished
  // bytes never counted toward the quota). A file that can never be completed
  // (> MAX_FILE_SIZE) is refused with 413; the workspace quota counts
  // completed bytes PLUS everyone's unfinished chunks and answers 507 — both
  // are the statuses the client treats as a permanent, user-visible failure.
  // Replacing an existing chunk is not growth.
  const held = await heldBytes(db, id, idx);
  if (held.own + body.byteLength > MAX_FILE_SIZE) return c.json({ error: 'file too large (max 20 MB)' }, 413);
  if (held.done + held.pending + body.byteLength > QUOTA_BYTES) return c.json({ error: 'storage quota exceeded' }, 507);
  // The completion check belongs to the same statement as the write: a PUT
  // that read pending state before another request completed must not alter
  // the acknowledged file afterwards.
  const [, written] = await fileBatch(db, authority, [
    db.prepare(`INSERT OR IGNORE INTO files (id,uploaded_by,created_at,complete)
      SELECT ?,?,?,0 WHERE NOT EXISTS(SELECT 1 FROM file_deletions WHERE id=?)`).bind(id, c.get('user').id, Date.now(), id),
    db.prepare(`INSERT INTO file_chunks (file_id, idx, data)
    SELECT ?, ?, ? WHERE EXISTS(SELECT 1 FROM files WHERE id=? AND complete=0) AND NOT EXISTS(SELECT 1 FROM file_deletions WHERE id=?)
    ON CONFLICT(file_id, idx) DO UPDATE SET data = excluded.data
      WHERE EXISTS(SELECT 1 FROM files WHERE id=? AND complete=0) AND NOT EXISTS(SELECT 1 FROM file_deletions WHERE id=?)`)
    .bind(id, idx, body, id, id, id, id),
  ]);
  if (!(written.meta.changes ?? 0)) return c.json({ error: 'file already complete' }, 409);
  return c.json({ ok: true, idx, size: body.byteLength });
});

files.post('/:id/complete', async (c) => {
  const id = c.req.param('id');
  if (!ID_RE.test(id)) return c.json({ error: 'invalid file id' }, 400);
  const authority = await authorizeFile(c.env.DB, c.get('user'), id, true);
  const body = await c.req.json<{ mime?: string; size?: number; chunks?: number }>().catch(() => null);
  if (!body || typeof body.chunks !== 'number' || !Number.isInteger(body.chunks) || body.chunks < 1 || typeof body.size !== 'number' || !Number.isInteger(body.size) || body.size < 1) {
    return c.json({ error: 'invalid body' }, 400);
  }
  if (body.size > MAX_FILE_SIZE) return c.json({ error: 'file too large (max 20 MB)' }, 413);

  const db = c.env.DB;
  if (await db.prepare('SELECT id FROM file_deletions WHERE id=?').bind(id).first()) return c.json({ error: 'file deleted' }, 410);
  const meta = await db.prepare('SELECT * FROM files WHERE id = ?').bind(id).first<FileRow>();
  if (!meta) return c.json({ error: 'no chunks uploaded' }, 400);
  if (meta.complete) { if (authority) await fileBatch(db, authority, []); return c.json({ ok: true }); } // idempotent

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
  const oversized = await db.prepare('SELECT 1 AS hit FROM file_chunks WHERE file_id=? AND LENGTH(data)>=? LIMIT 1').bind(id, D1_MAX_ROW_BYTES).first<{ hit: number }>();
  if (oversized) return c.json({ error: 'chunk too large' }, 413);

  if ((await usageBytes(db)) + body.size > QUOTA_BYTES) return c.json({ error: 'storage quota exceeded' }, 507);

  const mime = typeof body.mime === 'string' && body.mime.length <= 100 ? body.mime : 'application/octet-stream';
  // Recheck integrity and quota in the final write transaction. Preliminary
  // reads improve errors but cannot authorize a later concurrent completion.
  const readySql = `complete=0
    AND (SELECT COUNT(*) FROM file_chunks WHERE file_id=files.id)=?
    AND (SELECT COALESCE(SUM(LENGTH(data)),0) FROM file_chunks WHERE file_id=files.id)=?
    AND (SELECT MIN(idx) FROM file_chunks WHERE file_id=files.id)=0
    AND (SELECT MAX(idx) FROM file_chunks WHERE file_id=files.id)=?-1
    AND NOT EXISTS(SELECT 1 FROM file_chunks WHERE file_id=files.id AND LENGTH(data)>=?)
    AND (SELECT COALESCE(SUM(size),0) FROM files WHERE complete=1)+?<=?`;
  const interrupted = async () => {
    if (authority) await fileBatch(db, authority, []);
    const current = await db.prepare('SELECT complete FROM files WHERE id=?').bind(id).first<{ complete: number }>();
    if (current?.complete) return c.json({ ok: true });
    if ((await usageBytes(db)) + body.size! > QUOTA_BYTES) return c.json({ error: 'storage quota exceeded' }, 507);
    return c.json({ error: 'file changed during completion; retry upload' }, 409);
  };

  // SVG is active markup: sanitize on write and store the canonical output.
  if (mime === 'image/svg+xml') {
    const { results } = await db.prepare('SELECT data FROM file_chunks WHERE file_id = ? ORDER BY idx').bind(id).all<{ data: unknown }>();
    const svg = sanitizeSvg(new TextDecoder().decode(concatRows(results)));
    if (!svg.ok) {
      await fileBatch(db, authority, [
        db.prepare('DELETE FROM file_chunks WHERE file_id=? AND EXISTS(SELECT 1 FROM files WHERE id=? AND complete=0)').bind(id, id),
        db.prepare('DELETE FROM files WHERE id=? AND complete=0').bind(id),
      ]);
      return c.json({ error: 'svg failed sanitization', reasons: svg.reasons }, 400);
    }
    const bytes = new TextEncoder().encode(svg.svg);
    const parts = fileChunkSlices(bytes);
    const chunks: D1PreparedStatement[] = [
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM files WHERE id=? AND ${readySql}) THEN 1 ELSE json_extract('{','$') END`)
        .bind(id, body.chunks, body.size, body.chunks, D1_MAX_ROW_BYTES, bytes.length, QUOTA_BYTES),
      db.prepare('DELETE FROM file_chunks WHERE file_id = ?').bind(id),
    ];
    for (const [idx, part] of parts.entries()) {
      chunks.push(db.prepare('INSERT INTO file_chunks (file_id, idx, data) VALUES (?, ?, ?)').bind(id, idx, part));
    }
    chunks.push(db.prepare('UPDATE files SET mime = ?, size = ?, chunks = ?, complete = 1 WHERE id = ?')
      .bind(mime, bytes.length, parts.length, id));
    try { await fileBatch(db, authority, chunks); }
    catch (error) {
      if (error instanceof FileAccessError) throw error;
      if (error instanceof Error && /malformed JSON/i.test(error.message)) return interrupted();
      return c.json({ error: 'file completion interrupted; retry' }, 503);
    }
    return c.json({ ok: true });
  }

  const [completed] = await fileBatch(db, authority, [db.prepare(`UPDATE files SET mime = ?, size = ?, chunks = ?, complete = 1 WHERE id = ? AND ${readySql}`)
    .bind(mime, body.size, body.chunks, id, body.chunks, body.size, body.chunks, D1_MAX_ROW_BYTES, body.size, QUOTA_BYTES)]);
  if (!(completed.meta.changes ?? 0)) return interrupted();
  return c.json({ ok: true });
});

files.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!ID_RE.test(id)) return c.json({ error: 'invalid file id' }, 400);
  const authority = await authorizeFile(c.env.DB, c.get('user'), id, false);
  const meta = await c.env.DB.prepare('SELECT mime, size, chunks, complete FROM files WHERE id = ?').bind(id).first<FileRow>();
  if (!meta || !meta.complete) return c.json({ error: 'not found' }, 404);
  const [bytes] = await fileBatch(c.env.DB, authority, [c.env.DB.prepare('SELECT idx, data FROM file_chunks WHERE file_id = ? ORDER BY idx').bind(id)]);
  const results = bytes.results as unknown as { idx: number; data: unknown }[];
  if (results.length !== (meta.chunks ?? results.length) || results.some((row, index) => row.idx !== index)) return c.json({ error: 'not found' }, 404);
  const served = servedFile(meta.mime, concatRows(results));
  return new Response(served.body, {
    headers: {
      'Content-Length': String(served.body.byteLength),
      // Authorization is per request: never let an HTTP cache answer for the
      // server (revocation, deletion, account switch). The client keeps its
      // own blob cache in IndexedDB.
      'Cache-Control': 'private, no-store',
      ...served.headers,
    },
  });
});

files.delete('/:id', async (c) => {
  const id = c.req.param('id');
  if (!ID_RE.test(id)) return c.json({ error: 'invalid file id' }, 400);
  const authority = await authorizeFile(c.env.DB, c.get('user'), id, true);
  const row=await c.env.DB.prepare('SELECT collection,data FROM records WHERE id=?').bind(id).first<{collection:string;data:string}>();
  // Enabled: a record the caller may not act on is indistinguishable from a missing file.
  if(row && !authority && await accessEnabled(c.env.DB)) return c.json({error:'not found'},404);
  if(row) {
    if(row.collection!=='files') return c.json({error:'not a file'},409);
    const {applyChanges}=await import('./sync');
    const data=JSON.parse(row.data) as {thumbId?:string};
    const changes=[{id,collection:'files',patch:{deleted:true},ts:0}];
    if(data.thumbId && (!authority || await c.env.DB.prepare("SELECT 1 FROM records WHERE id=? AND collection='files'").bind(data.thumbId).first())) changes.push({id:data.thumbId,collection:'files',patch:{deleted:true},ts:0});
    const result=await applyChanges(c.env,c.get('user').id,changes,{serverTs:true,event:{source:'client',ctx:c.executionCtx},session:{tokenHash:c.get('user').tokenHash}});
    if(result.partialError||result.rejected) return c.json({error:'cleanup interrupted; retry'},503);
  } else {
    // Legacy/incomplete uploads have no synced metadata. Only their uploader
    // or an administrator may retire them; record IDs cannot be repurposed.
    const blob=await c.env.DB.prepare('SELECT uploaded_by FROM files WHERE id=?').bind(id).first<{uploaded_by:string|null}>();
    if(blob&&blob.uploaded_by!==c.get('user').id&&c.get('user').role!=='admin') return c.json({error:'forbidden'},403);
    await fileBatch(c.env.DB, authority, [
      c.env.DB.prepare('INSERT INTO file_deletions(id,created_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING').bind(id,Date.now()),
      c.env.DB.prepare('DELETE FROM file_chunks WHERE file_id IN (SELECT id FROM reclaimable_files WHERE id=?)').bind(id),
      c.env.DB.prepare('DELETE FROM files WHERE id IN (SELECT id FROM reclaimable_files WHERE id=?)').bind(id),
    ]);
  }
  return c.json({ ok: true });
});

/** Transcribe an uploaded audio file with Workers AI Whisper. */
files.post('/:id/transcribe', async (c) => {
  const id = c.req.param('id');
  if (!ID_RE.test(id)) return c.json({ error: 'invalid file id' }, 400);
  const authority = await authorizeFile(c.env.DB, c.get('user'), id, true);
  const meta = await c.env.DB.prepare('SELECT mime, size, complete FROM files WHERE id = ?').bind(id).first<FileRow>();
  if (!meta || !meta.complete) return c.json({ error: 'not found' }, 404);
  if ((meta.size ?? 0) > MAX_TRANSCRIBE_BYTES) return c.json({ error: 'audio too large to transcribe' }, 413);
  const [chunkRows] = await fileBatch(c.env.DB, authority, [c.env.DB.prepare('SELECT data FROM file_chunks WHERE file_id = ? ORDER BY idx').bind(id)]);
  const results = chunkRows.results as unknown as { data: unknown }[];
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
    if (authority) await fileBatch(c.env.DB, authority, []);
    return c.json({ text: res.text ?? '' });
  } catch (e) {
    if (e instanceof FileAccessError) throw e;
    return c.json({ error: `transcription failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
});
