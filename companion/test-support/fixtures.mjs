// Test-only fixtures: an in-process fake of the OpenAI auth/API hosts and of a
// TCG Workspace server, all reached through an injected `fetch`. Nothing here
// touches the network. The "browser" is a function that performs a real HTTP
// GET against the companion's 127.0.0.1 loopback listener.
import { createSign, generateKeyPairSync } from 'node:crypto';
import { request } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FULL_SCOPE = 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke';
export const WS_ORIGIN = 'https://ws.example.test';

export const tempDir = () => mkdtempSync(join(tmpdir(), 'tcg-companion-test-'));

export function makeKeys(kid = 'k1') {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  return { privateKey, jwk, kid };
}

export function signJwt(privateKey, payload, header = { alg: 'RS256', kid: 'k1', typ: 'JWT' }) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc(header)}.${enc(payload)}`;
  const sig = createSign('RSA-SHA256').update(data).sign(privateKey).toString('base64url');
  return `${data}.${sig}`;
}

export const json = (status, body, headers = {}) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export function sseResponse(events, { headers = {}, status = 200 } = {}) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const ev of events) c.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
      c.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_test_1', ...headers } });
}

export const textDelta = (t) => ({ type: 'response.output_text.delta', delta: t });
export const completed = (output = []) => ({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output } });
export const assistantMsg = (text) => ({ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text }] });
export const fnCall = (name, args, callId = 'call_1', namespace = 'tcg_workspace') => ({ type: 'function_call', id: `fc_${callId}`, call_id: callId, name, namespace, arguments: JSON.stringify(args) });

/** Real HTTP GET to the loopback listener with explicit headers. */
export function httpGet(url, headers = {}) {
  const u = new URL(url);
  return new Promise((resolve) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: headers[':method'] ?? 'GET',
      headers: { Host: `${u.hostname}:${u.port}`, Connection: 'close', ...Object.fromEntries(Object.entries(headers).filter(([k]) => !k.startsWith(':'))) } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code }));
    req.end();
  });
}

/** Headers a browser sends on the legitimate cross-site authorization redirect. */
export const NAV_HEADERS = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-User': '?1' };

/**
 * Fake OpenAI (auth.openai.com + api.openai.com) and Workspace origin.
 * Every request is recorded in `world.calls`.
 */
export function makeWorld(opts = {}) {
  const keys = opts.keys ?? makeKeys();
  const world = {
    keys,
    calls: /** @type {{url:string, method:string, headers:Headers, body:string}[]} */ ([]),
    now: opts.now ?? (() => Date.parse('2026-10-20T12:00:00Z')),
    clientId: 'oaiapp_issued_1',
    sub: 'user-sub-1',
    email: 'user@example.com',
    tokenScope: FULL_SCOPE,
    nonce: null,
    authorizeUrls: [],
    tokenSeq: 0,
    /** override hooks */
    idTokenClaims: {},
    idTokenSigner: null,
    idTokenHeader: null,
    tokenHandler: null,
    refreshHandler: null,
    revokeHandler: null,
    responsesHandler: null,
    modelsBody: { models: [] },
    ws: { tools: [], callTool: null, sessionId: 'mcp-sess-1', tokenSeq: 0 },
  };

  const idToken = (aud) => signJwt(world.idTokenSigner ?? keys.privateKey, {
    iss: 'https://auth.openai.com', aud, sub: world.sub, email: world.email, nonce: world.nonce,
    iat: Math.floor(world.now() / 1000), exp: Math.floor(world.now() / 1000) + 3600, ...world.idTokenClaims,
  }, world.idTokenHeader ?? { alg: 'RS256', kid: keys.kid, typ: 'JWT' });

  const issue = () => {
    const n = ++world.tokenSeq;
    return { access_token: `AT_SECRET_CHATGPT_${n}`, refresh_token: `RT_SECRET_CHATGPT_${n}`, id_token: idToken(world.clientId), token_type: 'Bearer', expires_in: 3600, scope: world.tokenScope };
  };

  async function handleOpenAI(u, method, body) {
    if (u.href === 'https://auth.openai.com/.well-known/openid-configuration') {
      return json(200, { issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/oauth/revoke', token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token' });
    }
    if (u.href === 'https://auth.openai.com/.well-known/jwks.json') return json(200, { keys: [keys.jwk] });
    if (u.href === 'https://auth.openai.com/api/accounts/oauth/token' && method === 'POST') {
      const f = new URLSearchParams(body);
      if (f.get('grant_type') === 'authorization_code') {
        if (world.tokenHandler) return world.tokenHandler(f);
        return json(200, issue());
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (world.refreshHandler) return world.refreshHandler(f);
        await new Promise((r) => setTimeout(r, 30)); // widen the race window
        const t = issue();
        delete t.id_token;
        return json(200, t);
      }
    }
    if (u.href === 'https://auth.openai.com/oauth/revoke' && method === 'POST') {
      return world.revokeHandler ? world.revokeHandler(new URLSearchParams(body)) : new Response('', { status: 200 });
    }
    if (u.href === 'https://api.openai.com/v1/models') return json(200, world.modelsBody);
    if (u.href === 'https://api.openai.com/v1/responses' && method === 'POST') {
      if (!world.responsesHandler) return sseResponse([textDelta('ok'), completed([assistantMsg('ok')])]);
      return world.responsesHandler(JSON.parse(body));
    }
    return json(404, { error: 'not_found' });
  }

  async function handleWorkspace(u, method, body, headers) {
    const o = WS_ORIGIN;
    if (u.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, { issuer: o, authorization_endpoint: `${o}/oauth/authorize`, token_endpoint: `${o}/token`, registration_endpoint: `${o}/register`, scopes_supported: ['mcp'], code_challenge_methods_supported: ['S256'] });
    }
    if (u.pathname === '/register' && method === 'POST') return json(201, { client_id: 'ws-client-1', ...JSON.parse(body) });
    if (u.pathname === '/token' && method === 'POST') {
      const n = ++world.ws.tokenSeq;
      return json(200, { access_token: `WS_SECRET_AT_${n}`, refresh_token: `WS_SECRET_RT_${n}`, token_type: 'bearer', expires_in: 3600, scope: 'mcp' });
    }
    if (u.pathname === '/mcp' && method === 'POST') {
      if (!/^Bearer WS_SECRET_AT_/.test(headers.get('authorization') ?? '')) return json(401, { error: 'invalid_token' });
      const msg = JSON.parse(body);
      if (msg.method === 'initialize') return json(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Workspace', version: 't' } } }, { 'mcp-session-id': world.ws.sessionId });
      if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (msg.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: msg.id, result: { tools: world.ws.tools } });
      if (msg.method === 'tools/call') {
        const result = world.ws.callTool ? await world.ws.callTool(msg.params.name, msg.params.arguments) : { content: [{ type: 'text', text: '{}' }] };
        // Respond as SSE to exercise that path.
        const enc = new TextEncoder();
        const stream = new ReadableStream({ start(c) { c.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`)); c.close(); } });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (msg.method === 'prompts/list') return json(200, { jsonrpc: '2.0', id: msg.id, result: { prompts: [] } });
    }
    return json(404, { error: 'not_found' });
  }

  world.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = init.body === undefined ? '' : String(init.body);
    world.calls.push({ url: u.href, method, headers, body });
    if (u.origin === 'https://auth.openai.com' || u.origin === 'https://api.openai.com') return handleOpenAI(u, method, body);
    if (u.origin === WS_ORIGIN) return handleWorkspace(u, method, body, headers);
    throw new Error(`fixture: unexpected network call to ${u.origin}`);
  };

  /**
   * Fake system browser for SIWC: records the authorize URL, captures the
   * nonce, then (asynchronously) hits the loopback callback.
   * `callback(q)` may return the query object to send, or null to send nothing.
   */
  world.browser = (callback) => async (url) => {
    const q = new URL(url).searchParams;
    world.authorizeUrls.push(url);
    world.nonce = q.get('nonce');
    const params = callback ? callback(q) : { code: 'AUTHCODE_1', state: q.get('state'), client_id: world.clientId, scope: FULL_SCOPE };
    if (!params) return;
    const cb = new URL(q.get('redirect_uri'));
    for (const [k, v] of Object.entries(params)) if (v !== undefined) cb.searchParams.set(k, v);
    setTimeout(() => { world.lastCallback = httpGet(cb.href, NAV_HEADERS); }, 5);
  };

  /** Fake browser for the Workspace consent page. */
  world.wsBrowser = async (url) => {
    const q = new URL(url).searchParams;
    world.wsAuthorizeUrl = url;
    const cb = new URL(q.get('redirect_uri'));
    cb.searchParams.set('code', 'WS_CODE_1');
    cb.searchParams.set('state', q.get('state'));
    setTimeout(() => { httpGet(cb.href, NAV_HEADERS); }, 5);
  };

  return world;
}

/** Collecting writable for stdout/stderr capture. */
export function sink() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
}
