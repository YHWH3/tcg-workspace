import {servedFile} from './fileServing';
export {SVG_HEADERS,svgHeaders,servedFileHeaders,servedFile} from './fileServing';
import {usageBytes,QUOTA_BYTES,ID_RE,MAX_FILE_SIZE,readBytes,putChunk,completeUpload,reclaimChunkStatement} from './fileStore';
import type {FileRow} from './fileStore';
export {UNFINISHED_UPLOAD_WINDOW_MS,heldBytes,MAX_FILE_SIZE,QUOTA_BYTES,D1_MAX_ROW_BYTES,FILE_CHUNK_BYTES,fileChunkSlices,ID_RE,concatRows,type FileRow} from './fileStore';

import { accessEnabled } from './readAccess';
import { Hono } from 'hono';
import { requireAuth } from './auth';
import type { Env, AuthUser } from './auth';
import { authorizeFile, fileBatch, FileAccessError, readableFileUsage } from './fileAccess';
import { syncFailure } from './syncAccess';

export const files = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
files.use('*', requireAuth);
files.onError((error, c) => {
  if (error instanceof FileAccessError) return c.json({ error: error.message }, error.status);
  const failure = syncFailure(error);
  if (failure) return c.json({ error: failure.error }, failure.status);
  throw error;
});

files.get('/usage', async (c) => {
  const scoped = await readableFileUsage(c.env.DB, c.get('user'));
  return c.json({ used: scoped ?? await usageBytes(c.env.DB), limit: QUOTA_BYTES, ...(scoped !== null ? { scope: 'readable', quotaShared: true } : {}) });
});

/** Idempotent chunk upsert. Body is the raw chunk bytes. */
files.put('/:id/chunks/:idx',putChunk);
files.post('/:id/complete',completeUpload);

files.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!ID_RE.test(id)) return c.json({ error: 'invalid file id' }, 400);
  const authority = await authorizeFile(c.env.DB, c.get('user'), id, false);
  const meta = await c.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first<FileRow>();
  if (!meta || !meta.complete) return c.json({ error: 'not found' }, 404);
  const bytes=await readBytes(c.env,meta,authority);
  if(!bytes)return c.json({error:'not found'},404);
  const served=servedFile(meta.mime,bytes);
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
      reclaimChunkStatement(c.env.DB,id),
      c.env.DB.prepare('DELETE FROM files WHERE id IN (SELECT id FROM reclaimable_files WHERE id=?)').bind(id),
    ]);
  }
  return c.json({ ok: true });
});

const WHISPER_MODEL='@cf/openai/whisper-large-v3-turbo';
const MAX_TRANSCRIBE_BYTES=MAX_FILE_SIZE;

/** Transcribe an uploaded audio file with Workers AI Whisper. */
files.post('/:id/transcribe', async (c) => {
  const id = c.req.param('id');
  if (!ID_RE.test(id)) return c.json({ error: 'invalid file id' }, 400);
  const authority = await authorizeFile(c.env.DB, c.get('user'), id, true);
  const meta = await c.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first<FileRow>();
  if (!meta || !meta.complete) return c.json({ error: 'not found' }, 404);
  if ((meta.size ?? 0) > MAX_TRANSCRIBE_BYTES) return c.json({ error: 'audio too large to transcribe' }, 413);
  const bytes=await readBytes(c.env,meta,authority);
  if(!bytes)return c.json({error:'not found'},404);
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
