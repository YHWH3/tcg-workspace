// Targeted snapshot for template instantiation (MCP create_from_template and
// the automation action of the same name).
//
// The planner needs only the template's closure: its page subtree, those
// pages' blocks, the databases the blocks embed or read, those databases'
// records / views, the records' own body blocks, and the links among the
// copied set. Reading whole collections (LIMIT 5000, no ORDER BY) made the
// copy silently partial once any collection outgrew the cap — and cost a full
// workspace scan per call. This loader is bounded by the template, not the
// workspace, and every round is one D1 binding call.

import type { Env } from './auth';
import { boardRefsOf, type RecSnapshot } from '../shared/templates';
import { gateRows } from './readAccess';

interface Row {
  id: string;
  data: string;
}

type Bag = Record<string, Record<string, unknown>>;

const MAX_ROUNDS = 8;

function take(rows: Row[], into: Bag): string[] {
  const fresh: string[] = [];
  for (const row of rows) {
    if (into[row.id]) continue;
    try {
      into[row.id] = JSON.parse(row.data) as Record<string, unknown>;
      fresh.push(row.id);
    } catch {
      /* unparseable row — absent for planning */
    }
  }
  return fresh;
}

/**
 * @param parentId the destination parent of the copy — its existing children
 *   are loaded so the new root is ordered after them (the planner derives the
 *   root's order from its siblings).
 */
export async function loadTemplateSnapshot(env: Pick<Env, 'DB' | 'READ_GATE'>, templateId: string, parentId: string | null = null): Promise<RecSnapshot> {
  const db = env.DB;
  const snap: RecSnapshot = { pages: {}, blocks: {}, boards: {}, tasks: {}, views: {}, links: {} };
  const ids = (list: string[]) => JSON.stringify(list);

  // Page subtree + the destination's existing children, one batch.
  const [subtree, siblings] = await db.batch<Row>([
    db.prepare(`WITH RECURSIVE sub(id) AS (
        SELECT id FROM records WHERE id=? AND collection='pages'
        UNION
        SELECT r.id FROM records r JOIN sub ON json_extract(r.data,'$.parentId')=sub.id WHERE r.collection='pages')
      SELECT id, data FROM records WHERE id IN (SELECT id FROM sub)`).bind(templateId),
    parentId === null
      ? db.prepare(`SELECT id, data FROM records WHERE collection='pages' AND json_extract(data,'$.parentId') IS NULL AND COALESCE(json_extract(data,'$.deleted'),0)=0`)
      : db.prepare(`SELECT id, data FROM records WHERE collection='pages' AND json_extract(data,'$.parentId')=? AND COALESCE(json_extract(data,'$.deleted'),0)=0`).bind(parentId),
  ]);
  const pageIds = take(subtree.results, snap.pages);
  take(siblings.results, snap.pages);
  if (!pageIds.length) return snap;

  // Closure rounds: blocks of known containers → databases they reference →
  // those databases' records and views → the records' body blocks.
  let containers = pageIds;
  const seenBoards = new Set<string>();
  for (let round = 0; round < MAX_ROUNDS && containers.length; round++) {
    const blocks = await db
      .prepare(`SELECT id, data FROM records WHERE collection='blocks' AND json_extract(data,'$.pageId') IN (SELECT value FROM json_each(?))`)
      .bind(ids(containers))
      .all<Row>();
    const fresh = take(blocks.results, snap.blocks);
    const wanted = new Set<string>();
    for (const id of fresh) {
      const block = snap.blocks[id];
      if (block.deleted) continue;
      for (const ref of boardRefsOf(block)) if (!seenBoards.has(ref)) wanted.add(ref);
    }
    if (!wanted.size) break;
    const boardIds = [...wanted];
    for (const id of boardIds) seenBoards.add(id);
    // Records with no boardId belong to the default board.
    const includesDefault = boardIds.includes('board-default');
    const [boards, tasks, views] = await db.batch<Row>([
      db.prepare(`SELECT id, data FROM records WHERE collection='boards' AND id IN (SELECT value FROM json_each(?))`).bind(ids(boardIds)),
      db.prepare(
        `SELECT id, data FROM records WHERE collection='tasks' AND (json_extract(data,'$.boardId') IN (SELECT value FROM json_each(?))${includesDefault ? " OR json_extract(data,'$.boardId') IS NULL" : ''})`,
      ).bind(ids(boardIds)),
      db.prepare(`SELECT id, data FROM records WHERE collection='views' AND json_extract(data,'$.databaseId') IN (SELECT value FROM json_each(?))`).bind(ids(boardIds)),
    ]);
    take(boards.results, snap.boards);
    take(views.results, snap.views!);
    containers = take(tasks.results, snap.tasks);
  }

  // Links whose endpoints are inside the copied set.
  const copied = [...Object.keys(snap.pages), ...Object.keys(snap.tasks)];
  if (copied.length) {
    const links = await db
      .prepare(
        `SELECT id, data FROM records WHERE collection='links' AND (
           json_extract(data,'$.fromId') IN (SELECT value FROM json_each(?)) OR json_extract(data,'$.toId') IN (SELECT value FROM json_each(?)))`,
      )
      .bind(ids(copied), ids(copied))
      .all<Row>();
    take(links.results, snap.links!);
  }
  if (!env.READ_GATE) return snap;
  // A user-visible copy contains only what the caller can read now (an embedded database
  // or relation target in another space is left out, never copied).
  const bags = (Object.values(snap) as (Bag | undefined)[]).filter((bag): bag is Bag => !!bag);
  const kept = new Set((await gateRows(env, bags.flatMap(bag => Object.keys(bag)).map(id => ({ id })))).map(row => row.id));
  for (const bag of bags) for (const id of Object.keys(bag)) if (!kept.has(id)) delete bag[id];
  return snap;
}
