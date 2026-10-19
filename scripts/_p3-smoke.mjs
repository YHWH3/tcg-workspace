#!/usr/bin/env node
import {enableFixtureHuman} from './certification/human-review.mjs';
import {fixtureFetch} from './certification/oauth-consent.mjs';
// Phase 3 (Agent E) verification: install_template (starter-people + tcg-pack,
// dryRun/alreadyInstalled/unknown-key), archive_item/unarchive_item round-trip,
// query_records includeArchived, convert_record + convert_idea_to_project,
// prompts list/get.
// Requires `wrangler dev --local --port 8788` + smoke.sh users seeded.
// Usage: node scripts/_p3-smoke.mjs [base]   default http://localhost:8788
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import crypto from 'node:crypto';

const BASE = process.argv[2] ?? 'http://localhost:8788';
const PASS = process.env.MCP_PASS ?? 'password123';
const USER = process.env.MCP_USER ?? 'admin';
let PASS_COUNT = 0, FAIL_COUNT = 0;
const check = (name, cond, extra = '') => {
  if (cond) { PASS_COUNT++; console.log(`  ✅ ${name}`); }
  else { FAIL_COUNT++; console.log(`  ❌ ${name} ${extra}`); }
};
const api = async (path, { method = 'GET', token, body, form, raw, cookie } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (body) headers['Content-Type'] = 'application/json';
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const res = await fixtureFetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined, redirect: 'manual' });
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
  const client = new Client({ name: 'p3-verify', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  enableFixtureHuman(client,BASE,{username:USER,password:PASS});
  return { client, call: async (tool, args) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { data, isError: !!r.isError, text };
  } };
}

console.log('== Phase 3 Agent E: install_template, archive, convert, includeArchived, prompts ==');

const login = await api('/api/auth/login', { method: 'POST', body: { username: USER, password: PASS } });
check('session login', !!login.data?.token);

const dcr = await api('/register', {
  method: 'POST',
  body: { client_name: 'p3-verify', redirect_uris: ['http://localhost:8123/cb'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' },
});
check('DCR client registered', !!dcr.data?.client_id);
const token = await grantFor(dcr.data.client_id, USER);
const { client, call } = await mcpClient(token);
const j = (r) => (r.isError ? { error: r.text.slice(0, 200) } : r.data ?? {});

// --- install_template: starter-people ---
const instPeople = j(await call('install_template', { bundled: 'starter-people' }));
check('install starter-people', instPeople.installed === true && !!instPeople.rootPageId, JSON.stringify(instPeople).slice(0, 220));
check('install returns url + counts', /\/pages\//.test(instPeople.url ?? '') && (instPeople.counts?.pages ?? 0) >= 1, JSON.stringify(instPeople).slice(0, 220));

// --- install_template: unknown key rejected ---
const bad = j(await call('install_template', { bundled: 'no-such-pack' }));
check('unknown bundled key rejected', !!bad.error, JSON.stringify(bad).slice(0, 160));

// --- install_template: tcg-pack dryRun shows preview (people db reused) ---
const dry = j(await call('install_template', { bundled: 'tcg-pack', dryRun: true }));
check('tcg-pack dryRun', dry.dryRun === true && !!dry.databases, JSON.stringify(dry).slice(0, 300));
check('dryRun previews creates', (dry.databases?.create?.length ?? 0) > 0 && (dry.pages ?? 0) > 10, JSON.stringify(dry).slice(0, 300));
check('dryRun reuses starter-people boards', (dry.databases?.reuse?.length ?? 0) >= 1, JSON.stringify(dry.databases));

// --- install_template: tcg-pack for real ---
const inst = j(await call('install_template', { bundled: 'tcg-pack' }));
check('install tcg-pack', inst.installed === true && !!inst.rootPageId, JSON.stringify(inst).slice(0, 220));
check('tcg-pack writes boards+pages+records', (inst.counts?.boards ?? 0) >= 10 && (inst.counts?.pages ?? 0) >= 30 && (inst.counts?.tasks ?? 0) > 0, JSON.stringify(inst.counts));
check('tcg-pack reuse reports databases', (inst.reuse?.databases ?? 0) >= 1, JSON.stringify(inst.reuse));

// --- alreadyInstalled marker: re-run without force ---
const again = j(await call('install_template', { bundled: 'tcg-pack' }));
check('re-install → alreadyInstalled', again.alreadyInstalled === true && /\/pages\//.test(again.pageUrl ?? ''), JSON.stringify(again).slice(0, 200));

// --- find the Ideas/Projects boards installed by the pack ---
const ov = j(await call('workspace_overview', {}));
const boards = ov.databases ?? ov.boards ?? [];
const ideasDb = boards.find((b) => b.templateDbKey === 'ideas' || /ideas/i.test(b.name ?? ''));
const projectsDb = boards.find((b) => b.templateDbKey === 'projects' || /projects/i.test(b.name ?? ''));
check('pack installed Ideas db', !!ideasDb?.id, JSON.stringify(boards.map((b) => b.name).slice(0, 25)));
check('pack installed Projects db', !!projectsDb?.id);

// --- convert_idea_to_project: seed an idea then convert ---
const ideaSeed = j(await call('create_records', { databaseId: ideasDb.id, records: [{ title: 'E2E idea → project' }] }));
const ideaId = (ideaSeed.created ?? [])[0]?.id;
check('seed idea record', !!ideaId, JSON.stringify(ideaSeed).slice(0, 200));
const conv = j(await call('convert_idea_to_project', { ideaId }));
check('convert_idea_to_project', !!conv.destId && conv.destId !== ideaId, JSON.stringify(conv).slice(0, 240));
check('convert returns urls + link', /\/boards\//.test(conv.destUrl ?? '') && !!conv.linkId, JSON.stringify(conv).slice(0, 240));
// dedupe on re-run
const conv2 = j(await call('convert_idea_to_project', { ideaId }));
check('re-convert → alreadyConverted', conv2.alreadyConverted === true && conv2.destId === conv.destId, JSON.stringify(conv2).slice(0, 200));

// --- convert_record on two hand-made databases ---
const dbA = j(await call('create_database', { name: 'P3 Src', kind: 'records', stages: ['New', 'Triaged'] }));
const dbB = j(await call('create_database', { name: 'P3 Dest', kind: 'records', stages: ['Intake', 'Done'] }));
check('seed two small dbs', !!dbA.id && !!dbB.id, JSON.stringify(dbA).slice(0, 160));
const srcRec = j(await call('create_records', { databaseId: dbA.id, records: [{ title: 'Convert me' }] }));
const srcId = (srcRec.created ?? [])[0]?.id;
const srcBoard = j(await call('get_board', { boardId: dbA.id }));
const triagedId = (srcBoard.columns ?? srcBoard.stages ?? []).find((c) => /triaged/i.test(c.name ?? c))?.id;
check('resolve sourceStage column id', !!triagedId, JSON.stringify(srcBoard).slice(0, 200));
const c1 = j(await call('convert_record', { recordId: srcId, toDatabaseId: dbB.id, sourceStage: triagedId }));
check('convert_record creates dest', !!c1.destId && c1.destId !== srcId, JSON.stringify(c1).slice(0, 240));
check('convert_record src stage stamped', c1.warnings === undefined || Array.isArray(c1.warnings), JSON.stringify(c1.warnings));
const c2 = j(await call('convert_record', { recordId: srcId, toDatabaseId: dbB.id }));
check('convert_record dedupe → alreadyConverted', c2.alreadyConverted === true && c2.destId === c1.destId, JSON.stringify(c2).slice(0, 200));
const cBad = j(await call('convert_record', { recordId: 'missing-record', toDatabaseId: dbB.id }));
check('convert_record missing src rejected', !!cBad.error, JSON.stringify(cBad).slice(0, 160));

// --- archive/unarchive round-trip on the dest record ---
const q0 = j(await call('query_records', { databaseId: dbB.id }));
const destRow = (q0.records ?? q0.rows ?? []).find((r) => r.id === c1.destId);
check('dest row visible before archive', !!destRow && destRow.archived === false, JSON.stringify(destRow ?? q0).slice(0, 200));
const a1 = j(await call('archive_item', { id: c1.destId, collection: 'record' }));
check('archive_item record', a1.archived === true && a1.changed === true && a1.rev > 0, JSON.stringify(a1).slice(0, 200));
const a2 = j(await call('archive_item', { id: c1.destId, collection: 'record' }));
check('re-archive → changed:false', a2.archived === true && a2.changed === false, JSON.stringify(a2).slice(0, 200));
const qHid = j(await call('query_records', { databaseId: dbB.id }));
check('archived hidden by default', !(qHid.records ?? qHid.rows ?? []).some((r) => r.id === c1.destId));
const qInc = j(await call('query_records', { databaseId: dbB.id, includeArchived: true }));
const archRow = (qInc.records ?? qInc.rows ?? []).find((r) => r.id === c1.destId);
check('includeArchived shows archived row', !!archRow && archRow.archived === true, JSON.stringify(archRow ?? qInc).slice(0, 200));
const u1 = j(await call('unarchive_item', { id: c1.destId }));
check('unarchive_item (probe by id)', u1.archived === false && u1.changed === true && u1.collection === 'record', JSON.stringify(u1).slice(0, 200));
const u2 = j(await call('unarchive_item', { id: c1.destId }));
check('re-unarchive → changed:false', u2.changed === false, JSON.stringify(u2).slice(0, 200));
const aMissing = j(await call('archive_item', { id: 'nope-missing' }));
check('archive missing id → err', !!aMissing.error, JSON.stringify(aMissing).slice(0, 160));
// page archive via probe
const pg = j(await call('create_page', { title: 'P3 archive page' }));
const aPg = j(await call('archive_item', { id: pg.id }));
check('archive page via collection probe', aPg.archived === true && aPg.collection === 'page', JSON.stringify(aPg).slice(0, 200));

// --- prompts: list + get ---
const pl = await client.listPrompts();
const names = (pl.prompts ?? []).map((p) => p.name);
check('prompts include weekly_operating_review', names.includes('weekly_operating_review'), JSON.stringify(names));
check('prompts include project_review', names.includes('project_review'));
check('prompts include field_notes_to_log', names.includes('field_notes_to_log'));
const gp = await client.getPrompt({ name: 'weekly_operating_review', arguments: {} });
check('weekly_operating_review get → user message', gp.messages?.[0]?.role === 'user' && /query_records/.test(gp.messages[0].content?.text ?? ''), JSON.stringify(gp.messages?.[0]?.content?.text ?? '').slice(0, 120));
const gp2 = await client.getPrompt({ name: 'project_review', arguments: { projectId: c1.destId } });
check('project_review get interpolates id', (gp2.messages?.[0]?.content?.text ?? '').includes(c1.destId));
const gp3 = await client.getPrompt({ name: 'field_notes_to_log', arguments: { notes: 'pump reading 42' } });
check('field_notes_to_log get interpolates notes', (gp3.messages?.[0]?.content?.text ?? '').includes('pump reading 42'));

console.log(`\n== ${PASS_COUNT} passed, ${FAIL_COUNT} failed`);
process.exit(FAIL_COUNT ? 1 : 0);
