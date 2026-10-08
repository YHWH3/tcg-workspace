#!/usr/bin/env node
// Export a workspace template page subtree to the bundled-template JSON format
// (templates/*.json). Reads the LOCAL D1 via `wrangler d1 execute --local`.
// Usage: node scripts/export-template.mjs <rootPageId> [key] [--remote]
//   writes templates/<key>.json  (key defaults to the page id)
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootId = process.argv[2];
const key = process.argv[3] ?? rootId;
const remote = process.argv.includes('--remote');
if (!rootId) {
  console.error('usage: node scripts/export-template.mjs <rootPageId> [key] [--remote]');
  process.exit(1);
}

const PERSIST = ['--persist-to', '.wrangler/state-e2e'];
const q = (sql) => {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', remote ? '--remote' : '--local', ...PERSIST, '--json', '--command', sql], { cwd: join(dirname(fileURLToPath(import.meta.url)), '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(out);
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((r) => r.results ?? []);
};
const esc = (s) => String(s).replace(/'/g, "''");

const rows = (coll) =>
  Object.fromEntries(
    q(`SELECT id, data FROM records WHERE collection = '${coll}'`).map((r) => [r.id, JSON.parse(r.data)]),
  );

// page subtree (BFS)
const pagesAll = rows('pages');
const pages = {};
const queue = [rootId];
while (queue.length) {
  const pid = queue.shift();
  const p = pagesAll[pid];
  if (!p || p.deleted || pages[pid]) continue;
  pages[pid] = p;
  for (const [cid, c] of Object.entries(pagesAll)) if (String(c.parentId ?? '') === pid) queue.push(cid);
}
if (!Object.keys(pages).length) {
  console.error(`page ${rootId} not found (or deleted)`);
  process.exit(1);
}
const pageSet = new Set(Object.keys(pages));

const blocksAll = rows('blocks');
const blocks = Object.fromEntries(Object.entries(blocksAll).filter(([, b]) => !b.deleted && pageSet.has(String(b.pageId ?? ''))));

const boardsAll = rows('boards');
const tasksAll = rows('tasks');
const viewsAll = rows('views');
const linksAll = rows('links');

const boardIds = new Set(Object.values(blocks).filter((b) => b.type === 'tasks' && typeof b.boardId === 'string').map((b) => b.boardId));
const boards = Object.fromEntries(Object.entries(boardsAll).filter(([id, b]) => boardIds.has(id) && !b.deleted));
const tasks = Object.fromEntries(Object.entries(tasksAll).filter(([, t]) => !t.deleted && boardIds.has(String(t.boardId ?? ''))));
const views = Object.fromEntries(Object.entries(viewsAll).filter(([, v]) => !v.deleted && boardIds.has(String(v.databaseId ?? ''))));
const taskIds = new Set(Object.keys(tasks));
const links = Object.fromEntries(
  Object.entries(linksAll).filter(([, l]) => {
    if (l.deleted) return false;
    const inScope = (type, id) => (type === 'record' || type === 'task' ? taskIds.has(String(id)) : type === 'page' ? pageSet.has(String(id)) : false);
    return inScope(l.fromType, l.fromId) && inScope(l.toType, l.toId);
  }),
);

const meta = pages[rootId];
const out = {
  key,
  name: meta.title ?? key,
  description: `Exported from workspace page ${rootId}`,
  icon: meta.icon ?? '📦',
  root: rootId,
  snapshot: { pages, blocks, boards, tasks, views, links },
};
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
mkdirSync(dir, { recursive: true });
const file = join(dir, `${key}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${file} — ${Object.keys(pages).length} pages, ${Object.keys(blocks).length} blocks, ${Object.keys(boards).length} boards, ${Object.keys(tasks).length} tasks, ${Object.keys(views).length} views, ${Object.keys(links).length} links`);
