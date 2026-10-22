// @ts-nocheck — exercises the plain-ESM companion (companion/*.mjs, JSDoc-typed).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { startCallbackServer, checkCallbackRequest } from '../companion/lib/loopback.mjs';
import { ChatGPTAuth } from '../companion/lib/siwc.mjs';
import { CompanionStore } from '../companion/lib/store.mjs';
import { Companion } from '../companion/lib/companion.mjs';
import { guardedFetch, redact, withFileLock } from '../companion/lib/util.mjs';
import { NAV_HEADERS, httpGet, json, makeWorld, sink, tempDir } from '../companion/test-support/fixtures.mjs';

afterEach(() => vi.restoreAllMocks());

describe('loopback callback listener', () => {
  const start = (state = 'GOOD') => startCallbackServer({ path: '/auth/callback', port: 0, expectedState: state, timeoutMs: 5000 });

  it('binds 127.0.0.1 and reports the actual bound port', async () => {
    const s = await start();
    expect(s.redirectUri).toBe(`http://127.0.0.1:${s.port}/auth/callback`);
    expect(s.port).toBeGreaterThan(0);
    s.close();
  });

  it('state mismatch (callback substitution) is rejected and does not complete the attempt', async () => {
    const s = await start();
    const bad = await httpGet(`${s.redirectUri}?code=ATTACKER&state=EVIL`, NAV_HEADERS);
    expect(bad.status).toBe(400);
    const missing = await httpGet(`${s.redirectUri}?code=ATTACKER`, NAV_HEADERS);
    expect(missing.status).toBe(400);
    const good = await httpGet(`${s.redirectUri}?code=REAL&state=GOOD`, NAV_HEADERS);
    expect(good.status).toBe(200);
    expect((await s.waitForCallback()).get('code')).toBe('REAL');
  });

  it('a second callback is refused once one was accepted', async () => {
    const s = await start();
    expect((await httpGet(`${s.redirectUri}?code=1&state=GOOD`, NAV_HEADERS)).status).toBe(200);
    const second = await httpGet(`${s.redirectUri}?code=2&state=GOOD`, NAV_HEADERS);
    expect(second.status === 410 || second.status === 0).toBe(true); // refused or listener closed
    expect((await s.waitForCallback()).get('code')).toBe('1');
  });

  it('wrong Host header (DNS rebinding) is rejected', async () => {
    const s = await start();
    for (const host of [`localhost:${s.port}`, `evil.example:${s.port}`, '127.0.0.1', `127.0.0.1:${s.port + 1}`]) {
      expect((await httpGet(`${s.redirectUri}?code=x&state=GOOD`, { ...NAV_HEADERS, Host: host })).status).toBe(421);
    }
    s.close();
  });

  it('cross-site non-navigation requests and foreign Origin are rejected; top-level navigation passes', async () => {
    const s = await start();
    const url = `${s.redirectUri}?code=x&state=GOOD`;
    expect((await httpGet(url, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' })).status).toBe(403);
    expect((await httpGet(url, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' })).status).toBe(403);
    expect((await httpGet(url, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' })).status).toBe(403);
    expect((await httpGet(url, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Origin: 'https://evil.example' })).status).toBe(403);
    expect((await httpGet(url, { Origin: 'https://evil.example' })).status).toBe(403); // foreign Origin, not a navigation
    expect((await httpGet(url, { ':method': 'POST' })).status).toBe(405);
    expect((await httpGet(`http://127.0.0.1:${s.port}/other?state=GOOD`, NAV_HEADERS)).status).toBe(404);
    // Some browsers send the redirecting Origin on the top-level navigation; that must still work.
    expect((await httpGet(url, { ...NAV_HEADERS, Origin: 'https://auth.openai.com' })).status).toBe(200);
    await s.waitForCallback();
  });

  it('falls back to an ephemeral port when the default port is busy', async () => {
    const { createServer } = await import('node:http');
    const blocker = createServer(() => {});
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const busy = blocker.address().port;
    try {
      const s = await startCallbackServer({ path: '/auth/callback', port: busy, expectedState: 'GOOD', timeoutMs: 5000 });
      expect(s.port).not.toBe(busy);
      expect(s.redirectUri).toBe(`http://127.0.0.1:${s.port}/auth/callback`);
      expect((await httpGet(`${s.redirectUri}?code=c&state=GOOD`, NAV_HEADERS)).status).toBe(200);
      expect((await s.waitForCallback()).get('code')).toBe('c');
    } finally {
      blocker.close();
    }
  });

  it('pure check helper mirrors the policy', () => {
    const h = { host: '127.0.0.1:1455' };
    expect(checkCallbackRequest({ method: 'GET', url: '/auth/callback?state=s', headers: h }, { port: 1455, path: '/auth/callback' }).ok).toBe(true);
    expect(checkCallbackRequest({ method: 'GET', url: '/auth/callback', headers: { ...h, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' } }, { port: 1455, path: '/auth/callback' }).ok).toBe(false);
  });
});

describe('credential files and logging', () => {
  it('config dir is 0700, credential files 0600, and no token reaches any output', async () => {
    const world = makeWorld();
    const dir = tempDir();
    const out = sink(); const err = sink();
    const logged = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug']) vi.spyOn(console, m).mockImplementation((...a) => { logged.push(a.join(' ')); });
    const c = new Companion({ configDir: dir, fetch: world.fetch, now: world.now, openBrowser: async () => { throw new Error('no browser'); }, stdout: out, stderr: err, sleep: async () => {} });
    // No browser: the companion must print an authorize URL; drive the callback ourselves.
    const done = c.login({ port: 0 });
    await vi.waitFor(() => expect(err.text()).toMatch(/https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?/), { timeout: 3000 });
    const printed = new URL(err.text().match(/https:\/\/auth\.openai\.com\S+/)[0]);
    world.nonce = printed.searchParams.get('nonce');
    const cb = new URL(printed.searchParams.get('redirect_uri'));
    cb.searchParams.set('code', 'AUTHCODE_1'); cb.searchParams.set('state', printed.searchParams.get('state')); cb.searchParams.set('client_id', world.clientId);
    await httpGet(cb.href, NAV_HEADERS);
    await done;
    // reauth path with id_token_hint: printed URL must omit the hint
    const err2 = sink();
    const c2 = new Companion({ configDir: dir, fetch: world.fetch, now: world.now, openBrowser: async () => { throw new Error('no browser'); }, stdout: sink(), stderr: err2 });
    const again = c2.login({ port: 0, account: 'user@example.com' }).catch(() => {});
    await vi.waitFor(() => expect(err2.text()).toMatch(/authorize\?/), { timeout: 3000 });
    expect(err2.text()).not.toMatch(/id_token_hint/);
    // finish the reauth attempt with a denial so its listener closes
    const u2 = new URL(err2.text().match(/https:\/\/auth\.openai\.com\S+/)[0]);
    const cb2 = new URL(u2.searchParams.get('redirect_uri')); cb2.searchParams.set('error', 'access_denied'); cb2.searchParams.set('state', u2.searchParams.get('state'));
    await httpGet(cb2.href, NAV_HEADERS);
    await again;

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) expect(statSync(`${dir}/${f}`).mode & 0o777).toBe(0o600);
    const everything = out.text() + err.text() + err2.text() + logged.join('\n');
    for (const secret of ['AT_SECRET', 'RT_SECRET', 'eyJ', 'AUTHCODE_1']) expect(everything).not.toContain(secret);
    expect(out.text()).toMatch(/You’re using your ChatGPT plan/);
  });

  it('redact() strips JWTs, bearer values, and token fields', () => {
    const s = redact('Bearer abc.def https://auth.openai.com/x?id_token_hint=eyJhbGciOi.eyJzdWIi.sig&x=1 {"refresh_token":"RT1"} access_token=AT1');
    expect(s).not.toMatch(/abc\.def|eyJ|RT1|AT1/);
  });
});

describe('refresh-token race', () => {
  async function loggedIn() {
    const world = makeWorld();
    const dir = tempDir();
    const mk = () => {
      const store = new CompanionStore({ configDir: dir, now: world.now });
      return new ChatGPTAuth({ store, fetch: world.fetch, now: world.now, openBrowser: world.browser(), lockWait: (ms) => new Promise((r) => setTimeout(r, ms)) });
    };
    const a = mk();
    const r = await a.login({ port: 0, timeoutMs: 5000 });
    const rec = a.store.readAccount(r.account.label);
    rec.saved_at = new Date(world.now() - 2 * 3600_000).toISOString(); // expired for everyone
    a.store.writeAccount(rec);
    return { world, dir, a, mk, label: r.account.label };
  }
  const refreshCalls = (w) => w.calls.filter((c) => c.body.includes('grant_type=refresh_token'));

  it('same process: concurrent callers share ONE token-endpoint call and the rotated token', async () => {
    const { world, a, label } = await loggedIn();
    const [t1, t2, t3] = await Promise.all([a.accessToken(label), a.accessToken(label), a.accessToken(label)]);
    expect(refreshCalls(world)).toHaveLength(1);
    expect(new Set([t1.token, t2.token, t3.token])).toEqual(new Set(['AT_SECRET_CHATGPT_2']));
  });

  it('two processes (separate stores/locks on one dir): lock file serializes, second reuses rotation', async () => {
    const { world, a, mk, label } = await loggedIn();
    const b = mk(); // independent in-process state — only the O_EXCL lock file is shared
    expect(b.refreshing).not.toBe(a.refreshing);
    const [ta, tb] = await Promise.all([a.accessToken(label), b.accessToken(label)]);
    expect(refreshCalls(world)).toHaveLength(1);
    expect(ta.token).toBe('AT_SECRET_CHATGPT_2');
    expect(tb.token).toBe('AT_SECRET_CHATGPT_2');
    expect(b.store.readAccount(label).refresh_token).toBe('RT_SECRET_CHATGPT_2');
  });

  it('a held lock blocks a second process; a stale lock is recovered', async () => {
    const dir = tempDir();
    const lock = `${dir}/x.lock`;
    let t = 1_000_000;
    writeFileSync(lock, JSON.stringify({ created_at: t, token: 'other' }));
    let ran = false;
    const p = withFileLock(lock, async () => { ran = true; }, { now: () => t, staleMs: 30_000, wait: async () => { t += 10_000; } });
    await p;
    expect(ran).toBe(true); // became stale after 30s of injected clock and was taken over
    let inside = 0; let maxInside = 0;
    await Promise.all([1, 2, 3].map(() => withFileLock(lock, async () => { inside++; maxInside = Math.max(maxInside, inside); await new Promise((r) => setTimeout(r, 10)); inside--; }, { wait: (ms) => new Promise((r) => setTimeout(r, ms)) })));
    expect(maxInside).toBe(1);
  });
});

describe('endpoint pinning and fetch guards', () => {
  it('discovery with a foreign jwks_uri is refused before any key fetch', async () => {
    const world = makeWorld();
    const base = world.fetch;
    world.fetch = async (url, init) => (String(url).endsWith('openid-configuration')
      ? json(200, { issuer: 'https://auth.openai.com', jwks_uri: 'https://keys.evil.example/jwks', revocation_endpoint: 'https://auth.openai.com/oauth/revoke' })
      : base(url, init));
    const store = new CompanionStore({ configDir: tempDir(), now: world.now });
    const auth = new ChatGPTAuth({ store, fetch: world.fetch, now: world.now, openBrowser: world.browser() });
    await expect(auth.login({ port: 0, timeoutMs: 5000 })).rejects.toMatchObject({ code: 'discovery_untrusted' });
  });

  it('discovery with a wrong issuer is refused', async () => {
    const world = makeWorld();
    const store = new CompanionStore({ configDir: tempDir(), now: world.now });
    const auth = new ChatGPTAuth({ store, fetch: async () => json(200, { issuer: 'https://evil.example', jwks_uri: 'https://auth.openai.com/j' }), now: world.now });
    await expect(auth.discovery()).rejects.toMatchObject({ code: 'discovery_untrusted' });
  });

  it('guardedFetch refuses non-allowlisted origins and never follows redirects', async () => {
    const inner = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    const f = guardedFetch(inner, ['https://api.openai.com'], 't');
    await expect(f('https://evil.example/x')).rejects.toThrow(/non-allowlisted/);
    await expect(f('http://api.openai.com/x')).rejects.toThrow(/non-allowlisted/);
    expect(inner).not.toHaveBeenCalled();
    await expect(f('https://api.openai.com/v1/responses')).rejects.toThrow(/redirect/);
    expect(inner.mock.calls[0][1].redirect).toBe('manual');
  });

  it('endpoints are constants, not environment-overridable', () => {
    const src = ['constants', 'siwc', 'openai', 'workspace', 'util', 'loopback', 'companion', 'store', 'chat']
      .map((m) => readFileSync(`companion/lib/${m}.mjs`, 'utf8')).join('\n');
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/backend-api/);
  });
});
