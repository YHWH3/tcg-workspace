import { Hono } from 'hono';
import type { Env } from './auth';
import { ID_RE, concatRows, svgHeaders, type FileRow } from './files';
import {
  allowedCanvasFiles,
  allowedFileIds,
  canServeBoardShare,
  canServeFile,
  canServePage,
  descendantIds,
  expandThumbs,
  publicCanvasItem,
  type PubBlock,
  type PubCanvasCard,
  type PubFileMeta,
  type PubMoodItem,
  type PubPage,
} from './publicAccess';

export const publicApi = new Hono<{ Bindings: Env }>();

const MENTION_RE = /@\[(page|user):([A-Za-z0-9_-]+)\]/g;

interface ShareRow {
  token: string;
  page_id: string;
  target_type: string;
}

interface PageRec extends PubPage {
  title?: string;
  icon?: string;
}

async function shareFor(db: D1Database, token: string, targetType: 'page' | 'moodboard'): Promise<ShareRow | null> {
  return db.prepare('SELECT token, page_id, target_type FROM shares WHERE token = ? AND target_type = ?').bind(token, targetType).first<ShareRow>();
}

/** All pages (id/title/icon/parent/deleted) + the set of ids inside the share tree. */
async function pageTree(db: D1Database, rootId: string): Promise<{ pages: PageRec[]; tree: Set<string> }> {
  const { results } = await db
    .prepare(
      `SELECT id,
              json_extract(data, '$.parentId') AS parentId,
              json_extract(data, '$.title') AS title,
              json_extract(data, '$.icon') AS icon,
              COALESCE(json_extract(data, '$.deleted'), 0) AS deleted
       FROM records WHERE collection = 'pages'`,
    )
    .all<PageRec>();
  return { pages: results, tree: descendantIds(results, rootId) };
}

interface BlockRow {
  id: string;
  pageId: string;
  data: Record<string, unknown>;
}

async function blocksFor(db: D1Database, pageIds: string[]): Promise<BlockRow[]> {
  if (pageIds.length === 0) return [];
  const ph = pageIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT id, json_extract(data, '$.pageId') AS pageId, data FROM records WHERE collection = 'blocks' AND json_extract(data, '$.pageId') IN (${ph})`)
    .bind(...pageIds)
    .all<{ id: string; pageId: string; data: string }>();
  return results.map((r) => {
    const d = JSON.parse(r.data) as Record<string, unknown>;
    return { id: r.id, pageId: r.pageId ?? String(d.pageId ?? ''), data: d };
  });
}

function toPubBlock(b: BlockRow): PubBlock {
  return {
    id: b.id,
    pageId: b.pageId,
    type: String(b.data.type ?? 'p'),
    fileId: (b.data.fileId as string | undefined) ?? null,
    boardId: (b.data.boardId as string | undefined) ?? null,
    deleted: Boolean(b.data.deleted),
  };
}

/** Covers of tasks shown by `tasks` blocks inside the tree. */
async function taskCovers(db: D1Database, boardIds: string[]): Promise<(string | null)[]> {
  if (boardIds.length === 0) return [];
  const ph = boardIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT json_extract(data, '$.coverFileId') AS cover
       FROM records WHERE collection = 'tasks'
         AND COALESCE(json_extract(data, '$.deleted'), 0) = 0
         AND (json_extract(data, '$.boardId') IN (${ph}) OR (json_extract(data, '$.boardId') IS NULL AND 'board-default' IN (${ph})))`,
    )
    .bind(...boardIds, ...boardIds)
    .all<{ cover: string | null }>();
  return results.map((r) => r.cover);
}

/** Compute the set of file ids this share may serve (with thumbs expanded). */
async function allowedFiles(db: D1Database, tree: Set<string>): Promise<{ allowed: Set<string>; files: PubFileMeta[] }> {
  const blocks = (await blocksFor(db, [...tree])).map(toPubBlock);
  const boardIds = [...new Set(blocks.filter((b) => !b.deleted && b.type === 'tasks' && b.boardId).map((b) => String(b.boardId)))];
  const covers = await taskCovers(db, boardIds);
  const base = allowedFileIds(blocks, tree, covers);
  const { results } = await db
    .prepare(`SELECT id, json_extract(data, '$.thumbId') AS thumbId FROM records WHERE collection = 'files'`)
    .all<PubFileMeta>();
  return { allowed: expandThumbs(base, results), files: results };
}

publicApi.get('/:token', async (c) => {
  const share = await shareFor(c.env.DB, c.req.param('token'), 'page');
  if (!share) return c.json({ error: 'inactive' }, 404);
  const { pages, tree } = await pageTree(c.env.DB, share.page_id);
  const root = pages.find((p) => p.id === share.page_id);
  const nodes = pages.filter((p) => tree.has(p.id)).map((p) => ({ id: p.id, title: p.title ?? 'Untitled', icon: p.icon ?? '', parentId: p.parentId ?? null }));
  return c.json({ page: { id: share.page_id, title: root?.title ?? 'Untitled', icon: root?.icon ?? '' }, tree: nodes });
});

publicApi.get('/:token/pages/:pageId', async (c) => {
  const share = await shareFor(c.env.DB, c.req.param('token'), 'page');
  if (!share) return c.json({ error: 'inactive' }, 404);
  const pageId = c.req.param('pageId');
  const { pages, tree } = await pageTree(c.env.DB, share.page_id);
  if (!canServePage(pageId, tree)) return c.json({ error: 'not found' }, 404);
  const page = pages.find((p) => p.id === pageId);

  const blocks = await blocksFor(c.env.DB, [pageId]);
  const live = blocks.filter((b) => !b.data.deleted);
  live.sort((a, b) => String(a.data.order ?? '').localeCompare(String(b.data.order ?? '')));

  // Resolve mentions: page chips link only inside the tree; user → first name.
  const userIds = new Set<string>();
  const pageIds = new Set<string>();
  for (const b of live) {
    const text = String(b.data.text ?? '');
    for (const m of text.matchAll(MENTION_RE)) (m[1] === 'page' ? pageIds : userIds).add(m[2]);
  }
  const { results: userRows } =
    userIds.size > 0
      ? await c.env.DB.prepare(`SELECT id, name FROM users WHERE id IN (${[...userIds].map(() => '?').join(',')})`).bind(...userIds).all<{ id: string; name: string }>()
      : { results: [] as { id: string; name: string }[] };
  const pageTitle = new Map(pages.map((p) => [p.id, String(p.title ?? 'Untitled')]));
  const userName = new Map(userRows.map((u) => [u.id, u.name.split(' ')[0]]));

  const outBlocks = live.map((b) => {
    const data = b.data;
    const mentions: { kind: string; id: string; label: string; inTree: boolean }[] = [];
    for (const m of String(data.text ?? '').matchAll(MENTION_RE)) {
      if (m[1] === 'page') mentions.push({ kind: 'page', id: m[2], label: pageTitle.get(m[2]) ?? 'Untitled', inTree: tree.has(m[2]) });
      else mentions.push({ kind: 'user', id: m[2], label: userName.get(m[2]) ?? 'Someone', inTree: false });
    }
    return {
      id: b.id,
      type: data.type ?? 'p',
      text: data.text ?? '',
      checked: data.checked ?? false,
      fileId: data.fileId ?? null,
      caption: data.caption ?? '',
      boardId: data.boardId ?? null,
      order: data.order ?? '',
      mentions,
    };
  });

  // Files referenced by blocks → whitelisted metadata (no uploader/user data).
  const fileIds = [...new Set(live.map((b) => String(b.data.fileId ?? '')).filter(Boolean))];
  const files: Record<string, unknown> = {};
  if (fileIds.length > 0) {
    const { results } = await c.env.DB
      .prepare(`SELECT id, data FROM records WHERE collection = 'files' AND id IN (${fileIds.map(() => '?').join(',')})`)
      .bind(...fileIds)
      .all<{ id: string; data: string }>();
    for (const r of results) {
      const d = JSON.parse(r.data) as Record<string, unknown>;
      files[r.id] = { id: r.id, name: d.name ?? '', mime: d.mime ?? '', kind: d.kind ?? 'file', size: d.size ?? 0, thumbId: d.thumbId ?? null, width: d.width ?? null, height: d.height ?? null, duration: d.duration ?? null };
    }
  }

  // Tasks blocks → minimal task info, no people.
  const taskBlocks: Record<string, unknown> = {};
  for (const b of live) {
    if (b.data.type !== 'tasks' || !b.data.boardId) continue;
    const boardId = String(b.data.boardId);
    const boardRow = await c.env.DB.prepare(`SELECT data FROM records WHERE collection = 'boards' AND id = ?`).bind(boardId).first<{ data: string }>();
    const cols = boardRow ? ((JSON.parse(boardRow.data).columns ?? []) as { id: string; name: string; color?: string }[]) : [];
    const colName = new Map(cols.map((col) => [col.id, col.name]));
    const { results: tasks } = await c.env.DB
      .prepare(
        `SELECT id, data FROM records WHERE collection = 'tasks'
           AND COALESCE(json_extract(data, '$.deleted'), 0) = 0
           AND (json_extract(data, '$.boardId') = ? OR (json_extract(data, '$.boardId') IS NULL AND ? = 'board-default'))`,
      )
      .bind(boardId, boardId)
      .all<{ id: string; data: string }>();
    taskBlocks[b.id] = tasks.map((t) => {
      const d = JSON.parse(t.data) as Record<string, unknown>;
      const status = String(d.status ?? '');
      return { id: t.id, title: d.title ?? 'Untitled', stage: colName.get(status) ?? status, coverFileId: d.coverFileId ?? null };
    });
  }

  return c.json({
    page: { id: pageId, title: page?.title ?? 'Untitled', icon: page?.icon ?? '' },
    blocks: outBlocks,
    files,
    taskBlocks,
  });
});

publicApi.get('/:token/files/:fileId', async (c) => {
  const share = await shareFor(c.env.DB, c.req.param('token'), 'page');
  if (!share) return c.json({ error: 'inactive' }, 404);
  const fileId = c.req.param('fileId');
  if (!ID_RE.test(fileId)) return c.json({ error: 'invalid file id' }, 400);
  const { tree } = await pageTree(c.env.DB, share.page_id);
  const { allowed, files } = await allowedFiles(c.env.DB, tree);
  if (!canServeFile(fileId, allowed, files)) return c.json({ error: 'not found' }, 404);
  const meta = await c.env.DB.prepare('SELECT mime, complete FROM files WHERE id = ?').bind(fileId).first<FileRow>();
  if (!meta || !meta.complete) return c.json({ error: 'not found' }, 404);
  const { results } = await c.env.DB.prepare('SELECT data FROM file_chunks WHERE file_id = ? ORDER BY idx').bind(fileId).all<{ data: unknown }>();
  const out = concatRows(results);
  return new Response(out, {
    headers: {
      'Content-Type': meta.mime ?? 'application/octet-stream',
      'Content-Length': String(out.byteLength),
      'Cache-Control': 'public, max-age=31536000, immutable',
      ...svgHeaders(meta.mime),
    },
  });
});

/* ---------- Public moodboard (canvas) shares (Phase 2 §6) ---------- */

interface CanvasItemRow extends PubMoodItem {
  data: string;
  rev: number;
}

/** Live mooditems of one board, as parsed records. */
async function canvasItems(db: D1Database, boardId: string): Promise<{ row: CanvasItemRow; data: Record<string, unknown> }[]> {
  const { results } = await db
    .prepare(
      `SELECT id, data, seq AS rev FROM records WHERE collection = 'mooditems'
         AND json_extract(data, '$.boardId') = ? AND COALESCE(json_extract(data, '$.deleted'), 0) = 0`,
    )
    .bind(boardId)
    .all<{ id: string; data: string; rev: number }>();
  return results.map((r) => ({ row: { id: r.id, data: r.data, rev: r.rev }, data: JSON.parse(r.data) as Record<string, unknown> }));
}

/** Minimal {title, stage} for a card ref — never body/custom fields/links. */
async function cardInfo(db: D1Database, ref: { type?: unknown; id?: unknown }, boards: Map<string, Map<string, string>>): Promise<PubCanvasCard> {
  const id = typeof ref?.id === 'string' ? ref.id : '';
  const type = ref?.type === 'page' ? 'pages' : 'tasks';
  if (!id) return { title: null, stage: null };
  const row = await db
    .prepare(`SELECT data FROM records WHERE collection = ? AND id = ? AND COALESCE(json_extract(data, '$.deleted'), 0) = 0`)
    .bind(type, id)
    .first<{ data: string }>();
  if (!row) return { title: null, stage: null };
  const d = JSON.parse(row.data) as Record<string, unknown>;
  const title = typeof d.title === 'string' && d.title ? d.title : 'Untitled';
  let stage: string | null = null;
  if (type === 'tasks') {
    const boardId = typeof d.boardId === 'string' && d.boardId ? d.boardId : 'board-default';
    let cols = boards.get(boardId);
    if (!cols) {
      cols = new Map();
      const b = await db.prepare(`SELECT data FROM records WHERE collection = 'boards' AND id = ?`).bind(boardId).first<{ data: string }>();
      const list = b ? ((JSON.parse(b.data).columns ?? []) as { id: string; name: string }[]) : [];
      for (const col of list) cols.set(col.id, col.name);
      boards.set(boardId, cols);
    }
    const status = typeof d.status === 'string' ? d.status : '';
    stage = cols.get(status) ?? (status || null);
  }
  return { title, stage };
}

publicApi.get('/canvas/:token', async (c) => {
  const share = await shareFor(c.env.DB, c.req.param('token'), 'moodboard');
  if (!share) return c.json({ error: 'inactive' }, 404);
  if (!canServeBoardShare(share, share.page_id)) return c.json({ error: 'inactive' }, 404);
  const board = await c.env.DB
    .prepare(`SELECT data FROM records WHERE collection = 'moodboards' AND id = ? AND COALESCE(json_extract(data, '$.deleted'), 0) = 0`)
    .bind(share.page_id)
    .first<{ data: string }>();
  if (!board) return c.json({ error: 'inactive' }, 404);
  const bd = JSON.parse(board.data) as Record<string, unknown>;

  const items = await canvasItems(c.env.DB, share.page_id);
  const boards = new Map<string, Map<string, string>>();
  const out: Record<string, unknown>[] = [];
  for (const it of items) {
    const data = it.data;
    data.id = it.row.id;
    let card: PubCanvasCard | null = null;
    if (data.type === 'card') card = await cardInfo(c.env.DB, (data.ref as { type?: unknown; id?: unknown }) ?? { type: 'record', id: data.taskId }, boards);
    out.push(publicCanvasItem(data, card));
  }

  const { results: files } = await c.env.DB
    .prepare(`SELECT id, json_extract(data, '$.thumbId') AS thumbId FROM records WHERE collection = 'files'`)
    .all<PubFileMeta>();
  const allowed = allowedCanvasFiles(items.map((i) => i.row).map((r) => ({ id: r.id, ...JSON.parse(r.data) } as PubMoodItem)), share.page_id, files);
  const meta: Record<string, unknown> = {};
  if (allowed.size) {
    const { results } = await c.env.DB
      .prepare(`SELECT id, data FROM records WHERE collection = 'files' AND id IN (${[...allowed].map(() => '?').join(',')})`)
      .bind(...[...allowed])
      .all<{ id: string; data: string }>();
    for (const r of results) {
      const d = JSON.parse(r.data) as Record<string, unknown>;
      meta[r.id] = { id: r.id, name: d.name ?? '', mime: d.mime ?? '', kind: d.kind ?? 'file', size: d.size ?? 0, thumbId: d.thumbId ?? null, width: d.width ?? null, height: d.height ?? null, duration: d.duration ?? null };
    }
  }

  return c.json({ board: { id: share.page_id, name: (bd.title as string) ?? (bd.name as string) ?? 'Moodboard' }, items: out, files: meta });
});

publicApi.get('/canvas/:token/files/:fileId', async (c) => {
  const share = await shareFor(c.env.DB, c.req.param('token'), 'moodboard');
  if (!share) return c.json({ error: 'inactive' }, 404);
  // Same live-board check as the metadata route: a soft-deleted board must
  // take its media down with it (R1).
  if (!canServeBoardShare(share, share.page_id)) return c.json({ error: 'inactive' }, 404);
  const board = await c.env.DB
    .prepare(`SELECT data FROM records WHERE collection = 'moodboards' AND id = ? AND COALESCE(json_extract(data, '$.deleted'), 0) = 0`)
    .bind(share.page_id)
    .first<{ data: string }>();
  if (!board) return c.json({ error: 'inactive' }, 404);
  const fileId = c.req.param('fileId');
  if (!ID_RE.test(fileId)) return c.json({ error: 'invalid file id' }, 400);
  const items = await canvasItems(c.env.DB, share.page_id);
  const { results: files } = await c.env.DB
    .prepare(`SELECT id, json_extract(data, '$.thumbId') AS thumbId FROM records WHERE collection = 'files'`)
    .all<PubFileMeta>();
  const pubItems = items.map((i) => ({ id: i.row.id, ...i.data } as PubMoodItem));
  const allowed = allowedCanvasFiles(pubItems, share.page_id, files);
  if (!canServeFile(fileId, allowed, files)) return c.json({ error: 'not found' }, 404);
  const meta = await c.env.DB.prepare('SELECT mime, complete FROM files WHERE id = ?').bind(fileId).first<FileRow>();
  if (!meta || !meta.complete) return c.json({ error: 'not found' }, 404);
  const { results } = await c.env.DB.prepare('SELECT data FROM file_chunks WHERE file_id = ? ORDER BY idx').bind(fileId).all<{ data: unknown }>();
  const out = concatRows(results);
  return new Response(out, {
    headers: {
      'Content-Type': meta.mime ?? 'application/octet-stream',
      'Content-Length': String(out.byteLength),
      'Cache-Control': 'public, max-age=31536000, immutable',
      ...svgHeaders(meta.mime),
    },
  });
});
