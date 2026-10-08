/* MCP requestId replay protection (Phase 0 §5). One row per
 * (user_id, request_id): replay with identical args returns the stored
 * result flagged `replayed: true`; replay with different args is an error.
 */

import { argsHash } from '../shared/stablejson';
import type { Env } from './auth';

const RUNNING_TTL_MS = 120_000;
const RESULT_CAP_BYTES = 100 * 1024;
const REQ_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type IdemOutcome = { replayed: true; result: string } | { error: string } | { store: (status: 'done' | 'failed', result: string) => Promise<void> };

/**
 * `run` executes the tool body and returns the JSON-string tool payload.
 * Throws nothing — the outcome distinguishes replay / collision / fresh run.
 */
export async function withIdempotency(env: Env, userId: string, tool: string, requestId: string, args: unknown, run: () => Promise<{ text: string; isError: boolean }>): Promise<{ text: string; replayed?: boolean; failed?: boolean }> {
  if (!REQ_ID_RE.test(requestId)) {
    return { text: JSON.stringify({ error: `requestId must be 1-64 chars of [A-Za-z0-9_-]` }), failed: true };
  }
  const hash = await argsHash(args);
  const now = Date.now();

  const ins = await env.DB.prepare('INSERT INTO mcp_requests (user_id, request_id, tool, args_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, request_id) DO NOTHING')
    .bind(userId, requestId, tool, hash, 'running', now)
    .run();

  if ((ins.meta.changes ?? 0) === 0) {
    const row = await env.DB.prepare('SELECT tool, args_hash, status, result, created_at FROM mcp_requests WHERE user_id = ? AND request_id = ?').bind(userId, requestId).first<{ tool: string; args_hash: string; status: string; result: string | null; created_at: number }>();
    if (!row) return { text: JSON.stringify({ error: 'idempotency conflict' }), failed: true };
    if (row.args_hash !== hash) {
      return { text: JSON.stringify({ error: `requestId "${requestId}" was already used with different arguments` }), failed: true };
    }
    if (row.status === 'done') {
      return { text: injectReplayed(row.result ?? '{}'), replayed: true };
    }
    if (row.status === 'running' && now - row.created_at < RUNNING_TTL_MS) {
      return { text: JSON.stringify({ error: `requestId "${requestId}" is still running` }), failed: true };
    }
    // stale running / failed: guarded takeover
    const take = await env.DB.prepare('UPDATE mcp_requests SET status = ?, created_at = ?, tool = ? WHERE user_id = ? AND request_id = ? AND status = ? AND created_at = ?')
      .bind('running', now, tool, userId, requestId, row.status, row.created_at)
      .run();
    if ((take.meta.changes ?? 0) === 0) {
      return { text: JSON.stringify({ error: `requestId "${requestId}" is still running` }), failed: true };
    }
  }

  let status: 'done' | 'failed' = 'done';
  let text: string;
  try {
    const out = await run();
    text = out.text;
    if (out.isError) status = 'failed';
  } catch (e) {
    status = 'failed';
    text = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }

  await env.DB.prepare('UPDATE mcp_requests SET status = ?, result = ? WHERE user_id = ? AND request_id = ?').bind(status, storeResult(text), userId, requestId).run();

  // Bounded cleanup, piggy-backed on writes (§5).
  await env.DB.prepare('DELETE FROM mcp_requests WHERE created_at < ? LIMIT 100').bind(now - 7 * 24 * 60 * 60 * 1000).run().catch(() => undefined);

  return { text, failed: status === 'failed' };
}

function injectReplayed(result: string): string {
  try {
    const o = JSON.parse(result) as Record<string, unknown>;
    o.replayed = true;
    return JSON.stringify(o);
  } catch {
    return result;
  }
}

/** Results over 100KB are stored truncated — every created id survives. */
function storeResult(text: string): string {
  if (text.length <= RESULT_CAP_BYTES) return text;
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const ids: string[] = [];
    const collect = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === 'object') {
        const rec = v as Record<string, unknown>;
        if (typeof rec.id === 'string') ids.push(rec.id);
        Object.values(rec).forEach(collect);
      }
    };
    collect(o);
    return JSON.stringify({ truncated: true, ids, summary: `result exceeded ${RESULT_CAP_BYTES} bytes` });
  } catch {
    return JSON.stringify({ truncated: true, ids: [], summary: 'oversized result' });
  }
}
