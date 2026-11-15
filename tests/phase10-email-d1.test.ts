import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emailApi } from '../worker/email';
import { me } from '../worker/auth';
import { openAuditFixture, type AuditFixture } from './audit-fixture';
import { d1BudgetRemaining, withD1Budget } from '../worker/d1budget';

let fx: AuditFixture;
let messages: { to: string[]; text: string }[];
let deliver: ReturnType<typeof vi.fn<Fetcher['fetch']>>;

beforeEach(async () => {
  messages = [];
  deliver = vi.fn<Fetcher['fetch']>(async (_url, init) => {
    messages.push(JSON.parse(String(init?.body)));
    return new Response(null, {status: 202});
  });
  fx = await openAuditFixture(undefined, {
    EMAIL_PROVIDER: 'simulated',
    WORKSPACE_ENV: 'local-test',
    EMAIL_LINK_KEY: crypto.randomUUID(),
    EMAIL_TEST_SINK: {fetch: deliver},
  });
});
afterEach(async () => { await fx?.dispose(); });

async function request(path = '/', method = 'GET', body?: object, actor = 'alice', env = fx.env) {
  const scoped = withD1Budget(env);
  const budget = d1BudgetRemaining(scoped.DB);
  const response = await emailApi.request(path, {method, headers: actor ? fx.auth(actor) : {}, body: body && JSON.stringify(body)}, scoped, fx.ctx);
  expect(budget - d1BudgetRemaining(scoped.DB)).toBeLessThanOrEqual(6);
  return response;
}
const send = (email: string, actor = 'alice') => request('/', 'POST', {email}, actor);
const confirm = (code: string, actor = 'alice') => request('/verify', 'POST', {code}, actor);
const latestCode = () => messages.at(-1)!.text.match(/\b\d{6}\b/)![0];

it('verifies case-normalized addresses without exposing the code or profile address and removes them explicitly', async () => {
  expect((await request('/', 'GET', undefined, '')).status).toBe(401);
  const started = await send(' Owner@Example.test ');
  expect(started.status).toBe(202);
  expect(await started.json()).toEqual({pending: 'owner@example.test', delivery: 'accepted'});
  expect(messages[0].to).toEqual(['owner@example.test']);
  const code = latestCode();
  const hash = await fx.db.prepare('SELECT code_hash FROM email_verifications').first<string>('code_hash');
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(await (await request()).json()).toMatchObject({email:null, pending:'owner@example.test'});
  const results = await Promise.all([confirm(code), confirm(code)]);
  expect(results.map(result => result.status).sort()).toEqual([200, 400]);
  const own = await me.request('/', {headers:fx.auth('alice')}, fx.env, fx.ctx);
  expect(await own.text()).not.toContain('owner@example.test');
  const bob = await request('/', 'GET', undefined, 'bob');
  expect(await bob.json()).toMatchObject({email:null, pending:null});
  expect((await request('/', 'DELETE')).status).toBe(200);
  expect(await (await request()).json()).toMatchObject({email:null, pending:null});
});

it('bounds code requests and guesses and rejects expired and replaced challenges', async () => {
  await send('owner@example.test');
  const correct = latestCode();
  const wrong = correct === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) expect((await confirm(wrong)).status).toBe(400);
  expect((await confirm(correct)).status).toBe(400);
  await send('new@example.test');
  const expired = latestCode();
  await fx.db.prepare('UPDATE email_verifications SET expires_at=0').run();
  expect((await confirm(expired)).status).toBe(400);
  await send('replacement@example.test');
  expect((await send('fourth@example.test')).status).toBe(429);
  expect(deliver).toHaveBeenCalledTimes(3);
  expect((await confirm(latestCode())).status).toBe(200);
});

it('keeps a duplicate address private at request time and uses the same error as an invalid code', async () => {
  await fx.db.prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
  await send('owner@example.test');
  await confirm(latestCode());
  const duplicate = await send('OWNER@example.test', 'bob');
  expect(duplicate.status).toBe(202);
  expect(await duplicate.json()).toEqual({pending: 'owner@example.test', delivery: 'accepted'});
  const code = latestCode();
  const incorrect = await confirm(code === '000000' ? '000001' : '000000', 'bob');
  const collision = await confirm(code, 'bob');
  expect(collision.status).toBe(incorrect.status);
  expect(await collision.json()).toEqual(await incorrect.json());
  expect(await (await request('/', 'GET', undefined, 'bob')).json()).toMatchObject({email:null, pending:'owner@example.test'});
});

it('fails closed outside the disposable environment and clears challenges when their session is revoked', async () => {
  const disabled = await request('/', 'POST', {email:'owner@example.test'}, 'alice', {...fx.env, WORKSPACE_ENV:'production'});
  expect(disabled.status).toBe(503);
  expect(deliver).not.toHaveBeenCalled();
  deliver.mockRejectedValueOnce(new Error('simulated response loss'));
  expect(await (await send('owner@example.test')).json()).toMatchObject({delivery:'uncertain'});
  expect(deliver).toHaveBeenCalledTimes(1);
  await fx.db.prepare("DELETE FROM sessions WHERE user_id='alice'").run();
  expect((await confirm('123456')).status).toBe(401);
  expect(await fx.db.prepare('SELECT COUNT(*) AS n FROM email_verifications').first('n')).toBe(0);
});
