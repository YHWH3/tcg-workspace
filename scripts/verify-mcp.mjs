#!/usr/bin/env node
// Phase C verification: OAuth dance + MCP tools (official SDK) + UI live-poke +
// field/template UI + screenshots. Run against `wrangler dev --port 8788`
// (fresh D1 + smoke.sh first) or staging.
// Usage: node scripts/verify-mcp.mjs [base]   default http://localhost:8788
import { createCertificationReporter, localOrigin } from './certification-report.mjs';
import { assertionManifests } from './certification-manifests.mjs';
const certification = createCertificationReporter('verify-mcp', assertionManifests['verify-mcp']);
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';

const requestedBase = process.argv[2] ?? 'http://localhost:8788';
const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
let BASE;
try {
  const parsedBase = new URL(requestedBase);
  if (parsedBase.protocol !== 'http:' || !localHosts.has(parsedBase.hostname) || (parsedBase.pathname !== '/' && parsedBase.pathname !== '') || parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) throw new Error('not a loopback HTTP origin');
  BASE = parsedBase.origin;
} catch {
  console.error(`FATAL: refusing non-local base URL: ${requestedBase}`);
  process.exit(2);
}
const SHOTS = process.env.CERT_ARTIFACT_DIR ?? '/tmp/notion-shots/v5';
mkdirSync(SHOTS, { recursive: true });
const USER = process.env.MCP_USER ?? 'admin';
const PASS = process.env.MCP_PASS ?? 'password123';
const TASK_COUNT = Number(process.env.MCP_TASK_COUNT ?? 12); // ~100 on staging for CPU check
const fixtureConfig = process.env.PHASE4_FIXTURE_CONFIG?.trim() ?? '';
const fixtureState = process.env.PHASE4_FIXTURE_STATE?.trim() ?? '';
if (!fixtureConfig || !fixtureState) {
  console.error('FATAL: PHASE4_FIXTURE_CONFIG and PHASE4_FIXTURE_STATE are required together for the destructive deleted-user check');
  process.exit(2);
}
const configPath = resolve(fixtureConfig);
const statePath = resolve(fixtureState);
try {
  if (!existsSync(configPath) || !statSync(configPath).isFile() || !existsSync(statePath) || !statSync(statePath).isDirectory()) throw new Error('fixture config/state does not exist with the expected types');
  const configParent = realpathSync(dirname(configPath));
  const realConfig = realpathSync(configPath);
  const realState = realpathSync(statePath);
  const tempRoot = realpathSync(tmpdir());
  const relativeFixture = relative(tempRoot, configParent);
  if (basename(realConfig) !== 'wrangler.json' || basename(realState) !== 'state' || dirname(realState) !== configParent || !basename(configParent).startsWith('tcg-phase4-disposable-') || !relativeFixture || relativeFixture.startsWith('..') || resolve(tempRoot, relativeFixture) !== configParent) throw new Error('fixture config/state must be the exact disposable helper layout under the OS temp directory');
} catch (error) {
  console.error(`FATAL: refusing fixture config/state targets: ${error?.message ?? error}`);
  process.exit(2);
}

let PASS_COUNT = 0,
  FAIL_COUNT = 0;
const check = (name, cond, extra = '') => {
  certification.record('none', 'none', name, cond ? 'PASS' : 'FAIL', cond ? null : (extra || 'Assertion evaluated false'));
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

/* ================= PART 1: OAuth dance ================= */
console.log('\n== oauth dance ==');

// Dynamic client registration
const dcr = await api('/register', {
  method: 'POST',
  body: { client_name: 'MCP Verify', redirect_uris: ['http://localhost:8123/cb'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' },
});
check('DCR registers client', dcr.status === 201 || dcr.status === 200, `status=${dcr.status} ${dcr.text.slice(0, 200)}`);
const clientId = dcr.data.client_id;
check('DCR returns client_id', !!clientId);

const resource = `${BASE}/mcp`;
const authorize = async () => {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(8));
  const url = `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:8123/cb', state, code_challenge: challenge, code_challenge_method: 'S256', resource, scope: 'mcp' })}`;
  const page = await api(url, { raw: true });
  const cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ') || page.headers.get('set-cookie')?.split(';')[0] || '';
  return { verifier, state, status: page.status, html: await page.text(), cookie };
};

// Missing PKCE: authorize without a challenge → the provider must reject it.
const noPkce = await api(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:8123/cb', state: 'x', resource })}`, { raw: true });
check('authorize without PKCE fails', noPkce.status === 400, `status=${noPkce.status}`);

const dance = await authorize();
check('authorize page renders consent form', dance.status === 200 && /name="handle"/.test(dance.html) && /MCP Verify/.test(dance.html));
const handle = dance.html.match(/name="handle" value="([^"]+)"/)?.[1];
check('authorize returns consent handle', !!handle);
// Form posts back to the same URL — keep the query like a real browser form would.
const dancePath = `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:8123/cb', state: dance.state, code_challenge: b64url(crypto.createHash('sha256').update(dance.verifier).digest()), code_challenge_method: 'S256', resource, scope: 'mcp' })}`;

// Bad password → re-rendered form, handle still usable.
const bad = await api(dancePath, { method: 'POST', cookie: dance.cookie, form: { handle, username: USER, password: 'wrong-password', decision: 'allow' } });
check('bad password rejected (401, form re-rendered)', bad.status === 401 && /name="handle"/.test(bad.text), `status=${bad.status}`);

// Good creds → 302 with code
const good = await api(dancePath, { method: 'POST', cookie: dance.cookie, form: { handle, username: USER, password: PASS, decision: 'allow' } });
const loc = good.headers.get('location') ?? '';
const code = new URL(loc, BASE).searchParams.get('code');
check('good creds → 302 with code', good.status === 302 && !!code, `status=${good.status} loc=${loc.slice(0, 120)}`);
check('state round-tripped', new URL(loc, BASE).searchParams.get('state') === dance.state);

// Token exchange WITHOUT verifier must fail first (PKCE enforced).
const noVerifier = await api('/token', { method: 'POST', form: { grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:8123/cb', client_id: clientId, resource } });
check('token exchange without PKCE fails', noVerifier.status === 400 || noVerifier.status === 401, `status=${noVerifier.status} ${noVerifier.text.slice(0, 120)}`);

// But the failed attempt may have consumed the code — mint a fresh one.
const dance2 = await authorize();
const handle2 = dance2.html.match(/name="handle" value="([^"]+)"/)?.[1];
const dance2Path = `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:8123/cb', state: dance2.state, code_challenge: b64url(crypto.createHash('sha256').update(dance2.verifier).digest()), code_challenge_method: 'S256', resource, scope: 'mcp' })}`;
const good2 = await api(dance2Path, { method: 'POST', cookie: dance2.cookie, form: { handle: handle2, username: USER, password: PASS, decision: 'allow' } });
const code2 = new URL(good2.headers.get('location') ?? '', BASE).searchParams.get('code');
const tok = await api('/token', { method: 'POST', form: { grant_type: 'authorization_code', code: code2, redirect_uri: 'http://localhost:8123/cb', client_id: clientId, code_verifier: dance2.verifier, resource } });
check('token exchange with PKCE succeeds', tok.status === 200 && !!tok.data.access_token, `status=${tok.status} ${tok.text.slice(0, 160)}`);
const accessToken = tok.data.access_token;
check('refresh token issued', !!tok.data.refresh_token);

// Unauthenticated MCP call → 401 with WWW-Authenticate pointing at metadata.
const unauth = await api('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
const wwa = unauth.headers.get('www-authenticate') ?? '';
check('unauthed /mcp → 401 + resource_metadata challenge', unauth.status === 401 && wwa.includes('resource_metadata'), `wwa=${wwa.slice(0, 160)}`);

/* ================= PART 2: MCP tools via official SDK ================= */
console.log('\n== mcp tools ==');

const client = new Client({ name: 'mcp-verify', version: '1.0.0' }, { capabilities: {} });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  }),
);
check('MCP connect over Streamable HTTP', true);

const { tools } = await client.listTools();
const toolNames = tools.map((t) => t.name);
check(
  'tools listed (≥18)',
  toolNames.length >= 18,
  `got ${toolNames.length}: ${toolNames.slice(0, 25).join(',')}`,
);
for (const n of ['search', 'fetch', 'workspace_overview', 'get_page', 'create_page', 'edit_page', 'get_board', 'create_board', 'update_board', 'create_tasks', 'update_tasks', 'get_task', 'create_moodboard', 'add_mood_items', 'add_comment', 'publish_page', 'create_from_template', 'delete_item', 'restore_item'])
  check(`tool ${n} registered`, toolNames.includes(n));

const { prompts } = await client.listPrompts();
check('prompts registered', ['plan_project', 'make_sop', 'capture_notes'].every((p) => prompts.map((x) => x.name).includes(p)));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { data, isError: !!r.isError, text };
};

const ov = await call('workspace_overview', {});
check('workspace_overview returns people+pages+boards', Array.isArray(ov.data.people) && Array.isArray(ov.data.pages) && Array.isArray(ov.data.boards));
const bobId = ov.data.people.find((u) => u.username === 'bob')?.id;

// A second user for person-field + mention coverage; bob exists after smoke.
const imgUrl = 'https://picsum.photos/seed/ws5/640/480';

const proj = await call('create_project', {
  title: 'Film Launch',
  icon: '🎬',
  overviewMarkdown: '# Launch plan\n\nKickoff with @bob. See [[Team Handbook]].',
  pages: [
    { title: 'Runbook', markdown: '## Steps\n- [ ] shoot\n- [ ] edit\n- [x] scout', children: [{ title: 'Contacts', markdown: 'Call the venue.' }] },
  ],
  board: {
    name: 'Production',
    columns: [{ name: 'Backlog' }, { name: 'Doing' }, { name: 'Shipped' }],
    fields: [
      { name: 'Kind', type: 'select', options: ['Hero', 'BTS'], showOnCard: true },
      { name: 'Budget', type: 'number', showOnCard: true },
      { name: 'Owner', type: 'person' },
      { name: 'Go', type: 'checkbox' },
      { name: 'Brief', type: 'url' },
    ],
    tasks: Array.from({ length: TASK_COUNT }, (_, i) => ({
      title: `Task ${i + 1}`,
      description: i % 5 === 0 ? 'Filming at the workshop' : '',
      status: i % 3 === 0 ? 'Doing' : 'Backlog',
      priority: i % 7 === 0 ? 'high' : 'none',
      ...(i === 0 ? { assignee: 'bob' } : {}),
      fields: { Kind: i % 2 ? 'Hero' : 'BTS', Budget: i * 100, Owner: 'bob', Go: i % 4 === 0, Brief: 'https://example.com/brief' },
    })),
  },
  moodboard: { title: 'Launch mood', items: [{ type: 'note', text: 'grain + warm light' }, { type: 'color', color: '#e5484d' }, { type: 'image', imageUrl: imgUrl }] },
});
check('create_project succeeds', !proj.isError && !!proj.data.pageId, proj.text.slice(0, 240));
const pageId = proj.data.pageId;
const boardId = proj.data.boardId;
const moodId = proj.data.moodboardId;
check('project board+moodboard created', !!boardId && !!moodId);

// edit_page append + insert
const ep = await call('edit_page', { pageId, appendMarkdown: '> quoted note\n\n- follow-up bullet' });
check('edit_page append', !ep.isError && ep.data.updated > 0, ep.text.slice(0, 160));
const gp = await call('get_page', { pageId });
check('get_page returns markdown + children', typeof gp.data.markdown === 'string' && gp.data.children.length === 1 && /Launch plan/.test(gp.data.markdown));
check('page markdown renders mention tokens', /@Bob|\[\[Team Handbook\]\]/.test(gp.data.markdown), gp.data.markdown?.slice(0,200));

// update_board: add field, rename
const ub = await call('update_board', { boardId, addFields: [{ name: 'External', type: 'select', options: ['Yes', 'No'], showOnCard: true }] });
check('update_board addFields', !ub.isError);

const gb = await call('get_board', { boardId });
check('get_board tasks carry named field values', gb.data.tasks.length === TASK_COUNT && gb.data.tasks[0].fields?.Kind !== undefined, gb.text.slice(0, 160));
check('unknown option auto-added? tasks all have values', gb.data.tasks.every((t) => t.fields.Kind === 'Hero' || t.fields.Kind === 'BTS'));
const aTaskId = gb.data.tasks[0].id;

// update_tasks: move task, set checkbox off, new select option auto-created
const ut = await call('update_tasks', { updates: [{ taskId: aTaskId, status: 'Shipped', fields: { Kind: 'Teaser' } }] });
check('update_tasks', !ut.isError);
const gb2 = await call('get_board', { boardId });
const moved = gb2.data.tasks.find((t) => t.id === aTaskId);
check('task moved to Shipped + option Teaser auto-added', moved?.statusName === 'Shipped' && moved?.fields?.Kind === 'Teaser');

const cm = await call('add_comment', { targetType: 'task', targetId: aTaskId, text: 'ping @bob — looks good' });
check('add_comment', !cm.isError);
const lc = await call('list_comments', { targetType: 'task', targetId: aTaskId });
check('list_comments + mention resolved', lc.data.comments.length === 1 && /@Bob|Bob/.test(lc.data.comments[0].body), lc.text.slice(0, 120));

// publish + public check
const pub = await call('publish_page', { pageId, enabled: true });
check('publish_page returns url', !pub.isError && /\/s\//.test(pub.data.url ?? ''));
const pubCheck = await fetch(pub.data.url).then((r) => r.status).catch(() => 0);
check('public share page loads', pubCheck === 200, `status=${pubCheck}`);

// template round-trip
const tpl = await call('edit_page', { pageId, isTemplate: true });
check('mark page as template', !tpl.isError);
const inst = await call('create_from_template', { templateId: pageId, title: 'Instance X', variables: {} });
check('create_from_template copies subtree+board', !inst.isError && !!inst.data.pageId && inst.data.records > 5, inst.text.slice(0, 160));
await call('edit_page', { pageId, isTemplate: false });

// search + fetch
const srch = await call('search', { query: 'Film Launch' });
check('search finds created page', srch.data.results?.some((r) => r.id === `page:${pageId}`));
const ft = await call('fetch', { id: `page:${pageId}` });
check('fetch returns page text', !ft.isError && /Launch plan/.test(ft.data.text ?? ''));

// activity via-client attribution
const act = await call('recent_activity', { limit: 30 });
check('activity shows via <client>', act.data.activity?.some((a) => a.via === 'MCP Verify'), JSON.stringify(act.data.activity?.slice(0, 3)));

// delete + restore
const delNoRev = await call('delete_item', { type: 'task', id: aTaskId });
check('delete_item without expectedRev → error', delNoRev.isError && /expectedRev/.test(delNoRev.text), delNoRev.text.slice(0, 140));
const taskForRev = await call('get_task', { taskId: aTaskId });
const del = await call('delete_item', { type: 'task', id: aTaskId, expectedRev: taskForRev.data.task?.rev ?? taskForRev.data.rev });
check('delete_item soft-deletes', !del.isError && del.data.deleted === true, del.text.slice(0, 140));
const res = await call('restore_item', { type: 'task', id: aTaskId });
check('restore_item restores', !res.isError && res.data.restored === true);

// create_page standalone
const cp = await call('create_page', { title: 'MCP note', markdown: 'plain para' });
check('create_page', !cp.isError && !!cp.data.id);

/* ================= PART 3: UI — live poke, fields, templates, settings ================= */
console.log('\n== ui ==');

const adminLogin = await api('/api/auth/login', { method: 'POST', body: { username: USER, password: PASS } });
const adminToken = adminLogin.data.token;
check('app login for UI', !!adminToken);

const browser = await certification.trackBrowser(await chromium.launch(), 'chromium');
const mkPage = async ({ viewport = { width: 1280, height: 800 }, mobile = false } = {}) => {
  const ctx2 = await browser.newContext({ viewport, colorScheme: 'light', ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  const pg = await ctx2.newPage();
  await pg.goto(`${BASE}/login`);
  await pg.evaluate((u) => {
    localStorage.setItem('ws_token', u.token);
    localStorage.setItem('ws_user', JSON.stringify(u.user));
    localStorage.setItem('ws_uid', u.user.id);
  }, adminLogin.data);
  return { ctx: ctx2, page: pg };
};

// authorize page light + dark screenshots (a fresh DCR consent URL)
const dance3 = await authorize();
for (const scheme of ['light', 'dark']) {
  const c2 = await browser.newContext({ viewport: { width: 420, height: 720 }, colorScheme: scheme });
  const pg = await c2.newPage();
  await pg.goto(`${BASE}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:8123/cb', state: 'x', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource })}`);
  await pg.waitForSelector('text=/wants to access/', { timeout: 8000 }).catch(() => {});
  await pg.screenshot({ path: `${SHOTS}/authorize-${scheme}.png` });
  await c2.close();
}
check('authorize page screenshots', true);

const { ctx: uiCtx, page: ui } = await mkPage();

// live poke: MCP write appears without reload
await ui.goto(`${BASE}/boards/${boardId}`);
await ui.waitForSelector('text=Task 1', { timeout: 15000 });
const t0 = Date.now();
await call('create_tasks', { boardId, tasks: [{ title: 'LIVE-POKE TASK', status: 'Backlog', fields: { Kind: 'Hero' } }] });
const appeared = await ui
  .waitForSelector('text=LIVE-POKE TASK', { timeout: 6000 })
  .then(() => true)
  .catch(() => false);
check('live poke: new task visible without reload', appeared, `latency=${Date.now() - t0}ms`);

// field chips render on a card
await ui.locator('[data-task-card]').first().waitFor({ timeout: 8000 });
const chipsVisible = await ui.locator('[data-task-card]', { hasText: 'Hero' }).count().then((n) => n > 0).catch(() => false);
check('field chips render on cards', chipsVisible);
await ui.screenshot({ path: `${SHOTS}/card-chips.png` });

// task detail property rows
await ui.locator('text=Task 1').first().click();
await ui.waitForSelector('text=Budget', { timeout: 8000 });
check('task detail shows property rows', await ui.getByText('Owner', { exact: true }).isVisible());
await ui.screenshot({ path: `${SHOTS}/task-detail-props-desktop.png` });

// fields editor
await ui.keyboard.press('Escape').catch(() => {});
await ui.goto(`${BASE}/boards/${boardId}`);
await ui.getByLabel('Board menu').click();
await ui.locator('text=Fields').click();
await ui.waitForSelector('text=/Show on card/', { timeout: 8000 });
check('Fields editor opens', true);
await ui.screenshot({ path: `${SHOTS}/fields-editor-desktop.png` });
await ui.keyboard.press('Escape').catch(() => {});

// settings → AI connectors
await ui.goto(`${BASE}/settings`);
await ui.waitForSelector('text=AI connectors', { timeout: 8000 });
check('AI connectors section renders', await ui.locator('text=/Connected apps|Setup steps/').first().isVisible());
const grantsVisible = await ui.locator('text=MCP Verify').first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
check('grant listed (MCP Verify)', grantsVisible);
await ui.locator('section:has-text("AI connectors")').screenshot({ path: `${SHOTS}/settings-ai-connectors.png` }).catch(async () => ui.screenshot({ path: `${SHOTS}/settings-ai-connectors.png` }));

// activity shows "via MCP Verify"
await ui.goto(`${BASE}/activity`);
await ui.locator('text=All activity').click().catch(() => {});
const viaOk = await ui.locator('text=/via MCP Verify/').first().waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
check('activity shows "via MCP Verify"', viaOk);

// From template picker
await ui.goto(`${BASE}/`);
const tplBtn = await ui.evaluate(() => {
  const row = [...document.querySelectorAll('[data-page-row]')].find((r) => r.textContent?.includes('Film Launch'));
  return !!row;
});
void tplBtn;
// mark template via API and use picker
await api('/api/sync/push', { method: 'POST', token: adminToken, body: { changes: [{ id: pageId, collection: 'pages', patch: { isTemplate: true }, ts: Date.now() }] } });
await ui.reload();
// wait until the pushed isTemplate flag has synced (marker icon in the tree)
await ui.waitForSelector('[aria-label="Template"]', { timeout: 15000 }).catch(() => {});
await ui.getByLabel('New page').first().click();
await ui.waitForTimeout(300);
const tplOption = ui.locator('button:has-text("Film Launch")').first();
const tplVisible = await tplOption.waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
check('"From template" lists the template', tplVisible);
if (tplVisible) {
  await tplOption.click();
  await ui.waitForURL(/\/pages\//, { timeout: 8000 });
  check('instantiated page opens', true);
}
await ui.screenshot({ path: `${SHOTS}/from-template.png` });

// mobile shots
const { ctx: mCtx, page: mp } = await mkPage({ viewport: { width: 390, height: 844 }, mobile: true });
await mp.goto(`${BASE}/boards/${boardId}`);
await mp.waitForSelector('text=Task 1', { timeout: 15000 });
await mp.locator('text=Task 2').first().click().catch(() => {});
await mp.waitForTimeout(600);
await mp.screenshot({ path: `${SHOTS}/task-detail-props-mobile.png` });
await mp.goto(`${BASE}/boards/${boardId}`);
await mp.getByLabel('Board menu').click();
await mp.locator('text=Fields').click();
await mp.waitForTimeout(500);
await mp.screenshot({ path: `${SHOTS}/fields-editor-mobile.png` });
await mCtx.close();

await uiCtx.close();
await browser.close();

/* ================= PART 4: token for deleted user → 401 ================= */
console.log('\n== deleted user token ==');
// Snapshot a spare user's row, delete it, expect 401, restore it.
const secondToken = accessToken; // token is bound to USER; delete USER and restore
const { execFileSync } = await import('node:child_process');
const d1Args = ['wrangler', 'd1', 'execute', 'workspace-db', '--local', '--config', configPath, '--persist-to', statePath];
const d1 = (args) => execFileSync('npx', [...d1Args, ...args], { cwd: process.cwd() }).toString();
const rowJson = d1(['--json', '--command', `SELECT * FROM users WHERE username='${USER}'`]);
const rows = JSON.parse(rowJson);
const row = Array.isArray(rows) ? rows[0]?.results?.[0] : rows.results?.[0];
d1(['--command', `DELETE FROM users WHERE username='${USER}'`]);
await new Promise((r) => setTimeout(r, 400));
const dead = await api('/mcp', { method: 'POST', token: accessToken, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
check('token with deleted user → 401', dead.status === 401, `status=${dead.status}`);
if (row) {
  const cols = Object.keys(row).join(', ');
  const vals = Object.values(row).map((v) => (v === null ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`)).join(', ');
  d1(['--command', `INSERT INTO users (${cols}) VALUES (${vals})`]);
  const back = await api('/api/auth/login', { method: 'POST', body: { username: USER, password: PASS } });
  check('restored user can log in again', !!back.data.token);
}
void secondToken;

console.log(`\n== ${PASS_COUNT} passed, ${FAIL_COUNT} failed ==`);
certification.finish();
process.exit(FAIL_COUNT || process.exitCode ? 1 : 0);
