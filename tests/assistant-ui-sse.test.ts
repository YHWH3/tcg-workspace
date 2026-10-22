import { describe, expect, it } from 'vitest';
import { createSseParser, asAssistantEvent } from '../src/core/assistant/sse';
import { errorFromStatus, nextRequest, streamRun } from '../src/core/assistant/client';
import type { AssistantEvent } from '../shared/assistantProtocol';

const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const text = (delta: string) => ({ type: 'text', messageId: 'm1', delta });

describe('createSseParser', () => {
  it('parses multiple events in one chunk', () => {
    const p = createSseParser();
    const out = p.push(ev(text('Hel')) + ev(text('lo')) + ev({ type: 'step_end', runId: 'r1', step: 1, next: 'done' }));
    expect(out.map((e) => e.type)).toEqual(['text', 'text', 'step_end']);
    expect((out[0] as Extract<AssistantEvent, { type: 'text' }>).delta).toBe('Hel');
  });

  it('reassembles events split mid-line and mid-JSON across chunks', () => {
    const p = createSseParser();
    const raw = ev(text('one')) + ev(text('two'));
    const got: AssistantEvent[] = [];
    // Every possible split point, including inside "data:" and the JSON body.
    for (let cut = 1; cut < raw.length; cut++) {
      const q = createSseParser();
      const a = q.push(raw.slice(0, cut));
      const b = q.push(raw.slice(cut));
      expect([...a, ...b].map((e) => (e as { delta: string }).delta)).toEqual(['one', 'two']);
    }
    for (const ch of raw) got.push(...p.push(ch)); // one character at a time
    expect(got).toHaveLength(2);
  });

  it('handles CRLF and CR line endings, including a CRLF split across chunks', () => {
    const p = createSseParser();
    const body = `data: ${JSON.stringify(text('x'))}`;
    const a = p.push(`${body}\r`);
    const b = p.push(`\n\r\n`);
    expect([...a, ...b]).toHaveLength(1);
    const q = createSseParser();
    expect(q.push(`${body}\r\r`)).toHaveLength(1);
  });

  it('ignores comments, unknown fields, malformed JSON and unknown event types', () => {
    const p = createSseParser();
    const out = p.push(
      ': keep-alive\n\n' +
        'event: ping\nid: 7\nretry: 100\n\n' +
        'data: {not json\n\n' +
        ev({ type: 'surprise', x: 1 }) +
        ev({ type: 'text', messageId: 'm1' }) + // missing delta
        ev(['array']) +
        'garbage line without colon\n\n' +
        ev(text('ok')),
    );
    expect(out).toHaveLength(1);
    expect((out[0] as { delta: string }).delta).toBe('ok');
  });

  it('joins multi-line data fields and tolerates writers that omit the blank line', () => {
    const p = createSseParser();
    const multi = p.push('data: {"type":"text",\ndata: "messageId":"m1","delta":"a"}\n\n');
    expect(multi).toHaveLength(1);
    const q = createSseParser();
    const noSep = q.push(`data: ${JSON.stringify(text('a'))}\ndata: ${JSON.stringify(text('b'))}\n\n`);
    expect(noSep.map((e) => (e as { delta: string }).delta)).toEqual(['a', 'b']);
  });

  it('flushes a trailing event without a terminating blank line on end()', () => {
    const p = createSseParser();
    expect(p.push(`data: ${JSON.stringify(text('tail'))}`)).toHaveLength(0);
    expect(p.end()).toHaveLength(1);
  });

  it('validates step_end next values and normalises error retryable', () => {
    expect(asAssistantEvent({ type: 'step_end', runId: 'r', step: 1, next: 'explode' })).toBeNull();
    const e = asAssistantEvent({ type: 'error', code: 'provider_usage_limit', message: 'limit' });
    expect(e).toMatchObject({ type: 'error', retryable: false });
  });
});

/* ---------------- client step loop (injected fetch) ---------------- */

function sseResponse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('streamRun', () => {
  it('auto-continues on step_end continue and stops on done', async () => {
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    const bodies = [
      [ev({ type: 'run', runId: 'r1', conversationId: 'c1', step: 1, provider: 'simulated', model: 'm' }), ev(text('Hi')).slice(0, 10), ev(text('Hi')).slice(10), ev({ type: 'step_end', runId: 'r1', step: 1, next: 'continue' })],
      [ev(text(' there')), ev({ type: 'step_end', runId: 'r1', step: 2, next: 'done' })],
    ];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).Authorization ?? null });
      return sseResponse(bodies[calls.length - 1]);
    }) as unknown as typeof fetch;
    const events: AssistantEvent[] = [];
    const out = await streamRun({ path: '/api/assistant/conversations/c1/messages', body: { text: 'q' } }, { signal: new AbortController().signal, onEvent: (e) => events.push(e), fetchImpl, getToken: () => 'tok' });
    expect(out).toEqual({ kind: 'done', runId: 'r1' });
    expect(calls.map((c) => c.url)).toEqual(['/api/assistant/conversations/c1/messages', '/api/assistant/runs/r1/continue']);
    expect(calls[1].body).toEqual({ step: 1 });
    expect(calls.every((c) => c.auth === 'Bearer tok')).toBe(true);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Hi there');
  });

  it('turns a stream that closes without step_end into a retryable interrupted error', async () => {
    const fetchImpl = (async () => sseResponse([ev(text('partial'))])) as unknown as typeof fetch;
    const events: AssistantEvent[] = [];
    const out = await streamRun({ path: '/x', body: {} }, { signal: new AbortController().signal, onEvent: (e) => events.push(e), fetchImpl, getToken: () => null });
    expect(out.kind).toBe('error');
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'provider_stream_interrupted', retryable: true });
  });

  it('stops on approval and on server error events without continuing', async () => {
    let n = 0;
    const approval = (async () => {
      n++;
      return sseResponse([ev({ type: 'step_end', runId: 'r2', step: 3, next: 'approval' })]);
    }) as unknown as typeof fetch;
    expect(await streamRun({ path: '/x', body: {} }, { signal: new AbortController().signal, onEvent: () => {}, fetchImpl: approval, getToken: () => null })).toEqual({ kind: 'approval', runId: 'r2' });
    expect(n).toBe(1);
    const failing = (async () => sseResponse([ev({ type: 'error', code: 'provider_usage_limit', message: 'limit', retryable: false }), ev({ type: 'step_end', runId: 'r3', step: 1, next: 'continue' })])) as unknown as typeof fetch;
    const out = await streamRun({ path: '/x', body: {} }, { signal: new AbortController().signal, onEvent: () => {}, fetchImpl: failing, getToken: () => null });
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.error.code).toBe('provider_usage_limit');
  });

  it('caps automatic continues', async () => {
    let n = 0;
    const loop = (async () => {
      n++;
      return sseResponse([ev({ type: 'step_end', runId: 'r', step: n, next: 'continue' })]);
    }) as unknown as typeof fetch;
    const out = await streamRun({ path: '/x', body: {} }, { signal: new AbortController().signal, onEvent: () => {}, fetchImpl: loop, getToken: () => null, maxContinues: 3 });
    expect(out.kind === 'error' && out.error.code).toBe('step_limit');
    expect(n).toBe(4);
  });

  it('maps HTTP failures to typed errors and reports abort as aborted', async () => {
    const res429 = (async () => new Response(JSON.stringify({ code: 'provider_usage_limit', message: 'over' }), { status: 429 })) as unknown as typeof fetch;
    const out = await streamRun({ path: '/x', body: {} }, { signal: new AbortController().signal, onEvent: () => {}, fetchImpl: res429, getToken: () => null });
    expect(out.kind === 'error' && out.error.code).toBe('provider_usage_limit');
    expect(errorFromStatus(401, null).code).toBe('unauthenticated');
    expect(errorFromStatus(409, { error: 'busy' }).code).toBe('run_conflict');
    const ctrl = new AbortController();
    ctrl.abort();
    const aborted = await streamRun({ path: '/x', body: {} }, { signal: ctrl.signal, onEvent: () => {}, fetchImpl: res429, getToken: () => null });
    expect(aborted.kind).toBe('aborted');
  });

  it('nextRequest only continues on next=continue', () => {
    expect(nextRequest({ type: 'step_end', runId: 'a/b', step: 2, next: 'continue' })).toEqual({ path: '/api/assistant/runs/a%2Fb/continue', body: { step: 2 } });
    expect(nextRequest({ type: 'step_end', runId: 'a', step: 2, next: 'cancelled' })).toBeNull();
  });
});
