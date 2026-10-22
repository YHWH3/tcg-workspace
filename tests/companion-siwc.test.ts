// @ts-nocheck — exercises the plain-ESM companion (companion/*.mjs, JSDoc-typed).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { buildAuthorizeUrl, ChatGPTAuth, interpretCallback } from '../companion/lib/siwc.mjs';
import { CompanionStore } from '../companion/lib/store.mjs';
import { OpenAIClient } from '../companion/lib/openai.mjs';
import { verifyIdToken } from '../companion/lib/jwt.mjs';
import { FULL_SCOPE, json, makeKeys, makeWorld, signJwt, tempDir } from '../companion/test-support/fixtures.mjs';

function setup(worldOpts = {}) {
  const world = makeWorld(worldOpts);
  const dir = tempDir();
  const store = new CompanionStore({ configDir: dir, now: world.now });
  const auth = new ChatGPTAuth({ store, fetch: world.fetch, now: world.now, openBrowser: world.browser(), sleep: async () => {}, lockWait: (ms) => new Promise((r) => setTimeout(r, ms)) });
  return { world, dir, store, auth };
}
const login = (ctx, opts = {}) => ctx.auth.login({ port: 0, timeoutMs: 5000, ...opts });
const withBrowser = (ctx, cb) => { ctx.auth.openBrowser = ctx.world.browser(cb); };
const tokenCalls = (world) => world.calls.filter((c) => c.url === 'https://auth.openai.com/api/accounts/oauth/token');

describe('authorize URL', () => {
  const base = { hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000', redirectUri: 'http://127.0.0.1:1455/auth/callback', state: 'S', nonce: 'N', codeChallenge: 'C' };

  it('first registration: exact parameter set, agent_name_hint present, no hints', () => {
    const u = new URL(buildAuthorizeUrl({ ...base, clientId: 'dynamic_agent_client', firstRegistration: true, idTokenHint: 'x', loginHint: 'a@b' }));
    expect(u.origin + u.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'TCG Workspace Companion',
      ext_agent_host_id: base.hostId,
      response_type: 'code',
      redirect_uri: 'http://127.0.0.1:1455/auth/callback',
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: 'https://api.openai.com/v1',
      state: 'S', nonce: 'N', code_challenge_method: 'S256', code_challenge: 'C',
    });
  });

  it('returning account: issued client id, hints, and NO agent_name_hint', () => {
    const u = new URL(buildAuthorizeUrl({ ...base, clientId: 'oaiapp_x', firstRegistration: false, idTokenHint: 'IDT', loginHint: 'user@example.com', redirectUri: 'http://127.0.0.1:54321/auth/callback' }));
    const q = u.searchParams;
    expect(q.get('client_id')).toBe('oaiapp_x');
    expect(q.has('agent_name_hint')).toBe(false);
    expect(q.get('id_token_hint')).toBe('IDT');
    expect(q.get('login_hint')).toBe('user@example.com');
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:54321/auth/callback');
    expect(q.has('prompt')).toBe(false);
  });

  it('refuses localhost, other paths, https, and client-id misuse', () => {
    for (const redirectUri of ['http://localhost:1455/auth/callback', 'http://127.0.0.1:1455/callback', 'https://127.0.0.1:1455/auth/callback', 'http://127.0.0.1:1455/auth/callback?x=1']) {
      expect(() => buildAuthorizeUrl({ ...base, redirectUri, clientId: 'dynamic_agent_client', firstRegistration: true })).toThrow();
    }
    expect(() => buildAuthorizeUrl({ ...base, clientId: 'oaiapp_x', firstRegistration: true })).toThrow();
    expect(() => buildAuthorizeUrl({ ...base, clientId: 'dynamic_agent_client', firstRegistration: false })).toThrow();
  });

  it('prompt=consent only on explicit plan re-enable', () => {
    const u = new URL(buildAuthorizeUrl({ ...base, clientId: 'oaiapp_x', firstRegistration: false, reconsent: true }));
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
  });
});

describe('callback interpretation', () => {
  const p = (o) => new URLSearchParams(o);
  it('new registration without issued client id is incomplete', () => {
    expect(() => interpretCallback(p({ code: 'c', state: 's' }), { firstRegistration: true })).toThrow(expect.objectContaining({ code: 'registration_incomplete' }));
    expect(() => interpretCallback(p({ code: 'c', state: 's', client_id: 'dynamic_agent_client' }), { firstRegistration: true })).toThrow(expect.objectContaining({ code: 'registration_incomplete' }));
  });
  it('reauth with a different client id is rejected; omitted client id keeps the pending one', () => {
    expect(() => interpretCallback(p({ code: 'c', client_id: 'oaiapp_other' }), { firstRegistration: false, expectedClientId: 'oaiapp_mine' })).toThrow(expect.objectContaining({ code: 'client_mismatch' }));
    expect(interpretCallback(p({ code: 'c' }), { firstRegistration: false, expectedClientId: 'oaiapp_mine' }).clientId).toBe('oaiapp_mine');
  });
  it('access_denied stops without a code exchange', () => {
    expect(() => interpretCallback(p({ error: 'access_denied', state: 's' }), { firstRegistration: true })).toThrow(expect.objectContaining({ code: 'access_denied' }));
  });
});

describe('sign-in flow', () => {
  it('first registration: host id persisted, exchange uses issued id + identical redirect_uri, record saved', async () => {
    const ctx = setup();
    const r = await login(ctx);
    expect(r.planUsage).toBe('active');
    expect(r.showWelcome).toBe(true);
    const authz = new URL(ctx.world.authorizeUrls[0]).searchParams;
    expect(authz.get('client_id')).toBe('dynamic_agent_client');
    expect(authz.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(authz.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    const [ex] = tokenCalls(ctx.world);
    const f = new URLSearchParams(ex.body);
    expect(Object.fromEntries(f)).toEqual({
      grant_type: 'authorization_code', client_id: 'oaiapp_issued_1', code: 'AUTHCODE_1',
      code_verifier: expect.any(String), redirect_uri: authz.get('redirect_uri'), resource: 'https://api.openai.com/v1',
    });
    expect(f.has('client_secret')).toBe(false);
    const rec = ctx.store.activeAccount();
    expect(rec).toMatchObject({ email: 'user@example.com', issuer: 'https://auth.openai.com', subject: 'user-sub-1', client_id: 'oaiapp_issued_1', ext_agent_host_id: authz.get('ext_agent_host_id'), token_type: 'Bearer', expires_in: 3600 });
    expect(rec.scopes).toEqual(FULL_SCOPE.split(' '));
    expect(JSON.parse(readFileSync(ctx.store.path('host-id.json'), 'utf8')).ext_agent_host_id).toBe(rec.ext_agent_host_id);
  });

  it('returning sign-in reuses issued client id, host id and hints; welcome not shown again', async () => {
    const ctx = setup();
    const first = await login(ctx);
    const r = await (withBrowser(ctx, (q) => ({ code: 'AUTHCODE_2', state: q.get('state') })), login(ctx, { account: first.account.label }));
    const q = new URL(ctx.world.authorizeUrls[1]).searchParams;
    expect(q.get('client_id')).toBe('oaiapp_issued_1');
    expect(q.has('agent_name_hint')).toBe(false);
    expect(q.get('ext_agent_host_id')).toBe(new URL(ctx.world.authorizeUrls[0]).searchParams.get('ext_agent_host_id'));
    expect(q.get('id_token_hint')).toBeTruthy();
    expect(q.get('login_hint')).toBe('user@example.com');
    expect(r.showWelcome).toBe(false);
    expect(ctx.store.listAccounts()).toHaveLength(1);
  });

  it('access_denied: no token exchange, nothing saved', async () => {
    const ctx = setup();
    withBrowser(ctx, (q) => ({ error: 'access_denied', state: q.get('state') }));
    await expect(login(ctx)).rejects.toMatchObject({ code: 'access_denied' });
    expect(tokenCalls(ctx.world)).toHaveLength(0);
    expect(ctx.store.listAccounts()).toHaveLength(0);
  });

  it('new registration callback missing client_id → incomplete, no exchange', async () => {
    const ctx = setup();
    withBrowser(ctx, (q) => ({ code: 'c', state: q.get('state') }));
    await expect(login(ctx)).rejects.toMatchObject({ code: 'registration_incomplete' });
    expect(tokenCalls(ctx.world)).toHaveLength(0);
  });

  it('reauth callback with a different client_id is rejected and credentials kept', async () => {
    const ctx = setup();
    const first = await login(ctx);
    const before = readFileSync(ctx.store.accountFile(first.account.label), 'utf8');
    withBrowser(ctx, (q) => ({ code: 'c2', state: q.get('state'), client_id: 'oaiapp_attacker' }));
    await expect(login(ctx, { account: first.account.label })).rejects.toMatchObject({ code: 'client_mismatch' });
    expect(readFileSync(ctx.store.accountFile(first.account.label), 'utf8')).toBe(before);
    expect(tokenCalls(ctx.world)).toHaveLength(1);
  });

  it('invalid_grant on exchange discards the code', async () => {
    const ctx = setup();
    ctx.world.tokenHandler = () => json(400, { error: 'invalid_grant' });
    await expect(login(ctx)).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(ctx.store.listAccounts()).toHaveLength(0);
  });

  describe('ID token validation (local RSA key + fake JWKS)', () => {
    const cases = [
      ['bad signature', (w) => { w.idTokenSigner = makeKeys().privateKey; }, 'bad_signature'],
      ['wrong issuer (wrong-host authentication)', (w) => { w.idTokenClaims = { iss: 'https://auth.evil.example' }; }, 'wrong_issuer'],
      ['wrong audience', (w) => { w.idTokenClaims = { aud: 'oaiapp_someone_else' }; }, 'wrong_audience'],
      ['expired', (w) => { w.idTokenClaims = { exp: Math.floor(w.now() / 1000) - 3600 }; }, 'expired'],
      ['nonce mismatch', (w) => { w.idTokenClaims = { nonce: 'replayed-nonce' }; }, 'nonce_mismatch'],
      ['unknown kid', (w) => { w.idTokenHeader = { alg: 'RS256', kid: 'nope' }; }, 'unknown_kid'],
      ['HS256 alg confusion', (w) => { w.idTokenHeader = { alg: 'HS256', kid: 'k1' }; }, 'unsupported_alg'],
    ];
    for (const [name, mutate, reason] of cases) {
      it(`rejects: ${name}`, async () => {
        const ctx = setup();
        mutate(ctx.world);
        await expect(login(ctx)).rejects.toMatchObject({ code: 'id_token_invalid', reason });
        expect(ctx.store.listAccounts()).toHaveLength(0);
      });
    }
    it('rejects alg none outright', async () => {
      const keys = makeKeys();
      const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const t = `${enc({ alg: 'none', kid: 'k1' })}.${enc({ iss: 'https://auth.openai.com', aud: 'a', sub: 's', exp: 9e9, nonce: 'n' })}.x`;
      await expect(verifyIdToken(t, { jwks: { keys: [keys.jwk] }, issuer: 'https://auth.openai.com', audience: 'a', nonce: 'n', now: Date.now() })).rejects.toMatchObject({ reason: 'unsupported_alg' });
      const ok = signJwt(keys.privateKey, { iss: 'https://auth.openai.com', aud: ['a', 'b'], azp: 'a', sub: 's', exp: 9e9, nonce: 'n' });
      await expect(verifyIdToken(ok, { jwks: { keys: [keys.jwk] }, issuer: 'https://auth.openai.com', audience: 'a', nonce: 'n', now: Date.now() })).resolves.toMatchObject({ sub: 's' });
    });
  });

  it('returning account whose identity changed is rejected (cross-account mix-up)', async () => {
    const ctx = setup();
    const first = await login(ctx);
    const before = readFileSync(ctx.store.accountFile(first.account.label), 'utf8');
    ctx.world.sub = 'different-user';
    withBrowser(ctx, (q) => ({ code: 'c2', state: q.get('state') }));
    await expect(login(ctx, { account: first.account.label })).rejects.toMatchObject({ code: 'identity_mismatch' });
    expect(readFileSync(ctx.store.accountFile(first.account.label), 'utf8')).toBe(before);
  });

  it('missing chatgpt.tokens.use.direct → signed in, plan usage disabled, inference refused without a request', async () => {
    const ctx = setup();
    ctx.world.tokenScope = 'openid profile email offline_access resource.invoke';
    const r = await login(ctx);
    expect(r.planUsage).toBe('disabled');
    expect(r.showWelcome).toBe(false);
    expect(ctx.store.listAccounts()).toHaveLength(1);
    const openai = new OpenAIClient({ auth: ctx.auth, fetch: ctx.world.fetch });
    await expect(openai.stream({ label: r.account.label, model: 'm', input: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ code: 'plan_usage_disabled' });
    expect(ctx.world.calls.some((c) => c.url.startsWith('https://api.openai.com/'))).toBe(false);
  });

  it('plan usage is decided by the token response scope, not the callback scope', async () => {
    const ctx = setup();
    ctx.world.tokenScope = 'openid profile email offline_access';
    const r = await login(ctx); // callback still advertises the full scope
    expect(r.planUsage).toBe('disabled');
  });
});

describe('accounts', () => {
  it('multiple registrations stay separate; switching never mixes client ids and tokens', async () => {
    const ctx = setup();
    const a = await login(ctx);
    ctx.world.sub = 'user-sub-2';
    ctx.world.email = 'other@example.com';
    ctx.world.clientId = 'oaiapp_issued_2';
    withBrowser(ctx, (q) => ({ code: 'c2', state: q.get('state'), client_id: 'oaiapp_issued_2' }));
    const b = await login(ctx);
    expect(a.account.label).not.toBe(b.account.label);
    expect(ctx.store.activeLabel()).toBe(b.account.label);
    const ra = ctx.store.readAccount(a.account.label);
    const rb = ctx.store.readAccount(b.account.label);
    expect([ra.client_id, rb.client_id]).toEqual(['oaiapp_issued_1', 'oaiapp_issued_2']);
    expect(ra.access_token).not.toBe(rb.access_token);
    expect(ra.ext_agent_host_id).toBe(rb.ext_agent_host_id);
    ctx.store.setActive(a.account.label);
    expect(ctx.store.activeAccount().client_id).toBe('oaiapp_issued_1');
    expect(() => ctx.store.setActive('nope')).toThrow();
  });

  it('same email, different registration gets a distinct label', async () => {
    const ctx = setup();
    const a = await login(ctx);
    ctx.world.sub = 'user-sub-2'; ctx.world.clientId = 'oaiapp_issued_2';
    withBrowser(ctx, (q) => ({ code: 'c2', state: q.get('state'), client_id: 'oaiapp_issued_2' }));
    const b = await login(ctx);
    expect(a.account.label).toBe('user@example.com');
    expect(b.account.label).toBe('user@example.com-2');
  });
});

describe('models', () => {
  it('keeps only visibility=list models in server order', async () => {
    const ctx = setup();
    const r = await login(ctx);
    ctx.world.modelsBody = { models: [
      { slug: 'b-model', display_name: 'B', visibility: 'list' },
      { slug: 'hidden', display_name: 'H', visibility: 'hide' },
      { slug: 'a-model', display_name: 'A', visibility: 'list' },
      { slug: 'none', display_name: 'N' },
    ] };
    const openai = new OpenAIClient({ auth: ctx.auth, fetch: ctx.world.fetch });
    expect(await openai.listModels(r.account.label)).toEqual([{ slug: 'b-model', display_name: 'B' }, { slug: 'a-model', display_name: 'A' }]);
    const call = ctx.world.calls.find((c) => c.url === 'https://api.openai.com/v1/models');
    expect(call.headers.get('authorization')).toBe('Bearer AT_SECRET_CHATGPT_1');
  });
});

describe('refresh', () => {
  const expire = (ctx, label) => { const rec = ctx.store.readAccount(label); rec.saved_at = new Date(ctx.world.now() - 2 * 3600_000).toISOString(); ctx.store.writeAccount(rec); };

  it('refresh body: issued client id, refresh token, resource, no scope; rotation replaces together', async () => {
    const ctx = setup();
    const r = await login(ctx);
    expire(ctx, r.account.label);
    const { token } = await ctx.auth.accessToken(r.account.label);
    expect(token).toBe('AT_SECRET_CHATGPT_2');
    const f = new URLSearchParams(tokenCalls(ctx.world)[1].body);
    expect(Object.fromEntries(f)).toEqual({ grant_type: 'refresh_token', client_id: 'oaiapp_issued_1', refresh_token: 'RT_SECRET_CHATGPT_1', resource: 'https://api.openai.com/v1' });
    expect(ctx.store.readAccount(r.account.label)).toMatchObject({ access_token: 'AT_SECRET_CHATGPT_2', refresh_token: 'RT_SECRET_CHATGPT_2', expires_in: 3600 });
  });

  for (const code of ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']) {
    it(`terminal refresh error ${code} clears tokens and requires login`, async () => {
      const ctx = setup();
      const r = await login(ctx);
      expire(ctx, r.account.label);
      ctx.world.refreshHandler = () => json(400, { error: code });
      await expect(ctx.auth.accessToken(r.account.label)).rejects.toMatchObject({ code: 'reauth_required' });
      const rec = ctx.store.readAccount(r.account.label);
      expect(rec.access_token).toBeUndefined();
      expect(rec.refresh_token).toBeUndefined();
      expect(rec.client_id).toBe('oaiapp_issued_1');
    });
  }

  it('invalid_client is a configuration error; 5xx keeps credentials', async () => {
    const ctx = setup();
    const r = await login(ctx);
    expire(ctx, r.account.label);
    ctx.world.refreshHandler = () => json(401, { error: 'invalid_client' });
    await expect(ctx.auth.accessToken(r.account.label)).rejects.toMatchObject({ code: 'invalid_client' });
    ctx.world.refreshHandler = () => json(502, {});
    await expect(ctx.auth.accessToken(r.account.label)).rejects.toMatchObject({ code: 'refresh_failed' });
    expect(ctx.store.readAccount(r.account.label).refresh_token).toBe('RT_SECRET_CHATGPT_1');
  });
});

describe('sign out', () => {
  it('revocation success: posts refresh token to discovered endpoint, clears tokens, keeps mapping + host id', async () => {
    const ctx = setup();
    const r = await login(ctx);
    const hostId = ctx.store.hostId();
    const out = await ctx.auth.logout(r.account.label);
    expect(out.revoked).toBe(true);
    const rev = ctx.world.calls.filter((c) => c.url === 'https://auth.openai.com/oauth/revoke');
    expect(rev).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(rev[0].body))).toEqual({ token: 'RT_SECRET_CHATGPT_1', token_type_hint: 'refresh_token', client_id: 'oaiapp_issued_1' });
    const rec = ctx.store.readAccount(r.account.label);
    expect(rec.access_token ?? rec.refresh_token ?? rec.id_token).toBeUndefined();
    expect(rec.client_id).toBe('oaiapp_issued_1');
    expect(ctx.store.hostId()).toBe(hostId);
    expect(existsSync(ctx.store.path('host-id.json'))).toBe(true);
  });

  it('revocation unconfirmed after bounded 5xx retries: clears locally and says so', async () => {
    const ctx = setup();
    const r = await login(ctx);
    ctx.world.revokeHandler = () => new Response('', { status: 503 });
    const out = await ctx.auth.logout(r.account.label);
    expect(out.revoked).toBe(false);
    expect(out.message).toMatch(/NOT confirmed/);
    expect(ctx.world.calls.filter((c) => c.url === 'https://auth.openai.com/oauth/revoke')).toHaveLength(4);
    expect(ctx.store.readAccount(r.account.label).refresh_token).toBeUndefined();
  });

  it('network failures are retried then reported unconfirmed', async () => {
    const ctx = setup();
    const r = await login(ctx);
    ctx.world.revokeHandler = () => { throw new TypeError('fetch failed'); };
    const out = await ctx.auth.logout(r.account.label);
    expect(out.revoked).toBe(false);
  });
});
