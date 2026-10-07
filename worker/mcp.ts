import { McpServer } from '@modelcontextprotocol/server';
import type { McpRequestContext } from '@modelcontextprotocol/server';
import { createMcpHandler, type StatelessMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import type { Env } from './auth';
import { randomToken } from './password';
import { applyChanges, pokeLive } from './sync';
import { importFileFromUrl, RemoteFileError } from './remotefile';
import { cmpOrder, orderBetween, uuid } from '../shared/order';
import { blocksToMarkdown, markdownToBlocks, renderMentionText, resolveMentionText } from '../shared/markdown';
import { planTemplateInstantiation, type RecSnapshot } from '../shared/templates';
import { coerceFieldValue, fieldsOf, formatFieldValue, isSelectType, optionByName, propKey, type FieldDef } from '../shared/fields';
import { COLUMN_COLORS } from '../src/modules/boards/model';
import type { Collection } from '../shared/collections';

const MAX_WRITE_RECORDS = 500;
const MAX_PAGE_BLOCKS = 200;
const MAX_TASKS_PER_CALL = 100;

/* ---------- record access ---------- */

interface Rec {
  id: string;
  data: Record<string, unknown>;
}

async function recs(env: Env, collection: Collection): Promise<Rec[]> {
  const { results } = await env.DB.prepare('SELECT id, data FROM records WHERE collection = ?').bind(collection).all<{ id: string; data: string }>();
  return results.map((r) => ({ id: r.id, data: JSON.parse(r.data) as Record<string, unknown> }));
}

async function rec(env: Env, collection: Collection, id: string): Promise<Rec | null> {
  const row = await env.DB.prepare('SELECT id, data FROM records WHERE collection = ? AND id = ?').bind(collection, id).first<{ id: string; data: string }>();
  return row ? { id: row.id, data: JSON.parse(row.data) as Record<string, unknown> } : null;
}

const live = (list: Rec[]) => list.filter((r) => !r.data.deleted);
const byOrder = (a: Rec, b: Rec) => cmpOrder(a.data.order, b.data.order);
const titleOf = (r: Rec, fallback: string) => String(r.data.title ?? r.data.name ?? '') || fallback;

/* ---------- write + activity ---------- */

interface WriteOp {
  collection: Collection;
  id: string;
  patch: Record<string, unknown>;
}

async function write(env: Env, ctx: ExecutionContext, userId: string, ops: WriteOp[]): Promise<void> {
  for (let i = 0; i < ops.length; i += MAX_WRITE_RECORDS) {
    const chunk = ops.slice(i, i + MAX_WRITE_RECORDS);
    const r = await applyChanges(
      env,
      userId,
      chunk.map((o) => ({ id: o.id, collection: o.collection, patch: o.patch, ts: 0 })),
      { serverTs: true },
    );
    if (r.conflict) throw new Error('write conflict, retry');
  }
  pokeLive(env, ctx);
}

function activityOp(userId: string, clientName: string | undefined, verb: string, targetType: string, targetId: string, targetTitle: string): WriteOp {
  return {
    collection: 'activity',
    id: uuid(),
    patch: {
      actorId: userId,
      verb,
      targetType,
      targetId,
      targetTitle,
      meta: clientName ? { via: clientName } : null,
      createdAt: Date.now(),
    },
  };
}

/* ---------- lookups ---------- */

interface UserRow {
  id: string;
  username: string;
  name: string;
}

async function users(env: Env): Promise<UserRow[]> {
  const { results } = await env.DB.prepare('SELECT id, username, name FROM users').all<UserRow>();
  return results;
}

/** @handle / display name / id → user id when exactly one user matches. */
async function resolveUser(env: Env, handle: string): Promise<string | undefined> {
  const h = handle.trim().toLowerCase();
  const all = await users(env);
  const matches = all.filter((u) => u.id === handle || u.username.toLowerCase() === h || u.name.toLowerCase() === h);
  return matches.length === 1 ? matches[0].id : undefined;
}

async function mentionResolvers(c: Ctx) {
  await fillCaches(c);
  return {
    resolveUser: (h: string) => c.userByKey.get(h.toLowerCase()),
    resolvePage: (t: string) => c.pageIdByTitle.get(t.trim().toLowerCase()),
    userName: (id: string) => c.userNameById.get(id),
    pageTitle: (id: string) => c.pageTitleById.get(id),
  };
}

/* ---------- shared builders ---------- */

interface Ctx {
  env: Env;
  ectx: ExecutionContext;
  userId: string;
  clientName?: string;
  origin: string;
  /** per-request lookup caches (never module-level — requests interleave) */
  userByKey: Map<string, string>;
  userNameById: Map<string, string>;
  pageTitleById: Map<string, string>;
  pageIdByTitle: Map<string, string>;
  cachesReady: boolean;
}

function pageUrl(c: Ctx, id: string) {
  return `${c.origin}/pages/${id}`;
}
function boardUrl(c: Ctx, id: string) {
  return `${c.origin}/boards/${id}`;
}
function taskUrl(c: Ctx, task: Rec) {
  return `${c.origin}/boards/${String(task.data.boardId ?? 'board-default')}/tasks/${task.id}`;
}
function moodUrl(c: Ctx, id: string) {
  return `${c.origin}/moodboards/${id}`;
}

const txt = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const err = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true });

/** Append blocks parsed from markdown under a page; returns the write ops (not yet applied). */
async function blockOps(c: Ctx, pageId: string, markdown: string, existing: Rec[], afterBlockId?: string): Promise<WriteOp[]> {
  const mdBlocks = markdownToBlocks(markdown, {
    resolveUser: (h) => c.userByKey.get(h.toLowerCase()),
    resolvePage: (t) => c.pageIdByTitle.get(t.trim().toLowerCase()),
  });
  const ordered = existing.filter((b) => !b.data.deleted).sort(byOrder);
  const ops: WriteOp[] = [];
  let prevKey: string | null;
  let nextKey: string | null;
  if (afterBlockId) {
    const idx = ordered.findIndex((b) => b.id === afterBlockId);
    if (idx < 0) throw new Error('insertAfterBlockId not found');
    prevKey = String(ordered[idx].data.order ?? '') || null;
    nextKey = idx + 1 < ordered.length ? String(ordered[idx + 1].data.order ?? '') || null : null;
  } else {
    prevKey = ordered.length ? String(ordered[ordered.length - 1].data.order ?? '') || null : null;
    nextKey = null;
  }
  for (const b of mdBlocks) {
    const key = orderBetween(prevKey, nextKey);
    prevKey = key;
    const patch: Record<string, unknown> = { pageId, order: key, type: b.type, text: b.text ?? '' };
    if (b.type === 'todo') patch.checked = !!b.checked;
    if (b.caption) patch.caption = b.caption;
    if (b.src) patch.src = b.src; // caller resolves to fileId afterwards
    ops.push({ collection: 'blocks', id: uuid(), patch });
  }
  return ops;
}

/** Resolve `src` markers on just-planned image ops into fileIds via remote import. */
async function resolveImageSrcs(c: Ctx, ops: WriteOp[]): Promise<void> {
  for (const op of ops) {
    const src = op.patch.src;
    if (typeof src === 'string' && src.startsWith('http')) {
      try {
        const { fileId } = await importFileFromUrl(c.env, src, { parentType: 'block', parentId: op.id, userId: c.userId });
        op.patch.fileId = fileId;
      } catch {
        // Leave the block without fileId — it renders as a placeholder rather than failing the whole call.
      }
      delete op.patch.src;
    }
  }
}

async function fillCaches(c: Ctx): Promise<void> {
  if (c.cachesReady) return;
  c.cachesReady = true;
  for (const u of await users(c.env)) {
    c.userByKey.set(u.username.toLowerCase(), u.id);
    c.userByKey.set(u.name.toLowerCase(), u.id);
    c.userByKey.set(u.id, u.id);
    c.userNameById.set(u.id, u.name);
  }
  for (const p of live(await recs(c.env, 'pages'))) {
    c.pageTitleById.set(p.id, String(p.data.title ?? 'Untitled'));
    c.pageIdByTitle.set(String(p.data.title ?? 'Untitled').toLowerCase(), p.id);
  }
}

/* ---------- board helpers ---------- */

interface BoardData {
  name?: string;
  icon?: string;
  columns?: { id: string; name: string; color: string }[];
  fields?: FieldDef[];
}

function boardColumns(b: Rec | null): { id: string; name: string; color: string }[] {
  const c = (b?.data as BoardData | undefined)?.columns;
  return Array.isArray(c) && c.length ? c : [];
}

/** status input → column id (match by id or case-insensitive name; unknown → first column). */
function columnIdFor(board: Rec, status: unknown): string {
  const cols = boardColumns(board);
  if (!cols.length) return 'todo';
  if (typeof status === 'string' && status) {
    const byId = cols.find((col) => col.id === status);
    if (byId) return byId.id;
    const lc = status.toLowerCase();
    const byName = cols.find((col) => col.name.toLowerCase() === lc);
    if (byName) return byName.id;
  }
  return cols[0].id;
}

/** Field values keyed by field NAME for readable output. */
function namedFieldValues(board: Rec, task: Rec, userNameById: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fieldsOf(board.data)) {
    const v = task.data[propKey(f.id)];
    const disp = formatFieldValue(f, v, { userName: (id) => userNameById.get(id) });
    if (disp !== undefined) out[f.name] = disp;
  }
  return out;
}

/**
 * Parse a fields input object ({name-or-id: value}) into task prop patches.
 * Unknown select option names are auto-added to the field def — returns the
 * (possibly updated) fields array so the caller can include a board write.
 */
function coerceFieldsInput(fields: FieldDef[], input: Record<string, unknown>): { patch: Record<string, unknown>; fields: FieldDef[] } {
  const patch: Record<string, unknown> = {};
  const nameToField = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  for (const [key, raw] of Object.entries(input)) {
    const field = fields.find((f) => f.id === key) ?? nameToField.get(key.toLowerCase());
    if (!field) continue;
    if (isSelectType(field.type)) {
      // Auto-add unknown option names.
      const names = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      const opts = [...(field.options ?? [])];
      for (const n of names) {
        const exists = optionByName(field, n) || opts.some((o) => o.id === n);
        if (!exists && n.trim()) {
          opts.push({ id: uuid().slice(0, 8), name: n.trim(), color: COLUMN_COLORS[opts.length % COLUMN_COLORS.length] });
        }
      }
      field.options = opts;
      const v = coerceFieldValue(field, raw);
      if (v !== undefined) patch[propKey(field.id)] = v;
      else if (Array.isArray(raw) && raw.length === 0) patch[propKey(field.id)] = [];
      continue;
    }
    const v = coerceFieldValue(field, raw);
    if (v !== undefined) patch[propKey(field.id)] = v;
  }
  return { patch, fields };
}

/* ---------- the server factory ---------- */

const INSTRUCTIONS = `Workspace is a local-first mini-Notion (pages with markdown-ish blocks, task boards with stages and custom fields, mood boards, comments, activity, page templates, public share links).

Data model:
- Pages form a tree; each page holds ordered blocks (paragraph p, headings h1-h3, bullet, numbered, todo, quote, code, divider, image/video/audio/file, tasks embed).
- Boards have named columns (stages) and custom fields (text, number, select, multi_select, person, date, url, checkbox). Tasks live in a board column; custom values are per-field properties.
- Mood boards are spatial canvases with image/note/text/color items.
- Page templates are pages flagged isTemplate; instantiate them with create_from_template, which also copies embedded task boards.
- Mentions: block text accepts [[Page Title]] and @username; stored as tokens and rendered as names.
- For multi-part structures prefer create_project (pages + board + tasks + moodboard in one call). Look up ids first with workspace_overview, search or get_board.
- markdown? arguments accept standard markdown plus [[Page Title]] and @handle mentions and ![caption](url) image imports (https only).`;

export function createWorkspaceServer(ctx: Ctx): McpServer {
  const server = new McpServer(
    { name: 'Workspace', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );

  const fieldInput = z.record(z.string(), z.unknown()).optional().describe('Custom field values keyed by field name or id (select accepts option name).');

  /* ---------- 1-2. search / fetch (ChatGPT connector contract) ---------- */

  server.registerTool(
    'search',
    {
      description: 'Search workspace pages, tasks, boards and mood boards by title and content.',
      inputSchema: z.object({ query: z.string().describe('Free-text search query') }),
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      const q = query.trim().toLowerCase();
      const results: { id: string; title: string; url: string }[] = [];
      const [pages, blocks, tasks, boards, moods] = await Promise.all([
        recs(ctx.env, 'pages'),
        recs(ctx.env, 'blocks'),
        recs(ctx.env, 'tasks'),
        recs(ctx.env, 'boards'),
        recs(ctx.env, 'moodboards'),
      ]);
      const pageHasMatch = new Set<string>();
      for (const b of blocks) if (!b.data.deleted && String(b.data.text ?? '').toLowerCase().includes(q)) pageHasMatch.add(String(b.data.pageId ?? ''));
      for (const p of live(pages)) {
        if (results.length >= 50) break;
        if (String(p.data.title ?? '').toLowerCase().includes(q) || pageHasMatch.has(p.id)) {
          results.push({ id: `page:${p.id}`, title: titleOf(p, 'Untitled'), url: pageUrl(ctx, p.id) });
        }
      }
      for (const t of live(tasks)) {
        if (results.length >= 50) break;
        if (`${t.data.title ?? ''} ${t.data.description ?? ''}`.toLowerCase().includes(q)) results.push({ id: `task:${t.id}`, title: titleOf(t, 'Task'), url: taskUrl(ctx, t) });
      }
      for (const b of live(boards)) {
        if (results.length >= 50) break;
        if (String(b.data.name ?? '').toLowerCase().includes(q)) results.push({ id: `board:${b.id}`, title: titleOf(b, 'Board'), url: boardUrl(ctx, b.id) });
      }
      for (const m of live(moods)) {
        if (results.length >= 50) break;
        if (String(m.data.title ?? '').toLowerCase().includes(q)) results.push({ id: `moodboard:${m.id}`, title: titleOf(m, 'Mood board'), url: moodUrl(ctx, m.id) });
      }
      return txt({ results });
    },
  );

  server.registerTool(
    'fetch',
    {
      description: 'Fetch a workspace item by its id from search (e.g. "page:abc", "task:abc", "board:abc", "moodboard:abc").',
      inputSchema: z.object({ id: z.string().describe('Result id like "page:<id>"') }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const [type, rawId] = id.split(':', 2);
      const resolvers = await mentionResolvers(ctx);
      if (type === 'page') {
        const p = await rec(ctx.env, 'pages', rawId);
        if (!p || p.data.deleted) return err('page not found');
        const blocks = live(await recs(ctx.env, 'blocks')).filter((b) => String(b.data.pageId) === rawId).sort(byOrder);
        return txt({
          id,
          title: titleOf(p, 'Untitled'),
          text: blocksToMarkdown(blocks.map((b) => b.data), resolvers),
          url: pageUrl(ctx, rawId),
          metadata: { type: 'page', parentId: p.data.parentId ?? null, isTemplate: !!p.data.isTemplate },
        });
      }
      if (type === 'task') {
        const t = await rec(ctx.env, 'tasks', rawId);
        if (!t || t.data.deleted) return err('task not found');
        const board = (await rec(ctx.env, 'boards', String(t.data.boardId ?? 'board-default'))) ?? null;
        const status = columnIdFor(board ?? ({ data: {} } as Rec), t.data.status);
        const colName = boardColumns(board).find((c) => c.id === status)?.name ?? status;
        return txt({
          id,
          title: titleOf(t, 'Task'),
          text: `${t.data.description ?? ''}\n\nStatus: ${colName} · Board: ${String(board?.data.name ?? '')}\nPriority: ${t.data.priority ?? 'none'} · Due: ${t.data.dueDate ?? '—'}`.trim(),
          url: taskUrl(ctx, t),
          metadata: { type: 'task', boardId: board?.id ?? null, status },
        });
      }
      if (type === 'board') {
        const b = await rec(ctx.env, 'boards', rawId);
        if (!b || b.data.deleted) return err('board not found');
        const tasks = live(await recs(ctx.env, 'tasks')).filter((t) => String(t.data.boardId ?? 'board-default') === rawId);
        const lines = boardColumns(b).map((col) => `- ${col.name}: ${tasks.filter((t) => columnIdFor(b, t.data.status) === col.id).length} tasks`);
        return txt({ id, title: titleOf(b, 'Board'), text: `Columns:\n${lines.join('\n')}`, url: boardUrl(ctx, rawId), metadata: { type: 'board' } });
      }
      if (type === 'moodboard') {
        const m = await rec(ctx.env, 'moodboards', rawId);
        if (!m || m.data.deleted) return err('mood board not found');
        const items = live(await recs(ctx.env, 'mooditems')).filter((i) => String(i.data.boardId) === rawId);
        const lines = items.map((i) => `- ${i.data.type}: ${i.data.text ?? i.data.color ?? i.data.fileId ?? ''}`);
        return txt({ id, title: titleOf(m, 'Mood board'), text: `Items:\n${lines.join('\n')}`, url: moodUrl(ctx, rawId), metadata: { type: 'moodboard' } });
      }
      return err('unknown id — use page:, task:, board: or moodboard: prefixes');
    },
  );

  /* ---------- 3. workspace_overview ---------- */

  server.registerTool(
    'workspace_overview',
    {
      description: 'List people, the page tree (with templates), boards (columns + fields) and mood boards. Use this to look up ids before other tools.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [us, pages, boards, moods, items] = await Promise.all([
        users(ctx.env),
        recs(ctx.env, 'pages'),
        recs(ctx.env, 'boards'),
        recs(ctx.env, 'moodboards'),
        recs(ctx.env, 'mooditems'),
      ]);
      return txt({
        people: us.map((u) => ({ id: u.id, username: u.username, name: u.name })),
        pages: live(pages)
          .sort(byOrder)
          .map((p) => ({ id: p.id, title: titleOf(p, 'Untitled'), icon: p.data.icon, parentId: p.data.parentId ?? null, isTemplate: !!p.data.isTemplate })),
        boards: live(boards).map((b) => ({
          id: b.id,
          name: b.data.name,
          columns: boardColumns(b).map((c) => ({ id: c.id, name: c.name })),
          fields: fieldsOf(b.data).map((f) => ({ id: f.id, name: f.name, type: f.type, options: f.options?.map((o) => o.name) })),
        })),
        moodboards: live(moods).map((m) => ({ id: m.id, title: m.data.title, itemCount: live(items).filter((i) => String(i.data.boardId) === m.id).length })),
      });
    },
  );

  /* ---------- 4. get_page ---------- */

  server.registerTool(
    'get_page',
    {
      description: 'Read a page: markdown body, raw blocks, child pages and pages that link here (backlinks).',
      inputSchema: z.object({ pageId: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ pageId }) => {
      const p = await rec(ctx.env, 'pages', pageId);
      if (!p || p.data.deleted) return err('page not found');
      const resolvers = await mentionResolvers(ctx);
      const [allBlocks, allPages] = await Promise.all([recs(ctx.env, 'blocks'), recs(ctx.env, 'pages')]);
      const blocks = live(allBlocks).filter((b) => String(b.data.pageId) === pageId).sort(byOrder);
      const children = live(allPages).filter((x) => String(x.data.parentId) === pageId).sort(byOrder);
      const token = `@[page:${pageId}]`;
      const pageName = new Map(live(allPages).map((x) => [x.id, String(x.data.title ?? 'Untitled')]));
      const backlinks = live(allBlocks)
        .filter((b) => b.data.pageId !== pageId && String(b.data.text ?? '').includes(token))
        .slice(0, 20)
        .map((b) => ({
          pageId: b.data.pageId,
          title: pageName.get(String(b.data.pageId)) ?? 'Untitled',
          snippet: renderMentionText(String(b.data.text ?? ''), resolvers).slice(0, 140),
        }));
      return txt({
        page: { id: p.id, title: titleOf(p, 'Untitled'), icon: p.data.icon, parentId: p.data.parentId ?? null, isTemplate: !!p.data.isTemplate },
        markdown: blocksToMarkdown(blocks.map((b) => b.data), resolvers),
        blocks: blocks.map((b) => ({ id: b.id, type: b.data.type ?? 'p', text: b.data.text ?? '' })),
        children: children.map((x) => ({ id: x.id, title: titleOf(x, 'Untitled'), icon: x.data.icon })),
        backlinks,
        url: pageUrl(ctx, pageId),
      });
    },
  );

  /* ---------- 5. create_page ---------- */

  interface ChildNode {
    title: string;
    icon?: string;
    markdown?: string;
    children?: ChildNode[];
  }
  const childPageSchema: z.ZodType<ChildNode> = z.lazy(() =>
    z.object({
      title: z.string(),
      icon: z.string().optional(),
      markdown: z.string().optional(),
      children: z.array(childPageSchema).optional(),
    }),
  ) as z.ZodType<ChildNode>;

  server.registerTool(
    'create_page',
    {
      description: 'Create a page (optionally nested under a parent) from markdown. `children` recursively creates sub-pages. Max ~200 blocks total.',
      inputSchema: z.object({
        title: z.string(),
        icon: z.string().optional(),
        parentId: z.string().optional().describe('Parent page id for a sub-page'),
        markdown: z.string().optional(),
        children: z.array(childPageSchema).optional(),
      }),
      annotations: { idempotentHint: false },
    },
    async (args) => {
      await fillCaches(ctx);
      const ops: WriteOp[] = [];
      let blockCount = 0;
      const allPages = live(await recs(ctx.env, 'pages'));
      const allBlocks = live(await recs(ctx.env, 'blocks'));

      const build = async (node: ChildNode, parentId: string | null): Promise<string> => {
        const id = uuid();
        const sibs = allPages.filter((p) => (p.data.parentId ?? null) === parentId).sort(byOrder);
        const order = orderBetween(sibs.length ? String(sibs[sibs.length - 1].data.order ?? '') || null : null, null);
        allPages.push({ id, data: { parentId, order } });
        ops.push({
          collection: 'pages',
          id,
          patch: { title: node.title, icon: node.icon ?? '📄', parentId, order, isTemplate: false, createdBy: ctx.userId, createdAt: Date.now() },
        });
        if (node.markdown) {
          blockCount += markdownToBlocks(node.markdown).length;
          if (blockCount > MAX_PAGE_BLOCKS) throw new Error(`too many blocks (max ${MAX_PAGE_BLOCKS})`);
          ops.push(...(await blockOps(ctx, id, node.markdown, allBlocks.filter((b) => String(b.data.pageId) === id))));
        }
        for (const child of (node.children ?? []) as ChildNode[]) await build(child, id);
        return id;
      };
      const id = await build(args as ChildNode, args.parentId ?? null);
      await resolveImageSrcs(ctx, ops);
      await write(ctx.env, ctx.ectx, ctx.userId, [...ops, activityOp(ctx.userId, ctx.clientName, 'created', 'page', id, args.title)]);
      return txt({ id, url: pageUrl(ctx, id) });
    },
  );

  /* ---------- 6. edit_page ---------- */

  server.registerTool(
    'edit_page',
    {
      description: 'Edit a page: rename/retitle/icon/parent/template flag, append markdown, insert after a block, replace or delete blocks.',
      inputSchema: z.object({
        pageId: z.string(),
        title: z.string().optional(),
        icon: z.string().optional(),
        parentId: z.string().nullable().optional(),
        isTemplate: z.boolean().optional(),
        appendMarkdown: z.string().optional().describe('Append markdown blocks at the end'),
        insertAfterBlockId: z.string().optional().describe('Insert `markdown` after this block id'),
        markdown: z.string().optional().describe('Used with insertAfterBlockId'),
        replaceBlocks: z.array(z.object({ blockId: z.string(), markdown: z.string() })).optional().describe('Replace each block\'s text with the parsed markdown line'),
        deleteBlockIds: z.array(z.string()).optional(),
      }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const p = await rec(ctx.env, 'pages', a.pageId);
      if (!p || p.data.deleted) return err('page not found');
      await fillCaches(ctx);
      const ops: WriteOp[] = [];
      const pagePatch: Record<string, unknown> = {};
      if (a.title !== undefined) pagePatch.title = a.title;
      if (a.icon !== undefined) pagePatch.icon = a.icon;
      if (a.parentId !== undefined) pagePatch.parentId = a.parentId;
      if (a.isTemplate !== undefined) pagePatch.isTemplate = a.isTemplate;
      if (Object.keys(pagePatch).length) ops.push({ collection: 'pages', id: a.pageId, patch: pagePatch });

      const existing = live(await recs(ctx.env, 'blocks')).filter((b) => String(b.data.pageId) === a.pageId);
      if (a.appendMarkdown) ops.push(...(await blockOps(ctx, a.pageId, a.appendMarkdown, existing)));
      if (a.insertAfterBlockId) {
        if (!a.markdown) return err('insertAfterBlockId requires markdown');
        ops.push(...(await blockOps(ctx, a.pageId, a.markdown, existing, a.insertAfterBlockId)));
      }
      for (const r of a.replaceBlocks ?? []) {
        const src = existing.find((b) => b.id === r.blockId);
        if (!src) return err(`block ${r.blockId} not found`);
        const parsed = markdownToBlocks(r.markdown, {
          resolveUser: (h) => ctx.userByKey.get(h.toLowerCase()),
          resolvePage: (t) => ctx.pageIdByTitle.get(t.trim().toLowerCase()),
        });
        const first = parsed[0];
        if (!first) continue;
        ops.push({ collection: 'blocks', id: r.blockId, patch: { type: first.type, text: first.text ?? '', ...(first.type === 'todo' ? { checked: !!first.checked } : {}) } });
      }
      for (const id of a.deleteBlockIds ?? []) ops.push({ collection: 'blocks', id, patch: { deleted: true } });
      await resolveImageSrcs(ctx, ops);
      await write(ctx.env, ctx.ectx, ctx.userId, ops);
      return txt({ id: a.pageId, url: pageUrl(ctx, a.pageId), updated: ops.length });
    },
  );

  /* ---------- 7-10. boards & tasks ---------- */

  server.registerTool(
    'get_board',
    {
      description: 'Read a board: columns, custom fields and tasks (optionally filtered by stage name/id or assignee name/username/id). Field values are keyed by field name.',
      inputSchema: z.object({ boardId: z.string(), status: z.string().optional(), assignee: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ boardId, status, assignee }) => {
      const board = await rec(ctx.env, 'boards', boardId);
      if (!board || board.data.deleted) return err('board not found');
      await fillCaches(ctx);
      const assigneeId = assignee ? (await resolveUser(ctx.env, assignee)) ?? assignee : undefined;
      let tasks = live(await recs(ctx.env, 'tasks')).filter((t) => String(t.data.boardId ?? 'board-default') === boardId);
      if (status) {
        const cols = boardColumns(board);
        const col = cols.find((c) => c.id === status || c.name.toLowerCase() === status.toLowerCase());
        tasks = tasks.filter((t) => columnIdFor(board, t.data.status) === (col?.id ?? status));
      }
      if (assigneeId) tasks = tasks.filter((t) => String(t.data.assigneeId ?? '') === assigneeId);
      return txt({
        board: { id: board.id, name: board.data.name, icon: board.data.icon },
        columns: boardColumns(board),
        fields: fieldsOf(board.data),
        tasks: tasks.sort(byOrder).map((t) => ({
          id: t.id,
          title: t.data.title,
          description: t.data.description,
          status: t.data.status,
          statusName: boardColumns(board).find((c) => c.id === columnIdFor(board, t.data.status))?.name,
          assignee: ctx.userNameById.get(String(t.data.assigneeId ?? '')) ?? null,
          priority: t.data.priority,
          dueDate: t.data.dueDate ?? null,
          fields: namedFieldValues(board, t, ctx.userNameById),
          url: taskUrl(ctx, t),
        })),
      });
    },
  );

  server.registerTool(
    'create_board',
    {
      description: 'Create a task board with stages (columns) and optional custom fields. The last column is the "done" stage.',
      inputSchema: z.object({
        name: z.string(),
        icon: z.string().optional(),
        columns: z.array(z.object({ name: z.string(), color: z.string().optional() })).min(1),
        fields: z
          .array(
            z.object({
              name: z.string(),
              type: z.enum(['text', 'number', 'select', 'multi_select', 'person', 'date', 'url', 'checkbox']),
              options: z.array(z.union([z.string(), z.object({ name: z.string(), color: z.string().optional() })])).optional(),
              showOnCard: z.boolean().optional(),
            }),
          )
          .optional(),
      }),
      annotations: { idempotentHint: false },
    },
    async ({ name, icon, columns, fields }) => {
      const boardId = uuid();
      const boards = live(await recs(ctx.env, 'boards')).sort(byOrder);
      const order = orderBetween(boards.length ? String(boards[boards.length - 1].data.order ?? '') || null : null, null);
      const fieldDefs: FieldDef[] = (fields ?? []).map((f) => ({
        id: uuid().slice(0, 8),
        name: f.name,
        type: f.type,
        showOnCard: f.showOnCard,
        options: isSelectType(f.type)
          ? (f.options ?? []).map((o, j) => (typeof o === 'string' ? { id: uuid().slice(0, 8), name: o, color: COLUMN_COLORS[j % COLUMN_COLORS.length] } : { id: uuid().slice(0, 8), name: o.name, color: o.color ?? COLUMN_COLORS[j % COLUMN_COLORS.length] }))
          : undefined,
      }));
      await write(ctx.env, ctx.ectx, ctx.userId, [
        {
          collection: 'boards',
          id: boardId,
          patch: {
            name,
            icon: icon ?? '🗂️',
            columns: columns.map((c, i) => ({ id: uuid().slice(0, 8), name: c.name, color: c.color ?? COLUMN_COLORS[i % COLUMN_COLORS.length] })),
            fields: fieldDefs,
            order,
            createdBy: ctx.userId,
            createdAt: Date.now(),
          },
        },
        activityOp(ctx.userId, ctx.clientName, 'created', 'board', boardId, name),
      ]);
      return txt({ id: boardId, url: boardUrl(ctx, boardId), columns: columns.map((c) => c.name) });
    },
  );

  server.registerTool(
    'update_board',
    {
      description: 'Rename/re-icon a board, replace columns, or add/update/remove custom fields. Tasks in removed columns move to the first column.',
      inputSchema: z.object({
        boardId: z.string(),
        name: z.string().optional(),
        icon: z.string().optional(),
        columns: z.array(z.object({ id: z.string().optional(), name: z.string(), color: z.string().optional() })).optional().describe('Full column list; rows without id are new columns. Columns not listed are removed.'),
        addFields: z.array(z.object({ name: z.string(), type: z.enum(['text', 'number', 'select', 'multi_select', 'person', 'date', 'url', 'checkbox']), options: z.array(z.union([z.string(), z.object({ name: z.string(), color: z.string().optional() })])).optional(), showOnCard: z.boolean().optional() })).optional(),
        updateFields: z.array(z.object({ field: z.string().describe('Field id or name'), name: z.string().optional(), options: z.array(z.union([z.string(), z.object({ name: z.string(), color: z.string().optional() })])).optional(), showOnCard: z.boolean().optional() })).optional(),
        removeFields: z.array(z.string()).optional().describe('Field ids or names to remove'),
      }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const board = await rec(ctx.env, 'boards', a.boardId);
      if (!board || board.data.deleted) return err('board not found');
      const ops: WriteOp[] = [];
      const patch: Record<string, unknown> = {};
      if (a.name !== undefined) patch.name = a.name;
      if (a.icon !== undefined) patch.icon = a.icon;
      let newCols: { id: string; name: string; color: string }[] | undefined;
      if (a.columns) {
        const old = boardColumns(board);
        newCols = a.columns.map((c, i) => ({ id: c.id ?? old.find((o) => o.name.toLowerCase() === c.name.toLowerCase())?.id ?? uuid().slice(0, 8), name: c.name, color: c.color ?? old.find((o) => o.id === c.id)?.color ?? COLUMN_COLORS[i % COLUMN_COLORS.length] }));
        patch.columns = newCols;
      }
      const fields = fieldsOf(board.data).map((f) => ({ ...f, options: f.options ? [...f.options] : undefined }));
      const findField = (key: string) => fields.find((f) => f.id === key || f.name.toLowerCase() === key.toLowerCase());
      for (const rf of a.removeFields ?? []) {
        const f = findField(rf);
        if (f) fields.splice(fields.indexOf(f), 1);
      }
      for (const af of a.addFields ?? []) {
        fields.push({
          id: uuid().slice(0, 8),
          name: af.name,
          type: af.type,
          showOnCard: af.showOnCard,
          options: isSelectType(af.type) ? (af.options ?? []).map((o, j) => (typeof o === 'string' ? { id: uuid().slice(0, 8), name: o, color: COLUMN_COLORS[j % COLUMN_COLORS.length] } : { id: uuid().slice(0, 8), name: o.name, color: o.color ?? COLUMN_COLORS[j % COLUMN_COLORS.length] })) : undefined,
        });
      }
      for (const uf of a.updateFields ?? []) {
        const f = findField(uf.field);
        if (!f) return err(`field ${uf.field} not found`);
        if (uf.name) f.name = uf.name;
        if (uf.showOnCard !== undefined) f.showOnCard = uf.showOnCard;
        if (uf.options && isSelectType(f.type)) f.options = uf.options.map((o, j) => (typeof o === 'string' ? { id: f.options?.[j]?.id ?? uuid().slice(0, 8), name: o, color: f.options?.[j]?.color ?? COLUMN_COLORS[j % COLUMN_COLORS.length] } : { id: uuid().slice(0, 8), name: o.name, color: o.color ?? COLUMN_COLORS[j % COLUMN_COLORS.length] }));
      }
      if (a.addFields || a.updateFields || a.removeFields) patch.fields = fields;
      if (Object.keys(patch).length) ops.push({ collection: 'boards', id: a.boardId, patch });
      // Move tasks out of removed columns.
      if (newCols) {
        const valid = new Set(newCols.map((c) => c.id));
        const first = newCols[0]?.id ?? 'todo';
        const tasks = live(await recs(ctx.env, 'tasks')).filter((t) => String(t.data.boardId ?? 'board-default') === a.boardId && !valid.has(String(t.data.status ?? '')));
        for (const t of tasks) ops.push({ collection: 'tasks', id: t.id, patch: { status: first } });
      }
      await write(ctx.env, ctx.ectx, ctx.userId, ops);
      return txt({ id: a.boardId, url: boardUrl(ctx, a.boardId), updated: ops.length });
    },
  );

  const taskInput = z.object({
    title: z.string(),
    description: z.string().optional(),
    status: z.string().optional().describe('Column name or id (unknown → first column)'),
    assignee: z.string().optional().describe('Username, display name or user id'),
    due: z.string().optional().describe('ISO date yyyy-mm-dd'),
    priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']).optional(),
    coverImageUrl: z.string().optional().describe('https image URL to import as the card cover'),
    fields: fieldInput,
  });

  server.registerTool(
    'create_tasks',
    {
      description: `Create up to ${MAX_TASKS_PER_CALL} tasks on a board. Select field values accept option names; unknown option names are added to the field.`,
      inputSchema: z.object({ boardId: z.string(), tasks: z.array(taskInput).min(1).max(MAX_TASKS_PER_CALL) }),
      annotations: { idempotentHint: false },
    },
    async ({ boardId, tasks }) => {
      const board = await rec(ctx.env, 'boards', boardId);
      if (!board || board.data.deleted) return err('board not found');
      await fillCaches(ctx);
      const allTasks = live(await recs(ctx.env, 'tasks')).filter((t) => String(t.data.boardId ?? 'board-default') === boardId);
      const ops: WriteOp[] = [];
      const created: { id: string; title: string }[] = [];
      let fieldsMutated = false;
      let fields: FieldDef[] = fieldsOf(board.data).map((f) => ({ ...f, options: f.options ? [...f.options] : undefined }));
      const boardProxy = { data: { ...board.data, fields } };
      for (const t of tasks) {
        const id = uuid();
        const status = columnIdFor(board, t.status);
        const inCol = allTasks.filter((x) => columnIdFor(board, x.data.status) === status).sort(byOrder);
        const order = orderBetween(inCol.length ? String(inCol[inCol.length - 1].data.order ?? '') || null : null, null);
        const fieldPatch: { patch: Record<string, unknown>; fields: FieldDef[] } = t.fields ? coerceFieldsInput(fields, t.fields) : { patch: {}, fields };
        if (t.fields) {
          fields = fieldPatch.fields;
          fieldsMutated = fieldsMutated || JSON.stringify(fields) !== JSON.stringify(fieldsOf(board.data));
          boardProxy.data = { ...boardProxy.data, fields };
        }
        const patch: Record<string, unknown> = {
          title: t.title,
          description: t.description ?? '',
          boardId,
          status,
          priority: t.priority ?? 'none',
          assigneeId: t.assignee ? ((await resolveUser(ctx.env, t.assignee)) ?? null) : null,
          dueDate: t.due ?? null,
          pageId: null,
          order,
          createdBy: ctx.userId,
          createdAt: Date.now(),
          ...fieldPatch.patch,
        };
        ops.push({ collection: 'tasks', id, patch });
        if (t.coverImageUrl) {
          try {
            const { fileId } = await importFileFromUrl(ctx.env, t.coverImageUrl, { parentType: 'task', parentId: id, userId: ctx.userId });
            patch.coverFileId = fileId;
          } catch (e) {
            if (e instanceof RemoteFileError) return err(`coverImageUrl for "${t.title}": ${e.message}`);
            throw e;
          }
        }
        allTasks.push({ id, data: { boardId, status, order } });
        created.push({ id, title: t.title });
      }
      if (fieldsMutated) ops.unshift({ collection: 'boards', id: boardId, patch: { fields } });
      await write(ctx.env, ctx.ectx, ctx.userId, [...ops, ...created.map((x) => activityOp(ctx.userId, ctx.clientName, 'created', 'task', x.id, x.title))]);
      return txt({ boardId, created, url: boardUrl(ctx, boardId) });
    },
  );

  server.registerTool(
    'update_tasks',
    {
      description: 'Update tasks: title, description, stage, assignee, due, priority, move to another board (lands in its first column), custom field values.',
      inputSchema: z.object({
        updates: z.array(taskInput.partial().extend({ taskId: z.string(), boardId: z.string().optional().describe('Move to this board') })).min(1).max(100),
      }),
      annotations: { idempotentHint: true },
    },
    async ({ updates }) => {
      await fillCaches(ctx);
      const ops: WriteOp[] = [];
      const boardsMutated = new Map<string, FieldDef[]>();
      for (const u of updates) {
        const task = await rec(ctx.env, 'tasks', u.taskId);
        if (!task || task.data.deleted) return err(`task ${u.taskId} not found`);
        const targetBoardId = u.boardId ?? String(task.data.boardId ?? 'board-default');
        const board = (await rec(ctx.env, 'boards', targetBoardId)) ?? ({ data: {} } as Rec);
        const patch: Record<string, unknown> = {};
        if (u.title !== undefined) patch.title = u.title;
        if (u.description !== undefined) patch.description = u.description;
        if (u.status !== undefined || u.boardId !== undefined) patch.status = columnIdFor(board, u.status);
        if (u.boardId !== undefined) patch.boardId = u.boardId;
        if (u.priority !== undefined) patch.priority = u.priority;
        if (u.due !== undefined) patch.dueDate = u.due;
        if (u.assignee !== undefined) patch.assigneeId = (await resolveUser(ctx.env, u.assignee)) ?? null;
        if (u.coverImageUrl !== undefined) {
          const { fileId } = await importFileFromUrl(ctx.env, u.coverImageUrl, { parentType: 'task', parentId: u.taskId, userId: ctx.userId });
          patch.coverFileId = fileId;
        }
        if (u.fields) {
          const cur = boardsMutated.get(targetBoardId) ?? fieldsOf(board.data).map((f) => ({ ...f, options: f.options ? [...f.options] : undefined }));
          const r = coerceFieldsInput(cur, u.fields);
          boardsMutated.set(targetBoardId, r.fields);
          Object.assign(patch, r.patch);
        }
        ops.push({ collection: 'tasks', id: u.taskId, patch });
      }
      for (const [bid, fields] of boardsMutated) ops.push({ collection: 'boards', id: bid, patch: { fields } });
      await write(ctx.env, ctx.ectx, ctx.userId, ops);
      return txt({ updated: updates.length });
    },
  );

  server.registerTool(
    'get_task',
    {
      description: 'Read a task with its comments, attachments and custom field values.',
      inputSchema: z.object({ taskId: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ taskId }) => {
      const t = await rec(ctx.env, 'tasks', taskId);
      if (!t || t.data.deleted) return err('task not found');
      await fillCaches(ctx);
      const board = await rec(ctx.env, 'boards', String(t.data.boardId ?? 'board-default'));
      const [comments, filesRecs] = await Promise.all([recs(ctx.env, 'comments'), recs(ctx.env, 'files')]);
      const thread = live(comments)
        .filter((c) => c.data.targetType === 'task' && c.data.targetId === taskId)
        .sort((a, b) => Number(a.data.createdAt ?? 0) - Number(b.data.createdAt ?? 0));
      const attachments = live(filesRecs).filter((f) => f.data.parentType === 'task' && f.data.parentId === taskId);
      return txt({
        id: t.id,
        title: t.data.title,
        description: t.data.description,
        board: board?.data.name,
        status: t.data.status,
        statusName: board ? boardColumns(board).find((c) => c.id === columnIdFor(board, t.data.status))?.name : undefined,
        assignee: ctx.userNameById.get(String(t.data.assigneeId ?? '')) ?? null,
        priority: t.data.priority,
        dueDate: t.data.dueDate ?? null,
        fields: board ? namedFieldValues(board, t, ctx.userNameById) : {},
        comments: thread.map((c) => ({ id: c.id, author: ctx.userNameById.get(String(c.data.authorId ?? '')), body: c.data.body, createdAt: c.data.createdAt })),
        attachments: attachments.map((f) => ({ id: f.id, name: f.data.name, mime: f.data.mime, kind: f.data.kind })),
        url: taskUrl(ctx, t),
      });
    },
  );

  /* ---------- 12. mood boards ---------- */

  const moodItemInput = z.object({
    type: z.enum(['note', 'text', 'color', 'image']),
    text: z.string().optional(),
    color: z.string().optional(),
    imageUrl: z.string().optional().describe('https URL — imported into workspace files'),
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().optional(),
    h: z.number().optional(),
  });

  const MOOD_SIZES: Record<string, [number, number]> = { image: [320, 213], note: [220, 160], text: [400, 60], color: [120, 80] };

  async function moodItemOps(moodboardId: string, items: z.infer<typeof moodItemInput>[], existing: Rec[]): Promise<WriteOp[]> {
    const ops: WriteOp[] = [];
    let z0 = Math.max(0, ...existing.map((i) => Number(i.data.z ?? 0)));
    // Auto-layout: tidy 3-per-row grid to the right of (or below) existing items.
    const originX = existing.length ? Math.max(...existing.map((i) => Number(i.data.x ?? 0) + Number(i.data.w ?? 0))) + 40 : 0;
    const originY = existing.length ? Math.min(...existing.map((i) => Number(i.data.y ?? 0))) : 0;
    let col = 0;
    let rowY = originY;
    let rowH = 0;
    for (const item of items) {
      const [dw, dh] = MOOD_SIZES[item.type] ?? [220, 160];
      const w = item.w ?? dw;
      const h = item.h ?? dh;
      const auto = item.x === undefined || item.y === undefined;
      const x = auto ? originX + col * 344 : item.x!;
      const y = auto ? rowY : item.y!;
      if (auto) {
        rowH = Math.max(rowH, h);
        col++;
        if (col === 3) {
          col = 0;
          rowY += rowH + 24;
          rowH = 0;
        }
      }
      const id = uuid();
      const patch: Record<string, unknown> = { boardId: moodboardId, type: item.type, x, y, w, h, z: ++z0 };
      if (item.text !== undefined) patch.text = item.text;
      if (item.color !== undefined) patch.color = item.color;
      if (item.type === 'image' && item.imageUrl) {
        const { fileId } = await importFileFromUrl(ctx.env, item.imageUrl, { parentType: 'mooditem', parentId: id, userId: ctx.userId });
        patch.fileId = fileId;
      }
      ops.push({ collection: 'mooditems', id, patch });
    }
    return ops;
  }

  server.registerTool(
    'create_moodboard',
    {
      description: 'Create a mood board, optionally with initial items (notes, text, color swatches, images from https URLs). Items without x/y auto-lay-out in a tidy grid.',
      inputSchema: z.object({ title: z.string(), items: z.array(moodItemInput).optional() }),
      annotations: { idempotentHint: false },
    },
    async ({ title, items }) => {
      const id = uuid();
      const ops: WriteOp[] = [
        { collection: 'moodboards', id, patch: { title, icon: '🎨', order: String(Date.now()), createdBy: ctx.userId, createdAt: Date.now() } },
      ];
      if (items?.length) ops.push(...(await moodItemOps(id, items, [])));
      await write(ctx.env, ctx.ectx, ctx.userId, [...ops, activityOp(ctx.userId, ctx.clientName, 'created', 'mooditem', id, title)]);
      return txt({ id, url: moodUrl(ctx, id) });
    },
  );

  server.registerTool(
    'add_mood_items',
    {
      description: 'Add items to a mood board. Items without x/y are placed in a tidy grid after existing items.',
      inputSchema: z.object({ moodboardId: z.string(), items: z.array(moodItemInput).min(1) }),
      annotations: { idempotentHint: false },
    },
    async ({ moodboardId, items }) => {
      const mb = await rec(ctx.env, 'moodboards', moodboardId);
      if (!mb || mb.data.deleted) return err('mood board not found');
      const existing = live(await recs(ctx.env, 'mooditems')).filter((i) => String(i.data.boardId) === moodboardId);
      const ops = await moodItemOps(moodboardId, items, existing);
      await write(ctx.env, ctx.ectx, ctx.userId, ops);
      return txt({ moodboardId, added: ops.length, url: moodUrl(ctx, moodboardId) });
    },
  );

  /* ---------- 13. comments ---------- */

  server.registerTool(
    'add_comment',
    {
      description: 'Add a comment to a task, page, block or mood item. @handle mentions are resolved.',
      inputSchema: z.object({ targetType: z.enum(['task', 'page', 'block', 'mooditem']), targetId: z.string(), text: z.string() }),
      annotations: { idempotentHint: false },
    },
    async ({ targetType, targetId, text }) => {
      await fillCaches(ctx);
      const body = resolveMentionText(text, { resolveUser: (h) => ctx.userByKey.get(h.toLowerCase()) });
      const id = uuid();
      await write(ctx.env, ctx.ectx, ctx.userId, [
        { collection: 'comments', id, patch: { targetType, targetId, body, authorId: ctx.userId, createdAt: Date.now() } },
        activityOp(ctx.userId, ctx.clientName, 'commented', targetType, targetId, 'comment'),
      ]);
      return txt({ id });
    },
  );

  server.registerTool(
    'list_comments',
    {
      description: 'List comments on a task, page, block or mood item.',
      inputSchema: z.object({ targetType: z.enum(['task', 'page', 'block', 'mooditem']), targetId: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ targetType, targetId }) => {
      await fillCaches(ctx);
      const all = live(await recs(ctx.env, 'comments')).filter((c) => c.data.targetType === targetType && c.data.targetId === targetId);
      all.sort((a, b) => Number(a.data.createdAt ?? 0) - Number(b.data.createdAt ?? 0));
      return txt({
        comments: all.map((c) => ({ id: c.id, author: ctx.userNameById.get(String(c.data.authorId ?? '')), body: renderMentionText(String(c.data.body ?? ''), { userName: (id) => ctx.userNameById.get(id) }), createdAt: c.data.createdAt })),
      });
    },
  );

  /* ---------- 14. publish_page ---------- */

  server.registerTool(
    'publish_page',
    {
      description: 'Publish or unpublish a page (and its sub-pages) as a read-only public link.',
      inputSchema: z.object({ pageId: z.string(), enabled: z.boolean() }),
      annotations: { idempotentHint: true },
    },
    async ({ pageId, enabled }) => {
      const p = await rec(ctx.env, 'pages', pageId);
      if (!p || p.data.deleted) return err('page not found');
      if (!enabled) {
        await ctx.env.DB.prepare('DELETE FROM shares WHERE page_id = ?').bind(pageId).run();
        return txt({ enabled: false });
      }
      const existing = await ctx.env.DB.prepare('SELECT token FROM shares WHERE page_id = ?').bind(pageId).first<{ token: string }>();
      const token = existing?.token ?? randomToken();
      if (!existing) await ctx.env.DB.prepare('INSERT INTO shares (token, page_id, created_by, created_at) VALUES (?, ?, ?, ?)').bind(token, pageId, ctx.userId, Date.now()).run();
      return txt({ enabled: true, token, url: `${ctx.origin}/s/${token}` });
    },
  );

  /* ---------- 15. templates ---------- */

  server.registerTool(
    'list_templates',
    {
      description: 'List pages marked as templates.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const pages = live(await recs(ctx.env, 'pages')).filter((p) => p.data.isTemplate);
      return txt({ templates: pages.map((p) => ({ id: p.id, title: titleOf(p, 'Untitled'), icon: p.data.icon, url: pageUrl(ctx, p.id) })) });
    },
  );

  async function snapshot(env: Env): Promise<RecSnapshot> {
    const [pages, blocks, boards, tasks] = await Promise.all([recs(env, 'pages'), recs(env, 'blocks'), recs(env, 'boards'), recs(env, 'tasks')]);
    const map = (rs: Rec[]) => Object.fromEntries(rs.map((r) => [r.id, r.data]));
    return { pages: map(pages), blocks: map(blocks), boards: map(boards), tasks: map(tasks) };
  }

  server.registerTool(
    'create_from_template',
    {
      description: 'Instantiate a template page: deep-copies the page tree ({{name}} placeholders substituted), copies embedded task boards with their tasks.',
      inputSchema: z.object({
        templateId: z.string(),
        title: z.string().optional(),
        parentId: z.string().nullable().optional(),
        variables: z.record(z.string(), z.string()).optional().describe('{{placeholder}} → value map'),
      }),
      annotations: { idempotentHint: false },
    },
    async ({ templateId, title, parentId, variables }) => {
      const plan = planTemplateInstantiation(await snapshot(ctx.env), { templateId, title, parentId, variables, actorId: ctx.userId }, { id: uuid, now: Date.now() });
      if (!plan) return err('template not found');
      await write(ctx.env, ctx.ectx, ctx.userId, [...plan.writes, activityOp(ctx.userId, ctx.clientName, 'created', 'page', plan.rootPageId, title ?? 'From template')]);
      return txt({ pageId: plan.rootPageId, url: pageUrl(ctx, plan.rootPageId), records: plan.writes.length });
    },
  );

  /* ---------- 16. create_project ---------- */

  server.registerTool(
    'create_project',
    {
      description:
        'One-shot project scaffold: an overview page (with an embedded task-list block and links to sub-pages), a board with stages/fields/tasks, and an optional mood board — all cross-linked.',
      inputSchema: z.object({
        title: z.string(),
        icon: z.string().optional(),
        overviewMarkdown: z.string().optional(),
        pages: z.array(childPageSchema).optional(),
        board: z
          .object({
            name: z.string(),
            icon: z.string().optional(),
            columns: z.array(z.object({ name: z.string(), color: z.string().optional() })).min(1),
            fields: z.array(z.object({ name: z.string(), type: z.enum(['text', 'number', 'select', 'multi_select', 'person', 'date', 'url', 'checkbox']), options: z.array(z.union([z.string(), z.object({ name: z.string(), color: z.string().optional() })])).optional(), showOnCard: z.boolean().optional() })).optional(),
            tasks: z.array(taskInput.omit({ coverImageUrl: true })).max(MAX_TASKS_PER_CALL).optional(),
          })
          .optional(),
        moodboard: z.object({ title: z.string(), items: z.array(moodItemInput).optional() }).optional(),
      }),
      annotations: { idempotentHint: false },
    },
    async (a) => {
      await fillCaches(ctx);
      const ops: WriteOp[] = [];
      const links: string[] = [];

      // Board (+ fields + tasks)
      let boardId: string | undefined;
      let boardCols: { id: string; name: string; color: string }[] = [];
      let boardFields: FieldDef[] = [];
      if (a.board) {
        boardId = uuid();
        boardCols = a.board.columns.map((c, i) => ({ id: uuid().slice(0, 8), name: c.name, color: c.color ?? COLUMN_COLORS[i % COLUMN_COLORS.length] }));
        boardFields = (a.board.fields ?? []).map((f) => ({
          id: uuid().slice(0, 8),
          name: f.name,
          type: f.type,
          showOnCard: f.showOnCard,
          options: isSelectType(f.type) ? (f.options ?? []).map((o, j) => (typeof o === 'string' ? { id: uuid().slice(0, 8), name: o, color: COLUMN_COLORS[j % COLUMN_COLORS.length] } : { id: uuid().slice(0, 8), name: o.name, color: o.color ?? COLUMN_COLORS[j % COLUMN_COLORS.length] })) : undefined,
        }));
        const boards = live(await recs(ctx.env, 'boards')).sort(byOrder);
        ops.push({
          collection: 'boards',
          id: boardId,
          patch: {
            name: a.board.name,
            icon: a.board.icon ?? '🗂️',
            columns: boardCols,
            fields: boardFields,
            order: orderBetween(boards.length ? String(boards[boards.length - 1].data.order ?? '') || null : null, null),
            createdBy: ctx.userId,
            createdAt: Date.now(),
          },
        });
        links.push(`- [[${a.board.name}]] (board: ${boardId})`);
        let orderKey: string | null = null;
        const boardProxy = { data: { columns: boardCols, fields: boardFields } };
        for (const t of a.board.tasks ?? []) {
          const st = t.status;
          const status = (st ? boardCols.find((c) => c.id === st || c.name.toLowerCase() === st.toLowerCase()) : undefined) ?? boardCols[0];
          orderKey = orderBetween(orderKey, null);
          const fieldPatch = t.fields ? coerceFieldsInput(boardProxy.data.fields as FieldDef[], t.fields) : { patch: {} as Record<string, unknown> };
          ops.push({
            collection: 'tasks',
            id: uuid(),
            patch: {
              title: t.title,
              description: t.description ?? '',
              boardId,
              status: status.id,
              priority: t.priority ?? 'none',
              assigneeId: t.assignee ? ((await resolveUser(ctx.env, t.assignee)) ?? null) : null,
              dueDate: t.due ?? null,
              pageId: null,
              order: orderKey,
              createdBy: ctx.userId,
              createdAt: Date.now(),
              ...fieldPatch.patch,
            },
          });
        }
      }

      // Mood board
      let moodId: string | undefined;
      if (a.moodboard) {
        moodId = uuid();
        ops.push({ collection: 'moodboards', id: moodId, patch: { title: a.moodboard.title, icon: '🎨', order: String(Date.now()), createdBy: ctx.userId, createdAt: Date.now() } });
        if (a.moodboard.items?.length) ops.push(...(await moodItemOps(moodId, a.moodboard.items, [])));
        links.push(`- [${a.moodboard.title}](${moodUrl(ctx, moodId)})`);
      }

      // Overview page + sub-pages
      const rootId = uuid();
      const allPages = live(await recs(ctx.env, 'pages')).filter((p) => !p.data.parentId).sort(byOrder);
      const rootOrder = orderBetween(allPages.length ? String(allPages[allPages.length - 1].data.order ?? '') || null : null, null);
      ops.push({
        collection: 'pages',
        id: rootId,
        patch: { title: a.title, icon: a.icon ?? '📄', parentId: null, order: rootOrder, isTemplate: false, createdBy: ctx.userId, createdAt: Date.now() },
      });
      const overviewParts: string[] = [];
      if (a.overviewMarkdown) overviewParts.push(a.overviewMarkdown);
      const subPageIds: { title: string; id: string }[] = [];
      const childOrder = new Map<string, string | null>();
      const buildSub = async (node: ChildNode, parentId: string): Promise<void> => {
        const pid = uuid();
        const key = orderBetween(childOrder.get(parentId) ?? null, null);
        childOrder.set(parentId, key);
        ops.push({
          collection: 'pages',
          id: pid,
          patch: { title: node.title, icon: node.icon ?? '📄', parentId, order: key, createdBy: ctx.userId, createdAt: Date.now() },
        });
        subPageIds.push({ title: node.title, id: pid });
        if (node.markdown) ops.push(...(await blockOps(ctx, pid, node.markdown, [])));
        for (const child of (node.children ?? []) as ChildNode[]) await buildSub(child, pid);
      };
      for (const p of (a.pages ?? []) as ChildNode[]) await buildSub(p, rootId);
      for (const s of subPageIds) links.push(`- [[${s.title}]] → ${pageUrl(ctx, s.id)}`);

      if (links.length) overviewParts.push(`## Links\n${links.join('\n')}`);
      let blockCount = overviewParts.reduce((n, md) => n + markdownToBlocks(md).length, 0) + (boardId ? 1 : 0);
      if (blockCount > MAX_PAGE_BLOCKS) return err(`too many blocks (max ${MAX_PAGE_BLOCKS})`);
      for (const md of overviewParts) ops.push(...(await blockOps(ctx, rootId, md, [])));
      // Embedded tasks block pointing at the new board — appended after markdown.
      if (boardId) {
        const prev = ops.filter((o) => o.collection === 'blocks' && o.patch.pageId === rootId).map((o) => String(o.patch.order ?? '')).sort(cmpOrder);
        ops.push({
          collection: 'blocks',
          id: uuid(),
          patch: { pageId: rootId, type: 'tasks', boardId, order: orderBetween(prev.length ? prev[prev.length - 1] || null : null, null), text: '' },
        });
      }

      if (ops.length > MAX_WRITE_RECORDS) return err(`project too large (max ${MAX_WRITE_RECORDS} records)`);
      await resolveImageSrcs(ctx, ops);
      ops.push(activityOp(ctx.userId, ctx.clientName, 'created', 'page', rootId, a.title));
      await write(ctx.env, ctx.ectx, ctx.userId, ops);
      return txt({ pageId: rootId, url: pageUrl(ctx, rootId), boardId, boardUrl: boardId ? boardUrl(ctx, boardId) : undefined, moodboardId: moodId, moodboardUrl: moodId ? moodUrl(ctx, moodId) : undefined, records: ops.length });
    },
  );

  /* ---------- 17. recent_activity ---------- */

  server.registerTool(
    'recent_activity',
    {
      description: 'Most recent activity entries (who did what, and which client via meta.via).',
      inputSchema: z.object({ limit: z.number().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      await fillCaches(ctx);
      const all = live(await recs(ctx.env, 'activity'))
        .sort((a, b) => Number(b.data.createdAt ?? 0) - Number(a.data.createdAt ?? 0))
        .slice(0, Math.min(limit ?? 50, 200));
      return txt({
        activity: all.map((a) => ({
          actor: ctx.userNameById.get(String(a.data.actorId ?? '')) ?? null,
          verb: a.data.verb,
          targetType: a.data.targetType,
          targetTitle: a.data.targetTitle,
          via: (a.data.meta as Record<string, unknown> | null)?.via ?? undefined,
          at: a.data.createdAt,
        })),
      });
    },
  );

  /* ---------- 18. delete / restore ---------- */

  const deleteTypes = z.enum(['page', 'task', 'board', 'moodboard', 'mooditem', 'comment', 'file', 'block']);
  const typeToColl: Record<string, Collection> = {
    page: 'pages',
    task: 'tasks',
    board: 'boards',
    moodboard: 'moodboards',
    mooditem: 'mooditems',
    comment: 'comments',
    file: 'files',
    block: 'blocks',
  };

  server.registerTool(
    'delete_item',
    {
      description: 'Soft-delete an item (page, task, board, moodboard, mooditem, comment, file, block). Recoverable via restore_item.',
      inputSchema: z.object({ type: deleteTypes, id: z.string() }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ type, id }) => {
      const collection = typeToColl[type];
      const r = await rec(ctx.env, collection, id);
      if (!r) return err(`${type} not found`);
      if (r.data.deleted) return txt({ type, id, deleted: true, already: true });
      await write(ctx.env, ctx.ectx, ctx.userId, [
        { collection, id, patch: { deleted: true } },
        activityOp(ctx.userId, ctx.clientName, 'deleted', type, id, String(r.data.title ?? r.data.name ?? type)),
      ]);
      return txt({ type, id, deleted: true });
    },
  );

  server.registerTool(
    'restore_item',
    {
      description: 'Restore a soft-deleted item.',
      inputSchema: z.object({ type: deleteTypes, id: z.string() }),
      annotations: { idempotentHint: true },
    },
    async ({ type, id }) => {
      const collection = typeToColl[type];
      const r = await rec(ctx.env, collection, id);
      if (!r) return err(`${type} not found`);
      await write(ctx.env, ctx.ectx, ctx.userId, [{ collection, id, patch: { deleted: false } }]);
      return txt({ type, id, restored: true });
    },
  );

  /* ---------- prompts ---------- */

  server.registerPrompt(
    'plan_project',
    {
      title: 'Plan a project',
      description: 'Turn the current conversation into a workspace project: overview page, board with stages, tasks and an optional mood board.',
      argsSchema: z.object({ brief: z.string().describe('What the project is about — notes, goals, context') }),
    },
    async ({ brief }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Turn this brief into a Workspace project. First call workspace_overview to see existing boards/pages and people for assignment. Then use create_project with: a clear title, overviewMarkdown summarizing goals/next steps, a board with sensible stages and useful custom fields (e.g. select Status/Type, person Owner, date Due), concrete tasks (assign to real people where obvious), and a moodboard if visuals matter. Report the page + board URLs when done.\n\nBrief:\n${brief}`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'make_sop',
    {
      title: 'Create an SOP template',
      description: 'Turn this process into a reusable template page tree with checklists.',
      argsSchema: z.object({ process: z.string().describe('The process or procedure to capture') }),
    },
    async ({ process }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Create a reusable Workspace template for this process. Build the page tree with create_page (root page is fine), write the steps as todo/checklist blocks plus guidance text, use {{placeholder}} tokens where the operator fills in specifics (e.g. {{client name}}, {{date}}), then set isTemplate via edit_page so it shows up under "From template…". Verify with list_templates.\n\nProcess:\n${process}`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'capture_notes',
    {
      title: 'File notes',
      description: 'File raw notes into existing pages and tasks.',
      argsSchema: z.object({ notes: z.string().describe('Raw notes to file away') }),
    },
    async ({ notes }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `File these notes into the workspace. Call workspace_overview to find relevant pages/boards, append content to the right page(s) with edit_page appendMarkdown, and create_tasks for action items (pick a sensible board and stage). Summarize what went where with links.\n\nNotes:\n${notes}`,
          },
        },
      ],
    }),
  );

  return server;
}

/* ---------- handler ---------- */

/**
 * apiHandler for OAuthProvider: validates the token's user still exists in D1
 * (a wiped DB must re-auth rather than write as a ghost), then delegates to the
 * stateless MCP handler. ctx.props comes from completeAuthorization().
 */
let handler: StatelessMcpHandler | null = null;

export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx.props ?? {}) as { userId?: string; clientName?: string };
    if (!props.userId) return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } });
    const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(props.userId).first<{ id: string }>();
    if (!user) return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } });

    if (!handler) handler = createMcpHandler((mcpCtx: McpRequestContext) => createWorkspaceServer(ctxFor(env, ctx, mcpCtx, props)), { route: '/mcp' });
    return handler(request, env, ctx);
  },
};

function ctxFor(env: Env, ectx: ExecutionContext, mcpCtx: McpRequestContext, props: { userId?: string; clientName?: string }): Ctx {
  const url = new URL(mcpCtx.requestInfo?.url ?? 'https://workspace.local');
  return {
    env,
    ectx,
    userId: props.userId!,
    clientName: props.clientName,
    origin: url.origin,
    userByKey: new Map(),
    userNameById: new Map(),
    pageTitleById: new Map(),
    pageIdByTitle: new Map(),
    cachesReady: false,
  };
}

