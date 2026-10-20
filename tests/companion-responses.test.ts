// @ts-nocheck — exercises the plain-ESM companion (companion/*.mjs, JSDoc-typed).
import { describe, it, expect } from 'vitest';
import { ChatGPTAuth } from '../companion/lib/siwc.mjs';
import { CompanionStore } from '../companion/lib/store.mjs';
import { OpenAIClient, buildResponsesBody } from '../companion/lib/openai.mjs';
import { UNSUPPORTED_RESPONSES_FIELDS } from '../companion/lib/constants.mjs';
import { assistantMsg, completed, json, makeWorld, sseResponse, tempDir, textDelta } from '../companion/test-support/fixtures.mjs';

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
