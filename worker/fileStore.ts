import {servedFileHeaders} from './fileServing';
import {hasD1Budget} from './d1budget';
import type {Context} from 'hono';
import type {Env,AuthUser} from './auth';
import {authorizeFile,fileBatch,FileAccessError,type FileAuthority} from './fileAccess';
import {sanitizeSvg} from '../shared/svgSanitize';

type FileContext=Context<{Bindings:Env;Variables:{user:AuthUser}}>;

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

export interface FileRow {
  id: string;
  mime: string | null;
  size: number | null;
  chunks: number | null;
  complete: number;
  storage: 'd1'|'r2';
  r2_key: string|null;
  sha256: string|null;
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

export async function usageBytes(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE complete = 1').first<{ used: number }>();
  return row?.used ?? 0;
}

export async function readBytes(env: StorageEnv, file: FileRow, authority: FileAuthority | null = null): Promise<Uint8Array<ArrayBuffer> | null> {
  if(file.storage==='r2'){
    if(!env.FILES)throw new Error('R2 binding unavailable');
    const object=await env.FILES.get(file.r2_key!);
    if(object){
      if(object.size>MAX_FILE_SIZE){await object.body.cancel();throw new Error('stored file exceeds size limit');}
      const bytes=new Uint8Array(await object.arrayBuffer());
      if(bytes.length!==file.size||await bytesHash(bytes)!==file.sha256)throw new Error('stored file integrity mismatch');
      // External I/O never extends an old credential or record capability.
      const [current] = await fileBatch(env.DB, authority, [
        env.DB.prepare("SELECT 1 FROM files WHERE id=? AND storage='r2' AND r2_key=? AND sha256=? AND complete=1")
          .bind(file.id, file.r2_key, file.sha256),
      ]);
      return current.results.length ? bytes : null;
    }
  }
  const [rows]=await fileBatch(env.DB,authority,[env.DB.prepare('SELECT idx, data FROM file_chunks WHERE file_id = ? ORDER BY idx').bind(file.id)]);
  const chunks=rows.results as unknown as {idx:number;data:unknown}[];
  if(!chunks.length||chunks.length!==(file.chunks??chunks.length)||chunks.some((row,index)=>row.idx!==index)){
    if (file.storage === 'r2') console.warn('file_bytes_missing');
    else if (env.FILES) {
      // A concurrent promotion may have removed the chunks after metadata was read.
      const promoted = await env.DB.prepare("SELECT * FROM files WHERE id=? AND storage='r2' AND complete=1")
        .bind(file.id).first<FileRow>();
      if (promoted) return readBytes(env, promoted, authority);
    }
    return null;
  }
  const bytes = concatRows(chunks);
  if (file.storage === 'r2' && (bytes.length !== file.size || await bytesHash(bytes) !== file.sha256)) {
    throw new Error('stored file integrity mismatch');
  }
  return bytes;
}

export function deleteChunkStatement(db:D1Database,id:string){return db.prepare('DELETE FROM file_chunks WHERE file_id=?').bind(id);}
export function reclaimChunkStatement(db:D1Database,id:string){return db.prepare('DELETE FROM file_chunks WHERE file_id IN (SELECT id FROM reclaimable_files WHERE id=?)').bind(id);}

export async function putChunk(c:FileContext){
  const id = c.req.param('id') ?? '';
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
    if ((await usageBytes(db)) >= quotaBytes(c.env)) return c.json({ error: 'storage quota exceeded' }, 507);
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
  if (held.done + held.pending + body.byteLength > quotaBytes(c.env)) return c.json({ error: 'storage quota exceeded' }, 507);
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
}

export async function completeUpload(c:FileContext){
  const id = c.req.param('id') ?? '';
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
  if (meta.complete) { await finalize(c.env,id,authority); if (authority) await fileBatch(db, authority, []); return c.json({ ok: true }); } // idempotent

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

  if ((await usageBytes(db)) + body.size > quotaBytes(c.env)) return c.json({ error: 'storage quota exceeded' }, 507);

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
    if (current?.complete) {await finalize(c.env,id,authority);return c.json({ ok: true });}
    if ((await usageBytes(db)) + body.size! > quotaBytes(c.env)) return c.json({ error: 'storage quota exceeded' }, 507);
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
        .bind(id, body.chunks, body.size, body.chunks, D1_MAX_ROW_BYTES, bytes.length, quotaBytes(c.env)),
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
    await finalize(c.env,id,authority);
    return c.json({ ok: true });
  }

  const [completed] = await fileBatch(db, authority, [db.prepare(`UPDATE files SET mime = ?, size = ?, chunks = ?, complete = 1 WHERE id = ? AND ${readySql}`)
    .bind(mime, body.size, body.chunks, id, body.chunks, body.size, body.chunks, D1_MAX_ROW_BYTES, body.size, quotaBytes(c.env))]);
  if (!(completed.meta.changes ?? 0)) return interrupted();
  await finalize(c.env,id,authority);
  return c.json({ ok: true });
}

/** Atomic D1 staging shared by public forms and authorized remote import. */
export async function stageBytes(env:StorageEnv,id:string,mime:string,bytes:Uint8Array<ArrayBuffer>,uploadedBy:string|null,now=Date.now()):Promise<boolean>{
  const db=env.DB,parts=fileChunkSlices(bytes);
  await db.batch([
    db.prepare('INSERT INTO files (id,uploaded_by,created_at,complete,mime,size,chunks) SELECT ?,?,?,0,?,?,? WHERE (SELECT COALESCE(SUM(size),0) FROM files WHERE complete=1)+?<=?')
      .bind(id,uploadedBy,now,mime,bytes.length,parts.length,bytes.length,quotaBytes(env)),
    ...parts.map((part,idx)=>db.prepare('INSERT INTO file_chunks(file_id,idx,data) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM files WHERE id=?)').bind(id,idx,part,id)),
    db.prepare('UPDATE files SET complete=1 WHERE id=? AND (SELECT COUNT(*) FROM file_chunks WHERE file_id=?)=? AND (SELECT COALESCE(SUM(LENGTH(data)),0) FROM file_chunks WHERE file_id=?)=?')
      .bind(id,id,parts.length,id,bytes.length),
  ]);
  const file=await db.prepare('SELECT * FROM files WHERE id=? AND complete=1').bind(id).first<FileRow>();
  if(!file){
    if(await db.prepare('SELECT id FROM files WHERE id=?').bind(id).first())throw new Error('file staging incomplete');
    return false;
  }
  return true;
}

export function abandonedChunkStatement(db:D1Database,before:number){return db.prepare(`DELETE FROM file_chunks WHERE file_id IN (
 SELECT f.id FROM files f WHERE f.complete=0 AND f.created_at<? AND NOT EXISTS(SELECT 1 FROM records r WHERE r.id=f.id))`).bind(before);}

type StorageEnv=Pick<Env,'DB'|'FILES'|'FILE_STORAGE'|'FILE_QUOTA_MB'>;

export function quotaBytes(env:Pick<Env,'FILE_QUOTA_MB'>):number{
  if(env.FILE_QUOTA_MB===undefined)return QUOTA_BYTES;
  const mb=Number(env.FILE_QUOTA_MB);
  if(!Number.isSafeInteger(mb)||mb<1||mb>1024*1024)throw new Error('invalid FILE_QUOTA_MB');
  return mb*1024*1024;
}

async function bytesHash(bytes:Uint8Array<ArrayBuffer>):Promise<string>{
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
}

/** Completed D1 chunks are immutable. Retain an intent before external I/O so
 * lost acknowledgements can replay the same key/bytes. Delete always wins. */
export async function finalize(env:StorageEnv,id:string,authority:FileAuthority|null=null,adminFence?:()=>D1PreparedStatement):Promise<'d1'|'r2'|'missing'>{
  if(env.FILE_STORAGE!=='r2')return 'd1';
  if(!env.FILES){console.warn('file_r2_finalize_failed');return 'd1';}
  const db=env.DB;
  const file=await db.prepare('SELECT * FROM files WHERE id=? AND complete=1').bind(id).first<FileRow>();
  if(!file)return 'missing';
  if(file.storage==='r2')return 'r2';
  const key=`files/${id}`;
  await fileBatch(db,authority,[...(adminFence?[adminFence()]:[]),db.prepare(`INSERT INTO file_storage_jobs(file_id,object_key,operation,created_at)
    SELECT id,?,'copy',? FROM files WHERE id=? AND storage='d1' AND complete=1
    AND NOT EXISTS(SELECT 1 FROM file_deletions WHERE id=?) ON CONFLICT(file_id) DO NOTHING`).bind(key,Date.now(),id,id)]);
  const job=await db.prepare("SELECT operation FROM file_storage_jobs WHERE file_id=?").bind(id).first<{operation:string}>();
  if(job?.operation!=='copy')return 'd1';
  try{
    const bytes=await readBytes(env,file,authority);
    if(!bytes||bytes.length!==file.size||bytes.length>MAX_FILE_SIZE)throw new Error('file bytes incomplete');
    const hash=await bytesHash(bytes);
    await env.FILES.put(key,bytes,{sha256:hash,httpMetadata:{contentType:servedFileHeaders(file.mime)['Content-Type']},customMetadata:{sha256:hash,workspaceFile:id}});
    // Backfill and fresh uploads use the same verified promotion, never a blind flip.
    const object=await env.FILES.get(key);
    if (!object) throw new Error('R2 verification failed');
    if (object.size !== bytes.length) {
      await object.body.cancel();
      throw new Error('R2 verification failed');
    }
    const stored=new Uint8Array(await object.arrayBuffer());
    if(await bytesHash(stored)!==hash)throw new Error('R2 verification failed');
    const [updated]=await fileBatch(db,authority,[
      db.prepare(`UPDATE files SET storage='r2',r2_key=?,sha256=? WHERE id=? AND complete=1 AND storage='d1'
        AND NOT EXISTS(SELECT 1 FROM file_deletions WHERE id=?)
        AND EXISTS(SELECT 1 FROM file_storage_jobs WHERE file_id=? AND operation='copy')`).bind(key,hash,id,id,id),
      db.prepare(`DELETE FROM file_chunks WHERE file_id=? AND EXISTS(SELECT 1 FROM files WHERE id=? AND storage='r2' AND sha256=?)`).bind(id,id,hash),
      db.prepare(`DELETE FROM file_storage_jobs WHERE file_id=? AND operation='copy' AND EXISTS(SELECT 1 FROM files WHERE id=? AND storage='r2' AND sha256=?)`).bind(id,id,hash),
      ...(adminFence?[adminFence()]:[]),
    ]);
    if (updated.meta.changes) return 'r2';
    const current = await db.prepare('SELECT storage FROM files WHERE id=? AND complete=1').bind(id)
      .first<{ storage: FileRow['storage'] }>();
    return current?.storage ?? 'missing';
  }catch(error){
    if (error instanceof FileAccessError) throw error;
    if (adminFence) await db.batch([adminFence()]);
    // This boundary can recover by serving the committed D1 copy and retaining work.
    console.warn('file_r2_finalize_failed');
    await db.prepare(`UPDATE file_storage_jobs SET attempts=attempts+1,next_attempt_at=?,last_error='copy_failed'
      WHERE file_id=? AND operation='copy'`).bind(Date.now()+15*60_000,id).run();
    return 'd1';
  }
}

/** Destructive byte reclamation, called only for a durable delete intent.
 * Missing acknowledgements leave the intent available for idempotent replay. */
export async function deleteBytes(env:StorageEnv,file:{id:string;object_key:string}):Promise<void>{
  if(!env.FILES)throw new Error('R2 binding unavailable');
  await env.FILES.delete(file.object_key);
  await env.DB.batch([
    deleteChunkStatement(env.DB,file.id),
    env.DB.prepare("DELETE FROM file_storage_jobs WHERE file_id=? AND operation='delete'").bind(file.id),
  ]);
}

/** Reuse the existing retention phase. Bounded jobs plus an object cursor repair
 * even a put that completed after deletion had already been acknowledged. */
export async function recoverFileStorage(env:StorageEnv,now=Date.now()):Promise<void>{
  if(!env.FILES||!hasD1Budget(env.DB,8))return;
  const db=env.DB;
  const jobs=await db.prepare("SELECT file_id AS id,object_key,operation FROM file_storage_jobs WHERE next_attempt_at<=? AND (operation='delete' OR ?='r2') ORDER BY next_attempt_at,file_id LIMIT 5").bind(now,env.FILE_STORAGE??'d1').all<{id:string;object_key:string;operation:string}>();
  for(const job of jobs.results){
    if(!hasD1Budget(db,9))break;
    if(job.operation==='copy'){
      if(env.FILE_STORAGE==='r2')await finalize(env,job.id);
    }else{
      try{await deleteBytes(env,job);}
      catch{await db.prepare("UPDATE file_storage_jobs SET attempts=attempts+1,next_attempt_at=?,last_error='delete_failed' WHERE file_id=? AND operation='delete'").bind(now+15*60_000,job.id).run();}
    }
  }
  if(!hasD1Budget(db,4))return;
  const cursor=await db.prepare("SELECT record_id FROM rhythm_sweep_cursors WHERE name='r2-objects'").first<{record_id:string}>();
  const page=await env.FILES.list({prefix:'files/',limit:20,include:['customMetadata'],...(cursor?.record_id?{cursor:cursor.record_id}:{})});
  const candidates=page.objects.filter(o=>o.customMetadata?.workspaceFile&&o.key===`files/${o.customMetadata.workspaceFile}`);
  if(candidates.length){
    const orphaned=await db.prepare(`SELECT json_extract(j.value,'$.key') AS object_key FROM json_each(?) j
      WHERE EXISTS(SELECT 1 FROM file_deletions WHERE id=json_extract(j.value,'$.id'))
      AND NOT EXISTS(SELECT 1 FROM files WHERE id=json_extract(j.value,'$.id'))
      AND NOT EXISTS(SELECT 1 FROM file_storage_jobs WHERE file_id=json_extract(j.value,'$.id') AND operation='copy')`)
      .bind(JSON.stringify(candidates.map(o=>({key:o.key,id:o.customMetadata!.workspaceFile})))).all<{object_key:string}>();
    if(orphaned.results.length)await env.FILES.delete(orphaned.results.map(o=>o.object_key));
  }
  await db.prepare("INSERT INTO rhythm_sweep_cursors(name,record_id) VALUES('r2-objects',?) ON CONFLICT(name) DO UPDATE SET record_id=excluded.record_id")
    .bind(page.truncated?page.cursor:'').run();
}

/** One authenticated admin page, with a fixed five-file bound. Returns a keyset
 * cursor, not a whole-file inventory. Authority is supplied by the admin route. */
export async function migrateFiles(
  env: StorageEnv, after: number, dryRun: boolean, fence: () => D1PreparedStatement, user: AuthUser,
) {
  const [page] = await env.DB.batch([
    env.DB.prepare(`SELECT rowid AS cursor, id, size FROM files
      WHERE rowid>? AND storage='d1' AND complete=1
        AND NOT EXISTS(SELECT 1 FROM file_deletions WHERE id=files.id)
      ORDER BY rowid LIMIT 6`).bind(after),
    fence(),
  ]);
  const candidates = page.results as unknown as { cursor: number; id: string; size: number | null }[];
  const files: { id: string; size: number | null; storage: string }[] = [];
  let examined = 0, cursor = after;
  for (const file of candidates.slice(0, 5)) {
    if (!hasD1Budget(env.DB, 15)) break;
    examined++;
    cursor = file.cursor;
    let authority: FileAuthority | null;
    try {
      authority = await authorizeFile(env.DB, user, file.id, false);
    } catch (error) {
      if (error instanceof FileAccessError && error.status === 404) continue;
      throw error;
    }
    if (dryRun) await fileBatch(env.DB, authority, [fence()]);
    const storage = dryRun ? 'd1' : await finalize(env, file.id, authority, fence);
    files.push({ id: file.id, size: file.size, storage });
  }
  await env.DB.batch([fence()]);
  return {dryRun, files, bytes: files.reduce((sum, file) => sum + (file.size ?? 0), 0), next: candidates.length > examined ? cursor : null};
}

export function orphanFormChunkStatement(db:D1Database,before:number){return db.prepare(`DELETE FROM file_chunks WHERE file_id IN (SELECT id FROM records WHERE collection='files' AND json_extract(data,'$.parentType')='form-pending' AND updated_at<? ORDER BY id LIMIT 50)`).bind(before);}
