/* SSE-over-fetch client for the embedded assistant's step protocol.
 *
 * One HTTP request = one bounded runtime step. When a step ends with
 * `{type:'step_end', next:'continue'}` we POST `/runs/:id/continue` with the
 * returned `step` and keep streaming; 'done' | 'approval' | 'cancelled' or an
 * `error` event end the run. Stop = abort the reader + POST `/runs/:id/cancel`.
 *
 * Kept free of the store/Dexie so it is unit-testable in node with an
 * injected fetch (tests/assistant-ui-sse.test.ts). */
import {
  ASSISTANT_API,
  MAX_RUN_STEPS,
  type AssistantErrorCode,
  type AssistantEvent,
} from '../../../shared/assistantProtocol';
import { createSseParser } from './sse';

export type ErrorEvent = Extract<AssistantEvent, { type: 'error' }>;
export type StepEnd = Extract<AssistantEvent, { type: 'step_end' }>;

export type RunOutcome =
  | { kind: 'done' | 'approval' | 'cancelled'; runId: string | null }
  | { kind: 'error'; runId: string | null; error: ErrorEvent }
  | { kind: 'aborted'; runId: string | null };

export interface StreamRequest {
  path: string;
  body: unknown;
}

export interface StreamOptions {
  signal: AbortSignal;
  onEvent: (e: AssistantEvent) => void;
  fetchImpl?: typeof fetch;
  getToken?: () => string | null;
  /** Upper bound on automatic continues (defaults to MAX_RUN_STEPS). */
  maxContinues?: number;
}

const KNOWN_CODES = new Set<AssistantErrorCode>([
  'unauthenticated', 'provider_unavailable', 'provider_auth_failed', 'provider_usage_limit', 'provider_not_eligible',
  'provider_unsupported_capability', 'provider_stream_interrupted', 'provider_failed', 'budget_exhausted', 'step_limit',
  'run_conflict', 'access_changed', 'invalid_request', 'internal',
]);

function defaultToken(): string | null {
  try {
    return localStorage.getItem('ws_token');
  } catch {
    return null;
  }
}

/** Map a non-2xx response to an assistant error event (never echoes request data). */
export function errorFromStatus(status: number, body: unknown): ErrorEvent {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const raw = typeof b.code === 'string' ? b.code : typeof b.error === 'string' ? b.error : '';
  const code: AssistantErrorCode = KNOWN_CODES.has(raw as AssistantErrorCode)
    ? (raw as AssistantErrorCode)
    : status === 401
      ? 'unauthenticated'
      : status === 403
        ? 'access_changed'
        : status === 409
          ? 'run_conflict'
          : status === 400 || status === 413 || status === 422
            ? 'invalid_request'
            : status === 503
              ? 'provider_unavailable'
              : 'internal';
  const message = typeof b.message === 'string' ? b.message : typeof b.error === 'string' && !KNOWN_CODES.has(b.error as AssistantErrorCode) ? b.error : `HTTP ${status}`;
  const retryable = typeof b.retryable === 'boolean' ? b.retryable : status === 0 || status >= 500 || status === 429;
  return { type: 'error', code, message, retryable };
}

export const interruptedError = (message = 'The response stream was interrupted.'): ErrorEvent => ({
  type: 'error',
  code: 'provider_stream_interrupted',
  message,
  retryable: true,
});

/** What to request after a step ends (pure; exported for tests). */
export function nextRequest(end: StepEnd): StreamRequest | null {
  return end.next === 'continue' ? { path: `${ASSISTANT_API}/runs/${encodeURIComponent(end.runId)}/continue`, body: { step: end.step } } : null;
}

function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError';
}

/** Run one request/step chain to completion, streaming events to `onEvent`. */
export async function streamRun(first: StreamRequest, opts: StreamOptions): Promise<RunOutcome> {
  const doFetch = opts.fetchImpl ?? fetch;
  const token = (opts.getToken ?? defaultToken)();
  const maxContinues = opts.maxContinues ?? MAX_RUN_STEPS;
  let req: StreamRequest | null = first;
  let runId: string | null = null;
  let continues = 0;

  while (req) {
    if (opts.signal.aborted) return { kind: 'aborted', runId };
    let res: Response;
    try {
      res = await doFetch(req.path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(req.body),
        signal: opts.signal,
      });
    } catch (e) {
      if (isAbort(e) || opts.signal.aborted) return { kind: 'aborted', runId };
      const err = interruptedError('Could not reach the server. Check your connection and retry.');
      opts.onEvent(err);
      return { kind: 'error', runId, error: err };
    }
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* non-JSON error body */
      }
      const err = errorFromStatus(res.status, body);
      opts.onEvent(err);
      return { kind: 'error', runId, error: err };
    }
    if (!res.body) {
      const err = interruptedError();
      opts.onEvent(err);
      return { kind: 'error', runId, error: err };
    }

    const parser = createSseParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    const st: { stepEnd: StepEnd | null; failure: ErrorEvent | null } = { stepEnd: null, failure: null };
    const handle = (events: AssistantEvent[]) => {
      for (const ev of events) {
        // Nothing after the step's terminal event belongs to this step.
        if (st.stepEnd || st.failure) return;
        if (ev.type === 'run') runId = ev.runId;
        if (ev.type === 'step_end') {
          runId = ev.runId;
          st.stepEnd = ev;
        }
        if (ev.type === 'error') st.failure = ev;
        opts.onEvent(ev);
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        handle(parser.push(decoder.decode(value, { stream: true })));
        if (st.failure || st.stepEnd) break;
      }
      if (!st.failure && !st.stepEnd) handle(parser.push(decoder.decode()).concat(parser.end()));
    } catch (e) {
      if (isAbort(e) || opts.signal.aborted) return { kind: 'aborted', runId };
      st.failure = interruptedError();
      opts.onEvent(st.failure);
    } finally {
      reader.cancel().catch(() => {});
    }

    if (st.failure) return { kind: 'error', runId, error: st.failure };
    const end = st.stepEnd;
    if (!end) {
      if (opts.signal.aborted) return { kind: 'aborted', runId };
      const err = interruptedError();
      opts.onEvent(err);
      return { kind: 'error', runId, error: err };
    }
    req = nextRequest(end);
    if (!req) return { kind: end.next as 'done' | 'approval' | 'cancelled', runId };
    if (++continues > maxContinues) {
      const err: ErrorEvent = { type: 'error', code: 'step_limit', message: 'The assistant reached its step limit for this request.', retryable: false };
      opts.onEvent(err);
      return { kind: 'error', runId, error: err };
    }
  }
  return { kind: 'done', runId };
}

/** Best-effort server-side cancel; the local reader is aborted by the caller. */
export async function cancelRun(runId: string, opts: { fetchImpl?: typeof fetch; getToken?: () => string | null } = {}): Promise<void> {
  const token = (opts.getToken ?? defaultToken)();
  try {
    await (opts.fetchImpl ?? fetch)(`${ASSISTANT_API}/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: '{}',
    });
  } catch {
    /* offline — the server run times out on its own */
  }
}
