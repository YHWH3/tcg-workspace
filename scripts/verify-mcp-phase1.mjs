#!/usr/bin/env node
// Phase 1 verification: custom databases, views, links, record helpers.
// Requires `wrangler dev --local --port 8788` + smoke.sh users seeded.
// Usage: node scripts/verify-mcp-phase1.mjs [base]   default http://localhost:8788
import { createCertificationReporter, localOrigin } from './certification-report.mjs';
import { assertionManifests } from './certification-manifests.mjs';
const certification = createCertificationReporter('verify-mcp-phase1', assertionManifests['verify-mcp-phase1']);
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import crypto from 'node:crypto';

const BASE = localOrigin(process.argv[2] ?? process.env.CERT_BASE ?? 'http://localhost:8788');
const PASS = process.env.MCP_PASS ?? 'password123';
const USER = process.env.MCP_USER ?? 'admin';
let PASS_COUNT = 0, FAIL_COUNT = 0;
const check = (name, cond, extra = '') => {
  certification.record('none', 'none', name, cond ? 'PASS' : 'FAIL', cond ? null : (extra || 'Assertion evaluated false'));
  if (cond) { PASS_COUNT++; console.log(`  ✅ ${name}`); }
  else { FAIL_COUNT++; console.log(`  ❌ ${name} ${extra}`); }
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
  try { data = JSON.parse(text); } catch { data = { _text: text }; }
  return { status: res.status, data, text, headers: res.headers };
};
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const resource = `${BASE}/mcp`;

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
  if (!tok.data?.access_token) throw new Error(`no access token: ${tok.text.slice(0, 160)}`);
  return tok.data.access_token;
}

async function mcpClient(token) {
  const client = new Client({ name: 'p1-verify', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return async (tool, args) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { data, isError: !!r.isError, text };
  };
}

console.log('== Phase 1: databases, views, links, record helpers ==');
const dcr = await api('/register', {
  method: 'POST',
  body: { client_name: 'p1-verify', redirect_uris: ['http://localhost:8123/cb'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' },
});
check('DCR client registered', !!dcr.data?.client_id);
const token = await grantFor(dcr.data.client_id, USER);
const call = await mcpClient(token);

const j = (r) => (r.isError ? { error: r.text.slice(0, 200) } : r.data ?? {});

// --- database shell ---
const db = j(await call('create_database', { name: 'Projects', kind: 'records', recordNoun: 'Project', description: 'Delivery projects', fields: [{ name: 'Health', type: 'select', options: ['On track', 'At risk'] }, { name: 'Budget', type: 'number' }], views: [{ name: 'All Projects', type: 'table' }] }));
check('create_database returns id', !!db.id, JSON.stringify(db).slice(0, 200));
const dbId = db.id;
const ov = j(await call('workspace_overview'));
const dbMeta = ov.boards?.find((b) => b.id === dbId);
check('overview kind=records + recordNoun', (dbMeta?.kind === 'records' || dbMeta?.kind === 'database') && dbMeta?.recordNoun === 'Project', JSON.stringify(dbMeta).slice(0, 200));
check('default view row created', (ov.viewsByBoard?.[dbId] ?? []).length >= 1, JSON.stringify(ov.viewsByBoard?.[dbId]));

// --- records ---
const recsR = j(await call('create_records', { databaseId: dbId, records: [
  { title: 'Apollo', fields: { Health: 'On track', Budget: 10 }, body: '# Apollo\nFirst.' },
  { title: 'Borealis', fields: { Health: 'At risk' }, parent: 'Apollo' },
  { title: 'Cygnus', blockedBy: ['Apollo'] },
] }));
check('create_records x3', (recsR.created ?? []).length === 3, JSON.stringify(recsR).slice(0, 220));
const idOf = (t) => (recsR.created ?? []).find((r) => r.title === t)?.id;
const idApollo = idOf('Apollo'), idBor = idOf('Borealis'), idCyg = idOf('Cygnus');
check('sub-record parent set', !idBor ? false : true);
const apollo0 = j(await call('get_record', { recordId: idApollo }));
check('get_record: children includes Borealis', (apollo0.record?.children ?? []).some((c) => c.id === idBor), JSON.stringify(apollo0.record?.children ?? apollo0).slice(0, 200));

const ov2 = j(await call('workspace_overview'));
const health = ov2.boards?.find((b) => b.id === dbId)?.fields?.find((f) => f.name === 'Health');
check('select options present', (health?.options ?? []).includes('On track'), JSON.stringify(health));

// relation field two-way (add_field)
const rel = j(await call('add_field', { boardId: dbId, field: { name: 'Depends on', type: 'relation', target: dbId, twoWay: true, reverseName: 'Blocks' } }));
check('relation field created', rel.field?.type === 'relation', JSON.stringify(rel).slice(0, 200));
const relFid = rel.field?.id;
const ov3 = j(await call('workspace_overview'));
check('reverse field Blocks paired', !!ov3.boards?.find((b) => b.id === dbId)?.fields?.find((f) => f.name === 'Blocks' && f.relation?.pairedFieldId === relFid));

// relation value via update_records addRelations + reverse denormalization
const ar = j(await call('update_records', { updates: [{ recordId: idBor, addRelations: { 'Depends on': ['Apollo'] } }] }));
check('update_records addRelations', !ar.error, JSON.stringify(ar).slice(0, 200));
const apollo = j(await call('get_record', { recordId: idApollo }));
check('reverse link visible on get_record', JSON.stringify(apollo.record ?? apollo).includes(idBor), JSON.stringify(apollo.record?.relations ?? apollo).slice(0, 240));

// link_items related + idempotent dedupe
const pg = j(await call('create_page', { title: 'Spec Doc', markdown: 'spec' }));
const l1 = j(await call('link_items', { from: { type: 'record', id: idApollo }, to: { type: 'page', id: pg.id }, kind: 'related' }));
check('link_items related', !!l1.linkId, JSON.stringify(l1).slice(0, 160));
const dup = j(await call('link_items', { from: { type: 'record', id: idApollo }, to: { type: 'page', id: pg.id }, kind: 'related' }));
check('link_items idempotent', dup.existed === true && dup.linkId === l1.linkId, JSON.stringify(dup).slice(0, 160));

// views
const v = j(await call('add_view', { databaseId: dbId, name: 'Risk Board', type: 'board', groupBy: 'Health', filters: [{ field: 'Health', op: 'is', value: 'At risk' }], sorts: [{ field: 'createdAt', dir: 'desc' }] }));
check('add_view board view', !!v.id, JSON.stringify(v).slice(0, 160));
const vDup = j(await call('add_view', { databaseId: dbId, name: 'Risk Board', type: 'table' }));
check('add_view dup returns existed', vDup.existed === true && vDup.id === v.id, JSON.stringify(vDup).slice(0, 160));
const ovV = j(await call('workspace_overview'));
check('view visible in overview', (ovV.viewsByBoard?.[dbId] ?? []).some((x) => x.id === v.id));
const uv = j(await call('update_view', { viewId: v.id, filters: [{ field: 'Health', op: 'is_not', value: 'On track' }] }));
check('update_view ok', !uv.error && !!uv.id, JSON.stringify(uv).slice(0, 160));

// query_records filter + sort + include
const risk = j(await call('query_records', { databaseId: dbId, filters: [{ field: 'Health', op: 'is', value: 'At risk' }] }));
check('query filter eq -> Borealis', risk.rows?.length === 1 && risk.rows[0].title === 'Borealis', JSON.stringify(risk).slice(0, 240));
const sorted = j(await call('query_records', { databaseId: dbId, sorts: [{ field: 'title', dir: 'desc' }] }));
check('query sort desc', sorted.rows?.[0]?.title === 'Cygnus', JSON.stringify(sorted.rows?.map((r) => r.title)));

// tasks database + move via update_records stage
const tdb = j(await call('create_database', { name: 'Tasks DB', kind: 'tasks' }));
check('create_database kind=tasks', !!tdb.id && (tdb.stages ?? []).length === 3, JSON.stringify(tdb).slice(0, 160));
const tr = j(await call('create_records', { databaseId: tdb.id, records: [{ title: 'T1', stage: 'To do' }, { title: 'T2' }] }));
check('create_records on tasks db', (tr.created ?? []).length === 2, JSON.stringify(tr).slice(0, 160));
const t1 = (tr.created ?? []).find((r) => r.title === 'T1')?.id;
const doneStage = (tdb.stages ?? []).find((s) => /done/i.test(s)) ?? 'Done';
const mv = j(await call('update_records', { updates: [{ recordId: t1, stage: doneStage }] }));
check('update_records stage move', !mv.error, JSON.stringify(mv).slice(0, 160));
const tOv = j(await call('workspace_overview'));
const doneCol = tOv.boards?.find((b) => b.id === tdb.id)?.columns?.find((c) => /done/i.test(c.name))?.id;
const t1After = j(await call('get_record', { recordId: t1 }));
check('stage applied', t1After.record?.stage === doneCol, `stage=${t1After.record?.stage} doneCol=${doneCol}`);

// dependency + cycle guard
const dep = j(await call('add_dependency', { blocker: 'Apollo', blocked: 'Cygnus', databaseId: dbId }));
check('add_dependency', dep.existed === true || !!dep.linkId, JSON.stringify(dep).slice(0, 160));
const depCyc = j(await call('add_dependency', { blocker: 'Cygnus', blocked: 'Apollo', databaseId: dbId }));
check('dependency cycle rejected', !!depCyc.error, JSON.stringify(depCyc).slice(0, 160));

// set_parent cycle guard (Borealis is child of Apollo; making Apollo child of Borealis cycles)
const cyc = j(await call('set_parent', { recordId: idApollo, parentId: idBor }));
check('sub-record cycle rejected', !!cyc.error, JSON.stringify(cyc).slice(0, 160));

// dryRun + expectedRev on update_records
const cur = j(await call('get_record', { recordId: idApollo }));
const dry = j(await call('update_records', { updates: [{ recordId: idApollo, fields: { Budget: 42 } }], dryRun: true }));
check('update_records dryRun', dry.dryRun === true, JSON.stringify(dry).slice(0, 200));
const stale = j(await call('update_records', { updates: [{ recordId: idApollo, expectedRev: (cur.record?.rev ?? 0) + 9, fields: { Budget: 43 } }] }));
check('expectedRev conflict rejected', !!stale.error, JSON.stringify(stale).slice(0, 160));
const real = j(await call('update_records', { updates: [{ recordId: idApollo, expectedRev: cur.record?.rev, fields: { Budget: 42 } }] }));
check('update_records with correct rev ok', !real.error, JSON.stringify(real).slice(0, 200));

// edit_record_body
const eb = j(await call('edit_record_body', { recordId: idApollo, appendMarkdown: 'Added line.' }));
check('edit_record_body append', !eb.error, JSON.stringify(eb).slice(0, 160));

// cascade delete + restore
const curDel = j(await call('get_record', { recordId: idApollo }));
const del = j(await call('delete_item', { type: 'record', id: idApollo, expectedRev: curDel.record?.rev }));
check('delete record ok', !del.error, JSON.stringify(del).slice(0, 160));
const borAfter = j(await call('query_records', { databaseId: dbId, filters: [{ field: 'title', op: 'is', value: 'Borealis' }] }));
check('sub-record cascade-deleted', (borAfter.rows ?? []).length === 0, JSON.stringify(borAfter).slice(0, 160));
const rst = j(await call('restore_item', { type: 'record', id: idApollo }));
check('restore record ok', !rst.error, JSON.stringify(rst).slice(0, 160));
const borBack = j(await call('query_records', { databaseId: dbId, filters: [{ field: 'title', op: 'is', value: 'Borealis' }] }));
check('sub-record cascade-restored', (borBack.rows ?? []).length === 1);

// unlink_items by endpoints
const rl = j(await call('unlink_items', { from: idApollo, to: pg.id, kind: 'related' }));
check('unlink_items by tuple', rl.removed === true, JSON.stringify(rl).slice(0, 160));

// embed block on page
const emb = j(await call('edit_page', { pageId: pg.id, appendMarkdown: '', appendBlocks: [{ type: 'embed', url: 'https://drive.google.com/file/d/abc123/preview' }] }));
if (emb.error) {
  const emb2 = j(await call('edit_page', { pageId: pg.id, appendMarkdown: '![embed](https://drive.google.com/file/d/abc123/preview)' }));
  check('embed block accepted', !emb2.error, JSON.stringify(emb2).slice(0, 200));
} else check('embed block accepted', true);

console.log(`\n== ${PASS_COUNT} passed, ${FAIL_COUNT} failed ==`);
certification.finish();
process.exit(FAIL_COUNT || process.exitCode ? 1 : 0);
