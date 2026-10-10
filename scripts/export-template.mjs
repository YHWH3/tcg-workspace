#!/usr/bin/env node
/**
 * export-template.mjs — validate a bundled template JSON (default:
 * templates/starter-people.json) or export a board to template form.
 *
 *   node scripts/export-template.mjs [--check] [path/to/template.json]
 *
 * Validation: databases have unique ids; relation fields pair correctly
 * (each non-primary relation's pairedFieldId points at a primary relation on
 * the target db); view FieldKeys (p_<fid>/rel_<fid>/built-ins) resolve to a
 * field or built-in; pages reference only declared database ids.
 */
import { readFileSync } from 'node:fs';

const BUILTINS = new Set(['title', 'status', 'assigneeId', 'dueDate', 'priority', 'createdAt', 'createdBy']);
const FIELDTYPES = new Set(['text', 'number', 'checkbox', 'select', 'multi_select', 'person', 'url', 'date', 'relation', 'rating']);
const file = process.argv.filter((a) => !a.startsWith('--'))[2] ?? new URL('../templates/starter-people.json', import.meta.url).pathname;
const tpl = JSON.parse(readFileSync(file, 'utf8'));
const errors = [];
const warn = [];

const dbs = new Map();
for (const d of tpl.databases ?? []) {
  if (!d.id || !d.name) errors.push(`database missing id/name: ${JSON.stringify(d)}`);
  if (dbs.has(d.id)) errors.push(`duplicate database id ${d.id}`);
  dbs.set(d.id, d);
}
for (const d of tpl.databases ?? []) {
  const fieldIds = new Set();
  for (const f of d.fields ?? []) {
    if (!f.id || !f.name || !FIELDTYPES.has(f.type)) errors.push(`db ${d.id}: bad field ${JSON.stringify(f)}`);
    fieldIds.add(f.id);
    if (f.type === 'relation') {
      const r = f.relation;
      if (!r || !dbs.has(r.target)) { errors.push(`db ${d.id}.${f.id}: relation target missing (${r?.target})`); continue; }
      if (r.pairedFieldId) {
        const paired = (dbs.get(r.target).fields ?? []).find((x) => x.id === r.pairedFieldId);
        if (!paired || paired.type !== 'relation') errors.push(`db ${d.id}.${f.id}: pairedFieldId ${r.pairedFieldId} not a relation on ${r.target}`);
        else if (paired.relation?.pairedFieldId !== f.id) errors.push(`db ${d.id}.${f.id}: pairing not reciprocal (${r.target}.${paired.id})`);
        else if (r.primary !== true && paired.relation?.primary !== true) errors.push(`db ${d.id}.${f.id}: neither side is primary`);
        else if (r.primary === true && paired.relation?.primary === true) errors.push(`db ${d.id}.${f.id}: both sides primary`);
      }
    }
    if ((f.type === 'select' || f.type === 'multi_select') && !f.options?.length) warn.push(`db ${d.id}.${f.id}: ${f.type} has no options`);
  }
  for (const v of d.views ?? []) {
    for (const key of v.config?.visible ?? []) {
      if (BUILTINS.has(key)) continue;
      const fid = key.startsWith('rel_') || key.startsWith('p_') ? key.slice(key.indexOf('_') + 1) : null;
      if (!fid || !fieldIds.has(fid)) errors.push(`db ${d.id} view ${v.id}: visible key ${key} does not resolve`);
    }
  }
}
for (const pg of tpl.pages ?? []) {
  for (const md of pg.blocks ?? []) {
    const m = /^Embed:\s*(\S+)/.exec(md);
    if (m && !dbs.has(m[1])) errors.push(`page ${pg.id}: Embed ${m[1]} is not a declared database`);
  }
}
for (const w of warn) console.warn('warn:', w);
if (errors.length) {
  for (const e of errors) console.error('error:', e);
  process.exit(1);
}
console.log(`ok: ${tpl.name} — ${(tpl.databases ?? []).length} databases, ${(tpl.pages ?? []).length} pages`);
