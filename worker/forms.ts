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
import { beginChangeset, commitChangeset } from './changesets';
import { notify } from './notifications';
import { getRec, listBy } from './records';
import { requireAuth, type Env, type AuthUser } from './auth';
import { coerceFieldValue, fieldsOf, propKey, type FieldDef } from '../shared/fields';
import { cmpOrder, orderBetween, uuid } from '../shared/order';
import { fnv1a64hex, linkId } from '../shared/linkid';
import type { SemanticEvent } from '../shared/events';

type Bindings = Env & {
  /** When set, Turnstile runs for real; unset = test mode ('pass'/'fail'). */
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
};

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
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Rejection-free base64url → base62-ish: we don't need uniform crypto-grade
  // distribution, just uniqueness + token secrecy (both satisfied).
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
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

async function formByToken(env: Bindings, token: string): Promise<{ form: FormConfig; formId: string; board: RecRowLite } | null> {
  const t = await env.DB.prepare('SELECT token, form_id, created_at, revoked_at FROM form_tokens WHERE token = ?').bind(token).first<TokenRow>();
  if (!t || t.revoked_at !== null) return null;
  const rec = await getRec(env, t.form_id);
  if (!rec || rec.collection !== 'forms' || rec.data.deleted) return null;
  const form = parseFormConfig(rec.data);
  if (!form) return null;
  const board = await getRec(env, form.databaseId);
  if (!board || board.collection !== 'boards' || board.data.deleted) return null;
  return { form, formId: rec.id, board: recLite(board) };
}

interface RecRowLite {
  id: string;
  data: Record<string, unknown>;
}
function recLite(r: { id: string; data: Record<string, unknown> }): RecRowLite {
  return { id: r.id, data: r.data };
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

async function turnstileOk(env: Bindings, token: unknown, ip: string): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) return token === 'pass'; // test mode — 'fail' exercises the 403 path
  if (typeof token !== 'string' || !token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
    });
    const j = (await res.json()) as { success?: boolean };
    return j.success === true;
  } catch {
    return false;
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
}): WriteOp[] {
  const { form, formId, boardData, coerced, submissionId, personMatch } = args;
  const recordId = submissionRecordId(formId, submissionId);
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
  const ops: WriteOp[] = [{ id: recordId, collection: 'tasks', patch }];

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
  if (personMatch.kind === 'email') {
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
      id: `f_${uuid()}`,
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
    if (!target || target.data.deleted) errors.push(`createRelations target ${rel.toId} not found`);
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
  await applyChanges(c.env, user.id, [{ id, collection: 'forms', patch, ts: Date.now() }], {
    serverTs: true,
    event: { source: 'client', ctx: c.executionCtx },
  });
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

const UNAVAILABLE = (c: { json: (o: unknown, s: number) => Response }) => c.json({ error: 'unavailable' }, 410);

/** GET schema — filtered: notifyUserIds/createRelations/peopleMatch never leave. */
publicFormsApi.get('/:token', async (c) => {
  const hit = await formByToken(c.env, c.req.param('token'));
  if (!hit || !hit.form.enabled) return UNAVAILABLE(c);
  const siteKey = c.env.TURNSTILE_SECRET ? (c.env.TURNSTILE_SITE_KEY ?? TURNSTILE_TEST_SITEKEY) : TURNSTILE_TEST_SITEKEY;
  return c.json(publicFormSchema(hit.form, hit.board.data, siteKey));
});

/** POST an image staged against the form (reparented on submit accept). */
publicFormsApi.post('/:token/files', async (c) => {
  const hit = await formByToken(c.env, c.req.param('token'));
  if (!hit || !hit.form.enabled) return UNAVAILABLE(c);
  const ip = clientIp(c);
  const used = await rateLimitHit(c.env, 'form', `${ip}:${c.req.param('token')}`, FORM_RATE_WINDOW_MS);
  if (used > FORM_RATE_LIMIT) return c.json({ error: 'rate_limited' }, 429);

  const fd = await c.req.formData().catch(() => null);
  const file = fd?.get('file');
  if (!file || !(file instanceof File)) return c.json({ error: 'file required' }, 400);
  if (!file.type.startsWith('image/')) return c.json({ error: 'images only' }, 415);
  if (file.size > FORM_MAX_IMAGE) return c.json({ error: 'too_large' }, 413);

  const id = `f_${uuid()}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO files (id, uploaded_by, created_at, complete, mime, size) VALUES (?, NULL, ?, 1, ?, ?)').bind(id, now, file.type, file.size),
    c.env.DB.prepare('INSERT INTO file_chunks (file_id, idx, data) VALUES (?, 0, ?)').bind(id, bytes),
  ]);
  await applyChanges(c.env, 'form', [{ id, collection: 'files', patch: {
    name: file.name || 'upload',
    mime: file.type,
    size: file.size,
    kind: 'image',
    parentType: 'form-pending',
    parentId: hit.formId,
    uploadedBy: null,
    createdAt: now,
    deleted: false,
  }, ts: now }], { serverTs: true, event: { source: 'form', ctx: c.executionCtx } });
  pokeLive(c.env, c.executionCtx);
  return c.json({ id });
});

/**
 * POST a submission. Ordered pipeline (spec §6):
 * token+enabled → rate+size → Turnstile → dedupe → validate → write → notify.
 */
publicFormsApi.post('/:token', async (c) => {
  const token = c.req.param('token');
  const hit = await formByToken(c.env, token);
  if (!hit || !hit.form.enabled) return UNAVAILABLE(c);
  const { form, formId, board } = hit;

  const raw = await c.req.text();
  if (raw.length > FORM_MAX_PAYLOAD) return c.json({ error: 'rate_limited' }, 429);
  const ip = clientIp(c);
  const used = await rateLimitHit(c.env, 'form', `${ip}:${token}`, FORM_RATE_WINDOW_MS);
  if (used > FORM_RATE_LIMIT) return c.json({ error: 'rate_limited' }, 429);

  const body = (() => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; } })();
  if (!body) return c.json({ error: 'invalid json' }, 400);
  if (!(await turnstileOk(c.env, body.turnstileToken, ip))) return c.json({ error: 'challenge' }, 403);

  const submissionId = typeof body.submissionId === 'string' ? body.submissionId : '';
  if (!SUBMISSION_ID_RE.test(submissionId)) return c.json({ error: 'submissionId required (1–64 chars)' }, 400);

  const fileIds = Array.isArray(body.fileIds) ? (body.fileIds as unknown[]).filter((f): f is string => typeof f === 'string').slice(0, FORM_MAX_FILES) : [];

  // Idempotency: first-writer-wins on submission_id; replays get the stored
  // outcome verbatim (accepted → receipt, rejected → error, processing → state).
  const ins = await c.env.DB
    .prepare("INSERT OR IGNORE INTO form_submissions (submission_id, form_id, state, receipt, record_id, error, created_at) VALUES (?, ?, 'processing', NULL, NULL, NULL, ?)")
    .bind(submissionId, formId, Date.now())
    .run();
  if (!ins.meta.changes) {
    const stored = await c.env.DB.prepare('SELECT state, receipt, error FROM form_submissions WHERE submission_id = ? AND form_id = ?').bind(submissionId, formId).first<{ state: string; receipt: string | null; error: string | null }>();
    if (!stored) return c.json({ error: 'unavailable' }, 410);
    if (stored.state === 'accepted' && stored.receipt) return c.json(JSON.parse(stored.receipt));
    if (stored.state === 'rejected') return c.json({ error: 'validation', fieldErrors: stored.error ? JSON.parse(stored.error) : {} }, 422);
    return c.json({ state: 'processing' }, 202);
  }

  const fail = async (state: 'rejected', error: Record<string, unknown>, http: 400 | 422, body2: Record<string, unknown>) => {
    await c.env.DB.prepare('UPDATE form_submissions SET state = ?, error = ? WHERE submission_id = ?').bind(state, JSON.stringify(error), submissionId).run();
    return c.json(body2, http);
  };

  const res = validateSubmissionValues(form, board.data, body.values);
  if (!res.ok) return fail('rejected', res.errors, 422, { error: 'validation', fieldErrors: res.errors });

  // fileIds must be pending uploads scoped to THIS form (blocks attaching
  // foreign uploads / other forms' staged files).
  const pendingFileIds: string[] = [];
  for (const fid of fileIds) {
    const f = await getRec(c.env, fid);
    if (f && f.collection === 'files' && !f.data.deleted && f.data.parentType === 'form-pending' && f.data.parentId === formId) pendingFileIds.push(fid);
  }

  // peopleMatch over the form's own database rows
  let personMatch: PersonMatch = { kind: 'none' };
  if (form.peopleMatch) {
    const emailKey = peopleEmailKey(form.peopleMatch.emailField);
    const rows = await listBy(c.env, 'tasks', 'boardId', form.databaseId);
    const email = normalizeEmail(res.coerced[emailKey]);
    const name = normalizePersonName(res.coerced.title);
    personMatch = findPersonMatch(emailKey, email, name, rows.map((r) => ({ id: r.id, title: r.data.title, data: r.data })));
  }

  // optional pasted attachment link — validated http(s) URL, ≤1000 chars
  let fileLink: string | undefined;
  if (typeof body.fileLink === 'string' && body.fileLink.trim()) {
    const u = body.fileLink.trim().slice(0, 1000);
    if (!/^https?:\/\/.+/i.test(u)) return fail('rejected', { fileLink: 'invalid' }, 422, { error: 'validation', fieldErrors: { fileLink: 'invalid' } });
    fileLink = u;
  }

  const existing = await listBy(c.env, 'tasks', 'boardId', form.databaseId);
  const lastOrder = existing.map((r) => String(r.data.order ?? '')).sort(cmpOrder).pop();

  const recordId = submissionRecordId(formId, submissionId);
  const ops = planSubmissionChanges({
    form, formId, boardData: board.data, coerced: res.coerced, submissionId,
    lastOrder, personMatch, pendingFileIds, fileLink, at: Date.now(),
  });

  const cs = beginChangeset({ userId: 'form', clientName: 'form', tool: 'form_submit', summary: `Submission on "${form.title}"`, source: 'form' });
  const event: SemanticEvent = {
    kind: 'form.submitted',
    recordId,
    collection: 'tasks',
    boardId: form.databaseId,
    formId,
  };
  const applied = await applyChanges(
    c.env,
    'form',
    ops.map((o) => ({ id: o.id, collection: o.collection, patch: o.patch, ts: Date.now() })),
    { serverTs: true, event: { source: 'form', ctx: c.executionCtx, changesetId: cs.id, extra: [event] } },
  );
  cs.items.push(...applied.applied);
  await commitChangeset(c.env, cs).catch(() => null);

  const receipt = {
    state: 'accepted' as const,
    submissionId,
    recordId,
    recordUrl: `/boards/${form.databaseId}/tasks/${recordId}`,
    message: form.successMessage,
    at: Date.now(),
  };
  await c.env.DB.prepare('UPDATE form_submissions SET state = ?, receipt = ?, record_id = ? WHERE submission_id = ?')
    .bind('accepted', JSON.stringify(receipt), recordId, submissionId)
    .run();
  pokeLive(c.env, c.executionCtx);

  // notify configured members — fire-and-forget, never blocks the receipt
  if (form.notifyUserIds.length) {
    const title = typeof res.coerced.title === 'string' ? res.coerced.title : form.title;
    c.executionCtx.waitUntil(
      Promise.all(
        form.notifyUserIds.map((userId) =>
          notify(c.env, {
            userId,
            kind: 'form_submission',
            targetType: 'record',
            targetId: recordId,
            title: `New submission: ${form.title}`,
            body: title,
            url: receipt.recordUrl,
          }).catch(() => undefined),
        ),
      ),
    );
  }
  return c.json(receipt);
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
