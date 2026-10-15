#!/usr/bin/env node
// Phase 0 verification: two OAuth users (admin=A, bob=B) against one wrangler
// dev isolate. Covers docs/architecture/phase-0-safe-ai-editing.md §12.
// Requires `wrangler dev --port 8788` on the built app + smoke.sh users seeded.
// Usage: node scripts/verify-mcp-multiuser.mjs [base]   default http://localhost:8788
import { createCertificationReporter, localOrigin } from './certification-report.mjs';
import { assertionManifests } from './certification-manifests.mjs';
const certification = createCertificationReporter('verify-mcp-multiuser', assertionManifests['verify-mcp-multiuser']);
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import crypto from 'node:crypto';

const BASE = localOrigin(process.argv[2] ?? process.env.CERT_BASE ?? 'http://localhost:8788');
const PASS = process.env.MCP_PASS ?? 'password123';
const USER_A = process.env.MCP_USER_A ?? 'admin';
const USER_B = process.env.MCP_USER_B ?? 'bob';

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
check('OAuth grant for user A', !!tokenA);
const tokenB = await grantFor(clientId, USER_B);
check('OAuth grant for user B', !!tokenB);

const A = await mcpClient(tokenA, 'verify-A');
const B = await mcpClient(tokenB, 'verify-B');
check('both MCP clients connected', true);

const ov = await A.call('workspace_overview', {});
const idA = ov.data.people.find((u) => u.username === USER_A)?.id;
const idB = ov.data.people.find((u) => u.username === USER_B)?.id;
check('resolved user ids', !!idA && !!idB && idA !== idB);
const concurrent=await Promise.all(Array.from({length:6},async(_,i)=>({want:i%2?idB:idA,res:await (i%2?B:A).call('create_page',{title:`Security concurrent ${Date.now()} ${i}`,requestId:`security-concurrent-${i}`})})));
check('security: concurrent MCP calls complete for both users',concurrent.every(w=>!w.res.isError&&w.res.data.id&&w.res.data.changesetId));


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
check('security: concurrent MCP writes retain user and changeset attribution',concurrent.every(w=>all.get(w.res.data.id)?.data.createdBy===w.want&&[...all.values()].some(r=>r.collection==='activity'&&r.data.targetId===w.res.data.id&&r.data.actorId===w.want&&r.data.meta?.changesetId===w.res.data.changesetId)));

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

/* ================= review B1: undo authorization ================= */
console.log('\n== 2. undo changeset authorization (review B1) ==');

const bobLogin = await api('/api/auth/login', { method: 'POST', body: { username: USER_B, password: PASS } });
check('bob session login', !!bobLogin.data.token, bobLogin.text.slice(0, 160));

const cpForUndo = await A.call('create_page', { title: `${RUN}-UNDO-TARGET`, markdown: 'keep me' });
check('A create_page for undo target', !cpForUndo.isError && !!cpForUndo.data.id && !!cpForUndo.data.changesetId, cpForUndo.text.slice(0, 160));
const undoTargetId = cpForUndo.data.id;
const undoTargetCs = cpForUndo.data.changesetId;

// B via MCP — must be refused, and the page must stay.
const bUndoMcp = await B.call('undo_change', { changesetId: undoTargetCs });
check('B undo_change of A changeset → forbidden', bUndoMcp.isError && /forbidden/.test(bUndoMcp.text), bUndoMcp.text.slice(0, 160));

// B via HTTP — same rule on the REST path.
const bUndoHttp = await api(`/api/changes/${undoTargetCs}/undo`, { method: 'POST', token: bobLogin.data.token });
check('B POST /api/changes/:id/undo → 403', bUndoHttp.status === 403, `status=${bUndoHttp.status} ${bUndoHttp.text.slice(0, 120)}`);

const allAfterDeny = await pullAll(adminLogin.data.token);
const pageAfterDeny = allAfterDeny.get(undoTargetId);
check('page untouched after denied undos', !!pageAfterDeny && pageAfterDeny.data.deleted !== true && pageAfterDeny.data.title === `${RUN}-UNDO-TARGET`);
const csAfterDeny = await api(`/api/changes/${undoTargetCs}`, { token: adminLogin.data.token });
check('changeset not marked undone (zero undo writes)', csAfterDeny.status === 200 && csAfterDeny.data.changeset?.undone_by === null, csAfterDeny.text.slice(0, 160));

// A's own undo still works (owner path stays healthy).
const aUndo = await A.call('undo_change', { changesetId: undoTargetCs });
check('A undo_change of own changeset → ok', !aUndo.isError && aUndo.data.restored !== undefined, aUndo.text.slice(0, 160));
const allAfterUndo = await pullAll(adminLogin.data.token);
check('page deleted by owner undo', allAfterUndo.get(undoTargetId)?.data?.deleted === true);

/* ================= review B2: atomic expectedRev ================= */
console.log('\n== 3. atomic expectedRev gate (review B2) ==');

const adb = await A.call('create_database', { name: `${RUN}-Atomic`, kind: 'records' });
check('create_database for atomic test', !adb.isError && !!adb.data.id, adb.text.slice(0, 160));
const aRecs = await A.call('create_records', { databaseId: adb.data.id, records: [{ title: `${RUN}-R1` }, { title: `${RUN}-R2` }, { title: `${RUN}-R3` }] });
const [r1, r2, r3] = (aRecs.data.created ?? []).map((c) => c.id);
check('create_records x3', !!r1 && !!r2 && !!r3, aRecs.text.slice(0, 160));

const g1 = await A.call('get_record', { recordId: r1 });
const g2 = await A.call('get_record', { recordId: r2 });
const rev1 = g1.data.record?.rev;
const rev2 = g2.data.record?.rev;
check('read revs for r1/r2', Number.isFinite(rev1) && Number.isFinite(rev2));

// B edits r2 in between → r2's stored rev moves past what A read.
const bBump = await B.call('update_records', { updates: [{ recordId: r2, title: `${RUN}-R2-byB` }] });
check('B writes r2 (forced interleave)', !bBump.isError, bBump.text.slice(0, 160));

// A calls update_records: 2 expected revs (r1 fresh, r2 stale) + 1 non-expected op (r3).
const atomicRes = await A.call('update_records', {
  updates: [
    { recordId: r1, expectedRev: rev1, title: `${RUN}-R1-byA` },
    { recordId: r2, expectedRev: rev2, title: `${RUN}-R2-byA` },
    { recordId: r3, title: `${RUN}-R3-byA` },
  ],
});
check('stale expectedRev in batch → conflict error', atomicRes.isError && /conflict/.test(atomicRes.text), atomicRes.text.slice(0, 200));

const allAtomic = await pullAll(adminLogin.data.token);
check('no partial apply: r1 untouched', allAtomic.get(r1)?.data?.title === `${RUN}-R1`, String(allAtomic.get(r1)?.data?.title));
check('no partial apply: r2 kept B write', allAtomic.get(r2)?.data?.title === `${RUN}-R2-byB`, String(allAtomic.get(r2)?.data?.title));
check('no partial apply: non-expected r3 skipped', allAtomic.get(r3)?.data?.title === `${RUN}-R3`, String(allAtomic.get(r3)?.data?.title));

// Retry with fresh revs lands all three atomically.
const g2b = await A.call('get_record', { recordId: r2 });
const atomicRetry = await A.call('update_records', {
  updates: [
    { recordId: r1, expectedRev: rev1, title: `${RUN}-R1-byA` },
    { recordId: r2, expectedRev: g2b.data.record?.rev, title: `${RUN}-R2-byA` },
    { recordId: r3, title: `${RUN}-R3-byA` },
  ],
});
check('retry with fresh revs succeeds', !atomicRetry.isError, atomicRetry.text.slice(0, 160));
const allAtomic2 = await pullAll(adminLogin.data.token);
check('retry wrote all three records', allAtomic2.get(r1)?.data?.title === `${RUN}-R1-byA` && allAtomic2.get(r2)?.data?.title === `${RUN}-R2-byA` && allAtomic2.get(r3)?.data?.title === `${RUN}-R3-byA`);

// VERIFY-B2: on real D1, the atomic batch lands as ONE committed changeset
// containing exactly the three writes — and the earlier conflicted call
// committed nothing for these ids.
check('atomic retry committed a changeset', !!atomicRetry.data?.changesetId, JSON.stringify(atomicRetry.data ?? atomicRetry.text).slice(0, 160));
const csAtomic = await api(`/api/changes/${atomicRetry.data?.changesetId}`, { token: adminLogin.data.token });
const atomicItemIds = new Set((csAtomic.data?.items ?? []).map((i) => i.record_id));
check('changeset contains exactly the 3 batch writes', csAtomic.status === 200 && atomicItemIds.size === 3 && [r1, r2, r3].every((id) => atomicItemIds.has(id)), JSON.stringify(csAtomic.data?.items?.map((i) => i.record_id) ?? []));
check('changeset actor is A', csAtomic.data?.changeset?.user_id === idA, `user_id=${csAtomic.data?.changeset?.user_id}`);

/* ================= review B3: block-level rev guards ================= */
console.log('\n== 4. block-level rev guards (review B3) ==');

const pg3 = await A.call('create_page', { title: `${RUN}-B3`, markdown: 'block one\n\nblock two' });
check('create page for block-rev test', !pg3.isError && !!pg3.data.id, pg3.text.slice(0, 160));
const gp0 = await A.call('get_page', { pageId: pg3.data.id });
const b1 = gp0.data.blocks?.[0];
check('get_page exposes per-block rev', !!b1 && Number.isFinite(b1.rev), gp0.text.slice(0, 160));

// correct-rev success
const okRep = await A.call('edit_page', { pageId: pg3.data.id, replaceBlocks: [{ blockId: b1.id, markdown: 'block one edited', expectedRev: b1.rev }] });
check('correct block rev → success', !okRep.isError, okRep.text.slice(0, 160));

// stale-block conflict: B bumps b1, then A writes with the pre-bump rev.
const gp1 = await A.call('get_page', { pageId: pg3.data.id });
const b1v2 = gp1.data.blocks[0];
const bBlock = await B.call('edit_page', { pageId: pg3.data.id, replaceBlocks: [{ blockId: b1.id, markdown: 'B concurrent edit', expectedRev: b1v2.rev }] });
check('B edits same block (fresh rev)', !bBlock.isError, bBlock.text.slice(0, 160));
const staleBlock = await A.call('edit_page', { pageId: pg3.data.id, replaceBlocks: [{ blockId: b1.id, markdown: 'A stale edit', expectedRev: b1v2.rev }] });
check('stale block rev → conflict', staleBlock.isError && /conflict/.test(staleBlock.text), staleBlock.text.slice(0, 200));
const gp2 = await A.call('get_page', { pageId: pg3.data.id });
check('block kept B write (no clobber)', gp2.data.blocks[0].text === 'B concurrent edit', gp2.data.blocks[0].text);

// page-vs-block interleave: block moved, but A edits page FIELDS at the
// current page rev → allowed (block and page revs guard different rows).
const pageRevNow = gp2.data.page.rev;
const titleOk = await A.call('edit_page', { pageId: pg3.data.id, title: `${RUN}-B3-renamed`, expectedRev: pageRevNow });
check('page-field edit at page rev after block bump → ok', !titleOk.isError, titleOk.text.slice(0, 160));
const staleTitle = await A.call('edit_page', { pageId: pg3.data.id, title: 'another title', expectedRev: pageRevNow });
check('stale page rev on fields → conflict', staleTitle.isError && /conflict/.test(staleTitle.text), staleTitle.text.slice(0, 160));

// unguarded legacy shape refused
const legacyDel = await A.call('edit_page', { pageId: pg3.data.id, deleteBlockIds: ['whatever'] });
check('deleteBlockIds rejected (needs per-block rev)', legacyDel.isError && /deleteBlocks/.test(legacyDel.text), legacyDel.text.slice(0, 160));

// edit_record_body: same stale-block flow via bodyBlocks revs
const erbRec = await A.call('create_records', { databaseId: adb.data.id, records: [{ title: `${RUN}-ERB`, body: 'first body line' }] });
const erbId = erbRec.data.created?.[0]?.id;
const grb = await A.call('get_record', { recordId: erbId });
const rb1 = grb.data.record?.bodyBlocks?.[0];
check('get_record exposes bodyBlocks revs', !!rb1 && Number.isFinite(rb1.rev), grb.text.slice(0, 160));
const recBump = await B.call('edit_record_body', { recordId: erbId, replaceBlocks: [{ blockId: rb1.id, markdown: 'B body edit', expectedRev: rb1.rev }] });
check('B edits record body block', !recBump.isError, recBump.text.slice(0, 160));
const recStale = await A.call('edit_record_body', { recordId: erbId, replaceBlocks: [{ blockId: rb1.id, markdown: 'A stale body', expectedRev: rb1.rev }] });
check('stale record-block rev → conflict', recStale.isError && /conflict/.test(recStale.text), recStale.text.slice(0, 200));
const grb2 = await A.call('get_record', { recordId: erbId });
check('record body kept B write', /B body edit/.test(grb2.data.record?.body ?? ''), String(grb2.data.record?.body ?? '').slice(0, 80));

/* ================= review C2: casUpdate attribution ================= */
console.log('\n== 5. casUpdate attribution + undo field-skip (review C2/C1) ==');

const c2db = await A.call('create_database', { name: `${RUN}-C2DB` });
check('create_database for C2', !c2db.isError && !!c2db.data.id, c2db.text.slice(0, 160));
const c2dbId = c2db.data.id;
const gb0 = await B.call('get_board', { boardId: c2dbId });
const boardRev0 = gb0.data.board.rev;

// B mutates the board through the CAS path (add_stage → casUpdate).
const stageAdd = await B.call('add_stage', { boardId: c2dbId, name: 'Bob Stage' });
check('B add_stage (casUpdate path) ok', !stageAdd.isError && !!stageAdd.data.changesetId, stageAdd.text.slice(0, 160));

// The board row's updated_by must be B's user id — surfaced via a stale-rev
// conflict's changedBy (and not the literal string 'mcp').
const staleRename = await A.call('update_board', { boardId: c2dbId, name: 'A rename', expectedRev: boardRev0 });
const changedBy = staleRename.text.includes('conflicts') ? (JSON.parse(staleRename.text).conflicts?.[0]?.changedBy ?? null) : null;
check('stale board write → conflict', staleRename.isError && /conflict/.test(staleRename.text), staleRename.text.slice(0, 200));
check('updated_by attributes to B (not "mcp")', changedBy === idB, `changedBy=${changedBy} want ${idB}`);

// The casUpdate changeset itself is also B-owned.
const csB = await api(`/api/changes/${stageAdd.data.changesetId}`, { token: adminLogin.data.token });
check('casUpdate changeset actor is B', csB.data?.changeset?.user_id === idB, `user_id=${csB.data?.changeset?.user_id}`);

// Undo skip (C1's e2e face): B rewrites the SAME field A's changeset wrote —
// the undo must skip it rather than clobber B's edit.
const c1rec = await A.call('create_records', { databaseId: c2dbId, records: [{ title: `${RUN}-C1`, body: 'x' }] });
const c1rid = c1rec.data.created?.[0]?.id;
const titleChange = await A.call('update_records', { updates: [{ recordId: c1rid, title: 'A wrote this' }] });
check('A update_records title (has changeset)', !titleChange.isError && !!titleChange.data.changesetId, titleChange.text.slice(0, 160));
const bTitle = await B.call('update_records', { updates: [{ recordId: c1rid, title: 'B won this field' }] });
check('B update_records same field', !bTitle.isError, bTitle.text.slice(0, 160));
const undoOut = await A.call('undo_change', { changesetId: titleChange.data.changesetId });
check('undo of title change ok', !undoOut.isError, undoOut.text.slice(0, 200));
check('undo reported the skipped field', JSON.stringify(undoOut.data?.skipped ?? '').includes('title'), JSON.stringify(undoOut.data?.skipped ?? null)?.slice(0, 160));
const gr1 = await A.call('get_record', { recordId: c1rid });
check('undo kept B title (no clobber)', gr1.data.record?.title === 'B won this field', String(gr1.data.record?.title));

/* ================= review C3: idempotency retry-after-failure ================= */
console.log('\n== 6. idempotency retry-after-failure (review C3) ==');

const RID = `rid-${RUN}`;
// 1) deterministic failure: stage that does not exist yet → stored 'failed'.
const failCall = await A.call('update_stage', { boardId: c2dbId, stage: 'nosuch', name: 'Renamed Stage', requestId: RID });
check('update_stage missing stage → error (stored failed)', failCall.isError, failCall.text.slice(0, 160));
// 2) world state changes: the stage now exists.
const addSt = await B.call('add_stage', { boardId: c2dbId, name: 'nosuch' });
check('B add_stage nosuch', !addSt.isError, addSt.text.slice(0, 160));
// 3) retry SAME requestId+args: guarded takeover re-runs, not a replay.
const retryCall = await A.call('update_stage', { boardId: c2dbId, stage: 'nosuch', name: 'Renamed Stage', requestId: RID });
check('retry after failure re-runs and succeeds', !retryCall.isError, retryCall.text.slice(0, 160));
const gbC2 = await A.call('get_board', { boardId: c2dbId });
check('retried write landed (stage renamed)', (gbC2.data.columns ?? []).some((c) => c.name === 'Renamed Stage'), JSON.stringify(gbC2.data.columns ?? []).slice(0, 200));
// 4) 'done' replay protection: identical requestId returns the stored result.
const doneRid = `rid2-${RUN}`;
const firstDone = await A.call('update_stage', { boardId: c2dbId, stage: 'Renamed Stage', color: '#123456', requestId: doneRid });
const replay = await A.call('update_stage', { boardId: c2dbId, stage: 'Renamed Stage', color: '#123456', requestId: doneRid });
check('done requestId replays stored result', !firstDone.isError && !replay.isError && /"replayed":\s*true/.test(replay.text), replay.text.slice(0, 200));
// 5) same requestId with different args → refused.
const collided = await A.call('update_stage', { boardId: c2dbId, stage: 'Renamed Stage', name: 'Different Name', requestId: doneRid });
check('requestId+new args → collision error', collided.isError && /different arguments/.test(collided.text), collided.text.slice(0, 160));

/* ================= later Phase 0 scenarios land here ================= */

console.log(`\n== ${PASS_COUNT} passed, ${FAIL_COUNT} failed`);
certification.finish();
process.exit(FAIL_COUNT || process.exitCode ? 1 : 0);
