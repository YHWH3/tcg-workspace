/* Bundled-template author format → RecSnapshot compiler (Phase 3 §4). Pure and
 * importable by the worker: `templates/*.json` are hand-authored data; this
 * module turns them into the snapshot `planTemplateInstantiation` consumes.
 *
 * Authoring rules:
 * - Every `databaseId` / relation `target` / `sources[].databaseId` /
 *   `captureTargets[].databaseId` value is an AUTHORED db id (`db_<slug>`) —
 *   the planner remaps them to live board ids at install.
 * - `links[].from/to` are authored page or record ids.
 * - `db.key` is the stable reuse key: the snapshot carries it on the board and
 *   the planner stamps it as `templateDbKey` so re-installs dedupe.
 * - String block lines still work: plain text → text block, `Embed: db_x` →
 *   embedded `tasks` block. Object blocks cover every stored block config. */

import { linkId } from './linkid';
import type { FieldDef } from './fields';
import type { Filter } from './views';
import type { RecSnapshot } from './templates';

export interface BundledTemplate {
  key: string;
  name: string;
  description: string;
  icon: string;
  root: string;
  snapshot: RecSnapshot;
}

/** Capture kinds a context database can route (§1.3); `fieldActions` may also list input kinds. */
export type CaptureKind = 'observation' | 'expense' | 'task' | 'note' | 'photo' | 'voice' | 'text';

export interface AuthorCaptureTarget {
  kind: CaptureKind | (string & {});
  /** Authored db id the capture routes to (or a literal live id). */
  databaseId: string;
}

export interface AuthorView {
  id: string;
  name: string;
  type?: string;
  config?: Record<string, unknown>;
  order?: string;
}

/** Authored starter record (`databases[].records[]`) → snapshot `tasks` row. */
export interface AuthorRecord {
  id: string;
  title: string;
  status?: string | null;
  /** Custom-field values, keyed `p_<fieldId>` like stored records. */
  props?: Record<`p_${string}`, unknown>;
  /** Body paragraphs → `blocks` rows (parentType 'record'). */
  body?: string[];
}

export interface AuthorDb {
  id: string;
  /** Stable dedupe key → stamped as `templateDbKey` on install; drives findReusableBoards. */
  key?: string;
  name: string;
  icon?: string;
  kind?: string;
  recordNoun?: string;
  showBuiltins?: Record<string, boolean>;
  columns?: { id: string; name: string; color?: string }[];
  fields?: FieldDef[]; // relation.target = authored db id (remapped by the planner)
  captureTargets?: AuthorCaptureTarget[]; // databaseId = authored id or literal
  fieldActions?: string[];
  defaultViewId?: string;
  views?: AuthorView[];
  records?: AuthorRecord[];
}

/** Object-form block inside `pages[].blocks` (string lines also accepted). */
export interface AuthorBlock {
  type:
    | 'text' | 'h1' | 'h2' | 'h3' | 'bulleted' | 'todo' | 'divider' | 'callout' | 'tasks'
    | 'view' | 'metric' | 'calendar' | 'activity' | 'mywork' | 'embed';
  text?: string;
  checked?: boolean;
  url?: string;
  // dashboard block config (Phase 3 §3) — databaseId/sources ids are authored
  databaseId?: string;
  viewId?: string;
  limit?: number;
  heading?: string;
  filters?: Filter[];
  agg?: string;
  fieldKey?: string;
  label?: string;
  format?: string;
  sources?: { databaseId: string; dateKey?: string; filters?: Filter[]; color?: string }[];
  scope?: unknown;
  inline?: Record<string, unknown>; // `view` block inline ViewConfig (e.g. {includeArchived:true})
}

export interface AuthorPage {
  id: string;
  title: string;
  icon?: string;
  parentId?: string | null;
  /** Authored page template — stays `isTemplate:true` when the planner runs with preserveTemplates. */
  template?: boolean;
  order?: string;
  blocks?: (string | AuthorBlock)[];
}

export interface AuthorLink {
  from: string;
  to: string;
  kind?: string;
  fieldId?: string | null;
}

export interface AuthorTemplate {
  $schema?: string;
  name: string;
  description: string;
  icon: string;
  databases: AuthorDb[];
  pages: AuthorPage[];
  links?: AuthorLink[];
  /** Phase 4 — automation configs (`{id, databaseId, trigger, conditions, actions}`;
   * authored db/page/form ids inside are remapped by the planner at install). */
  automations?: ({ id: string } & Record<string, unknown>)[];
  /** Phase 4 — public form configs (same authored-id remap). */
  forms?: ({ id: string } & Record<string, unknown>)[];
}

/** Author names that differ from stored block type ids. */
const AUTHOR_TYPE_MAP: Record<string, string> = { text: 'p', bulleted: 'bullet' };
const storedType = (t: string): string => AUTHOR_TYPE_MAP[t] ?? t;

const EMBED_RE = /^Embed:\s*(\S+)$/;

/** Typed-object block → stored block row (authored db ids kept — the planner remaps). */
function toStoredBlock(b: AuthorBlock, pageId: string, order: string): Record<string, unknown> {
  const out: Record<string, unknown> = { pageId, order, type: storedType(b.type) };
  if (b.text !== undefined) out.text = b.text;
  if (b.checked !== undefined) out.checked = b.checked;
  if (b.type === 'tasks') {
    if (b.databaseId) out.boardId = b.databaseId; // stored `tasks` blocks use boardId
    return out;
  }
  if (b.type === 'embed') {
    if (b.url !== undefined) out.url = b.url;
    return out;
  }
  for (const k of [
    'databaseId', 'viewId', 'inline', 'limit', 'heading', 'filters',
    'agg', 'fieldKey', 'label', 'format', 'sources', 'scope', 'url',
  ] as const) {
    const v = b[k as keyof AuthorBlock];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Convert the hand-authored template format ({databases,pages,links}) into the RecSnapshot the planner consumes. */
export function toBundled(key: string, t: AuthorTemplate): BundledTemplate {
  const boards: NonNullable<RecSnapshot['boards']> = {};
  const views: NonNullable<RecSnapshot['views']> = {};
  const blocks: NonNullable<RecSnapshot['blocks']> = {};
  const tasks: NonNullable<RecSnapshot['tasks']> = {};
  const pages: NonNullable<RecSnapshot['pages']> = {};
  const links: NonNullable<RecSnapshot['links']> = {};

  // Per-bundle deterministic ids (remapped by the planner anyway) — no module
  // state so the worker can import this freely.
  let n = 0;
  const oid = () => `tpl_${(n++).toString(36)}`;
  let orderSeq = 0;
  const nextOrder = () => `a${orderSeq++}`;

  const dbIds = new Set((t.databases ?? []).map((d) => d.id));
  const pageIds = new Set((t.pages ?? []).map((p) => p.id));
  const recIds = new Set<string>();
  for (const d of t.databases ?? []) for (const r of d.records ?? []) recIds.add(r.id);

  for (const d of t.databases ?? []) {
    let viewOrder = 'a0';
    for (const v of d.views ?? []) {
      viewOrder += '0';
      views[v.id] = { databaseId: d.id, name: v.name, type: v.type ?? 'table', config: v.config ?? {}, order: v.order ?? viewOrder };
    }
    let recOrder = 'a0';
    for (const r of d.records ?? []) {
      recOrder += '0';
      tasks[r.id] = { boardId: d.id, title: r.title, status: r.status ?? null, order: recOrder, ...(r.props ?? {}) };
      let bodyOrder = 'a0';
      for (const line of r.body ?? []) {
        bodyOrder += '0';
        const id = oid();
        blocks[id] = { pageId: r.id, parentType: 'record', order: bodyOrder, type: 'p', text: String(line) };
      }
    }
    boards[d.id] = {
      name: d.name,
      icon: d.icon,
      kind: d.kind,
      recordNoun: d.recordNoun,
      showBuiltins: d.showBuiltins,
      columns: d.columns,
      fields: d.fields,
      // `key` rides the snapshot so the planner can stamp `templateDbKey` and
      // previews/findReusableBoards can match on it.
      key: d.key,
      captureTargets: d.captureTargets,
      fieldActions: d.fieldActions,
      defaultViewId: d.defaultViewId ?? d.views?.[0]?.id,
      order: nextOrder(),
    };
  }

  for (const pg of t.pages ?? []) {
    pages[pg.id] = {
      title: pg.title,
      icon: pg.icon,
      parentId: pg.parentId ?? null,
      order: pg.order ?? nextOrder(),
      isTemplate: pg.template === true,
    };
    let blockOrder = 'a0';
    for (const entry of pg.blocks ?? []) {
      blockOrder += '0';
      const id = oid();
      if (typeof entry === 'string') {
        const m = EMBED_RE.exec(entry.trim());
        if (m && dbIds.has(m[1])) {
          blocks[id] = { pageId: pg.id, order: blockOrder, type: 'tasks', boardId: m[1] };
        } else {
          blocks[id] = { pageId: pg.id, order: blockOrder, type: 'p', text: entry };
        }
      } else {
        blocks[id] = toStoredBlock(entry, pg.id, blockOrder);
      }
    }
  }

  for (const l of t.links ?? []) {
    const kind = l.kind ?? 'related';
    const fieldId = l.fieldId ?? null;
    links[linkId(kind, fieldId, l.from, l.to)] = {
      fromId: l.from,
      toId: l.to,
      kind,
      fieldId,
      fromType: pageIds.has(l.from) ? 'page' : 'record',
      toType: pageIds.has(l.to) ? 'page' : 'record',
    };
  }

  const automations: NonNullable<RecSnapshot['automations']> = {};
  const forms: NonNullable<RecSnapshot['forms']> = {};
  for (const a of t.automations ?? []) {
    const { id, ...cfg } = a;
    automations[id] = cfg;
  }
  for (const f of t.forms ?? []) {
    const { id, ...cfg } = f;
    forms[id] = cfg;
  }

  const root = t.pages[0]?.id ?? 'root';
  return { key, name: t.name, description: t.description, icon: t.icon, root, snapshot: { pages, blocks, boards, tasks, views, links, automations, forms } };
}

/* ---------- install preview + reuse ---------- */

/** Live-board shape the matcher needs (subset of a boards record). */
export interface ExistingBoardLike {
  id: string;
  templateDbKey?: string;
  templateKey?: string;
  name?: string;
  deleted?: boolean;
}

/** Starter-people installs predate `templateDbKey`: only these keys may fall back to name matching. */
const NAME_FALLBACK_KEYS = new Set(['people', 'organizations']);

function matchReusableBoards(existing: ExistingBoardLike[], entries: { refId: string; key?: string; name?: string }[]): Record<string, string> {
  const live = existing.filter((b) => !b.deleted);
  const out: Record<string, string> = {};
  for (const e of entries) {
    if (!e.key) continue;
    const hit =
      live.find((b) => b.templateDbKey === e.key) ??
      (NAME_FALLBACK_KEYS.has(e.key) ? live.find((b) => b.templateKey === 'starter-people' && b.name === e.name) : undefined);
    if (hit) out[e.refId] = hit.id;
  }
  return out;
}

/**
 * authored db id → existing live board id. Match by `templateDbKey === db.key`;
 * fallback for pre-key installs: `templateKey === 'starter-people'` && name
 * equals the authored name (people/organizations keys only). Re-run safety:
 * pack databases carry `key`, so a second install reuses what the first made.
 */
export function findReusableBoards(existing: ExistingBoardLike[], author: AuthorTemplate): Record<string, string> {
  return matchReusableBoards(
    existing,
    (author.databases ?? []).map((d) => ({ refId: d.id, key: d.key, name: d.name })),
  );
}

export interface InstallPreview {
  databases: { create: string[]; reuse: string[] };
  pages: number;
  views: number;
  links: number;
  records: number;
  blocks: number;
  /** Views/records the install does not count as its own creates: authored
   * content on boards that will be reused, plus content on shared databases
   * (the people/organizations keys) — a shared database's authored content
   * belongs to its canonical bundle's lifecycle even when this install has to
   * bootstrap the board itself. */
  reused: { views: number; records: number; links: number };
}

/**
 * What an install would write — drives the gallery preview sheet and the MCP
 * `install_template` dry-run result. Counts mirror the planner: boards/records/
 * views of REUSED databases are not written, and links only land when both
 * ends are inside the copied set. `create`/`reuse` list database names.
 * Views/records on shared databases (people/organizations keys — reusable
 * across bundles via NAME_FALLBACK_KEYS) are accounted in `reused`, never in
 * `views`/`records`: their content lifecycle belongs to the shared bundle, so
 * the preview stays truthful whether the shared boards already exist or not.
 */
export function planInstallPreview(bundle: BundledTemplate, existing: ExistingBoardLike[]): InstallPreview {
  const snap = bundle.snapshot;
  const boardEntries = Object.entries(snap.boards ?? {}).map(([id, b]) => ({
    refId: id,
    key: b.key as string | undefined,
    name: b.name as string | undefined,
  }));
  const reuseMap = matchReusableBoards(existing, boardEntries);
  const reused = new Set(Object.keys(reuseMap));
  // Reused boards ∪ shared databases: views/records on either are reused-side
  // accounting, not this install's creates.
  const excludedDbIds = new Set<string>(reused);
  for (const e of boardEntries) if (e.key !== undefined && NAME_FALLBACK_KEYS.has(e.key)) excludedDbIds.add(e.refId);

  const pageIds = new Set(Object.entries(snap.pages ?? {}).filter(([, p]) => !p.deleted).map(([id]) => id));
  const recordIds = new Set(
    Object.entries(snap.tasks ?? {})
      .filter(([, t]) => !t.deleted && !excludedDbIds.has(String(t.boardId ?? 'board-default')))
      .map(([id]) => id),
  );
  const insideCopy = (x: unknown): boolean => pageIds.has(String(x)) || recordIds.has(String(x));

  const authoredViews = Object.values(snap.views ?? {}).filter((v) => !v.deleted);
  const views = authoredViews.filter((v) => !excludedDbIds.has(String(v.databaseId ?? ''))).length;
  const authoredRecords = Object.values(snap.tasks ?? {}).filter((t) => !t.deleted);
  // A link is only written when BOTH ends resolve into the copied set; links
  // touching reused/shared-database records are skipped and reported under
  // `reused.links` so the count is honest about what the install writes.
  const authoredLinks = Object.values(snap.links ?? {}).filter((l) => !l.deleted);
  const authoredRecordIds = new Set(Object.keys(snap.tasks ?? {}));
  const insideAuthored = (x: unknown): boolean => pageIds.has(String(x)) || authoredRecordIds.has(String(x));
  const links = authoredLinks.filter((l) => insideCopy(l.fromId) && insideCopy(l.toId)).length;
  const reusedLinks = authoredLinks.filter((l) => insideAuthored(l.fromId) && insideAuthored(l.toId)).length - links;
  const blocks = Object.values(snap.blocks ?? {}).filter((b) => !b.deleted && insideCopy(b.pageId)).length;

  return {
    databases: {
      create: boardEntries.filter((e) => !reused.has(e.refId)).map((e) => e.name ?? e.refId),
      reuse: boardEntries.filter((e) => reused.has(e.refId)).map((e) => e.name ?? e.refId),
    },
    pages: pageIds.size,
    views,
    links,
    records: recordIds.size,
    blocks,
    reused: { views: authoredViews.length - views, records: authoredRecords.length - recordIds.size, links: reusedLinks },
  };
}
