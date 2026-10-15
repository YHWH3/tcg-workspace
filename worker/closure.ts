// Subtree reads for page delete / restore. A page tree is read with ONE
// recursive-CTE binding call instead of one query per page: every D1 binding
// call spends the request's invocation budget (45 on the Free plan), so a
// per-node walk failed with `processing_budget` on trees of ~20 pages, and the
// whole-collection alternative is capped at 5,000 rows.

import type { Env } from './auth';
import { SELECT, toRow, type RawRow, type RecRow } from './records';

export interface PageClosure {
  pages: RecRow[];
  blocks: RecRow[];
  files: RecRow[];
}

/**
 * The page `rootId` and its descendants (by parentId), plus every block whose
 * pageId is in that set and every file whose parentId is. By default only the
 * LIVE subtree is walked (a deleted child hides its own subtree, which was
 * deleted independently); `includeDeleted` walks tombstones too — restore needs
 * the rows a delete hid.
 */
export async function pageClosure(env: Pick<Env, 'DB'>, rootId: string, opts: { includeDeleted?: boolean } = {}): Promise<PageClosure> {
  const live = opts.includeDeleted ? '' : " AND COALESCE(json_extract(r.data,'$.deleted'),0)!=1";
  const cte = `WITH RECURSIVE sub(id) AS (
      SELECT id FROM records WHERE id=? AND collection='pages'
      UNION
      SELECT r.id FROM records r JOIN sub ON json_extract(r.data,'$.parentId')=sub.id WHERE r.collection='pages'${live})`;
  const db = env.DB;
  const [pages, blocks, files] = await db.batch<RawRow>([
    db.prepare(`${cte} SELECT ${SELECT} FROM records WHERE collection='pages' AND id IN (SELECT id FROM sub)`).bind(rootId),
    db.prepare(`${cte} SELECT ${SELECT} FROM records WHERE collection='blocks' AND json_extract(data,'$.pageId') IN (SELECT id FROM sub)`).bind(rootId),
    db.prepare(`${cte} SELECT ${SELECT} FROM records WHERE collection='files' AND json_extract(data,'$.parentId') IN (SELECT id FROM sub)`).bind(rootId),
  ]);
  return { pages: pages.results.map(toRow), blocks: blocks.results.map(toRow), files: files.results.map(toRow) };
}

/** Tasks embedded by `tasks` blocks (blockId), in one read. */
export async function tasksByBlockIds(env: Pick<Env, 'DB'>, blockIds: string[]): Promise<RecRow[]> {
  if (!blockIds.length) return [];
  const { results } = await env.DB
    .prepare(`SELECT ${SELECT} FROM records WHERE collection='tasks' AND json_extract(data,'$.blockId') IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(blockIds))
    .all<RawRow>();
  return results.map(toRow);
}
