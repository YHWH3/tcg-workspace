// Signed server-to-server inbox for The Common Ground website's form relay.
//
// The relay POSTs one JSON event per form submission or patron event, signed
// with a shared secret (the public forms API needs a Turnstile token, so it
// cannot serve a server caller). Each accepted event becomes or updates a
// record in the seeded "Website inbox" database and notifies admins.
//
//   X-TCG-Timestamp: <unix seconds>            (±300 s)
//   X-TCG-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
//
// 503 not configured · 413 over 64 KB · 401 bad/expired signature ·
// 400 body fails the schema · 409 same id with a different body ·
// 503 {retryable:true} when the write did not land. The same id with the same
// body (any timestamp) returns the first result.
//
// `website_ingest` is a server-only D1 table (never a synced collection).

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from './auth';
import { applyChanges, pokeLive } from './sync';
import { getRec } from './records';
import { notify } from './notifications';
import { sha256Hex } from './password';
import { boundedRequestBody } from './forms';
import { stableJson } from '../shared/stablejson';
import { fnv1a64hex } from '../shared/linkid';
import { orderBetween } from '../shared/order';
import { markdownBlockPatch, markdownToBlocks, type MdBlock } from '../shared/markdown';
import {
  PATRON_TIERS,
  WEBSITE_EVENTS,
  WEBSITE_INBOX_BOARD,
  WEBSITE_INBOX_ID,
  WI_FIELD,
  websiteEventLabel,
  type WebsiteEvent,
} from '../shared/websiteInbox';

export const INGEST_MAX_BYTES = 64 * 1024;
export const INGEST_MAX_SKEW_S = 300;
const ANSWER_VALUE_CAP = 5000;
const ANSWERS_CAP = 40;

/* ------------------------------------------------------------------ */
/* Body schema                                                         */
/* ------------------------------------------------------------------ */

const optText = (max: number) => z.string().max(max).nullish();
const idLike = (max: number) => z.union([z.string().max(max), z.number().int().nonnegative()]).nullish().transform((v) => (v == null ? v : String(v)));

export const IngestBody = z
  .object({
    id: z.string().min(1).max(64),
    event: z.enum(WEBSITE_EVENTS),
    occurred_at: z.iso.datetime({ offset: true }),
    form_id: optText(64),
    subject: optText(300),
    page: optText(2000),
    reply_to: optText(320),
    answers: z
      .array(z.object({ name: z.string().max(100), label: z.string().max(300), value: z.string().max(ANSWER_VALUE_CAP) }))
      .max(ANSWERS_CAP)
      .default([]),
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
/* Planning (pure)                                                     */
/* ------------------------------------------------------------------ */

interface WriteOp {
  id: string;
  collection: string;
  patch: Record<string, unknown>;
}

export interface WebsitePlan {
  recordId: string;
  title: string;
  action: 'created' | 'updated';
  ops: WriteOp[];
  createOnly: Set<string>;
}

/** Patron events share one record per application; each form submission is its own. */
export function websiteRecordId(body: IngestBody): string {
  return body.patron ? `web_${fnv1a64hex('patron|' + body.patron.application_id)}` : `web_${fnv1a64hex('form|' + body.id)}`;
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
    const value = neutralize(a.value.trim()) || '—';
    out.push(...markdownToBlocks(`### ${label}\n\n${value}`).map(safeBlock));
  }
  return out;
}

export function personName(answers: IngestBody['answers']): string {
  const exact = answers.find((a) => /^(full[ _-]?)?name$/i.test(a.name.trim()) || /^(full[ _-]?)?name$/i.test(a.label.trim()));
  const loose = exact ?? answers.find((a) => /\bname\b/i.test(a.label) && !/(organi[sz]ation|company|business|project|user)/i.test(a.label));
  return oneLine(loose?.value ?? '').slice(0, 120);
}

export function websiteTitle(body: IngestBody): string {
  const subject = oneLine(body.subject ?? '');
  const name = personName(body.answers);
  const title = subject && name ? `${subject} — ${name}` : subject || name || (body.patron ? placeholderTitle(body) : `Website: ${body.form_id ?? 'form'}`);
  return neutralize(title).slice(0, 300);
}

function placeholderTitle(body: IngestBody): string {
  return `Patron application ${body.patron?.application_id ?? ''}`.trim();
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
  return neutralize(oneLine(parts.join(' · ')));
}

function httpUrl(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Field values this event may set. Empty inputs never blank a stored value. */
function eventFields(body: IngestBody, occurredMs: number, existing: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const prevAt = typeof existing?.websiteEventAt === 'number' ? existing.websiteEventAt : -Infinity;
  // Out-of-order delivery must not roll Event back (minted, then a late applied).
  if (occurredMs >= prevAt) {
    out[`p_${WI_FIELD.event}`] = body.event;
    out.websiteEventAt = occurredMs;
  }
  const p = body.patron;
  if (p) {
    out[`p_${WI_FIELD.application}`] = p.application_id;
    if (p.tier && (PATRON_TIERS as readonly string[]).includes(p.tier)) out[`p_${WI_FIELD.tier}`] = p.tier;
    if (p.edition) out[`p_${WI_FIELD.edition}`] = p.edition;
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

/**
 * Everything one event writes. form.submitted / patron.applied create the
 * record (createOnly — a relay retry never overwrites the team's edits); later
 * patron events patch only the event fields and append one body line. A patron
 * event that arrives before its record exists creates it, and a late
 * patron.applied then fills in the answers.
 */
export function planWebsiteRecord(
  body: IngestBody,
  ctx: { existing: Record<string, unknown> | null; lastOrder: string | undefined; lastBlockOrder: string | undefined; now: number },
): WebsitePlan {
  const recordId = websiteRecordId(body);
  const occurredMs = Date.parse(body.occurred_at);
  const fields = eventFields(body, occurredMs, ctx.existing);
  const createOnly = new Set<string>();
  const answerBlocks = body.event === 'form.submitted' || body.event === 'patron.applied' ? answersMarkdownBlocks(body.answers) : [];
  const lineBlocks: MdBlock[] = [{ type: 'p', text: eventLine(body) }];

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
      ...fields,
    };
    // Created ahead of its patron.applied: the late applied may replace this title.
    if (body.patron && body.event !== 'patron.applied') patch.websiteAutoTitle = title;
    const source = body.form_id ?? (body.patron ? 'patron' : undefined);
    if (source) patch[`p_${WI_FIELD.source}`] = neutralize(source);
    if (body.reply_to) patch[`p_${WI_FIELD.email}`] = neutralize(body.reply_to.trim());
    const page = httpUrl(body.page);
    if (page) patch[`p_${WI_FIELD.page}`] = page;
    const blocks = blockOps(recordId, body.id, [...answerBlocks, ...lineBlocks], undefined);
    createOnly.add(recordId);
    for (const b of blocks) createOnly.add(b.id);
    return { recordId, title, action: 'created', ops: [{ id: recordId, collection: 'tasks', patch }, ...blocks], createOnly };
  }

  const patch: Record<string, unknown> = { ...fields };
  const currentTitle = typeof ctx.existing.title === 'string' ? ctx.existing.title : '';
  let title = currentTitle;
  // A placeholder title from an out-of-order event gives way to the real one,
  // unless the team has renamed the record since.
  if (body.event === 'patron.applied' && currentTitle && currentTitle === ctx.existing.websiteAutoTitle) {
    title = websiteTitle(body);
    patch.title = title;
    if (body.reply_to && !ctx.existing[`p_${WI_FIELD.email}`]) patch[`p_${WI_FIELD.email}`] = neutralize(body.reply_to.trim());
  }
  const blocks = blockOps(recordId, body.id, [...answerBlocks, ...lineBlocks], ctx.lastBlockOrder);
  for (const b of blocks) createOnly.add(b.id);
  return { recordId, title: title || placeholderTitle(body), action: 'updated', ops: [{ id: recordId, collection: 'tasks', patch }, ...blocks], createOnly };
}

/* ------------------------------------------------------------------ */
/* Ingest                                                              */
/* ------------------------------------------------------------------ */

type Ctx = { waitUntil(p: Promise<unknown>): void };
export type IngestOutcome = { status: 200 | 409 | 503; body: Record<string, unknown> };

const retryable = (error: string): IngestOutcome => ({ status: 503, body: { ok: false, error, retryable: true } });

/** The board exists before its first record. ts=1 without serverTs converges
 *  with the client seed; a board the team deleted is not resurrected. */
async function ensureInbox(env: Env, now: number): Promise<boolean> {
  if (await getRec(env, WEBSITE_INBOX_ID)) return true;
  const res = await applyChanges(env, 'website', [{ id: WEBSITE_INBOX_ID, collection: 'boards', patch: { ...WEBSITE_INBOX_BOARD, createdAt: now }, ts: 1 }]);
  return !res.partialError && !res.rejected;
}

async function notifyAdmins(env: Env, body: IngestBody, plan: WebsitePlan): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM users WHERE COALESCE(workspace_role,role) IN ('owner','admin') AND disabled_at IS NULL",
  ).all<{ id: string }>();
  for (const admin of results) {
    await notify(env, {
      userId: admin.id,
      kind: 'form_submission',
      targetType: 'task',
      targetId: plan.recordId,
      title: `Website: ${plan.title}`.slice(0, 300),
      body: websiteEventLabel(body.event as WebsiteEvent),
      url: `/tasks/${plan.recordId}`,
      groupKey: 'website-inbox',
      dedupeKey: `website:${body.id}`,
    });
  }
}

export async function ingestWebsiteEvent(env: Env, body: IngestBody, ctx: Ctx): Promise<IngestOutcome> {
  const now = Date.now();
  const bodyHash = await sha256Hex(stableJson(body));
  await env.DB.prepare("INSERT OR IGNORE INTO website_ingest(event_id,body_hash,event,state,created_at) VALUES(?,?,?,'pending',?)")
    .bind(body.id, bodyHash, body.event, now)
    .run();
  const row = await env.DB.prepare('SELECT body_hash,state,result FROM website_ingest WHERE event_id=?').bind(body.id).first<{ body_hash: string; state: string; result: string | null }>();
  if (!row) return retryable('ingest_unavailable');
  if (row.body_hash !== bodyHash) return { status: 409, body: { ok: false, error: 'ingest_conflict' } };
  if (row.state === 'accepted' && row.result) return { status: 200, body: JSON.parse(row.result) as Record<string, unknown> };

  if (!(await ensureInbox(env, now))) return retryable('write_failed');
  const recordId = websiteRecordId(body);
  const existing = await getRec(env, recordId);
  const lastOrder = (await env.DB.prepare(
    "SELECT json_extract(data,'$.order') AS value FROM records WHERE collection='tasks' AND json_extract(data,'$.boardId')=? AND COALESCE(json_extract(data,'$.deleted'),0)!=1 ORDER BY json_extract(data,'$.order') DESC LIMIT 1",
  ).bind(WEBSITE_INBOX_ID).first<{ value: string | null }>())?.value ?? undefined;
  const lastBlockOrder = existing
    ? (await env.DB.prepare(
        "SELECT json_extract(data,'$.order') AS value FROM records WHERE collection='blocks' AND json_extract(data,'$.pageId')=? ORDER BY json_extract(data,'$.order') DESC LIMIT 1",
      ).bind(recordId).first<{ value: string | null }>())?.value ?? undefined
    : undefined;
  // A retry of the event that created the record re-plans the same create.
  const createdByThis = existing?.data.websiteSourceEvent === body.id;
  const plan = planWebsiteRecord(body, { existing: existing && !createdByThis ? existing.data : null, lastOrder, lastBlockOrder, now });

  const written = await applyChanges(env, 'website', plan.ops.map((o) => ({ ...o, ts: now })), {
    serverTs: true,
    createOnly: plan.createOnly,
    event: { source: 'website', ctx },
  });
  if (written.partialError || written.rejected || written.conflict || written.conflicts?.length) return retryable('write_failed');
  pokeLive(env, ctx);
  await notifyAdmins(env, body, plan);

  const result = { ok: true, id: body.id, recordId: plan.recordId, action: plan.action };
  await env.DB.prepare("UPDATE website_ingest SET state='accepted',record_id=?,result=?,updated_at=? WHERE event_id=?")
    .bind(plan.recordId, JSON.stringify(result), Date.now(), body.id)
    .run();
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
