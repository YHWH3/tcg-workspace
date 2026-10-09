#!/usr/bin/env node
// Phase 2 verification: canvas item types, connectors↔links, frames, layouts,
// diagrams, board_to_canvas, calendar/timeline views, moodboard shares →
// public canvas API, svg sanitisation, dryRun/expectedRev/requestId/undo.
// Requires `wrangler dev --local --port 8788` + smoke.sh users seeded.
// Usage: node scripts/verify-mcp-phase2.mjs [base]   default http://localhost:8788
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
  const client = new Client({ name: 'p2-verify', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return async (tool, args) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { data, isError: !!r.isError, text };
  };
}

console.log('== Phase 2: canvas items, connectors, frames, diagrams, board_to_canvas, views, public canvas ==');

// REST session for file uploads + public canvas checks
const login = await api('/api/auth/login', { method: 'POST', body: { username: USER, password: PASS } });
const session = login.data?.token;
check('session login', !!session);

const dcr = await api('/register', {
  method: 'POST',
  body: { client_name: 'p2-verify', redirect_uris: ['http://localhost:8123/cb'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' },
});
check('DCR client registered', !!dcr.data?.client_id);
const token = await grantFor(dcr.data.client_id, USER);
const call = await mcpClient(token);
const j = (r) => (r.isError ? { error: r.text.slice(0, 200) } : r.data ?? {});

// --- seed a tasks database with stages + records for cards/board_to_canvas ---
const db = j(await call('create_database', { name: 'P2 Board', kind: 'tasks', stages: ['Backlog', 'Doing', 'Done'], fields: [{ name: 'Due', type: 'date' }] }));
check('seed tasks database', !!db.id && (db.stages ?? []).length === 3, JSON.stringify(db).slice(0, 200));
const recsR = j(await call('create_records', { databaseId: db.id, records: [
  { title: 'Card A', stage: 'Backlog', fields: { Due: '2026-10-12' } },
  { title: 'Card B', stage: 'Doing', dueDate: '2026-10-15' },
  { title: 'Card C', stage: 'Done' },
] }));
check('seed records x3', (recsR.created ?? []).length === 3, JSON.stringify(recsR).slice(0, 220));
const recId = (t) => (recsR.created ?? []).find((r) => r.title === t)?.id;
const dep = j(await call('add_dependency', { blocker: recId('Card A'), blocked: recId('Card B'), databaseId: db.id }));
check('seed dependency A blocks B', !!dep.linkId, JSON.stringify(dep).slice(0, 160));

// --- moodboard + items of every type ---
const mb = j(await call('create_moodboard', { title: 'P2 Canvas' }));
check('create_moodboard', !!mb.id, JSON.stringify(mb).slice(0, 160));

const base = j(await call('add_mood_items', { moodboardId: mb.id, items: [
  { type: 'note', text: 'sticky' },
  { type: 'text', text: 'label' },
  { type: 'color', color: '#ff8800' },
  { type: 'shape', shape: 'diamond', fill: '#00ff88', stroke: '#003322' },
  { type: 'svg', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>' },
  { type: 'card', ref: { type: 'record', id: recId('Card A') } },
] }));
check('add_mood_items 6 types', base.added === 6, JSON.stringify(base).slice(0, 220));
const gm0 = j(await call('get_moodboard', { moodboardId: mb.id }));
const itemOf = (pred) => gm0.items?.find(pred);
check('get_moodboard returns items', (gm0.items ?? []).length === 6, JSON.stringify(gm0.items?.map((i) => i.type)));
const card = itemOf((i) => i.type === 'card');
check('card resolves {title,stage}', card?.card?.title === 'Card A' && card?.card?.stage === 'Backlog', JSON.stringify(card?.card));

// adversarial svg in add_mood_items → stored sanitized (script stripped)
const bad = j(await call('add_mood_items', { moodboardId: mb.id, items: [{ type: 'svg', svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="4" height="4"/></svg>', x: 0, y: 0 }] }));
check('adversarial svg accepted-but-sanitized', !!bad.added, JSON.stringify(bad).slice(0, 160));
const noSvg = j(await call('add_mood_items', { moodboardId: mb.id, items: [{ type: 'svg' }] }));
check('svg without content rejected', !!noSvg.error, JSON.stringify(noSvg).slice(0, 160));
const gm1 = j(await call('get_moodboard', { moodboardId: mb.id }));
const storedScript = gm1.items?.find((i) => i.type === 'svg' && String(i.svg ?? '').includes('<rect'));
check('stored svg has no script content', !!storedScript && !String(storedScript.svg).includes('script'), String(storedScript?.svg).slice(0, 120));

// add_svg inline + requestId idempotency
const rid = `p2svg-${Date.now()}`;
const s1 = j(await call('add_svg', { moodboardId: mb.id, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><circle cx="2" cy="2" r="2"/></svg>', x: 5, y: 5, requestId: rid }));
check('add_svg inline', !!s1.id, JSON.stringify(s1).slice(0, 160));
const s1b = j(await call('add_svg', { moodboardId: mb.id, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><circle cx="2" cy="2" r="2"/></svg>', x: 5, y: 5, requestId: rid }));
check('add_svg requestId replay → same id', s1b.id === s1.id, `s1=${s1.id} replay=${s1b.id}`);
const sBad = j(await call('add_svg', { moodboardId: mb.id, svg: '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>x</script></body></foreignObject><circle r="3"/></svg>' }));
check('add_svg foreignObject sanitized', !sBad.error && !!sBad.id, JSON.stringify(sBad).slice(0, 160));
const gmS = j(await call('get_moodboard', { moodboardId: mb.id }));
const foItem = gmS.items?.find((i) => i.id === sBad.id);
check('foreignObject stripped from stored svg', !!foItem && !String(foItem.svg).includes('foreignObject') && !String(foItem.svg).includes('script'), String(foItem?.svg).slice(0, 120));
const sUrl = j(await call('add_svg', { moodboardId: mb.id, svgUrl: 'http://evil.example.com/x.svg' }));
check('add_svg rejects non-https url', !!sUrl.error, JSON.stringify(sUrl).slice(0, 160));

// connectors: card→card with linkKind mirrors a links row
const cardB = j(await call('add_mood_items', { moodboardId: mb.id, items: [{ type: 'card', ref: { type: 'record', id: recId('Card B') } }] }));
const gm2 = j(await call('get_moodboard', { moodboardId: mb.id }));
const cardIds = gm2.items.filter((i) => i.type === 'card').map((i) => i.id);
check('second card added', cardIds.length === 2, JSON.stringify(gm2.items?.length));
const c1 = j(await call('connect_items', { moodboardId: mb.id, from: cardIds[0], to: cardIds[1], linkKind: 'blocks', label: 'dep' }));
check('connect_items creates connector', (c1.created ?? []).length === 1, JSON.stringify(c1).slice(0, 220));
const gm3 = j(await call('get_moodboard', { moodboardId: mb.id }));
const conn = gm3.items.find((i) => i.type === 'connector');
check('connector has linkId + not dangling', !!conn?.linkId && conn.dangling === false, JSON.stringify(conn));
const c2 = j(await call('connect_items', { moodboardId: mb.id, from: cardIds[0], to: cardIds[1], linkKind: 'blocks' }));
check('connect_items dedupe → existed', (c2.existed ?? []).length === 1, JSON.stringify(c2).slice(0, 160));
const plain = j(await call('connect_items', { moodboardId: mb.id, from: gm3.items.find((i) => i.type === 'note')?.id, to: gm3.items.find((i) => i.type === 'text')?.id, style: 'dashed' }));
check('plain connector (no linkKind)', (plain.created ?? []).length === 1, JSON.stringify(plain).slice(0, 160));
const badEnd = j(await call('connect_items', { moodboardId: mb.id, from: 'nope', to: cardIds[0] }));
check('connect_items bad endpoint fails', (badEnd.failed ?? []).length === 1 || !!badEnd.error, JSON.stringify(badEnd).slice(0, 160));

// frame groups items
const noteIds = gm3.items.filter((i) => i.type === 'note' || i.type === 'text').map((i) => i.id);
const fr = j(await call('add_frame', { moodboardId: mb.id, itemIds: noteIds, title: 'Cluster' }));
check('add_frame', !!fr.id && fr.memberCount === 2, JSON.stringify(fr).slice(0, 160));
const gm4 = j(await call('get_moodboard', { moodboardId: mb.id }));
check('members carry parentFrameId', gm4.items.filter((i) => noteIds.includes(i.id)).every((i) => i.parentFrameId === fr.id));

// update_mood_items patch + expectedRev + stale conflict
const note = gm4.items.find((i) => i.type === 'note');
const up = j(await call('update_mood_items', { items: [{ id: note.id, expectedRev: note.rev, patch: { text: 'edited', color: '#123456' } }] }));
check('update_mood_items patch', up.updated === 1, JSON.stringify(up).slice(0, 160));
const staleUp = j(await call('update_mood_items', { items: [{ id: note.id, expectedRev: note.rev + 99, patch: { text: 'stale' } }] }));
check('update_mood_items stale rev rejected', !!staleUp.error && String(staleUp.error).includes('conflict'), JSON.stringify(staleUp).slice(0, 160));
const dryUp = j(await call('update_mood_items', { items: [{ id: note.id, patch: { text: 'x' } }], dryRun: true }));
check('update_mood_items dryRun', dryUp.dryRun === true, JSON.stringify(dryUp).slice(0, 160));

// layouts
const lg = j(await call('layout_moodboard', { moodboardId: mb.id, algorithm: 'grid' }));
check('layout grid', typeof lg.moved === 'number', JSON.stringify(lg).slice(0, 160));
const lf = j(await call('layout_moodboard', { moodboardId: mb.id, algorithm: 'by-frame' }));
check('layout by-frame', typeof lf.moved === 'number', JSON.stringify(lf).slice(0, 160));
const ls = j(await call('layout_moodboard', { moodboardId: mb.id, algorithm: 'by-stage', databaseId: db.id }));
check('layout by-stage', typeof ls.moved === 'number', JSON.stringify(ls).slice(0, 160));

// diagrams
const spec = { layout: 'auto-lr', nodes: [{ id: 'n1', label: 'Start' }, { id: 'n2', label: 'End' }], edges: [{ from: 'n1', to: 'n2' }] };
const dg = j(await call('add_diagram', { moodboardId: mb.id, spec }));
check('add_diagram', !!dg.id && dg.nodes === 2, JSON.stringify(dg).slice(0, 160));
const gm5 = j(await call('get_moodboard', { moodboardId: mb.id }));
const dgItem = gm5.items.find((i) => i.id === dg.id);
check('diagram stored as ONE item holding spec', dgItem?.type === 'diagram' && dgItem.spec?.nodes?.length === 2 && !gm5.items.some((i) => i.type === 'connector' && i.from === 'n1'));
const dgBad = j(await call('add_diagram', { moodboardId: mb.id, spec: { layout: 'auto-lr', nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'ghost' }] } }));
check('bad diagram rejected', !!dgBad.error, JSON.stringify(dgBad).slice(0, 160));
const ud = j(await call('update_diagram', { itemId: dg.id, expectedRev: dgItem.rev, spec: { ...spec, nodes: [...spec.nodes, { id: 'n3', label: 'Extra' }] } }));
check('update_diagram', ud.nodes === 3, JSON.stringify(ud).slice(0, 160));
const udStale = j(await call('update_diagram', { itemId: dg.id, expectedRev: 99999, spec }));
check('update_diagram stale rev rejected', !!udStale.error, JSON.stringify(udStale).slice(0, 160));

// board_to_canvas (flagship)
const b2c = j(await call('board_to_canvas', { databaseId: db.id }));
check('board_to_canvas creates board', !!b2c.moodboardId && b2c.created === true, JSON.stringify(b2c).slice(0, 240));
check('b2c frames per stage', b2c.frames === 3, `frames=${b2c.frames}`);
check('b2c cards', b2c.cards === 3, `cards=${b2c.cards}`);
check('b2c dep connector', b2c.connectors >= 1, `connectors=${b2c.connectors}`);
const b2cMb = j(await call('get_moodboard', { moodboardId: b2c.moodboardId }));
const frames = b2cMb.items.filter((i) => i.type === 'frame');
check('b2c frames carry frameStageOf', frames.every((f) => f.frameStageOf?.databaseId === db.id && f.frameStageOf?.stageId), JSON.stringify(frames.map((f) => f.frameStageOf)));
const bcards = b2cMb.items.filter((i) => i.type === 'card');
check('b2c cards parented to frames + resolved', bcards.length === 3 && bcards.every((cd) => cd.parentFrameId && cd.card?.title), JSON.stringify(bcards.map((x) => x.card)));
const b2cDry = j(await call('board_to_canvas', { databaseId: db.id, moodboardId: b2c.moodboardId, dryRun: true }));
check('b2c dryRun reports all skipped', b2cDry.dryRun === true && b2cDry.counts?.skippedExisting === 3, JSON.stringify(b2cDry).slice(0, 200));

// calendar + timeline views
const cal = j(await call('add_view', { databaseId: db.id, name: 'P2 Calendar', type: 'calendar', dateKey: 'dueDate' }));
check('add_view calendar', !!cal.id, JSON.stringify(cal).slice(0, 160));
const tl = j(await call('add_view', { databaseId: db.id, name: 'P2 Timeline', type: 'timeline', dateKey: 'Due', endDateKey: 'dueDate', timelineScale: 'month' }));
check('add_view timeline + date field name', !!tl.id, JSON.stringify(tl).slice(0, 160));
const badKey = j(await call('add_view', { databaseId: db.id, name: 'Bad Cal', type: 'calendar', dateKey: 'Nope' }));
check('add_view bad dateKey rejected', !!badKey.error, JSON.stringify(badKey).slice(0, 160));

// moodboard share → public canvas
const shr = j(await call('share_moodboard', { moodboardId: mb.id }));
check('share_moodboard returns token + canvas url', !!shr.token && /\/s\/canvas\//.test(shr.url ?? ''), JSON.stringify(shr).slice(0, 200));
const shr2 = j(await call('share_moodboard', { moodboardId: mb.id }));
check('share_moodboard idempotent', shr2.token === shr.token);
const pub = await api(`/api/public/canvas/${shr.token}`);
check('public canvas 200', pub.status === 200, `status=${pub.status} ${pub.text?.slice(0, 120)}`);
check('public canvas board meta', pub.data?.board?.id === mb.id);
const pubCard = pub.data?.items?.find((i) => i.type === 'card');
check('public card = {title,stage} only', pubCard?.card?.title === 'Card A' && !('ref' in pubCard ? false : false) && pubCard?.ref?.id === recId('Card A') && pubCard?.card?.stage === 'Backlog' && !('fields' in (pubCard ?? {})) && !('body' in (pubCard ?? {})) && !('description' in (pubCard ?? {})), JSON.stringify(pubCard));
const pubSvg = pub.data?.items?.find((i) => i.type === 'svg' && i.svg);
check('svg item carries inline sanitized svg', !!pubSvg && !pubSvg.svg.includes('script') && !pubSvg.svg.includes('foreignObject'), JSON.stringify(pubSvg).slice(0, 120));
const pubConn = pub.data?.items?.find((i) => i.type === 'connector' && i.linkKind);
check('public connector has linkKind, no linkId leak check', !!pubConn && pubConn.linkKind === 'blocks' && !('linkId' in pubConn), JSON.stringify(pubConn));

// REST share create/list parity + moodboard target
const restShare = await api('/api/shares', { method: 'POST', token: session, body: { moodboardId: mb.id } });
check('REST POST /api/shares moodboard', restShare.data?.target_type === 'moodboard' && restShare.data?.token === shr.token, JSON.stringify(restShare.data));
const list = await api('/api/shares', { token: session });
check('share list includes target_type', (list.data ?? []).some((s) => s.target_type === 'moodboard' && s.page_id === mb.id));
const both = await api('/api/shares', { method: 'POST', token: session, body: { pageId: 'x', moodboardId: mb.id } });
check('both pageId+moodboardId → 400', both.status === 400);
const badTarget = await api('/api/shares', { method: 'POST', token: session, body: { moodboardId: 'nonexistent' } });
check('unknown moodboard → 404', badTarget.status === 404);

// public canvas file rules: file not on board rejected, on-board file allowed
const fid = `f${crypto.randomBytes(8).toString('hex')}`;
const upChunk = await fetch(`${BASE}/api/files/${fid}/chunks/0`, { method: 'PUT', headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('89504e470d0a1a0a', 'hex') });
check('file chunk upload', upChunk.status === 200, `status=${upChunk.status}`);
const done = await api(`/api/files/${fid}/complete`, { method: 'POST', token: session, body: { mime: 'image/png', size: 8, chunks: 1 } });
check('file complete', done.status === 200, JSON.stringify(done.data));
// not referenced by the board → public fetch must 404
const nf = await api(`/api/public/canvas/${shr.token}/files/${fid}`);
check('non-board file rejected on canvas share', nf.status === 404, `status=${nf.status}`);
// attach it via an image item → now servable
const img = j(await call('add_mood_items', { moodboardId: mb.id, items: [{ type: 'image', fileId: fid }] }));
check('image item with fileId', img.added === 1, JSON.stringify(img).slice(0, 160));
const okf = await api(`/api/public/canvas/${shr.token}/files/${fid}`, { raw: true });
check('board file served on canvas share', okf.status === 200, `status=${okf.status}`);
// page-share token cannot read the canvas route
const pshr = j(await call('publish_page', { pageId: (j(await call('create_page', { title: 'P2 pub page' }))).id, enabled: true }));
const cross = await api(`/api/public/canvas/${pshr.token}`);
check('page token 404 on canvas route', cross.status === 404);
const cross2 = await api(`/api/public/${shr.token}`);
check('canvas token 404 on page route', cross2.status === 404);

// svg upload via files API → sanitized + CSP on serve
const svgBad = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
const fsid = `fs${crypto.randomBytes(8).toString('hex')}`;
const upBad = await fetch(`${BASE}/api/files/${fsid}/chunks/0`, { method: 'PUT', headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/octet-stream' }, body: svgBad });
await upBad.text();
const doneBad = await api(`/api/files/${fsid}/complete`, { method: 'POST', token: session, body: { mime: 'image/svg+xml', size: svgBad.length, chunks: 1 } });
check('svg upload completes (sanitized on write)', doneBad.status === 200, `status=${doneBad.status}`);
const servedBad = await fetch(`${BASE}/api/files/${fsid}`, { headers: { Authorization: `Bearer ${session}` } });
const badText = await servedBad.text();
check('script stripped from stored svg file', !badText.includes('script'), badText.slice(0, 120));
const svgOk = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';
const fsid2 = `fs${crypto.randomBytes(8).toString('hex')}`;
const upOk = await fetch(`${BASE}/api/files/${fsid2}/chunks/0`, { method: 'PUT', headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/octet-stream' }, body: svgOk });
await upOk.text();
const doneOk = await api(`/api/files/${fsid2}/complete`, { method: 'POST', token: session, body: { mime: 'image/svg+xml', size: svgOk.length, chunks: 1 } });
check('clean svg upload completes', doneOk.status === 200, JSON.stringify(doneOk.data).slice(0, 120));
const served = await fetch(`${BASE}/api/files/${fsid2}`, { headers: { Authorization: `Bearer ${session}` } });
const csp = served.headers.get('content-security-policy') ?? '';
await served.text();
check('svg serve has CSP+sandbox+nosniff', csp.includes("default-src 'none'") && csp.includes('sandbox') && served.headers.get('x-content-type-options') === 'nosniff', `csp=${csp}`);

// changeset undo on a new write tool
const undoTarget = j(await call('add_svg', { moodboardId: mb.id, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2"/></svg>' }));
check('write result carries changesetId', !!undoTarget.changesetId, JSON.stringify(undoTarget).slice(0, 160));
const und = j(await call('undo_change', { changesetId: undoTarget.changesetId }));
check('undo_change undoes add_svg', !und.error && und.restored >= 1, JSON.stringify(und).slice(0, 160));
const gm6 = j(await call('get_moodboard', { moodboardId: mb.id }));
check('undone svg gone from board', !gm6.items.some((i) => i.id === undoTarget.id));

console.log(`\n== ${PASS_COUNT} passed, ${FAIL_COUNT} failed ==`);
process.exit(FAIL_COUNT ? 1 : 0);
