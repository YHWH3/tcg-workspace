// Signed server-to-server inbox for The Common Ground website's form relay.
// Contract (both sides keep a copy): docs/integrations/the-common-ground.md.
//
// The relay POSTs one JSON event per form submission or patron event, signed
// with a shared secret (the public forms API needs a Turnstile token, so it
// cannot serve a server caller). Each accepted event becomes or updates a
// record in the seeded "Website inbox" database, links the sender to a People
// record, and notifies admins.
//
//   X-TCG-Timestamp: <unix seconds>            (±300 s)
//   X-TCG-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
//
// 503 not configured · 413 over 64 KB · 401 bad/expired signature ·
// 400 body fails the schema · 409 same id with a different body ·
// 503 {retryable:true} when the write did not land. The same id with the same
// body (any timestamp) returns the first result.
//
// Contract v2 adds `v` and a self-describing `form` block {id,title,family,
// fields}; typed fields and family views are built from it. v1 (no `v`, no
// `form`) still works: the family comes from the form id.
//
// Every request runs under the invocation D1 budget (worker/d1budget.ts): state
// is read in one batch, writes go through at most two applyChanges calls, and
// admin notifications ride the durable event outbox instead of one notify()
// per admin inside the request.
//
// `website_ingest` is a server-only D1 table (never a synced collection).

import {websiteAuthority,websiteGrantFence} from './websiteAuthority';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from './auth';
import { applyChanges, pokeLive, type ApplyResult } from './sync';
import { sha256Hex } from './password';
import { boundedRequestBody, EMAIL_RE, normalizeEmail } from './forms';
import { scheduleOutbox } from './events';
import type { NewNotification } from './notifications';
import { stableJson } from '../shared/stablejson';
import { fnv1a64hex, linkId } from '../shared/linkid';
import { orderBetween } from '../shared/order';
import { fieldsOf, type FieldDef } from '../shared/fields';
import type { ViewConfig } from '../shared/views';
import { markdownBlockPatch, markdownToBlocks, type MdBlock } from '../shared/markdown';
import {
  FAMILY_ID_RE,
  PATRON_TIERS,
  WEBSITE_BUILTIN_FIELDS,
  WEBSITE_EVENTS,
  WEBSITE_INBOX_BOARD,
  WEBSITE_INBOX_ID,
  WEBSITE_PEOPLE_BOARD,
  WEBSITE_PEOPLE_ID,
  WEBSITE_SITE_ORIGIN,
  WI_FIELD,
  familyForForm,
  familyName,
  familyView,
  familyViewId,
  mergeFieldDefs,
  optionIdFor,
  patronStageFor,
  splitChoices,
  typedFieldDef,
  typedFieldEligible,
  websiteEventLabel,
  websiteInboxViews,
  wiKey,
} from '../shared/websiteInbox';

export const INGEST_MAX_BYTES = 64 * 1024;
export const INGEST_MAX_SKEW_S = 300;
const ANSWER_VALUE_CAP = 5000;
const ANSWERS_CAP = 40;
const TEXT_FIELD_CAP = 2000;

/* ------------------------------------------------------------------ */
/* Body schema                                                         */
/* ------------------------------------------------------------------ */

const optText = (max: number) => z.string().max(max).nullish();
const idLike = (max: number) => z.union([z.string().max(max), z.number().int().nonnegative()]).nullish().transform((v) => (v == null ? v : String(v)));

const FormBlock = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(300).nullish(),
  family: z.string().regex(FAMILY_ID_RE),
  fields: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        label: z.string().max(300).default(''),
        // Unknown types are kept as text rather than refusing the whole event.
        type: z.string().max(20),
        required: z.boolean().optional(),
        options: z.array(z.string().max(200)).max(60).optional(),
      }),
    )
    .max(60),
});

export const IngestBody = z
  .object({
    // Contract version: absent or 1 (no form block) or 2. Anything else is a loud 400.
    v: z.union([z.literal(1), z.literal(2)]).optional(),
    id: z.string().min(1).max(64),
    event: z.enum(WEBSITE_EVENTS),
    occurred_at: z.iso.datetime({ offset: true }),
    form_id: optText(64),
    subject: optText(300),
    page: optText(2000),
    reply_to: optText(320),
    form: FormBlock.nullish(),
    answers: z
      .array(z.object({ name: z.string().max(100), label: z.string().max(300), value: z.string().max(ANSWER_VALUE_CAP) }))
      .max(ANSWERS_CAP)
      .default([]),
    truncated: z.boolean().optional(),
    patron: z
      .object({
        application_id: z.string().min(1).max(64),
        tier: optText(32),
        currency: optText(8),
        amount_display: optText(64),
        edition: idLike(16),
        tx: optText(128),
        token_id: idLike(78),
      })
      .optional(),
  })
  .superRefine((body, ctx) => {
    if (body.event.startsWith('patron.') && !body.patron) ctx.addIssue({ code: 'custom', path: ['patron'], message: 'patron events need patron' });
  });
export type IngestBody = z.infer<typeof IngestBody>;

/* ------------------------------------------------------------------ */
/* Authentication                                                      */
/* ------------------------------------------------------------------ */

export function ingestConfigured(env: Pick<Env, 'WEBSITE_INGEST_ENABLED' | 'WEBSITE_INGEST_SECRET'>): boolean {
  const flag = (env.WEBSITE_INGEST_ENABLED ?? '').trim().toLowerCase();
  return (flag === '1' || flag === 'true') && !!env.WEBSITE_INGEST_SECRET?.trim();
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Timestamp window + HMAC over the exact received bytes. crypto.subtle.verify
 *  compares in constant time (and runs in Workers and Node alike). */
export async function verifyIngestSignature(secret: string, timestamp: string | undefined, signature: string | undefined, raw: Uint8Array, nowMs: number): Promise<boolean> {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > INGEST_MAX_SKEW_S) return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(signature ?? '');
  if (!m) return false;
  const enc = new TextEncoder();
  const prefix = enc.encode(`${timestamp}.`);
  const message = new Uint8Array(prefix.length + raw.length);
  message.set(prefix, 0);
  message.set(raw, prefix.length);
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, hexBytes(m[1]!.toLowerCase()), message);
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

interface WriteOp {
  id: string;
  collection: string;
  patch: Record<string, unknown>;
}

/** Patron events share one record per application; each form submission is its own. */
export function websiteRecordId(body: IngestBody): string {
  return body.patron ? `web_${fnv1a64hex('patron|' + body.patron.application_id)}` : `web_${fnv1a64hex('form|' + body.id)}`;
}

export function websiteFamily(body: IngestBody): string {
  return body.form?.family ?? familyForForm(body.form_id ?? (body.patron ? 'patron' : null));
}

/** v2 sends the site path ("/patron/"); v1 may send a full URL. Only http(s) on the way out. */
export function websitePage(page: string | null | undefined): string | undefined {
  if (!page) return undefined;
  try {
    const u = new URL(page, WEBSITE_SITE_ORIGIN);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

const SAFE_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'quote', 'code', 'divider']);

/** Visitor text must never become a mention token or wiki link. */
export function neutralize(text: string): string {
  return text.replace(/@\[/g, '@⁠[').replace(/\[\[/g, '[⁠[');
}

/** Media/embed blocks would fetch or frame a visitor-chosen URL: keep the text only. */
function safeBlock(b: MdBlock): MdBlock {
  if (SAFE_BLOCKS.has(b.type)) return b;
  return { type: 'p', text: [b.text, b.caption, b.src, b.url].filter((s) => typeof s === 'string' && s).join(' ') };
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Each answer is parsed on its own so a stray fence can't swallow the next. */
export function answersMarkdownBlocks(answers: IngestBody['answers']): MdBlock[] {
  const out: MdBlock[] = [];
  for (const a of answers) {
    const label = neutralize(oneLine(a.label || a.name)) || 'Answer';
    const value = neutralize(a.value.trim()) || '(no answer)';
    out.push(...markdownToBlocks(`### ${label}\n\n${value}`).map(safeBlock));
  }
  return out;
}

export function personName(answers: IngestBody['answers']): string {
  const exact = answers.find((a) => /^(full[ _-]?)?name$/i.test(a.name.trim()) || /^(full[ _-]?)?name$/i.test(a.label.trim()));
  const loose = exact ?? answers.find((a) => /\bname\b/i.test(a.label) && !/(organi[sz]ation|company|business|project|user)/i.test(a.label));
  return oneLine(loose?.value ?? '').slice(0, 120);
}

/** "Subject · Name" (house rule: no em dashes). */
export function websiteTitle(body: IngestBody): string {
  const subject = oneLine(body.subject ?? body.form?.title ?? '');
  const name = personName(body.answers);
  const title = subject && name ? `${subject} · ${name}` : subject || name || (body.patron ? 'Patron application' : `Website: ${body.form_id ?? 'form'}`);
  return neutralize(title).slice(0, 300);
}

/** One readable line per event, appended to the body. */
export function eventLine(body: IngestBody): string {
  const p = body.patron;
  const parts: string[] = [websiteEventLabel(body.event), body.occurred_at.slice(0, 10)];
  if (p?.tier) parts.push(p.tier[0]!.toUpperCase() + p.tier.slice(1));
  if (p?.amount_display) parts.push(p.currency ? `${p.amount_display} ${p.currency.toUpperCase()}` : p.amount_display);
  if (p?.edition) parts.push(`edition ${p.edition}`);
  if (p?.token_id) parts.push(`token ${p.token_id}`);
  if (p?.tx) parts.push(`tx ${p.tx}`);
  if (!p && body.page) parts.push(`from ${body.page}`);
  if (body.truncated) parts.push('answers shortened by the website to fit');
  return neutralize(oneLine(parts.join(' · ')));
}

/** Field defs this event needs: the built-ins plus typed fields from the form block,
 *  with any answer value not yet among a choice field's options. */
export function neededFields(body: IngestBody): FieldDef[] {
  const family = websiteFamily(body);
  const out: FieldDef[] = [...WEBSITE_BUILTIN_FIELDS];
  const famAt = out.findIndex((f) => f.id === WI_FIELD.family);
  const fam = out[famAt]!;
  if (!fam.options!.some((o) => o.id === family)) out[famAt] = { ...fam, options: [...fam.options!, { id: family, name: familyName(family), color: '#8a8a8a' }] };
  for (const spec of body.form?.fields ?? []) {
    if (!typedFieldEligible(spec)) continue;
    const def = typedFieldDef(family, spec);
    const answer = body.answers.find((a) => a.name === spec.name)?.value.trim();
    if (answer && def.options) {
      const known = def.options.map((o) => o.name);
      const picked = def.type === 'multi_select' ? splitChoices(answer, known) : [answer];
      for (const name of picked) if (name.length <= 200 && !def.options.some((o) => o.name.toLowerCase() === name.toLowerCase())) def.options.push({ id: optionIdFor(name), name, color: '#8a8a8a' });
    }
    out.push(def);
  }
  return out;
}

/** p_ values for the typed fields, resolved against the board's merged defs. */
export function typedValues(body: IngestBody, fields: FieldDef[]): Record<string, unknown> {
  const family = websiteFamily(body);
  const out: Record<string, unknown> = {};
  for (const spec of body.form?.fields ?? []) {
    if (!typedFieldEligible(spec)) continue;
    const def = fields.find((f) => f.id === typedFieldDef(family, spec).id);
    const answer = body.answers.find((a) => a.name === spec.name)?.value.trim();
    if (!def || !answer) continue;
    const byName = (name: string) => def.options?.find((o) => o.name.toLowerCase() === name.toLowerCase())?.id;
    if (def.type === 'select') {
      const id = byName(answer);
      if (id) out[wiKey(def.id)] = id;
    } else if (def.type === 'multi_select') {
      const ids = splitChoices(answer, (def.options ?? []).map((o) => o.name)).map(byName).filter((x): x is string => !!x);
      if (ids.length) out[wiKey(def.id)] = ids;
    } else if (def.type === 'url') {
      // Only an absolute http(s) link becomes a link; anything else stays in the body only.
      if (/^https?:\/\//i.test(answer) && websitePage(answer)) out[wiKey(def.id)] = websitePage(answer);
    } else {
      out[wiKey(def.id)] = neutralize(oneLine(answer)).slice(0, TEXT_FIELD_CAP);
    }
  }
  return out;
}

/** Field values this event may set. Empty inputs never blank a stored value;
 *  Event and Patron stage only move forward in time. */
function eventFields(body: IngestBody, occurredMs: number, existing: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const prevAt = typeof existing?.websiteEventAt === 'number' ? existing.websiteEventAt : -Infinity;
  if (occurredMs >= prevAt) {
    out[wiKey(WI_FIELD.event)] = body.event;
    const stage = patronStageFor(body.event);
    if (stage) out[wiKey(WI_FIELD.stage)] = stage;
    out.websiteEventAt = occurredMs;
  }
  const p = body.patron;
  if (p) {
    out[wiKey(WI_FIELD.application)] = p.application_id;
    if (p.tier && (PATRON_TIERS as readonly string[]).includes(p.tier)) out[wiKey(WI_FIELD.tier)] = p.tier;
    if (p.edition) out[wiKey(WI_FIELD.edition)] = p.edition;
    if (body.event === 'patron.paid' && p.amount_display) out[wiKey(WI_FIELD.paid)] = neutralize(p.currency ? `${p.amount_display} ${p.currency.toUpperCase()}` : p.amount_display);
    if (p.token_id) out[wiKey(WI_FIELD.token)] = p.token_id;
  }
  return out;
}

function blockOps(recordId: string, eventId: string, blocks: MdBlock[], after: string | undefined): WriteOp[] {
  let order = after;
  return blocks.map((b, i) => {
    order = orderBetween(order, undefined);
    return { id: `${recordId}_${fnv1a64hex(eventId + '|' + i)}`, collection: 'blocks', patch: { pageId: recordId, order, ...markdownBlockPatch(b), deleted: false } };
  });
}

export interface WebsitePlan {
  recordId: string;
  title: string;
  action: 'created' | 'updated';
  ops: WriteOp[];
  createOnly: Set<string>;
}

/**
 * Everything one event writes to its record. form.submitted / patron.applied
 * create the record (createOnly: a relay retry never overwrites the team's
 * edits); later patron events patch only the event fields and append one body
 * line. A patron event that arrives before its record exists creates it, and a
 * late patron.applied then fills in the answers and the real title.
 */
export function planWebsiteRecord(
  body: IngestBody,
  ctx: { existing: Record<string, unknown> | null; fields: FieldDef[]; lastOrder: string | undefined; lastBlockOrder: string | undefined; now: number },
): WebsitePlan {
  const recordId = websiteRecordId(body);
  const occurredMs = Date.parse(body.occurred_at);
  const fields = eventFields(body, occurredMs, ctx.existing);
  const typed = typedValues(body, ctx.fields);
  const createOnly = new Set<string>();
  const answerBlocks = body.event === 'form.submitted' || body.event === 'patron.applied' ? answersMarkdownBlocks(body.answers) : [];
  const lineBlocks: MdBlock[] = [{ type: 'p', text: eventLine(body) }];
  const family = websiteFamily(body);

  if (!ctx.existing) {
    const title = websiteTitle(body);
    const patch: Record<string, unknown> = {
      boardId: WEBSITE_INBOX_ID,
      title,
      status: 'new',
      order: orderBetween(ctx.lastOrder, undefined),
      parentId: null,
      createdBy: null,
      createdAt: ctx.now,
      deleted: false,
      websiteSourceEvent: body.id,
      [wiKey(WI_FIELD.family)]: family,
      [wiKey(WI_FIELD.received)]: body.occurred_at.slice(0, 10),
      ...typed,
      ...fields,
    };
    // Created ahead of its patron.applied: the late applied may replace this title.
    if (body.patron && body.event !== 'patron.applied') patch.websiteAutoTitle = title;
    const source = body.form_id ?? body.form?.id ?? (body.patron ? 'patron' : undefined);
    if (source) patch[wiKey(WI_FIELD.source)] = neutralize(source);
    if (body.reply_to) patch[wiKey(WI_FIELD.email)] = neutralize(body.reply_to.trim());
    const page = websitePage(body.page);
    if (page) patch[wiKey(WI_FIELD.page)] = page;
    const blocks = blockOps(recordId, body.id, [...answerBlocks, ...lineBlocks], undefined);
    createOnly.add(recordId);
    for (const b of blocks) createOnly.add(b.id);
    return { recordId, title, action: 'created', ops: [{ id: recordId, collection: 'tasks', patch }, ...blocks], createOnly };
  }

  const patch: Record<string, unknown> = { ...fields };
  const currentTitle = typeof ctx.existing.title === 'string' ? ctx.existing.title : '';
  let title = currentTitle;
  if (body.event === 'patron.applied') {
    Object.assign(patch, typed);
    // A placeholder title from an out-of-order event gives way to the real one,
    // unless the team has renamed the record since.
    if (currentTitle && currentTitle === ctx.existing.websiteAutoTitle) {
      title = websiteTitle(body);
      patch.title = title;
    }
    if (body.reply_to && !ctx.existing[wiKey(WI_FIELD.email)]) patch[wiKey(WI_FIELD.email)] = neutralize(body.reply_to.trim());
  }
  const blocks = blockOps(recordId, body.id, [...answerBlocks, ...lineBlocks], ctx.lastBlockOrder);
  for (const b of blocks) createOnly.add(b.id);
  return { recordId, title: title || 'Patron application', action: 'updated', ops: [{ id: recordId, collection: 'tasks', patch }, ...blocks], createOnly };
}

/* ------------------------------------------------------------------ */
/* People (the forms peopleMatch shape: same reservation table + ids)   */
/* ------------------------------------------------------------------ */

interface Row {
  id: string;
  collection: string;
  data: Record<string, unknown>;
  seq: number;
}

const parseRow = (r: { id: string; collection: string; data: string; seq: number } | null | undefined): Row | null => {
  if (!r) return null;
  try {
    return { id: r.id, collection: r.collection, data: JSON.parse(r.data) as Record<string, unknown>, seq: r.seq };
  } catch {
    return null;
  }
};

/** The text/url field named Email on a People database. */
export function peopleEmailField(board: Record<string, unknown>): FieldDef | undefined {
  return fieldsOf(board).find((f) => (f.type === 'text' || f.type === 'url') && /^e-?mail$/i.test(f.name.trim()));
}

/**
 * Which People database senders are matched against, in order: the one pinned
 * on the inbox (`peopleDatabaseId`), a team "People" database with an Email
 * field, else the built-in one this creates. The choice is pinned so a second
 * People board appearing later cannot split one person in two.
 */
export function choosePeopleDatabase(inbox: Record<string, unknown> | null, candidates: { id: string; data: Record<string, unknown> }[]): { id: string; create: boolean } {
  const pinned = typeof inbox?.peopleDatabaseId === 'string' ? candidates.find((c) => c.id === inbox.peopleDatabaseId) : undefined;
  if (pinned && peopleEmailField(pinned.data)) return { id: pinned.id, create: false };
  const usable = candidates.filter((c) => peopleEmailField(c.data)).sort((a, b) => Number(a.id === WEBSITE_PEOPLE_ID) - Number(b.id === WEBSITE_PEOPLE_ID) || a.id.localeCompare(b.id));
  if (usable[0]) return { id: usable[0].id, create: false };
  return { id: WEBSITE_PEOPLE_ID, create: true };
}

async function personRecordId(databaseId: string, emailKey: string, email: string): Promise<string> {
  return `person_${(await sha256Hex(databaseId + '|' + emailKey + '|' + email)).slice(0, 48)}`;
}

/* ------------------------------------------------------------------ */
/* Ingest                                                              */
/* ------------------------------------------------------------------ */

type Ctx = { waitUntil(p: Promise<unknown>): void };
export type IngestOutcome = { status: 200 | 409 | 503; body: Record<string, unknown> };

const retryable = (error: string): IngestOutcome => ({ status: 503, body: { ok: false, error, retryable: true } });
const failed = (r: ApplyResult) => !!(r.partialError || r.rejected || r.conflict || r.conflicts?.length);
const SELECT_ROW = 'SELECT id,collection,data,seq FROM records WHERE id=?';

export async function ingestWebsiteEvent(env: Env, body: IngestBody, ctx: Ctx): Promise<IngestOutcome> {
  const grant=await websiteAuthority(env);
  if(!grant)return retryable('ingest_authority_unavailable');
  const sponsor=grant.sponsor_id;
  const fences=[()=>websiteGrantFence(env,grant)];
  const now = Date.now();
  const bodyHash = await sha256Hex(stableJson(body));
  const recordId = websiteRecordId(body);
  const family = websiteFamily(body);
  const reserve = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO website_ingest(event_id,body_hash,event,state,created_at) VALUES(?,?,?,'pending',?)").bind(body.id, bodyHash, body.event, now),
    env.DB.prepare('SELECT body_hash,state,result FROM website_ingest WHERE event_id=?').bind(body.id),
  ]);
  const row = reserve[1]!.results[0] as { body_hash: string; state: string; result: string | null } | undefined;
  if (!row) return retryable('ingest_unavailable');
  if (row.body_hash !== bodyHash) return { status: 409, body: { ok: false, error: 'ingest_conflict' } };
  if (row.state === 'accepted' && row.result) {
    const result=JSON.parse(row.result) as Record<string,unknown>;
    const current=await env.DB.prepare("SELECT id FROM records WHERE id=? AND collection='tasks' AND json_extract(data,'$.boardId')=? AND space_id=? AND COALESCE(json_extract(data,'$.deleted'),0)=0").bind(result.recordId as string,grant.inbox_id,grant.space_id).first();
    if(!current)return retryable('receipt_destination_changed');
    if(result.personId){
      const person=await env.DB.prepare("SELECT id FROM records WHERE id=? AND collection='tasks' AND json_extract(data,'$.boardId')=? AND space_id=? AND COALESCE(json_extract(data,'$.deleted'),0)=0 AND COALESCE(json_extract(data,'$.archived'),0)=0").bind(result.personId as string,grant.people_id,grant.space_id).first();
      if(!person){delete result.personId;result.matchingStatus='unusable_identity';}
    }
    return {status:200,body:result};
  }

  // One read for everything the plan needs.
  const baseViews = websiteInboxViews();
  const viewIds = [...baseViews.map((v) => v.id), familyViewId(family)];
  const state = await env.DB.batch([
    env.DB.prepare(SELECT_ROW).bind(WEBSITE_INBOX_ID),
    env.DB.prepare(SELECT_ROW).bind(recordId),
    env.DB.prepare("SELECT json_extract(data,'$.order') AS value FROM records WHERE collection='tasks' AND json_extract(data,'$.boardId')=? AND COALESCE(json_extract(data,'$.deleted'),0)!=1 ORDER BY json_extract(data,'$.order') DESC LIMIT 1").bind(WEBSITE_INBOX_ID),
    env.DB.prepare("SELECT json_extract(data,'$.order') AS value FROM records WHERE collection='blocks' AND json_extract(data,'$.pageId')=? ORDER BY json_extract(data,'$.order') DESC LIMIT 1").bind(recordId),
    env.DB.prepare("SELECT id,collection,data,seq FROM records WHERE collection='boards' AND id=? AND COALESCE(json_extract(data,'$.deleted'),0)!=1 AND COALESCE(json_extract(data,'$.archived'),0)!=1 ORDER BY id LIMIT 20").bind(grant.people_id),
    env.DB.prepare("SELECT id,json_extract(data,'$.config') AS config FROM records WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(viewIds)),
    env.DB.prepare("SELECT id FROM users WHERE COALESCE(workspace_role,role) IN ('owner','admin') AND disabled_at IS NULL ORDER BY id"),
  ]);
  const one = (i: number) => parseRow(state[i]!.results[0] as never);
  const inbox = one(0);
  if (inbox && inbox.data.deleted === true) return retryable('website_inbox_deleted');
  const existingRow = one(1);
  const lastOrder = (state[2]!.results[0] as { value: string | null } | undefined)?.value ?? undefined;
  const lastBlockOrder = (state[3]!.results[0] as { value: string | null } | undefined)?.value ?? undefined;
  const peopleBoards = (state[4]!.results as never[]).map(parseRow).filter((r): r is Row => !!r);
  const views = new Map((state[5]!.results as { id: string; config: string | null }[]).map((v) => [v.id, v.config]));
  const admins = (state[6]!.results as { id: string }[]).map((r) => r.id);

  // Seeds converge with the client seed: ts=1 and no serverTs, so any real edit wins.
  const seeds: (WriteOp & { ts: number })[] = [];
  if (!inbox) seeds.push({ id: WEBSITE_INBOX_ID, collection: 'boards', patch: { ...WEBSITE_INBOX_BOARD, spaceId:grant.space_id, createdAt: now }, ts: 1 });
  for (const v of baseViews) if (!views.has(v.id)) seeds.push({ id: v.id, collection: 'views', patch: { ...v.data, createdAt: now }, ts: 1 });
  const famIndex = baseViews.filter((v) => v.id.startsWith('view-wi-fam-')).length;
  if (!views.has(familyViewId(family)) && !seeds.some((s) => s.id === familyViewId(family))) {
    seeds.push({ id: familyViewId(family), collection: 'views', patch: { ...familyView(family, famIndex).data, createdAt: now }, ts: 1 });
  }

  const email = normalizeEmail(body.reply_to);
  const people = EMAIL_RE.test(email) ? {id:grant.people_id,create:!peopleBoards.some(b=>b.id===grant.people_id)} : null;
  if(people?.create&&people.id!==WEBSITE_PEOPLE_ID)return retryable('people_destination_unavailable');
  if (people?.create) seeds.push({ id: WEBSITE_PEOPLE_ID, collection: 'boards', patch: { ...WEBSITE_PEOPLE_BOARD, spaceId:grant.space_id, createdAt: now }, ts: 1 });
  if (seeds.length) {
    const seeded = await applyChanges(env, sponsor, seeds,{fences,atomic:true});
    if (failed(seeded)) return retryable('write_failed');
  }

  // Board fields: append what this event needs; never replace team edits.
  const boardData = inbox?.data ?? (WEBSITE_INBOX_BOARD as Record<string, unknown>);
  const merged = mergeFieldDefs(fieldsOf(boardData), neededFields(body));
  const fields = merged ?? fieldsOf(boardData);
  const ops: WriteOp[] = [];
  const expect = new Map<string, number>();
  const boardPatch: Record<string, unknown> = {};
  if (merged) boardPatch.fields = merged;
  if (people && boardData.peopleDatabaseId !== people.id) boardPatch.peopleDatabaseId = people.id;
  if (Object.keys(boardPatch).length) {
    ops.push({ id: WEBSITE_INBOX_ID, collection: 'boards', patch: boardPatch });
    // A concurrent ingest appending other fields fails this fence and the relay retries.
    if (inbox) expect.set(WEBSITE_INBOX_ID, inbox.seq);
  }

  // The family view lists that family's typed fields.
  const typedKeys = (body.form?.fields ?? []).filter(typedFieldEligible).map((f) => wiKey(typedFieldDef(family, f).id));
  if (typedKeys.length) {
    let config: ViewConfig | undefined;
    try {
      const stored = views.get(familyViewId(family));
      config = stored ? (JSON.parse(stored) as ViewConfig) : undefined;
    } catch {
      config = undefined;
    }
    const base = config ?? familyView(family, famIndex).data.config;
    const missing = typedKeys.filter((k) => !((base.visible ?? []) as string[]).includes(k));
    if (missing.length) ops.push({ id: familyViewId(family), collection: 'views', patch: { config: { ...base, visible: [...(base.visible ?? []), ...missing] } } });
  }

  const plan = planWebsiteRecord(body, {
    // A retry of the event that created the record re-plans the same create.
    existing: existingRow && existingRow.data.websiteSourceEvent !== body.id ? existingRow.data : null,
    fields,
    lastOrder,
    lastBlockOrder,
    now,
  });
  ops.push(...plan.ops);
  const createOnly = new Set(plan.createOnly);

  // People: match by normalized email, reserve through the forms table, link.
  let personId: string | undefined;
  let matchingStatus = people ? 'created' : 'no_email';
  if (people) {
    const peopleBoard = people.create ? (WEBSITE_PEOPLE_BOARD as Record<string, unknown>) : peopleBoards.find((b) => b.id === people.id)!.data;
    const emailKey = wiKey(peopleEmailField(peopleBoard)!.id);
    const matched = await env.DB.prepare(
      "SELECT id FROM records WHERE collection='tasks' AND json_extract(data,'$.boardId')=? AND lower(trim(json_extract(data,?)))=? ORDER BY COALESCE(json_extract(data,'$.deleted'),0),COALESCE(json_extract(data,'$.archived'),0),id LIMIT 1",
    ).bind(people.id, `$.${emailKey}`, email).first<{ id: string }>();
    const candidate = matched?.id ?? (await personRecordId(people.id, emailKey, email));
    const reserved = await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO form_people_keys(database_id,field_key,email,record_id) VALUES(?,?,?,?)').bind(people.id, emailKey, email, candidate),
      env.DB.prepare(
        "SELECT k.record_id, r.id AS present, r.data AS person_data, EXISTS(SELECT 1 FROM website_ingest w WHERE w.state='accepted' AND json_extract(w.result,'$.personId')=k.record_id) AS previously_used FROM form_people_keys k LEFT JOIN records r ON r.id=k.record_id WHERE k.database_id=? AND k.field_key=? AND k.email=?",
      ).bind(people.id, emailKey, email),
    ]);
    const key = reserved[1]!.results[0] as { record_id: string; present: string | null; person_data:string|null; previously_used:number } | undefined;
    const storedPerson=key?.person_data?JSON.parse(key.person_data) as Record<string,unknown>:null;
    const unusable=storedPerson&&(storedPerson.deleted===true||storedPerson.archived===true||storedPerson.boardId!==people.id||normalizeEmail(storedPerson[emailKey])!==email)||!key?.present&&key?.previously_used;
    matchingStatus=unusable?'unusable_identity':key?.present?'matched':'created';
    personId = unusable?undefined:key?.record_id ?? candidate;
    if (personId && !key?.present) {
      const columns = Array.isArray(peopleBoard.columns) ? (peopleBoard.columns as { id: string }[]) : [];
      ops.push({
        id: personId,
        collection: 'tasks',
        patch: { boardId: people.id, title: neutralize(personName(body.answers) || email).slice(0, 200), status: columns[0]?.id ?? null, [emailKey]: email, parentId: null, createdBy: null, createdAt: now, deleted: false, order: orderBetween(undefined, undefined) },
      });
      createOnly.add(personId);
    }
    if(personId) {
    if(key?.present)fences.push(()=>env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM records WHERE id=? AND collection='tasks' AND space_id=? AND json_extract(data,'$.boardId')=? AND COALESCE(json_extract(data,'$.deleted'),0)=0 AND COALESCE(json_extract(data,'$.archived'),0)=0 AND lower(trim(json_extract(data,?)))=?) THEN 1 ELSE json_extract('{','$') END`).bind(personId!,grant.space_id,people.id,'$.'+emailKey,email));
    const link = linkId('related', '', plan.recordId, personId);
    ops.push({ id: link, collection: 'links', patch: { fromType: 'record', fromId: plan.recordId, toType: 'record', toId: personId, kind: 'related', fieldId: null, deleted: false, createdBy: null, createdAt: now } });
    createOnly.add(link);
    }
  }

  const written = await applyChanges(env, sponsor, ops.map((o) => ({ ...o, patch:{...o.patch,...(o.patch.createdBy===null?{createdBy:sponsor}:{})}, ts: now })), {
    serverTs: true,
    atomic: true,
    fences,
    createOnly,
    ...(expect.size ? { expect } : {}),
    event: { source: 'website', ctx },
  });
  if (failed(written)) return retryable('write_failed');
  pokeLive(env, ctx);

  // Admin notifications ride the durable outbox (processOutbox delivers them
  // through the notification kernel's fences), committed with the receipt.
  const notifications: NewNotification[] = admins.map((userId) => ({
    userId,
    kind: 'form_submission',
    targetType: 'task',
    targetId: plan.recordId,
    title: `Website: ${plan.title}`.slice(0, 300),
    body: `${websiteEventLabel(body.event)} · ${familyName(family)}`,
    url: `/tasks/${plan.recordId}`,
    groupKey: 'website-inbox',
    dedupeKey: `website:${body.id}`,
  }));
  const result = { ok: true, id: body.id, recordId: plan.recordId, action: plan.action, family, matchingStatus, ...(personId ? { personId } : {}) };
  const outboxId = `ev_web_${fnv1a64hex(body.id)}`;
  await env.DB.batch([
    websiteGrantFence(env,grant),
    env.DB.prepare('INSERT OR IGNORE INTO event_outbox(id,payload,created_at) VALUES(?,?,?)').bind(outboxId, JSON.stringify({ source: 'website', userId: sponsor, changesetId: null, applied: [], extra: [], notifications }), now),
    env.DB.prepare("UPDATE website_ingest SET state='accepted',record_id=?,result=?,updated_at=? WHERE event_id=?").bind(plan.recordId, JSON.stringify(result), Date.now(), body.id),
  ]);
  scheduleOutbox(env, ctx, [outboxId]);
  return { status: 200, body: result };
}

/* ------------------------------------------------------------------ */
/* Route (mounted /api/ingest/website — no session; signature-gated)    */
/* ------------------------------------------------------------------ */

export const websiteIngestApi = new Hono<{ Bindings: Env }>();

websiteIngestApi.post('/', async (c) => {
  if (!ingestConfigured(c.env)) return c.json({ ok: false, error: 'ingest_not_configured' }, 503);
  const raw = await boundedRequestBody(c.req.raw, INGEST_MAX_BYTES);
  if (!raw) return c.json({ ok: false, error: 'too_large' }, 413);
  const signed = await verifyIngestSignature(c.env.WEBSITE_INGEST_SECRET!, c.req.header('x-tcg-timestamp'), c.req.header('x-tcg-signature'), raw, Date.now());
  if (!signed) return c.json({ ok: false, error: 'unauthorized' }, 401);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400);
  }
  const parsed = IngestBody.safeParse(json);
  if (!parsed.success) {
    // Paths and codes only: never echo visitor values back.
    return c.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), code: i.code })) }, 400);
  }
  const outcome = await ingestWebsiteEvent(c.env, parsed.data, c.executionCtx);
  return c.json(outcome.body, outcome.status);
});
