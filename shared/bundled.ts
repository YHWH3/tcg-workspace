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

import {validateAttentionConfig,type AttentionConfig,type AttentionKind} from './attention';
import { linkId } from './linkid';
import type { FieldDef } from './fields';
import type { Filter } from './views';
import {planTemplateInstantiation,installRecordId,type RecSnapshot,type PlannedWrite} from './templates';

export interface BundledTemplate {
  version: number;
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
  key?: string;
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
  attention?: AttentionConfig;
}

/** Object-form block inside `pages[].blocks` (string lines also accepted). */
export interface AuthorBlock {
  key?: string;
  type:
    | 'text' | 'h1' | 'h2' | 'h3' | 'bulleted' | 'todo' | 'divider' | 'callout' | 'tasks'
    | 'view' | 'metric' | 'calendar' | 'activity' | 'mywork' | 'attention' | 'projecthealth' | 'budget' | 'fieldsessions' | 'measurechart' | 'eventops' | 'embed';
  text?: string;
  checked?: boolean;
  url?: string;
  // dashboard block config (Phase 3 §3) — databaseId/sources ids are authored
  databaseId?: string;
  projectId?: string;
  recordId?: string;
  mode?: 'project' | 'product';
  dateKey?: string;
  eventId?: string;
  capacityKey?: string;
  facilitatorsKey?: string;
  volunteersKey?: string;
  participantsKey?: string;
  upcomingOnly?: boolean;
  measurementKey?: string;
  unitKey?: string;
  observationKey?: string;
  photoKey?: string;
  placeKey?: string;
  experimentKey?: string;
  projectKey?: string;
  experimentId?: string;
  placeId?: string;
  unit?: string;
  missingOnly?: boolean;
  budgetKey?: string;
  amountKey?: string;
  typeKey?: string;
  relationKey?: string;
  priceKey?: string;
  costKey?: string;
  ownerKey?: string;
  startKey?: string;
  endKey?: string;
  staleDays?: number;
  viewId?: string;
  limit?: number;
  heading?: string;
  kinds?: AttentionKind[];
  compact?: boolean;
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
  key?: string;
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
  version?: number;
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
    'databaseId', 'viewId', 'inline', 'limit', 'heading', 'filters', 'kinds', 'compact',
    'agg', 'fieldKey', 'label', 'format', 'sources', 'scope', 'url', 'projectId','recordId','eventId','capacityKey','facilitatorsKey','volunteersKey','participantsKey','upcomingOnly','mode','measurementKey','unitKey','observationKey','photoKey','placeKey','experimentKey','projectKey','experimentId','placeId','unit','missingOnly','dateKey','budgetKey','amountKey','typeKey','relationKey','priceKey','costKey','ownerKey','startKey','endKey','staleDays',
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
      views[v.id] = { templateItemKey:v.key??v.id, databaseId: d.id, name: v.name, type: v.type ?? 'table', config: v.config ?? {}, order: v.order ?? viewOrder };
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
      ...(d.attention===undefined?{}:{attention:validateAttentionConfig(d.attention,d as unknown as Record<string,unknown>)}),
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
      templateItemKey:pg.key??pg.id,
      ...(pg.id===t.pages[0]?.id?{templateVersion:t.version??1}:{}),
      title: pg.title,
      icon: pg.icon,
      parentId: pg.parentId ?? null,
      order: pg.order ?? nextOrder(),
      isTemplate: pg.template === true,
    };
    let blockOrder = 'a0';
    for (const entry of pg.blocks ?? []) {
      blockOrder += '0';
      const legacyId=oid(),id=typeof entry==='object'&&entry.key?entry.key:legacyId;
      if (typeof entry === 'string') {
        const m = EMBED_RE.exec(entry.trim());
        if (m && dbIds.has(m[1])) {
          blocks[id] = { pageId: pg.id, order: blockOrder, type: 'tasks', boardId: m[1] };
        } else {
          blocks[id] = { pageId: pg.id, order: blockOrder, type: 'p', text: entry };
        }
      } else {
        blocks[id] = {...toStoredBlock(entry, pg.id, blockOrder),templateItemKey:entry.key??id};
      }
      blocks[id].templateItemKey=typeof entry==='object'?(entry.key??id):id;
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
  return { version:t.version??1, key, name: t.name, description: t.description, icon: t.icon, root, snapshot: { pages, blocks, boards, tasks, views, links, automations, forms } };
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

/** Additive upgrade planner. Stable install ids are the first legacy fallback:
 * they survive team renames and moves. Keys and structural matches cover older
 * imported installs; ambiguous matches are held, never guessed. Deleted ids stay
 * reserved. Records, links, stage columns and existing item content are untouched. */
export interface PackRecord {id:string;collection:string;data:Record<string,unknown>;rev?:number}
export interface PackUpgradeWrite extends PlannedWrite {reason:string;before:Record<string,unknown>|null}
export interface PackUpgradePlan {rootPageId:string|null;version:number;writes:PackUpgradeWrite[];warnings:string[]}
export function planPackUpgrade(bundle:BundledTemplate,existing:PackRecord[],options:{now?:number;actorId?:string}={}):PackUpgradePlan {
 const warnings:string[]=[],writes:PackUpgradeWrite[]=[],version=bundle.version??1;
 const byId=new Map(existing.map(r=>[r.id,r]));
 const stable=(collection:string,id:string)=>installRecordId(bundle.key,collection,id);
 const roots=existing.filter(r=>r.collection==='pages'&&r.data.templateKey===bundle.key);
 const root=byId.get(stable('pages',bundle.root))??(roots.length===1?roots[0]:undefined);
 if(!root||root.collection!=='pages'||root.data.deleted||root.data.archived||roots.length>1)return {rootPageId:null,version,writes,warnings:['A single active installed root is required. Restore or resolve the existing installation first.']};
 if(Number(root.data.templateVersion??0)>version)return {rootPageId:root.id,version,writes,warnings:['This installation uses a newer pack version. Update the application before upgrading.']};
 const plan=planTemplateInstantiation(bundle.snapshot,{templateId:bundle.root,templateKey:bundle.key,stableIds:true,packInstall:true,preserveTemplates:true,actorId:options.actorId},{id:()=>{throw new Error('stable pack ids required');},now:options.now??0});
 if(!plan)throw new Error('invalid bundled root');
 const desired=plan.writes.filter(w=>['boards','pages','views','blocks'].includes(w.collection)&&!(w.collection==='blocks'&&w.patch.parentType==='record'));
 const maps=new Map<string,string>([[stable('pages',bundle.root),root.id]]),held=new Set<string>();
 const remap=(value:unknown):unknown=>{
  if(typeof value==='string')return maps.get(value)??value;
  if(Array.isArray(value))return value.map(remap);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,remap(v)]));
  return value;
 };
 function resolve(w:PlannedWrite){
  if(maps.has(w.id))return;
  const exact=byId.get(w.id);
  if(exact){if(exact.collection===w.collection)maps.set(w.id,exact.id);else{held.add(w.id);warnings.push(`Reserved id has another type: ${w.id}`);}return;}
  const data=remap(w.patch) as Record<string,unknown>;
  const candidates=existing.filter(r=>{
   if(r.collection!==w.collection)return false;
   if(w.collection==='boards')return !!data.templateDbKey&&r.data.templateDbKey===data.templateDbKey;
   const parent=w.collection==='pages'?'parentId':w.collection==='views'?'databaseId':'pageId';
   if((r.data[parent]??null)!==(data[parent]??null))return false;
   if(data.templateItemKey&&r.data.templateItemKey===data.templateItemKey)return true;
   if(w.collection==='pages')return r.data.title===data.title;
   if(w.collection==='views')return r.data.name===data.name;
   return r.data.type===data.type&&String(r.data.label??r.data.heading??r.data.text??'')===String(data.label??data.heading??data.text??'');
  });
  if(candidates.length===1)maps.set(w.id,candidates[0].id);
  else if(candidates.length>1){held.add(w.id);warnings.push(`Ambiguous ${w.collection} match: ${String(data.title??data.name??data.label??w.id)}`);}
 }
 for(const w of desired.filter(w=>w.collection==='boards'))resolve(w);
 // Resolve parents before their children, regardless of authored order.
 const pages=desired.filter(w=>w.collection==='pages');
 for(let n=0;n<=pages.length;n++)for(const w of pages)if(!w.patch.parentId||maps.has(String(w.patch.parentId))||!pages.some(p=>p.id===w.patch.parentId))resolve(w);
 for(const w of pages)resolve(w);
 for(const c of ['views','blocks'])for(const w of desired.filter(w=>w.collection===c))resolve(w);
 const unavailable=new Set<string>();
 const unusable=(id:unknown)=>typeof id==='string'&&(unavailable.has(id)||held.has(id)||!!byId.get(maps.get(id)??id)?.data.deleted||!!byId.get(maps.get(id)??id)?.data.archived);
 for(let pass=0;pass<desired.length;pass++){let changed=false;for(const w of desired)if(!unavailable.has(w.id)&&(unusable(w.id)||unusable(w.patch.parentId)||unusable(w.patch.pageId)||unusable(w.patch.databaseId)||unusable(w.patch.boardId))){unavailable.add(w.id);changed=true;}if(!changed)break;}
 for(const w of desired){
  if(held.has(w.id)||unusable(w.id)||unusable(w.patch.parentId)||unusable(w.patch.pageId)||unusable(w.patch.databaseId)||unusable(w.patch.boardId))continue;
  const id=maps.get(w.id)??w.id,old=byId.get(id),patch=remap(w.patch) as Record<string,unknown>;
  if(!old){
   // Never place additions before/reorder existing siblings. A deterministic
   // suffix follows the current last item; preserve every existing order value.
   const parent=w.collection==='pages'?'parentId':w.collection==='views'?'databaseId':w.collection==='blocks'?'pageId':null;
   const orders=existing.filter(r=>r.collection===w.collection&&(!parent||(r.data[parent]??null)===(patch[parent]??null))).map(r=>String(r.data.order??'')).sort();
   patch.order=(orders.at(-1)??'')+'z'+w.id;
   writes.push({...w,id,patch,before:null,reason:`Add missing ${w.collection==='boards'?'database':w.collection.slice(0,-1)}: ${String(patch.title??patch.name??patch.label??patch.heading??patch.type??id)}`});
   continue;
  }
  if(w.collection!=='boards')continue;
  const prior=Array.isArray(old.data.fields)?structuredClone(old.data.fields) as FieldDef[]:[];
  const fields=structuredClone(prior),reasons:string[]=[];
  for(const wanted of (patch.fields??[]) as FieldDef[]){
   const field=fields.find(f=>f.id===wanted.id);
   if(!field){fields.push(structuredClone(wanted));reasons.push(`Add field ${wanted.name}`);continue;}
   // A changed type, name, format, currency or option label belongs to the team.
   if(field.type!==wanted.type)continue;
   if(field.type==='number')for(const key of ['format','currency'] as const)if(field[key]===undefined&&wanted[key]!==undefined){Object.assign(field,{[key]:wanted[key]});reasons.push(key==='format'?`Show ${field.name} as ${wanted.format}`:`Set ${field.name} currency to ${wanted.currency}`);}
   if(Array.isArray(wanted.options)){
    const opts=field.options??[];
    for(const option of wanted.options)if(!opts.some(o=>o.id===option.id||o.name.toLocaleLowerCase()===option.name.toLocaleLowerCase())){opts.push(structuredClone(option));reasons.push(`Add option ${option.name} to ${field.name}`);}
    field.options=opts;
   }
  }
  const additions:Record<string,unknown>={},before:Record<string,unknown>={};
  if(reasons.length){additions.fields=fields;before.fields=old.data.fields??null;}
  // Missing configuration is additive. Explicit null/disabled/custom settings
  // belong to the team and survive every later pack upgrade.
  if(old.data.attention===undefined&&patch.attention!==undefined){
   try{additions.attention=validateAttentionConfig(patch.attention,{...old.data,fields});before.attention=null;reasons.push('Configure attention');}
   catch{warnings.push(`Attention fields changed on ${String(old.data.name??id)}; configure attention manually`);}
  }
  if(reasons.length)writes.push({collection:'boards',id,patch:additions,before,reason:reasons.join('; ')});
 }
 // An unresolved item prevents marking the bundle version complete. Partial
 // additive work can be reviewed, but never silently declare a held plan done.
 if(!warnings.length&&Number(root.data.templateVersion??0)<version)writes.push({collection:'pages',id:root.id,patch:{templateVersion:version},before:{templateVersion:root.data.templateVersion??null},reason:`Update pack to version ${version}`});
 return {rootPageId:root.id,version,writes,warnings};
}
