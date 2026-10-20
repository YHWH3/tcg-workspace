// Sign in with ChatGPT — open-source/local plan-usage flow.
// Spec: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
//       https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
//       https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
import {
  AGENT_NAME, DYNAMIC_CLIENT_ID, LOOPBACK_HOST, OPENAI_AUTHORIZE_URL, OPENAI_DISCOVERY_URL,
  OPENAI_ISSUER, OPENAI_RESOURCE, OPENAI_TOKEN_URL, PLAN_SCOPE, SIWC_CALLBACK_PATH,
  SIWC_DEFAULT_PORT, SIWC_SCOPES, TERMINAL_REFRESH_ERRORS,
} from './constants.mjs';
import { AuthError, CompanionError, ReauthRequired } from './errors.mjs';
import { IdTokenError, verifyIdToken } from './jwt.mjs';
import { startCallbackServer } from './loopback.mjs';
import { publicAccount } from './store.mjs';
import { formBody, guardedFetch, pkcePair, randomToken, readBody, realSleep, withFileLock } from './util.mjs';

const AUTH_ORIGIN = new URL(OPENAI_ISSUER).origin;
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Build the authorization URL exactly per the SIWC sign-in spec.
 * @param {{clientId:string, hostId:string, redirectUri:string, state:string, nonce:string,
 *   codeChallenge:string, firstRegistration:boolean, idTokenHint?:string, loginHint?:string,
 *   reconsent?:boolean}} p
 */
export function buildAuthorizeUrl(p) {
  const r = new URL(p.redirectUri);
  if (r.protocol !== 'http:' || r.hostname !== LOOPBACK_HOST || r.pathname !== SIWC_CALLBACK_PATH || r.search || r.hash) {
    throw new Error('SIWC redirect_uri must be http://127.0.0.1:<port>/auth/callback');
  }
  if (p.firstRegistration && p.clientId !== DYNAMIC_CLIENT_ID) throw new Error('first registration must use dynamic_agent_client');
  if (!p.firstRegistration && (p.clientId === DYNAMIC_CLIENT_ID || !p.clientId)) throw new Error('reauthorization must use the saved issued client id');
  const u = new URL(OPENAI_AUTHORIZE_URL);
  const q = u.searchParams;
  q.set('client_id', p.clientId);
  if (p.firstRegistration) q.set('agent_name_hint', AGENT_NAME);
  q.set('ext_agent_host_id', p.hostId);
  if (!p.firstRegistration && p.idTokenHint) q.set('id_token_hint', p.idTokenHint);
  if (!p.firstRegistration && p.loginHint) q.set('login_hint', p.loginHint);
  q.set('response_type', 'code');
  q.set('redirect_uri', p.redirectUri);
  q.set('scope', SIWC_SCOPES.join(' '));
  q.set('resource', OPENAI_RESOURCE);
  q.set('state', p.state);
  q.set('nonce', p.nonce);
  q.set('code_challenge_method', 'S256');
  q.set('code_challenge', p.codeChallenge);
  // Only when the user explicitly re-enables plan usage after declining it.
  // https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
  if (p.reconsent) q.set('prompt', 'consent');
  return u.href;
}

/**
 * Interpret the (state-validated) callback parameters.
 * @param {URLSearchParams} params
 * @param {{firstRegistration:boolean, expectedClientId?:string}} pending
 * @returns {{code:string, clientId:string, callbackScope:string|null}}
 */
export function interpretCallback(params, pending) {
  const error = params.get('error');
  if (error === 'access_denied') {
    throw new AuthError('access_denied', 'Sign-in was declined in the browser. Nothing was saved; ChatGPT plan usage is not enabled.');
  }
  if (error) throw new AuthError('authorization_error', `Authorization failed: ${error}`);
  const code = params.get('code');
  if (!code) throw new AuthError('missing_code', 'The authorization callback did not include a code.');
  const cbClient = params.get('client_id');
  if (pending.firstRegistration) {
    if (!cbClient || cbClient === DYNAMIC_CLIENT_ID) {
      throw new AuthError('registration_incomplete', 'Registration is incomplete: the callback did not return an issued client id. Start sign-in again.');
    }
    return { code, clientId: cbClient, callbackScope: params.get('scope') };
  }
  if (cbClient && cbClient !== pending.expectedClientId) {
    throw new AuthError('client_mismatch', 'The callback returned a different client id than the selected account’s registration; result rejected.');
  }
  return { code, clientId: /** @type {string} */ (pending.expectedClientId), callbackScope: params.get('scope') };
}

export const scopesOf = (scope) => (typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : []);
export const planUsageActive = (rec) => Boolean(rec?.scopes?.includes(PLAN_SCOPE));
const expiresAtMs = (rec) => Date.parse(rec.saved_at) + Number(rec.expires_in ?? 0) * 1000;

const defaultOpenBrowser = async (url) => {
  const { spawn } = await import('node:child_process');
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  await new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.once('error', rej);
    child.once('spawn', () => { child.unref(); res(undefined); });
  });
};

export class ChatGPTAuth {
  /**
   * @param {{store: import('./store.mjs').CompanionStore, fetch?: typeof fetch, now?: () => number,
   *   openBrowser?: (url:string)=>Promise<void>, log?: (msg:string)=>void, sleep?: (ms:number)=>Promise<void>,
   *   lockWait?: (ms:number)=>Promise<void>}} deps
   */
  constructor(deps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.http = guardedFetch(deps.fetch ?? globalThis.fetch, [AUTH_ORIGIN], 'ChatGPT auth');
    this.openBrowser = deps.openBrowser ?? defaultOpenBrowser;
    this.log = deps.log ?? (() => {});
    this.sleep = deps.sleep ?? realSleep;
    this.lockWait = deps.lockWait ?? realSleep;
    /** @type {Map<string, Promise<any>>} in-process refresh serialization */
    this.refreshing = new Map();
    this._discovery = null;
  }

  /** OpenID configuration, pinned to the OpenAI issuer and host. */
  async discovery() {
    if (this._discovery) return this._discovery;
    const res = await this.http(OPENAI_DISCOVERY_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new CompanionError('discovery_failed', `OpenID discovery failed (HTTP ${res.status}).`);
    const d = await res.json();
    if (d.issuer !== OPENAI_ISSUER) throw new CompanionError('discovery_untrusted', 'OpenID discovery returned an unexpected issuer.');
    for (const k of ['jwks_uri', 'revocation_endpoint']) {
      if (d[k] !== undefined && new URL(d[k]).origin !== AUTH_ORIGIN) {
        throw new CompanionError('discovery_untrusted', `OpenID discovery ${k} is not on ${AUTH_ORIGIN}.`);
      }
    }
    if (!d.jwks_uri) throw new CompanionError('discovery_failed', 'OpenID discovery has no jwks_uri.');
    this._discovery = d;
    return d;
  }

  async jwks() {
    const { jwks_uri } = await this.discovery();
    const res = await this.http(jwks_uri, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new CompanionError('jwks_failed', `Could not fetch OpenAI signing keys (HTTP ${res.status}).`);
    return res.json();
  }

  async validateIdToken(idToken, audience, nonce) {
    try {
      return await verifyIdToken(idToken, { jwks: await this.jwks(), issuer: OPENAI_ISSUER, audience, nonce, now: this.now() });
    } catch (e) {
      if (e instanceof IdTokenError) throw new AuthError('id_token_invalid', `${e.message}. Nothing was saved.`, { reason: e.reason });
      throw e;
    }
  }

  /**
   * Full browser sign-in. `account` selects an existing registration
   * (reauthorization); otherwise a new registration is created.
   * @param {{account?:string, label?:string, port?:number, reconsent?:boolean, timeoutMs?:number}} [opts]
   */
  async login(opts = {}) {
    const existing = opts.account ? this.store.readAccount(opts.account) : null;
    if (opts.account && !existing) throw new CompanionError('unknown_account', `No saved ChatGPT account named "${opts.account}".`);
    const firstRegistration = !existing;
    const hostId = this.store.hostId(); // persisted before the first sign-in
    const state = randomToken(32);
    const nonce = randomToken(32);
    const pkce = pkcePair();
    const server = await startCallbackServer({
      path: SIWC_CALLBACK_PATH, port: opts.port ?? SIWC_DEFAULT_PORT, expectedState: state, timeoutMs: opts.timeoutMs,
    });
    const redirectUri = server.redirectUri; // identical in authorize and exchange
    const clientId = firstRegistration ? DYNAMIC_CLIENT_ID : existing.client_id;
    const urlArgs = {
      clientId, hostId, redirectUri, state, nonce, codeChallenge: pkce.challenge, firstRegistration,
      idTokenHint: existing?.id_token, loginHint: existing?.email ?? undefined, reconsent: opts.reconsent,
    };
    let params;
    try {
      const url = buildAuthorizeUrl(urlArgs);
      this.log('Opening your browser: Continue with ChatGPT…');
      try {
        await this.openBrowser(url);
      } catch {
        // Never print a URL containing id_token_hint; the hint is optional.
        this.log(`Could not open a browser. Open this URL to continue:\n${buildAuthorizeUrl({ ...urlArgs, idTokenHint: undefined })}`);
      }
      params = await server.waitForCallback();
    } finally {
      server.close();
    }
    const cb = interpretCallback(params, { firstRegistration, expectedClientId: existing?.client_id });

    // Exchange the code (form POST, no client secret).
    const res = await this.http(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: formBody({
        grant_type: 'authorization_code', client_id: cb.clientId, code: cb.code,
        code_verifier: pkce.verifier, redirect_uri: redirectUri, resource: OPENAI_RESOURCE,
      }),
    });
    const tok = await readBody(res);
    if (!res.ok) {
      const code = typeof tok.error === 'string' ? tok.error : tok.error?.code;
      if (code === 'invalid_grant') {
        throw new AuthError('invalid_grant', 'The authorization code was rejected (invalid_grant). It has been discarded; run login again.', { clientId: cb.clientId });
      }
      throw new AuthError('token_exchange_failed', `Token exchange failed (HTTP ${res.status}${code ? `, ${code}` : ''}).`);
    }
    if (!tok.access_token || !tok.id_token) throw new AuthError('token_exchange_failed', 'Token response is missing access_token or id_token.');

    const claims = await this.validateIdToken(tok.id_token, cb.clientId, nonce);
    if (existing && (claims.sub !== existing.subject || existing.issuer !== OPENAI_ISSUER)) {
      throw new AuthError('identity_mismatch',
        `The ChatGPT account that signed in does not match the selected account "${existing.label}". Credentials were NOT replaced. ` +
        'Use `login` without --account to add it as a separate account.');
    }
    const scopes = scopesOf(tok.scope);
    const label = existing ? existing.label : this.store.uniqueLabel(opts.label ?? claims.email ?? 'chatgpt');
    const planActive = scopes.includes(PLAN_SCOPE);
    const showWelcome = planActive && !existing?.plan_welcome_shown;
    const rec = {
      label,
      email: typeof claims.email === 'string' ? claims.email : null,
      issuer: OPENAI_ISSUER,
      subject: claims.sub,
      client_id: cb.clientId,
      ext_agent_host_id: hostId,
      id_token: tok.id_token,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      token_type: tok.token_type ?? 'Bearer',
      expires_in: Number(tok.expires_in ?? 3600),
      earliest_refresh_at: tok.earliest_refresh_at,
      scopes,
      saved_at: new Date(this.now()).toISOString(),
      plan_welcome_shown: Boolean(existing?.plan_welcome_shown || planActive),
    };
    this.store.writeAccount(rec);
    this.store.setActive(label);
    return { account: publicAccount(rec), planUsage: planActive ? 'active' : 'disabled', showWelcome };
  }

  /**
   * Return a usable access token for the account, refreshing near expiry.
   * @param {string} label
   */
  async accessToken(label) {
    const rec = this.store.readAccount(label);
    if (!rec) throw new ReauthRequired(`No saved ChatGPT account named "${label}". Run login.`);
    if (!rec.access_token && !rec.refresh_token) throw new ReauthRequired(`ChatGPT account "${label}" is signed out. Run login --account "${label}".`);
    if (!rec.access_token || this.now() >= expiresAtMs(rec) - REFRESH_MARGIN_MS) {
      const fresh = await this.refresh(label, rec.refresh_token);
      return { token: fresh.access_token, record: fresh };
    }
    return { token: rec.access_token, record: rec };
  }

  /**
   * Serialized refresh: one in-process promise per account plus a cross-process
   * O_EXCL lock file. After acquiring the lock the record is re-read; if another
   * process already rotated the refresh token, its result is reused and no
   * network call is made.
   * @param {string} label
   * @param {string} [observedRefreshToken] the refresh token the caller saw
   */
  refresh(label, observedRefreshToken) {
    const inflight = this.refreshing.get(label);
    if (inflight) return inflight;
    const p = (async () => {
      const observed = observedRefreshToken ?? this.store.readAccount(label)?.refresh_token;
      return withFileLock(this.store.accountLock(label), async () => {
        const rec = this.store.readAccount(label);
        if (!rec?.refresh_token) throw new ReauthRequired(`ChatGPT account "${label}" needs to sign in again.`);
        if (rec.refresh_token !== observed && rec.access_token && this.now() < expiresAtMs(rec)) {
          return rec; // rotated concurrently by another process — reuse it
        }
        const res = await this.http(OPENAI_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          // omit scope to retain the grant
          body: formBody({ grant_type: 'refresh_token', client_id: rec.client_id, refresh_token: rec.refresh_token, resource: OPENAI_RESOURCE }),
        });
        const body = await readBody(res);
        if (!res.ok) {
          const code = typeof body.error === 'string' ? body.error : body.error?.code;
          if (code && TERMINAL_REFRESH_ERRORS.has(code)) {
            this.store.clearTokens(label, ['access_token', 'refresh_token']);
            throw new ReauthRequired(`ChatGPT session for "${label}" ended (${code}). Run login --account "${label}" to sign in again.`, { refreshError: code });
          }
          if (code === 'invalid_client') {
            throw new CompanionError('invalid_client', `ChatGPT rejected the registration's client id (invalid_client). This is a configuration problem; re-register with \`login\`.`);
          }
          throw new CompanionError('refresh_failed', `Token refresh failed (HTTP ${res.status}${code ? `, ${code}` : ''}); credentials kept, try again later.`, { retryable: true });
        }
        if (!body.access_token) throw new CompanionError('refresh_failed', 'Refresh response had no access_token.');
        const next = { ...rec };
        // Replace access token, expiry, scopes and rotating refresh token together.
        next.access_token = body.access_token;
        next.expires_in = Number(body.expires_in ?? 3600);
        if (body.scope !== undefined) next.scopes = scopesOf(body.scope);
        if (body.refresh_token) next.refresh_token = body.refresh_token;
        if (body.token_type) next.token_type = body.token_type;
        next.earliest_refresh_at = body.earliest_refresh_at;
        next.saved_at = new Date(this.now()).toISOString();
        if (body.id_token) {
          try {
            const c = await verifyIdToken(body.id_token, { jwks: await this.jwks(), issuer: OPENAI_ISSUER, audience: rec.client_id, nonce: null, now: this.now() });
            if (c.sub === rec.subject) next.id_token = body.id_token;
          } catch { /* keep the previously validated id_token */ }
        }
        this.store.writeAccount(next);
        return next;
      }, { now: this.now, wait: this.lockWait });
    })().finally(() => this.refreshing.delete(label));
    this.refreshing.set(label, p);
    return p;
  }

  /**
   * Sign out: revoke the refresh token at the discovered revocation endpoint
   * (bounded retries on 5xx/network), then clear tokens locally. Keeps the
   * account/client mapping and host id.
   * @param {string} label
   * @returns {Promise<{revoked:boolean, message:string}>}
   */
  async logout(label) {
    const rec = this.store.readAccount(label);
    if (!rec) throw new CompanionError('unknown_account', `No saved ChatGPT account named "${label}".`);
    let revoked = false;
    if (rec.refresh_token) {
      const delays = [500, 1500, 4000];
      let endpoint = null;
      for (let attempt = 0; attempt <= delays.length && !revoked; attempt++) {
        try {
          endpoint ??= (await this.discovery()).revocation_endpoint;
          if (!endpoint) break;
          const res = await this.http(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formBody({ token: rec.refresh_token, token_type_hint: 'refresh_token', client_id: rec.client_id }),
          });
          if (res.status === 200) { revoked = true; break; }
          if (res.status < 500) break; // not retryable
        } catch { /* network failure: retry */ }
        if (attempt < delays.length) await this.sleep(delays[attempt]);
      }
    } else {
      revoked = false;
    }
    this.store.clearTokens(label, ['access_token', 'refresh_token', 'id_token']);
    return {
      revoked,
      message: revoked
        ? `Signed out of "${label}"; the session was revoked.`
        : `Signed out of "${label}" locally, but remote revocation was NOT confirmed. You can disconnect the app in ChatGPT Settings.`,
    };
  }
}
