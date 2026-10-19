/** Phase 5 permission-aware search (docs/architecture/phase-5-implementation.md §9).
 *
 * Index: `search_documents` (authoritative, server-only) + `search_fts` (FTS5, rowid-aligned,
 * reconstructible) + `search_dirty` (filled by triggers in the same statement as every
 * record write; migration 0022).
 *
 * Query rules:
 *  - Tokens are escaped literals (letters/digits only), ANDed; tokens of ≥ 2 characters are
 *    prefix-matched. No MATCH syntax or SQL from callers.
 *  - Readable-space prefilter in SQL, then the request's read gate (the authorization
 *    kernel) on every candidate. Unauthorized documents never contribute a title, snippet,
 *    count or rank.
 *  - Rank uses only the document's own content (title hit before body hit, then newest
 *    revision): no bm25 or other corpus statistics, so hidden documents cannot move visible
 *    ones. Ordering is total — (score, rev, doc_id) — and the cursor is a keyset position,
 *    so pages stay complete and stable when the gate drops candidates.
 *  - A dirty document is never served from the index: its CURRENT content is matched
 *    instead (bounded). If the dirty backlog in readable spaces exceeds that bound the reply
 *    says `indexPending: true` instead of silently omitting results.
 * No totals, raw ranks or timings are returned. */
import { createReadGate, type ReadGate } from './readAccess';
import type { Env } from './auth';
import { levelSql } from './capability';
import { hasD1Budget } from './d1budget';

export const SEARCH_MAX_LIMIT = 50;
const PROCESS_CHUNK = 50;
const BODY_MAX = 8_000;
const LIVE_DIRTY_MAX = 200;
const MAX_TOKENS = 8;
export type SearchType = 'page' | 'task' | 'board' | 'moodboard' | 'comment' | 'file' | 'mooditem';
const TYPE_COLLECTION: Record<SearchType, string> = { page: 'pages', task: 'tasks', board: 'boards', moodboard: 'moodboards', comment: 'comments', file: 'files', mooditem: 'mooditems' };
const COLLECTION_TYPE: Record<string, SearchType> = { pages: 'page', tasks: 'task', boards: 'board', moodboards: 'moodboard', comments: 'comment', files: 'file', mooditems: 'mooditem' };

/* ---------- documents ---------- */

interface Doc { docId: string; collection: string; spaceId: string | null; databaseId: string | null; title: string; body: string; rev: number; url: string }
interface RootRow { id: string; collection: string; data: string; space_id: string | null; seq: number }
interface BlockRow { doc: string; text: string | null; seq: number }

const plain = (text: unknown) => String(text ?? '').replace(/@\[(?:page|user|rec):[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim();

function linkMetadata(value:unknown):string {try {const u=new URL(String(value));return u.protocol==='https:'?plain(u.hostname+' '+u.pathname):'';}catch{return '';}}

/** Current documents for `ids` (absent: missing, deleted, or not a document). One binding call. */
async function loadDocs(db: D1Database, ids: string[]): Promise<Map<string, Doc>> {
  const out = new Map<string, Doc>();
  if (!ids.length) return out;
  const json = JSON.stringify(ids);
  const [roots, blocks, ancestry] = await db.batch([
    db.prepare(`SELECT id, collection, data, space_id, seq FROM records WHERE id IN (SELECT value FROM json_each(?)) AND collection IN ('pages','tasks','boards','moodboards','comments','files','mooditems')`).bind(json),
    db.prepare(`SELECT json_extract(data,'$.pageId') AS doc, json_extract(data,'$.text') AS text, seq FROM records
        WHERE collection='blocks' AND json_extract(data,'$.pageId') IN (SELECT value FROM json_each(?)) AND COALESCE(json_extract(data,'$.deleted'),0)!=1
        ORDER BY doc, CAST(json_extract(data,'$.order') AS TEXT), id`).bind(json),
    db.prepare(`WITH RECURSIVE lineage(doc,id,collection,data,depth) AS (
      SELECT id,id,collection,data,0 FROM records WHERE id IN (SELECT value FROM json_each(?))
      UNION ALL SELECT l.doc,r.id,r.collection,r.data,l.depth+1 FROM lineage l JOIN records r ON r.id=CASE
        WHEN l.collection='pages' THEN json_extract(l.data,'$.parentId')
        WHEN l.collection='tasks' THEN COALESCE(json_extract(l.data,'$.parentId'),json_extract(l.data,'$.boardId'),'board-default')
        WHEN l.collection='blocks' THEN json_extract(l.data,'$.pageId')
        WHEN l.collection='comments' THEN json_extract(l.data,'$.targetId')
        WHEN l.collection='files' THEN json_extract(l.data,'$.parentId')
        WHEN l.collection='mooditems' THEN json_extract(l.data,'$.boardId') END WHERE l.depth<64
    ) SELECT * FROM lineage`).bind(json),
  ]);
  const paths = new Map<string, { id: string; collection: string; data: string; depth: number }[]>();
  for (const r of ancestry.results as unknown as {doc:string;id:string;collection:string;data:string;depth:number}[]) {
    const list=paths.get(r.doc)??[];list.push(r);paths.set(r.doc,list);
  }
  const bodies = new Map<string, { text: string[]; size: number; rev: number }>();
  for (const b of blocks.results as unknown as BlockRow[]) {
    const entry = bodies.get(b.doc) ?? { text: [], size: 0, rev: 0 };
    const t = plain(b.text);
    if (t && entry.size < BODY_MAX) { entry.text.push(t); entry.size += t.length + 1; }
    entry.rev = Math.max(entry.rev, b.seq);
    bodies.set(b.doc, entry);
  }
  for (const r of roots.results as unknown as RootRow[]) {
    let data: Record<string, unknown>;
    try { data = JSON.parse(r.data) as Record<string, unknown>; } catch { continue; }
    if (data.deleted === true || data.archived === true || data.parentType === 'form-pending') continue;
    const path=paths.get(r.id)??[];
    if(path.some(p=>{const d=JSON.parse(p.data);return d.deleted===true||d.archived===true;}) || path.some(p=>p.depth>=64))continue;
    const nav=path.find(p=>['pages','tasks','boards','moodboards'].includes(p.collection));
    if(!nav)continue;
    const navData=JSON.parse(nav.data);
    const url=nav.collection==='tasks'?`/boards/${encodeURIComponent(String(navData.boardId??'board-default'))}/tasks/${encodeURIComponent(nav.id)}`
      :`/${nav.collection==='boards'?'boards':nav.collection==='moodboards'?'moodboards':'pages'}/${encodeURIComponent(nav.id)}`;
    const body = bodies.get(r.id);
    const title = String((r.collection === 'boards' || r.collection === 'files' ? data.name ?? data.title : r.collection === 'comments' ? data.body : r.collection === 'mooditems' ? data.title ?? data.text : data.title) ?? (r.collection === 'pages' ? 'Untitled' : '')) || (r.collection === 'boards' ? 'Board' : r.collection === 'moodboards' ? 'Mood board' : 'Untitled');
    const text = [plain(data.description), r.collection==='comments'?plain(data.body):'', r.collection==='mooditems'?plain(data.text):'', r.collection==='files'?linkMetadata(data.url):'', ...Object.entries(data).filter(([k,v])=>k.startsWith('p_')&&typeof v==='string').map(([,v])=>plain(v)), ...(body?.text ?? [])].filter(Boolean).join('\n').slice(0, BODY_MAX);
    out.set(r.id, { docId: r.id, collection: r.collection, spaceId: r.space_id, databaseId: r.collection === 'tasks' ? String(data.boardId ?? 'board-default') : null,
      title: plain(title).slice(0,300), body: text, rev: Math.max(r.seq, body?.rev ?? 0), url });
  }
  return out;
}

/** Rebuild up to one chunk of dirty documents: one read batch, one write batch. A dirty key
 * is removed only if its token is unchanged (no write arrived while it was being rebuilt). */
export async function processSearchDirty(env: Pick<Env, 'DB'>, limit = PROCESS_CHUNK): Promise<number> {
  const db = env.DB;
  const { results: dirty } = await db.prepare('SELECT doc_id, token FROM search_dirty ORDER BY token LIMIT ?').bind(Math.min(limit, PROCESS_CHUNK)).all<{ doc_id: string; token: number }>();
  if (!dirty.length) return 0;
  const docs = await loadDocs(db, dirty.map(d => d.doc_id));
  const statements: D1PreparedStatement[] = [];
  for (const { doc_id: id, token } of dirty) {
    const doc = docs.get(id);
    statements.push(db.prepare('DELETE FROM search_fts WHERE rowid = (SELECT rowid FROM search_documents WHERE doc_id = ?) AND EXISTS(SELECT 1 FROM search_dirty WHERE doc_id=? AND token=?)').bind(id,id,token));
    if (doc) {
      statements.push(
        db.prepare(`INSERT INTO search_documents(doc_id, collection, space_id, database_id, title, body, source_rev) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM search_dirty WHERE doc_id=? AND token=?)
            ON CONFLICT(doc_id) DO UPDATE SET collection=excluded.collection, space_id=excluded.space_id, database_id=excluded.database_id,
              title=excluded.title, body=excluded.body, source_rev=excluded.source_rev`).bind(id, doc.collection, doc.spaceId, doc.databaseId, doc.title, doc.body, doc.rev,id,token),
        db.prepare('INSERT INTO search_fts(rowid, title, body) SELECT rowid, title, body FROM search_documents WHERE doc_id = ? AND EXISTS(SELECT 1 FROM search_dirty WHERE doc_id=? AND token=?)').bind(id,id,token),
      );
    } else statements.push(db.prepare('DELETE FROM search_documents WHERE doc_id = ? AND EXISTS(SELECT 1 FROM search_dirty WHERE doc_id=? AND token=?)').bind(id,id,token));
    statements.push(db.prepare('DELETE FROM search_dirty WHERE doc_id = ? AND token = ?').bind(id, token));
  }
  await db.batch(statements);
  return dirty.length;
}

/** Drain the backlog while the invocation budget allows (cron / outbox). */
export async function processSearchBacklog(env: Pick<Env, 'DB'>, maxChunks = 20): Promise<number> {
  let done = 0;
  for (let i = 0; i < maxChunks && hasD1Budget(env.DB, 6); i++) {
    const n = await processSearchDirty(env);
    done += n;
    if (n < PROCESS_CHUNK) break;
  }
  return done;
}

/** Recovery: mark a keyset page of documents dirty (rebuilds a lost or corrupted index). */
export async function enqueueSearchRebuild(env: Pick<Env, 'DB'>, after = '', page = 400): Promise<{ queued: number; next: string | null }> {
  const { results } = await env.DB.prepare(`SELECT id, seq FROM records WHERE collection IN ('pages','tasks','boards','moodboards','comments','files','mooditems') AND id > ? ORDER BY id LIMIT ?`)
    .bind(after, page).all<{ id: string; seq: number }>();
  if (results.length) {
    await env.DB.prepare(`INSERT INTO search_dirty(doc_id, token) SELECT json_extract(value,'$.id'), json_extract(value,'$.seq') FROM json_each(?) WHERE true
        ON CONFLICT(doc_id) DO UPDATE SET token = MAX(token, excluded.token)`).bind(JSON.stringify(results)).run();
  }
  return { queued: results.length, next: results.length === page ? results[results.length - 1].id : null };
}

/* ---------- query ---------- */

export interface SearchQuery { q: string; spaceId?: string; type?: SearchType; databaseId?: string; cursor?: string | null; limit?: number }
export interface SearchHit { docId: string; type: SearchType; title: string; databaseId: string | null; rev: number; snippet: string | null; url?: string }
export interface SearchResult { results: SearchHit[]; nextCursor: string | null; hasMore: boolean; indexPending: boolean }
export class SearchError extends Error { constructor(public readonly code: 'invalid_cursor' | 'invalid_query') { super(code); this.name = 'SearchError'; } }

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
export function searchTokens(q: string): string[] {
  return [...new Set(fold(String(q ?? '')).match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, MAX_TOKENS);
}
const ftsExpr = (tokens: string[]) => tokens.map(t => (t.length >= 2 ? `"${t}"*` : `"${t}"`)).join(' AND ');
/** Same rule as the FTS expression, for live (dirty) documents. */
function liveMatch(tokens: string[], text: string): boolean {
  const words = fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.every(t => words.some(w => (t.length >= 2 ? w.startsWith(t) : w === t)));
}

interface Key { s: number; r: number; id: string }
const before = (a: Key, b: Key) => a.s !== b.s ? a.s > b.s : a.r !== b.r ? a.r > b.r : a.id > b.id; // a sorts before b (DESC)
async function sha(text: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join(''); }
const encode = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decode(cursor: string): Record<string, unknown> {
  try { return JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>; } catch { throw new SearchError('invalid_cursor'); }
}

/** The search service shared by MCP `search` and `GET /api/search`. `env` must carry the
 * caller's read gate (or `gate` is created for `userId`). */
export async function searchRecords(env: Pick<Env, 'DB' | 'READ_GATE'>, userId: string, query: SearchQuery): Promise<SearchResult> {
  const db = env.DB, gate: ReadGate = env.READ_GATE ?? createReadGate(db, userId);
  const tokens = searchTokens(query.q);
  const limit = Math.max(1, Math.min(Math.floor(query.limit ?? 20), SEARCH_MAX_LIMIT));
  if (!tokens.length) return { results: [], nextCursor: null, hasMore: false, indexPending: false };
  const collection = query.type ? TYPE_COLLECTION[query.type] : null;
  if (query.type && !collection) throw new SearchError('invalid_query');
  const fingerprint = await sha(JSON.stringify([userId, tokens, collection, query.databaseId ?? null, query.spaceId ?? null]));
  let after: Key | null = null;
  if (query.cursor) {
    const c = decode(query.cursor);
    if (c.v !== 1 || c.f !== fingerprint || typeof c.s !== 'number' || typeof c.r !== 'number' || typeof c.id !== 'string') throw new SearchError('invalid_cursor');
    after = { s: c.s, r: c.r, id: c.id };
  }
  const scoped = await gate.enabled();
  const spaceFilter = (col: string) => (scoped ? ` AND ${col} IN (SELECT s.id FROM spaces s WHERE ${levelSql('?', 's.id')} >= 1)` : '');
  const spaceBind = scoped ? [userId] : [];
  const match = ftsExpr(tokens), titleMatch = `{title} : (${match})`;
  const docFilter = `${collection ? ' AND d.collection = ?' : ''}${query.databaseId ? ' AND d.database_id = ?' : ''}${query.spaceId ? ' AND d.space_id = ?' : ''}`;
  const docBind = [...(collection ? [collection] : []), ...(query.databaseId ? [query.databaseId] : []), ...(query.spaceId ? [query.spaceId] : [])];

  // Live candidates: dirty documents in readable spaces, matched on current content.
  const { results: dirtyRows } = await db.prepare(`SELECT s.doc_id FROM search_dirty s JOIN records r ON r.id = s.doc_id
      WHERE r.collection IN ('pages','tasks','boards','moodboards','comments','files','mooditems')${spaceFilter('r.space_id')} ORDER BY s.doc_id LIMIT ?`)
    .bind(...spaceBind, LIVE_DIRTY_MAX + 1).all<{ doc_id: string }>();
  const indexPending = dirtyRows.length > LIVE_DIRTY_MAX;
  const dirtyIds = dirtyRows.slice(0, LIVE_DIRTY_MAX).map(r => r.doc_id);
  const live: (Key & { doc: Doc })[] = [];
  for (const doc of (await loadDocs(db, dirtyIds)).values()) {
    if ((collection && doc.collection !== collection) || (query.databaseId && doc.databaseId !== query.databaseId) || (query.spaceId && doc.spaceId !== query.spaceId)) continue;
    const titleHit = liveMatch(tokens, doc.title);
    if (!titleHit && !liveMatch(tokens, `${doc.title} ${doc.body}`)) continue;
    live.push({ s: titleHit ? 1 : 0, r: doc.rev, id: doc.docId, doc });
  }
  live.sort((a, b) => (before(a, b) ? -1 : 1));

  const window = limit * 2;
  const results: (Key & { hit: SearchHit; rowid?: number })[] = [];
  let scan: Key | null = after, hasMore = false;
  for (let round = 0; round < 4 && results.length < limit; round++) {
    const cursorSql = scan ? ' WHERE (score < ? OR (score = ? AND rev < ?) OR (score = ? AND rev = ? AND doc_id < ?))' : '';
    const cursorBind = scan ? [scan.s, scan.s, scan.r, scan.s, scan.r, scan.id] : [];
    const { results: rows } = await db.prepare(`SELECT * FROM (
        SELECT d.rowid AS rowid, d.doc_id AS doc_id, d.collection AS collection, d.database_id AS database_id, d.title AS title, d.source_rev AS rev,
          CASE WHEN d.rowid IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?) THEN 1 ELSE 0 END AS score
        FROM search_fts JOIN search_documents d ON d.rowid = search_fts.rowid
        WHERE search_fts MATCH ?${spaceFilter('d.space_id')}${docFilter} AND d.doc_id NOT IN (SELECT doc_id FROM search_dirty)
      )${cursorSql} ORDER BY score DESC, rev DESC, doc_id DESC LIMIT ?`)
      .bind(titleMatch, match, ...spaceBind, ...docBind, ...cursorBind, window + 1)
      .all<{ rowid: number; doc_id: string; collection: string; database_id: string | null; title: string; rev: number; score: number }>();
    const indexedMore = rows.length > window;
    const indexed = rows.slice(0, window).map(r => ({ s: r.score, r: r.rev, id: r.doc_id, rowid: r.rowid,
      hit: { docId: r.doc_id, type: COLLECTION_TYPE[r.collection], title: r.title, databaseId: r.database_id, rev: r.rev, snippet: null } as SearchHit }));
    // Everything up to `boundary` is complete in this round; later live items wait.
    const boundary: Key | null = indexedMore ? indexed[indexed.length - 1] : null;
    const pending = live.filter(l => (!scan || before(scan, l)) && (!boundary || !before(boundary, l)))
      .map(l => ({ s: l.s, r: l.r, id: l.id, hit: { docId: l.id, type: COLLECTION_TYPE[l.doc.collection], title: l.doc.title, databaseId: l.doc.databaseId, rev: l.doc.rev, snippet: null } as SearchHit }));
    const merged = [...indexed, ...pending].sort((a, b) => (before(a, b) ? -1 : 1));
    const allowed = new Set((await gate.filter(merged.map(m => ({ id: m.id })))).map(m => m.id));
    let stopped = false;
    for (let i = 0; i < merged.length; i++) {
      const item = merged[i];
      scan = item;
      if (allowed.has(item.id)) results.push(item);
      if (results.length === limit) { hasMore = i < merged.length - 1 || indexedMore || live.some(l => before(item, l)); stopped = true; break; }
    }
    if (stopped) break;
    if (!indexedMore) { hasMore = false; break; }
    scan = boundary;
    hasMore = true;
  }
  // Snippets for indexed hits only (a dirty document's index text may be stale).
  const rowids = results.filter(r => r.rowid !== undefined).map(r => r.rowid!);
  if (rowids.length) {
    const { results: snippets } = await db.prepare(`SELECT rowid, snippet(search_fts, 1, '[', ']', '…', 12) AS snippet FROM search_fts WHERE search_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))`)
      .bind(match, JSON.stringify(rowids)).all<{ rowid: number; snippet: string }>();
    const byRow = new Map(snippets.map(s => [s.rowid, s.snippet]));
    for (const r of results) if (r.rowid !== undefined) r.hit.snippet = byRow.get(r.rowid) || null;
  }
  // The cursor is the last SCANNED position (readable or not), never the last returned one:
  // the next page starts exactly where this one stopped looking.
  return {
    results: await (async()=>{
      const current=await loadDocs(db,results.map(r=>r.id));
      const candidates=results.filter(r=>{const d=current.get(r.id);return d&&liveMatch(tokens,`${d.title} ${d.body}`);});
      const allowed=new Set((await createReadGate(db,userId).filter(candidates.map(r=>({id:r.id})))).map(r=>r.id));
      return candidates.filter(r=>allowed.has(r.id)).map(r=>{const d=current.get(r.id)!;
        return {...r.hit,title:d.title,url:d.url,snippet:r.rowid!==undefined&&d.rev===r.r?r.hit.snippet:d.body.slice(0,180)||null};});
    })(),
    nextCursor: hasMore && scan ? encode({ v: 1, f: fingerprint, s: scan.s, r: scan.r, id: scan.id }) : null,
    hasMore, indexPending,
  };
}

