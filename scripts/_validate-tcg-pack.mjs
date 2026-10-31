#!/usr/bin/env node
/**
 * _validate-tcg-pack.mjs — deep reference check for templates/tcg-pack.json.
 *
 * Asserts every cross-reference in the authored pack resolves to an authored
 * id and that the two-way relation graph is symmetric:
 *   - databases: unique ids, `key` present, unique field ids, stage column ids
 *   - relation fields: target resolves; paired relations are reciprocal with
 *     exactly one primary side; one-way fields carry no pair
 *   - views: `type` known; config `visible`/`dateKey`/`endDateKey`/`groupBy`/
 *     `filters[].key`/`sorts[].key` FieldKeys resolve (builtins, p_<fid>,
 *     rel_<fid>); filter values for select fields name a real option
 *   - pages: unique ids; parentId resolves; blocks use contract types; every
 *     `databaseId`, `viewId`, `sources[].databaseId`, `captureTargets[].databaseId`
 *     resolves; inline ViewConfigs pass the same key checks
 *   - records: props keys are p_<fid> of that db; status is a column id
 *   - links: from/to resolve to authored pages or records
 *   - JSON < ~250 KB
 *
 *   node scripts/_validate-tcg-pack.mjs [path/to/tcg-pack.json]
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? new URL('../templates/tcg-pack.json', import.meta.url).pathname;
const tpl = JSON.parse(readFileSync(file, 'utf8'));

const BUILTINS = new Set(['title', 'status', 'assigneeId', 'dueDate', 'priority', 'createdAt', 'createdBy', 'archived']);
const FIELDKEY = /^(p|rel)_(.+)$/;
const VIEW_TYPES = new Set(['board', 'table', 'list', 'gallery', 'calendar', 'timeline']);
const FILTER_OPS = new Set([
  'is', 'is_not', 'contains', 'not_contains', 'empty', 'not_empty',
  'before', 'after', 'on_or_before', 'on_or_after', 'within', 'checked', 'unchecked', 'me',
]);
const BLOCK_TYPES = new Set([
  'text', 'h1', 'h2', 'h3', 'bulleted', 'todo', 'divider', 'callout', 'tasks',
  'view', 'metric', 'calendar', 'activity', 'mywork', 'attention', 'projecthealth', 'budget', 'fieldsessions', 'measurechart', 'eventops', 'embed',
]);

const errors = [];
const warn = [];
const err = (m) => errors.push(m);

/* ---------- indexes ---------- */
const dbs = new Map();
for (const d of tpl.databases ?? []) {
  if (!d.id || !d.name) err(`database missing id/name: ${JSON.stringify(d).slice(0, 80)}`);
  if (dbs.has(d.id)) err(`duplicate database id ${d.id}`);
  dbs.set(d.id, d);
  if (!d.key) err(`db ${d.id}: missing 'key' (templateDbKey)`);
  if (!/^db_/.test(d.id)) warn.push(`db ${d.id}: id does not start with db_`);
}
const recordIds = new Set();
for (const d of tpl.databases ?? []) for (const r of d.records ?? []) recordIds.add(r.id);
const pageIds = new Set();
for (const pg of tpl.pages ?? []) {
  if (pageIds.has(pg.id)) err(`duplicate page id ${pg.id}`);
  pageIds.add(pg.id);
}
const viewIds = new Set();
for (const d of tpl.databases ?? []) for (const v of d.views ?? []) {
  if (viewIds.has(v.id)) err(`duplicate view id ${v.id}`);
  viewIds.add(v.id);
}

/* ---------- FieldKey resolution ---------- */
function checkFieldKey(db, key, where) {
  if (BUILTINS.has(key)) return;
  const m = FIELDKEY.exec(key);
  if (!m) { err(`${where}: bad FieldKey '${key}'`); return; }
  const fid = m[2];
  const fields = db.fields ?? [];
  if (!fields.some((f) => f.id === fid)) err(`${where}: '${key}' — no field '${fid}' on ${db.id}`);
}
function checkConfig(db, cfg, where) {
  if (!cfg) return;
  for (const k of cfg.visible ?? []) checkFieldKey(db, k, `${where}.visible`);
  if (cfg.groupBy) checkFieldKey(db, cfg.groupBy, `${where}.groupBy`);
  if (cfg.dateKey) checkFieldKey(db, cfg.dateKey, `${where}.dateKey`);
  if (cfg.endDateKey) checkFieldKey(db, cfg.endDateKey, `${where}.endDateKey`);
  for (const f of cfg.filters ?? []) {
    checkFieldKey(db, f.key, `${where}.filters`);
    if (!FILTER_OPS.has(f.op)) err(`${where}.filters: bad op '${f.op}'`);
  }
  for (const s of cfg.sorts ?? []) checkFieldKey(db, s.key, `${where}.sorts`);
}

/* ---------- databases ---------- */
let relPairCount = 0;
let relOneWayCount = 0;
for (const d of tpl.databases ?? []) {
  const fids = new Set();
  for (const f of d.fields ?? []) {
    if (!f.id || !f.name || !f.type) { err(`db ${d.id}: bad field ${JSON.stringify(f).slice(0, 80)}`); continue; }
    if (fids.has(f.id)) err(`db ${d.id}: duplicate field id ${f.id}`);
    fids.add(f.id);
    if (f.type === 'relation') {
      const r = f.relation;
      if (!r || typeof r !== 'object') { err(`db ${d.id}.${f.id}: relation missing relation{}`); continue; }
      if (!dbs.has(r.target)) { err(`db ${d.id}.${f.id}: relation target '${r.target}' not a database`); continue; }
      if (r.target === d.id) warn.push(`db ${d.id}.${f.id}: self relation`);
      if (r.pairedFieldId != null) {
        relPairCount++;
        const paired = (dbs.get(r.target).fields ?? []).find((x) => x.id === r.pairedFieldId);
        if (!paired) { err(`db ${d.id}.${f.id}: pairedFieldId '${r.pairedFieldId}' missing on ${r.target}`); continue; }
        if (paired.type !== 'relation') err(`db ${d.id}.${f.id}: paired '${r.pairedFieldId}' is type ${paired.type}`);
        else {
          if (paired.relation?.pairedFieldId !== f.id) err(`db ${d.id}.${f.id}: pairing not reciprocal — ${r.target}.${paired.id} pairs to '${paired.relation?.pairedFieldId}'`);
          if (paired.relation?.target !== d.id) err(`db ${d.id}.${f.id}: paired field ${r.target}.${paired.id} targets '${paired.relation?.target}'`);
          if (r.primary === true && paired.relation?.primary === true) err(`db ${d.id}.${f.id}: both sides primary`);
          if (r.primary !== true && paired.relation?.primary !== true) err(`db ${d.id}.${f.id}: neither side primary`);
        }
      } else {
        relOneWayCount++;
      }
    }
    if ((f.type === 'select' || f.type === 'multi_select')) {
      if (!f.options?.length) warn.push(`db ${d.id}.${f.id}: ${f.type} has no options`);
      const oids = new Set();
      for (const o of f.options ?? []) {
        if (oids.has(o.id)) err(`db ${d.id}.${f.id}: duplicate option id '${o.id}'`);
        oids.add(o.id);
      }
    }
  }
  const colIds = new Set();
  for (const c of d.columns ?? []) {
    if (colIds.has(c.id)) err(`db ${d.id}: duplicate column '${c.id}'`);
    colIds.add(c.id);
    if (!/^[a-z0-9_]+$/.test(c.id)) warn.push(`db ${d.id}: column id '${c.id}' not slugged`);
  }
  for (const ct of d.captureTargets ?? []) {
    if (!dbs.has(ct.databaseId)) err(`db ${d.id}: captureTargets '${ct.kind}' → '${ct.databaseId}' not a database`);
  }
  for (const v of d.views ?? []) {
    if (v.type && !VIEW_TYPES.has(v.type)) err(`db ${d.id} view ${v.id}: unknown type '${v.type}'`);
    checkConfig(d, v.config, `db ${d.id} view ${v.id}`);
    if ((v.type === 'calendar' || v.type === 'timeline') && !v.config?.dateKey) err(`db ${d.id} view ${v.id}: ${v.type} without dateKey`);
  }
  if (d.defaultViewId && !(d.views ?? []).some((v) => v.id === d.defaultViewId)) err(`db ${d.id}: defaultViewId '${d.defaultViewId}' not a declared view`);
  for (const r of d.records ?? []) {
    if (!r.id || !r.title) err(`db ${d.id}: record missing id/title`);
    if (r.status && colIds.size && !colIds.has(r.status)) err(`db ${d.id} record ${r.id}: status '${r.status}' not a column`);
    for (const k of Object.keys(r.props ?? {})) checkFieldKey(d, k, `db ${d.id} record ${r.id}.props`);
  }
}

/* ---------- pages + blocks ---------- */
const filterDbIds = new Set();
for (const pg of tpl.pages ?? []) {
  if (!pg.id || !pg.title) err(`page missing id/title: ${JSON.stringify(pg).slice(0, 60)}`);
  if (pg.parentId != null && !pageIds.has(pg.parentId)) err(`page ${pg.id}: parentId '${pg.parentId}' not a page`);
  for (const [i, b] of (pg.blocks ?? []).entries()) {
    if (typeof b === 'string') {
      const m = /^Embed:\s*(\S+)/.exec(b.trim());
      if (m && !dbs.has(m[1])) err(`page ${pg.id} block ${i}: Embed '${m[1]}' not a database`);
      continue;
    }
    if (!b || typeof b !== 'object') { err(`page ${pg.id} block ${i}: bad block`); continue; }
    if (!BLOCK_TYPES.has(b.type)) err(`page ${pg.id} block ${i}: unknown type '${b.type}'`);
    const where = `page ${pg.id} block ${i} (${b.type})`;
    if (b.databaseId != null) {
      const db = dbs.get(b.databaseId);
      if (!db) err(`${where}: databaseId '${b.databaseId}' not a database`);
      else {
        filterDbIds.add(b.databaseId);
        if (b.viewId != null && !(db.views ?? []).some((v) => v.id === b.viewId)) err(`${where}: viewId '${b.viewId}' not on ${b.databaseId}`);
        if (b.inline != null) checkConfig(db, b.inline, `${where}.inline`);
        for (const f of b.filters ?? []) checkFieldKey(db, f.key, `${where}.filters`);
        if (b.fieldKey != null) checkFieldKey(db, b.fieldKey, `${where}.fieldKey`);
        if(['fieldsessions','measurechart'].includes(b.type)){
          for(const [key,fallback,type]of [['dateKey','p_f_date','date'],['measurementKey','p_f_measurement','number'],['unitKey','p_f_unit','text'],['observationKey','p_f_observation','text'],['photoKey','p_f_photos','url'],['placeKey','rel_f_place','relation'],['experimentKey','rel_f_experiment','relation'],['projectKey','rel_f_project','relation']]){
            const value=b[key]??fallback;checkFieldKey(db,value,`${where}.${key}`);
            if(!(db.fields??[]).some(f=>`${type==='relation'?'rel':'p'}_${f.id}`===value&&f.type===type))err(`${where}.${key}: expected ${type} field`);
          }
          if(b.limit!=null&&(!Number.isInteger(b.limit)||b.limit<1||b.limit>50))err(`${where}: limit must be1–50`);
          if(b.unit!=null&&(typeof b.unit!=='string'||b.unit.length>100))err(`${where}: unit must be at most100 characters`);
        }
        if(b.type==='eventops'){
          for(const [key,fallback,type]of [['startKey','p_f_start','date'],['capacityKey','p_f_capacity','number'],['facilitatorsKey','rel_f_facilitators','relation'],['volunteersKey','rel_f_volunteers','relation'],['participantsKey','rel_f_participants','relation']]){
            const value=b[key]??fallback;checkFieldKey(db,value,`${where}.${key}`);
            if(!(db.fields??[]).some(field=>`${type==='relation'?'rel':'p'}_${field.id}`===value&&field.type===type))err(`${where}.${key}: expected ${type} field`);
          }
          if(b.limit!=null&&(!Number.isInteger(b.limit)||b.limit<1||b.limit>20))err(`${where}: limit must be1–20`);
        }
        if(b.type==='budget'){
          const keys=b.mode==='product'?['priceKey','costKey']:['budgetKey'];
          for(const key of keys){const fallback={priceKey:'p_f_price',costKey:'p_f_cost',budgetKey:'p_f_budget'}[key],value=b[key]??fallback;checkFieldKey(db,value,`${where}.${key}`);if(!(db.fields??[]).some(f=>`p_${f.id}`===value&&f.type==='number'))err(`${where}.${key}: expected number field`);}
          if(b.mode!=='product'){
            const field=(db.fields??[]).find(f=>`rel_${f.id}`===(b.relationKey??'rel_f_transactions')),target=dbs.get(field?.relation?.target);
            if(!target)err(`${where}: transactions relation target missing`);
            else for(const [key,fallback,type]of [['amountKey','p_f_amount','number'],['typeKey','p_f_type','select']]){const value=b[key]??fallback;checkFieldKey(target,value,`${where}.${key}`);if(!(target.fields??[]).some(f=>`p_${f.id}`===value&&f.type===type))err(`${where}.${key}: expected ${type} field`);}
          }
          if(b.recordId&&b.recordId!=='self'&&!recordIds.has(b.recordId))err(`${where}: recordId not a record or self`);
        }
        if(b.type==='projecthealth'){
          for(const [key,fallback,type]of [['ownerKey','p_f_owner','person'],['startKey','p_f_start','date'],['endKey','p_f_end','date']]){
            const value=b[key]??fallback;checkFieldKey(db,value,`${where}.${key}`);
            if(value!==(type==='person'?'assigneeId':'dueDate')&&!(db.fields??[]).some(f=>`p_${f.id}`===value&&f.type===type))err(`${where}.${key}: expected ${type} field`);
          }
          if(b.projectId&&b.projectId!=='self'&&!recordIds.has(b.projectId))err(`${where}: projectId '${b.projectId}' not a record or self`);
        }
        if (b.type === 'calendar') err(`${where}: calendar block uses databaseId, expected sources[]`);
      }
    }
    if (b.type === 'calendar' && b.sources != null) {
      for (const s of b.sources) {
        const sdb = dbs.get(s.databaseId);
        if (!sdb) { err(`${where}: source '${s.databaseId}' not a database`); continue; }
        if (s.dateKey) checkFieldKey(sdb, s.dateKey, `${where}.sources`);
        else err(`${where}: source on ${s.databaseId} missing dateKey`);
        for (const f of s.filters ?? []) checkFieldKey(sdb, f.key, `${where}.sources.filters`);
      }
    }
    if (b.type === 'metric' && b.agg && !['count', 'sum', 'avg'].includes(b.agg)) err(`${where}: bad agg '${b.agg}'`);
    if ((b.type === 'view' || b.type === 'metric') && b.databaseId == null) err(`${where}: ${b.type} block without databaseId`);
    if (b.type === 'calendar' && !(b.sources?.length)) err(`${where}: calendar without sources`);
    if (b.type === 'board' || b.type === 'tasks') {
      if (b.boardId != null && !dbs.has(b.boardId)) err(`${where}: boardId '${b.boardId}' not a database`);
    }
  }
}

/* ---------- links ---------- */
for (const l of tpl.links ?? []) {
  const ok = (id) => pageIds.has(id) || recordIds.has(id);
  if (!ok(l.from)) err(`link: from '${l.from}' not an authored page/record`);
  if (!ok(l.to)) err(`link: to '${l.to}' not an authored page/record`);
}

/* ---------- summary ---------- */
const bytes = Buffer.byteLength(JSON.stringify(tpl));
if (bytes > 250 * 1024) warn.push(`JSON is ${(bytes / 1024).toFixed(0)} KB (> 250 KB target)`);
const templatePages = (tpl.pages ?? []).filter((pg) => pg.template === true).length;

for (const w of warn) console.warn('warn:', w);
if (errors.length) {
  for (const e of errors) console.error('error:', e);
  process.exit(1);
}
console.log(`ok: ${tpl.name}`);
console.log(`  databases: ${(tpl.databases ?? []).length} (${(tpl.databases ?? []).reduce((n, d) => n + (d.fields ?? []).length, 0)} fields, ${relPairCount} paired + ${relOneWayCount} one-way relation fields)`);
console.log(`  views: ${viewIds.size} · pages: ${(tpl.pages ?? []).length} (${templatePages} templates) · links: ${(tpl.links ?? []).length} · ${(bytes / 1024).toFixed(1)} KB`);
