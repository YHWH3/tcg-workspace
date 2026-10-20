// One-shot OAuth loopback callback listener.
//
// Defenses (the companion exposes NO other local HTTP API):
//  - binds 127.0.0.1 only (never 0.0.0.0 / localhost);
//  - serves exactly one path, GET only;
//  - Host header must equal `127.0.0.1:<port>` (DNS-rebinding defense);
//  - cross-site requests (foreign `Origin` or Sec-Fetch-Site cross-site/
//    same-site) are accepted only as top-level navigations (Sec-Fetch-Mode:
//    navigate + Sec-Fetch-Dest: document) — that is how the legitimate
//    authorization redirect arrives; fetch/XHR/img/no-cors probes from
//    arbitrary web pages are rejected;
//  - `state` must match the pending attempt (OAuth callback substitution);
//  - after one accepted callback the listener refuses everything and closes.
import { createServer } from 'node:http';
import { LOOPBACK_HOST } from './constants.mjs';

const PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`;

const SEC_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
};

export class CallbackRejected extends Error {}

/**
 * Decide whether a request may be treated as the OAuth callback.
 * Exported pure for tests.
 * @param {{method?:string, url?:string, headers:Record<string, string|string[]|undefined>}} req
 * @param {{port:number, path:string}} cfg
 * @returns {{ok:true, params:URLSearchParams} | {ok:false, status:number, reason:string}}
 */
export function checkCallbackRequest(req, { port, path }) {
  if (req.method !== 'GET') return { ok: false, status: 405, reason: 'method_not_allowed' };
  const host = req.headers.host;
  if (host !== `${LOOPBACK_HOST}:${port}`) return { ok: false, status: 421, reason: 'bad_host' };
  let url;
  try { url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}:${port}`); } catch { return { ok: false, status: 400, reason: 'bad_url' }; }
  if (url.pathname !== path) return { ok: false, status: 404, reason: 'not_found' };
  // The legitimate authorization redirect is a cross-site top-level document
  // navigation; that is the only shape a cross-site request may take here.
  const mode = req.headers['sec-fetch-mode'];
  const dest = req.headers['sec-fetch-dest'];
  const topLevelNav = mode === 'navigate' && (dest === undefined || dest === 'document');
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${LOOPBACK_HOST}:${port}` && !topLevelNav) {
    return { ok: false, status: 403, reason: 'cross_origin' };
  }
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none' && !topLevelNav) {
    return { ok: false, status: 403, reason: 'cross_site_subresource' };
  }
  return { ok: true, params: url.searchParams };
}

/**
 * Start the listener BEFORE opening the browser. Resolves once listening with
 * the exact redirect URI (actual bound port) to use in authorize AND exchange.
 * @param {{path:string, port?:number, expectedState:string, timeoutMs?:number, maxBadAttempts?:number, fallbackToEphemeral?:boolean}} opts
 */
export async function startCallbackServer(opts) {
  const { path, expectedState } = opts;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const maxBad = opts.maxBadAttempts ?? 10;
  let consumed = false;
  let bad = 0;
  /** @type {(v: URLSearchParams) => void} */ let resolveCb;
  /** @type {(e: Error) => void} */ let rejectCb;
  const result = new Promise((res, rej) => { resolveCb = res; rejectCb = rej; });
  result.catch(() => {}); // avoid unhandled rejection if caller never awaits

  const server = createServer((req, res) => {
    const port = server.address().port;
    if (consumed) {
      res.writeHead(410, SEC_HEADERS).end(PAGE('Already completed', 'This sign-in attempt has already finished.'));
      return;
    }
    const check = checkCallbackRequest(req, { port, path });
    if (!check.ok) {
      res.writeHead(check.status, SEC_HEADERS).end(PAGE('Request refused', 'This local endpoint only accepts the sign-in redirect.'));
      return;
    }
    const state = check.params.get('state');
    if (!state || state !== expectedState) {
      bad++;
      res.writeHead(400, SEC_HEADERS).end(PAGE('Sign-in not accepted', 'The response did not match this sign-in attempt.'));
      if (bad >= maxBad) finish(new CallbackRejected('Too many mismatched callback attempts; sign-in aborted.'));
      return;
    }
    consumed = true;
    const denied = check.params.get('error');
    res.writeHead(200, SEC_HEADERS).end(denied
      ? PAGE('Sign-in cancelled', 'You can close this window and return to the terminal.')
      : PAGE('Signed in', 'You can close this window and return to the terminal.'));
    finish(null, check.params);
  });

  let timer;
  const finish = (err, params) => {
    clearTimeout(timer);
    consumed = true;
    server.close();
    // Drop idle keep-alive sockets so a second callback cannot ride them.
    server.closeIdleConnections?.();
    if (err) rejectCb(err); else resolveCb(params);
  };

  const listen = (port) => new Promise((res, rej) => {
    const onErr = (e) => { server.off('listening', onOk); rej(e); };
    const onOk = () => { server.off('error', onErr); res(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, LOOPBACK_HOST);
  });
  try {
    await listen(opts.port ?? 0);
  } catch (e) {
    if (e.code === 'EADDRINUSE' && opts.fallbackToEphemeral !== false && opts.port) await listen(0);
    else throw e;
  }
  const port = server.address().port;
  timer = setTimeout(() => finish(new CallbackRejected('Timed out waiting for the browser sign-in to finish.')), timeoutMs);
  timer.unref?.();

  return {
    port,
    redirectUri: `http://${LOOPBACK_HOST}:${port}${path}`,
    /** @returns {Promise<URLSearchParams>} */
    waitForCallback: () => result,
    close: () => { if (!consumed) finish(new CallbackRejected('Sign-in attempt cancelled.')); },
  };
}
