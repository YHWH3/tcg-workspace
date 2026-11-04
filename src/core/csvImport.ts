import { coerceFieldValue, type FieldDef, type FieldType } from '../../shared/fields';
import { normalizeHeader, parseCsv, type ParsedCsv } from '../../shared/csv';
import { linkId } from '../../shared/linkid';
import { db } from './db';
import { mutateMany } from './sync/engine';
import type { BoardRow, TaskRow } from '../modules/boards/api';

export type CsvMappingTarget = 'skip' | 'title' | `p_${string}` | `new:${FieldType}`;
export interface CsvColumnMapping { header: string; target: CsvMappingTarget; }
export interface CsvImportError { row: number; reason: string; }
export interface CsvImportWrite { id: string; patch: Record<string, unknown>; before?: Record<string, unknown>; created: boolean; linkIds?: string[]; }
export interface CsvImportLinkWrite { id: string; patch: Record<string, unknown>; }
export interface CsvImportPlan { creates: number; updates: number; skips: number; errors: CsvImportError[]; writes: CsvImportWrite[]; links: CsvImportLinkWrite[]; fields: FieldDef[]; }
export interface CsvImportOptions {
  board: BoardRow;
  parsed: ParsedCsv;
  mappings: CsvColumnMapping[];
  records: readonly TaskRow[];
  dateFormat: 'yyyy-mm-dd' | 'dd/mm/yyyy' | 'mm/dd/yyyy';
  updateKey?: string;
  unknownSelect: 'add' | 'error';
  users?: readonly { id: string; name?: string; username?: string }[];
  relationTargets?: Readonly<Record<string, readonly { id: string; title: string }[]>>;
  idForRow?: (row: number) => string;
}

/** Build a bounded, previewable import plan. No local writes occur here. */
export function planCsvImport(options: CsvImportOptions): CsvImportPlan {
  const { board, parsed, mappings, records, dateFormat, updateKey, unknownSelect, users = [], relationTargets = {} } = options;
  const fields = (Array.isArray(board.fields) ? board.fields : []).map((field) => ({
    ...(field as FieldDef),
    ...(Array.isArray((field as FieldDef).options) ? { options: (field as FieldDef).options!.map((option) => ({ ...option })) } : {}),
    ...(isRelation(field as FieldDef) ? { relation: { ...(field as FieldDef).relation! } } : {}),
  })) as FieldDef[];
  const existing = new Map(records.filter(record => !record.deleted).map(record => [recordKey(record, updateKey), record]));
  const seenKeys = new Set<string>();
  const writes: CsvImportWrite[] = [];
  const links: CsvImportLinkWrite[] = [];
  const errors: CsvImportError[] = [];
  let skips = 0;
  parsed.rows.forEach((values, rowIndex) => {
    const row = rowIndex + 2;
    const patch: Record<string, unknown> = {};
    const relationValues: { field: FieldDef; ids: string[] }[] = [];
    let invalid = false;
    for (const mapping of mappings) {
      if (mapping.target === 'skip') continue;
      const index = parsed.headers.findIndex(header => normalizeHeader(header) === normalizeHeader(mapping.header));
      const raw = values[index] ?? '';
      if (mapping.target === 'title') {
        patch.title = raw;
        continue;
      }
      const fieldId = mapping.target.startsWith('new:') ? fieldIdFor(mapping.header) : mapping.target.slice(2);
      const field = fields.find(item => item.id === fieldId) ?? createImportedField(fieldId, mapping.header, mapping.target);
      if (!fields.some(item => item.id === field.id)) fields.push(field);
      const value = convertValue(field, raw, dateFormat, unknownSelect, users, relationTargets[field.id]);
      if (value.error) { errors.push({ row, reason: `${mapping.header}: ${value.error}` }); invalid = true; continue; }
      if (value.relationIds?.length) relationValues.push({ field, ids: value.relationIds });
      if (value.value !== undefined) patch[`p_${field.id}`] = value.value;
    }
    if (invalid || (!Object.keys(patch).length && !relationValues.length)) { skips += 1; return; }
    const key = updateKey ? String(patch[updateKey] ?? patch.title ?? '').trim().toLowerCase() : '';
    if (updateKey && !key) { errors.push({ row, reason: 'The selected update key is empty.' }); skips += 1; return; }
    if (updateKey && seenKeys.has(key)) { errors.push({ row, reason: `Duplicate update key: ${key}` }); skips += 1; return; }
    if (updateKey) seenKeys.add(key);
    const prior = updateKey ? existing.get(key) : undefined;
    const id = prior?.id ?? options.idForRow?.(row) ?? `import-${crypto.randomUUID()}`;
    const linkIds: string[] = [];
    for (const relation of relationValues) {
      const reverse = relation.field.relation?.primary !== true && !!relation.field.relation?.pairedFieldId;
      const fieldId = reverse ? relation.field.relation!.pairedFieldId! : relation.field.id;
      for (const targetId of relation.ids) {
        const fromId = reverse ? targetId : id;
        const toId = reverse ? id : targetId;
        const link = linkId('relation', fieldId, fromId, toId);
        linkIds.push(link);
        links.push({ id: link, patch: { fromType: 'record', fromId, toType: 'record', toId, kind: 'relation', fieldId, deleted: false } });
      }
    }
    writes.push({ id, patch, before: prior ? snapshotPatch(prior, patch) : undefined, created: !prior, linkIds: linkIds.length ? linkIds : undefined });
  });
  return { creates: writes.filter(write => write.created).length, updates: writes.filter(write => !write.created).length, skips, errors, writes, links, fields };
}

export function autoMappings(parsed: ParsedCsv, board: BoardRow): CsvColumnMapping[] {
  const fields = (board.fields ?? []) as FieldDef[];
  return parsed.headers.map(header => {
    const normalized = normalizeHeader(header);
    if (normalized === 'title' || normalized === 'name') return { header, target: 'title' };
    const field = fields.find(item => normalizeHeader(item.name) === normalized);
    return { header, target: field ? `p_${field.id}` : 'skip' };
  });
}

function convertValue(field: FieldDef, raw: string, dateFormat: CsvImportOptions['dateFormat'], unknownSelect: CsvImportOptions['unknownSelect'], users: readonly { id: string; name?: string; username?: string }[], relationTargets?: readonly { id: string; title: string }[]): { value?: unknown; error?: string; relationIds?: string[] } {
  if (raw.trim() === '') return { value: undefined };
  if (field.type === 'date') {
    const date = normalizeDate(raw.trim(), dateFormat);
    return date ? { value: date } : { error: `Invalid ${dateFormat} date.` };
  }
  if (field.type === 'select' || field.type === 'multi_select') {
    const values = field.type === 'multi_select' ? raw.split(';').map(value => value.trim()).filter(Boolean) : [raw.trim()];
    const missing = values.filter(value => !(field.options ?? []).some(option => normalizeHeader(option.name) === normalizeHeader(value) || option.id === value));
    if (missing.length && unknownSelect === 'error') return { error: `Unknown option: ${missing.join(', ')}` };
    if (missing.length) field.options = [...(field.options ?? []), ...missing.map((name, index) => ({ id: `import_${normalizeHeader(name)}_${index}`, name, color: '#8a8a8a' }))];
  }
  if (field.type === 'person') {
    const match = users.find(user => normalizeHeader(user.name ?? '') === normalizeHeader(raw) || normalizeHeader(user.username ?? '') === normalizeHeader(raw));
    return match ? { value: match.id } : { error: `Person not found: ${raw}` };
  }
  if (field.type === 'relation') {
    const values = raw.split(';').map(value => value.trim()).filter(Boolean);
    const targets = relationTargets ?? [];
    const ids: string[] = [];
    for (const value of values) {
      const matches = targets.filter(target => normalizeHeader(target.title) === normalizeHeader(value));
      if (matches.length !== 1) return { error: matches.length ? `Relation has multiple matches for ${value}: ${matches.map(match => match.title).join(', ')}` : `Relation target not found: ${value}` };
      ids.push(matches[0].id);
    }
    if (field.relation?.single && ids.length > 1) return { error: 'This relation accepts one target.' };
    return { relationIds: ids };
  }
  const value = coerceFieldValue(field, field.type === 'multi_select' ? raw.split(';').map(value => value.trim()) : raw);
  return value === undefined ? { error: `Invalid ${field.type} value.` } : { value };
}

function normalizeDate(value: string, format: CsvImportOptions['dateFormat']): string | null {
  if (format === 'yyyy-mm-dd') return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value);
  if (!match) return null;
  const [, first, second, year] = match;
  const month = format === 'dd/mm/yyyy' ? second : first;
  const day = format === 'dd/mm/yyyy' ? first : second;
  const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.getUTCFullYear() === Number(year) && parsed.getUTCMonth() + 1 === Number(month) && parsed.getUTCDate() === Number(day) ? date : null;
}

function fieldIdFor(header: string): string { return `import_${normalizeHeader(header).slice(0, 40) || 'field'}`; }
function createImportedField(id: string, header: string, target: CsvMappingTarget): FieldDef { return { id, name: header.trim() || 'Imported field', type: target.slice(5) as FieldType }; }
function isRelation(field: FieldDef): boolean { return field.type === 'relation' && !!field.relation; }
function recordKey(record: TaskRow, key: string | undefined): string { return String(key === 'title' ? record.title ?? '' : key?.startsWith('p_') ? record[key] ?? '' : record.title ?? '').trim().toLowerCase(); }
function snapshotPatch(record: TaskRow, patch: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.keys(patch).map(key => [key, record[key]])); }

export { parseCsv };

export interface CsvImportJournal {
  id: string;
  databaseId: string;
  createdAt: number;
  expiresAt: number;
  created: { id: string; after: Record<string, unknown> }[];
  updates: { id: string; before: Record<string, unknown>; after: Record<string, unknown> }[];
  linkIds: string[];
}

export async function saveCsvImportJournal(journal: CsvImportJournal): Promise<void> {
  await db.meta.put({ key: `import:${journal.id}`, value: journal });
}

export async function listCsvImportJournals(now = Date.now()): Promise<CsvImportJournal[]> {
  const rows = await db.meta.toArray();
  const journals: CsvImportJournal[] = [];
  for (const row of rows) {
    if (!row.key.startsWith('import:')) continue;
    const journal = row.value as CsvImportJournal;
    if (!journal || journal.expiresAt <= now) { await db.meta.delete(row.key); continue; }
    journals.push(journal);
  }
  return journals.sort((a, b) => b.createdAt - a.createdAt);
}

export async function undoCsvImportJournal(journal: CsvImportJournal): Promise<{ restored: number; skipped: number }> {
  const rows = (await db.tasks.bulkGet([...journal.created.map(item => item.id), ...journal.updates.map(item => item.id)])) as Record<string, unknown>[];
  const byId = new Map(rows.filter(Boolean).map(row => [String(row.id), row]));
  const createdPatch = journal.created.filter(item => {
    const row = byId.get(item.id);
    return row && Object.keys(item.after).every(key => JSON.stringify(row[key] ?? null) === JSON.stringify(item.after[key] ?? null));
  }).map(item => ({ id: item.id, patch: { deleted: true } }));
  const restores = journal.updates.filter(item => {
    const row = byId.get(item.id);
    return row && Object.keys(item.after).every(key => JSON.stringify(row[key] ?? null) === JSON.stringify(item.after[key] ?? null));
  }).map(item => ({ id: item.id, patch: item.before }));
  for (let i = 0; i < createdPatch.length; i += 200) await mutateMany('tasks', createdPatch.slice(i, i + 200));
  for (let i = 0; i < restores.length; i += 200) await mutateMany('tasks', restores.slice(i, i + 200));
  const linkPatches = journal.linkIds.map(id => ({ id, patch: { deleted: true } }));
  for (let i = 0; i < linkPatches.length; i += 200) await mutateMany('links', linkPatches.slice(i, i + 200));
  await db.meta.delete(`import:${journal.id}`);
  return { restored: createdPatch.length + restores.length, skipped: journal.created.length + journal.updates.length - createdPatch.length - restores.length };
}
