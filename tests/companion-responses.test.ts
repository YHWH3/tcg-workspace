// @ts-nocheck — exercises the plain-ESM companion (companion/*.mjs, JSDoc-typed).
import { describe, it, expect } from 'vitest';
import { ChatGPTAuth } from '../companion/lib/siwc.mjs';
import { CompanionStore } from '../companion/lib/store.mjs';
import { OpenAIClient, buildResponsesBody } from '../companion/lib/openai.mjs';
import { buildToolset, runTurn } from '../companion/lib/chat.mjs';
import { UNSUPPORTED_RESPONSES_FIELDS } from '../companion/lib/constants.mjs';
import { assistantMsg, completed, fnCall, json, makeWorld, sseResponse, tempDir, textDelta } from '../companion/test-support/fixtures.mjs';

async function ready() {
  const world = makeWorld();
  const store = new CompanionStore({ configDir: tempDir(), now: world.now });
  const auth = new ChatGPTAuth({ store, fetch: world.fetch, now: world.now, openBrowser: world.browser() });
  const r = await auth.login({ port: 0, timeoutMs: 5000 });
  const sleeps = [];
  const openai = new OpenAIClient({ auth, fetch: world.fetch, sleep: async (ms) => { sleeps.push(ms); } });
  return { world, openai, label: r.account.label, sleeps };
}
const req = (label, extra = {}) => ({ label, model: 'gpt-test', instructions: 'be brief', input: [{ role: 'user', content: 'hi' }], ...extra });
const responsesCalls = (w) => w.calls.filter((c) => c.url === 'https://api.openai.com/v1/responses');
const nonOpenAI = (w) => w.calls.filter((c) => !c.url.startsWith('https://auth.openai.com/') && !c.url.startsWith('https://api.openai.com/'));

describe('request body', () => {
  it('store:false, stream:true, instructions, full input; no unsupported fields', async () => {
    const { world, openai, label } = await ready();
    const deltas = [];
    const r = await openai.stream(req(label, { onDelta: (d) => deltas.push(d) }));
    expect(r.text).toBe('ok');
    expect(deltas).toEqual(['ok']);
    const [call] = responsesCalls(world);
    const body = JSON.parse(call.body);
    expect(body).toEqual({ model: 'gpt-test', input: [{ role: 'user', content: 'hi' }], store: false, stream: true, instructions: 'be brief' });
    for (const f of UNSUPPORTED_RESPONSES_FIELDS) expect(f in body).toBe(false);
    expect(call.headers.get('authorization')).toBe('Bearer AT_SECRET_CHATGPT_1');
  });

  it('rejects system-role items, hosted tools, and ungrouped function tools', () => {
    expect(() => buildResponsesBody({ model: 'm', input: [{ role: 'system', content: 'x' }] })).toThrow(/system/);
    for (const type of ['mcp', 'file_search', 'code_interpreter', 'tool_search', 'image_generation', 'computer_use_preview']) {
      expect(() => buildResponsesBody({ model: 'm', input: [], tools: [{ type }] })).toThrow();
    }
    expect(() => buildResponsesBody({ model: 'm', input: [], tools: [{ type: 'function', name: 'f' }] })).toThrow(/namespace/);
    const ok = buildResponsesBody({ model: 'm', input: [], tools: [{ type: 'namespace', name: 'ns', description: 'd', tools: [] }] });
    expect(ok.tools[0].type).toBe('namespace');
  });
});

describe('stream outcomes', () => {
  const consume = (events) => new OpenAIClient({ auth: {} }).consume(sseResponse(events).body, 'req_synthetic');
  const done = (item, output_index) => ({ type: 'response.output_item.done', item, output_index });

  it('merges partial terminal output with every completed streamed item in output order', async () => {
    const first = fnCall('search', { query: 'first' }, 'first');
    const second = fnCall('search', { query: 'second' }, 'second');
    const message = assistantMsg('I will search twice.');
    const r = await consume([textDelta('I will search twice.'), done(second, 2), done(message, 0), done(first, 1), completed([message])]);
    expect(r.output).toEqual([message, first, second]);
    expect(r.text).toBe('I will search twice.');
  });

  it.each([true, false])('deduplicates repeated streamed and terminal items (empty terminal=%s)', async (empty) => {
    const call = fnCall('search', { query: 'one' });
    const message = assistantMsg('Searching.');
    const r = await consume([done(message, 0), done(call, 1), done(call, 1), done(message, 0), completed(empty ? [] : [message, call])]);
    expect(r.output).toEqual([message, call]);
  });

  it('uses function call identity even when an item id is absent or changes', async () => {
    const call = fnCall('search', { query: 'one' });
    const { id: _id, ...withoutId } = call;
    const r = await consume([done(withoutId, 0), done(call, 0), completed([{ ...call, id: 'another_item_id' }])]);
    expect(r.output).toHaveLength(1);
    expect(r.output[0]).toMatchObject({ call_id: call.call_id, arguments: call.arguments });
  });

  it.each(['arguments', 'name', 'namespace'])('rejects conflicting duplicate function %s before any dispatch', async (field) => {
    const call = fnCall('search', { query: 'one' });
    await expect(consume([done(call, 0), completed([{ ...call, [field]: 'changed' }])])).rejects.toMatchObject({ kind: 'stream_conflict' });
  });

  it('rejects reuse of an output item id for a different call id', async () => {
    const call = fnCall('search', { query: 'one' });
    await expect(consume([done(call, 0), done({ ...call, call_id: 'different' }, 1), completed([])])).rejects.toMatchObject({ kind: 'stream_conflict' });
  });

  it.each([
    [[], 'stream_ended'],
    [[{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }], 'incomplete'],
    [[{ type: 'error', code: 'synthetic_failure' }], 'responses_error'],
  ])('does not expose a completed call when the response itself fails (%s)', async (terminal, kind) => {
    await expect(consume([done(fnCall('search', {}), 0), ...terminal])).rejects.toMatchObject({ kind });
  });

  it('cancels and releases an open stream after a provider error', async () => {
    let cancelled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"error","code":"synthetic_failure"}\n\n')); }, cancel() { cancelled = true; } });
    await expect(new OpenAIClient({ auth: {} }).consume(body, 'synthetic')).rejects.toMatchObject({ errorCode: 'synthetic_failure' });
    expect(body.locked).toBe(false);
    expect(cancelled).toBe(true);
  });

  it('fails on a network interruption after a completed item without dispatching it', async () => {
    let sent = false;
    const body = new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(done(fnCall('search', {}), 0))}\n\n`)); } else controller.error(new Error('synthetic interruption')); } });
    await expect(new OpenAIClient({ auth: {} }).consume(body, 'synthetic')).rejects.toMatchObject({ kind: 'stream_interrupted' });
    expect(body.locked).toBe(false);
  });

  it.each([true, false])('dispatches each function call exactly once through the real companion tool loop (empty terminal=%s)', async (empty) => {
    const { world, openai, label } = await ready();
    const a = fnCall('search', { query: 'first' }, 'first'), b = fnCall('search', { query: 'second' }, 'second');
    let segment = 0;
    world.responsesHandler = () => sseResponse(segment++ === 0 ? [done(a, 0), done(a, 0), done(b, 1), completed(empty ? [] : [a])] : [textDelta('Finished.'), completed([assistantMsg('Finished.')])]);
    const dispatched = [];
    await runTurn({ openai, label, model: 'gpt-test', history: [], userText: 'search twice', write() {}, toolset: buildToolset([{ name: 'search', inputSchema: { type: 'object' } }]), mcp: { async callTool(name, args) { dispatched.push({ name, args }); return { content: [] }; } } });
    expect(dispatched).toEqual([{ name: 'search', args: { query: 'first' } }, { name: 'search', args: { query: 'second' } }]);
  });
  it('collects function calls from output_item.done when store:false leaves completed.output empty (observed on a real account)', async () => {
    const { world, openai, label } = await ready();
    const call = fnCall('search', { query: 'Soil sensor' });
    world.responsesHandler = () => sseResponse([{ type: 'response.output_item.added', item: { ...call, arguments: '' } }, { type: 'response.function_call_arguments.delta', delta: '{"query"' }, { type: 'response.output_item.done', item: call }, completed([])]);
    const r = await openai.stream(req(label));
    expect(r.output).toEqual([call]);
  });

  it('stream ending without response.completed is a failure', async () => {
    const { world, openai, label } = await ready();
    world.responsesHandler = () => sseResponse([textDelta('partial')]);
    await expect(openai.stream(req(label))).rejects.toMatchObject({ kind: 'stream_ended' });
  });

  it('response.incomplete is a failure', async () => {
    const { world, openai, label } = await ready();
    world.responsesHandler = () => sseResponse([textDelta('x'), { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]);
    await expect(openai.stream(req(label))).rejects.toMatchObject({ kind: 'incomplete' });
  });

  it('explicit error event is a failure', async () => {
    const { world, openai, label } = await ready();
    world.responsesHandler = () => sseResponse([{ type: 'error', code: 'server_error', message: 'boom' }]);
    await expect(openai.stream(req(label))).rejects.toMatchObject({ errorCode: 'server_error' });
  });

  it('response.failed with usage_limit_exceeded → usage-limit error, one call, no fallback anywhere', async () => {
    const { world, openai, label, sleeps } = await ready();
    world.responsesHandler = () => sseResponse([textDelta('he'), { type: 'response.failed', response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }]);
    const before = world.calls.length;
    const e = await openai.stream(req(label)).catch((x) => x);
    expect(e).toMatchObject({ kind: 'usage_limit', errorCode: 'subscription_sharing_usage_limit_exceeded', status: 429, requestId: 'req_test_1', retryable: false });
    expect(e.message).toMatch(/Settings → Usage/);
    expect(e.message).not.toMatch(/reset|resets|try again in/i);
    const after = world.calls.slice(before);
    expect(after).toHaveLength(1);
    expect(after[0].url).toBe('https://api.openai.com/v1/responses');
    expect(nonOpenAI(world)).toHaveLength(0);
    expect(sleeps).toEqual([]);
  });

  it('pre-stream 429 usage limit body is preserved, not retried', async () => {
    const { world, openai, label } = await ready();
    world.responsesHandler = () => json(429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'x' } }, { 'x-request-id': 'req_429' });
    await expect(openai.stream(req(label))).rejects.toMatchObject({ kind: 'usage_limit', status: 429, requestId: 'req_429' });
    expect(responsesCalls(world)).toHaveLength(1);
  });

  it('unsupported_capability (400) is surfaced with param and never retried', async () => {
    const { world, openai, label, sleeps } = await ready();
    world.responsesHandler = () => json(400, { error: { code: 'subscription_sharing_unsupported_capability', param: 'tools[0].type', message: 'nope' } }, { 'x-request-id': 'req_400' });
    const e = await openai.stream(req(label)).catch((x) => x);
    expect(e).toMatchObject({ kind: 'unsupported_capability', status: 400, param: 'tools[0].type', requestId: 'req_400' });
    expect(e.message).toContain('tools[0].type');
    expect(responsesCalls(world)).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('usage_unavailable (503) uses bounded backoff then fails, without fallback', async () => {
    const { world, openai, label, sleeps } = await ready();
    world.responsesHandler = () => json(503, { error: { code: 'subscription_sharing_usage_unavailable' } });
    await expect(openai.stream(req(label))).rejects.toMatchObject({ kind: 'usage_unavailable', status: 503 });
    expect(responsesCalls(world)).toHaveLength(4);
    expect(sleeps).toEqual([1000, 3000, 8000]);
    expect(nonOpenAI(world)).toHaveLength(0);
  });

  it('503 retry succeeds when availability returns', async () => {
    const { world, openai, label } = await ready();
    let n = 0;
    world.responsesHandler = () => (++n === 1 ? json(503, { error: { code: 'subscription_sharing_user_unavailable' } }) : sseResponse([textDelta('hi'), completed([assistantMsg('hi')])]));
    expect((await openai.stream(req(label))).text).toBe('hi');
  });

  for (const [status, kind] of [[401, 'admission_unauthorized'], [403, 'admission_forbidden']]) {
    it(`pre-stream ${status} {detail} admission failure keeps status, detail and request id`, async () => {
      const { world, openai, label } = await ready();
      world.responsesHandler = () => json(status, { detail: 'Direct route not permitted' }, { 'x-request-id': `req_${status}` });
      await expect(openai.stream(req(label))).rejects.toMatchObject({ kind, status, detail: 'Direct route not permitted', requestId: `req_${status}` });
      expect(responsesCalls(world)).toHaveLength(1);
    });
  }

  for (const [code, status, kind] of [
    ['subscription_sharing_user_not_eligible', 403, 'not_eligible'],
    ['subscription_sharing_route_not_supported', 403, 'route_not_supported'],
    ['subscription_sharing_invalid_user', 401, 'invalid_user'],
    ['chatpass_v2_scope_not_authorized', 403, 'scope_not_authorized'],
    ['chatpass_v2_invalid_authorization_context', 403, 'scope_not_authorized'],
  ]) {
    it(`${code} maps to ${kind}, not retried`, async () => {
      const { world, openai, label } = await ready();
      world.responsesHandler = () => json(status, { error: { code } });
      await expect(openai.stream(req(label))).rejects.toMatchObject({ kind, status, errorCode: code, retryable: false });
      expect(responsesCalls(world)).toHaveLength(1);
    });
  }

  it('completed output items are returned for history replay', async () => {
    const { world, openai, label } = await ready();
    world.responsesHandler = () => sseResponse([textDelta('a'), textDelta('b'), completed([assistantMsg('ab')])]);
    const r = await openai.stream(req(label));
    expect(r.output).toEqual([assistantMsg('ab')]);
  });
});
