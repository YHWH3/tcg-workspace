// Models list + streamed Responses API calls on the user's ChatGPT plan.
// Spec: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
//       https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
//       https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
// There is NO fallback billing path: every failure stops inference.
import {
  MANAGE_USAGE_HINT, OPENAI_MODELS_URL, OPENAI_RESPONSES_URL,
  UNSUPPORTED_RESPONSES_FIELDS, UNSUPPORTED_TOOL_TYPES,
} from './constants.mjs';
import { CompanionError, PlanUsageDisabled, ResponsesError } from './errors.mjs';
import { planUsageActive } from './siwc.mjs';
import { guardedFetch, realSleep } from './util.mjs';

const API_ORIGIN = new URL(OPENAI_MODELS_URL).origin;

/** Known structured codes → kind / recovery text / retryability. */
const CODE_INFO = {
  subscription_sharing_user_not_eligible: { kind: 'not_eligible', retryable: false, hint: 'ChatGPT plan usage is unavailable for this user, workspace or policy.' },
  subscription_sharing_usage_limit_exceeded: { kind: 'usage_limit', retryable: false, hint: `Usage limit reached for your ChatGPT plan or for this app. New requests are paused. ${MANAGE_USAGE_HINT}` },
  subscription_sharing_usage_unavailable: { kind: 'usage_unavailable', retryable: true, hint: 'Usage availability could not be checked. Try again later.' },
  subscription_sharing_unsupported_capability: { kind: 'unsupported_capability', retryable: false, hint: 'The request used an input, tool, model or feature this route does not support.' },
  subscription_sharing_route_not_supported: { kind: 'route_not_supported', retryable: false, hint: 'This HTTP method/endpoint is not supported for ChatGPT plan usage.' },
  subscription_sharing_invalid_user: { kind: 'invalid_user', retryable: false, hint: 'The subscriber context could not be validated. If this persists, sign out and sign in again.' },
  chatpass_v2_scope_not_authorized: { kind: 'scope_not_authorized', retryable: false, hint: 'The granted permission does not authorize this operation. Check the account’s granted scopes.' },
  chatpass_v2_invalid_authorization_context: { kind: 'scope_not_authorized', retryable: false, hint: 'The signed permission context is not valid for this operation.' },
  subscription_sharing_user_unavailable: { kind: 'user_unavailable', retryable: true, hint: 'User/workspace information is temporarily unavailable. Try again later.' },
};
const ADMISSION = {
  401: { kind: 'admission_unauthorized', retryable: false, hint: 'The signed identity or direct permission was not accepted. Check the selected ChatGPT account and its granted scopes.' },
  403: { kind: 'admission_forbidden', retryable: false, hint: 'A policy or permission check (for example the serving region) prevented admission.' },
  503: { kind: 'admission_unavailable', retryable: true, hint: 'Direct routing is unavailable. Try again later.' },
};

/**
 * Map an error body / event to a ResponsesError, preserving status, code,
 * param and request id.
 * @param {{status?:number|null, body?:any, requestId?:string|null, source:'http'|'stream'}} f
 */
export function toResponsesError({ status = null, body, requestId = null, source }) {
  const err = body?.error && typeof body.error === 'object' ? body.error : body?.response?.error ?? (body?.code ? body : null);
  const code = err?.code ?? null;
  const param = err?.param ?? null;
  const detail = typeof body?.detail === 'string' ? body.detail : (typeof err?.message === 'string' ? err.message : null);
  const info = code && CODE_INFO[code];
  const effectiveStatus = status ?? (code === 'subscription_sharing_usage_limit_exceeded' ? 429 : null);
  if (info) {
    const extra = info.kind === 'unsupported_capability' && param ? ` (param: ${param})` : '';
    return new ResponsesError({ status: effectiveStatus, code, param, requestId, detail, kind: info.kind, retryable: info.retryable,
      message: `${info.hint}${extra} [${code}${effectiveStatus ? `, HTTP ${effectiveStatus}` : ''}${requestId ? `, request ${requestId}` : ''}]` });
  }
  const adm = source === 'http' && status && !code ? ADMISSION[status] : null;
  if (adm) {
    return new ResponsesError({ status, code: null, param: null, requestId, detail, kind: adm.kind, retryable: adm.retryable,
      message: `${adm.hint} [HTTP ${status}${requestId ? `, request ${requestId}` : ''}]${detail ? ` Detail: ${detail}` : ''}` });
  }
  return new ResponsesError({ status, code, param, requestId, detail, kind: code ? 'responses_error' : 'http_error', retryable: false,
    message: `Request failed${status ? ` (HTTP ${status})` : ''}${code ? `: ${code}` : ''}${detail ? ` — ${detail}` : ''}${requestId ? ` [request ${requestId}]` : ''}` });
}

/**
 * Build a Responses request body that complies with the ChatGPT-plan route:
 * store:false, stream:true, full history in `input`, `instructions` instead of
 * system messages, no unsupported fields or hosted tools.
 * @param {{model:string, instructions?:string, input:any[], tools?:any[]}} p
 */
export function buildResponsesBody(p) {
  if (!p.model) throw new CompanionError('no_model', 'No model selected. Run `tcg-companion models`.');
  if (!Array.isArray(p.input)) throw new CompanionError('bad_input', 'input must be an array');
  for (const item of p.input) {
    if (item && item.role === 'system') throw new CompanionError('bad_input', 'system-role input items are not allowed on this route; use instructions');
  }
  for (const t of p.tools ?? []) {
    if (UNSUPPORTED_TOOL_TYPES.has(t.type)) throw new CompanionError('bad_tools', `tool type ${t.type} is not supported on this route`);
    if (t.type !== 'namespace') throw new CompanionError('bad_tools', 'function tools must be grouped in a namespace');
  }
  /** @type {Record<string, unknown>} */
  const body = { model: p.model, input: p.input, store: false, stream: true };
  if (p.instructions) body.instructions = p.instructions;
  if (p.tools?.length) body.tools = p.tools;
  for (const f of UNSUPPORTED_RESPONSES_FIELDS) if (f in body) throw new Error(`unsupported field ${f}`);
  return body;
}

/** Incremental SSE parser yielding {event, data} objects. */
export async function* parseSse(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let ended = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) ended = true;
      if (value) buf += decoder.decode(value, { stream: true });
      if (done) buf += decoder.decode();
      let idx;
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        let event = 'message';
        const data = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
      if (done) {
        if (buf.trim()) {
          const data = buf.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
          if (data.length) yield { event: 'message', data: data.join('\n') };
        }
        return;
      }
    }
  } finally {
    // A provider error can end consumption before its HTTP stream closes.
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Reconcile store:false streamed items with possibly empty/partial terminal
 * output. Identity, rather than content or array length, prevents lost calls
 * and repeated tool dispatch. Conflicting function identities fail closed. */
function responseOutput(streamed, terminal, requestId) {
  const rows = [], keys = new Map();
  const conflict = () => { throw new ResponsesError({ requestId, kind: 'stream_conflict', message: 'The provider returned conflicting output items; no tools were dispatched.' }); };
  const add = (item, index) => {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'function_call' && (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || typeof item.arguments !== 'string')) conflict();
    const identities = [];
    if (typeof item.id === 'string' && item.id) identities.push(`item:${item.id}`);
    if (item.type === 'function_call') identities.push(`call:${item.call_id}`);
    if (!identities.length && Number.isInteger(index) && index >= 0) identities.push(`index:${index}`);
    const matches = [...new Set(identities.map(k => keys.get(k)).filter(r => r !== undefined))];
    if (matches.length > 1) conflict();
    let row = matches[0];
    if (row) {
      const old = row.item;
      if (old.type !== item.type || (item.type === 'function_call' && ['call_id', 'name', 'namespace', 'arguments'].some(k => (old[k] ?? '') !== (item[k] ?? '')))) conflict();
      row.item = { ...old, ...item };
    } else {
      row = { item, index: Number.isInteger(index) && index >= 0 ? index : rows.length, order: rows.length };
      rows.push(row);
    }
    for (const key of identities) keys.set(key, row);
  };
  for (const entry of streamed) add(entry.item, entry.index);
  for (const [index, item] of terminal.entries()) add(item, index);
  return rows.sort((a, b) => a.index - b.index || a.order - b.order).map(r => r.item);
}

export class OpenAIClient {
  /**
   * @param {{auth: import('./siwc.mjs').ChatGPTAuth, fetch?: typeof fetch, sleep?: (ms:number)=>Promise<void>}} deps
   */
  constructor(deps) {
    this.auth = deps.auth;
    this.http = guardedFetch(deps.fetch ?? globalThis.fetch, [API_ORIGIN], 'OpenAI API');
    this.sleep = deps.sleep ?? realSleep;
  }

  /** Account-specific model catalog; only `visibility === 'list'`, server order preserved. */
  async listModels(label) {
    const { token } = await this.auth.accessToken(label);
    const res = await this.http(OPENAI_MODELS_URL, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const requestId = res.headers.get('x-request-id');
    let body = {};
    try { body = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw toResponsesError({ status: res.status, body, requestId, source: 'http' });
    const models = Array.isArray(body.models) ? body.models : [];
    return models.filter((m) => m && m.visibility === 'list' && typeof m.slug === 'string')
      .map((m) => ({ slug: m.slug, display_name: m.display_name ?? m.slug }));
  }

  /**
   * Stream one Responses request to completion.
   * Success ONLY on `response.completed`.
   * @param {{label:string, model:string, instructions?:string, input:any[], tools?:any[], onDelta?:(t:string)=>void}} p
   * @returns {Promise<{output:any[], text:string, requestId:string|null}>}
   */
  async stream(p) {
    const rec = this.auth.store.readAccount(p.label);
    if (!planUsageActive(rec)) throw new PlanUsageDisabled(p.label);
    const body = JSON.stringify(buildResponsesBody(p));
    const delays = [1000, 3000, 8000];
    for (let attempt = 0; ; attempt++) {
      const { token } = await this.auth.accessToken(p.label);
      const res = await this.http(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body,
      });
      const requestId = res.headers.get('x-request-id');
      if (!res.ok) {
        let errBody = {};
        const text = await res.text();
        try { errBody = JSON.parse(text); } catch { errBody = text ? { detail: text.slice(0, 500) } : {}; }
        const e = toResponsesError({ status: res.status, body: errBody, requestId, source: 'http' });
        // Bounded backoff only for temporary availability failures (503 kinds).
        if (e.retryable && attempt < delays.length) { await this.sleep(delays[attempt]); continue; }
        throw e;
      }
      if (!res.body) throw new ResponsesError({ status: res.status, requestId, kind: 'stream_missing', message: 'Response had no stream body.' });
      return this.consume(res.body, requestId, p.onDelta);
    }
  }

  async consume(stream, requestId, onDelta) {
    let text = '';
    let completed = null;
    // With store:false the terminal response.completed event can carry an empty
    // `output`; the items are delivered by response.output_item.done events.
    const items = [];
    try {
      for await (const { data } of parseSse(stream)) {
        if (data === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        switch (ev.type) {
          case 'response.output_text.delta':
            if (typeof ev.delta === 'string') { text += ev.delta; onDelta?.(ev.delta); }
            break;
          case 'response.output_item.done':
            if (ev.item && typeof ev.item === 'object') items.push({ item: ev.item, index: ev.output_index });
            break;
          case 'response.completed':
            completed = ev.response ?? { output: [] };
            break;
          case 'response.failed':
            throw toResponsesError({ body: ev, requestId, source: 'stream' });
          case 'response.incomplete': {
            const reason = ev.response?.incomplete_details?.reason ?? 'unknown';
            throw new ResponsesError({ requestId, kind: 'incomplete', code: null, message: `The response was incomplete (${reason}).` });
          }
          case 'error':
            throw toResponsesError({ body: ev.error ? ev : { error: ev }, requestId, source: 'stream' });
          default:
            break;
        }
      }
    } catch (e) {
      if (e instanceof ResponsesError) throw e;
      throw new ResponsesError({ requestId, kind: 'stream_interrupted', message: `The response stream was interrupted: ${e.message}` });
    }
    if (!completed) {
      throw new ResponsesError({ requestId, kind: 'stream_ended', message: 'The stream ended without response.completed; treating as failed.' });
    }
    const output = responseOutput(items, Array.isArray(completed.output) ? completed.output : [], requestId);
    return { output, text, requestId };
  }
}
