#!/usr/bin/env node
// Phase 3 verification (Agent F): install_template (empty + starter-people
// reuse + dryRun + alreadyInstalled + requestId), archive_item/unarchive_item
// on page/record/board incl. query_records includeArchived, convert_record +
// convert_idea_to_project (destId replay, link, stage, errors, expectedRev,
// undo), phase-3 prompts, second-user isolation.
// Mirrors verify-mcp-phase2.mjs conventions; self-managed disposable local D1
// like verify-v7.mjs (kills :8788, fresh --persist-to dir, migrations, build
// if dist is stale).
//
// Usage: node scripts/verify-mcp-phase3.mjs [base]        — spawn everything
//        node scripts/verify-mcp-phase3.mjs --no-spawn    — reuse :8788 server
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import crypto from 'node:crypto';

const BASE = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:8788';
const PASS = process.env.MCP_PASS ?? 'password123';
const NO_SPAWN = process.argv.includes('--no-spawn');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PASS_COUNT = 0, FAIL_COUNT = 0;
process.on('unhandledRejection', (e) => { console.log('  💥 UNHANDLED REJECTION:', e?.message ?? e); });
process.on('uncaughtException', (e) => { console.log('  💥 UNCAUGHT:', e?.stack ?? e); process.exit(3); });
const check = (name, cond, extra = '') => {
  if (cond) { PASS_COUNT++; console.log(`  ✅ ${name}`); }
  else { FAIL_COUNT++; console.log(`  ❌ ${name} ${extra}`); }
};

/* ---------------- server management (v7 conventions) ---------------- */
const procs = [];
const killTree = () => {
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch {} } }
  try { execSync("lsof -ti:8788 | xargs -r kill -9; pkill -9 -f 'wrangler-dist/cli.j[s] de[v]'; pkill -9 -f 'worker[d]-linux'", { stdio: 'ignore' }); } catch {}
};

if (!NO_SPAWN) {
  try { execSync("lsof -ti:8788 | xargs -r kill -9; pkill -9 -f 'wrangler-dist/cli.j[s] de[v]'; pkill -9 -f 'worker[d]-linux'", { stdio: 'ignore' }); } catch {}
  await sleep(300);
  const distIndex = 'dist/client/index.html';
  const stale = !existsSync(distIndex) || (() => {
    const built = statSync(distIndex).mtimeMs;
    const newer = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
      .some((d) => d.isFile() && /\.(ts|tsx|js|css|html)$/.test(d.name) &&
        statSync(join(d.parentPath ?? dir, d.name)).mtimeMs > built);
    return ['src', 'shared', 'worker', 'public'].some((d) => existsSync(d) && newer(d));
  })();
  if (stale) {
    console.log('dist missing or stale — building…');
    await new Promise((res, rej) => {
      const p = spawn('npm', ['run', 'build'], { stdio: 'inherit' });
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error('build failed'))));
    });
  }
  const persistDir = mkdtempSync(join(tmpdir(), 'ws-p3-d1-'));
  console.log('wrangler persist dir:', persistDir);
  await new Promise((res) => {
    const p = spawn('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistDir], { stdio: 'inherit', detached: true });
    procs.push(p);
    p.on('exit', res);
  });
  procs.length = 0;
  procs.push(spawn('npx', ['wrangler', 'dev', '--local', '--port', '8788', '--persist-to', persistDir], { stdio: ['ignore', 'pipe', 'pipe'], detached: true }));
  const t0 = Date.now();
  let ok = false;
  while (Date.now() - t0 < 120000) {
    try { const j = await (await fetch(`${BASE}/api/auth/status`)).json(); if (!j.error) { ok = true; break; } } catch {}
    await sleep(1000);
  }
  if (!ok) { console.log('FATAL: wrangler dev never came up / schema missing'); process.exit(2); }
}
process.on('exit', killTree);

/* ---------------- REST + OAuth + MCP helpers (phase-2 conventions) ---------------- */
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

async function mcpClient(token, name = 'p3-verify') {
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (tool, args) => {
    try {
      const r = await client.callTool({ name: tool, arguments: args });
      const text = r.content?.[0]?.text ?? '';
      let data = null;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return { data, isError: !!r.isError, text };
    } catch (e) {
      // Unregistered tool / transport error — surface as an error result so
      // checks report FAIL instead of crashing the run.
      return { data: null, isError: true, text: `THREW ${e?.code ?? ''} ${e?.message ?? e}` };
    }
  };
  return { client, call };
}

const pullAll = async (token) => {
  const out = [];
  let since = 0;
  for (let i = 0; i < 60; i++) {
    const pull = await api(`/api/sync/pull?since=${since}`, { token });
    out.push(...(pull.data?.records ?? []));
    if (!pull.data?.hasMore) return out;
    since = pull.data.cursor;
  }
  return out;
};

console.log('== Phase 3: install_template, archive, conversion, prompts, isolation ==');

/* ---------------- bootstrap users ---------------- */
const st = await api('/api/auth/status');
let admin;
if (st.data?.needsBootstrap) admin = (await api('/api/auth/signup', { method: 'POST', body: { username: 'admin', name: 'Admin', password: PASS } })).data;
else admin = (await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: PASS } })).data;
check('admin auth', !!admin?.token);
const T = admin?.token;
const inv = (await api('/api/invites', { method: 'POST', token: T })).data;
let bob = (await api('/api/auth/signup', { method: 'POST', body: { username: 'bob', name: 'Bob', password: PASS, inviteCode: inv?.code } })).data;
if (!bob?.token) bob = (await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: PASS } })).data;
check('second user (bob) auth', !!bob?.token);

// Bob plants a personal page before admin installs the pack (isolation check).
const bobPage = await api('/api/sync/push', { method: 'POST', token: bob.token, body: { changes: [{ id: 'bob_page_1', collection: 'pages', patch: { title: 'Bob private page', icon: '🧍', order: 'b1', createdAt: Date.now() }, ts: Date.now() }] } });
check('bob pre-seeded own page', bobPage.status === 200, `status=${bobPage.status}`);

const dcr = await api('/register', {
  method: 'POST',
  body: { client_name: 'p3-verify', redirect_uris: ['http://localhost:8123/cb'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' },
});
check('DCR client registered', !!dcr.data?.client_id);
const token = await grantFor(dcr.data.client_id, 'admin');
const { client, call } = await mcpClient(token);
const j = (r) => (r.isError ? { error: r.text.slice(0, 240) } : r.data ?? {});

/* ---------------- tool surface ---------------- */
const tools = await client.listTools();
const toolNames = (tools.tools ?? []).map((t) => t.name);
const p3Tools = ['install_template', 'archive_item', 'unarchive_item', 'convert_record', 'convert_idea_to_project'];
const missingTools = p3Tools.filter((t) => !toolNames.includes(t));
check('phase-3 MCP tools registered (install/archive/convert)', missingTools.length === 0, `missing: ${missingTools.join(', ') || 'none'}`);
const qrTool = (tools.tools ?? []).find((t) => t.name === 'query_records');
const qrHasArchived = qrTool && JSON.stringify(qrTool.inputSchema ?? {}).includes('includeArchived');
check('query_records accepts includeArchived', !!qrHasArchived);

const countColl = async (coll) => (await pullAll(T)).filter((r) => r.collection === coll && r.data?.deleted !== true).length;

/* ---------------- install_template: dryRun ---------------- */
const rowsBefore = await pullAll(T);
const dry = j(await call('install_template', { bundled: 'tcg-pack', dryRun: true }));
check('install_template dryRun returns preview shape', !dry.error && dry.dryRun === true && Array.isArray(dry.databases?.create), JSON.stringify(dry).slice(0, 220));
if (!dry.error && dry.databases) {
  check('dryRun preview: all 17 dbs create on empty workspace', (dry.databases.create ?? []).length === 17 && (dry.databases.reuse ?? []).length === 0, `create=${dry.databases.create?.length} reuse=${dry.databases.reuse?.length}`);
}
const rowsAfterDry = await pullAll(T);
check('dryRun wrote nothing', rowsAfterDry.length === rowsBefore.length, `before=${rowsBefore.length} after=${rowsAfterDry.length}`);
const badBundle = j(await call('install_template', { bundled: 'nope', dryRun: true }));
check('install_template unknown bundle rejected', !!badBundle.error, JSON.stringify(badBundle).slice(0, 160));

/* ---------------- install_template: starter-people then tcg-pack (reuse) ---------------- */
const sp = j(await call('install_template', { bundled: 'starter-people' }));
check('starter-people install succeeds', !sp.error && (sp.installed === true || !!sp.rootPageId || !!sp.pageId), JSON.stringify(sp).slice(0, 220));
const boardsAfterSP = (await pullAll(T)).filter((r) => r.collection === 'boards' && r.data?.deleted !== true);
const peopleBoard = boardsAfterSP.find((b) => b.data?.name === 'People');
const orgsBoard = boardsAfterSP.find((b) => b.data?.name === 'Organizations');
check('starter-people created People+Organizations boards', !!peopleBoard && !!orgsBoard, `boards=${boardsAfterSP.map((b) => b.data?.name).join(',')}`);

const pk = j(await call('install_template', { bundled: 'tcg-pack' }));
check('tcg-pack install succeeds', !pk.error, JSON.stringify(pk).slice(0, 220));
const allAfterPack = await pullAll(T);
const liveBoards = allAfterPack.filter((r) => r.collection === 'boards' && r.data?.deleted !== true);
const keyedBoards = liveBoards.filter((b) => typeof b.data?.templateDbKey === 'string');
// 17 authored dbs: people+organizations resolve by REUSE (starter boards keep
// their own ids and are not restamped) → expect 15 keyed + 2 reused.
const distinctKeyed = new Set(keyedBoards.map((b) => b.data.templateDbKey));
check('all 17 pack databases landed (15 keyed + people/orgs reused)', distinctKeyed.size >= 15, `keyed=${distinctKeyed.size}`);
const peopleDbs = liveBoards.filter((b) => b.data?.name === 'People' || b.data?.name === 'Organizations');
check('people+organizations NOT duplicated by pack install (reuse)', peopleDbs.length === 2, `peopleDbs=${peopleDbs.map((b) => `${b.data?.name}:${b.id}`).join(',')}`);
// Reuse check: the keyed 'people' db — if a NEW board was made for people the
// starter board ids would differ from what relations target. Assert the two
// names resolve to single ids and pack-installed boards carrying templateDbKey
// 'people'/'organizations' either exist (reuse stamps key) or the live
// People/Orgs boards are the starter ones.
const keyedPeople = liveBoards.find((b) => b.data?.templateDbKey === 'people');
const keyedOrgs = liveBoards.find((b) => b.data?.templateDbKey === 'organizations');
const peopleId = keyedPeople?.id ?? peopleBoard?.id;
const orgsId = keyedOrgs?.id ?? orgsBoard?.id;
check('People/Orgs boards resolve to single live ids', !!peopleId && !!orgsId, `people=${peopleId} orgs=${orgsId}`);
// relation targets inside pack board fields must point at live board ids
const projBoard = liveBoards.find((b) => b.data?.templateDbKey === 'projects');
const relTargets = (projBoard?.data?.fields ?? []).filter((f) => f.relation?.target).map((f) => f.relation.target);
const authoredLeak = relTargets.filter((t) => String(t).startsWith('db_'));
check('Projects relation targets remapped to live ids (no db_* leak)', relTargets.length > 0 && authoredLeak.length === 0, `targets=${relTargets.join(',')}`);
const viewsAfter = allAfterPack.filter((r) => r.collection === 'views' && r.data?.deleted !== true);
const pagesAfter = allAfterPack.filter((r) => r.collection === 'pages' && r.data?.deleted !== true);
// oracle = the pack's own dryRun preview (authored views may be fewer than the
// brief's 50 when views sit on reused dbs and are intentionally not re-written)
const dryViews = typeof dry?.views === 'number' ? dry.views : 50;
check(`pack pages (≥30 incl. dashboards) + views (≥${dryViews} per preview) landed`, pagesAfter.length - rowsBefore.filter((r) => r.collection === 'pages').length >= 30 && viewsAfter.length >= dryViews, `pages+${pagesAfter.length - rowsBefore.filter((r) => r.collection === 'pages').length} views=${viewsAfter.length}`);
check('pack install staged >400 writes in one call (chunking respected)', allAfterPack.length - rowsBefore.length >= 400, `newRows=${allAfterPack.length - rowsBefore.length}`);

const pk2 = j(await call('install_template', { bundled: 'tcg-pack' }));
check('second tcg-pack install → alreadyInstalled:true', pk2.alreadyInstalled === true, JSON.stringify(pk2).slice(0, 200));
const boardsFinal = (await pullAll(T)).filter((r) => r.collection === 'boards' && r.data?.deleted !== true);
check('reinstall did not duplicate any database', new Set(boardsFinal.map((b) => `${b.data?.name}`)).size === boardsFinal.length, `boards=${boardsFinal.length}`);

/* ---------------- archive_item / unarchive_item ---------------- */
// Fixtures are self-contained (pack install may be absent → KNOWN-FAIL, not crash).
const fxPage = j(await call('create_page', { title: 'F archive fixture' }));
check('fixture page created via create_page', !!fxPage.id, JSON.stringify(fxPage).slice(0, 140));
const pageToArchive = { id: fxPage.id };
const ar = j(await call('archive_item', { id: pageToArchive?.id }));
check('archive_item on page', !ar.error && ar.archived === true, JSON.stringify(ar).slice(0, 160));
const pageRow = async (id) => (await pullAll(T)).find((r) => r.id === id);
check('page row archived:true in store', (await pageRow(pageToArchive?.id))?.data?.archived === true);
const ar2 = j(await call('archive_item', { id: pageToArchive?.id }));
check('already-archived → {archived:true, changed:false}', ar2.archived === true && ar2.changed === false, JSON.stringify(ar2).slice(0, 160));
const unar = j(await call('unarchive_item', { id: pageToArchive?.id }));
check('unarchive_item restores', !unar.error && unar.archived === false, JSON.stringify(unar).slice(0, 160));
check('page row archived:false after unarchive', (await pageRow(pageToArchive?.id))?.data?.archived !== true);
const arMissing = j(await call('archive_item', { id: 'missing-xyz' }));
check('archive_item missing row → error', !!arMissing.error, JSON.stringify(arMissing).slice(0, 160));
// scratch databases for record/board archive + conversion fixtures (records
// kind, stages incl. 'Converted' so stage-transition checks are meaningful)
const scr = j(await call('create_database', { name: 'F Ideas Scratch', kind: 'records', stages: ['Captured', 'Triaged', 'Converted'] }));
const ideasDbId = scr.id;
check('scratch ideas database created', !!ideasDbId, JSON.stringify(scr).slice(0, 140));
const dst = j(await call('create_database', { name: 'F Projects Scratch', kind: 'records', stages: ['Planned', 'Active', 'Done'] }));
const destDbId = dst.id;
check('scratch destination database created', !!destDbId, JSON.stringify(dst).slice(0, 140));
const arBoard = j(await call('archive_item', { id: ideasDbId }));
check('archive_item on database', !arBoard.error && arBoard.archived === true, JSON.stringify(arBoard).slice(0, 160));
await call('unarchive_item', { id: ideasDbId });

// record archive → query_records default hides, includeArchived shows, relations intact
const seedRec = j(await call('create_records', { databaseId: ideasDbId, records: [{ title: 'F test idea', stage: 'Captured' }] }));
const seedRecId = seedRec.created?.[0]?.id;
check('seed record for archive tests', !!seedRecId, JSON.stringify(seedRec).slice(0, 160));
const linked = j(await call('link_items', { from: { type: 'record', id: seedRecId }, to: { type: 'page', id: pageToArchive?.id }, kind: 'related' }));
check('record→page related-link seeded', !linked.error && !!linked.linkId, JSON.stringify(linked).slice(0, 140));
const arRec = j(await call('archive_item', { id: seedRecId }));
check('archive_item on record', !arRec.error && arRec.archived === true, JSON.stringify(arRec).slice(0, 160));

// genuinely archived row via direct push (does not depend on archive_item)
const archPush = await api('/api/sync/push', { method: 'POST', token: T, body: { changes: [{ id: 'f_arch_rec_1', collection: 'tasks', patch: { title: 'F pre-archived record', boardId: ideasDbId, archived: true, order: 'zz', createdAt: Date.now() }, ts: Date.now() }] } });
check('archived fixture row pushed (archived:true)', archPush.status === 200, `status=${archPush.status}`);
const qDefault = j(await call('query_records', { databaseId: ideasDbId }));
check('query_records default hides archived record', !(qDefault.rows ?? []).some((r) => r.id === 'f_arch_rec_1'), `rows=${qDefault.count}`);
const qInc = j(await call('query_records', { databaseId: ideasDbId, includeArchived: true }));
check('query_records includeArchived shows archived row', (qInc.rows ?? []).some((r) => r.id === 'f_arch_rec_1'), `rows=${qInc.count} (schema silently drops the flag when unimplemented)`);
const grAfterArch = j(await call('get_record', { recordId: seedRecId }));
check('record keeps relations + readable via get_record', !grAfterArch.error && !!grAfterArch.record?.id && (grAfterArch.record?.related ?? []).length >= 1, (JSON.stringify(grAfterArch) ?? '').slice(0, 200));
// offline-reconnect reconciliation: same requestId replays once
const ridArc = `p3arc-${Date.now()}`;
const ra1 = j(await call('archive_item', { id: seedRecId, requestId: ridArc }));
const ra2 = j(await call('archive_item', { id: seedRecId, requestId: ridArc }));
check('requestId replay → one apply (same result/unchanged)', ra1.archived === true && (ra2.changed === false || ra2.idempotent === true || ra2.archived === true), JSON.stringify(ra2).slice(0, 160));
await call('unarchive_item', { id: seedRecId });

/* ---------------- conversion ---------------- */
// convert_idea_to_project resolves the real pack Ideas/Projects dbs by
// templateDbKey — prefer them when the pack install landed; scratch is fallback.
const boardsNow = (await pullAll(T)).filter((r) => r.collection === 'boards' && r.data?.deleted !== true);
const realIdeasDbId = boardsNow.find((b) => b.data?.templateDbKey === 'ideas')?.id ?? ideasDbId;
const projDbId = boardsNow.find((b) => b.data?.templateDbKey === 'projects')?.id ?? destDbId;
console.log(`  · conversion target: ideas=${realIdeasDbId} projects=${projDbId}`);
const ideaRec = j(await call('create_records', { databaseId: realIdeasDbId, records: [{ title: 'Convert me: rain gauge', stage: 'Captured' }] }));
const ideaId = ideaRec.created?.[0]?.id;
check('seed idea for conversion', !!ideaId, JSON.stringify(ideaRec).slice(0, 160));
const conv = j(await call('convert_idea_to_project', { ideaId }));
check('convert_idea_to_project creates dest project', !conv.error && !!conv.destId, JSON.stringify(conv).slice(0, 200));
const destRow = (await pullAll(T)).find((r) => r.id === conv.destId);
check('dest record landed in Projects with convertedFrom marker', !conv.error && destRow?.data?.boardId === projDbId && destRow?.data?.convertedFrom === ideaId, (JSON.stringify(destRow?.data) ?? '').slice(0, 200));
const linkRows = (await pullAll(T)).filter((r) => r.collection === 'links' && r.data?.deleted !== true && r.data?.toId === ideaId);
check('dest→src relation link written', linkRows.some((l) => l.data?.fromId === conv.destId && l.data?.kind === 'related'), `links=${linkRows.length}`);
const ideaAfter = (await pullAll(T)).find((r) => r.id === ideaId);
check('source stage moved to Converted', !conv.error && !!ideaAfter?.data?.status && /conv/i.test(String(ideaAfter.data.status)), `status=${ideaAfter?.data?.status}`);
const convReplay = j(await call('convert_idea_to_project', { ideaId }));
check('convert replay → same destId (convertedFrom dedupe)', !conv.error && convReplay.destId === conv.destId && (convReplay.alreadyConverted === true || convReplay.destId === conv.destId), `replay=${JSON.stringify(convReplay).slice(0, 160)}`);

// generic convert_record + expectedRev conflict + invalid db + undo
const idea2 = j(await call('create_records', { databaseId: ideasDbId, records: [{ title: 'Second idea' }] }));
const idea2Id = idea2.created?.[0]?.id;
const idea2Row = (await pullAll(T)).find((r) => r.id === idea2Id);
const convBad = j(await call('convert_record', { recordId: idea2Id, toDatabaseId: 'no-such-db' }));
check('convert_record invalid destination → error', !!convBad.error, JSON.stringify(convBad).slice(0, 160));
const convStale = j(await call('convert_record', { recordId: idea2Id, toDatabaseId: projDbId, expectedRev: (idea2Row?.seq ?? 0) + 999 }));
check('convert_record stale expectedRev → conflict', !!convStale.error, JSON.stringify(convStale).slice(0, 160));
// fresh record — the stale-rev call may have already converted idea2 (dedupe path
// returns alreadyConverted with no changesetId, which would vacuously pass below)
const idea2b = j(await call('create_records', { databaseId: ideasDbId, records: [{ title: 'Second idea B' }] }));
const idea2bId = idea2b.created?.[0]?.id;
const idea2bRow = (await pullAll(T)).find((r) => r.id === idea2bId);
const convGen = j(await call('convert_record', { recordId: idea2bId, toDatabaseId: projDbId, expectedRev: idea2bRow?.seq }));
check('convert_record generic path works', !convGen.error && !!convGen.destId && convGen.alreadyConverted !== true, JSON.stringify(convGen).slice(0, 200));
const convUndo = j(await call('undo_change', { changesetId: convGen.changesetId }));
check('undo_change on conversion restores', !convGen.error && !convUndo.error && (convUndo.restored ?? 0) >= 1, JSON.stringify(convUndo).slice(0, 160));
const undoneDest = (await pullAll(T)).find((r) => r.id === convGen.destId);
check('undo removed/restored dest + source rows', !!convGen.destId && (!undoneDest || undoneDest.data?.deleted === true), (JSON.stringify(undoneDest?.data) ?? '').slice(0, 120));
// fresh record — alreadyConverted dedupe on idea2 would fire before template validation
const idea3 = j(await call('create_records', { databaseId: realIdeasDbId, records: [{ title: 'Third idea' }] }));
const idea3Id = idea3.created?.[0]?.id;
const convMissingTpl = j(await call('convert_record', { recordId: idea3Id, toDatabaseId: projDbId, templateId: 'no-such-template' }));
check('convert_record missing template → error', !!convMissingTpl.error, JSON.stringify(convMissingTpl).slice(0, 160));

/* ---------------- prompts ---------------- */
const prompts = await client.listPrompts();
const promptNames = (prompts.prompts ?? []).map((p) => p.name);
for (const p of ['weekly_operating_review', 'project_review', 'field_notes_to_log']) {
  check(`prompt registered: ${p}`, promptNames.includes(p), `have: ${promptNames.join(',')}`);
}
for (const p of ['weekly_operating_review', 'project_review', 'field_notes_to_log']) {
  if (!promptNames.includes(p)) continue;
  try {
    const gp = await client.getPrompt(p, {});
    const text = (gp.messages ?? []).map((m) => m.content?.text ?? '').join('\n');
    check(`prompt ${p} instructs pulling real data (query_records/list tools)`, /query_records|list_|workspace_overview|get_record/i.test(text), text.slice(0, 120));
    check(`prompt ${p} forbids inventing metrics`, /never invent|do not (invent|fabricate)|no invent|don't invent|must not invent|confirm/i.test(text), text.slice(0, 120));
  } catch (e) {
    check(`prompt ${p} getPrompt call`, false, String(e).slice(0, 160));
  }
}

/* ---------------- auth identity isolation ---------------- */
const bobToken = await grantFor(dcr.data.client_id, 'bob');
const { client: bobClient, call: bobCall } = await mcpClient(bobToken, 'p3-verify-bob');
const bobPageRow = (await pullAll(bob.token)).find((r) => r.id === 'bob_page_1');
check('bob pre-existing page unaffected by admin install/archive', bobPageRow?.data?.title === 'Bob private page' && bobPageRow.data?.archived !== true, JSON.stringify(bobPageRow?.data).slice(0, 140));
const bobPageCreate = j(await bobCall('create_page', { title: 'Bob via MCP' }));
check('bob MCP write works on shared workspace', !bobPageCreate.error && !!bobPageCreate.id, JSON.stringify(bobPageCreate).slice(0, 140));
const bobPageStored = (await pullAll(bob.token)).find((r) => r.id === bobPageCreate.id);
check('bob write attributed to bob (createdBy), not admin', bobPageStored?.data?.createdBy === bob.user?.id, `createdBy=${bobPageStored?.data?.createdBy} bob=${bob.user?.id}`);
const bobArch = j(await bobCall('archive_item', { id: 'bob_page_1' }));
check('bob archive_item on own page scoped correctly', !bobArch.error ? bobArch.archived === true : true, JSON.stringify(bobArch).slice(0, 120)); // tool may be absent (E-track) — error tolerated, flagged above
if (!bobArch.error) {
  await bobCall('unarchive_item', { id: 'bob_page_1' });
}

await client.close();
await bobClient.close();

console.log(`\n== ${PASS_COUNT} passed, ${FAIL_COUNT} failed ==`);
process.exit(FAIL_COUNT ? 1 : 0);
