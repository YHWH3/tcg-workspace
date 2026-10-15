import type { Env } from './auth';
import { MAX_FILE_SIZE, QUOTA_BYTES, fileChunkSlices } from './files';
import { uuid } from '../shared/order';
import { kindOf } from '../shared/filekinds';
import { applyChanges } from './sync';
import { sanitizeSvg } from '../shared/svgSanitize';

const ALLOWED = /^(image|video|audio)\/|^application\/pdf$/;

export class RemoteFileError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function usageBytes(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE complete = 1').first<{ used: number }>();
  return row?.used ?? 0;
}

/**
 * Fetch a remote file (https only) and store it like a client upload: D1
 * file_chunks + files rows (complete=1), plus a synced `files` record so it
 * renders everywhere a client attachment would. Enforces the 20 MB / 450 MB
 * limits. Returns the new file id.
 */
export async function importFileFromUrl(
  env: Env,
  url: string,
  opts: { parentType: 'task' | 'block' | 'mooditem'; parentId: string; userId: string; name?: string },
): Promise<{ fileId: string; mime: string; size: number }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new RemoteFileError(400, 'invalid url');
  }
  if (u.protocol !== 'https:') throw new RemoteFileError(400, 'only https urls are supported');

  const res = await fetch(u.toString(), { redirect: 'follow' });
  if (!res.ok || !res.body) throw new RemoteFileError(502, `fetch failed (${res.status})`);
  if (new URL(res.url || url).protocol !== 'https:') throw new RemoteFileError(400, 'redirected to non-https url');
  const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (!ALLOWED.test(mime)) throw new RemoteFileError(400, `unsupported content type: ${mime}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_FILE_SIZE) throw new RemoteFileError(413, 'file too large (max 20 MB)');

  // Stream the body with a hard cap — Content-Length may be missing/wrong.
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FILE_SIZE) {
      await reader.cancel().catch(() => {});
      throw new RemoteFileError(413, 'file too large (max 20 MB)');
    }
    parts.push(value);
  }
  let bytes = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    bytes.set(part, off);
    off += part.byteLength;
  }
  // SVG is active markup: a remote document is held to the same sanitizer as a
  // client upload and only the canonical output is stored.
  if (mime === 'image/svg+xml') {
    const svg = sanitizeSvg(new TextDecoder().decode(bytes));
    if (!svg.ok) throw new RemoteFileError(400, `svg failed sanitization: ${svg.reasons.join(', ')}`);
    bytes = new TextEncoder().encode(svg.svg);
  }
  if ((await usageBytes(env.DB)) + bytes.length > QUOTA_BYTES) throw new RemoteFileError(507, 'storage quota exceeded');

  const fileId = uuid();
  const slices = fileChunkSlices(bytes);
  const chunks = Math.max(1, slices.length);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('INSERT INTO files (id, mime, size, chunks, uploaded_by, created_at, complete) VALUES (?, ?, ?, ?, ?, ?, 1)').bind(
      fileId,
      mime,
      bytes.length,
      chunks,
      opts.userId,
      Date.now(),
    ),
  ];
  slices.forEach((part, i) => {
    stmts.push(env.DB.prepare('INSERT INTO file_chunks (file_id, idx, data) VALUES (?, ?, ?)').bind(fileId, i, part));
  });
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));

  const name = opts.name ?? decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? 'file').slice(0, 120);
  const r = await applyChanges(env, opts.userId, [
    {
      id: fileId,
      collection: 'files',
      patch: {
        name,
        mime,
        size: bytes.length,
        kind: kindOf(mime),
        parentType: opts.parentType,
        parentId: opts.parentId,
        uploadedBy: opts.userId,
        createdAt: Date.now(),
      },
      ts: Date.now(),
    },
  ]);
  if (r.conflict) throw new RemoteFileError(500, 'record write conflict');
  return { fileId, mime, size: bytes.length };
}
