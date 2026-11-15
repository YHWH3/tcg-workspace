import { Hono } from 'hono';
import { channelsFor, NOTIF_KINDS, parsePrefs, type Env, type NotifKind } from './auth';
import { deliveryMode, notificationEmailOrigin, requestEmail, type EmailEnv } from './email';
import { hasD1Budget } from './d1budget';
import { retryDelay } from './execution';
import { sha256Hex } from './password';
import { getRec } from './records';
import { collectAttention } from './attention';
import { buildEmailDigest } from '../shared/emailDigest';
import { createReadGate, withReadGate, type ReadDecision } from './readAccess';
import { levelSql } from './capability';

const day = 86_400_000;
type DeliveryEnv = {DB: D1Database} & EmailEnv;
type Outbox = {
  id: string; user_id: string; kind: NotifKind | 'digest'; target_id: string | null; verified_at: number; digest_key: string | null;
  created_at: number; attempts: number; payload_hash: string | null;
};
type Unsubscribe = { id: string; kind: NotifKind | 'digest'; exp: number; verifiedAt: number };
const captions: Record<NotifKind, string> = {
  mention: 'You were mentioned', assigned: 'You have a new assignment',
  comment_on_mine: 'Someone commented on your record', comment_resolved: 'A comment was resolved',
  due_soon: 'An item is due soon', overdue: 'An item is overdue',
  approval_requested: 'An approval needs you', approval_decided: 'An approval was decided',
  form_submission: 'A form was submitted', automation: 'You have an automation notice',
};
const generic = 'You have a new notification in TCG Workspace';

const escaped: Record<string, string> = {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'};
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => escaped[char]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64 = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
const encoder = new TextEncoder();
const signingKey = (secret: string) => crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']);

async function unsubscribeToken(secret: string, request: Unsubscribe) {
  const encoded = b64(encoder.encode(JSON.stringify(request)));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode('email-unsubscribe:' + encoded));
  return encoded + '.' + b64(new Uint8Array(signature));
}

async function verifyUnsubscribe(secret: string, token: string): Promise<Unsubscribe | null> {
  if (!/^[\w-]{1,512}\.[\w-]{43}$/.test(token)) return null;
  const [encoded, signature] = token.split('.');
  if (!await crypto.subtle.verify('HMAC', await signingKey(secret), unb64(signature), encoder.encode('email-unsubscribe:' + encoded))) return null;
  const request = JSON.parse(new TextDecoder().decode(unb64(encoded))) as Unsubscribe;
  return request.exp > Date.now() && (request.kind === 'digest' || NOTIF_KINDS.includes(request.kind)) ? request : null;
}

export function renderNotificationEmail(line: string, inbox: string, unsubscribe: string) {
  return {
    subject: 'TCG Workspace notification',
    text: `${line}\n\nOpen your Inbox: ${inbox}\nStop these emails: ${unsubscribe}`,
    html: `<p>${escapeHtml(line).replace(/\n/g,'<br>')}</p><p><a href="${escapeHtml(inbox)}">Open your Inbox</a></p><p><a href="${escapeHtml(unsubscribe)}">Unsubscribe from these emails</a></p>`,
    headers: { 'List-Unsubscribe': `<${unsubscribe}>` },
  };
}

/** Atomic lease claim and bounded recovery. No stored recipient, title or body copies. */
export async function sendNotificationEmails(env: DeliveryEnv, onlyId?: string) {
  const mode = deliveryMode(env);
  const origin = notificationEmailOrigin(env);
  if (!mode || !origin || !hasD1Budget(env.DB, 12)) return;
  const db = env.DB;
  const limit = onlyId ? 1 : 10;
  for (let i = 0; i < limit && hasD1Budget(db, 12); i++) {
    const now = Date.now();
    const lease = crypto.randomUUID();
    const row = await db.prepare(`
      UPDATE email_outbox SET lease_id=?,lease_until=?
      WHERE id=(SELECT id FROM email_outbox WHERE sent_at IS NULL AND terminal_at IS NULL
        AND (digest_key IS NULL OR ?=1) AND next_attempt_at<=? AND COALESCE(lease_until,0)<=? AND (? IS NULL OR id=?)
        ORDER BY next_attempt_at, created_at, id LIMIT 1)
      RETURNING id,user_id,kind,target_id,verified_at,created_at,attempts,payload_hash,digest_key`
    ).bind(lease, now + 30_000, hasD1Budget(db,28)?1:0, now, now, onlyId ?? null, onlyId ?? null).first<Outbox>();
    if (!row) return;
    const finish = (error: string, retry = false) => db.prepare(`
      UPDATE email_outbox SET last_error=?,next_attempt_at=?,terminal_at=?,lease_id=NULL,lease_until=NULL
      WHERE id=? AND lease_id=?`
    ).bind(error, Date.now() + retryDelay(row.attempts + 1), retry ? null : Date.now(), row.id, lease).run();
    if (row.attempts >= 8 || (row.attempts > 0 && now - row.created_at >= day - 60_000)) {
      await finish('delivery_requires_review');
      continue;
    }
    const user = await db.prepare(`
      SELECT email,prefs,(SELECT email_show_titles FROM workspace_settings WHERE id='workspace') AS show_titles
      FROM users WHERE id=? AND email_verified_at=? AND email IS NOT NULL AND disabled_at IS NULL`
    ).bind(row.user_id, row.verified_at).first<{email: string; prefs: string | null; show_titles: number}>();
    const prefs = parsePrefs(user?.prefs);
    const eligible = row.kind === 'digest'
      ? row.digest_key?.startsWith('t:') || prefs.emailDigest === 'daily' && row.digest_key?.startsWith('d:')
        || prefs.emailDigest === 'weekly' && row.digest_key?.startsWith('w:')
      : channelsFor(prefs, row.kind).has('email');
    if (!user || !eligible) {
      await finish('recipient_unavailable');
      continue;
    }
    let line = row.kind === 'digest' ? 'TCG Workspace digest' : captions[row.kind] ?? generic;
    let title: string | undefined;
    let titleRevisions: [string, number][] = [];
    let titleSpaces: readonly string[] = [];
    let permissionMode = 0;
    let digestSources: ReadDecision | undefined;
    let digestSections: ReturnType<typeof buildEmailDigest> | undefined;
    let includeTitles = false;
    if (row.kind === 'digest') {
      let attention;
      try {
        attention = await collectAttention(env as Env, row.user_id, {}, Date.now(), {
          includeWebsiteNew: true, observe: decision => { digestSources = decision; },
        });
      } catch (error) {
        if (error instanceof Error && ['access_reset_required','unauthenticated'].includes(error.message)) {
          await finish('digest_access_changed', true);
          continue;
        }
        throw error;
      }
      if (attention.partialSources.includes('processing_budget') || attention.partialSources.includes('authorization_budget')) {
        await finish('digest_budget',true);
        continue;
      }
      const sections = buildEmailDigest(attention.items, attention.today);
      if (!sections.length && !attention.nextCursor && !attention.partial && !row.digest_key?.startsWith('t:')) {
        await finish('digest_empty');
        continue;
      }
      digestSections = sections;
      includeTitles = user.show_titles === 1 && !!digestSources;
      if (digestSources) {
        permissionMode = digestSources!.enabled ? 1 : 0;
        titleRevisions = [...(digestSources!.graphRevs ?? digestSources!.revs)];
        titleSpaces = [...new Set([...digestSources!.scopes.values()].flatMap(scope => [...scope.readSpaceIds]))];
      }
      const lines = sections.map(({heading,items}) => [
        `${heading} (${items.length})`,
        ...items.map(item => `${includeTitles ? item.title : 'Open item'}\n${origin}${item.url}`),
      ].join('\n'));
      line = lines.length ? lines.join('\n') : 'There is nothing in your digest right now.';
      if (attention.partial || attention.nextCursor) line += '\nOpen Workspace to see all current items.';
    } else if (row.target_id) {
      const record = await getRec(withReadGate(env as Env, row.user_id), row.target_id);
      if (!record || record.data.deleted === true || record.data.archived === true) line = generic;
      else if (user.show_titles === 1) {
        const value = record.data.title ?? record.data.name;
        if (typeof value === 'string' && value) {
          const access = await createReadGate(db, row.user_id).decideEditable([row.target_id]);
          if (access.principalActive && access.readable.has(row.target_id) &&
            (!access.enabled || access.revs.get(row.target_id) === record.rev)) {
            title = value.slice(0, 240);
            titleRevisions = [...(access.graphRevs ?? new Map([[record.id, record.rev]]))];
            titleSpaces = access.scopes.get(row.target_id)?.readSpaceIds ?? [];
            permissionMode = access.enabled ? 1 : 0;
          } else line = generic;
        }
      }
    }
    const token = await unsubscribeToken(env.EMAIL_LINK_KEY!, { id: row.user_id, kind: row.kind, exp: row.created_at + 30 * day, verifiedAt: row.verified_at });
    const message = renderNotificationEmail(title ? `${line}: ${title}` : line, origin + '/inbox', origin + '/api/email/unsubscribe?t=' + token);
    if (row.kind === 'digest') {
      message.subject = 'TCG Workspace digest';
      message.html = (digestSections ?? []).map(section => `<h2>${escapeHtml(section.heading)}</h2><ul>${
        section.items.map(item => `<li><a href="${escapeHtml(origin + item.url)}">${escapeHtml(includeTitles ? item.title : 'Open item')}</a></li>`).join('')
      }</ul>`).join('') + message.html;
    }
    const body = JSON.stringify({ ...message, to: [user.email], from: env.EMAIL_FROM });
    const hash = await sha256Hex(body);
    if (row.payload_hash && row.payload_hash !== hash) {
      await finish('delivery_payload_changed');
      continue;
    }
    const fencedContent = !!title || !!digestSources;
    const titleFence = fencedContent ? `
      ${title || includeTitles ? "AND (SELECT email_show_titles FROM workspace_settings WHERE id='workspace')=1" : ''}
      AND (SELECT enabled FROM access_state WHERE id=1)=?
      AND NOT EXISTS(SELECT 1 FROM json_each(?) entry WHERE NOT EXISTS(
        SELECT 1 FROM records WHERE id=json_extract(entry.value,'$[0]') AND seq=json_extract(entry.value,'$[1]')))
      AND NOT EXISTS(SELECT 1 FROM json_each(?) space WHERE ${levelSql('?', 'space.value')}<1)` : '';
    const attempt = await db.prepare(`
      UPDATE email_outbox SET payload_hash=?,attempts=attempts+1
      WHERE id=? AND lease_id=? AND lease_until>? AND EXISTS(
        SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL AND email_verified_at=? AND email=? AND prefs IS ?)
        ${titleFence}`
    ).bind(hash,row.id,lease,Date.now(),row.user_id,row.verified_at,user.email,user.prefs,
      ...(fencedContent ? [permissionMode,JSON.stringify(titleRevisions),JSON.stringify(permissionMode ? titleSpaces : []),row.user_id] : [])
    ).run();
    if (!attempt.meta.changes) {
      await finish('recipient_changed', true);
      continue;
    }
    let status: number | undefined;
    let providerId: string | null = null;
    try {
      const response = await requestEmail(env, mode, row.id, body);
      status = response.status;
      if (response.ok && response.body) {
        const receipt = await response.json<{id?: unknown}>();
        if (typeof receipt.id === 'string' && /^[\w-]{1,128}$/.test(receipt.id)) providerId = receipt.id;
      } else await response.body?.cancel();
    } catch {
      // Retry the same provider request inside its idempotency window.
    }
    if (status !== undefined && status >= 200 && status < 300) {
      await db.prepare(`UPDATE email_outbox SET sent_at=?,provider_id=?,last_error=NULL,lease_id=NULL,lease_until=NULL
        WHERE id=? AND lease_id=?`).bind(Date.now(),providerId,row.id,lease).run();
    } else {
      const retry = row.attempts + 1 < 8 && (status === undefined || status === 409 || status === 429 || status >= 500);
      await finish(status === undefined ? 'provider_unconfirmed' : 'provider_' + status, retry);
    }
  }
}

export const unsubscribeApi = new Hono<{Bindings: Env}>();
unsubscribeApi.on(['GET','POST'], '/unsubscribe', async c => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  const token = c.req.query('t') ?? '';
  const request = c.env.EMAIL_LINK_KEY ? await verifyUnsubscribe(c.env.EMAIL_LINK_KEY, token) : null;
  if (!request) return c.text('This unsubscribe link is invalid or expired.', 400);
  if (c.req.method === 'GET') return c.html(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title><main><h1>Unsubscribe from these emails?</h1><form method="post" action="?t=${token}"><button>Unsubscribe</button></form></main></html>`);
  if (request.kind === 'digest') {
    await c.env.DB.prepare("UPDATE users SET prefs=json_set(COALESCE(prefs,'{}'),'$.emailDigest','off') WHERE id=? AND email_verified_at=?").bind(request.id,request.verifiedAt).run();
  } else {
    await c.env.DB.prepare(`UPDATE users SET prefs=json_set(prefs,?,json(CASE WHEN EXISTS(
      SELECT 1 FROM json_each(prefs,?) WHERE value='push') THEN '["inbox","push"]' ELSE '"inbox"' END))
      WHERE id=? AND email_verified_at=? AND EXISTS(SELECT 1 FROM json_each(prefs,?) WHERE value='email')`)
      .bind('$.notifications.'+request.kind,'$.notifications.'+request.kind,request.id,request.verifiedAt,'$.notifications.'+request.kind).run();
  }
  return c.text('You have unsubscribed from these emails.');
});
