/** Authenticated file capability, separate from public-share/form tokens. */
import { canEdit } from '../shared/access';
import { ownsThumbnail, thumbnailParentId } from '../shared/fileOwnership';
import { accessFence, readableSpaceIds, spaceAccess, type AccessContext } from './access';
import type { AuthUser } from './auth';
import { readAuthorizedRecords } from './recordAccess';
import { fencedRead, loadAccessState, syncContext } from './syncAccess';

export class FileAccessError extends Error {
  constructor(public readonly status: 403 | 404 | 409 | 503, message: string) { super(message); this.name = 'FileAccessError'; }
}
export interface FileAuthority { context: AccessContext; id: string; rev: number; tokenHash: string; auxiliaryId?: string }

export async function authorizeFile(db: D1Database, user: AuthUser, id: string, edit: boolean): Promise<FileAuthority | null> {
  if (!(await loadAccessState(db)).enabled) return null; // legacy Phase 4 contract
  const parentId = thumbnailParentId(id);
  const result = await readAuthorizedRecords(db, user.id, parentId ? [id, parentId] : [id]);
  let record = result.records.get(id);
  if (!record && parentId) {
    const parent = result.records.get(parentId);
    // A real record always keeps its own authority, even if a visible file
    // forges a reference to it as a thumbnail.
    if (parent?.collection === 'files' && parent.data.thumbId === id && ownsThumbnail(parent.id, id)
        && !await db.prepare('SELECT 1 FROM records WHERE id=?').bind(id).first()) record = parent;
  }
  if (!record || record.collection !== 'files') throw new FileAccessError(404, 'not found');
  if (edit && !canEdit(spaceAccess(result.context, record.scope.spaceId))) throw new FileAccessError(403, 'file is read-only');
  return { context: result.context, id: record.id, rev: record.rev, tokenHash: user.tokenHash, ...(record.id !== id ? { auxiliaryId: id } : {}) };
}

/** Every byte read/write uses the same batch as these fences. Parent reference,
 * deletion and membership changes invalidate the generation; the file row's
 * own revision and the current credential are checked as well. */
export async function fileBatch(db: D1Database, authority: FileAuthority | null, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  if (!authority) return db.batch(statements);
  const { context, id, rev, tokenHash, auxiliaryId } = authority;
  try {
    const result = await db.batch([
      accessFence(db, context),
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM records r JOIN sessions s ON s.user_id=?
        WHERE r.id=? AND r.collection='files' AND r.seq=? AND s.token_hash=? AND s.expires_at>?)
        AND NOT EXISTS(SELECT 1 FROM records WHERE id=?)
        THEN 1 ELSE json_extract('{','$') END`).bind(context.userId, id, rev, tokenHash, Date.now(), auxiliaryId ?? null),
      ...statements,
    ]);
    return result.slice(2);
  } catch (error) {
    const state = await loadAccessState(db);
    const record = await db.prepare('SELECT seq FROM records WHERE id=?').bind(id).first<{ seq: number }>();
    const session = await db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?').bind(tokenHash, context.userId, Date.now()).first();
    const collision = auxiliaryId && await db.prepare('SELECT 1 FROM records WHERE id=?').bind(auxiliaryId).first();
    if (state.generation !== context.generation || state.enabled !== Number(context.enabled) || record?.seq !== rev || !session || collision) throw new FileAccessError(409, 'file access changed; check access and retry');
    throw error;
  }
}

/** Workspace quota remains server-global. Reader-facing usage totals only
 * currently readable canonical files, so private bytes cannot become a side
 * channel through Settings. Bound this cold path; never return a partial sum. */
export async function readableFileUsage(db: D1Database, user: AuthUser): Promise<number | null> {
  const state = await loadAccessState(db);
  if (!state.enabled) return null;
  const context = await syncContext(db, user.id, state);
  const [, candidates] = await fencedRead(db, context, [db.prepare(`SELECT r.id,f.size FROM records r JOIN files f ON f.id IN (r.id,
      CASE WHEN json_extract(r.data,'$.thumbId')=r.id||'t'
        AND NOT EXISTS(SELECT 1 FROM records other WHERE other.id=r.id||'t') THEN r.id||'t' END)
    WHERE r.collection='files' AND f.complete=1 AND r.space_id IN (SELECT value FROM json_each(?)) ORDER BY r.id,f.id LIMIT 5001`)
    .bind(JSON.stringify(readableSpaceIds(context)))]);
  if (candidates.results.length > 5000) throw new FileAccessError(503, 'usage exceeds bounded scan; retry after maintenance');
  const rows = candidates.results as unknown as { id: string; size: number | null }[];
  let used = 0;
  for (let offset = 0; offset < rows.length; offset += 500) {
    const page = rows.slice(offset, offset + 500), authorized = await readAuthorizedRecords(db, user.id, page.map(r => r.id));
    if (authorized.context.generation !== context.generation) throw new FileAccessError(409, 'file access changed; check access and retry');
    for (const row of page) if (authorized.records.has(row.id)) used += row.size ?? 0;
  }
  await fencedRead(db, context, []); return used;
}
