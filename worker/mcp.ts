import { McpServer } from '@modelcontextprotocol/server';
import type { McpRequestContext } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import type { Env } from './auth';
import { randomToken } from './password';
import { applyChanges, pokeLive, MAX_EXPECTED, type ConflictInfo } from './sync';
import { getRec, getRecs, listBy, listCollection, listDefaultBoardTasks, casUpdate, type RecRow } from './records';
import { withIdempotency } from './idempotency';
import { beginChangeset, commitChangeset, undoChangeset, type ChangesetCtx } from './changesets';
import { planDeleteImpact, type ImpactRow } from '../shared/impact';
import type { AuthUser } from './auth';
import { importFileFromUrl, RemoteFileError } from './remotefile';
import { cmpOrder, orderBetween, uuid } from '../shared/order';
import { blocksToMarkdown, markdownToBlocks, renderMentionText, resolveMentionText } from '../shared/markdown';
import { planTemplateInstantiation, type RecSnapshot } from '../shared/templates';
import { coerceFieldValue, fieldsOf, formatFieldValue, isSelectType, optionByName, propKey, type FieldDef } from '../shared/fields';
import { normalizeItem, cardRef, connectorLinkPlan, DEFAULT_ITEM_SIZE, itemBounds, type MoodItem, type ItemRef } from '../shared/mooditems';
import { layoutBoard, type CanvasLayoutAlgorithm } from '../shared/canvasLayout';
import { validateDiagramSpec } from '../shared/diagramLayout';
import { sanitizeSvg, SVG_MAX_BYTES } from '../shared/svgSanitize';
import { linkId } from '../shared/linkid';
import { edgesOf, wouldCreateDependencyCycle } from '../shared/deps';
import { COLUMN_COLORS } from '../src/modules/boards/model';
import type { Collection } from '../shared/collections';

const MAX_WRITE_RECORDS = 500;
const MAX_PAGE_BLOCKS = 200;
const MAX_TASKS_PER_CALL = 100;

/* ---------- record access ---------- */

interface Rec {
  id: string;
  data: Record<string, unknown>;
  /** records.seq — the revision AI callers pass back as expectedRev. */
  rev: number;
  updatedBy: string | null;
  updatedAt: number | null;
}

const toRec = (r: RecRow): Rec => ({ id: r.id, data: r.data, rev: r.rev, updatedBy: r.updatedBy, updatedAt: r.updatedAt });

async function recs(env: Env, collection: Collection): Promise<Rec[]> {
  return (await listCollection(env, collection)).map(toRec);
}

async function rec(env: Env, collection: Collection, id: string): Promise<Rec | null> {
  const row = await getRec(env, id);
  return row && row.collection === collection ? toRec(row) : null;
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

/** Throw from write() — caught by the tool wrapper, becomes the §4.3 conflict result. */
class WriteConflict extends Error {
  constructor(public conflicts: ConflictInfo[]) {
    super('conflict');
  }
}

/**
 * Apply ops as the request's user, collect touched fields into the open
 * change set (activity rows excluded), and fail loudly on expectedRev
 * mismatches. `expect` caps at one atomic batch of expected ids.
 */
async function write(c: Ctx, ops: WriteOp[], opts: { expect?: Map<string, number> } = {}): Promise<void> {
  if (opts.expect && opts.expect.size > MAX_EXPECTED) throw new Error(`at most ${MAX_EXPECTED} expected ids per call`);
  for (let i = 0; i < ops.length; i += MAX_WRITE_RECORDS) {
    const chunk = ops.slice(i, i + MAX_WRITE_RECORDS);
    const r = await applyChanges(
      c.env,
      c.userId,
      chunk.map((o) => ({ id: o.id, collection: o.collection, patch: o.patch, ts: 0 })),
      { serverTs: true, expect: opts.expect },
    );
    if (r.conflicts?.length) throw new WriteConflict(r.conflicts);
    if (r.conflict) throw new Error('write conflict, retry');
    c.cs?.items.push(...r.applied.filter((a) => a.collection !== 'activity'));
  }
  pokeLive(c.env, c.ectx);
}

function activityOp(userId: string, clientName: string | undefined, verb: string, targetType: string, targetId: string, targetTitle: string, changesetId?: string): WriteOp {
  const meta: Record<string, unknown> = clientName ? { via: clientName } : {};
  if (changesetId) meta.changesetId = changesetId;
  return {
    collection: 'activity',
    id: uuid(),
    patch: {
      actorId: userId,
      verb,
      targetType,
      targetId,
      targetTitle,
      meta: Object.keys(meta).length ? meta : null,
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


async function mentionResolvers(c: Ctx) {
  await fillCaches(c);
  return {
    resolveUser: resolverFor(c, 'user'),
    resolvePage: resolverFor(c, 'page'),
    userName: (id: string) => c.userNameById.get(id),
    pageTitle: (id: string) => c.pageTitleById.get(id),
  };
}

/* ---------- shared builders ---------- */

interface Ctx {
  env: Env;
  ectx: ExecutionContext;
  userId: string;
  userRole: 'admin' | 'member';
  clientName?: string;
  origin: string;
  /** per-request lookup caches (never module-level — requests interleave) */
  userByKey: Map<string, string[]>;
  userNameById: Map<string, string>;
  pageTitleById: Map<string, string>;
  pageIdByTitle: Map<string, string[]>;
  cachesReady: boolean;
  /** accumulated ambiguity/mention warnings merged into tool results */
  warnings: string[];
  /** open change set for the running tool call */
  cs: ChangesetCtx | null;
  /** tool name while a write tool runs (undo uses it for summaries) */
  toolName: string;
}

type Resolution = { id: string } | { ambiguous: { id: string; title?: string; name?: string }[] } | { missing: true };

function resolveOne(c: Ctx, kind: 'page' | 'user', ids: string[] | undefined): Resolution {
  if (!ids?.length) return { missing: true };
  if (ids.length === 1) return { id: ids[0] };
  return {
    ambiguous: ids.slice(0, 10).map((id) => (kind === 'page' ? { id, title: c.pageTitleById.get(id) } : { id, name: c.userNameById.get(id) })),
  };
}

/** `[[Title]]`/`@handle` inside markdown: resolve, warn on ambiguity, leave literal on miss/ambiguity. */
function resolverFor(c: Ctx, kind: 'page' | 'user'): (key: string) => string | undefined {
  return (key) => {
    const k = key.trim().toLowerCase();
    const ids = kind === 'page' ? c.pageIdByTitle.get(k) : c.userByKey.get(k);
    const r = resolveOne(c, kind, ids);
    if ('id' in r) return r.id;
    c.warnings.push('ambiguous' in r ? `ambiguous ${kind} "${key}" — left as literal text` : `${kind} "${key}" not found — left as literal text`);
    return undefined;
  };
}

/** @handle / name / id → single user id, pushing an ambiguity warning. */
function resolveAssignee(c: Ctx, handle: string): string | null {
  const h = handle.trim().toLowerCase();
  const r = resolveOne(c, 'user', c.userByKey.get(h));
  if ('id' in r) return r.id;
  if ('ambiguous' in r) {
    c.warnings.push(`assignee "${handle}" is ambiguous — left unset`);
    return null;
  }
  c.warnings.push(`assignee "${handle}" not found — left unset`);
  return null;
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
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Result payload merger: inject warnings + changesetId into the JSON text of a txt() result. */
function decorate(res: ToolResult, ctx: Ctx, changesetId: string | null): ToolResult {
  const text = res.content?.[0]?.text;
  if (!text) return res;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return res;
  }
  if (ctx.warnings.length) data.warnings = ctx.warnings;
  if (changesetId) data.changesetId = changesetId;
  return { content: [{ type: 'text', text: JSON.stringify(data) }], isError: res.isError };
}

/** Append blocks parsed from markdown under a page; returns the write ops (not yet applied). */
async function blockOps(c: Ctx, pageId: string, markdown: string, existing: Rec[], afterBlockId?: string): Promise<WriteOp[]> {
  const mdBlocks = markdownToBlocks(markdown, {
    resolveUser: resolverFor(c, 'user'),
    resolvePage: resolverFor(c, 'page'),
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
  const pushKey = (m: Map<string, string[]>, k: string, id: string) => {
    const list = m.get(k);
    if (list) { if (!list.includes(id)) list.push(id); }
    else m.set(k, [id]);
  };
  for (const u of await users(c.env)) {
    pushKey(c.userByKey, u.username.toLowerCase(), u.id);
    pushKey(c.userByKey, u.name.toLowerCase(), u.id);
    pushKey(c.userByKey, u.id, u.id);
    c.userNameById.set(u.id, u.name);
  }
  for (const p of live(await recs(c.env, 'pages'))) {
    c.pageTitleById.set(p.id, String(p.data.title ?? 'Untitled'));
    pushKey(c.pageIdByTitle, String(p.data.title ?? 'Untitled').toLowerCase(), p.id);
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
  const requestIdInput = z.string().optional().describe('Idempotency key (1-64 chars). Re-sending the same requestId returns the stored result instead of re-applying.');
  const dryRunInput = z.boolean().optional().describe('Preview impact without writing. Call with dryRun:true first and show the user the impact before executing.');

  /**
   * Wrap a write tool: optional requestId replay protection → change-set
   * tracking → WriteConflict → §4.3 error JSON → warnings + changesetId merge.
   */
  function reg<S extends z.ZodRawShape>(name: string, meta: { description: string; inputSchema: z.ZodObject<S>; annotations?: Record<string, unknown> }, handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>): void {
    server.registerTool(name, { ...meta, inputSchema: meta.inputSchema.extend({ requestId: requestIdInput }) } as never, async (rawArgs: unknown) => {
      const args = rawArgs as z.infer<z.ZodObject<S>> & { requestId?: string };
      const run = async (): Promise<{ text: string; isError: boolean }> => {
        ctx.cs = beginChangeset({ userId: ctx.userId, clientName: ctx.clientName, tool: name, requestId: args.requestId ?? null });
        ctx.toolName = name;
        try {
          const res = await handler(args);
          // Commit even on error results: any write that already landed must
          // stay undoable — no successful write without a change set (§4.2).
          const csId = await commitChangeset(ctx.env, ctx.cs);
          const decorated = decorate(res, ctx, csId);
          return { text: decorated.content[0].text, isError: res.isError === true };
        } catch (e) {
          // Same guarantee on the throw path (e.g. casUpdate landed, then a
          // later step failed): commit whatever applied so it stays undoable.
          const csId = await commitChangeset(ctx.env, ctx.cs).catch(() => null);
          const payload: Record<string, unknown> =
            e instanceof WriteConflict
              ? { error: 'conflict', conflicts: e.conflicts.map((cc) => ({ type: 'stale_rev', id: cc.id, collection: cc.collection, expectedRev: cc.expectedRev, currentRev: cc.currentRev, current: cc.current, changedBy: cc.updatedBy, changedAt: cc.updatedAt })) }
              : { error: e instanceof Error ? e.message : String(e) };
          if (csId) payload.changesetId = csId;
          return { text: JSON.stringify(payload), isError: true };
        } finally {
          ctx.cs = null;
        }
      };
      if (args.requestId) {
        const out = await withIdempotency(ctx.env, ctx.userId, name, args.requestId, args, run);
        return { content: [{ type: 'text' as const, text: out.text }], isError: out.failed === true } as ToolResult;
      }
      const out = await run();
      return { content: [{ type: 'text' as const, text: out.text }], isError: out.isError } as ToolResult;
    });
  }

  /* Review C2: CAS read-modify-write that threads the real userId (updated_by
   * attribution) and records landed writes into the change set inside
   * casUpdate itself — nothing can land unrecorded before a later push. */
  const cas = (collection: string, id: string, mutate: Parameters<typeof casUpdate>[4]) =>
    casUpdate(ctx.env, ctx.userId, collection, id, mutate, { recordTo: ctx.cs?.items ?? undefined });

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
      const results: { id: string; title: string; url: string; rev?: number }[] = [];
      // §3/§11: scan only what search needs — no full data column.
      const { results: slim } = await ctx.env.DB.prepare(
        `SELECT id, collection, seq,
                json_extract(data, '$.title') AS jt,
                json_extract(data, '$.name') AS jn,
                json_extract(data, '$.text') AS jtext,
                json_extract(data, '$.description') AS jdesc,
                json_extract(data, '$.pageId') AS jpage,
                json_extract(data, '$.boardId') AS jboard,
                json_extract(data, '$.deleted') AS jdel
         FROM records
         WHERE collection IN ('pages','blocks','tasks','boards','moodboards')`,
      ).all<{ id: string; collection: string; seq: number; jt: unknown; jn: unknown; jtext: unknown; jdesc: unknown; jpage: unknown; jboard: unknown; jdel: unknown }>();
      const rows = slim.filter((r) => r.jdel !== 1);
      const pageHasMatch = new Set<string>();
      for (const b of rows) if (b.collection === 'blocks' && String(b.jtext ?? '').toLowerCase().includes(q)) pageHasMatch.add(String(b.jpage ?? ''));
      for (const p of rows) {
        if (results.length >= 50) break;
        if (p.collection !== 'pages') continue;
        if (String(p.jt ?? '').toLowerCase().includes(q) || pageHasMatch.has(p.id)) {
          results.push({ id: `page:${p.id}`, title: String(p.jt ?? 'Untitled'), url: pageUrl(ctx, p.id), rev: p.seq });
        }
      }
      for (const t of rows) {
        if (results.length >= 50) break;
        if (t.collection !== 'tasks') continue;
        if (`${t.jt ?? ''} ${t.jdesc ?? ''}`.toLowerCase().includes(q)) results.push({ id: `task:${t.id}`, title: String(t.jt ?? 'Task'), url: `${ctx.origin}/boards/${String(t.jboard ?? 'board-default')}/tasks/${t.id}`, rev: t.seq });
      }
      for (const b of rows) {
        if (results.length >= 50) break;
        if (b.collection !== 'boards') continue;
        if (String(b.jn ?? b.jt ?? '').toLowerCase().includes(q)) results.push({ id: `board:${b.id}`, title: String(b.jn ?? b.jt ?? 'Board'), url: boardUrl(ctx, b.id), rev: b.seq });
      }
      for (const m of rows) {
        if (results.length >= 50) break;
        if (m.collection !== 'moodboards') continue;
        if (String(m.jt ?? '').toLowerCase().includes(q)) results.push({ id: `moodboard:${m.id}`, title: String(m.jt ?? 'Mood board'), url: moodUrl(ctx, m.id), rev: m.seq });
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
        const blocks = (await listBy(ctx.env, 'blocks', 'pageId', rawId)).map(toRec).sort(byOrder);
        return txt({
          id,
          title: titleOf(p, 'Untitled'),
          rev: p.rev,
          text: blocksToMarkdown(blocks.map((b) => b.data), resolvers),
          url: pageUrl(ctx, rawId),
          linked: await linkedFor(rawId),
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
          rev: t.rev,
          text: `${t.data.description ?? ''}\n\nStatus: ${colName} · Board: ${String(board?.data.name ?? '')}\nPriority: ${t.data.priority ?? 'none'} · Due: ${t.data.dueDate ?? '—'}`.trim(),
          url: taskUrl(ctx, t),
          linked: await linkedFor(rawId),
          metadata: { type: 'task', boardId: board?.id ?? null, status },
        });
      }
      if (type === 'board') {
        const b = await rec(ctx.env, 'boards', rawId);
        if (!b || b.data.deleted) return err('board not found');
        const tasks = live(await recs(ctx.env, 'tasks')).filter((t) => String(t.data.boardId ?? 'board-default') === rawId);
        const lines = boardColumns(b).map((col) => `- ${col.name}: ${tasks.filter((t) => columnIdFor(b, t.data.status) === col.id).length} tasks`);
        return txt({ id, title: titleOf(b, 'Board'), rev: b.rev, text: `Columns:\n${lines.join('\n')}`, url: boardUrl(ctx, rawId), metadata: { type: 'board' } });
      }
      if (type === 'moodboard') {
        const m = await rec(ctx.env, 'moodboards', rawId);
        if (!m || m.data.deleted) return err('mood board not found');
        const items = live(await recs(ctx.env, 'mooditems')).filter((i) => String(i.data.boardId) === rawId);
        const lines = items.map((i) => `- ${i.data.type}: ${i.data.text ?? i.data.color ?? i.data.fileId ?? ''}`);
        return txt({ id, title: titleOf(m, 'Mood board'), rev: m.rev, text: `Items:\n${lines.join('\n')}`, url: moodUrl(ctx, rawId), metadata: { type: 'moodboard' } });
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
      const [us, pages, boards, moods, items, viewRowsAll] = await Promise.all([
        users(ctx.env),
        recs(ctx.env, 'pages'),
        recs(ctx.env, 'boards'),
        recs(ctx.env, 'moodboards'),
        recs(ctx.env, 'mooditems'),
        recs(ctx.env, 'views'),
      ]);
      const viewRows = live(viewRowsAll);
      return txt({
        people: us.map((u) => ({ id: u.id, username: u.username, name: u.name })),
        pages: live(pages)
          .sort(byOrder)
          .map((p) => ({ id: p.id, title: titleOf(p, 'Untitled'), icon: p.data.icon, parentId: p.data.parentId ?? null, isTemplate: !!p.data.isTemplate, rev: p.rev })),
        boards: live(boards).map((b) => ({
          id: b.id,
          name: b.data.name,
          rev: b.rev,
          kind: b.data.kind ?? 'tasks',
          recordNoun: b.data.recordNoun,
          description: b.data.description,
          defaultViewId: b.data.defaultViewId ?? null,
          columns: boardColumns(b).map((c) => ({ id: c.id, name: c.name })),
          fields: fieldsOf(b.data).map((f) => ({ id: f.id, name: f.name, type: f.type, options: f.options?.map((o) => o.name), relation: f.relation ? { target: f.relation.target, pairedFieldId: f.relation.pairedFieldId, single: f.relation.single, primary: f.relation.primary } : undefined })),
        })),
        viewsByBoard: Object.fromEntries(
          live(boards).map((b) => [b.id, viewRows.filter((v) => String(v.data.databaseId) === b.id).map((v) => ({ id: v.id, name: v.data.name, type: v.data.type, rev: v.rev }))]),
        ),
        moodboards: live(moods).map((m) => ({ id: m.id, title: m.data.title, rev: m.rev, itemCount: live(items).filter((i) => String(i.data.boardId) === m.id).length })),
      });
    },
  );

  /** Links touching an item (relations/related/blocks) + @[page|rec] mention backlinks summary. */
  const linkedFor = async (id: string) => {
    const ls = (await listCollection(ctx.env, 'links'));
    const touching = ls.filter((l) => String(l.data.fromId) === id || String(l.data.toId) === id);
    const titleOfRec = async (rid: string) => {
      const t = await getRec(ctx.env, rid);
      return t ? String(t.data.title ?? t.data.name ?? rid) : ctx.pageTitleById.get(rid) ?? rid;
    };
    const out = [];
    for (const l of touching.slice(0, 50)) {
      const other = String(l.data.fromId) === id ? String(l.data.toId) : String(l.data.fromId);
      out.push({ linkId: l.id, kind: l.data.kind, fieldId: l.data.fieldId ?? null, direction: String(l.data.fromId) === id ? 'out' : 'in', id: other, title: await titleOfRec(other) });
    }
    return out;
  };

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
      const [blockRows, childRows, backlinkRows] = await Promise.all([
        listBy(ctx.env, 'blocks', 'pageId', pageId),
        listBy(ctx.env, 'pages', 'parentId', pageId),
        // §3: backlink scan via instr() on the data column (blocks only).
        ctx.env.DB.prepare(`SELECT ${'id, collection, data, field_ts, seq, updated_by, updated_at'} FROM records WHERE collection = 'blocks' AND instr(data, ?) > 0 AND COALESCE(json_extract(data, '$.deleted'), 0) != 1`).bind(`@[page:${pageId}]`).all<{ id: string; collection: string; data: string; field_ts: string; seq: number; updated_by: string | null; updated_at: number | null }>(),
      ]);
      const blocks = blockRows.map(toRec).sort(byOrder);
      const children = childRows.map(toRec).sort(byOrder);
      const pageName = ctx.pageTitleById;
      const backlinks = backlinkRows.results
        .map((r) => toRec({ id: r.id, collection: r.collection, data: JSON.parse(r.data), fieldTs: JSON.parse(r.field_ts), rev: r.seq, updatedBy: r.updated_by, updatedAt: r.updated_at }))
        .filter((b) => b.data.pageId !== pageId && String(b.data.text ?? '').includes(`@[page:${pageId}]`))
        .slice(0, 20)
        .map((b) => ({
          pageId: b.data.pageId,
          title: pageName.get(String(b.data.pageId)) ?? 'Untitled',
          snippet: renderMentionText(String(b.data.text ?? ''), resolvers).slice(0, 140),
        }));
      return txt({
        page: { id: p.id, title: titleOf(p, 'Untitled'), icon: p.data.icon, parentId: p.data.parentId ?? null, isTemplate: !!p.data.isTemplate, rev: p.rev },
        markdown: blocksToMarkdown(blocks.map((b) => b.data), resolvers),
        blocks: blocks.map((b) => ({ id: b.id, type: b.data.type ?? 'p', text: b.data.text ?? '', rev: b.rev })),
        children: children.map((x) => ({ id: x.id, title: titleOf(x, 'Untitled'), icon: x.data.icon, rev: x.rev })),
        backlinks,
        linked: await linkedFor(pageId),
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

  reg(
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
      const allBlocks: Rec[] = []; // new pages have no existing blocks

      const build = async (node: ChildNode, parentId: string | null): Promise<string> => {
        const id = uuid();
        const sibs = allPages.filter((p) => (p.data.parentId ?? null) === parentId).sort(byOrder);
        const order = orderBetween(sibs.length ? String(sibs[sibs.length - 1].data.order ?? '') || null : null, null);
        allPages.push({ id, data: { parentId, order }, rev: -1, updatedBy: null, updatedAt: null });
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
      await write(ctx, [...ops, activityOp(ctx.userId, ctx.clientName, 'created', 'page', id, args.title, ctx.cs?.id)]);
      return txt({ id, url: pageUrl(ctx, id) });
    },
  );

  /* ---------- 6. edit_page ---------- */

  reg(
    'edit_page',
    {
      description: 'Edit a page: rename/retitle/icon/parent/template flag, append markdown, insert after a block, replace or delete blocks. replaceBlocks/deleteBlocks guard on EACH block\'s own rev (get_page returns per-block rev); page expectedRev guards page fields only.',
      inputSchema: z.object({
        pageId: z.string(),
        expectedRev: z.number().optional().describe('Page rev from get_page — guards title/icon/parent/isTemplate changes'),
        title: z.string().optional(),
        icon: z.string().optional(),
        parentId: z.string().nullable().optional(),
        isTemplate: z.boolean().optional(),
        appendMarkdown: z.string().optional().describe('Append markdown blocks at the end'),
        insertAfterBlockId: z.string().optional().describe('Insert `markdown` after this block id'),
        markdown: z.string().optional().describe('Used with insertAfterBlockId'),
        replaceBlocks: z.array(z.object({ blockId: z.string(), markdown: z.string(), expectedRev: z.number().describe("That block's own rev from get_page blocks[]") })).optional().describe('Replace each block\'s text with the parsed markdown lines'),
        deleteBlocks: z.array(z.object({ blockId: z.string(), expectedRev: z.number().describe("That block's own rev from get_page blocks[]") })).optional(),
        deleteBlockIds: z.array(z.string()).optional().describe('DEPRECATED unguarded — use deleteBlocks (per-block expectedRev)'),
        dryRun: dryRunInput,
      }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const p = await rec(ctx.env, 'pages', a.pageId);
      if (!p || p.data.deleted) return err('page not found');
      if (a.deleteBlockIds?.length) return err('deleteBlockIds cannot be rev-guarded — pass deleteBlocks:[{blockId, expectedRev}] (get_page returns each block\'s rev)');
      await fillCaches(ctx);
      if (a.dryRun) {
        return txt({
          dryRun: true,
          summary: `edit_page ${a.pageId}`,
          counts: { pageFields: Object.keys({ t: a.title, i: a.icon, p: a.parentId, t2: a.isTemplate }).length, appended: a.appendMarkdown ? markdownToBlocks(a.appendMarkdown).length : 0, replaced: a.replaceBlocks?.length ?? 0, deleted: a.deleteBlocks?.length ?? 0 },
          warnings: ctx.warnings.length ? ctx.warnings : [],
          impact: { deleteBlockIds: (a.deleteBlocks ?? []).map((d) => d.blockId), replaceBlockIds: (a.replaceBlocks ?? []).map((r) => r.blockId) },
        });
      }
      const ops: WriteOp[] = [];
      const unchecked: string[] = [];
      const expect = new Map<string, number>();
      const pagePatch: Record<string, unknown> = {};
      if (a.title !== undefined) pagePatch.title = a.title;
      if (a.icon !== undefined) pagePatch.icon = a.icon;
      if (a.parentId !== undefined) pagePatch.parentId = a.parentId;
      if (a.isTemplate !== undefined) pagePatch.isTemplate = a.isTemplate;
      if (Object.keys(pagePatch).length) {
        ops.push({ collection: 'pages', id: a.pageId, patch: pagePatch });
        if (a.expectedRev !== undefined) expect.set(a.pageId, a.expectedRev);
        else unchecked.push(a.pageId);
      }

      const existing = live((await listBy(ctx.env, 'blocks', 'pageId', a.pageId)).map(toRec));
      const splitReplaces: string[] = [];
      for (const r of a.replaceBlocks ?? []) {
        const src = existing.find((b) => b.id === r.blockId);
        if (!src) return err(`block ${r.blockId} not found`);
        // Guard the block at ITS OWN read rev — the page's rev can't see
        // concurrent block edits (review B3).
        expect.set(r.blockId, r.expectedRev);
        const parsed = markdownToBlocks(r.markdown, {
          resolveUser: resolverFor(ctx, 'user'),
          resolvePage: resolverFor(ctx, 'page'),
        });
        const first = parsed[0];
        if (!first) continue;
        ops.push({ collection: 'blocks', id: r.blockId, patch: { type: first.type, text: first.text ?? '', ...(first.type === 'todo' ? { checked: !!first.checked } : {}) } });
        // §10.7: markdown may parse to >1 block — the first replaces in place,
        // the rest are inserted right after it and reported.
        if (parsed.length > 1) {
          const idx = existing.filter((b) => !b.data.deleted).sort(byOrder).findIndex((b) => b.id === r.blockId);
          const ordered = existing.filter((b) => !b.data.deleted).sort(byOrder);
          let prevKey = String(ordered[idx].data.order ?? '') || null;
          let nextKey = idx + 1 < ordered.length ? String(ordered[idx + 1].data.order ?? '') || null : null;
          for (const b of parsed.slice(1)) {
            const key = orderBetween(prevKey, nextKey);
            prevKey = key;
            const patch: Record<string, unknown> = { pageId: a.pageId, order: key, type: b.type, text: b.text ?? '' };
            if (b.type === 'todo') patch.checked = !!b.checked;
            if (b.caption) patch.caption = b.caption;
            ops.push({ collection: 'blocks', id: uuid(), patch });
          }
          splitReplaces.push(r.blockId);
        }
      }
      for (const d of a.deleteBlocks ?? []) {
        if (!existing.some((b) => b.id === d.blockId)) return err(`block ${d.blockId} not found`);
        expect.set(d.blockId, d.expectedRev);
        ops.push({ collection: 'blocks', id: d.blockId, patch: { deleted: true } });
      }
      if (a.markdown && a.insertAfterBlockId) ops.push(...(await blockOps(ctx, a.pageId, a.markdown, existing, a.insertAfterBlockId)));
      if (a.appendMarkdown) ops.push(...(await blockOps(ctx, a.pageId, a.appendMarkdown, existing)));
      await resolveImageSrcs(ctx, ops);
      await write(ctx, ops, { expect });
      return txt({ id: a.pageId, url: pageUrl(ctx, a.pageId), updated: ops.length, ...(unchecked.length ? { unchecked } : {}), ...(splitReplaces.length ? { splitIntoMultipleBlocks: splitReplaces } : {}) });
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
      const assigneeId = assignee ? resolveAssignee(ctx, assignee) ?? undefined : undefined;
      const boardTasks = boardId === 'board-default' ? (await listDefaultBoardTasks(ctx.env)).map(toRec) : (await listBy(ctx.env, 'tasks', 'boardId', boardId)).map(toRec);
      let tasks = live(boardTasks);
      if (status) {
        const cols = boardColumns(board);
        const col = cols.find((c) => c.id === status || c.name.toLowerCase() === status.toLowerCase());
        tasks = tasks.filter((t) => columnIdFor(board, t.data.status) === (col?.id ?? status));
      }
      if (assigneeId) tasks = tasks.filter((t) => String(t.data.assigneeId ?? '') === assigneeId);
      return txt({
        board: { id: board.id, name: board.data.name, icon: board.data.icon, rev: board.rev },
        columns: boardColumns(board),
        fields: fieldsOf(board.data),
        tasks: tasks.sort(byOrder).map((t) => ({
          id: t.id,
          rev: t.rev,
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

  reg(
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
      void 0;
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
      await write(ctx, [
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
        activityOp(ctx.userId, ctx.clientName, 'created', 'board', boardId, name, ctx.cs?.id),
      ]);
      return txt({ id: boardId, url: boardUrl(ctx, boardId), columns: columns.map((c) => c.name) });
    },
  );

  reg(
    'update_board',
    {
      description: 'Rename/re-icon a board. columns/addFields/updateFields/removeFields are deprecated — use add_stage/update_stage/remove_stage and add_field/update_field/remove_field (CAS-safe, idempotent, per-call change sets).',
      inputSchema: z.object({
        boardId: z.string(),
        expectedRev: z.number().optional().describe('Board rev from get_board — recommended'),
        dryRun: dryRunInput,
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
      if (a.dryRun) return txt({ dryRun: true, summary: `update_board ${a.boardId}`, counts: { columns: a.columns?.length ?? 0, addFields: a.addFields?.length ?? 0, updateFields: a.updateFields?.length ?? 0, removeFields: a.removeFields?.length ?? 0 }, warnings: [], impact: {} });
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
        const tasks = live(a.boardId === 'board-default' ? (await listDefaultBoardTasks(ctx.env)).map(toRec) : (await listBy(ctx.env, 'tasks', 'boardId', a.boardId)).map(toRec)).filter((t) => !valid.has(String(t.data.status ?? '')));
        for (const t of tasks) ops.push({ collection: 'tasks', id: t.id, patch: { status: first } });
      }
      const expect = a.expectedRev !== undefined ? new Map([[a.boardId, a.expectedRev]]) : undefined;
      await write(ctx, ops, { expect });
      return txt({ id: a.boardId, url: boardUrl(ctx, a.boardId), updated: ops.length, ...(a.expectedRev === undefined ? { unchecked: [a.boardId] } : {}) });
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

  reg(
    'create_tasks',
    {
      description: `Create up to ${MAX_TASKS_PER_CALL} tasks on a board. Select field values accept option names; unknown option names are added to the field. dedupe:'title' (default) skips tasks whose title already exists on the board.`,
      inputSchema: z.object({
        boardId: z.string(),
        tasks: z.array(taskInput).min(1).max(MAX_TASKS_PER_CALL),
        dedupe: z.enum(['none', 'title']).optional().describe("'title' (default) skips creates whose title already exists on the board (case-insensitive)"),
        dryRun: dryRunInput,
      }),
      annotations: { idempotentHint: false },
    },
    async ({ boardId, tasks, dedupe, dryRun }) => {
      const board = await rec(ctx.env, 'boards', boardId);
      if (!board || board.data.deleted) return err('board not found');
      await fillCaches(ctx);
      const allTasks = live(boardId === 'board-default' ? (await listDefaultBoardTasks(ctx.env)).map(toRec) : (await listBy(ctx.env, 'tasks', 'boardId', boardId)).map(toRec));
      const ops: WriteOp[] = [];
      const created: { id: string; title: string }[] = [];
      const skipped: string[] = [];
      if ((dedupe ?? 'title') === 'title') {
        const seen = new Set(allTasks.map((t) => String(t.data.title ?? '').toLowerCase()));
        tasks = tasks.filter((t) => {
          const k = t.title.toLowerCase();
          if (seen.has(k)) {
            skipped.push(t.title);
            return false;
          }
          seen.add(k);
          return true;
        });
      }
      if (dryRun) return txt({ dryRun: true, summary: `create_tasks on board ${boardId}`, counts: { create: tasks.length, skipped: skipped.length }, warnings: [], impact: { skippedTitles: skipped } });
      if (!tasks.length) return txt({ boardId, created: [], skipped, url: boardUrl(ctx, boardId) });
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
          assigneeId: t.assignee ? (resolveAssignee(ctx, t.assignee)) : null,
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
        allTasks.push({ id, data: { boardId, status, order }, rev: -1, updatedBy: null, updatedAt: null });
        created.push({ id, title: t.title });
      }
      if (fieldsMutated) ops.unshift({ collection: 'boards', id: boardId, patch: { fields } });
      await write(ctx, [...ops, ...created.map((x) => activityOp(ctx.userId, ctx.clientName, 'created', 'task', x.id, x.title, ctx.cs?.id))]);
      return txt({ boardId, created, skipped, url: boardUrl(ctx, boardId) });
    },
  );

  reg(
    'update_tasks',
    {
      description: 'Update tasks: title, description, stage, assignee, due, priority, move to another board (lands in its first column), custom field values. expectedRev per update is recommended.',
      inputSchema: z.object({
        updates: z.array(taskInput.partial().extend({ taskId: z.string(), boardId: z.string().optional().describe('Move to this board'), expectedRev: z.number().optional() })).min(1).max(100),
        dryRun: dryRunInput,
      }),
      annotations: { idempotentHint: true },
    },
    async ({ updates, dryRun }) => {
      await fillCaches(ctx);
      if (dryRun) return txt({ dryRun: true, summary: `update_tasks`, counts: { updates: updates.length }, warnings: [], impact: { taskIds: updates.map((u) => u.taskId) } });
      const ops: WriteOp[] = [];
      const expect = new Map<string, number>();
      const unchecked: string[] = [];
      const boardsMutated = new Map<string, FieldDef[]>();
      for (const u of updates) {
        const task = await rec(ctx.env, 'tasks', u.taskId);
        if (!task || task.data.deleted) return err(`task ${u.taskId} not found`);
        if (u.expectedRev !== undefined) expect.set(u.taskId, u.expectedRev);
        else unchecked.push(u.taskId);
        const targetBoardId = u.boardId ?? String(task.data.boardId ?? 'board-default');
        const board = (await rec(ctx.env, 'boards', targetBoardId)) ?? ({ data: {} } as Rec);
        const patch: Record<string, unknown> = {};
        if (u.title !== undefined) patch.title = u.title;
        if (u.description !== undefined) patch.description = u.description;
        if (u.status !== undefined || u.boardId !== undefined) patch.status = columnIdFor(board, u.status);
        if (u.boardId !== undefined) patch.boardId = u.boardId;
        if (u.priority !== undefined) patch.priority = u.priority;
        if (u.due !== undefined) patch.dueDate = u.due;
        if (u.assignee !== undefined) patch.assigneeId = resolveAssignee(ctx, u.assignee);
        if (u.coverImageUrl !== undefined) {
          try {
            const { fileId } = await importFileFromUrl(ctx.env, u.coverImageUrl, { parentType: 'task', parentId: u.taskId, userId: ctx.userId });
            patch.coverFileId = fileId;
          } catch (e) {
            if (e instanceof RemoteFileError) return err(`coverImageUrl for task ${u.taskId}: ${e.message}`);
            throw e;
          }
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
      await write(ctx, ops, { expect });
      return txt({ updated: updates.length, ...(unchecked.length ? { unchecked } : {}) });
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
      const [comments, filesRecs] = await Promise.all([listBy(ctx.env, 'comments', 'targetId', taskId), listBy(ctx.env, 'files', 'parentId', taskId)]);
      const thread = comments
        .map(toRec)
        .filter((c) => c.data.targetType === 'task')
        .sort((a, b) => Number(a.data.createdAt ?? 0) - Number(b.data.createdAt ?? 0));
      const attachments = filesRecs.map(toRec).filter((f) => f.data.parentType === 'task');
      return txt({
        id: t.id,
        rev: t.rev,
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

  const itemRefInput = z.object({ type: z.enum(['record', 'page']), id: z.string() });
  const moodItemInput = z.object({
    type: z.enum(['image', 'note', 'text', 'color', 'card', 'frame', 'shape', 'svg', 'diagram', 'connector']),
    text: z.string().optional(),
    color: z.string().optional(),
    imageUrl: z.string().optional().describe('https URL — imported into workspace files'),
    fileId: z.string().optional().describe('existing workspace file id (image/svg)'),
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().optional(),
    h: z.number().optional(),
    // card
    ref: itemRefInput.optional().describe('card target: {type:"record"|"page", id}'),
    taskId: z.string().optional().describe('legacy shorthand for ref {type:"record",id}'),
    // frame
    title: z.string().optional(),
    frameStageOf: z.object({ databaseId: z.string(), stageId: z.string() }).nullable().optional(),
    // shape
    shape: z.enum(['rect', 'ellipse', 'diamond', 'pill']).optional(),
    fill: z.string().optional(),
    stroke: z.string().optional(),
    // svg (inline sanitized markup — never store unsanitized)
    svg: z.string().optional(),
    // diagram
    spec: z.unknown().optional().describe('DiagramSpec {layout, nodes, edges}'),
    // connector
    from: z.string().optional(),
    to: z.string().optional(),
    label: z.string().optional(),
    style: z.enum(['solid', 'dashed']).optional(),
    arrow: z.enum(['end', 'both', 'none']).optional(),
    linkKind: z.enum(['blocks', 'related']).nullable().optional(),
    linkId: z.string().nullable().optional(),
    parentFrameId: z.string().nullable().optional(),
  });

  /** Live mooditems of one board. */
  const boardItems = async (moodboardId: string): Promise<Rec[]> =>
    live((await listBy(ctx.env, 'mooditems', 'boardId', moodboardId)).map(toRec));

  /** Resolve a card ref to {title, stage} — stage is the column NAME on the record's board. */
  async function cardInfoFor(ref: ItemRef | null, boardsById: Map<string, Rec>): Promise<{ title: string | null; stage: string | null }> {
    if (!ref) return { title: null, stage: null };
    const r = await rec(ctx.env, ref.type === 'page' ? 'pages' : 'tasks', ref.id);
    if (!r || r.data.deleted) return { title: null, stage: null };
    if (ref.type === 'page') return { title: titleOf(r, 'Untitled'), stage: null };
    let board = boardsById.get(String(r.data.boardId ?? 'board-default'));
    if (board === undefined) {
      board = (await rec(ctx.env, 'boards', String(r.data.boardId ?? 'board-default'))) ?? undefined;
      if (board) boardsById.set(String(r.data.boardId ?? 'board-default'), board);
    }
    const cols = (board?.data.columns ?? []) as { id: string; name: string }[];
    const status = String(r.data.status ?? '');
    return { title: titleOf(r, 'Untitled'), stage: cols.find((c) => c.id === status)?.name ?? (status || null) };
  }

  /** Mirror a connector's linkKind into a `links` row (deterministic id) — same ops batch (§4). */
  function linkOpFor(kind: 'blocks' | 'related', fromId: string, toId: string): WriteOp {
    return {
      collection: 'links',
      id: linkId(kind, '', fromId, toId),
      patch: { fromType: 'record', fromId, toType: 'record', toId, kind, fieldId: null, deleted: false, createdBy: ctx.userId, createdAt: Date.now() },
    };
  }

  /** Per-item validation + defaults. Throws on bad svg/spec — never stores unsanitized svg. */
  async function canvasItemPatch(moodboardId: string, id: string, item: z.infer<typeof moodItemInput>, knownIds: Set<string>): Promise<{ patch: Record<string, unknown>; extraOps: WriteOp[] }> {
    const patch: Record<string, unknown> = { boardId: moodboardId, type: item.type };
    for (const k of ['x', 'y', 'w', 'h', 'text', 'color', 'title', 'shape', 'fill', 'stroke', 'label', 'style', 'arrow'] as const) {
      if (item[k] !== undefined) patch[k] = item[k];
    }
    if (item.frameStageOf !== undefined) patch.frameStageOf = item.frameStageOf;
    if (item.parentFrameId !== undefined) patch.parentFrameId = item.parentFrameId;
    const extraOps: WriteOp[] = [];
    if (item.type === 'image') {
      if (item.imageUrl) {
        const { fileId } = await importFileFromUrl(ctx.env, item.imageUrl, { parentType: 'mooditem', parentId: id, userId: ctx.userId });
        patch.fileId = fileId;
      } else if (item.fileId) patch.fileId = item.fileId;
    } else if (item.type === 'svg') {
      if (item.fileId) patch.fileId = item.fileId;
      if (item.svg !== undefined) {
        const s = sanitizeSvg(item.svg);
        if (!s.ok) throw new Error(`svg rejected: ${s.reasons.join('; ')}`);
        patch.svg = s.svg;
      }
      if (!patch.svg && !patch.fileId) throw new Error('svg item needs `svg` markup or `fileId`');
    } else if (item.type === 'card') {
      const ref = item.ref ?? (item.taskId ? { type: 'record' as const, id: item.taskId } : undefined);
      if (!ref) throw new Error('card item needs `ref` (or taskId)');
      const target = await rec(ctx.env, ref.type === 'page' ? 'pages' : 'tasks', ref.id);
      if (!target || target.data.deleted) throw new Error(`card ref ${ref.id} not found`);
      patch.ref = { type: ref.type, id: ref.id };
    } else if (item.type === 'diagram') {
      const v = validateDiagramSpec(item.spec);
      if (!v.ok) throw new Error(`diagram spec rejected: ${v.reasons.join('; ')}`);
      patch.spec = v.spec;
    } else if (item.type === 'connector') {
      if (!item.from || !item.to) throw new Error('connector needs `from` and `to`');
      patch.from = item.from;
      patch.to = item.to;
      if (item.linkId !== undefined) patch.linkId = item.linkId;
      if (item.linkKind) patch.linkKind = item.linkKind;
    }
    void knownIds;
    return { patch, extraOps };
  }

  async function moodItemOps(moodboardId: string, items: z.infer<typeof moodItemInput>[], existing: Rec[]): Promise<WriteOp[]> {
    const ops: WriteOp[] = [];
    let z0 = Math.max(0, ...existing.map((i) => Number(i.data.z ?? 0)));
    // Auto-layout: tidy 3-per-row grid to the right of (or below) existing items.
    const originX = existing.length ? Math.max(...existing.map((i) => Number(i.data.x ?? 0) + Number(i.data.w ?? 0))) + 40 : 0;
    const originY = existing.length ? Math.min(...existing.map((i) => Number(i.data.y ?? 0))) : 0;
    let col = 0;
    let rowY = originY;
    let rowH = 0;
    const knownIds = new Set(existing.map((i) => i.id));
    for (const item of items) {
      const id = uuid();
      knownIds.add(id);
      const { patch, extraOps } = await canvasItemPatch(moodboardId, id, item, knownIds);
      if (item.type !== 'connector') {
        const ds = DEFAULT_ITEM_SIZE[item.type] ?? { w: 220, h: 160 };
        const w = item.w ?? ds.w;
        const h = item.h ?? ds.h;
        const auto = item.x === undefined || item.y === undefined;
        patch.w = w;
        patch.h = h;
        if (auto) {
          patch.x = originX + col * 344;
          patch.y = rowY;
          rowH = Math.max(rowH, h);
          col++;
          if (col === 3) {
            col = 0;
            rowY += rowH + 24;
            rowH = 0;
          }
        } else {
          patch.x = item.x;
          patch.y = item.y;
        }
      }
      patch.z = ++z0;
      const normalized = normalizeItem({ id, ...patch } as Partial<MoodItem> & { id: string });
      const { id: _drop, ...data } = normalized;
      void _drop;
      if (data.type === 'connector' && data.linkKind && data.linkId === undefined) {
        // Mirror into a `links` row in the same batch — connector ↔ link share fate (§4).
        const all = [...existing.map((e) => ({ id: e.id, ...e.data })), ...ops.filter((o) => o.collection === 'mooditems').map((o) => ({ id: o.id, ...o.patch }))] as MoodItem[];
        const from = all.find((m) => m.id === data.from);
        const to = all.find((m) => m.id === data.to);
        const rf = from ? cardRef(from) : null;
        const rt = to ? cardRef(to) : null;
        if (!rf || !rt || rf.type !== 'record' || rt.type !== 'record') throw new Error('linkKind connectors need both endpoints to be record cards');
        const lid = linkId(data.linkKind, '', rf.id, rt.id);
        data.linkId = lid;
        const existingLink = await getRec(ctx.env, lid);
        data.linkOwned = !existingLink || existingLink.data.deleted === true;
        extraOps.push(linkOpFor(data.linkKind, rf.id, rt.id));
      }
      ops.push({ collection: 'mooditems', id, patch: data });
      ops.push(...extraOps);
    }
    return ops;
  }

  reg(
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
      await write(ctx, [...ops, activityOp(ctx.userId, ctx.clientName, 'created', 'moodboard', id, title, ctx.cs?.id)]);
      return txt({ id, url: moodUrl(ctx, id) });
    },
  );

  reg(
    'add_mood_items',
    {
      description: 'Add items to a mood board (types: image, note, text, color, card, frame, shape, svg, diagram, connector). Items without x/y are placed in a tidy grid after existing items. svg needs `svg` markup (sanitized) or `fileId`; card needs `ref`; diagram needs `spec`; connector needs `from`/`to` (linkKind mirrors a links row in the same batch).',
      inputSchema: z.object({ moodboardId: z.string(), items: z.array(moodItemInput).min(1), dryRun: dryRunInput }),
      annotations: { idempotentHint: false },
    },
    async (a) => {
      const { moodboardId, items } = a;
      const mb = await rec(ctx.env, 'moodboards', moodboardId);
      if (!mb || mb.data.deleted) return err('mood board not found');
      const existing = live(await recs(ctx.env, 'mooditems')).filter((i) => String(i.data.boardId) === moodboardId);
      const ops = await moodItemOps(moodboardId, items, existing);
      if (a.dryRun) return txt({ dryRun: true, summary: `add_mood_items in ${moodboardId}`, counts: { create: ops.filter((o) => o.collection === 'mooditems').length }, warnings: [], impact: { types: items.map((i) => i.type) } });
      await write(ctx, ops);
      return txt({ moodboardId, added: ops.filter((o) => o.collection === 'mooditems').length, url: moodUrl(ctx, moodboardId) });
    },
  );

  /* ---------- 12b. Phase 2 canvas tools ---------- */

  /** Resolve a moodboard by id (moodboardId|boardId) or exact title (name). */
  async function moodboardFor(id: string | undefined, name: string | undefined): Promise<Rec | null | 'ambiguous'> {
    if (id) {
      const m = await rec(ctx.env, 'moodboards', id);
      return m && !m.data.deleted ? m : null;
    }
    if (!name) return null;
    const all = live(await recs(ctx.env, 'moodboards')).filter((m) => String(m.data.title ?? m.data.name ?? '').toLowerCase() === name.toLowerCase());
    if (all.length > 1) return 'ambiguous';
    return all[0] ?? null;
  }

  server.registerTool(
    'get_moodboard',
    {
      description: 'Get a mood board with all items (each item carries rev for expectedRev writes). Card items include a resolved {title, stage}. Connectors flag `dangling` when their linkId has no live links row.',
      inputSchema: z.object({
        moodboardId: z.string().optional(),
        boardId: z.string().optional(),
        name: z.string().optional().describe('Exact moodboard title'),
      }),
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const mb = await moodboardFor(a.moodboardId ?? a.boardId, a.name);
      if (mb === 'ambiguous') return err('multiple mood boards share that name — pass moodboardId');
      if (!mb) return err('mood board not found');
      const items = await boardItems(mb.id);
      const boardsById = new Map<string, Rec>();
      // linkId → live links row check for connector dangling detection
      const linkIds = items.map((i) => i.data.linkId).filter((x): x is string => typeof x === 'string' && !!x);
      const liveLinks = linkIds.length ? await getRecs(ctx.env, linkIds) : new Map();
      const out = items.map((i) => ({ id: i.id, rev: i.rev, ...(i.data as Record<string, unknown>) }));
      return txt({
        id: mb.id,
        title: mb.data.title ?? 'Mood board',
        rev: mb.rev,
        url: moodUrl(ctx, mb.id),
        items: await Promise.all(
          out.map(async (it) => {
            const m = it as Record<string, unknown>;
            if (m.type === 'card') m.card = await cardInfoFor(cardRef(m as MoodItem), boardsById);
            if (m.type === 'connector' && typeof m.linkId === 'string') {
              const l = liveLinks.get(m.linkId);
              m.dangling = !l || l.data.deleted === true;
            }
            return it;
          }),
        ),
      });
    },
  );

  const ITEM_PATCH_FIELDS = new Set(['x', 'y', 'w', 'h', 'z', 'text', 'color', 'ref', 'taskId', 'title', 'frameStageOf', 'shape', 'fill', 'stroke', 'fileId', 'svg', 'spec', 'from', 'to', 'label', 'style', 'arrow', 'linkKind', 'linkId', 'parentFrameId', 'type', 'deleted']);

  reg(
    'update_mood_items',
    {
      description: 'Patch mood items: {items:[{id, expectedRev?, patch:{...}}]} (flat fields merge into patch). Editable: geometry, text/color, ref, title, frameStageOf, shape/fill/stroke, fileId, svg (sanitized), spec (validated), connector from/to/label/style/arrow/linkKind/linkId, parentFrameId, deleted. boardId/id are not patchable.',
      inputSchema: z.object({
        items: z
          .array(
            z.object({ id: z.string(), expectedRev: z.number().optional(), patch: z.record(z.string(), z.unknown()).optional() }).passthrough(),
          )
          .min(1)
          .max(200),
        dryRun: dryRunInput,
      }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const ids = a.items.map((i) => i.id);
      if (new Set(ids).size !== ids.length) return err('duplicate item ids');
      const found = await getRecs(ctx.env, ids);
      const ops: WriteOp[] = [];
      const expect = new Map<string, number>();
      const skipped: string[] = [];
      // Connector lifecycle bookkeeping: linkId/linkKind/from/to are connector
      // shape — retarget or re-mirror via connect_items, never by raw patch.
      // links rows are GLOBAL (deterministic linkId is shared across boards):
      // referrer accounting must span every moodboard, tombstoned connectors
      // included — only connectorLinkPlan decides retire/transfer.
      const beingDeleted = new Set<string>();
      const referrersByLink = new Map<string, MoodItem[]>();
      const connectorsOnLink = async (lid: string): Promise<MoodItem[]> => {
        let list = referrersByLink.get(lid);
        if (!list) {
          const { results } = await ctx.env.DB
            .prepare(`SELECT id, data FROM records WHERE collection = 'mooditems' AND json_extract(data, '$.type') = 'connector' AND json_extract(data, '$.linkId') = ?`)
            .bind(lid)
            .all<{ id: string; data: string }>();
          list = results.map((r) => ({ id: r.id, ...(JSON.parse(r.data) as Record<string, unknown>) }) as MoodItem);
          referrersByLink.set(lid, list);
        }
        return list;
      };
      for (const upd of a.items) {
        const row = found.get(upd.id);
        const { id: _id, expectedRev, patch: patchObj, ...flat } = upd;
        void _id;
        const patch: Record<string, unknown> = { ...flat, ...(patchObj ?? {}) };
        for (const k of Object.keys(patch)) if (!ITEM_PATCH_FIELDS.has(k)) delete patch[k];
        if (!row || row.collection !== 'mooditems' || (row.data.deleted === true && patch.deleted !== false)) {
          skipped.push(upd.id);
          ctx.warnings.push(`mooditem ${upd.id} not found — skipped`);
          continue;
        }
        if (!Object.keys(patch).length) {
          skipped.push(upd.id);
          continue;
        }
        const isConnector = row.data.type === 'connector' || patch.type === 'connector';
        if (isConnector && (patch.from !== undefined || patch.to !== undefined || patch.linkKind !== undefined || patch.linkId !== undefined || patch.linkOwned !== undefined)) {
          return err(`connector ${upd.id}: linkId/linkKind/from/to/linkOwned are lifecycle fields — use connect_items / delete+recreate`);
        }
        if (!isConnector) {
          delete patch.linkId;
          delete patch.linkKind;
          delete patch.linkOwned;
          delete patch.from;
          delete patch.to;
        }
        const deletesItem = patch.deleted === true || (patch.type !== undefined && patch.type !== 'connector');
        if (isConnector && deletesItem && typeof row.data.linkId === 'string') {
          const lid = String(row.data.linkId);
          // Referrers deleted earlier in this batch aren't live any more, but
          // their ownership flags still count for the connector-minted check.
          const all = (await connectorsOnLink(lid)).map((c) => (beingDeleted.has(c.id) ? { ...c, deleted: true } : c));
          const plan = connectorLinkPlan(row.data as MoodItem, all, upd.id);
          if (plan.retireLink) ops.push({ collection: 'links', id: lid, patch: { deleted: true } });
          if (plan.transferTo) ops.push({ collection: 'mooditems', id: plan.transferTo, patch: { linkOwned: true } });
          if (patch.deleted === true) beingDeleted.add(upd.id);
        }
        const restoresItem = isConnector && patch.deleted === false && typeof row.data.linkId === 'string';
        if (restoresItem && (row.data as MoodItem).linkOwned === true) {
          // Resurrect a mirror this connector owned — only if the row is
          // actually dead (resurrection also un-dangles any other referrer).
          const lid = String(row.data.linkId);
          const linkRow = await getRec(ctx.env, lid);
          if (linkRow?.data.deleted === true) ops.push({ collection: 'links', id: lid, patch: { deleted: false } });
        }
        if (patch.svg !== undefined) {
          const s = sanitizeSvg(patch.svg);
          if (!s.ok) return err(`svg rejected for ${upd.id}: ${s.reasons.join('; ')}`);
          patch.svg = s.svg;
        }
        if (patch.spec !== undefined) {
          const v = validateDiagramSpec(patch.spec);
          if (!v.ok) return err(`diagram spec rejected for ${upd.id}: ${v.reasons.join('; ')}`);
          patch.spec = v.spec;
        }
        if (expectedRev !== undefined) expect.set(upd.id, expectedRev);
        ops.push({ collection: 'mooditems', id: upd.id, patch });
      }
      if (!ops.length) return err('nothing to update');
      if (a.dryRun) return txt({ dryRun: true, summary: `update_mood_items`, counts: { update: ops.length, skipped: skipped.length }, warnings: ctx.warnings, impact: { skipped } });
      await write(ctx, ops, { expect: expect.size ? expect : undefined });
      return txt({ updated: ops.length, skipped });
    },
  );

  reg(
    'connect_items',
    {
      description: `Draw connector(s) between mood items. Single: {moodboardId, from, to, linkKind?, label?, style?, arrow?} or batch via connects:[{from,to,...}]. With linkKind 'blocks'/'related' AND both endpoints card items with record refs, a deterministic links row is written in the same batch and connector.linkId set. Reconnecting an existing from→to pair returns the existing connector.`,
      inputSchema: z.object({
        moodboardId: z.string(),
        from: z.string().optional(),
        to: z.string().optional(),
        linkKind: z.enum(['blocks', 'related']).optional(),
        label: z.string().optional(),
        style: z.enum(['solid', 'dashed']).optional(),
        arrow: z.enum(['end', 'both', 'none']).optional(),
        connects: z
          .array(
            z.object({ from: z.string(), to: z.string(), linkKind: z.enum(['blocks', 'related']).optional(), label: z.string().optional(), style: z.enum(['solid', 'dashed']).optional(), arrow: z.enum(['end', 'both', 'none']).optional() }),
          )
          .optional(),
        dryRun: dryRunInput,
      }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const mb = await rec(ctx.env, 'moodboards', a.moodboardId);
      if (!mb || mb.data.deleted) return err('mood board not found');
      const wants = a.connects?.length ? a.connects : a.from && a.to ? [{ from: a.from, to: a.to, linkKind: a.linkKind, label: a.label, style: a.style, arrow: a.arrow }] : null;
      if (!wants) return err('pass from/to or connects[]');
      const items = await boardItems(a.moodboardId);
      const byId = new Map(items.map((i) => [i.id, i]));
      const depEdges = edgesOf((await listCollection(ctx.env, 'links')).map((l) => l.data));
      const ops: WriteOp[] = [];
      const created: string[] = [];
      const existed: string[] = [];
      const failed: { from: string; to: string; error: string }[] = [];
      let z0 = Math.max(0, ...items.map((i) => Number(i.data.z ?? 0)));
      for (const w2 of wants) {
        const from = byId.get(w2.from);
        const to = byId.get(w2.to);
        if (!from || !to) {
          failed.push({ from: w2.from, to: w2.to, error: 'endpoint item not found on this board' });
          continue;
        }
        const dup = items.find((i) => i.data.type === 'connector' && String(i.data.from) === w2.from && String(i.data.to) === w2.to);
        if (dup) {
          existed.push(dup.id);
          continue;
        }
        const id = uuid();
        const patch: Record<string, unknown> = { boardId: a.moodboardId, type: 'connector', from: w2.from, to: w2.to, z: ++z0 };
        if (w2.label !== undefined) patch.label = w2.label;
        if (w2.style !== undefined) patch.style = w2.style;
        if (w2.arrow !== undefined) patch.arrow = w2.arrow;
        if (w2.linkKind) {
          const rf = cardRef(from.data as MoodItem);
          const rt = cardRef(to.data as MoodItem);
          if (!rf || !rt || rf.type !== 'record' || rt.type !== 'record') {
            failed.push({ from: w2.from, to: w2.to, error: 'linkKind connectors need both endpoints to be record cards' });
            continue;
          }
          if (w2.linkKind === 'blocks' && wouldCreateDependencyCycle([...depEdges, ...ops.filter((o) => o.collection === 'links').map((o) => [String(o.patch.fromId), String(o.patch.toId)] as [string, string])], rf.id, rt.id)) {
            failed.push({ from: w2.from, to: w2.to, error: 'dependency cycle' });
            continue;
          }
          const lid = linkId(w2.linkKind, '', rf.id, rt.id);
          patch.linkKind = w2.linkKind;
          patch.linkId = lid;
          const existing = await getRec(ctx.env, lid);
          patch.linkOwned = !existing || existing.data.deleted === true;
          ops.push({ collection: 'links', id: lid, patch: { fromType: 'record', fromId: rf.id, toType: 'record', toId: rt.id, kind: w2.linkKind, fieldId: null, deleted: false, createdBy: ctx.userId, createdAt: existing?.data.createdAt ?? Date.now() } });
        }
        ops.push({ collection: 'mooditems', id, patch });
        created.push(id);
      }
      if (a.dryRun) return txt({ dryRun: true, summary: `connect_items on ${a.moodboardId}`, counts: { create: created.length, existed: existed.length, failed: failed.length }, warnings: [], impact: { failed } });
      if (ops.length) await write(ctx, ops);
      return txt({ moodboardId: a.moodboardId, created, existed, failed });
    },
  );

  reg(
    'add_frame',
    {
      description: `Create a frame item grouping items on a mood board. bounds omitted → computed to contain itemIds (+40px pad). stage {databaseId, stageId|stage} stores frameStageOf for stage-mirrored frames.`,
      inputSchema: z.object({
        moodboardId: z.string(),
        itemIds: z.array(z.string()).optional(),
        items: z.array(z.string()).optional().describe('alias of itemIds'),
        title: z.string().optional(),
        bounds: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
        stage: z.object({ databaseId: z.string(), stageId: z.string().optional(), stage: z.string().optional() }).optional(),
        dryRun: dryRunInput,
      }),
      annotations: { idempotentHint: false },
    },
    async (a) => {
      const mb = await rec(ctx.env, 'moodboards', a.moodboardId);
      if (!mb || mb.data.deleted) return err('mood board not found');
      const itemIds = a.itemIds ?? a.items ?? [];
      const items = await boardItems(a.moodboardId);
      const byId = new Map(items.map((i) => [i.id, i]));
      const members = itemIds.map((id) => byId.get(id)).filter((x): x is Rec => !!x && x.data.type !== 'frame');
      let bounds = a.bounds;
      if (!bounds) {
        const pad = 40;
        if (members.length) {
          const rects = members.map((m) => itemBounds({ id: m.id, ...(m.data as object) } as MoodItem));
          const x = Math.min(...rects.map((r) => r.x));
          const y = Math.min(...rects.map((r) => r.y));
          bounds = { x: x - pad, y: y - pad, w: Math.max(...rects.map((r) => r.x + r.w)) - x + pad * 2, h: Math.max(...rects.map((r) => r.y + r.h)) - y + pad * 2 };
        } else {
          bounds = { x: 0, y: 0, w: DEFAULT_ITEM_SIZE.frame.w, h: DEFAULT_ITEM_SIZE.frame.h };
        }
      }
      let frameStageOf: { databaseId: string; stageId: string } | undefined;
      if (a.stage) {
        const board = await rec(ctx.env, 'boards', a.stage.databaseId);
        if (!board || board.data.deleted) return err('stage database not found');
        const cols = (board.data.columns ?? []) as { id: string; name: string }[];
        const stage = a.stage;
        const stageId = stage.stageId ?? cols.find((c) => c.name.toLowerCase() === String(stage.stage ?? '').toLowerCase())?.id;
        if (!stageId) return err('stage not found on that database');
        frameStageOf = { databaseId: stage.databaseId, stageId };
      }
      if (a.dryRun) return txt({ dryRun: true, summary: `add_frame on ${a.moodboardId}`, counts: { create: 1, update: members.length }, warnings: [], impact: { members: members.map((m) => m.id) } });
      const id = uuid();
      const z0 = Math.max(0, ...items.map((i) => Number(i.data.z ?? 0))) + 1;
      const ops: WriteOp[] = [
        { collection: 'mooditems', id, patch: { boardId: a.moodboardId, type: 'frame', x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h, z: z0, ...(a.title !== undefined ? { title: a.title } : {}), ...(frameStageOf ? { frameStageOf } : {}) } },
        ...members.map((m) => ({ collection: 'mooditems' as const, id: m.id, patch: { parentFrameId: id } })),
      ];
      await write(ctx, ops);
      return txt({ id, moodboardId: a.moodboardId, bounds, memberCount: members.length, ...(frameStageOf ? { frameStageOf } : {}) });
    },
  );

  reg(
    'layout_moodboard',
    {
      description: `Apply an automatic layout to a mood board. algorithm: 'grid' | 'flow-lr' (connector DAG, cycles → grid) | 'by-frame' (arrange members inside frames) | 'by-stage' (lanes = stage columns; needs cards, optional databaseId). Connectors are never positioned. Returns moved count.`,
      inputSchema: z.object({
        moodboardId: z.string(),
        algorithm: z.enum(['grid', 'flow-lr', 'by-frame', 'by-stage']),
        databaseId: z.string().optional().describe("for 'by-stage': database whose columns become lanes (default: board shared by the most cards)"),
        gap: z.number().optional(),
        wrapWidth: z.number().optional(),
        dryRun: dryRunInput,
      }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const mb = await rec(ctx.env, 'moodboards', a.moodboardId);
      if (!mb || mb.data.deleted) return err('mood board not found');
      const items = await boardItems(a.moodboardId);
      const moodItems = items.map((i) => ({ id: i.id, ...(i.data as object) }) as MoodItem);
      const opts: { gap?: number; wrapWidth?: number; lanes?: string[]; laneOf?: (it: MoodItem) => string | null } = { gap: a.gap, wrapWidth: a.wrapWidth };
      const recByCardItem = new Map<string, Rec>();
      if (a.algorithm === 'by-stage') {
        const cardItems = moodItems.filter((m) => m.type === 'card');
        for (const m of cardItems) {
          const ref = cardRef(m);
          if (ref?.type === 'record') {
            const t = await rec(ctx.env, 'tasks', ref.id);
            if (t) recByCardItem.set(m.id, t);
          }
        }
        let boardId = a.databaseId;
        if (!boardId) {
          const counts = new Map<string, number>();
          for (const t of recByCardItem.values()) {
            const b = String(t.data.boardId ?? 'board-default');
            counts.set(b, (counts.get(b) ?? 0) + 1);
          }
          boardId = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
        }
        const board = boardId ? await rec(ctx.env, 'boards', boardId) : null;
        const cols = ((board?.data.columns ?? []) as { id: string; name: string }[]).map((c) => c.id);
        if (!cols.length) {
          ctx.warnings.push('by-stage needs a staged database — fell back to grid');
          a = { ...a, algorithm: 'grid' };
        } else {
          opts.lanes = cols;
          opts.laneOf = (it) => {
            const t = recByCardItem.get(it.id);
            return t ? String(t.data.status ?? '') : null;
          };
        }
      }
      const rects = layoutBoard(moodItems, a.algorithm as CanvasLayoutAlgorithm, opts);
      const ops: WriteOp[] = [];
      for (const [id, r] of rects) {
        const cur = items.find((i) => i.id === id);
        if (!cur) continue;
        if (Number(cur.data.x) === r.x && Number(cur.data.y) === r.y && Number(cur.data.w) === r.w && Number(cur.data.h) === r.h) continue;
        ops.push({ collection: 'mooditems', id, patch: { x: r.x, y: r.y, w: r.w, h: r.h } });
      }
      if (a.dryRun) return txt({ dryRun: true, summary: `layout_moodboard ${a.algorithm} on ${a.moodboardId}`, counts: { update: ops.length }, warnings: ctx.warnings, impact: {} });
      if (ops.length) await write(ctx, ops);
      return txt({ moodboardId: a.moodboardId, algorithm: a.algorithm, moved: ops.length });
    },
  );

  /** https-only fetch with a byte cap — svg payload for add_svg (≤1MB per §6). */
  async function fetchSvgText(url: string): Promise<string> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error('invalid url');
    }
    if (u.protocol !== 'https:') throw new Error('only https urls are supported');
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`fetch failed (${res.status})`);
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > SVG_MAX_BYTES) throw new Error(`svg exceeds ${SVG_MAX_BYTES} bytes`);
      parts.push(value);
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      buf.set(p, off);
      off += p.length;
    }
    return new TextDecoder().decode(buf);
  }

  reg(
    'add_svg',
    {
      description: `Add an SVG item to a mood board. svg = inline markup; svgUrl = https URL fetched (≤1MB). Both are sanitized server-side and stored inline on the item — unsanitizable input is an error.`,
      inputSchema: z.object({
        moodboardId: z.string(),
        svg: z.string().optional(),
        svgUrl: z.string().optional().describe('https URL of an .svg — fetched and sanitized'),
        x: z.number().optional(),
        y: z.number().optional(),
        w: z.number().optional(),
        h: z.number().optional(),
        parentFrameId: z.string().optional(),
      }),
      annotations: { idempotentHint: false },
    },
    async (a) => {
      if (!a.svg && !a.svgUrl) return err('pass svg or svgUrl');
      if (a.svg && a.svgUrl) return err('pass exactly one of svg/svgUrl');
      const mb = await rec(ctx.env, 'moodboards', a.moodboardId);
      if (!mb || mb.data.deleted) return err('mood board not found');
      const raw = a.svg ?? (await fetchSvgText(a.svgUrl!));
      const s = sanitizeSvg(raw);
      if (!s.ok) return err(`svg rejected: ${s.reasons.join('; ')}`);
      const items = await boardItems(a.moodboardId);
      const id = uuid();
      const z0 = Math.max(0, ...items.map((i) => Number(i.data.z ?? 0))) + 1;
      const patch: Record<string, unknown> = { boardId: a.moodboardId, type: 'svg', svg: s.svg, x: a.x ?? 0, y: a.y ?? 0, w: a.w ?? DEFAULT_ITEM_SIZE.svg.w, h: a.h ?? DEFAULT_ITEM_SIZE.svg.h, z: z0 };
      if (a.parentFrameId) patch.parentFrameId = a.parentFrameId;
      await write(ctx, [{ collection: 'mooditems', id, patch }]);
      return txt({ id, moodboardId: a.moodboardId, bytes: s.svg.length });
    },
  );

  reg(
    'add_diagram',
    {
      description: `Add a diagram to a mood board as ONE mooditem holding the validated spec (edges derive render-side — no connector items). spec = {layout:'auto-lr'|'auto-tb'|'manual', nodes:[{id,label?,...}], edges:[{from,to,label?}]} — ≤200 nodes / ≤400 edges.`,
      inputSchema: z.object({
        moodboardId: z.string(),
        spec: z.unknown().describe('DiagramSpec'),
        x: z.number().optional(),
        y: z.number().optional(),
        w: z.number().optional(),
        h: z.number().optional(),
        parentFrameId: z.string().optional(),
      }),
      annotations: { idempotentHint: false },
    },
    async (a) => {
      const mb = await rec(ctx.env, 'moodboards', a.moodboardId);
      if (!mb || mb.data.deleted) return err('mood board not found');
      const v = validateDiagramSpec(a.spec);
      if (!v.ok) return err(`diagram spec rejected: ${v.reasons.join('; ')}`);
      const items = await boardItems(a.moodboardId);
      const id = uuid();
      const z0 = Math.max(0, ...items.map((i) => Number(i.data.z ?? 0))) + 1;
      const patch: Record<string, unknown> = { boardId: a.moodboardId, type: 'diagram', spec: v.spec, x: a.x ?? 0, y: a.y ?? 0, w: a.w ?? DEFAULT_ITEM_SIZE.diagram.w, h: a.h ?? DEFAULT_ITEM_SIZE.diagram.h, z: z0 };
      if (a.parentFrameId) patch.parentFrameId = a.parentFrameId;
      await write(ctx, [{ collection: 'mooditems', id, patch }]);
      return txt({ id, moodboardId: a.moodboardId, nodes: v.spec.nodes.length, edges: v.spec.edges.length });
    },
  );

  reg(
    'update_diagram',
    {
      description: 'Replace a diagram item\'s spec (validated; expectedRev guards against stale writes).',
      inputSchema: z.object({
        itemId: z.string().optional(),
        id: z.string().optional().describe('alias of itemId'),
        spec: z.unknown().describe('DiagramSpec'),
        expectedRev: z.number().describe('required — the item\'s current rev'),
      }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const id = a.itemId ?? a.id;
      if (!id) return err('pass itemId');
      const row = await getRec(ctx.env, id);
      if (!row || row.collection !== 'mooditems' || row.data.deleted === true) return err('diagram item not found');
      if (row.data.type !== 'diagram') return err('item is not a diagram');
      const v = validateDiagramSpec(a.spec);
      if (!v.ok) return err(`diagram spec rejected: ${v.reasons.join('; ')}`);
      await write(ctx, [{ collection: 'mooditems', id, patch: { spec: v.spec } }], { expect: new Map([[id, a.expectedRev]]) });
      return txt({ id, nodes: v.spec.nodes.length, edges: v.spec.edges.length });
    },
  );

  reg(
    'board_to_canvas',
    {
      description: `Convert a database/board into moodboard frames+cards in one call: one frame per stage (frameStageOf) + one card per record (ref {type:'record'}) parented to its stage frame + 'blocks' dependencies as linkKind connectors. moodboardId/name appends to an existing moodboard (dedupes existing card refs); otherwise a new moodboard is created. layout applies layoutBoard (default 'by-frame').`,
      inputSchema: z.object({
        databaseId: z.string().optional(),
        boardId: z.string().optional().describe('alias of databaseId'),
        moodboardId: z.string().optional().describe('append to this moodboard'),
        name: z.string().optional().describe('append to moodboard with this title (else create new)'),
        title: z.string().optional().describe('title for a newly created moodboard'),
        layout: z.enum(['grid', 'flow-lr', 'by-frame', 'by-stage']).optional(),
        dryRun: dryRunInput,
      }),
      annotations: { idempotentHint: false },
    },
    async (a) => {
      const dbId = a.databaseId ?? a.boardId;
      if (!dbId) return err('pass databaseId');
      const board = await rec(ctx.env, 'boards', dbId);
      if (!board || board.data.deleted) return err('database not found');
      const cols = (board.data.columns ?? []) as { id: string; name: string; color?: string }[];
      const records = live((await listBy(ctx.env, 'tasks', 'boardId', dbId)).map(toRec));

      let mb: Rec | 'ambiguous' | null;
      if (a.moodboardId || a.name) mb = await moodboardFor(a.moodboardId, a.name);
      else mb = null;
      if (mb === 'ambiguous') return err('multiple mood boards share that name — pass moodboardId');
      if (a.moodboardId && !mb) return err('mood board not found');
      const existing = mb ? await boardItems(mb.id) : [];
      const existingRefs = new Set(existing.filter((i) => i.data.type === 'card').map((i) => cardRef(i.data as MoodItem)?.id).filter(Boolean));
      // Existing cards map ref→item so dep connectors can point at them too.
      const cardIdByRec = new Map<string, string>();
      for (const i of existing) {
        if (i.data.type !== 'card') continue;
        const r = cardRef(i.data as MoodItem);
        if (r) cardIdByRec.set(r.id, i.id);
      }

      const FRAME_W = 340;
      const FRAME_GAP = 60;
      const CARD_GAP = 20;
      const PAD = 40;
      const perCol = new Map<string, Rec[]>();
      for (const t of records) {
        const st = String(t.data.status ?? cols[0]?.id ?? '');
        const list = perCol.get(st) ?? [];
        list.push(t);
        perCol.set(st, list);
      }
      const ops: WriteOp[] = [];
      let newCards = 0;
      let z0 = mb ? Math.max(0, ...existing.map((i) => Number(i.data.z ?? 0))) : 0;
      const frameIdByStage = new Map<string, string>();
      cols.forEach((col, i) => {
        const n = perCol.get(col.id)?.length ?? 0;
        const fid = uuid();
        frameIdByStage.set(col.id, fid);
        const h = Math.max(DEFAULT_ITEM_SIZE.frame.h, PAD * 2 + n * (DEFAULT_ITEM_SIZE.card.h + CARD_GAP));
        ops.push({ collection: 'mooditems', id: fid, patch: { boardId: '', type: 'frame', title: col.name, frameStageOf: { databaseId: dbId, stageId: col.id }, x: i * (FRAME_W + FRAME_GAP), y: 0, w: FRAME_W, h } });
      });
      const orphanRecs = perCol.get('') ?? [];
      let orphanFrameId: string | null = null;
      const cardOps = (t: Rec, fid: string) => {
        if (existingRefs.has(t.id)) return;
        const cid = uuid();
        cardIdByRec.set(t.id, cid);
        newCards++;
        ops.push({ collection: 'mooditems', id: cid, patch: { boardId: '', type: 'card', ref: { type: 'record', id: t.id }, parentFrameId: fid, x: 0, y: 0, w: DEFAULT_ITEM_SIZE.card.w, h: DEFAULT_ITEM_SIZE.card.h } });
      };
      for (const col of cols) (perCol.get(col.id) ?? []).forEach((t) => cardOps(t, frameIdByStage.get(col.id)!));
      if (orphanRecs.length) {
        orphanFrameId = uuid();
        ops.push({ collection: 'mooditems', id: orphanFrameId, patch: { boardId: '', type: 'frame', title: 'No stage', x: cols.length * (FRAME_W + FRAME_GAP), y: 0, w: FRAME_W, h: Math.max(DEFAULT_ITEM_SIZE.frame.h, PAD * 2 + orphanRecs.length * (DEFAULT_ITEM_SIZE.card.h + CARD_GAP)) } });
        orphanRecs.forEach((t) => cardOps(t, orphanFrameId!));
      }
      // 'blocks' deps between records that both got cards → connector + mirrored links row.
      const depLinks = (await listCollection(ctx.env, 'links')).filter((l) => !l.data.deleted && l.data.kind === 'blocks');
      let connectors = 0;
      const connSeen = new Set(existing.filter((i) => i.data.type === 'connector').map((i) => `${i.data.from}->${i.data.to}`));
      for (const l of depLinks) {
        const f = cardIdByRec.get(String(l.data.fromId));
        const t = cardIdByRec.get(String(l.data.toId));
        if (!f || !t || connSeen.has(`${f}->${t}`)) continue;
        connSeen.add(`${f}->${t}`);
        connectors++;
        ops.push(
          { collection: 'mooditems', id: uuid(), patch: { boardId: '', type: 'connector', from: f, to: t, linkKind: 'blocks', linkId: l.id } },
        );
      }
      const mbId = mb?.id ?? uuid();
      for (const o of ops) {
        (o.patch as Record<string, unknown>).boardId = mbId;
        o.patch.z = ++z0;
      }
      const algorithm = (a.layout ?? 'by-frame') as CanvasLayoutAlgorithm;
      // Apply layout to the freshly minted geometry (single write, LWW).
      const staged = [...existing.map((i) => ({ id: i.id, ...(i.data as object) }) as MoodItem), ...ops.filter((o) => o.collection === 'mooditems').map((o) => ({ id: o.id, ...(o.patch as object) }) as MoodItem)];
      const rects = layoutBoard(staged, algorithm, {});
      for (const o of ops) {
        if (o.collection !== 'mooditems') continue;
        const r = rects.get(o.id);
        if (r && o.patch.type !== 'connector') Object.assign(o.patch, { x: r.x, y: r.y, w: r.w, h: r.h });
      }
      if (a.dryRun) {
        return txt({ dryRun: true, summary: `board_to_canvas ${dbId} → ${mb ? mb.id : 'new moodboard'}`, counts: { frames: frameIdByStage.size + (orphanFrameId ? 1 : 0), cards: newCards, connectors, skippedExisting: records.length - newCards }, warnings: [], impact: {} });
      }
      if (!mb) ops.push({ collection: 'moodboards', id: mbId, patch: { title: a.title ?? `${titleOf(board, 'Board')} canvas`, icon: '🎨', order: String(Date.now()), createdBy: ctx.userId, createdAt: Date.now() } });
      ops.push(activityOp(ctx.userId, ctx.clientName, 'created', 'moodboard', mbId, a.title ?? String(board.data.name ?? 'canvas'), ctx.cs?.id));
      await write(ctx, ops);
      return txt({
        moodboardId: mbId,
        created: !mb,
        url: moodUrl(ctx, mbId),
        frames: frameIdByStage.size + (orphanFrameId ? 1 : 0),
        cards: newCards,
        connectors,
        skippedExisting: records.length - newCards,
        frameIds: [...frameIdByStage.values()],
        cardIds: [...cardIdByRec.values()],
      });
    },
  );

  reg(
    'share_moodboard',
    {
      description: 'Publish (or unpublish) a mood board as a read-only public canvas link. Returns /s/canvas/<token>.',
      inputSchema: z.object({ moodboardId: z.string(), enabled: z.boolean().optional() }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const mb = await rec(ctx.env, 'moodboards', a.moodboardId);
      if (!mb || mb.data.deleted) return err('mood board not found');
      if (a.enabled === false) {
        await ctx.env.DB.prepare(`DELETE FROM shares WHERE page_id = ? AND target_type = 'moodboard'`).bind(a.moodboardId).run();
        return txt({ enabled: false });
      }
      const existing = await ctx.env.DB.prepare(`SELECT token FROM shares WHERE page_id = ? AND target_type = 'moodboard'`).bind(a.moodboardId).first<{ token: string }>();
      const token = existing?.token ?? randomToken();
      if (!existing) await ctx.env.DB.prepare(`INSERT INTO shares (token, target_type, page_id, created_by, created_at) VALUES (?, 'moodboard', ?, ?, ?)`).bind(token, a.moodboardId, ctx.userId, Date.now()).run();
      return txt({ enabled: true, token, url: `${ctx.origin}/s/canvas/${token}`, api: `${ctx.origin}/api/public/canvas/${token}` });
    },
  );

  /* ---------- 13. comments ---------- */

  reg(
    'add_comment',
    {
      description: 'Add a comment to a task, page, block or mood item. @handle mentions are resolved.',
      inputSchema: z.object({ targetType: z.enum(['task', 'page', 'block', 'mooditem']), targetId: z.string(), text: z.string() }),
      annotations: { idempotentHint: false },
    },
    async ({ targetType, targetId, text }) => {
      await fillCaches(ctx);
      const body = resolveMentionText(text, { resolveUser: resolverFor(ctx, 'user') });
      const id = uuid();
      await write(ctx, [
        { collection: 'comments', id, patch: { targetType, targetId, body, authorId: ctx.userId, createdAt: Date.now() } },
        activityOp(ctx.userId, ctx.clientName, 'commented', targetType, targetId, 'comment', ctx.cs?.id),
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
      const all = (await listBy(ctx.env, 'comments', 'targetId', targetId))
        .map(toRec)
        .filter((c) => c.data.targetType === targetType)
        .sort((a, b) => Number(a.data.createdAt ?? 0) - Number(b.data.createdAt ?? 0));
      return txt({
        comments: all.map((c) => ({ id: c.id, author: ctx.userNameById.get(String(c.data.authorId ?? '')), body: renderMentionText(String(c.data.body ?? ''), { userName: (id) => ctx.userNameById.get(id) }), createdAt: c.data.createdAt })),
      });
    },
  );

  /* ---------- 14. publish_page ---------- */

  reg(
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
      return txt({ templates: pages.map((p) => ({ id: p.id, title: titleOf(p, 'Untitled'), icon: p.data.icon, rev: p.rev, url: pageUrl(ctx, p.id) })) });
    },
  );

  async function snapshot(env: Env): Promise<RecSnapshot> {
    const [pages, blocks, boards, tasks, views, links] = await Promise.all([recs(env, 'pages'), recs(env, 'blocks'), recs(env, 'boards'), recs(env, 'tasks'), recs(env, 'views'), recs(env, 'links')]);
    const map = (rs: Rec[]) => Object.fromEntries(rs.map((r) => [r.id, r.data]));
    return { pages: map(pages), blocks: map(blocks), boards: map(boards), tasks: map(tasks), views: map(views), links: map(links) };
  }

  reg(
    'create_from_template',
    {
      description: 'Instantiate a template page: deep-copies the page tree ({{name}} placeholders substituted), copies embedded task boards with their tasks.',
      inputSchema: z.object({
        templateId: z.string(),
        title: z.string().optional(),
        parentId: z.string().nullable().optional(),
        variables: z.record(z.string(), z.string()).optional().describe('{{placeholder}} → value map'),
        dryRun: dryRunInput,
      }),
      annotations: { idempotentHint: false },
    },
    async ({ templateId, title, parentId, variables, dryRun }) => {
      const plan = planTemplateInstantiation(await snapshot(ctx.env), { templateId, title, parentId, variables, actorId: ctx.userId }, { id: uuid, now: Date.now() });
      if (!plan) return err('template not found');
      if (dryRun) return txt({ dryRun: true, summary: `instantiate template ${templateId}`, counts: { records: plan.writes.length }, warnings: [], impact: { byCollection: plan.writes.reduce((m: Record<string, number>, w: WriteOp) => ((m[w.collection] = (m[w.collection] ?? 0) + 1), m), {}) } });
      await write(ctx, [...plan.writes, activityOp(ctx.userId, ctx.clientName, 'created', 'page', plan.rootPageId, title ?? 'From template', ctx.cs?.id)]);
      return txt({ pageId: plan.rootPageId, url: pageUrl(ctx, plan.rootPageId), records: plan.writes.length });
    },
  );

  /* ---------- 16. create_project ---------- */

  reg(
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
        dryRun: dryRunInput,
      }),
      annotations: { idempotentHint: false },
    },
    async (a) => {
      await fillCaches(ctx);
      if (a.dryRun) {
        const countPages = (ns: ChildNode[]): number => ns.reduce((n, x) => n + 1 + countPages((x.children ?? []) as ChildNode[]), 0);
        return txt({ dryRun: true, summary: `create_project "${a.title}"`, counts: { pages: 1 + countPages((a.pages ?? []) as ChildNode[]), tasks: a.board?.tasks?.length ?? 0, moodItems: a.moodboard?.items?.length ?? 0, boards: a.board ? 1 : 0 }, warnings: [], impact: {} });
      }
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
              assigneeId: t.assignee ? (resolveAssignee(ctx, t.assignee)) : null,
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
      ops.push(activityOp(ctx.userId, ctx.clientName, 'created', 'page', rootId, a.title, ctx.cs?.id));
      await write(ctx, ops);
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

  const deleteTypes = z.enum(['page', 'task', 'record', 'board', 'view', 'link', 'moodboard', 'mooditem', 'comment', 'file', 'block']);
  const typeToColl: Record<string, Collection> = {
    page: 'pages',
    task: 'tasks',
    record: 'tasks',
    board: 'boards',
    view: 'views',
    link: 'links',
    moodboard: 'moodboards',
    mooditem: 'mooditems',
    comment: 'comments',
    file: 'files',
    block: 'blocks',
  };

  reg(
    'delete_item',
    {
      description: 'Soft-delete an item (page, task, board, moodboard, mooditem, comment, file, block). Requires expectedRev. Call with dryRun:true first and show the user the impact before deleting. Recoverable via restore_item / undo_change.',
      inputSchema: z.object({
        type: deleteTypes,
        id: z.string(),
        expectedRev: z.number().describe('The record rev from a read — required so you never delete a record changed since you saw it'),
        taskAction: z.enum(['move_to_default', 'delete']).optional().describe('Board delete: what to do with live tasks (default move_to_default)'),
        dryRun: dryRunInput,
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (a) => {
      const { type, id } = a;
      const collection = typeToColl[type];
      const r = await rec(ctx.env, collection, id);
      if (!r) return err(`${type} not found`);
      if (r.data.deleted) return txt({ type, id, deleted: true, already: true });

      // ---- gather the rows a delete touches (targeted reads only) ----
      const impType = (type === 'page' ? 'page' : type === 'record' ? 'task' : type) as 'page' | 'board' | 'task' | 'comment' | 'file' | 'moodboard' | 'mooditem';
      // record/task deletes cascade to sub-records (deletedVia = parent id)
      const subRecordIds: string[] = [];
      let pages: ImpactRow[] = [{ id, collection, data: r.data }];
      const blocks: ImpactRow[] = [];
      const tasks: ImpactRow[] = [];
      const comments: ImpactRow[] = [];
      const filesR: ImpactRow[] = [];
      const mooditems: ImpactRow[] = [];
      let shareCount = 0;
      let backlinkCount = 0;
      let descendantIds: string[] = [];
      const boardTasks: Rec[] = [];

      if (impType === 'page') {
        // full descendant closure: page children via parentId index
        const allPages = live(await recs(ctx.env, 'pages'));
        const byParent = new Map<string, Rec[]>();
        for (const p of allPages) {
          const pid = String(p.data.parentId ?? '');
          if (!pid) continue;
          const l = byParent.get(pid) ?? [];
          l.push(p);
          byParent.set(pid, l);
        }
        const queue = [id];
        while (queue.length) {
          const cur = queue.shift()!;
          for (const ch of byParent.get(cur) ?? []) {
            descendantIds.push(ch.id);
            queue.push(ch.id);
          }
        }
        pages = [{ id, collection, data: r.data }, ...descendantIds.map((d) => ({ id: d, collection: 'pages', data: allPages.find((p) => p.id === d)!.data }))];
        const allIds = [id, ...descendantIds];
        for (const pid of allIds) {
          blocks.push(...(await listBy(ctx.env, 'blocks', 'pageId', pid)).map((x) => ({ id: x.id, collection: 'blocks', data: x.data })));
          filesR.push(...(await listBy(ctx.env, 'files', 'parentId', pid)).map((x) => ({ id: x.id, collection: 'files', data: x.data })));
        }
        const taskBlockIds = new Set(blocks.filter((b) => b.data.type === 'tasks').map((b) => b.id));
        for (const bid of taskBlockIds) {
          tasks.push(...(await listBy(ctx.env, 'tasks', 'blockId', bid)).map((x) => ({ id: x.id, collection: 'tasks', data: x.data })));
        }
        const shares = await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM shares WHERE page_id = ?').bind(id).first<{ n: number }>();
        shareCount = shares?.n ?? 0;
        const bl = await ctx.env.DB.prepare(`SELECT COUNT(*) AS n FROM records WHERE collection = 'blocks' AND instr(data, ?) > 0 AND COALESCE(json_extract(data, '$.deleted'), 0) != 1`).bind(`@[page:${id}]`).first<{ n: number }>();
        backlinkCount = bl?.n ?? 0;
      } else if (impType === 'board') {
        boardTasks.push(...(await listBy(ctx.env, 'tasks', 'boardId', id)).map(toRec));
        tasks.push(...boardTasks.map((t) => ({ id: t.id, collection: 'tasks', data: t.data })));
      } else if (impType === 'task') {
        comments.push(...(await listBy(ctx.env, 'comments', 'targetId', id)).map((x) => ({ id: x.id, collection: 'comments', data: x.data })));
        filesR.push(...(await listBy(ctx.env, 'files', 'parentId', id)).map((x) => ({ id: x.id, collection: 'files', data: x.data })));
        mooditems.push(...(await listBy(ctx.env, 'mooditems', 'taskId', id)).map((x) => ({ id: x.id, collection: 'mooditems', data: x.data })));
        // sub-record cascade (deletedVia marks who removed them so restore can scope)
        const dbId = String(r.data.boardId ?? '');
        const all = live((await listBy(ctx.env, 'tasks', 'boardId', dbId)).map(toRec));
        const parentOf = new Map(all.map((t) => [t.id, (t.data.parentId as string | null) ?? null]));
        const { descendants } = await import('../shared/tree');
        for (const d of descendants(parentOf, id)) {
          subRecordIds.push(d);
          const dRow = all.find((t) => t.id === d);
          if (dRow) tasks.push({ id: d, collection: 'tasks', data: dRow.data });
        }
      }

      const impact = planDeleteImpact({ pages, blocks, tasks, comments, files: filesR, mooditems, shares: shareCount, backlinks: backlinkCount }, impType, id);
      if (a.dryRun) return txt({ dryRun: true, summary: impact.summary, counts: impact.counts, warnings: impact.warnings, impact: { ids: impact.ids } });

      const expect = new Map([[id, a.expectedRev]]);
      const ops: WriteOp[] = [{ collection, id, patch: { deleted: true } }];
      for (const pid of descendantIds) ops.push({ collection: 'pages', id: pid, patch: { deleted: true } });
      for (const b of impact.ids.blocks ?? []) ops.push({ collection: 'blocks', id: b, patch: { deleted: true } });
      for (const f of impact.ids.files ?? []) ops.push({ collection: 'files', id: f, patch: { deleted: true } });
      if (impType === 'page') {
        for (const t of impact.ids.tasks ?? []) ops.push({ collection: 'tasks', id: t, patch: { deleted: true } });
        await ctx.env.DB.prepare('DELETE FROM shares WHERE page_id = ?').bind(id).run();
      }
      if (impType === 'board') {
        const action = a.taskAction ?? 'move_to_default';
        for (const t of boardTasks) {
          ops.push({ collection: 'tasks', id: t.id, patch: action === 'delete' ? { deleted: true } : { boardId: null, status: 'todo' } });
        }
      }
      if (impType === 'task') {
        for (const cm of impact.ids.comments ?? []) ops.push({ collection: 'comments', id: cm, patch: { deleted: true } });
        for (const sid of subRecordIds) ops.push({ collection: 'tasks', id: sid, patch: { deleted: true, deletedVia: id } });
      }
      ops.push(activityOp(ctx.userId, ctx.clientName, 'deleted', type, id, String(r.data.title ?? r.data.name ?? type), ctx.cs?.id));
      await write(ctx, ops, { expect });
      return txt({ type, id, deleted: true, impact: { counts: impact.counts, warnings: impact.warnings } });
    },
  );

  reg(
    'restore_item',
    {
      description: 'Restore a soft-deleted item.',
      inputSchema: z.object({ type: deleteTypes, id: z.string(), expectedRev: z.number().optional().describe('Record rev from a read — recommended') }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const { type, id } = a;
      const collection = typeToColl[type];
      const r = await rec(ctx.env, collection, id);
      if (!r) return err(`${type} not found`);
      const expect = a.expectedRev !== undefined ? new Map([[id, a.expectedRev]]) : undefined;
      const ops: WriteOp[] = [{ collection, id, patch: { deleted: false } }];
      if (collection === 'tasks') {
        for (const d of (await listBy(ctx.env, 'tasks', 'deletedVia', id, { includeDeleted: true }))) ops.push({ collection: 'tasks', id: d.id, patch: { deleted: false, deletedVia: null } });
      }
      await write(ctx, ops, { expect });
      return txt({ type, id, restored: true, ...(a.expectedRev === undefined ? { unchecked: [id] } : {}) });
    },
  );

  /* ---------- 19. CAS stage/field ops (Phase 0 §6) ---------- */

  const boardOr404 = async (boardId: string) => {
    const b = await rec(ctx.env, 'boards', boardId);
    return !b || b.data.deleted ? null : b;
  };

  const colsOf = (b: Rec) => boardColumns(b);

  reg(
    'find_or_create_page',
    {
      description: 'Find a live page by title among siblings of the same parent (case-insensitive); creates it when missing. Natural-key dedupe for agents.',
      inputSchema: z.object({ title: z.string(), parentId: z.string().nullable().optional(), markdown: z.string().optional(), icon: z.string().optional() }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      await fillCaches(ctx);
      const sibs = live(a.parentId ? (await listBy(ctx.env, 'pages', 'parentId', a.parentId)).map(toRec) : live(await recs(ctx.env, 'pages')).filter((p) => !p.data.parentId));
      const found = sibs.find((p) => String(p.data.title ?? '').toLowerCase() === a.title.toLowerCase());
      if (found) return txt({ id: found.id, title: titleOf(found, 'Untitled'), rev: found.rev, url: pageUrl(ctx, found.id), existed: true });
      const id = uuid();
      const order = orderBetween(sibs.length ? String(sibs.sort(byOrder)[sibs.length - 1].data.order ?? '') || null : null, null);
      const ops: WriteOp[] = [{ collection: 'pages', id, patch: { title: a.title, icon: a.icon ?? '📄', parentId: a.parentId ?? null, order, isTemplate: false, createdBy: ctx.userId, createdAt: Date.now() } }];
      if (a.markdown) ops.push(...(await blockOps(ctx, id, a.markdown, [])));
      ops.push(activityOp(ctx.userId, ctx.clientName, 'created', 'page', id, a.title, ctx.cs?.id));
      await write(ctx, ops);
      return txt({ id, url: pageUrl(ctx, id), existed: false });
    },
  );

  reg(
    'add_stage',
    {
      description: 'Add a stage (column) to a board. Idempotent by name (case-insensitive): re-adding an existing name returns the existing stage.',
      inputSchema: z.object({ boardId: z.string(), name: z.string(), color: z.string().optional(), expectedRev: z.number().optional() }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const board = await boardOr404(a.boardId);
      if (!board) return err('board not found');
      const out = await cas('boards', a.boardId, (data) => {
        const cols = Array.isArray(data.columns) ? [...(data.columns as { id: string; name: string; color: string }[])] : [];
        if (cols.some((c) => c.name.toLowerCase() === a.name.toLowerCase())) return null; // idempotent no-op
        cols.push({ id: uuid().slice(0, 8), name: a.name, color: a.color ?? COLUMN_COLORS[cols.length % COLUMN_COLORS.length] });
        return { columns: cols };
      });
      if ('conflict' in out) return err('concurrent board edits — retry');
      if ('notFound' in out) return err('board not found');
      const cols = colsOf({ id: board.id, data: out.row.data, rev: out.row.rev, updatedBy: null, updatedAt: null });
      const added = cols.find((c) => c.name.toLowerCase() === a.name.toLowerCase());
      return txt({ boardId: a.boardId, stage: added, existed: !out.result.applied.length });
    },
  );

  reg(
    'update_stage',
    {
      description: 'Rename or recolor a stage by id or current name.',
      inputSchema: z.object({ boardId: z.string(), stage: z.string().describe('Stage id or name'), name: z.string().optional(), color: z.string().optional(), expectedRev: z.number().optional() }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const board = await boardOr404(a.boardId);
      if (!board) return err('board not found');
      const out = await cas('boards', a.boardId, (data) => {
        const cols = Array.isArray(data.columns) ? [...(data.columns as { id: string; name: string; color: string }[])] : [];
        const col = cols.find((c) => c.id === a.stage || c.name.toLowerCase() === a.stage.toLowerCase());
        if (!col) throw new Error(`stage ${a.stage} not found`);
        if (a.name !== undefined) col.name = a.name;
        if (a.color !== undefined) col.color = a.color;
        return { columns: cols };
      });
      if ('conflict' in out) return err('concurrent board edits — retry');
      if ('notFound' in out) return err('board not found');
      return txt({ boardId: a.boardId, stage: a.stage, updated: true });
    },
  );

  reg(
    'remove_stage',
    {
      description: 'Remove a stage. Refuses to remove the last stage. Live tasks in the stage are moved to moveTasksTo (or the first remaining stage) in the same change set. Call with dryRun:true first.',
      inputSchema: z.object({
        boardId: z.string(),
        stage: z.string().describe('Stage id or name'),
        moveTasksTo: z.string().optional().describe('Target stage id/name for live tasks (default: first remaining)'),
        expectedRev: z.number().optional(),
        dryRun: dryRunInput,
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (a) => {
      const board = await boardOr404(a.boardId);
      if (!board) return err('board not found');
      const cols = colsOf(board);
      const col = cols.find((c) => c.id === a.stage || c.name.toLowerCase() === a.stage.toLowerCase());
      if (!col) return err(`stage ${a.stage} not found`);
      if (cols.length <= 1) return err('cannot remove the last stage');
      const rest = cols.filter((c) => c.id !== col.id);
      const target = a.moveTasksTo ? rest.find((c) => c.id === a.moveTasksTo || c.name.toLowerCase() === a.moveTasksTo!.toLowerCase()) : rest[0];
      if (!target) return err(`moveTasksTo ${a.moveTasksTo} not found among remaining stages`);
      const affected = (a.boardId === 'board-default' ? (await listDefaultBoardTasks(ctx.env)).map(toRec) : (await listBy(ctx.env, 'tasks', 'boardId', a.boardId)).map(toRec)).filter((t) => String(t.data.status ?? '') === col.id);
      if (a.dryRun) return txt({ dryRun: true, summary: `remove stage "${col.name}" from board ${a.boardId}`, counts: { tasksMoved: affected.length }, warnings: affected.length ? [`${affected.length} task(s) move to "${target.name}"`] : [], impact: { tasks: affected.map((t) => t.id), toStage: target.id } });
      const out = await cas('boards', a.boardId, (data) => {
        const cur = Array.isArray(data.columns) ? (data.columns as { id: string; name: string; color: string }[]) : [];
        if (!cur.some((c) => c.id === col.id)) return null;
        return { columns: cur.filter((c) => c.id !== col.id) };
      });
      if ('conflict' in out) return err('concurrent board edits — retry');
      if ('notFound' in out) return err('board not found');
      const ops: WriteOp[] = affected.map((t) => ({ collection: 'tasks' as Collection, id: t.id, patch: { status: target.id } }));
      if (ops.length) await write(ctx, ops);
      return txt({ boardId: a.boardId, removed: col.id, tasksMoved: affected.length, movedTo: target.id });
    },
  );

  const fieldInputSchema = z.object({
    name: z.string(),
    type: z.enum(['text', 'number', 'select', 'multi_select', 'person', 'date', 'url', 'checkbox', 'relation']),
    options: z.array(z.union([z.string(), z.object({ name: z.string(), color: z.string().optional() })])).optional(),
    showOnCard: z.boolean().optional(),
    target: z.string().optional().describe("relation: target database id/name or 'pages'"),
    twoWay: z.boolean().optional().describe('relation: create the reverse field on the target database'),
    reverseName: z.string().optional(),
    single: z.boolean().optional(),
  });

  const mkOptions = (raw: (string | { name: string; color?: string })[] | undefined, existing?: { id: string; name: string; color: string }[]) =>
    (raw ?? []).map((o, j) => (typeof o === 'string' ? { id: existing?.find((e) => e.name.toLowerCase() === o.toLowerCase())?.id ?? uuid().slice(0, 8), name: o, color: existing?.find((e) => e.name.toLowerCase() === o.toLowerCase())?.color ?? COLUMN_COLORS[j % COLUMN_COLORS.length] } : { id: existing?.find((e) => e.name.toLowerCase() === o.name.toLowerCase())?.id ?? uuid().slice(0, 8), name: o.name, color: o.color ?? COLUMN_COLORS[j % COLUMN_COLORS.length] }));

  reg(
    'add_field',
    {
      description: 'Add a custom field to a board. Idempotent by name (case-insensitive): same name + same type returns the existing field; same name + different type is an error.',
      inputSchema: z.object({ boardId: z.string(), field: fieldInputSchema, expectedRev: z.number().optional() }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const board = await boardOr404(a.boardId);
      if (!board) return err('board not found');
      if (a.field.type === 'relation') {
        const boards = live(await recs(ctx.env, 'boards'));
        const targetBoard = a.field.target === 'pages' ? null : boards.find((b) => b.id === a.field.target || String(b.data.name ?? '').toLowerCase() === String(a.field.target ?? '').toLowerCase()) ?? null;
        if (a.field.target !== 'pages' && !targetBoard) return err(`relation target database "${a.field.target}" not found`);
        const fId = uuid().slice(0, 8);
        const pId = a.field.twoWay ? uuid().slice(0, 8) : null;
        const out = await cas('boards', a.boardId, (data) => {
          const fields = fieldsOf(data).map((f) => ({ ...f }));
          const ex = fields.find((f) => f.name.toLowerCase() === a.field.name.toLowerCase());
          if (ex) {
            if (ex.type !== 'relation') throw new Error(`field "${a.field.name}" exists with type ${ex.type}`);
            return null;
          }
          fields.push({ id: fId, name: a.field.name, type: 'relation', relation: { target: a.field.target === 'pages' ? 'pages' : targetBoard!.id, pairedFieldId: pId, single: a.field.single, primary: true } });
          return { fields };
        });
        if ('conflict' in out) return err('concurrent board edits — retry');
        if ('notFound' in out) return err('board not found');
        if (pId && targetBoard) {
          const outB = await cas('boards', targetBoard.id, (d) => {
            const fs = fieldsOf(d).map((x) => ({ ...x }));
            if (fs.some((x) => x.name.toLowerCase() === (a.field.reverseName ?? a.field.name).toLowerCase())) return null;
            fs.push({ id: pId, name: a.field.reverseName ?? String(board.data.name ?? 'Related'), type: 'relation', relation: { target: a.boardId, pairedFieldId: fId, single: false, primary: false } });
            return { fields: fs };
          });
          if ('conflict' in outB || 'notFound' in outB) ctx.warnings.push('reverse relation field failed on concurrent edit');
        }
        const fresh = await rec(ctx.env, 'boards', a.boardId);
        const field = fresh ? fieldsOf(fresh.data).find((f) => f.id === fId) ?? null : null;
        return txt({ boardId: a.boardId, field, existed: !out.result.applied.length });
      }
      const out = await cas('boards', a.boardId, (data) => {
        const fields = fieldsOf(data).map((f) => ({ ...f, options: f.options ? [...f.options] : undefined }));
        const existing = fields.find((f) => f.name.toLowerCase() === a.field.name.toLowerCase());
        if (existing) {
          if (existing.type !== a.field.type) throw new Error(`field "${a.field.name}" exists with type ${existing.type} (requested ${a.field.type})`);
          return null; // idempotent
        }
        fields.push({ id: uuid().slice(0, 8), name: a.field.name, type: a.field.type, showOnCard: a.field.showOnCard, options: isSelectType(a.field.type) ? mkOptions(a.field.options) : undefined });
        return { fields };
      });
      if ('conflict' in out) return err('concurrent board edits — retry');
      if ('notFound' in out) return err('board not found');
      const fresh2 = await rec(ctx.env, 'boards', a.boardId);
      const field = fresh2 ? fieldsOf(fresh2.data).find((f) => f.name.toLowerCase() === a.field.name.toLowerCase()) : undefined;
      return txt({ boardId: a.boardId, field, existed: !out.result.applied.length });
    },
  );

  reg(
    'update_field',
    {
      description: 'Update a custom field: rename, showOnCard, add/rename/remove select options. Option ids are NEVER rewritten — existing task values stay valid.',
      inputSchema: z.object({
        boardId: z.string(),
        field: z.string().describe('Field id or name'),
        name: z.string().optional(),
        showOnCard: z.boolean().optional(),
        addOptions: z.array(z.union([z.string(), z.object({ name: z.string(), color: z.string().optional() })])).optional(),
        renameOptions: z.record(z.string(), z.string()).optional().describe('{optionId: newName}'),
        removeOptions: z.array(z.string()).optional().describe('Option ids to remove'),
        expectedRev: z.number().optional(),
      }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const board = await boardOr404(a.boardId);
      if (!board) return err('board not found');
      const out = await cas('boards', a.boardId, (data) => {
        const fields = fieldsOf(data).map((f) => ({ ...f, options: f.options ? [...f.options] : undefined }));
        const f = fields.find((x) => x.id === a.field || x.name.toLowerCase() === a.field.toLowerCase());
        if (!f) throw new Error(`field ${a.field} not found`);
        if (a.name !== undefined) f.name = a.name;
        if (a.showOnCard !== undefined) f.showOnCard = a.showOnCard;
        if (isSelectType(f.type)) {
          const opts = [...(f.options ?? [])];
          for (const o of a.addOptions ?? []) {
            const name = typeof o === 'string' ? o : o.name;
            if (opts.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
            opts.push({ id: uuid().slice(0, 8), name, color: (typeof o === 'object' ? o.color : undefined) ?? COLUMN_COLORS[opts.length % COLUMN_COLORS.length] });
          }
          for (const [optId, newName] of Object.entries(a.renameOptions ?? {})) {
            const o = opts.find((x) => x.id === optId);
            if (o) o.name = newName;
          }
          for (const optId of a.removeOptions ?? []) {
            const i = opts.findIndex((x) => x.id === optId);
            if (i >= 0) opts.splice(i, 1);
          }
          f.options = opts;
        }
        return { fields };
      });
      if ('conflict' in out) return err('concurrent board edits — retry');
      if ('notFound' in out) return err('board not found');
      const field = fieldsOf(out.row.data).find((x) => x.id === a.field || x.name === a.field);
      return txt({ boardId: a.boardId, field });
    },
  );

  reg(
    'remove_field',
    {
      description: 'Remove a custom field. Existing p_<id> values on tasks are left in place (display ignores them). Call with dryRun:true first.',
      inputSchema: z.object({ boardId: z.string(), field: z.string().describe('Field id or name'), expectedRev: z.number().optional(), dryRun: dryRunInput }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (a) => {
      const board = await boardOr404(a.boardId);
      if (!board) return err('board not found');
      const f = fieldsOf(board.data).find((x) => x.id === a.field || x.name.toLowerCase() === a.field.toLowerCase());
      if (!f) return err(`field ${a.field} not found`);
      const tasks = (a.boardId === 'board-default' ? (await listDefaultBoardTasks(ctx.env)).map(toRec) : (await listBy(ctx.env, 'tasks', 'boardId', a.boardId)).map(toRec));
      const withValue = tasks.filter((t) => t.data[propKey(f.id)] !== undefined).length;
      if (a.dryRun) return txt({ dryRun: true, summary: `remove field "${f.name}" from board ${a.boardId}`, counts: { tasksWithValue: withValue }, warnings: withValue ? [`${withValue} task(s) keep their stored value (hidden)`] : [], impact: { fieldId: f.id } });
      const out = await cas('boards', a.boardId, (data) => {
        const fields = fieldsOf(data);
        if (!fields.some((x) => x.id === f.id)) return null;
        return { fields: fields.filter((x) => x.id !== f.id) };
      });
      if ('conflict' in out) return err('concurrent board edits — retry');
      if ('notFound' in out) return err('board not found');
      return txt({ boardId: a.boardId, removed: f.id, tasksWithValue: withValue });
    },
  );

  /* ---------- 20. change sets ---------- */

  server.registerTool(
    'list_changes',
    {
      description: 'List your AI change sets (newest first). Each can be undone with undo_change.',
      inputSchema: z.object({ limit: z.number().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const { results } = await ctx.env.DB.prepare('SELECT id, source, client_name, tool, summary, request_id, undoes, undone_by, item_count, created_at FROM changesets WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').bind(ctx.userId, Math.min(limit ?? 50, 100)).all();
      return txt({ changes: results });
    },
  );

  server.registerTool(
    'get_change',
    {
      description: 'Inspect a change set: the tool, summary and every record write with before/after field values.',
      inputSchema: z.object({ changesetId: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ changesetId }) => {
      const cs = await ctx.env.DB.prepare('SELECT * FROM changesets WHERE id = ?').bind(changesetId).first<Record<string, unknown>>();
      if (!cs) return err('changeset not found');
      if (ctx.userRole !== 'admin' && cs.user_id !== ctx.userId) return err('forbidden');
      const { results } = await ctx.env.DB.prepare('SELECT idx, collection, record_id, created, before, after, field_ts FROM changeset_items WHERE changeset_id = ? ORDER BY idx').bind(changesetId).all();
      return txt({ changeset: cs, items: results.map((r) => ({ ...r, before: JSON.parse(String(r.before)), after: JSON.parse(String(r.after)), field_ts: JSON.parse(String(r.field_ts)) })) });
    },
  );

  reg(
    'undo_change',
    {
      description: 'Undo a change set: restores every field it changed that nobody touched since. Skips fields with later edits. Call with dryRun:true to preview.',
      inputSchema: z.object({ changesetId: z.string(), dryRun: dryRunInput }),
      annotations: { destructiveHint: true },
    },
    async (a) => {
      const cs = await ctx.env.DB.prepare('SELECT * FROM changesets WHERE id = ?').bind(a.changesetId).first<{ id: string; user_id: string; undone_by: string | null; tool: string }>();
      if (!cs) return err('changeset not found');
      if (ctx.userRole !== 'admin' && cs.user_id !== ctx.userId) return err('forbidden');
      if (cs.undone_by) return err('already undone');
      const { results } = await ctx.env.DB.prepare('SELECT collection, record_id, created, before, after, field_ts FROM changeset_items WHERE changeset_id = ? ORDER BY idx').bind(a.changesetId).all<{ collection: string; record_id: string; created: number; before: string; after: string; field_ts: string }>();
      const items = results.map((r) => ({ collection: r.collection, record_id: r.record_id, created: r.created, before: JSON.parse(r.before), after: JSON.parse(r.after), field_ts: JSON.parse(r.field_ts) }));
      const current = await getRecs(ctx.env, items.map((i) => i.record_id));
      const { planUndo } = await import('../shared/undo');
      const plan = planUndo(items, new Map([...current.entries()].map(([rid, rr]) => [rid, { data: rr.data, field_ts: rr.fieldTs }])));
      if (a.dryRun) return txt({ dryRun: true, summary: `undo ${cs.tool} (${a.changesetId})`, counts: { restore: plan.patches.length, skipped: plan.skipped.length }, warnings: plan.skipped.map((s) => `${s.id}.${s.field}: ${s.reason}`), impact: { patches: plan.patches } });
      const out = await undoChangeset(ctx.env, { id: ctx.userId, role: ctx.userRole } as AuthUser, a.changesetId);
      if (!out.ok) return err(out.error ?? 'undo failed');
      return txt({ undone: a.changesetId, undoChangesetId: out.undoChangesetId, restored: out.restored, skipped: out.skipped });
    },
  );

  /* ---------- 21. Phase 1: databases, views, records, links ---------- */

  const VIEW_TYPES = ['table', 'list', 'gallery', 'board', 'calendar', 'timeline'] as const;
  const viewUrl = (dbId: string, viewId: string) => `${ctx.origin}/boards/${dbId}/views/${viewId}`;
  const recordUrl = (dbId: string, recId: string) => `${ctx.origin}/boards/${dbId}/tasks/${recId}`;

  const viewInput = z.object({
    name: z.string(),
    type: z.enum(VIEW_TYPES).optional(),
    filters: z.array(z.object({ field: z.string(), op: z.string(), value: z.unknown().optional() })).optional(),
    sorts: z.array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']).optional() })).optional(),
    groupBy: z.string().optional(),
    visible: z.array(z.string()).optional(),
    cover: z.string().optional(),
    dateKey: z.string().optional().describe("calendar/timeline: date field name/id ('dueDate' or a date-type field)"),
    endDateKey: z.string().optional().describe('timeline: bar end date field name/id'),
    timelineScale: z.enum(['week', 'month', 'quarter']).optional(),
  });

  /** Field name/id → views.ts FieldKey ('title'|'status'|'assigneeId'|'dueDate'|'priority'|'createdAt'|'createdBy'|p_<fid>|rel_<fid>). */
  const resolveFieldKey = (boardData: Record<string, unknown>, key: string): import('../shared/views').FieldKey => {
    const BUILTINS: Record<string, string> = { title: 'title', status: 'status', stage: 'status', assignee: 'assigneeId', assigneeid: 'assigneeId', due: 'dueDate', duedate: 'dueDate', priority: 'priority', createdat: 'createdAt', createdby: 'createdBy', cover: 'cover' };
    const f = fieldsOf(boardData).find((x) => x.id === key || x.name.toLowerCase() === key.toLowerCase());
    if (f) return (f.type === 'relation' ? `rel_${f.id}` : `p_${f.id}`) as import('../shared/views').FieldKey;
    return (BUILTINS[key.toLowerCase()] ?? key) as import('../shared/views').FieldKey;
  };

  /** dateKey arg → 'dueDate' | p_<fid>; must resolve to a date-capable field. Throws on bad key. */
  const resolveDateKeyArg = (boardData: Record<string, unknown>, key: string): string => {
    if (key === 'dueDate' || key === 'due' || key === 'duedate') return 'dueDate';
    const f = fieldsOf(boardData).find((x) => x.id === key || x.name.toLowerCase() === key.toLowerCase());
    if (!f) throw new Error(`dateKey "${key}" is not a field on this database`);
    if (f.type !== 'date') throw new Error(`dateKey "${key}" resolves to a ${f.type} field — needs type 'date'`);
    return `p_${f.id}`;
  };

  const viewOps = async (dbId: string, views: { name: string; type?: string; filters?: { field: string; op: string; value?: unknown }[]; sorts?: { field: string; dir?: string }[]; groupBy?: string; visible?: string[]; cover?: string; dateKey?: string; endDateKey?: string; timelineScale?: string }[], boardData: Record<string, unknown>): Promise<WriteOp[]> => {
    const ops: WriteOp[] = [];
    let prevKey: string | null = null;
    for (const v of views) {
      prevKey = orderBetween(prevKey, null);
      const id = uuid();
      ops.push({
        collection: 'views',
        id,
        patch: {
          databaseId: dbId,
          name: v.name,
          type: (v.type ?? 'table'),
          config: {
            filters: (v.filters ?? []).map((f) => ({ key: resolveFieldKey(boardData, f.field), op: f.op, value: f.value })),
            sorts: (v.sorts ?? []).map((s) => ({ key: resolveFieldKey(boardData, s.field), dir: s.dir ?? 'asc' })),
            groupBy: v.groupBy ? resolveFieldKey(boardData, v.groupBy) : undefined,
            visible: v.visible?.map((f) => resolveFieldKey(boardData, f)),
            cover: v.cover ? resolveFieldKey(boardData, v.cover) : undefined,
            dateKey: v.dateKey ? resolveDateKeyArg(boardData, v.dateKey) : undefined,
            endDateKey: v.endDateKey ? resolveDateKeyArg(boardData, v.endDateKey) : undefined,
            timelineScale: v.timelineScale ?? undefined,
          },
          order: prevKey,
          createdBy: ctx.userId,
          createdAt: Date.now(),
        },
      });
    }
    return ops;
  };

  reg(
    'create_database',
    {
      description: `Create a database (board). kind 'tasks' = task board with stages; kind 'records' = records database (stages optional). fields accepts type 'relation' with {target db id/name|'pages', twoWay?, reverseName?, single?}. views creates view rows.`,
      inputSchema: z.object({
        name: z.string(),
        icon: z.string().optional(),
        kind: z.enum(['tasks', 'records']).optional(),
        recordNoun: z.string().optional(),
        description: z.string().optional(),
        stages: z.array(z.union([z.string(), z.object({ name: z.string(), color: z.string().optional() })])).optional().describe("Stage names/objects. Default: To do/Doing/Done for kind 'tasks'; none for 'records'"),
        fields: z.array(
          z.object({
            name: z.string(),
            type: z.enum(['text', 'number', 'select', 'multi_select', 'person', 'date', 'url', 'checkbox', 'relation']),
            options: z.array(z.union([z.string(), z.object({ name: z.string(), color: z.string().optional() })])).optional(),
            showOnCard: z.boolean().optional(),
            target: z.string().optional().describe("relation: target database id/name or 'pages'"),
            twoWay: z.boolean().optional().describe('relation: create the reverse field on the target database'),
            reverseName: z.string().optional(),
            single: z.boolean().optional(),
          }),
        ).optional(),
        views: z.array(viewInput).optional(),
        parentPageId: z.string().optional().describe('Append a tasks block embedding this database on the page'),
      }),
      annotations: { idempotentHint: false },
    },
    async (a) => {
      const dbId = uuid();
      const boards = live(await recs(ctx.env, 'boards')).sort(byOrder);
      const kind = a.kind ?? 'tasks';
      const stageList = a.stages ?? (kind === 'tasks' ? ['To do', 'Doing', 'Done'] : []);
      const cols = stageList.map((c, i) => (typeof c === 'string' ? { id: uuid().slice(0, 8), name: c, color: COLUMN_COLORS[i % COLUMN_COLORS.length] } : { id: uuid().slice(0, 8), name: c.name, color: c.color ?? COLUMN_COLORS[i % COLUMN_COLORS.length] }));
      const showBuiltins = kind === 'records' ? { assignee: false, due: false, priority: false } : undefined;
      const data: Record<string, unknown> = { name: a.name, icon: a.icon ?? (kind === 'records' ? '🗃️' : '🗂️'), kind, recordNoun: a.recordNoun, description: a.description, showBuiltins, columns: cols, fields: [] as FieldDef[], order: orderBetween(boards.length ? String(boards[boards.length - 1].data.order ?? '') || null : null, null), createdBy: ctx.userId, createdAt: Date.now() };
      const ops: WriteOp[] = [{ collection: 'boards', id: dbId, patch: data }];
      // fields (relation handled post-commit via add_field semantics — two-way needs the target board row)
      const relFields: { name: string; target: string; twoWay?: boolean; reverseName?: string; single?: boolean }[] = [];
      const fieldDefs: FieldDef[] = [];
      for (const f of a.fields ?? []) {
        if (f.type === 'relation') {
          relFields.push({ name: f.name, target: f.target ?? '', twoWay: f.twoWay, reverseName: f.reverseName, single: f.single });
          continue;
        }
        fieldDefs.push({ id: uuid().slice(0, 8), name: f.name, type: f.type, showOnCard: f.showOnCard, options: isSelectType(f.type) ? mkOptions(f.options) : undefined });
      }
      data.fields = fieldDefs;
      const dbData = data;
      ops.push(...(await viewOps(dbId, a.views ?? [], dbData)));
      if (a.parentPageId) {
        const pg = await rec(ctx.env, 'pages', a.parentPageId);
        if (!pg || pg.data.deleted) return err('parentPage not found');
        const pgBlocks = (await listBy(ctx.env, 'blocks', 'pageId', a.parentPageId)).map(toRec);
        ops.push({ collection: 'blocks', id: uuid(), patch: { pageId: a.parentPageId, order: orderBetween(pgBlocks.length ? String(pgBlocks.sort(byOrder)[pgBlocks.length - 1].data.order ?? '') || null : null, null), type: 'tasks', boardId: dbId } });
      }
      ops.push(activityOp(ctx.userId, ctx.clientName, 'created', 'board', dbId, a.name, ctx.cs?.id));
      await write(ctx, ops);
      // two-way relations: CAS each board after base write so both sides point at each other
      const relResults: string[] = [];
      for (const rf of relFields) {
        const targetBoard = rf.target === 'pages' ? null : boards.find((b) => b.id === rf.target || String(b.data.name ?? '').toLowerCase() === rf.target.toLowerCase()) ?? null;
        if (rf.target !== 'pages' && !targetBoard) {
          ctx.warnings.push(`relation "${rf.name}": target database "${rf.target}" not found — skipped`);
          continue;
        }
        const fId = uuid().slice(0, 8);
        const pId = rf.twoWay ? uuid().slice(0, 8) : null;
        const outA = await cas('boards', dbId, (d) => {
          const fs = fieldsOf(d).map((x) => ({ ...x }));
          if (fs.some((x) => x.name.toLowerCase() === rf.name.toLowerCase())) return null;
          fs.push({ id: fId, name: rf.name, type: 'relation', relation: { target: rf.target === 'pages' ? 'pages' : targetBoard!.id, pairedFieldId: pId, single: rf.single, primary: true } });
          return { fields: fs };
        });
        if ('conflict' in outA || 'notFound' in outA) {
          ctx.warnings.push(`relation "${rf.name}" failed on concurrent edit`);
          continue;
        }
        if (pId && targetBoard) {
          const outB = await cas('boards', targetBoard.id, (d) => {
            const fs = fieldsOf(d).map((x) => ({ ...x }));
            if (fs.some((x) => x.name.toLowerCase() === (rf.reverseName ?? a.name).toLowerCase())) return null;
            fs.push({ id: pId, name: rf.reverseName ?? a.name, type: 'relation', relation: { target: dbId, pairedFieldId: fId, single: false, primary: false } });
            return { fields: fs };
          });
          if ('conflict' in outB || 'notFound' in outB) ctx.warnings.push(`reverse relation for "${rf.name}" failed on concurrent edit`);
        }
        relResults.push(rf.name);
      }
      return txt({ id: dbId, url: boardUrl(ctx, dbId), kind, recordNoun: a.recordNoun, stages: cols.map((c) => c.name), fields: fieldDefs.map((f) => f.name).concat(relResults), views: (a.views ?? []).map((v) => v.name) });
    },
  );

  reg(
    'add_view',
    {
      description: 'Add a view to a database (types: table/list/gallery/board/calendar/timeline). Filter/sort/groupBy/visible take field NAMES (resolved server-side to ids). calendar/timeline take dateKey/endDateKey (date field names) + timelineScale.',
      inputSchema: z.object({ databaseId: z.string(), name: z.string(), type: z.enum(VIEW_TYPES).optional(), filters: z.array(z.object({ field: z.string(), op: z.string(), value: z.unknown().optional() })).optional(), sorts: z.array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']).optional() })).optional(), groupBy: z.string().optional(), visible: z.array(z.string()).optional(), cover: z.string().optional(), dateKey: z.string().optional(), endDateKey: z.string().optional(), timelineScale: z.enum(['week', 'month', 'quarter']).optional() }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const board = await rec(ctx.env, 'boards', a.databaseId);
      if (!board || board.data.deleted) return err('database not found');
      const existing = (await listBy(ctx.env, 'views', 'databaseId', a.databaseId)).map(toRec);
      const dup = existing.find((v) => String(v.data.name ?? '').toLowerCase() === a.name.toLowerCase());
      if (dup) return txt({ id: dup.id, url: viewUrl(a.databaseId, dup.id), existed: true });
      const id = uuid();
      const ops = await viewOps(a.databaseId, [{ name: a.name, type: a.type, filters: a.filters, sorts: a.sorts, groupBy: a.groupBy, visible: a.visible, cover: a.cover, dateKey: a.dateKey, endDateKey: a.endDateKey, timelineScale: a.timelineScale }], board.data);
      await write(ctx, ops.map((o) => ({ ...o, id })).concat(activityOp(ctx.userId, ctx.clientName, 'created', 'board', a.databaseId, `view ${a.name}`, ctx.cs?.id)));
      return txt({ id, url: viewUrl(a.databaseId, id) });
    },
  );

  reg(
    'update_view',
    {
      description: 'Update a view name/type/config.',
      inputSchema: z.object({ viewId: z.string(), name: z.string().optional(), type: z.enum(VIEW_TYPES).optional(), filters: z.array(z.object({ field: z.string(), op: z.string(), value: z.unknown().optional() })).optional(), sorts: z.array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']).optional() })).optional(), groupBy: z.string().optional(), visible: z.array(z.string()).optional(), cover: z.string().optional(), dateKey: z.string().nullable().optional(), endDateKey: z.string().nullable().optional(), timelineScale: z.enum(['week', 'month', 'quarter']).nullable().optional(), expectedRev: z.number().optional() }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const v = await rec(ctx.env, 'views', a.viewId);
      if (!v || v.data.deleted) return err('view not found');
      const board = await rec(ctx.env, 'boards', String(v.data.databaseId));
      const cfg = (v.data.config ?? {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      if (a.name !== undefined) patch.name = a.name;
      if (a.type !== undefined) patch.type = a.type;
      if (a.filters !== undefined) cfg.filters = a.filters.map((f) => ({ key: resolveFieldKey(board?.data ?? {}, f.field), op: f.op, value: f.value }));
      if (a.sorts !== undefined) cfg.sorts = a.sorts.map((s) => ({ key: resolveFieldKey(board?.data ?? {}, s.field), dir: s.dir ?? 'asc' }));
      if (a.groupBy !== undefined) cfg.groupBy = a.groupBy ? resolveFieldKey(board?.data ?? {}, a.groupBy) : undefined;
      if (a.visible !== undefined) cfg.visible = a.visible.map((f) => resolveFieldKey(board?.data ?? {}, f));
      if (a.cover !== undefined) cfg.cover = a.cover ? resolveFieldKey(board?.data ?? {}, a.cover) : undefined;
      if (a.dateKey !== undefined) cfg.dateKey = a.dateKey ? resolveDateKeyArg(board?.data ?? {}, a.dateKey) : undefined;
      if (a.endDateKey !== undefined) cfg.endDateKey = a.endDateKey ? resolveDateKeyArg(board?.data ?? {}, a.endDateKey) : undefined;
      if (a.timelineScale !== undefined) cfg.timelineScale = a.timelineScale ?? undefined;
      patch.config = cfg;
      const expect = a.expectedRev !== undefined ? new Map([[a.viewId, a.expectedRev]]) : undefined;
      await write(ctx, [{ collection: 'views', id: a.viewId, patch }], { expect });
      return txt({ id: a.viewId, url: viewUrl(String(v.data.databaseId), a.viewId) });
    },
  );

  reg(
    'remove_view',
    {
      description: 'Delete a view. Refuses to remove the database\u2019s last remaining view when it is the defaultViewId.',
      inputSchema: z.object({ viewId: z.string(), expectedRev: z.number().optional() }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (a) => {
      const v = await rec(ctx.env, 'views', a.viewId);
      if (!v || v.data.deleted) return err('view not found');
      const expect = a.expectedRev !== undefined ? new Map([[a.viewId, a.expectedRev]]) : undefined;
      const ops: WriteOp[] = [{ collection: 'views', id: a.viewId, patch: { deleted: true } }];
      const board = await rec(ctx.env, 'boards', String(v.data.databaseId));
      if (board && board.data.defaultViewId === a.viewId) ops.push({ collection: 'boards', id: board.id, patch: { defaultViewId: null } });
      await write(ctx, ops, { expect });
      return txt({ removed: a.viewId });
    },
  );

  const linkRec = async (kind: 'relation' | 'blocks' | 'related', fieldId: string, fromType: string, fromId: string, toType: string, toId: string): Promise<{ id: string; existed: boolean }> => {
    const { linkId } = await import('../shared/linkid');
    const id = linkId(kind, fieldId, fromId, toId);
    const existing = await getRec(ctx.env, id);
    if (existing && !existing.data.deleted) return { id, existed: true };
    await write(ctx, [{ collection: 'links', id, patch: { fromType, fromId, toType, toId, kind, fieldId: fieldId || null, deleted: false, createdBy: ctx.userId, createdAt: Date.now() } }]);
    return { id, existed: !!existing };
  };

  const resolveRecordRef = async (dbId: string, ref: string, byIdFirst = true): Promise<Rec | null> => {
    if (byIdFirst) {
      const r = await getRec(ctx.env, ref);
      if (r && !r.data.deleted) return r;
    }
    const all = live((await listBy(ctx.env, 'tasks', 'boardId', dbId)).map(toRec));
    return all.find((t) => String(t.data.title ?? '').toLowerCase() === ref.toLowerCase()) ?? null;
  };

  reg(
    'link_items',
    {
      description: `Link two items. kind 'related' = see-also (any types); 'relation' = store a relation-field value (field = field id/name on the from-record's database; writes always normalise to the primary field); 'blocks' = dependency (use add_dependency for title resolution + cycle check).`,
      inputSchema: z.object({
        from: z.object({ type: z.enum(['record', 'page', 'mooditem', 'block']), id: z.string() }),
        to: z.object({ type: z.enum(['record', 'page', 'mooditem', 'file']), id: z.string() }),
        kind: z.enum(['related', 'blocks', 'relation']).optional(),
        field: z.string().optional().describe('relation field id or name on the from-record\u2019s database'),
      }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const kind = a.kind ?? 'related';
      let fieldId = '';
      let fromId = a.from.id;
      let toId = a.to.id;
      if (kind === 'relation') {
        const fromRec = await rec(ctx.env, 'tasks', a.from.id);
        if (!fromRec || fromRec.data.deleted) return err('from record not found');
        const board = await rec(ctx.env, 'boards', String(fromRec.data.boardId));
        const f = fieldsOf(board?.data).find((x) => x.id === a.field || x.name.toLowerCase() === String(a.field ?? '').toLowerCase());
        if (!f || f.type !== 'relation') return err(`relation field "${a.field}" not found on record's database`);
        if (f.relation?.pairedFieldId && !f.relation.primary) {
          // Reverse side: normalise to primary direction — swap endpoints, use paired (primary) field id.
          const tmp = fromId; fromId = toId; toId = tmp;
          fieldId = f.relation.pairedFieldId;
        } else {
          fieldId = f.id;
        }
        const toRec2 = await rec(ctx.env, 'tasks', toId);
        if (f.relation && f.relation.target !== 'pages' && toRec2 && String(toRec2.data.boardId) !== f.relation.target) return err(`relation target mismatch: "${f.name}" points at database ${f.relation.target}`);
        if (f.relation?.target === 'pages' && a.to.type !== 'page') return err(`"${f.name}" targets pages — to must be a page`);
      }
      const out = await linkRec(kind, fieldId, a.from.type, fromId, a.to.type, toId);
      return txt({ linkId: out.id, existed: out.existed });
    },
  );

  reg(
    'create_records',
    {
      description: `Create up to ${MAX_TASKS_PER_CALL} records in a database. Extends create_tasks: parent (id|title), relations {fieldName:[id|title]}, blockedBy [id|title], body (markdown). Title refs resolve within the call first, then existing records. dedupe:'title' default.`,
      inputSchema: z.object({
        databaseId: z.string(),
        records: z.array(
          taskInput.omit({ status: true }).extend({
            stage: z.string().optional().describe('Stage name or id'),
            parent: z.string().optional().describe('Parent record id or title (same database)'),
            relations: z.record(z.string(), z.array(z.string())).optional().describe('{fieldName: [record id|title|page id|title]}'),
            blockedBy: z.array(z.string()).optional(),
            body: z.string().optional().describe('Record body markdown'),
          }),
        ).min(1).max(100),
        dedupe: z.enum(['none', 'title']).optional(),
        dryRun: dryRunInput,
      }),
      annotations: { idempotentHint: false },
    },
    async (a) => {
      const board = await rec(ctx.env, 'boards', a.databaseId);
      if (!board || board.data.deleted) return err('database not found');
      const isTasks = String(board.data.kind ?? 'tasks') === 'tasks';
      if (!isTasks && !colsOf(board).length && a.records.some((r) => r.stage)) ctx.warnings.push('database has no stages — stage input ignored');
      await fillCaches(ctx);
      const allTasks = live((await listBy(ctx.env, 'tasks', 'boardId', a.databaseId)).map(toRec));
      const ops: WriteOp[] = [];
      const created: { id: string; title: string }[] = [];
      const skipped: string[] = [];
      let records = a.records;
      if ((a.dedupe ?? 'title') === 'title') {
        const seen = new Set(allTasks.map((t) => String(t.data.title ?? '').toLowerCase()));
        records = records.filter((t) => {
          const k = t.title.toLowerCase();
          if (seen.has(k)) { skipped.push(t.title); return false; }
          seen.add(k);
          return true;
        });
      }
      if (a.dryRun) return txt({ dryRun: true, summary: `create_records in ${a.databaseId}`, counts: { create: records.length, skipped: skipped.length }, warnings: [], impact: { skippedTitles: skipped } });
      const idByTitle = new Map<string, string>();
      for (const t of allTasks) idByTitle.set(String(t.data.title ?? '').toLowerCase(), t.id);
      // first pass: create rows, collect deferred link/parent/body work
      const pending: { id: string; t: (typeof records)[number] }[] = [];
      let fields: FieldDef[] = fieldsOf(board.data).map((f) => ({ ...f, options: f.options ? [...f.options] : undefined }));
      let fieldsMutated = false;
      for (const t of records) {
        const id = uuid();
        idByTitle.set(t.title.toLowerCase(), id);
        const colId = isTasks ? columnIdFor(board, t.stage ?? undefined) : colsOf(board)[0]?.id ?? 'todo';
        const inCol = allTasks.filter((x) => columnIdFor(board, x.data.status) === colId).sort(byOrder);
        const fp = t.fields ? coerceFieldsInput(fields, t.fields) : { patch: {} as Record<string, unknown>, fields };
        fields = fp.fields;
        if (JSON.stringify(fields) !== JSON.stringify(fieldsOf(board.data))) fieldsMutated = true;
        const patch: Record<string, unknown> = {
          title: t.title,
          description: t.description ?? '',
          boardId: a.databaseId,
          status: colId,
          priority: t.priority ?? 'none',
          assigneeId: t.assignee ? resolveAssignee(ctx, t.assignee) : null,
          dueDate: t.due ?? null,
          pageId: null,
          parentId: null,
          order: orderBetween(inCol.length ? String(inCol[inCol.length - 1].data.order ?? '') || null : null, null),
          createdBy: ctx.userId,
          createdAt: Date.now(),
          ...fp.patch,
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
        allTasks.push({ id, data: { boardId: a.databaseId, status: colId, order: patch.order, title: t.title }, rev: -1, updatedBy: null, updatedAt: null });
        created.push({ id, title: t.title });
        pending.push({ id, t });
      }
      // second pass: parents, body blocks
      const parentOf = new Map(allTasks.map((t) => [t.id, (t.data.parentId as string | null) ?? null]));
      const { wouldCreateCycle, depthOf, subtreeHeight, MAX_DEPTH } = await import('../shared/tree');
      for (const { id, t } of pending) {
        if (t.parent) {
          const pid = idByTitle.get(t.parent.toLowerCase()) ?? t.parent;
          const prow = allTasks.find((x) => x.id === pid);
          if (!prow) ctx.warnings.push(`record "${t.title}": parent "${t.parent}" not found — skipped`);
          else {
            parentOf.set(id, null);
            if (wouldCreateCycle(parentOf, id, pid)) ctx.warnings.push(`record "${t.title}": parent "${t.parent}" would create a cycle — skipped`);
            else if (depthOf(parentOf, pid) + 1 + subtreeHeight(parentOf, id) > MAX_DEPTH) ctx.warnings.push(`record "${t.title}": parent "${t.parent}" exceeds max depth ${MAX_DEPTH} — skipped`);
            else { ops.push({ collection: 'tasks', id, patch: { parentId: pid } }); parentOf.set(id, pid); }
          }
        }
        if (t.body) ops.push(...(await blockOps(ctx, id, t.body, [])));
      }
      if (fieldsMutated) ops.unshift({ collection: 'boards', id: a.databaseId, patch: { fields } });
      ops.push(...created.map((x) => activityOp(ctx.userId, ctx.clientName, 'created', 'task', x.id, x.title, ctx.cs?.id)));
      await write(ctx, ops);
      // third pass: relations + dependencies via link collection (after rows exist)
      const relFieldDefs = fieldsOf(board.data).concat(fields).filter((f) => f.type === 'relation');
      for (const { id, t } of pending) {
        for (const [fname, refs] of Object.entries(t.relations ?? {})) {
          const f = relFieldDefs.find((x) => x.name.toLowerCase() === fname.toLowerCase());
          if (!f) { ctx.warnings.push(`relation field "${fname}" not found — skipped`); continue; }
          const primary = f.relation?.primary !== false ? f : undefined;
          const fid = f.relation?.pairedFieldId && !f.relation.primary ? f.relation.pairedFieldId : f.id;
          const rev = !!(f.relation?.pairedFieldId && !f.relation.primary);
          for (const ref of refs) {
            let toId = idByTitle.get(ref.toLowerCase());
            let toType: 'record' | 'page' = 'record';
            if (!toId) {
              const pr = await resolveRecordRef(String(f.relation?.target ?? ''), ref, true);
              if (pr) toId = pr.id;
            }
            if (!toId && f.relation?.target === 'pages') {
              const pg = (await getRec(ctx.env, ref)) ?? live(await recs(ctx.env, 'pages')).find((p) => String(p.data.title ?? '').toLowerCase() === ref.toLowerCase());
              if (pg) { toId = pg.id; toType = 'page'; }
            }
            if (!toId) { ctx.warnings.push(`relation "${fname}": "${ref}" not found — skipped`); continue; }
            if (f.relation && f.relation.target !== 'pages') {
              const tr = await getRec(ctx.env, toId);
              if (tr && String(tr.data.boardId ?? '') !== f.relation.target) { ctx.warnings.push(`relation "${fname}": "${ref}" is not in target database — skipped`); continue; }
            }
            const [fid2, to2] = rev ? [toId, id] : [id, toId];
            const l = await linkRec('relation', fid, 'record', fid2, rev ? 'record' : toType, to2);
            void primary;
            void l;
          }
        }
        for (const ref of t.blockedBy ?? []) {
          const bid = idByTitle.get(ref.toLowerCase()) ?? (await resolveRecordRef(a.databaseId, ref))?.id;
          if (!bid) { ctx.warnings.push(`blockedBy "${ref}" not found — skipped`); continue; }
          await linkRec('blocks', '', 'record', bid, 'record', id);
        }
      }
      return txt({ databaseId: a.databaseId, created, skipped, url: boardUrl(ctx, a.databaseId) });
    },
  );

  reg(
    'update_records',
    {
      description: 'Update records: title, stage, assignee, due, priority, fields by name, addRelations/removeRelations {fieldName:[id|title]}, parent (id|title|null, same database), move to database. expectedRev recommended per update.',
      inputSchema: z.object({
        updates: z.array(z.object({
          recordId: z.string(),
          expectedRev: z.number().optional(),
          title: z.string().optional(),
          stage: z.string().optional(),
          description: z.string().optional(),
          assignee: z.string().optional(),
          due: z.string().optional(),
          priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']).optional(),
          coverImageUrl: z.string().optional(),
          fields: fieldInput.optional(),
          addRelations: z.record(z.string(), z.array(z.string())).optional(),
          removeRelations: z.record(z.string(), z.array(z.string())).optional(),
          parent: z.string().nullable().optional(),
          databaseId: z.string().optional().describe('Move to this database (lands in first stage)'),
        })).min(1).max(100),
        dryRun: dryRunInput,
      }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      await fillCaches(ctx);
      if (a.dryRun) return txt({ dryRun: true, summary: 'update_records', counts: { updates: a.updates.length }, warnings: [], impact: { recordIds: a.updates.map((u) => u.recordId) } });
      const ops: WriteOp[] = [];
      const expect = new Map<string, number>();
      const unchecked: string[] = [];
      const boardsMutated = new Map<string, FieldDef[]>();
      const relOps: { rid: string; board: Rec; fname: string; refs: string[]; remove: boolean }[] = [];
      for (const u of a.updates) {
        const task = await rec(ctx.env, 'tasks', u.recordId);
        if (!task || task.data.deleted) return err(`record ${u.recordId} not found`);
        if (u.expectedRev !== undefined) expect.set(u.recordId, u.expectedRev);
        else unchecked.push(u.recordId);
        const patch: Record<string, unknown> = {};
        const dbId = String(task.data.boardId ?? 'board-default');
        const board = await rec(ctx.env, 'boards', dbId);
        const isTasks = String(board?.data.kind ?? 'tasks') === 'tasks';
        if (u.title !== undefined) patch.title = u.title;
        if (u.description !== undefined) patch.description = u.description;
        if (u.stage !== undefined) {
          if (!isTasks && !colsOf(board!).length) ctx.warnings.push(`record ${u.recordId}: database has no stages — stage ignored`);
          else if (board) patch.status = columnIdFor(board, u.stage);
        }
        if (u.databaseId) {
          const nb = await rec(ctx.env, 'boards', u.databaseId);
          if (!nb || nb.data.deleted) return err(`database ${u.databaseId} not found`);
          patch.boardId = u.databaseId;
          patch.status = colsOf(nb)[0]?.id ?? 'todo';
        }
        if (u.assignee !== undefined) patch.assigneeId = resolveAssignee(ctx, u.assignee);
        if (u.due !== undefined) patch.dueDate = u.due;
        if (u.priority !== undefined) patch.priority = u.priority;
        if (u.fields && board) {
          const fields = boardsMutated.get(dbId) ?? fieldsOf(board.data).map((f) => ({ ...f, options: f.options ? [...f.options] : undefined }));
          const fp = coerceFieldsInput(fields, u.fields);
          boardsMutated.set(dbId, fp.fields);
          Object.assign(patch, fp.patch);
        }
        if (u.coverImageUrl !== undefined) {
          try {
            const { fileId } = await importFileFromUrl(ctx.env, u.coverImageUrl, { parentType: 'task', parentId: u.recordId, userId: ctx.userId });
            patch.coverFileId = fileId;
          } catch (e) {
            if (e instanceof RemoteFileError) return err(`coverImageUrl for record ${u.recordId}: ${e.message}`);
            throw e;
          }
        }
        if (u.parent !== undefined && board) {
          const all = live((await listBy(ctx.env, 'tasks', 'boardId', dbId)).map(toRec));
          const parentOf = new Map(all.map((t) => [t.id, (t.data.parentId as string | null) ?? null]));
          const { wouldCreateCycle, depthOf, subtreeHeight, MAX_DEPTH } = await import('../shared/tree');
          if (u.parent === null) patch.parentId = null;
          else {
            const prow = all.find((t) => t.id === u.parent || String(t.data.title ?? '').toLowerCase() === u.parent!.toLowerCase());
            if (!prow) ctx.warnings.push(`record ${u.recordId}: parent "${u.parent}" not found — skipped`);
            else if (String(prow.data.boardId ?? '') !== dbId) ctx.warnings.push(`record ${u.recordId}: cross-database parent — skipped`);
            else if (wouldCreateCycle(parentOf, u.recordId, prow.id)) ctx.warnings.push(`record ${u.recordId}: parent "${u.parent}" creates a cycle — skipped`);
            else if (depthOf(parentOf, prow.id) + 1 + subtreeHeight(parentOf, u.recordId) > MAX_DEPTH) ctx.warnings.push(`record ${u.recordId}: exceeds max depth ${MAX_DEPTH} — skipped`);
            else patch.parentId = prow.id;
          }
        }
        for (const [fname, refs] of Object.entries(u.addRelations ?? {})) relOps.push({ rid: u.recordId, board: board!, fname, refs, remove: false });
        for (const [fname, refs] of Object.entries(u.removeRelations ?? {})) relOps.push({ rid: u.recordId, board: board!, fname, refs, remove: true });
        ops.push({ collection: 'tasks', id: u.recordId, patch });
      }
      for (const [bid, fields] of boardsMutated) ops.push({ collection: 'boards', id: bid, patch: { fields } });
      await write(ctx, ops, { expect });
      const { linkId } = await import('../shared/linkid');
      for (const r of relOps) {
        const f = fieldsOf(r.board.data).find((x) => x.name.toLowerCase() === r.fname.toLowerCase());
        if (!f || f.type !== 'relation') { ctx.warnings.push(`relation field "${r.fname}" not found on ${r.rid}`); continue; }
        const rev = !!(f.relation?.pairedFieldId && !f.relation.primary);
        const fid = rev ? f.relation!.pairedFieldId! : f.id;
        for (const ref of r.refs) {
          const targetDb = String(f.relation?.target ?? '');
          let other: string | undefined;
          const cand = targetDb !== 'pages' && targetDb ? await resolveRecordRef(targetDb, ref) : null;
          other = cand?.id ?? undefined;
          if (!other) {
            const any = await getRec(ctx.env, ref);
            if (any && !any.data.deleted) other = ref;
          }
          if (!other && targetDb !== 'pages') {
            const tr = live((await listBy(ctx.env, 'tasks', 'boardId', targetDb)).map(toRec)).find((t) => String(t.data.title ?? '').toLowerCase() === ref.toLowerCase());
            if (tr) other = tr.id;
          }
          if (!other && targetDb === 'pages') {
            const pg = live(await recs(ctx.env, 'pages')).find((p) => p.id === ref || String(p.data.title ?? '').toLowerCase() === ref.toLowerCase());
            if (pg) other = pg.id;
          }
          if (!other) { ctx.warnings.push(`relation "${r.fname}": "${ref}" not found — skipped`); continue; }
          const [fromId, toId] = rev ? [other, r.rid] : [r.rid, other];
          const lid = linkId('relation', fid, fromId, toId);
          if (r.remove) await write(ctx, [{ collection: 'links', id: lid, patch: { deleted: true } }]);
          else await linkRec('relation', fid, 'record', fromId, 'record', toId);
        }
      }
      return txt({ updated: a.updates.length, ...(unchecked.length ? { unchecked } : {}) });
    },
  );

  reg(
    'unlink_items',
    {
      description: 'Remove a link by id, or by (from,to,kind,field) endpoints.',
      inputSchema: z.object({
        linkId: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        kind: z.enum(['related', 'blocks', 'relation']).optional(),
        fieldId: z.string().optional(),
      }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      let id = a.linkId;
      if (!id && a.from && a.to) {
        const { linkId } = await import('../shared/linkid');
        id = linkId(a.kind ?? 'related', a.fieldId ?? '', a.from, a.to);
      }
      if (!id) return err('provide linkId or from+to');
      const l = await getRec(ctx.env, id);
      if (!l || l.data.deleted) return txt({ linkId: id, removed: true, existed: false });
      await write(ctx, [{ collection: 'links', id, patch: { deleted: true } }]);
      return txt({ linkId: id, removed: true });
    },
  );

  reg(
    'set_parent',
    {
      description: 'Set (or clear) a record\u2019s parent. Rejects cycles, depth > 3 and cross-database moves.',
      inputSchema: z.object({ recordId: z.string(), parentId: z.string().nullable(), expectedRev: z.number().optional() }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const r = await rec(ctx.env, 'tasks', a.recordId);
      if (!r || r.data.deleted) return err('record not found');
      const dbId = String(r.data.boardId ?? '');
      const { wouldCreateCycle, depthOf, subtreeHeight, MAX_DEPTH } = await import('../shared/tree');
      if (a.parentId) {
        const p = await rec(ctx.env, 'tasks', a.parentId);
        if (!p || p.data.deleted) return err('parent record not found');
        if (String(p.data.boardId ?? '') !== dbId) return err('cross-database parent is not allowed');
        const all = live((await listBy(ctx.env, 'tasks', 'boardId', dbId)).map(toRec));
        const parentOf = new Map(all.map((t) => [t.id, (t.data.parentId as string | null) ?? null]));
        if (wouldCreateCycle(parentOf, r.id, a.parentId)) return err('cycle: parent is a descendant of this record');
        const newDepth = depthOf(parentOf, a.parentId) + 1 + subtreeHeight(parentOf, r.id);
        if (newDepth > MAX_DEPTH) return err(`depth ${newDepth} exceeds max depth ${MAX_DEPTH}`);
      }
      const expect = a.expectedRev !== undefined ? new Map([[r.id, a.expectedRev]]) : undefined;
      await write(ctx, [{ collection: 'tasks', id: r.id, patch: { parentId: a.parentId ?? null } }], { expect });
      return txt({ recordId: r.id, parentId: a.parentId ?? null });
    },
  );

  reg(
    'add_dependency',
    {
      description: '`blocker` must finish before `blocked`. Ids or titles within databaseId. Rejects cycles.',
      inputSchema: z.object({ blocker: z.string(), blocked: z.string(), databaseId: z.string().optional() }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      let br: Rec | null = null;
      let bd: Rec | null = null;
      if (a.databaseId) {
        br = await resolveRecordRef(a.databaseId, a.blocker);
        bd = await resolveRecordRef(a.databaseId, a.blocked);
      } else {
        br = await rec(ctx.env, 'tasks', a.blocker);
        bd = await rec(ctx.env, 'tasks', a.blocked);
      }
      if (!br || br.data.deleted) return err('blocker not found');
      if (!bd || bd.data.deleted) return err('blocked record not found');
      if (br.id === bd.id) return err('a record cannot block itself');
      const links = (await listBy(ctx.env, 'links', 'toId', bd.id)).map(toRec).filter((l) => l.data.kind === 'blocks');
      const edges: [string, string][] = links.map((l) => [String(l.data.fromId), String(l.data.toId)]);
      const allLinks = (await listCollection(ctx.env, 'links')).filter((l) => l.data.kind === 'blocks');
      const allEdges = allLinks.map((l) => [String(l.data.fromId), String(l.data.toId)] as [string, string]);
      const { wouldCreateDependencyCycle } = await import('../shared/deps');
      if (wouldCreateDependencyCycle([...allEdges, ...edges], br.id, bd.id)) return err('dependency cycle');
      const out = await linkRec('blocks', '', 'record', br.id, 'record', bd.id);
      return txt({ linkId: out.id, existed: out.existed });
    },
  );

  reg(
    'remove_dependency',
    {
      description: 'Remove a dependency (blocker no longer blocks blocked).',
      inputSchema: z.object({ blocker: z.string(), blocked: z.string(), databaseId: z.string().optional() }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      let br: Rec | null = null;
      let bd: Rec | null = null;
      if (a.databaseId) {
        br = await resolveRecordRef(a.databaseId, a.blocker);
        bd = await resolveRecordRef(a.databaseId, a.blocked);
      } else {
        br = await rec(ctx.env, 'tasks', a.blocker);
        bd = await rec(ctx.env, 'tasks', a.blocked);
      }
      if (!br || !bd) return err('record not found');
      const { linkId } = await import('../shared/linkid');
      const id = linkId('blocks', '', br.id, bd.id);
      const l = await getRec(ctx.env, id);
      if (!l || l.data.deleted) return txt({ removed: true, existed: false });
      await write(ctx, [{ collection: 'links', id, patch: { deleted: true } }]);
      return txt({ linkId: id, removed: true });
    },
  );

  server.registerTool(
    'query_records',
    {
      description: 'Query a database: filters/sorts use field NAMES. Returns rows with named field values + rev. limit ≤200, cursor paginates.',
      inputSchema: z.object({
        databaseId: z.string(),
        filters: z.array(z.object({ field: z.string(), op: z.string(), value: z.unknown().optional() })).optional(),
        sorts: z.array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']).optional() })).optional(),
        limit: z.number().optional(),
        cursor: z.string().optional(),
        include: z.array(z.enum(['fields', 'relations', 'subrecords', 'deps'])).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const board = await rec(ctx.env, 'boards', a.databaseId);
      if (!board || board.data.deleted) return err('database not found');
      const limit = Math.min(a.limit ?? 100, 200);
      const rows = live((await listBy(ctx.env, 'tasks', 'boardId', a.databaseId)).map(toRec));
      const { applyView } = await import('../shared/views');
      const fmap = new Map(fieldsOf(board.data).map((f) => [f.id, f]));
      await fillCaches(ctx);
      const relLinks = (await listCollection(ctx.env, 'links')).filter((l) => l.data.kind === 'relation' && l.data.fieldId);
      const relationTitles = (recordId: string, fieldId: string) => {
        const toIds = relLinks.filter((l) => l.data.fieldId === fieldId && String(l.data.fromId) === recordId).map((l) => String(l.data.toId));
        return toIds.map((id) => ctx.pageTitleById.get(id) ?? id);
      };
      const view = {
        filters: (a.filters ?? []).map((f) => ({ key: resolveFieldKey(board.data, f.field), op: f.op as import('../shared/views').FilterOp, value: f.value })),
        sorts: (a.sorts ?? []).map((s) => ({ key: resolveFieldKey(board.data, s.field), dir: (s.dir ?? 'asc') as 'asc' | 'desc' })),
      };
      const startIdx = a.cursor ? rows.findIndex((r) => r.id === a.cursor) + 1 : 0;
      const applied = applyView(rows.map((r) => ({ ...r.data, id: r.id })), view, { meId: ctx.userId, fieldsById: fmap, relationTitles, columnsById: new Map(boardColumns(board).map((c, i) => [c.id, i])) });
      const page = applied.rows.slice(startIdx, startIdx + limit);
      const include = new Set(a.include ?? ['fields']);
      const allTasks = live(await recs(ctx.env, 'tasks'));
      const depEdges = (await listCollection(ctx.env, 'links')).filter((l) => l.data.kind === 'blocks').map((l) => [String(l.data.fromId), String(l.data.toId)] as [string, string]);
      const out = page.map((data) => {
        const id = String(data.id ?? '');
        const rec: Record<string, unknown> = { id, rev: undefined, title: data.title, status: data.status, url: recordUrl(a.databaseId, id) };
        if (include.has('fields')) {
          const fields: Record<string, unknown> = {};
          for (const f of fieldsOf(board.data)) fields[f.name] = f.type === 'relation' ? relationTitles(id, f.id) : data[propKey(f.id)];
          rec.fields = fields;
        }
        if (include.has('subrecords')) rec.children = allTasks.filter((t) => String(t.data.parentId ?? '') === id).map((t) => ({ id: t.id, title: t.data.title }));
        if (include.has('deps')) {
          rec.blockedBy = depEdges.filter(([, t]) => t === id).map(([f]) => f);
          rec.blocking = depEdges.filter(([f]) => f === id).map(([, t]) => t);
        }
        return rec;
      });
      // fill revs
      const rowByData = new Map(rows.map((r) => [r.data, r]));
      for (const rec2 of out) {
        const row = page.find((d) => rowByData.get(d)?.id === rec2.id);
        if (row) rec2.rev = rowByData.get(row)?.rev;
      }
      const next = startIdx + limit < applied.rows.length ? applied.rows[startIdx + limit - 1]?.id ?? null : null;
      return txt({ rows: out, count: out.length, nextCursor: next });
    },
  );

  server.registerTool(
    'get_record',
    {
      description: 'Read one record: fields by name, stage, relations (titles+ids), parent, children, dependencies, body markdown, backlinks, comment count, rev, URL.',
      inputSchema: z.object({ recordId: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ recordId }) => {
      const r = await rec(ctx.env, 'tasks', recordId);
      if (!r || r.data.deleted) return err('record not found');
      await fillCaches(ctx);
      const dbId = String(r.data.boardId ?? 'board-default');
      const board = await rec(ctx.env, 'boards', dbId);
      const fields: Record<string, unknown> = {};
      const relations: Record<string, { id: string; title: string }[]> = {};
      const relLinks = (await listCollection(ctx.env, 'links')).filter((l) => l.data.kind === 'relation' && l.data.fieldId);
      const linkedIds = new Set<string>();
      for (const f of fieldsOf(board?.data)) {
        if (f.type === 'relation') {
          const fw = f.relation?.primary !== false || !f.relation?.pairedFieldId;
          const tos = relLinks.filter((l) => (fw ? l.data.fieldId === f.id && String(l.data.fromId) === recordId : l.data.fieldId === f.relation?.pairedFieldId && String(l.data.toId) === recordId));
          const vals = tos.map((l) => {
            const other = fw ? String(l.data.toId) : String(l.data.fromId);
            linkedIds.add(other);
            return { id: other, title: ctx.pageTitleById.get(other) ?? '' };
          });
          relations[f.name] = vals;
        } else {
          fields[f.name] = r.data[propKey(f.id)];
        }
      }
      const allTasks = live(await recs(ctx.env, 'tasks'));
      const children = allTasks.filter((t) => String(t.data.parentId ?? '') === recordId);
      const parent = r.data.parentId ? allTasks.find((t) => t.id === r.data.parentId) : null;
      const depLinks = (await listCollection(ctx.env, 'links')).filter((l) => l.data.kind === 'blocks');
      const bodyBlocks = live((await listBy(ctx.env, 'blocks', 'pageId', recordId)).map(toRec)).sort(byOrder);
      const titleOfRec = (id: string) => String(allTasks.find((t) => t.id === id)?.data.title ?? ctx.pageTitleById.get(id) ?? id);
      const comments = (await listBy(ctx.env, 'comments', 'targetId', recordId)).filter((c) => c.data.targetType === 'task' || c.data.targetType === 'record');
      const relRelated = (await listCollection(ctx.env, 'links')).filter((l) => l.data.kind === 'related' && (String(l.data.fromId) === recordId || String(l.data.toId) === recordId));
      return txt({
        record: {
          id: r.id, rev: r.rev, url: recordUrl(dbId, r.id), databaseId: dbId, title: r.data.title, stage: r.data.status,
          assignee: ctx.userNameById.get(String(r.data.assigneeId ?? '')), due: r.data.dueDate, priority: r.data.priority,
          fields, relations,
          parent: parent ? { id: parent.id, title: parent.data.title } : null,
          children: children.map((c) => ({ id: c.id, title: c.data.title })),
          blockedBy: depLinks.filter((l) => String(l.data.toId) === recordId).map((l) => ({ id: String(l.data.fromId), title: titleOfRec(String(l.data.fromId)) })),
          blocking: depLinks.filter((l) => String(l.data.fromId) === recordId).map((l) => ({ id: String(l.data.toId), title: titleOfRec(String(l.data.toId)) })),
          related: relRelated.map((l) => ({ linkId: l.id, other: String(l.data.fromId) === recordId ? String(l.data.toId) : String(l.data.fromId), title: titleOfRec(String(l.data.fromId) === recordId ? String(l.data.toId) : String(l.data.fromId)) })),
          body: blocksToMarkdown(bodyBlocks.map((b) => ({ type: String(b.data.type ?? 'p'), text: String(b.data.text ?? ''), checked: !!b.data.checked })), { userName: (id) => ctx.userNameById.get(id), pageTitle: (id) => ctx.pageTitleById.get(id) }),
          bodyBlocks: bodyBlocks.map((b) => ({ id: b.id, type: b.data.type ?? 'p', text: b.data.text ?? '', rev: b.rev })),
          comments: comments.length,
          updatedBy: r.updatedBy, updatedAt: r.updatedAt,
        },
      });
    },
  );

  reg(
    'edit_record_body',
    {
      description: 'Edit a record\u2019s body blocks — same shape as edit_page (appendMarkdown / markdown+insertAfterBlockId / replaceBlocks / deleteBlocks). replaceBlocks/deleteBlocks guard on EACH block\'s own rev (get_record returns bodyBlocks with per-block rev).',
      inputSchema: z.object({
        recordId: z.string(),
        appendMarkdown: z.string().optional(),
        markdown: z.string().optional(),
        insertAfterBlockId: z.string().optional(),
        replaceBlocks: z.array(z.object({ blockId: z.string(), markdown: z.string(), expectedRev: z.number().describe("That block's own rev from get_record bodyBlocks[]") })).optional(),
        deleteBlocks: z.array(z.object({ blockId: z.string(), expectedRev: z.number().describe("That block's own rev from get_record bodyBlocks[]") })).optional(),
        deleteBlockIds: z.array(z.string()).optional().describe('DEPRECATED unguarded — use deleteBlocks (per-block expectedRev)'),
        dryRun: dryRunInput,
      }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const r = await rec(ctx.env, 'tasks', a.recordId);
      if (!r || r.data.deleted) return err('record not found');
      if (a.deleteBlockIds?.length) return err('deleteBlockIds cannot be rev-guarded — pass deleteBlocks:[{blockId, expectedRev}] (get_record returns each body block\'s rev)');
      await fillCaches(ctx);
      if (a.dryRun) return txt({ dryRun: true, summary: `edit_record_body ${a.recordId}`, counts: { appended: a.appendMarkdown ? markdownToBlocks(a.appendMarkdown).length : 0, replaced: a.replaceBlocks?.length ?? 0, deleted: a.deleteBlocks?.length ?? 0 }, warnings: [], impact: { deleteBlockIds: (a.deleteBlocks ?? []).map((d) => d.blockId) } });
      const ops: WriteOp[] = [];
      const expect = new Map<string, number>();
      const existing = live((await listBy(ctx.env, 'blocks', 'pageId', a.recordId)).map(toRec));
      for (const rr of a.replaceBlocks ?? []) {
        const src = existing.find((b) => b.id === rr.blockId);
        if (!src) return err(`block ${rr.blockId} not found`);
        // Guard the block at ITS OWN read rev (review B3).
        expect.set(rr.blockId, rr.expectedRev);
        const parsed = markdownToBlocks(rr.markdown, { resolveUser: resolverFor(ctx, 'user'), resolvePage: resolverFor(ctx, 'page') });
        const first = parsed[0];
        if (!first) continue;
        ops.push({ collection: 'blocks', id: rr.blockId, patch: { type: first.type, text: first.text ?? '', ...(first.type === 'todo' ? { checked: !!first.checked } : {}) } });
      }
      for (const d of a.deleteBlocks ?? []) {
        if (!existing.some((b) => b.id === d.blockId)) return err(`block ${d.blockId} not found`);
        expect.set(d.blockId, d.expectedRev);
        ops.push({ collection: 'blocks', id: d.blockId, patch: { deleted: true } });
      }
      if (a.markdown && a.insertAfterBlockId) ops.push(...(await blockOps(ctx, a.recordId, a.markdown, existing, a.insertAfterBlockId)));
      if (a.appendMarkdown) ops.push(...(await blockOps(ctx, a.recordId, a.appendMarkdown, existing)));
      await write(ctx, ops, { expect });
      return txt({ recordId: a.recordId, url: recordUrl(String(r.data.boardId ?? 'board-default'), a.recordId), updated: ops.length });
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

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } });
}

/**
 * apiHandler for OAuthProvider: validates the token's user still exists in D1
 * (a wiped DB must re-auth rather than write as a ghost), then delegates to the
 * stateless MCP handler. ctx.props comes from completeAuthorization().
 *
 * SECURITY: the handler MUST be built per request. The factory closure binds
 * this request's env/ctx/props (identity); caching the handler at module level
 * makes every later request execute and attribute as the first caller and
 * targets waitUntil at a finished request's ExecutionContext.
 */
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx.props ?? {}) as { userId?: string; clientName?: string };
    if (!props.userId) return unauthorized();
    const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(props.userId).first<{ id: string }>();
    if (!user) return unauthorized();
    return createMcpHandler(
      (mcpCtx: McpRequestContext) => createWorkspaceServer(ctxFor(env, ctx, mcpCtx, props)),
      { route: '/mcp' },
    )(request, env, ctx);
  },
};

function ctxFor(env: Env, ectx: ExecutionContext, mcpCtx: McpRequestContext, props: { userId?: string; clientName?: string; userRole?: 'admin' | 'member' }): Ctx {
  const url = new URL(mcpCtx.requestInfo?.url ?? 'https://workspace.local');
  return {
    env,
    ectx,
    userId: props.userId!,
    userRole: props.userRole ?? 'member',
    clientName: props.clientName,
    origin: url.origin,
    userByKey: new Map(),
    userNameById: new Map(),
    pageTitleById: new Map(),
    pageIdByTitle: new Map(),
    cachesReady: false,
    warnings: [],
    cs: null,
    toolName: '',
  };
}

