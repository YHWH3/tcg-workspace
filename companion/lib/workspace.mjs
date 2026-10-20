// TCG Workspace side: standard OAuth 2.1 (DCR + Authorization Code + PKCE)
// against the Workspace server, and a minimal Streamable-HTTP MCP client.
// Workspace credentials are stored separately from ChatGPT credentials and
// are only ever sent to the Workspace origin.
import { COMPANION_VERSION, AGENT_NAME, WORKSPACE_CALLBACK_PATH } from './constants.mjs';
import { AuthError, CompanionError, ReauthRequired } from './errors.mjs';
import { startCallbackServer } from './loopback.mjs';
import { formBody, guardedFetch, pkcePair, randomToken, readBody, realSleep, withFileLock } from './util.mjs';
import { parseSse } from './openai.mjs';

const REFRESH_MARGIN_MS = 60_000;
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Normalize and vet a Workspace origin. https only, except plain-http
 * loopback for local development.
 * @param {string} input
 */
export function normalizeOrigin(input) {
  let u;
  try { u = new URL(String(input)); } catch { throw new CompanionError('bad_origin', `Not a valid URL: ${input}`); }
  if (u.username || u.password) throw new CompanionError('bad_origin', 'Workspace origin must not contain credentials.');
  if (u.protocol === 'https:') return u.origin;
  if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u.origin;
  throw new CompanionError('bad_origin', 'Workspace origin must use https (http is allowed only for 127.0.0.1/localhost development).');
}

const sameOrigin = (url, origin) => { try { return new URL(url).origin === origin; } catch { return false; } };

export class WorkspaceAuth {
  /**
   * @param {{store: import('./store.mjs').CompanionStore, fetch?: typeof fetch, now?: () => number,
   *   openBrowser?: (url:string)=>Promise<void>, log?: (m:string)=>void, lockWait?: (ms:number)=>Promise<void>}} deps
   */
  constructor(deps) {
    this.store = deps.store;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
    this.openBrowser = deps.openBrowser;
    this.log = deps.log ?? (() => {});
    this.lockWait = deps.lockWait ?? realSleep;
    this.inflight = null;
  }

  /** Fetch restricted to exactly this Workspace origin. */
  httpFor(origin) { return guardedFetch(this.fetchImpl, [origin], 'Workspace'); }

  async metadata(origin) {
    const http = this.httpFor(origin);
    const res = await http(`${origin}/.well-known/oauth-authorization-server`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new CompanionError('workspace_discovery_failed', `Workspace OAuth discovery failed (HTTP ${res.status}).`);
    const m = await res.json();
    const issuer = String(m.issuer ?? '').replace(/\/$/, '');
    if (issuer !== origin) throw new CompanionError('workspace_discovery_untrusted', 'Workspace OAuth metadata issuer does not match the Workspace origin.');
    for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
      if (!m[k] || !sameOrigin(m[k], origin)) throw new CompanionError('workspace_discovery_untrusted', `Workspace ${k} is missing or not on ${origin}.`);
    }
    if (Array.isArray(m.code_challenge_methods_supported) && !m.code_challenge_methods_supported.includes('S256')) {
      throw new CompanionError('workspace_discovery_untrusted', 'Workspace does not support PKCE S256.');
    }
    return m;
  }

  /**
   * `connect <origin>`: register (or reuse) a public client and run the
   * browser consent where the human chooses which spaces to share.
   * @param {string} originInput
   * @param {{port?:number, timeoutMs?:number}} [opts]
   */
  async connect(originInput, opts = {}) {
    const origin = normalizeOrigin(originInput);
    const http = this.httpFor(origin);
    const meta = await this.metadata(origin);
    const state = randomToken(32);
    const pkce = pkcePair();
    const server = await startCallbackServer({ path: WORKSPACE_CALLBACK_PATH, port: opts.port ?? 0, expectedState: state, timeoutMs: opts.timeoutMs });
    let params;
    let clientId;
    const resource = `${origin}/mcp`;
    try {
      const prior = this.store.readWorkspace();
      clientId = prior?.origin === origin ? prior.client_id : null;
      if (!clientId) {
        const reg = await http(meta.registration_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            client_name: AGENT_NAME,
            redirect_uris: [`http://127.0.0.1:${server.port}${WORKSPACE_CALLBACK_PATH}`],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
          }),
        });
        const body = await readBody(reg);
        if (!reg.ok || !body.client_id) throw new CompanionError('workspace_registration_failed', `Workspace client registration failed (HTTP ${reg.status}).`);
        clientId = body.client_id;
      }
      const u = new URL(meta.authorization_endpoint);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', server.redirectUri);
      if (Array.isArray(meta.scopes_supported) && meta.scopes_supported.includes('mcp')) u.searchParams.set('scope', 'mcp');
      u.searchParams.set('state', state);
      u.searchParams.set('code_challenge', pkce.challenge);
      u.searchParams.set('code_challenge_method', 'S256');
      u.searchParams.set('resource', resource);
      this.log(`Opening your browser to connect ${origin}. Choose which spaces the companion may access on the Workspace consent page.`);
      try { await this.openBrowser?.(u.href); } catch { this.log(`Open this URL to continue:\n${u.href}`); }
      params = await server.waitForCallback();
    } finally {
      server.close();
    }
    if (params.get('error') === 'access_denied') throw new AuthError('access_denied', 'Workspace access was declined. Nothing was saved.');
    if (params.get('error')) throw new AuthError('authorization_error', `Workspace authorization failed: ${params.get('error')}`);
    const code = params.get('code');
    if (!code) throw new AuthError('missing_code', 'Workspace callback had no code.');
    const res = await http(meta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: formBody({ grant_type: 'authorization_code', code, redirect_uri: server.redirectUri, client_id: clientId, code_verifier: pkce.verifier, resource }),
    });
    const tok = await readBody(res);
    if (!res.ok || !tok.access_token) throw new AuthError('workspace_token_failed', `Workspace token exchange failed (HTTP ${res.status}${tok.error ? `, ${tok.error}` : ''}).`);
    const rec = {
      origin, client_id: clientId, token_endpoint: meta.token_endpoint, resource,
      access_token: tok.access_token, refresh_token: tok.refresh_token ?? null,
      expires_in: Number(tok.expires_in ?? 3600), scope: tok.scope ?? null,
      saved_at: new Date(this.now()).toISOString(),
    };
    this.store.writeWorkspace(rec);
    return { origin, scope: rec.scope };
  }

  /** @returns {Promise<{token:string, origin:string}>} */
  async accessToken({ force = false } = {}) {
    const rec = this.store.readWorkspace();
    if (!rec?.access_token && !rec?.refresh_token) throw new ReauthRequired('Not connected to a Workspace. Run `tcg-companion connect <origin>`.');
    const exp = Date.parse(rec.saved_at) + Number(rec.expires_in ?? 0) * 1000;
    if (force || !rec.access_token || this.now() >= exp - REFRESH_MARGIN_MS) {
      const fresh = await this.refresh(rec.refresh_token);
      return { token: fresh.access_token, origin: fresh.origin };
    }
    return { token: rec.access_token, origin: rec.origin };
  }

  refresh(observed) {
    if (this.inflight) return this.inflight;
    this.inflight = withFileLock(this.store.workspaceLock(), async () => {
      const rec = this.store.readWorkspace();
      if (!rec?.refresh_token) throw new ReauthRequired('Workspace session expired. Run `tcg-companion connect <origin>` again.');
      const exp = Date.parse(rec.saved_at) + Number(rec.expires_in ?? 0) * 1000;
      if (rec.refresh_token !== observed && rec.access_token && this.now() < exp) return rec;
      if (!sameOrigin(rec.token_endpoint, rec.origin)) throw new CompanionError('workspace_config', 'Stored Workspace token endpoint is not on the Workspace origin.');
      const res = await this.httpFor(rec.origin)(rec.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: formBody({ grant_type: 'refresh_token', refresh_token: rec.refresh_token, client_id: rec.client_id, resource: rec.resource }),
      });
      const body = await readBody(res);
      if (!res.ok || !body.access_token) {
        if (res.status === 400 || res.status === 401) {
          this.store.writeWorkspace({ ...rec, access_token: null, refresh_token: null });
          throw new ReauthRequired('Workspace session ended. Run `tcg-companion connect <origin>` again.');
        }
        throw new CompanionError('workspace_refresh_failed', `Workspace token refresh failed (HTTP ${res.status}); try again later.`);
      }
      const next = { ...rec, access_token: body.access_token, refresh_token: body.refresh_token ?? rec.refresh_token,
        expires_in: Number(body.expires_in ?? 3600), scope: body.scope ?? rec.scope, saved_at: new Date(this.now()).toISOString() };
      this.store.writeWorkspace(next);
      return next;
    }, { now: this.now, wait: this.lockWait }).finally(() => { this.inflight = null; });
    return this.inflight;
  }
}

export class McpError extends CompanionError {}

/** Minimal Streamable-HTTP MCP client (JSON-RPC over POST <origin>/mcp). */
export class McpClient {
  /** @param {{auth: WorkspaceAuth, fetch?: typeof fetch}} deps */
  constructor(deps) {
    this.auth = deps.auth;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.sessionId = null;
    this.protocolVersion = null;
    this.nextId = 1;
    this.origin = null;
  }

  async post(message, retried = false) {
    const { token, origin } = await this.auth.accessToken();
    this.origin = origin;
    const http = guardedFetch(this.fetchImpl, [origin], 'Workspace MCP');
    /** @type {Record<string,string>} */
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
    const res = await http(`${origin}/mcp`, { method: 'POST', headers, body: JSON.stringify(message) });
    if (res.status === 401 && !retried) {
      await this.auth.accessToken({ force: true });
      return this.post(message, true);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202) return null;
    if (!res.ok) throw new McpError('mcp_http_error', `Workspace MCP request failed (HTTP ${res.status}).`);
    if (!('id' in message)) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/event-stream')) {
      if (!res.body) return null;
      for await (const { data } of parseSse(res.body)) {
        let msg; try { msg = JSON.parse(data); } catch { continue; }
        if (msg && msg.id === message.id) return msg;
      }
      throw new McpError('mcp_no_response', 'Workspace MCP stream ended without a response.');
    }
    const text = await res.text();
    if (!text) return null;
    const msg = JSON.parse(text);
    return Array.isArray(msg) ? msg.find((m) => m.id === message.id) : msg;
  }

  async request(method, params) {
    const id = this.nextId++;
    const msg = await this.post({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    if (!msg) throw new McpError('mcp_no_response', `No response to ${method}.`);
    if (msg.error) throw new McpError('mcp_rpc_error', `Workspace MCP ${method} failed: ${msg.error.message ?? msg.error.code}`);
    return msg.result;
  }

  async notify(method, params) {
    await this.post({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'tcg-workspace-companion', version: COMPANION_VERSION },
    });
    this.protocolVersion = result?.protocolVersion ?? MCP_PROTOCOL_VERSION;
    await this.notify('notifications/initialized');
    return result;
  }

  async listTools(maxPages = 10) {
    const tools = [];
    let cursor;
    for (let i = 0; i < maxPages; i++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async listPrompts() {
    try { return (await this.request('prompts/list', {}))?.prompts ?? []; } catch { return []; }
  }

  async callTool(name, args) { return this.request('tools/call', { name, arguments: args ?? {} }); }
}
