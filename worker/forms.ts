// Phase 4 — public forms platform (Workstream C). Contract mounts are FIXED
// in worker/index.ts; this file implements the bodies.
//
// `forms` config rows are a synced collection (member-editable via the
// builder); form_tokens, form_submissions and rate_limits are
// server-controlled D1 tables that never sync.
//
// Member API  /api/forms        (session auth): create/update config, mint +
//               revoke publish tokens, fetch config incl. token list.
// Public API  /api/public/forms (unauthed): schema fetch, submission, image
//               upload — all token-gated, rate-limited, Turnstile-checked.
//               Schema responses never leak notifyUserIds/createRelations/
//               peopleMatch/branding internals beyond `intro`.
//
// Everything testable is a plain exported function (see tests/forms.test.ts).

import { Hono } from 'hono';
import { applyChanges, pokeLive } from './sync';
import { beginChangeset } from './changesets';
import { getRec, listBy } from './records';
import { requireAuth, type Env, type AuthUser } from './auth';
import { coerceFieldValue, fieldsOf, propKey, type FieldDef } from '../shared/fields';
import { cmpOrder, orderBetween, uuid } from '../shared/order';
import { fnv1a64hex, linkId } from '../shared/linkid';
import type { SemanticEvent } from '../shared/events';
import { sha256Hex, randomToken } from './password';
import { completedRecords, executionOptions, EXECUTION_LEASE_MS, EXECUTION_MAX_ATTEMPTS, retryDelay } from './execution';
import type { ChangesetCtx } from './changesets';
import {hasD1Budget,D1BudgetExhausted,d1CleanupDatabase} from './d1budget';
import { D1_MAX_ROW_BYTES, QUOTA_BYTES, fileChunkSlices } from './files';

type Bindings = Env;

/* ------------------------------------------------------------------ */
/* Config model + pure helpers                                         */
/* ------------------------------------------------------------------ */

/** Builtin keys a public form may expose. `assignee`, `parentId` and rel_*
 *  keys are never exposable (member ids / structural). */
export const PUBLIC_BUILTINS = ['title', 'dueDate', 'status', 'priority'] as const;
export type PublicBuiltin = (typeof PUBLIC_BUILTINS)[number];

export const FORM_MAX_PAYLOAD = 256 * 1024;
export const FORM_MAX_IMAGE = 5 * 1024 * 1024;
export const FORM_RATE_LIMIT = 10;
export const FORM_RATE_WINDOW_MS = 60 * 60 * 1000;
export const FORM_MAX_FILES = 10;
export const FORM_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
export const SUBMISSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const TEXT_CAP = 2000;

export interface FormFieldSpec {
  fieldKey: string; // PublicBuiltin | `p_<fieldId>`
  label: string;
  required?: boolean;
  help?: string;
  order?: number;
}

export interface FormRelSpec {
  fieldId: string;
  toId: string;
}

export interface FormConfig {
  databaseId: string;
  title: string;
  description?: string;
  fields: FormFieldSpec[];
  successMessage: string;
  enabled: boolean;
  notifyUserIds: string[];
  createRelations?: FormRelSpec[];
  peopleMatch?: { emailField: string };
  branding?: { intro?: string };
}

/** What the public schema ships for one field. */
export interface PubField {
  key: string;
  type: 'text' | 'url' | 'email' | 'number' | 'date' | 'checkbox' | 'select' | 'multiselect';
  label: string;
  required: boolean;
  help?: string;
  options?: { id: string; name: string }[];
}

const PRIORITY_OPTIONS = [
  { id: 'none', name: 'None' },
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'urgent', name: 'Urgent' },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/** peopleMatch.emailField tolerates a bare field id or a p_-prefixed key. */
export function peopleEmailKey(emailField: string): string {
  return emailField.startsWith('p_') ? emailField : propKey(emailField);
}

/** Tolerant parse of a synced `forms` record's data → FormConfig. */
export function parseFormConfig(data: Record<string, unknown>): FormConfig | null {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.databaseId !== 'string' || !data.databaseId) return null;
  if (typeof data.title !== 'string' || !data.title.trim()) return null;
  const rawFields = Array.isArray(data.fields) ? data.fields : [];
  const fields: FormFieldSpec[] = [];
  for (const f of rawFields) {
    if (!f || typeof f !== 'object') return null;
    const r = f as Record<string, unknown>;
    if (typeof r.fieldKey !== 'string' || !r.fieldKey) return null;
    if (typeof r.label !== 'string' || !r.label.trim()) return null;
    fields.push({
      fieldKey: r.fieldKey,
      label: String(r.label).slice(0, 140),
      required: r.required === true,
      help: typeof r.help === 'string' ? r.help.slice(0, 500) : undefined,
      order: typeof r.order === 'number' ? r.order : undefined,
    });
  }
  if (!fields.length) return null;
  fields.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const rels: FormRelSpec[] = [];
  if (Array.isArray(data.createRelations)) {
    for (const r of data.createRelations) {
      if (!r || typeof r !== 'object') return null;
      const rr = r as Record<string, unknown>;
      if (typeof rr.fieldId !== 'string' || typeof rr.toId !== 'string') return null;
      rels.push({ fieldId: rr.fieldId, toId: rr.toId });
    }
  }
  let peopleMatch: FormConfig['peopleMatch'];
  if (data.peopleMatch && typeof data.peopleMatch === 'object') {
    const pm = data.peopleMatch as Record<string, unknown>;
    if (typeof pm.emailField !== 'string' || !pm.emailField) return null;
    peopleMatch = { emailField: pm.emailField };
  }
  return {
    databaseId: data.databaseId,
    title: data.title.slice(0, 200),
    description: typeof data.description === 'string' ? data.description.slice(0, 2000) : undefined,
    fields,
    successMessage: typeof data.successMessage === 'string' && data.successMessage.trim() ? data.successMessage.slice(0, 500) : 'Thanks — your response has been recorded.',
    enabled: data.enabled === true,
    notifyUserIds: Array.isArray(data.notifyUserIds) ? data.notifyUserIds.filter((u): u is string => typeof u === 'string') : [],
    ...(rels.length ? { createRelations: rels } : {}),
    ...(peopleMatch ? { peopleMatch } : {}),
    ...(data.branding && typeof data.branding === 'object'
      ? { branding: { intro: typeof (data.branding as Record<string, unknown>).intro === 'string' ? String((data.branding as Record<string, unknown>).intro).slice(0, 2000) : undefined } }
      : {}),
  };
}

/** FieldDef + public projection for a form fieldKey, or null when the key is
 *  not exposable. `def` is set for p_-keys and for status (synthesised). */
export function publicFieldFor(
  spec: FormFieldSpec,
  boardData: Record<string, unknown>,
): { pub: PubField; def?: FieldDef } | null {
  const base = { key: spec.fieldKey, label: spec.label, required: spec.required === true, ...(spec.help ? { help: spec.help } : {}) };
  const columns = Array.isArray(boardData.columns) ? (boardData.columns as { id: string; name: string }[]) : [];
  if (spec.fieldKey === 'title') return { pub: { ...base, type: 'text' } };
  if (spec.fieldKey === 'dueDate') {
    const def: FieldDef = { id: '', name: 'Due date', type: 'date' };
    return { pub: { ...base, type: 'date' }, def };
  }
  if (spec.fieldKey === 'status') {
    const def: FieldDef = { id: '', name: 'Status', type: 'select', options: columns.map((c) => ({ id: c.id, name: c.name, color: '' })) };
    return { pub: { ...base, type: 'select', options: def.options }, def };
  }
  if (spec.fieldKey === 'priority') {
    const def: FieldDef = { id: '', name: 'Priority', type: 'select', options: PRIORITY_OPTIONS.map((o) => ({ ...o, color: '' })) };
    return { pub: { ...base, type: 'select', options: PRIORITY_OPTIONS.map((o) => ({ ...o })) }, def };
  }
  if (spec.fieldKey.startsWith('p_')) {
    const def = fieldsOf(boardData).find((f) => f.id === spec.fieldKey.slice(2));
    if (!def) return null;
    switch (def.type) {
      case 'text':
      case 'number':
      case 'date':
      case 'checkbox':
        return { pub: { ...base, type: def.type === 'text' ? 'text' : def.type }, def };
      case 'url': {
        const isEmail = /e-?mail/i.test(def.name);
        return { pub: { ...base, type: isEmail ? 'email' : 'url' }, def };
      }
      case 'select':
        return { pub: { ...base, type: 'select', options: (def.options ?? []).map((o) => ({ id: o.id, name: o.name })) }, def };
      case 'multi_select':
        return { pub: { ...base, type: 'multiselect', options: (def.options ?? []).map((o) => ({ id: o.id, name: o.name })) }, def };
      default:
        return null; // person + relation are never public fields
    }
  }
  return null;
}

/** Full public schema — the ONLY thing a token ever reveals. */
export function publicFormSchema(
  form: FormConfig,
  boardData: Record<string, unknown>,
  turnstileSiteKey: string,
): Record<string, unknown> {
  const fields = form.fields
    .map((f) => publicFieldFor(f, boardData))
    .filter((x): x is { pub: PubField } => !!x)
    .map((x) => {
      const p: Record<string, unknown> = { key: x.pub.key, type: x.pub.type, label: x.pub.label, required: x.pub.required };
      if (x.pub.help) p.help = x.pub.help;
      if (x.pub.options?.length) p.options = x.pub.options;
      return p;
    });
  return {
    title: form.title,
    ...(form.description ? { description: form.description } : {}),
    fields,
    successMessage: form.successMessage,
    turnstileSiteKey,
    ...(form.branding?.intro ? { intro: form.branding.intro } : {}),
  };
}

export interface ValidationResult {
  ok: boolean;
  errors: Record<string, string>;
  /** coerced values keyed by record patch key (title/dueDate/status/priority/p_<fid>) */
  coerced: Record<string, unknown>;
  /** submitted keys that aren't on the form — dropped, never an error */
  ignored: string[];
}

/** Validate + coerce one submission body against the form's public fields. */
export function validateSubmissionValues(
  form: FormConfig,
  boardData: Record<string, unknown>,
  values: unknown,
): ValidationResult {
  const errors: Record<string, string> = {};
  const coerced: Record<string, unknown> = {};
  const ignored: string[] = [];
  const input = values && typeof values === 'object' && !Array.isArray(values) ? (values as Record<string, unknown>) : {};
  const allowed = new Set(form.fields.map((f) => f.fieldKey));
  for (const k of Object.keys(input)) if (!allowed.has(k)) ignored.push(k);

  for (const spec of form.fields) {
    const resolved = publicFieldFor(spec, boardData);
    if (!resolved) continue; // field removed from board — member must re-save the form
    const { pub, def } = resolved;
    const raw = input[spec.fieldKey];
    const empty = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && !raw.length);
    if (empty) {
      if (pub.required) errors[spec.fieldKey] = 'required';
      continue;
    }
    let v: unknown;
    if (spec.fieldKey === 'title') {
      v = typeof raw === 'string' ? raw.trim().slice(0, 500) : undefined;
    } else if (pub.type === 'email') {
      const s = normalizeEmail(raw);
      v = EMAIL_RE.test(s) ? s : undefined;
    } else if (spec.fieldKey === 'status' || spec.fieldKey === 'priority') {
      v = def ? coerceFieldValue(def, raw) : undefined;
    } else if (def) {
      v = coerceFieldValue(def, raw);
      if (typeof v === 'string' && v.length > TEXT_CAP) v = v.slice(0, TEXT_CAP);
      if (Array.isArray(v) && !v.length) v = undefined;
    }
    if (v === undefined) {
      errors[spec.fieldKey] = 'invalid';
      continue;
    }
    coerced[spec.fieldKey] = v;
  }
  return { ok: !Object.keys(errors).length, errors, coerced, ignored };
}

export type PersonMatch =
  | { kind: 'none' }
  | { kind: 'email'; personId: string; personTitle: string }
  | { kind: 'name-similar'; personId: string; personTitle: string };

export function normalizePersonName(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

/**
 * peopleMatch resolution over the form's own database rows (the board IS the
 * People database for intake/update forms): exact normalized email wins; a
 * name-similar row is only flagged as a possible duplicate — the submission
 * record is always created either way.
 */
export function findPersonMatch(
  emailKey: string,
  email: unknown,
  name: unknown,
  existing: { id: string; title?: unknown; data: Record<string, unknown> }[],
): PersonMatch {
  const e = normalizeEmail(email);
  const n = normalizePersonName(name);
  if (e) {
    const hit = existing.find((r) => normalizeEmail(r.data[emailKey]) === e);
    if (hit) return { kind: 'email', personId: hit.id, personTitle: String(hit.title ?? hit.data.title ?? '') };
  }
  if (n) {
    const hit = existing.find((r) => normalizePersonName(r.title ?? r.data.title) === n);
    if (hit) return { kind: 'name-similar', personId: hit.id, personTitle: String(hit.title ?? hit.data.title ?? '') };
  }
  return { kind: 'none' };
}

export function duplicateMarker(personTitle: string, at: number): string {
  const day = new Date(at).toISOString().slice(0, 10);
  return `Possible duplicate of existing person "${personTitle}" — matched by form submission on ${day}. Flagged for review.`;
}

/** Deterministic record id for a submission — crash between write and the
 *  state UPDATE can never double-create the record. */
export function submissionRecordId(formId: string, submissionId: string): string {
  return `sub_${fnv1a64hex(`${formId}|${submissionId}`)}`;
}

/** tok_ + 22 base62 chars (128 random bits). */
export function mintToken(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let s = '';
  // 22 independent base62 symbols provide >128 bits, without modulo bias or
  // deterministic padding. Rejection sampling discards the eight high bytes.
  while(s.length<22) for(const b of crypto.getRandomValues(new Uint8Array(32))) {
    if(b<248)s+=alphabet[b%62];
    if(s.length===22)break;
  }
  return `tok_${s.padEnd(22, '0').slice(0, 22)}`;
}

const RELATION_NOTES_RE = /^(notes?|comment|comments|review notes?|flag)$/i;

/** Find the notes-ish text FieldDef where duplicate flags land. */
export function notesFieldOf(boardData: Record<string, unknown>): FieldDef | undefined {
  return fieldsOf(boardData).find((f) => f.type === 'text' && RELATION_NOTES_RE.test(f.name));
}

/* ------------------------------------------------------------------ */
/* D1 helpers                                                          */
/* ------------------------------------------------------------------ */

interface TokenRow {
  token: string;
  form_id: string;
  created_at: number;
  revoked_at: number | null;
}

async function formByToken(env: Bindings, token: string): Promise<{ form: FormConfig; formId: string; formRev: number; board: RecRowLite } | null> {
  const t = await env.DB.prepare('SELECT token, form_id, created_at, revoked_at FROM form_tokens WHERE token = ?').bind(token).first<TokenRow>();
  if (!t || t.revoked_at !== null) return null;
  const rec = await getRec(env, t.form_id);
  if (!rec || rec.collection !== 'forms' || rec.data.deleted) return null;
  const form = parseFormConfig(rec.data);
  if (!form) return null;
  const board = await getRec(env, form.databaseId);
  if (!board || board.collection !== 'boards' || board.data.deleted) return null;
  return { form, formId: rec.id, formRev: rec.rev, board: recLite(board) };
}

interface RecRowLite {
  id: string;
  data: Record<string, unknown>;
  rev?: number;
}
function recLite(r: { id: string; data: Record<string, unknown>; rev: number }): RecRowLite {
  return { id: r.id, data: r.data, rev: r.rev };
}

/** Sliding-window counter, atomic against concurrent submits. Returns the
 *  count this request consumed (caller compares to the limit). */
async function rateLimitHit(env: Bindings, bucket: string, key: string, windowMs: number): Promise<number> {
  const now = Date.now();
  const resetAt = now + windowMs;
  await env.DB.prepare('INSERT INTO rate_limits (bucket, key, count, reset_at) VALUES (?, ?, 0, 0) ON CONFLICT(bucket, key) DO NOTHING').bind(bucket, key).run();
  const row = await env.DB
    .prepare(
      `UPDATE rate_limits
         SET count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
             reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END
       WHERE bucket = ? AND key = ?
       RETURNING count`,
    )
    .bind(now, now, resetAt, bucket, key)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

export const TURNSTILE_TEST_SITEKEY = 'test';

export async function boundedRequestBody(request:Request,limit:number):Promise<Uint8Array|null> {
  if(Number(request.headers.get('content-length'))>limit) return null;
  const reader=request.body?.getReader();if(!reader) return new Uint8Array();
  const chunks:Uint8Array[]=[];let size=0;
  try {
    while(true) {const {value,done}=await reader.read();if(done) break;size+=value.length;if(size>limit) {await reader.cancel();return null;}chunks.push(value);}
  } finally {reader.releaseLock();}
  const out=new Uint8Array(size);let offset=0;for(const chunk of chunks) {out.set(chunk,offset);offset+=chunk.length;}return out;
}

export function localTurnstileTest(env: Bindings, requestUrl: string): boolean {
  const url=new URL(requestUrl);
  return env.WORKSPACE_ENV==='local-test' && env.TURNSTILE_LOCAL_TEST==='1' && url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
}

export async function verifyFormChallenge(env: Bindings, token: unknown, ip: string, requestUrl: string): Promise<'ok'|'challenge'|'configuration'|'unavailable'> {
  if(localTurnstileTest(env,requestUrl)) return token==='pass'?'ok':'challenge';
  const hosts=(env.TURNSTILE_HOSTNAMES??'').split(',').map(h=>h.trim()).filter(Boolean);
  if(!env.TURNSTILE_SECRET?.trim() || !env.TURNSTILE_SITE_KEY?.trim() || !hosts.length || hosts.some(h=>['localhost','127.0.0.1','[::1]'].includes(h))) return 'configuration';
  if (typeof token !== 'string' || !token || token.length>2048 || token==='pass') return 'challenge';
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret:env.TURNSTILE_SECRET, response: token, remoteip: ip }),
      signal:AbortSignal.timeout(10_000),
    });
    if(!res.ok) return 'unavailable';
    const j = (await res.json()) as { success?: boolean; hostname?:string; action?:string; 'error-codes'?:string[] };
    if(j['error-codes']?.includes('invalid-input-secret') || j['error-codes']?.includes('missing-input-secret')) return 'configuration';
    return j.success===true && j.action==='form_submit' && hosts.includes(j.hostname??'') && j.hostname===new URL(requestUrl).hostname ? 'ok':'challenge';
  } catch {
    return 'unavailable';
  }
}

function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
}

/* ------------------------------------------------------------------ */
/* Submission planning (pure-ish — assembled here, applied in the route)  */
/* ------------------------------------------------------------------ */

interface WriteOp {
  id: string;
  collection: string;
  patch: Record<string, unknown>;
}

/** Everything a submission writes, as applyChanges ops. Order matters: the
 *  record lands first, then links, then file reparents. */
export function planSubmissionChanges(args: {
  form: FormConfig;
  formId: string;
  boardData: Record<string, unknown>;
  coerced: Record<string, unknown>;
  submissionId: string;
  lastOrder: string | undefined;
  personMatch: PersonMatch;
  pendingFileIds: string[];
  fileLink?: string;
  at: number;
  recordId?:string;
}): WriteOp[] {
  const { form, formId, boardData, coerced, submissionId, personMatch } = args;
  const recordId = args.recordId ?? (personMatch.kind==='email'?personMatch.personId:submissionRecordId(formId, submissionId));
  const columns = Array.isArray(boardData.columns) ? (boardData.columns as { id: string }[]) : [];
  const patch: Record<string, unknown> = {
    boardId: form.databaseId,
    title: typeof coerced.title === 'string' && coerced.title ? coerced.title : 'Submission',
    status: typeof coerced.status === 'string' ? coerced.status : (columns[0]?.id ?? null),
    order: orderBetween(args.lastOrder, undefined),
    parentId: null,
    createdBy: null,
    createdAt: args.at,
    deleted: false,
  };
  for (const [k, v] of Object.entries(coerced)) {
    if (k === 'title' || k === 'status') continue;
    patch[k] = v;
  }
  // possible-duplicate flag rides on the record itself
  if (personMatch.kind === 'name-similar' || personMatch.kind === 'email') {
    const notes = notesFieldOf(boardData);
    if (notes && personMatch.kind === 'name-similar') {
      const key = propKey(notes.id);
      const existing = typeof patch[key] === 'string' ? `${patch[key]}\n` : '';
      patch[key] = `${existing}${duplicateMarker(personMatch.personTitle, args.at)}`;
    }
  }
  const ops: WriteOp[] = personMatch.kind==='email' ? [] : [{ id: recordId, collection: 'tasks', patch }];

  // fixed relations — normalise to the primary direction like link_items
  for (const rel of form.createRelations ?? []) {
    const def = fieldsOf(boardData).find((f) => f.id === rel.fieldId && f.type === 'relation');
    if (!def || !def.relation) continue;
    let fieldId = def.id;
    let fromId = recordId;
    let toId = rel.toId;
    let toType: 'record' | 'page' = 'record';
    if (def.relation.target === 'pages') toType = 'page';
    if (def.relation.pairedFieldId && !def.relation.primary) {
      // our field is the reverse side — swap ends, store under the paired id
      fieldId = def.relation.pairedFieldId;
      const tmp = fromId;
      fromId = toId;
      toId = tmp;
      // the record we created is now the `to`; the member-picked target is `from`
      if (def.relation.target === 'pages') toType = 'record';
    }
    ops.push({
      id: linkId('relation', fieldId, fromId, toId),
      collection: 'links',
      patch: {
        fromType: toType === 'page' && fromId === rel.toId ? 'page' : 'record',
        fromId,
        toType,
        toId,
        kind: 'relation',
        fieldId,
        deleted: false,
        createdBy: null,
        createdAt: args.at,
      },
    });
  }

  // peopleMatch email-hit → see-also link between the submission and the person
  if (personMatch.kind === 'email' && personMatch.personId!==recordId) {
    ops.push({
      id: linkId('related', '', recordId, personMatch.personId),
      collection: 'links',
      patch: {
        fromType: 'record',
        fromId: recordId,
        toType: 'record',
        toId: personMatch.personId,
        kind: 'related',
        fieldId: null,
        deleted: false,
        createdBy: null,
        createdAt: args.at,
      },
    });
  }

  // attach pending uploads — only files already staged under THIS form
  for (const fileId of args.pendingFileIds) {
    ops.push({
      id: fileId,
      collection: 'files',
      patch: { parentType: 'task', parentId: recordId },
    });
  }

  // pasted Drive/Dropbox link → kind:'link' file record (same shape as the
  // member-side "attach link" feature; never uploads bytes)
  if (args.fileLink) {
    ops.push({
      id: `f_${fnv1a64hex(`${formId}|${submissionId}|link`)}`,
      collection: 'files',
      patch: {
        kind: 'link',
        url: args.fileLink,
        name: 'Attachment link',
        parentType: 'task',
        parentId: recordId,
        uploadedBy: null,
        createdAt: args.at,
        deleted: false,
      },
    });
  }
  return ops;
}

/* ------------------------------------------------------------------ */
/* Member API (mounted /api/forms — session auth)                      */
/* ------------------------------------------------------------------ */

export const formsApi = new Hono<{ Bindings: Bindings; Variables: { user: AuthUser } }>();
formsApi.use('*', requireAuth);

/** Create or update a form config (upsert by body.id; always re-validates). */
formsApi.post('/', async (c) => {
  const body = await c.req.json<{ id?: string } & Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: 'invalid json' }, 400);
  const form = parseFormConfig(body as Record<string, unknown>);
  if (!form) return c.json({ error: 'invalid form config' }, 422);

  const board = await getRec(c.env, form.databaseId);
  if (!board || board.collection !== 'boards' || board.data.deleted) return c.json({ error: 'database not found' }, 404);

  const errors = validateFormConfig(form, board.data);
  if (form.notifyUserIds.length) {
    const { results } = await c.env.DB.prepare('SELECT id FROM users').all<{ id: string }>();
    const known = new Set(results.map((r) => r.id));
    const bad = form.notifyUserIds.filter((u) => !known.has(u));
    if (bad.length) errors.push(`notifyUserIds contains unknown users: ${bad.join(', ')}`);
  }
  for (const rel of form.createRelations ?? []) {
    const target = await getRec(c.env, rel.toId);
    const def=fieldsOf(board.data).find(f=>f.id===rel.fieldId&&f.type==='relation');
    const expected=def?.relation?.target;
    const valid=target&&!target.data.deleted&&(expected==='pages'?target.collection==='pages':target.collection==='tasks'&&target.data.boardId===expected);
    if (!valid) errors.push(`createRelations target ${rel.toId} is not in the configured relation database`);
  }
  if (errors.length) return c.json({ error: 'validation', details: errors }, 422);

  const id = typeof body.id === 'string' && body.id ? body.id : `form_${uuid()}`;
  const user = c.get('user');
  const patch: Record<string, unknown> = {
    databaseId: form.databaseId,
    title: form.title,
    description: form.description ?? null,
    fields: form.fields,
    successMessage: form.successMessage,
    enabled: form.enabled,
    notifyUserIds: form.notifyUserIds,
    createRelations: form.createRelations ?? [],
    peopleMatch: form.peopleMatch ?? null,
    branding: form.branding ?? null,
    updatedBy: user.id,
    updatedAt: Date.now(),
  };
  const existing = await getRec(c.env, id);
  if (existing && (existing.collection !== 'forms' || existing.data.deleted)) return c.json({ error: 'id taken' }, 409);
  if (!existing) {
    patch.createdBy = user.id;
    patch.createdAt = Date.now();
  }
  const written=await applyChanges(c.env, user.id, [{ id, collection: 'forms', patch, ts: Date.now() }], {
    serverTs: true,
    event: { source: 'client', ctx: c.executionCtx },
  });
  if(written.partialError||written.conflicts?.length||written.rejected) return c.json({error:'form_write_interrupted',retryable:true},503);
  pokeLive(c.env, c.executionCtx);
  return c.json({ id });
});

/** Form config + its token list (tokens are D1-only, never synced). */
formsApi.get('/:id', async (c) => {
  const rec = await getRec(c.env, c.req.param('id'));
  if (!rec || rec.collection !== 'forms' || rec.data.deleted) return c.json({ error: 'form not found' }, 404);
  const form = parseFormConfig(rec.data);
  const { results } = await c.env.DB.prepare('SELECT token, created_at, revoked_at FROM form_tokens WHERE form_id = ? ORDER BY created_at DESC').bind(rec.id).all<TokenRow>();
  return c.json({
    form,
    tokens: results.map((t) => ({ token: t.token, createdAt: t.created_at, revokedAt: t.revoked_at })),
  });
});

/** Mint a publish token for a form. */
formsApi.post('/:id/tokens', async (c) => {
  const rec = await getRec(c.env, c.req.param('id'));
  if (!rec || rec.collection !== 'forms' || rec.data.deleted) return c.json({ error: 'form not found' }, 404);
  const token = mintToken();
  await c.env.DB.prepare('INSERT INTO form_tokens (token, form_id, created_at, revoked_at) VALUES (?, ?, ?, NULL)').bind(token, rec.id, Date.now()).run();
  return c.json({ token });
});

/** Revoke a publish token (immediate: public reads check revoked_at). */
formsApi.delete('/tokens/:token', async (c) => {
  const token = c.req.param('token');
  const res = await c.env.DB.prepare('UPDATE form_tokens SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL').bind(Date.now(), token).run();
  if (!res.meta.changes) return c.json({ error: 'token not found' }, 404);
  return c.json({ ok: true });
});

/** Config-level validation shared by POST and tests. */
export function validateFormConfig(form: FormConfig, boardData: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const f of form.fields) {
    if (seen.has(f.fieldKey)) errors.push(`duplicate fieldKey ${f.fieldKey}`);
    seen.add(f.fieldKey);
    if (!publicFieldFor(f, boardData)) errors.push(`fieldKey ${f.fieldKey} is not exposable on this database`);
  }
  for (const rel of form.createRelations ?? []) {
    const def = fieldsOf(boardData).find((f) => f.id === rel.fieldId && f.type === 'relation');
    if (!def) errors.push(`createRelations field ${rel.fieldId} is not a relation field on this database`);
  }
  if (form.peopleMatch) {
    const fid = peopleEmailKey(form.peopleMatch.emailField).slice(2);
    const def = fieldsOf(boardData).find((f) => f.id === fid);
    if (!def) errors.push('peopleMatch.emailField is not a field on this database');
    else if (def.type !== 'text' && def.type !== 'url') errors.push('peopleMatch.emailField must be a text or url field');
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* Public API (mounted /api/public/forms — unauthed, token-gated)       */
/* ------------------------------------------------------------------ */

export const publicFormsApi = new Hono<{ Bindings: Bindings }>();
publicFormsApi.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});

const UNAVAILABLE = (c: { json: (o: unknown, s: number) => Response }) => c.json({ error: 'unavailable' }, 410);

/** GET schema — filtered: notifyUserIds/createRelations/peopleMatch never leave. */
publicFormsApi.get('/:token', async (c) => {
  const hit = await formByToken(c.env, c.req.param('token'));
  if (!hit || !hit.form.enabled) return UNAVAILABLE(c);
  const local=localTurnstileTest(c.env,c.req.url);
  if(!local && (!c.env.TURNSTILE_SECRET || !c.env.TURNSTILE_SITE_KEY || !c.env.TURNSTILE_HOSTNAMES)) return c.json({error:'challenge_configuration',retryable:false},503);
  const siteKey = local ? TURNSTILE_TEST_SITEKEY : c.env.TURNSTILE_SITE_KEY!;
  return c.json(publicFormSchema(hit.form, hit.board.data, siteKey));
});

/** POST an image staged against the form (reparented on submit accept). */
publicFormsApi.post('/:token/files', async (c) => {
  const hit = await formByToken(c.env, c.req.param('token'));
  if (!hit || !hit.form.enabled) return UNAVAILABLE(c);
  const ip = clientIp(c);
  const used = await rateLimitHit(c.env, 'form', `${ip}:${c.req.param('token')}`, FORM_RATE_WINDOW_MS);
  if (used > FORM_RATE_LIMIT) return c.json({ error: 'rate_limited' }, 429);

  const raw=await boundedRequestBody(c.req.raw,FORM_MAX_IMAGE+64*1024);
  if(!raw) return c.json({error:'too_large'},413);
  const fd = await new Request(c.req.url,{method:'POST',headers:c.req.raw.headers,body:new Uint8Array(raw).buffer}).formData().catch(() => null);
  const challenge=await verifyFormChallenge(c.env,fd?.get('turnstileToken'),ip,c.req.url);
  if(challenge!=='ok') return c.json({error:challenge==='challenge'?'challenge':'challenge_unavailable'},challenge==='challenge'?403:503);
  const file = fd?.get('file');
  if (!file || !(file instanceof File)) return c.json({ error: 'file required' }, 400);
  if (!file.type.startsWith('image/')) return c.json({ error: 'images only' }, 415);
  if (file.size > FORM_MAX_IMAGE) return c.json({ error: 'too_large' }, 413);

  const id = `f_${uuid()}`;
  const claim=randomToken();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size) return c.json({ error: 'too_large' }, 413);
  const parts = fileChunkSlices(bytes);
  if (parts.some((part) => part.byteLength >= D1_MAX_ROW_BYTES)) return c.json({ error: 'too_large' }, 413);
  const now = Date.now();
  const db = c.env.DB;
  const dropFile = () => db.batch([
    db.prepare('DELETE FROM file_chunks WHERE file_id=?').bind(id),
    db.prepare('DELETE FROM files WHERE id=?').bind(id),
    db.prepare('DELETE FROM records WHERE id=?').bind(id),
  ]);
  try {
    await db.batch([
      db.prepare('INSERT INTO files (id, uploaded_by, created_at, complete, mime, size, chunks) SELECT ?, NULL, ?, 0, ?, ?, ? WHERE (SELECT COALESCE(SUM(size),0) FROM files WHERE complete=1)+?<=?')
        .bind(id, now, file.type, bytes.byteLength, parts.length, bytes.byteLength, QUOTA_BYTES),
      ...parts.map((part, idx) => db.prepare('INSERT INTO file_chunks (file_id, idx, data) SELECT ?, ?, ? WHERE EXISTS(SELECT 1 FROM files WHERE id=?)').bind(id, idx, part, id)),
      db.prepare('UPDATE files SET complete=1 WHERE id=? AND (SELECT COUNT(*) FROM file_chunks WHERE file_id=?)=? AND (SELECT COALESCE(SUM(LENGTH(data)),0) FROM file_chunks WHERE file_id=?)=?')
        .bind(id, id, parts.length, id, bytes.byteLength),
    ]);
  } catch {
    await dropFile().catch(() => {});
    return c.json({ error: 'temporary_failure' }, 503);
  }
  const stored = await db.prepare('SELECT complete FROM files WHERE id=? AND complete=1').bind(id).first<{ complete: number }>();
  if (!stored) {
    const exists = await db.prepare('SELECT id FROM files WHERE id=?').bind(id).first();
    await dropFile().catch(() => {});
    return c.json({ error: exists ? 'temporary_failure' : 'workspace_full' }, exists ? 503 : 507);
  }
  const lens = await db.prepare('SELECT idx, LENGTH(data) AS n FROM file_chunks WHERE file_id=? ORDER BY idx').bind(id).all<{ idx: number; n: number }>();
  const durable = lens.results.length === parts.length && lens.results.every((row, idx) => row.idx === idx && row.n === parts[idx]!.byteLength && row.n < D1_MAX_ROW_BYTES);
  if (!durable) {
    await dropFile().catch(() => {});
    return c.json({ error: 'temporary_failure' }, 503);
  }
  const uploaded=await applyChanges(c.env, 'form', [{ id, collection: 'files', patch: {
    name: file.name || 'upload',
    mime: file.type,
    size: file.size,
    kind: 'image',
    parentType: 'form-pending',
    parentId: hit.formId,
    uploadedBy: null,
    createdAt: now,
    deleted: false,
    uploadClaimHash:await sha256Hex(claim),
  }, ts: now }], { serverTs: true, event: { source: 'form', ctx: c.executionCtx } });
  if(uploaded.partialError||uploaded.rejected) {
    await dropFile().catch(() => {});
    return c.json({error:'temporary_failure'},503);
  }
  pokeLive(c.env, c.executionCtx);
  return c.json({ id,claim });
});

/**
 * POST a submission. Ordered pipeline (spec §6):
 * token+enabled → rate+size → Turnstile → dedupe → validate → write → notify.
 */
interface SubmissionPlan {
  ops:WriteOp[]; recordId:string; cs:ChangesetCtx;
  receipt:{state:'accepted';submissionId:string;message:string;at:number};
  event:SemanticEvent;
}
interface SubmissionPayload { token:string; body:Record<string,unknown>; form:FormConfig; formId:string; board:RecRowLite }
type SubmissionOutcome={status:200|202|403|409|410|422|503;body:Record<string,unknown>};

/** Recover a reservation under a short, fenced lease. Plans and per-record
 * checkpoints survive interruption; accepted receipts never depend on HTTP
 * response delivery. Challenges are redeemed once, before reservation. */
export async function resumeSubmission(env:Bindings,submissionId:string,ctx:{waitUntil(p:Promise<unknown>):void}):Promise<SubmissionOutcome> {
  const row=await env.DB.prepare('SELECT * FROM form_submissions WHERE submission_id=?').bind(submissionId).first<{form_id:string;state:string;receipt:string|null;error:string|null;payload:string|null;plan:string|null;attempts:number}>();
  if(!row) return {status:410,body:{error:'unavailable'}};
  if(row.state==='accepted'&&row.receipt) return {status:200,body:JSON.parse(row.receipt)};
  if(row.state==='rejected') return {status:422,body:row.error?JSON.parse(row.error):{error:'rejected'}};
  if(!row.payload) return {status:503,body:{state:'retryable_failure',error:'retry_required',retryable:true}};
  const now=Date.now(),lease=crypto.randomUUID();
  const claimed=await env.DB.prepare(`UPDATE form_submissions SET state='processing',lease_id=?,lease_until=?,attempts=attempts+1,updated_at=?
    WHERE submission_id=? AND attempts<? AND retry_at<=? AND (state IN ('pending','retryable_failure') OR (state='processing' AND COALESCE(lease_until,0)<=?))
    RETURNING attempts`).bind(lease,now+EXECUTION_LEASE_MS,now,submissionId,EXECUTION_MAX_ATTEMPTS,now,now).first<{attempts:number}>();
  if(!claimed) {
    if(row.attempts>=EXECUTION_MAX_ATTEMPTS) {
      await env.DB.prepare("UPDATE form_submissions SET state='rejected',error=? WHERE submission_id=? AND state!='accepted' AND COALESCE(lease_until,0)<=?").bind(JSON.stringify({error:'attempt_limit',retryable:false}),submissionId,now).run();
      return {status:422,body:{error:'attempt_limit',retryable:false}};
    }
    return {status:202,body:{state:'processing',retryable:true,retryAfter:2}};
  }
  const reject=async(body:Record<string,unknown>,status:410|422=422):Promise<SubmissionOutcome>=>{
    await env.DB.prepare("UPDATE form_submissions SET state='rejected',error=?,lease_id=NULL,lease_until=NULL,updated_at=? WHERE submission_id=? AND lease_id=?").bind(JSON.stringify(body),Date.now(),submissionId,lease).run();
    return {status,body};
  };
  try {
    const p=JSON.parse(row.payload) as SubmissionPayload;
    const live=await formByToken(env,p.token);
    if(!live||!live.form.enabled||live.formId!==row.form_id) return await reject({error:'unavailable',retryable:false},410);
    // A reservation captures member-authorized configuration, not perpetual
    // authority to write into an old database after the form is remapped.
    if(JSON.stringify(live.form)!==JSON.stringify(p.form)) return await reject({error:'form_configuration_changed',retryable:false},422);
    // The form row can stay unchanged while its database fields/columns or
    // gate change. A durable plan captured the former schema and cannot turn
    // that snapshot into authority after a member changes the configuration.
    const schema = (data: Record<string, unknown>) => JSON.stringify({
      fields: data.fields ?? [], columns: data.columns ?? [], approvalGate: data.approvalGate ?? null,
    });
    if (schema(live.board.data) !== schema(p.board.data)) return await reject({ error: 'form_configuration_changed', retryable: false }, 422);
    const configErrors = validateFormConfig(live.form, live.board.data);
    if (configErrors.length) return await reject({ error: 'form_configuration', retryable: false });
    const authority = new Map<string, number>([[live.formId, live.formRev], [live.board.id, live.board.rev!]]);
    // Recheck fixed destinations even when a plan already exists: the
    // destination itself may have moved or been deleted during interruption.
    for (const rel of live.form.createRelations ?? []) {
      const def = fieldsOf(live.board.data).find(f => f.id === rel.fieldId);
      const target = await getRec(env, rel.toId);
      const valid = target && !target.data.deleted && !target.data.archived &&
        (def?.relation?.target === 'pages' ? target.collection === 'pages' : target.collection === 'tasks' && target.data.boardId === def?.relation?.target);
      if (!valid) return await reject({ error: 'form_configuration', retryable: false });
      authority.set(target.id, target.rev);
    }
    // The validated authority must still exist when writes/receipt commit.
    // One JSON binding also avoids a parameter-count explosion for relations.
    const authorityFence = () => env.DB.prepare(`SELECT CASE WHEN
      EXISTS(SELECT 1 FROM form_submissions WHERE submission_id=? AND lease_id=? AND lease_until>?)
      AND EXISTS(SELECT 1 FROM form_tokens WHERE token=? AND form_id=? AND revoked_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM json_each(?) e LEFT JOIN records r ON r.id=e.key WHERE r.seq IS NOT e.value)
      THEN 1 ELSE json_extract('{','$') END`)
      .bind(submissionId, lease, Date.now(), p.token, live.formId, JSON.stringify(Object.fromEntries(authority)));
    let plan:SubmissionPlan;
    if(row.plan) plan=JSON.parse(row.plan);
    else {
      const {form,formId,body}=p;
      const board = live.board;
      const res=validateSubmissionValues(form,board.data,body.values);
      if(!res.ok) return await reject({error:'validation',fieldErrors:res.errors});
      const pendingFileIds:string[]=[];
      const fileIds=Array.isArray(body.fileIds)?body.fileIds:[];
      if(fileIds.length>FORM_MAX_FILES) return await reject({error:'validation',fieldErrors:{files:'Too many files'}});
      const claims=body.fileClaims&&typeof body.fileClaims==='object'?body.fileClaims as Record<string,unknown>:{};
      for(const fid of fileIds) {
        if(typeof fid!=='string') return await reject({error:'validation',fieldErrors:{files:'Invalid upload'}});
        const file=await getRec(env,fid);
        if(!file||file.collection!=='files'||file.data.deleted||file.data.parentType!=='form-pending'||file.data.parentId!==formId ||
          typeof claims[fid]!=='string'||file.data.uploadClaimHash!==await sha256Hex(String(claims[fid]))) return await reject({error:'validation',fieldErrors:{files:'Upload is unavailable'}});
        pendingFileIds.push(fid);
      }
      let fileLink:string|undefined;
      if(typeof body.fileLink==='string'&&body.fileLink.trim()) {
        try {const url=new URL(body.fileLink.trim());if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.href.length>1000) throw new Error();fileLink=url.href;}
        catch {return await reject({error:'validation',fieldErrors:{fileLink:'Invalid link'}});}
      }
      const existing=form.peopleMatch?await listBy(env,'tasks','boardId',form.databaseId):[];
      let match:PersonMatch={kind:'none'};
      let recordId=submissionRecordId(formId,submissionId);
      if(form.peopleMatch) {
        const emailKey=peopleEmailKey(form.peopleMatch.emailField),email=normalizeEmail(res.coerced[emailKey]);
        if(email) {
          match=findPersonMatch(emailKey,email,res.coerced.title,existing.map(r=>({id:r.id,data:r.data,title:r.data.title})));
          const candidate=match.kind==='email'?match.personId:`person_${(await sha256Hex(form.databaseId+'|'+emailKey+'|'+email)).slice(0,48)}`;
          await env.DB.prepare('INSERT OR IGNORE INTO form_people_keys(database_id,field_key,email,record_id) VALUES(?,?,?,?)').bind(form.databaseId,emailKey,email,candidate).run();
          const reserved=await env.DB.prepare('SELECT record_id FROM form_people_keys WHERE database_id=? AND field_key=? AND email=?').bind(form.databaseId,emailKey,email).first<{record_id:string}>();
          recordId=reserved!.record_id;
          const person=await getRec(env,recordId);
          if(person&&!person.data.deleted) match={kind:'email',personId:recordId,personTitle:String(person.data.title??'')};
          res.coerced[emailKey]=email;
        }
      }
      const lastOrder=form.peopleMatch?existing.map(r=>String(r.data.order??'')).sort(cmpOrder).pop():
        (await env.DB.prepare("SELECT json_extract(data,'$.order') AS value FROM records WHERE collection='tasks' AND json_extract(data,'$.boardId')=? AND COALESCE(json_extract(data,'$.deleted'),0)!=1 ORDER BY json_extract(data,'$.order') DESC LIMIT 1").bind(form.databaseId).first<{value:string|null}>())?.value??undefined;
      const ops=planSubmissionChanges({form,formId,boardData:board.data,coerced:res.coerced,submissionId,lastOrder,personMatch:match,pendingFileIds,fileLink,at:row.attempts?now:now,recordId});
      const cs=beginChangeset({userId:'form',clientName:'form',tool:'form_submit',summary:`Submission on "${form.title}"`,source:'form'});
      cs.id=`cs_sub_${fnv1a64hex(formId+'|'+submissionId)}`;
      plan={ops,recordId,cs,receipt:{state:'accepted',submissionId,message:form.successMessage,at:now},event:{kind:'form.submitted',recordId,collection:'tasks',boardId:form.databaseId,formId}};
      await env.DB.prepare('UPDATE form_submissions SET plan=?,record_id=?,changeset_id=? WHERE submission_id=? AND lease_id=?').bind(JSON.stringify(plan),recordId,cs.id,submissionId,lease).run();
    }
    const operationId='form:'+submissionId;
    const done=await completedRecords(env.DB,operationId);
    let ops=plan.ops.filter(o=>!done.has(o.id));
    // A concurrent email reservation may already have created the Person.
    // Never overwrite that person's fields with another visitor's answers.
    if(plan.recordId.startsWith('person_') && await getRec(env,plan.recordId)) ops=ops.filter(o=>!(o.collection==='tasks'&&o.id===plan.recordId));
    if(ops.length) {
      const execution=executionOptions(env,'form_submissions',submissionId,lease);
      execution.guard = authorityFence;
      execution.checkpoint=id=>env.DB.prepare('INSERT OR IGNORE INTO execution_steps(operation_id,step_id,done_at) VALUES(?,?,?)').bind(operationId,'record:'+id,Date.now());
      const result=await applyChanges(env,'form',ops.map(o=>({...o,ts:now})),{serverTs:true,atomic:true,createOnly:plan.recordId.startsWith('person_')?new Set([plan.recordId]):undefined,journal:plan.cs,execution,event:{source:'form',ctx,changesetId:plan.cs.id}});
      if(result.rejected) return await reject({error:'submission_rejected',retryable:false});
      if(result.partialError||result.conflict||result.conflicts?.length) throw new Error(result.partialError??'write conflict');
    }
    const outboxId='ev_form_'+fnv1a64hex(row.form_id+'|'+submissionId);
    // The receipt and synthetic form event share their acknowledgement
    // transaction. Per-record writes/audit/events already share theirs.
    await env.DB.batch([
      authorityFence(),
      env.DB.prepare('INSERT OR IGNORE INTO event_outbox(id,payload,created_at) VALUES(?,?,?)').bind(outboxId,JSON.stringify({source:'form',userId:'form',changesetId:plan.cs.id,applied:[],extra:[plan.event]}),now),
      env.DB.prepare("UPDATE form_submissions SET state='accepted',receipt=?,record_id=?,error=NULL,lease_id=NULL,lease_until=NULL,updated_at=? WHERE submission_id=? AND lease_id=?").bind(JSON.stringify(plan.receipt),plan.recordId,Date.now(),submissionId,lease),
    ]);
    const {scheduleOutbox}=await import('./events');scheduleOutbox(env,ctx,[outboxId]);
    return {status:200,body:plan.receipt};
  } catch(error) {
    if(error instanceof D1BudgetExhausted) {
      await d1CleanupDatabase(env.DB).prepare("UPDATE form_submissions SET state='retryable_failure',attempts=MAX(0,attempts-1),error=?,retry_at=?,lease_id=NULL,lease_until=NULL,updated_at=? WHERE submission_id=? AND lease_id=?").bind(JSON.stringify({error:'processing_budget',retryable:true}),Date.now()+60_000,Date.now(),submissionId,lease).run();
      return {status:503,body:{error:'processing_budget',retryable:true}};
    }
    const terminal=claimed.attempts>=EXECUTION_MAX_ATTEMPTS;
    const body={error:terminal?'attempt_limit':'temporary_failure',retryable:!terminal};
    await env.DB.prepare('UPDATE form_submissions SET state=?,error=?,retry_at=?,lease_id=NULL,lease_until=NULL,updated_at=? WHERE submission_id=? AND lease_id=?')
      .bind(terminal?'rejected':'retryable_failure',JSON.stringify(body),Date.now()+retryDelay(claimed.attempts),Date.now(),submissionId,lease).run();
    return {status:terminal?422:503,body};
  }
}

export async function recoverFormSubmissions(env:Bindings,ctx:{waitUntil(p:Promise<unknown>):void}):Promise<void> {
  const now=Date.now();
  const {results}=await env.DB.prepare(`SELECT submission_id FROM form_submissions WHERE payload IS NOT NULL AND retry_at<=? AND (state IN ('pending','retryable_failure') OR (state='processing' AND COALESCE(lease_until,0)<=?)) ORDER BY created_at LIMIT 20`).bind(now,now).all<{submission_id:string}>();
  for(const row of results){if(!hasD1Budget(env.DB,28))break;await resumeSubmission(env,row.submission_id,ctx);}
}

publicFormsApi.post('/:token', async (c) => {
  const token=c.req.param('token'),hit=await formByToken(c.env,token);
  if(!hit) return UNAVAILABLE(c);
  const bytes=await boundedRequestBody(c.req.raw,FORM_MAX_PAYLOAD);
  if(!bytes) return c.json({error:'too_large'},413);
  let body:Record<string,unknown>;
  try {const parsed=JSON.parse(new TextDecoder().decode(bytes));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)) throw new Error();body=parsed;}
  catch {return c.json({error:'invalid json'},400);}
  const submissionId=typeof body.submissionId==='string'?body.submissionId:'';
  if(!SUBMISSION_ID_RE.test(submissionId)) return c.json({error:'submissionId required (1–64 chars)'},400);
  const safeBody={...body};delete safeBody.turnstileToken;
  const requestHash=await sha256Hex(JSON.stringify(safeBody));
  const stored=await c.env.DB.prepare('SELECT form_id,request_hash,state,receipt FROM form_submissions WHERE submission_id=?').bind(submissionId).first<{form_id:string;request_hash:string|null;state:string;receipt:string|null}>();
  if(stored) {
    if(stored.form_id!==hit.formId||stored.request_hash&&stored.request_hash!==requestHash) return c.json({error:'submission_conflict'},409);
    if(stored.state==='accepted'&&stored.receipt) return c.json(JSON.parse(stored.receipt));
    // Legacy reservations had no durable payload; a verified retry can repair
    // them rather than returning an unresumable Processing forever.
    if(stored.request_hash) {const result=await resumeSubmission(c.env,submissionId,c.executionCtx);return c.json(result.body,result.status);}
  }
  if(!hit.form.enabled) return UNAVAILABLE(c);
  const ip=clientIp(c);
  if(await rateLimitHit(c.env,'form',ip+':'+token,FORM_RATE_WINDOW_MS)>FORM_RATE_LIMIT) return c.json({error:'rate_limited'},429);
  const challenge=await verifyFormChallenge(c.env,body.turnstileToken,ip,c.req.url);
  if(challenge!=='ok') return c.json({error:challenge==='configuration'?'challenge_configuration':challenge==='unavailable'?'challenge_unavailable':'challenge',retryable:challenge!=='configuration'},challenge==='challenge'?403:503);
  const payload=JSON.stringify({token,body:safeBody,form:hit.form,formId:hit.formId,board:hit.board});
  await c.env.DB.prepare("INSERT OR IGNORE INTO form_submissions(submission_id,form_id,state,created_at,request_hash,payload) VALUES(?,?,'pending',?,?,?)").bind(submissionId,hit.formId,Date.now(),requestHash,payload).run();
  if(stored&&!stored.request_hash) await c.env.DB.prepare("UPDATE form_submissions SET payload=?,request_hash=?,state='pending' WHERE submission_id=? AND form_id=? AND state='processing' AND payload IS NULL").bind(payload,requestHash,submissionId,hit.formId).run();
  const reserved=await c.env.DB.prepare('SELECT form_id,request_hash FROM form_submissions WHERE submission_id=?').bind(submissionId).first<{form_id:string;request_hash:string}>();
  if(reserved?.form_id!==hit.formId||reserved.request_hash!==requestHash) return c.json({error:'submission_conflict'},409);
  const result=await resumeSubmission(c.env,submissionId,c.executionCtx);
  if(result.status===200) pokeLive(c.env,c.executionCtx);
  return c.json(result.body,result.status);
});
/** Orphan sweep — deletes staged 'form-pending' uploads older than 24h
 *  (record + D1 blob). runScheduled (Workstream B) calls this from cron;
 *  exported here so the C surface stays self-contained. */
export async function sweepFormFileOrphans(env: Bindings, ectx: { waitUntil(p: Promise<unknown>): void }): Promise<number> {
  const cutoff = Date.now() - FORM_ORPHAN_AGE_MS;
  const { results } = await env.DB
    .prepare("SELECT id, data FROM records WHERE collection = 'files' AND json_extract(data, '$.parentType') = 'form-pending'")
    .all<{ id: string; data: string }>();
  const stale = results.filter((r) => {
    try {
      const d = JSON.parse(r.data) as { createdAt?: number; deleted?: boolean };
      return !d.deleted && (d.createdAt ?? 0) < cutoff;
    } catch {
      return false;
    }
  });
  if (!stale.length) return 0;
  const now = Date.now();
  await applyChanges(
    env,
    'form',
    stale.map((r) => ({ id: r.id, collection: 'files', patch: { deleted: true }, ts: now })),
    { serverTs: true, event: { source: 'form', ctx: ectx } },
  );
  await env.DB.batch(
    stale.flatMap((r) => [
      env.DB.prepare('DELETE FROM file_chunks WHERE file_id = ?').bind(r.id),
      env.DB.prepare('DELETE FROM files WHERE id = ?').bind(r.id),
    ]),
  );
  return stale.length;
}
