#!/usr/bin/env node
// Phase 0 verification: two OAuth users (admin=A, bob=B) against one wrangler
// dev isolate. Covers docs/architecture/phase-0-safe-ai-editing.md §12.
// Requires `wrangler dev --port 8788` on the built app + smoke.sh users seeded.
// Usage: node scripts/verify-mcp-multiuser.mjs [base]   default http://localhost:8788
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import crypto from 'node:crypto';

const BASE = process.argv[2] ?? 'http://localhost:8788';
const PASS = process.env.MCP_PASS ?? 'password123';
const USER_A = process.env.MCP_USER_A ?? 'admin';
const USER_B = process.env.MCP_USER_B ?? 'bob';

let PASS_COUNT = 0,
  FAIL_COUNT = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    PASS_COUNT++;
    console.log(`  ✅ ${name}`);
  } else {
    FAIL_COUNT++;
    console.log(`  ❌ ${name} ${extra}`);
  }
};

const api = async (path, { method = 'GET', token, body, form, raw, cookie } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (body) headers['Content-Type'] = 'application/json';
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined, redirect: 'manual' });
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _text: text };
  }
  return { status: res.status, data, text, headers: res.headers };
};

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const resource = `${BASE}/mcp`;

/** Full OAuth dance (DCR shared client + PKCE authorize + token exchange) for one user. */
async function grantFor(clientId, username) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(8));
  const qs = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:8123/cb', state, code_challenge: challenge, code_challenge_method: 'S256', resource, scope: 'mcp' });
  const page = await api(`/oauth/authorize?${qs}`, { raw: true });
  const cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ') || page.headers.get('set-cookie')?.split(';')[0] || '';
  const html = await page.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  if (!handle) throw new Error(`no consent handle for ${username} (status ${page.status})`);
  const approve = await api(`/oauth/authorize?${qs}`, { method: 'POST', cookie, form: { handle, username, password: PASS, decision: 'allow' } });
  const code = new URL(approve.headers.get('location') ?? '', BASE).searchParams.get('code');
  if (!code) throw new Error(`no auth code for ${username} (status ${approve.status})`);
  const tok = await api('/token', { method: 'POST', form: { grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:8123/cb', client_id: clientId, code_verifier: verifier, resource } });
  if (!tok.data?.access_token) throw new Error(`no access token for ${username}: ${tok.text.slice(0, 160)}`);
  return tok.data.access_token;
}

async function mcpClient(token, name) {
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (tool, args) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { data, isError: !!r.isError, text };
  };
  return { client, call };
}

/** Pull every record (admin session) → flat map id → row. */
async function pullAll(token) {
  const out = new Map();
  let since = 0;
  for (;;) {
    const r = await api(`/api/sync/pull?since=${since}&limit=500`, { token });
    for (const rec of r.data.records ?? []) out.set(rec.id, rec);
    if (!r.data.hasMore) break;
    since = r.data.cursor;
  }
  return out;
}

/* ================= §12.1 interleaved identity ================= */
console.log('\n== 1. interleaved OAuth identity (§0.1) ==');

const dcr = await api('/register', {
  method: 'POST',
  body: { client_name: 'Multi-User Verify', redirect_uris: ['http://localhost:8123/cb'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' },
});
const clientId = dcr.data.client_id;
check('DCR client registered', !!clientId, dcr.text.slice(0, 160));

const tokenA = await grantFor(clientId, USER_A);
check(`OAuth grant for ${USER_A}`, !!tokenA);
const tokenB = await grantFor(clientId, USER_B);
check(`OAuth grant for ${USER_B}`, !!tokenB);

const A = await mcpClient(tokenA, 'verify-A');
const B = await mcpClient(tokenB, 'verify-B');
check('both MCP clients connected', true);

const ov = await A.call('workspace_overview', {});
const idA = ov.data.people.find((u) => u.username === USER_A)?.id;
const idB = ov.data.people.find((u) => u.username === USER_B)?.id;
check('resolved user ids', !!idA && !!idB && idA !== idB);

// Alternate callers in one isolate: A,B,A,B ×10 = 20 create_page calls.
const RUN = `MU-${Date.now()}`;
const writes = [];
for (let i = 0; i < 10; i++) {
  writes.push({ who: 'A', res: await A.call('create_page', { title: `${RUN}-A-${i}`, markdown: `from ${USER_A}` }) });
  writes.push({ who: 'B', res: await B.call('create_page', { title: `${RUN}-B-${i}`, markdown: `from ${USER_B}` }) });
}
check('all 20 interleaved create_page calls succeed', writes.every((w) => !w.res.isError && w.res.data.id), writes.find((w) => w.res.isError)?.res.text?.slice(0, 160) ?? '');

// Attribution: each created page's createdBy AND its activity row's actorId
// must match the caller — not the first request's identity.
const adminLogin = await api('/api/auth/login', { method: 'POST', body: { username: USER_A, password: PASS } });
const all = await pullAll(adminLogin.data.token);
let attrOk = true,
  actOk = true,
  detail = '';
for (const w of writes) {
  const page = all.get(w.res.data.id);
  const want = w.who === 'A' ? idA : idB;
  if (String(page?.data?.createdBy) !== want) {
    attrOk = false;
    detail += ` page ${w.res.data.id} createdBy=${page?.data?.createdBy} want ${want};`;
  }
  const act = [...all.values()].find((r) => r.collection === 'activity' && r.data.verb === 'created' && r.data.targetId === w.res.data.id);
  if (String(act?.data?.actorId) !== want) {
    actOk = false;
    detail += ` activity for ${w.res.data.id} actorId=${act?.data?.actorId} want ${want};`;
  }
}
check('every created page attributes to its caller (createdBy)', attrOk, detail.slice(0, 300));
check('every activity row attributes to its caller (actorId)', actOk, detail.slice(0, 300));

// Read isolation sanity: B's read tools still work (authB on every request).
const bRead = await B.call('workspace_overview', {});
check('B can still read after interleaved writes', Array.isArray(bRead.data.pages));

/* ================= later Phase 0 scenarios land here ================= */

console.log(`\n== ${PASS_COUNT} passed, ${FAIL_COUNT} failed`);
process.exit(FAIL_COUNT ? 1 : 0);
