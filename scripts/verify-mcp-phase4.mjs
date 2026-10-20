#!/usr/bin/env node
import {enableFixtureHuman} from './certification/human-review.mjs';
import {fixtureFetch} from './certification/oauth-consent.mjs';
// Phase 4 verification — MCP approvals, approval-gated writes, change-set
// audit/isolation, and the established automation run → undo path.
//
// Requires a local Phase 4 server (with migrations applied), for example:
//   npm run build
//   npx wrangler dev --local --port 8788
// The script bootstraps admin/bob when they are absent and writes uniquely
// named fixtures to that local D1. It refuses non-local base URLs.
//
// Usage: node scripts/verify-mcp-phase4.mjs [http://localhost:8788]

import { createCertificationReporter, localOrigin } from './certification-report.mjs';
import { assertionManifests } from './certification-manifests.mjs';
const certification = createCertificationReporter('verify-mcp-phase4', assertionManifests['verify-mcp-phase4']);
import crypto from 'node:crypto';

const requestedBase = process.argv.slice(2).find((arg) => /^https?:\/\//i.test(arg)) ?? process.env.PHASE4_BASE ?? 'http://localhost:8788';
let parsedBase;
try {
  parsedBase = new URL(requestedBase);
} catch {
  console.error(`FATAL: invalid base URL: ${requestedBase}`);
  process.exit(2);
}

const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
if (parsedBase.protocol !== 'http:' || !localHosts.has(parsedBase.hostname) || (parsedBase.pathname !== '/' && parsedBase.pathname !== '')) {
  console.error(`FATAL: refusing non-local base URL: ${requestedBase}`);
  process.exit(2);
}

const BASE = localOrigin(parsedBase.href);
const PASS = process.env.MCP_PASS ?? 'password123';
const RUN = `p4-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passCount = 0;
let failCount = 0;
const check = (name, condition, detail = '') => {
  certification.record('none', 'none', name, condition ? 'PASS' : 'FAIL', condition ? null : (detail || 'Assertion evaluated false'));
  if (condition) {
    passCount += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failCount += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const api = async (path, { method = 'GET', token, body, form, raw, cookie } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (body) headers['Content-Type'] = 'application/json';
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const response = await fixtureFetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined,
    redirect: 'manual',
  });
  if (raw) return response;
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _text: text };
  }
  return { status: response.status, data, text, headers: response.headers };
};

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const resultText = (result) => `${result?.text ?? ''} ${JSON.stringify(result?.data ?? '')}`;
const asData = (result) => (result?.data && typeof result.data === 'object' ? result.data : { error: result?.text ?? 'no result' });
const hasError = (result, pattern) => result?.isError === true || pattern.test(resultText(result));

async function grantFor(clientId, username) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(8));
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'http://localhost:8123/cb',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${BASE}/mcp`,
    scope: 'mcp',
  });
  const consent = await api(`/oauth/authorize?${query}`, { raw: true });
  const cookies = consent.headers.getSetCookie?.() ?? [];
  const cookie = cookies.map((value) => value.split(';')[0]).join('; ') || consent.headers.get('set-cookie')?.split(';')[0] || '';
  const html = await consent.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  if (!handle) throw new Error(`no consent handle for ${username} (status ${consent.status})`);

  const approved = await api(`/oauth/authorize?${query}`, {
    method: 'POST',
    cookie,
    form: { handle, username, password: PASS, decision: 'allow' },
  });
  const code = new URL(approved.headers.get('location') ?? '', BASE).searchParams.get('code');
  if (!code) throw new Error(`no authorization code for ${username} (status ${approved.status})`);

  const token = await api('/token', {
    method: 'POST',
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://localhost:8123/cb',
      client_id: clientId,
      code_verifier: verifier,
      resource: `${BASE}/mcp`,
    },
  });
  if (!token.data?.access_token) throw new Error(`no MCP access token for ${username}: ${token.text.slice(0, 180)}`);
  return token.data.access_token;
}

async function mcpClient(token, name) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  enableFixtureHuman(client,BASE,{username:name.includes('bob')?'bob':'admin'});
  const call = async (tool, args = {}) => {
    try {
      const response = await client.callTool({ name: tool, arguments: args });
      const text = response.content?.[0]?.text ?? '';
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
      return { data, isError: response.isError === true, text };
    } catch (error) {
      // Schema and authorization failures should be reported as failed checks,
      // not abort the rest of the verifier.
      return { data: null, isError: true, text: `THREW ${error?.code ?? ''} ${error?.message ?? error}` };
    }
  };
  return { client, call };
}

async function pullAll(token) {
  const records = [];
  let since = 0;
  for (let page = 0; page < 80; page += 1) {
    const response = await api(`/api/sync/pull?since=${since}`, { token });
    if (response.status !== 200) throw new Error(`sync pull failed (${response.status}): ${response.text.slice(0, 160)}`);
    records.push(...(response.data?.records ?? []));
    if (!response.data?.hasMore) return records;
    since = response.data.cursor;
  }
  throw new Error('sync pull exceeded pagination guard');
}

async function waitFor(fn, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(300);
  }
  return null;
}

async function main() {
  console.log(`== Phase 4 MCP verification against ${BASE} ==`);
  let adminClient;
  let bobClient;
  let adminCall;
  let bobCall;

  try {
    // ---------- auth/bootstrap ----------
    const status = await api('/api/auth/status');
    let admin = status.data?.needsBootstrap
      ? (await api('/api/auth/signup', { method: 'POST', body: { username: 'admin', name: 'Admin', password: PASS } })).data
      : (await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: PASS } })).data;
    check('admin session available', !!admin?.token, JSON.stringify(admin).slice(0, 180));
    if (!admin?.token || !admin.user?.id) throw new Error('admin session is required for Phase 4 verification');

    let bob = (await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: PASS } })).data;
    if (!bob?.token) {
      const invite = (await api('/api/invites', { method: 'POST', token: admin.token })).data;
      bob = (await api('/api/auth/signup', {
        method: 'POST',
        body: { username: 'bob', name: 'Bob', password: PASS, inviteCode: invite?.code },
      })).data;
    }
    check('approver (bob) session available', !!bob?.token && !!bob.user?.id, JSON.stringify(bob).slice(0, 180));
    if (!bob?.token || !bob.user?.id) throw new Error('bob session is required for identity/authorization checks');

    const dcr = await api('/register', {
      method: 'POST',
      body: {
        client_name: `${RUN}-mcp`,
        redirect_uris: ['http://localhost:8123/cb'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    });
    check('OAuth DCR client registered', !!dcr.data?.client_id, dcr.text.slice(0, 180));
    if (!dcr.data?.client_id) throw new Error('OAuth DCR is required for MCP verification');

    const adminMcpToken = await grantFor(dcr.data.client_id, 'admin');
    const bobMcpToken = await grantFor(dcr.data.client_id, 'bob');
    ({ client: adminClient, call: adminCall } = await mcpClient(adminMcpToken, `${RUN}-admin`));
    ({ client: bobClient, call: bobCall } = await mcpClient(bobMcpToken, `${RUN}-bob`));

    const listed = await adminClient.listTools();
    const toolNames = new Set((listed.tools ?? []).map((tool) => tool.name));
    for (const tool of ['request_approval', 'list_approvals', 'decide_approval']) {
      check(`approval tool discovered: ${tool}`, toolNames.has(tool), `tools=${[...toolNames].filter((n) => n.includes('approval')).join(',')}`);
    }

    // ---------- unique local gate fixture ----------
    const dbResult = asData(await adminCall('create_database', {
      name: `${RUN} approval gate DB`,
      kind: 'tasks',
      stages: ['Open', 'Review', 'Done'],
    }));
    const gateDbId = typeof dbResult.id === 'string' ? dbResult.id : '';
    check('gate fixture database created', !!gateDbId, JSON.stringify(dbResult).slice(0, 180));
    if (!gateDbId) throw new Error('cannot continue without gate fixture database');

    const boardResult = asData(await adminCall('get_board', { boardId: gateDbId }));
    const columns = Array.isArray(boardResult.columns) ? boardResult.columns : [];
    const openColumn = columns.find((column) => String(column.name).toLowerCase() === 'open') ?? columns[0];
    const doneColumn = columns.find((column) => String(column.name).toLowerCase() === 'done') ?? columns.at(-1);
    check('gate fixture has Open and Done stage ids', !!openColumn?.id && !!doneColumn?.id && openColumn.id !== doneColumn.id, JSON.stringify(columns));
    if (!openColumn?.id || !doneColumn?.id) throw new Error('cannot continue without gate stage ids');

    const gatePatch = await api('/api/sync/push', {
      method: 'POST',
      token: admin.token,
      body: {
        changes: [{
          id: gateDbId,
          collection: 'boards',
          patch: { approvalGate: { stageId: doneColumn.id } },
          ts: Date.now() + 1000,
        }],
      },
    });
    check('approval gate configured on fixture board', gatePatch.status === 200 && (gatePatch.data?.rejectedItems ?? []).length === 0, JSON.stringify(gatePatch.data));

    const sourceTitle = `${RUN} gated source`;
    const createdResult = asData(await adminCall('create_records', {
      databaseId: gateDbId,
      records: [{ title: sourceTitle, stage: 'Open' }],
      dedupe: 'none',
    }));
    const taskId = createdResult.created?.[0]?.id;
    check('gated task fixture created in Open', !!taskId, JSON.stringify(createdResult).slice(0, 180));
    if (!taskId) throw new Error('cannot continue without gated task fixture');

    // ---------- malformed/unauthorized inputs ----------
    const malformed = await adminCall('request_approval', {
      targetType: 'record',
      targetId: taskId,
      approverId: bob.user.id,
      requestId: 'bad key!',
    });
    check('malformed approval request is rejected', hasError(malformed, /requestId|invalid/i), resultText(malformed).slice(0, 220));

    const missingTarget = await adminCall('request_approval', {
      targetType: 'record',
      targetId: `${RUN}-missing-target`,
      approverId: bob.user.id,
    });
    check('approval request for missing target is rejected', hasError(missingTarget, /target not found|not found/i), resultText(missingTarget).slice(0, 220));

    const unauthSync = await api('/api/sync/push', { method: 'POST', body: { changes: [] } });
    check('unauthenticated direct sync is rejected', unauthSync.status === 401, `status=${unauthSync.status}`);

    // ---------- changeset audit + expectedRev ----------
    const beforeEdit = asData(await adminCall('get_record', { recordId: taskId }));
    const beforeRev = Number(beforeEdit.record?.rev ?? 0);
    const editTitle = `${RUN} title edited`;
    const edit = await adminCall('update_records', {
      updates: [{ recordId: taskId, expectedRev: beforeRev, title: editTitle }],
    });
    const editData = asData(edit);
    check('MCP expectedRev write succeeds at current revision', !editData.error && !!editData.changesetId, resultText(edit).slice(0, 220));

    const staleEdit = await adminCall('update_records', {
      updates: [{ recordId: taskId, expectedRev: beforeRev, title: `${RUN} stale edit` }],
    });
    const staleEditData = asData(staleEdit);
    check('MCP stale expectedRev returns conflict', staleEditData.error === 'conflict' && staleEditData.conflicts?.[0]?.type === 'stale_rev', resultText(staleEdit).slice(0, 240));

    const change = await adminCall('get_change', { changesetId: editData.changesetId });
    const changeData = asData(change);
    check('successful MCP write has inspectable change-set audit', !changeData.error && changeData.changeset?.tool === 'update_records' && (changeData.items ?? []).some((item) => item.record_id === taskId), resultText(change).slice(0, 240));

    const bobChange = await bobCall('get_change', { changesetId: editData.changesetId });
    check('change-set audit is not readable by another member', hasError(bobChange, /forbidden/i), resultText(bobChange).slice(0, 220));

    // ---------- approval request/list/decide identity + replay ----------
    const requestId = `${RUN}-request`;
    const approvalArgs = {
      targetType: 'record',
      targetId: taskId,
      approverId: bob.user.id,
      stageId: doneColumn.id,
      note: `${RUN} gate approval`,
      requestId,
    };
    const requested = await adminCall('request_approval', approvalArgs);
    const requestedData = asData(requested);
    const approvalId = requestedData.approval?.id;
    check('request_approval creates pending row with requester/approver identity', !requestedData.error && requestedData.approval?.status === 'pending' && requestedData.approval?.requestedBy === admin.user.id && requestedData.approval?.approverId === bob.user.id, resultText(requested).slice(0, 260));
    if (!approvalId) throw new Error('cannot continue without approval id');

    const replayedRequest = await adminCall('request_approval', approvalArgs);
    const replayedRequestData = asData(replayedRequest);
    check('request_approval requestId replay does not duplicate', replayedRequestData.approval?.id === approvalId || replayedRequestData.replayed===true&&replayedRequestData.resultRedacted===true, resultText(replayedRequest).slice(0, 220));

    const adminRequested = asData(await adminCall('list_approvals', { mine: 'requested', targetId: taskId }));
    const bobPending = asData(await bobCall('list_approvals', { mine: 'approver', targetId: taskId }));
    check('requester list is scoped to admin identity', (adminRequested.approvals ?? []).filter((row) => row.id === approvalId && row.requestedBy === admin.user.id).length === 1, JSON.stringify(adminRequested).slice(0, 260));
    check('approver list is scoped to bob identity', (bobPending.approvals ?? []).filter((row) => row.id === approvalId && row.approverId === bob.user.id && row.status === 'pending').length === 1, JSON.stringify(bobPending).slice(0, 260));
    const adminAsApprover = asData(await adminCall('list_approvals', { mine: 'approver', targetId: taskId }));
    check('requester cannot see approval in approver-only list', !(adminAsApprover.approvals ?? []).some((row) => row.id === approvalId), JSON.stringify(adminAsApprover).slice(0, 220));

    const wrongDecider = await adminCall('decide_approval', { approvalId, decision: 'approved' });
    check('requester cannot decide someone else approval', hasError(wrongDecider, /not your approval|approver/i), resultText(wrongDecider).slice(0, 220));

    // The approval is still pending: both the generic client push and the MCP
    // write path must be refused by the server-side gate.
    const directBypass = await api('/api/sync/push', {
      method: 'POST',
      token: admin.token,
      body: {
        changes: [{ id: taskId, collection: 'tasks', patch: { status: doneColumn.id }, ts: Date.now() + 2000 }],
      },
    });
    check('direct client push is blocked before approval', directBypass.status === 200 && directBypass.data?.rejectedItems?.some((item) => item.reason === 'approval_required'), JSON.stringify(directBypass.data).slice(0, 260));
    const afterDirectBypass = asData(await adminCall('get_record', { recordId: taskId }));
    check('blocked direct push leaves task in Open', afterDirectBypass.record?.stage === openColumn.id, JSON.stringify(afterDirectBypass.record).slice(0, 180));

    const mcpBypass = await adminCall('update_records', { updates: [{ recordId: taskId, stage: 'Done' }] });
    check('MCP gated stage write reports approval_required', hasError(mcpBypass, /approval_required|approval required/i), resultText(mcpBypass).slice(0, 260));
    const afterMcpBypass = asData(await adminCall('get_record', { recordId: taskId }));
    check('blocked MCP write leaves task in Open', afterMcpBypass.record?.stage === openColumn.id, JSON.stringify(afterMcpBypass.record).slice(0, 180));

    const pendingRow = (bobPending.approvals ?? []).find((row) => row.id === approvalId);
    const expectedRev = Number(pendingRow?.rev ?? 0);
    check('list_approvals exposes decision revision', expectedRev > 0, JSON.stringify(pendingRow));
    const staleDecision = await bobCall('decide_approval', { approvalId, decision: 'approved', expectedRev: expectedRev + 1 });
    const staleDecisionData = asData(staleDecision);
    check('decide_approval rejects stale expectedRev', staleDecisionData.error === 'conflict' && staleDecisionData.conflicts?.[0]?.type === 'stale_rev', resultText(staleDecision).slice(0, 260));

    const decision = await bobCall('decide_approval', { approvalId, decision: 'approved', expectedRev });
    const decisionData = asData(decision);
    check('named approver can approve with current revision', !decisionData.error && decisionData.approval?.status === 'approved' && decisionData.approval?.approverId === bob.user.id, resultText(decision).slice(0, 260));

    const decisionReplay = await bobCall('decide_approval', { approvalId, decision: 'approved', expectedRev });
    const decisionReplayData = asData(decisionReplay);
    check('identical approval decision replays safely', !decisionReplayData.error && decisionReplayData.approval?.status === 'approved' && decisionReplayData.replayed === true, resultText(decisionReplay).slice(0, 260));

    // ---------- approved gate transition ----------
    const authorizedPush = await api('/api/sync/push', {
      method: 'POST',
      token: admin.token,
      body: {
        changes: [{ id: taskId, collection: 'tasks', patch: { status: doneColumn.id }, ts: Date.now() + 3000 }],
      },
    });
    check('approved decision allows gated client push', authorizedPush.status === 200 && (authorizedPush.data?.rejectedItems ?? []).length === 0, JSON.stringify(authorizedPush.data).slice(0, 240));
    const afterAuthorized = asData(await adminCall('get_record', { recordId: taskId }));
    check('approved gated transition lands at Done', afterAuthorized.record?.stage === doneColumn.id, JSON.stringify(afterAuthorized.record).slice(0, 180));

    // ---------- established automation run-history → undo path ----------
    const automationId = `${RUN}-automation`;
    const automationTitle = `${RUN} automation child for {{record.title}}`;
    const automationConfig = {
      databaseId: gateDbId,
      name: `${RUN} automation`,
      enabled: true,
      trigger: { kind: 'record.created', databaseId: gateDbId },
      conditions: [],
      actions: [{ type: 'create_record', databaseId: gateDbId, title: automationTitle }],
    };
    const automationPush = await api('/api/sync/push', {
      method: 'POST',
      token: admin.token,
      body: { changes: [{ id: automationId, collection: 'automations', patch: automationConfig, ts: Date.now() + 4000 }] },
    });
    check('automation fixture config accepted', automationPush.status === 200 && (automationPush.data?.rejectedItems ?? []).length === 0, JSON.stringify(automationPush.data).slice(0, 240));

    const automationValidation = await api(`/api/automations/${automationId}/validate`, { token: admin.token });
    check('automation fixture validates with no errors', automationValidation.status === 200 && Array.isArray(automationValidation.data?.errors) && automationValidation.data.errors.length === 0, JSON.stringify(automationValidation.data).slice(0, 260));

    const automationSourceTitle = `${RUN} automation source`;
    const automationSource = asData(await adminCall('create_records', {
      databaseId: gateDbId,
      records: [{ title: automationSourceTitle, stage: 'Open' }],
      dedupe: 'none',
    }));
    const automationSourceId = automationSource.created?.[0]?.id;
    check('automation source record created', !!automationSourceId, JSON.stringify(automationSource).slice(0, 180));

    const run = await waitFor(async () => {
      const response = await api(`/api/automations/${automationId}/runs`, { token: admin.token });
      const current=response.status === 200 ? response.data?.runs?.[0] : null;
      if(current?.status==='completed')return current;
      // Write-path processing is optional acceleration. Exercise real durable
      // recovery in a fresh scheduled invocation when its request budget stops.
      const scheduled=await fetch(BASE+'/cdn-cgi/handler/scheduled?'+new URLSearchParams({cron:'*/15 * * * *',time:String(2*900000)}),{method:'POST'});
      if(scheduled.status!==200)throw new Error('Scheduled recovery endpoint unavailable');
      await scheduled.text();return null;
    });
    check('automation run history records source event', !!run && run.automation_id === automationId && run.status === 'completed', JSON.stringify(run).slice(0, 280));

    const allAfterAutomation = await pullAll(admin.token);
    const child = allAfterAutomation.find((row) => row.collection === 'tasks' && row.data?.title === automationTitle.replace('{{record.title}}', automationSourceTitle) && row.data?.deleted !== true);
    check('automation create_record action lands a unique child', !!child, String(JSON.stringify(child?.data)).slice(0, 220));

    if (run?.changeset_id) {
      const automationChange = await adminCall('get_change', { changesetId: run.changeset_id });
      const automationChangeData = asData(automationChange);
      check('automation run exposes an auditable automation change set', !automationChangeData.error && automationChangeData.changeset?.source === 'automation' && (automationChangeData.items ?? []).some((item) => item.record_id === child?.id), resultText(automationChange).slice(0, 280));

      const undone = await adminCall('undo_change', { changesetId: run.changeset_id });
      const undoneData = asData(undone);
      check('automation change set can be undone through MCP', !undoneData.error && Number(undoneData.restored ?? 0) >= 1, resultText(undone).slice(0, 260));
      const afterUndo = await pullAll(admin.token);
      const childAfterUndo = afterUndo.find((row) => row.id === child?.id);
      check('automation undo removes its created child', !childAfterUndo || childAfterUndo.data?.deleted === true, JSON.stringify(childAfterUndo?.data).slice(0, 180));
    } else {
      check('automation run exposes an auditable automation change set', false, 'run has no changeset_id');
      check('automation change set can be undone through MCP', false, 'run has no changeset_id');
      check('automation undo removes its created child', false, 'run has no changeset_id');
    }

    const peopleDb=asData(await adminCall('create_database',{name:RUN+' People',kind:'records',fields:[]}));
    const personId=asData(await adminCall('create_records',{databaseId:peopleDb.id,records:[{title:RUN+' Person'}],dedupe:'none'})).created?.[0]?.id;
    const peopleRead=asData(await adminCall('get_board',{boardId:peopleDb.id}));
    const peopleRev=(await pullAll(admin.token)).find(r=>r.id===peopleDb.id)?.seq;
    const archivedDb=asData(await adminCall('delete_item',{type:'board',id:peopleDb.id,expectedRev:peopleRev}));
    const archivedRow=(await pullAll(admin.token)).find(r=>r.id===peopleDb.id);
    const restoredDb=asData(await adminCall('restore_item',{type:'board',id:peopleDb.id,expectedRev:archivedRow?.seq}));
    const preservedPerson=asData(await adminCall('get_record',{recordId:personId}));
    check('INT-02 real MCP generic database archives and restores without moving records',!peopleRead.error&&!archivedDb.error&&archivedDb.archived===true&&!restoredDb.error&&preservedPerson.record?.databaseId===peopleDb.id,JSON.stringify(archivedDb));

    // Integrity regressions use the real built Worker, OAuth and MCP transport.
    const integrityPage=asData(await adminCall('create_page',{title:RUN+' integrity undo'}));
    const appended=asData(await adminCall('edit_page',{pageId:integrityPage.id,appendMarkdown:Array.from({length:101},(_,i)=>`Undo ${i}`).join('\n\n'),requestId:RUN+'-undo101'}));
    const largeUndo=asData(await adminCall('undo_change',{changesetId:appended.changesetId}));
    const emptyAfter=asData(await adminCall('get_page',{pageId:integrityPage.id}));
    check('INT-03 real MCP undo restores 101 journalled blocks',!largeUndo.error&&largeUndo.restored===101&&emptyAfter.markdown==='');
    const splitPage=asData(await adminCall('create_page',{title:RUN+' split',markdown:'Original'}));
    const splitRead=asData(await adminCall('get_page',{pageId:splitPage.id}));
    const splitArgs={pageId:splitPage.id,replaceBlocks:[{blockId:splitRead.blocks[0].id,expectedRev:splitRead.blocks[0].rev,markdown:Array.from({length:501},(_,i)=>`Split ${i}`).join('\n\n')}],requestId:RUN+'-split501'};
    const split=asData(await adminCall('edit_page',splitArgs)),splitReplay=asData(await adminCall('edit_page',splitArgs));
    const splitJournal=asData(await adminCall('get_change',{changesetId:split.changesetId}));
    check('INT-04 real MCP guarded 501-block edit and replay keep one journal',!split.error&&split.updated===501&&splitReplay.replayed===true&&splitJournal.changeset?.item_count===501,JSON.stringify(split));
    const mentionTitle=RUN+' Funding Opportunity';
    const mentionRec=asData(await adminCall('create_records',{databaseId:gateDbId,records:[{title:mentionTitle,stage:'Open'}],dedupe:'none'})).created?.[0]?.id;
    const mentionPage=asData(await adminCall('create_page',{title:RUN+' mentions',markdown:`[[${mentionTitle}]]`}));
    const mentionBlocks=(await pullAll(admin.token)).filter(r=>r.collection==='blocks'&&r.data.pageId===mentionPage.id);
    const mentioned=asData(await adminCall('get_page',{pageId:mentionPage.id}));
    check('INT-05 real MCP record mention stores token and renders current title',!!mentionRec&&mentionBlocks.some(b=>b.data.text===`@[rec:${mentionRec}]`)&&mentioned.markdown===`[[${mentionTitle}]]`);
    const docs='https://docs.google.com/document/d/integrity/edit',folder='https://drive.google.com/drive/folders/integrity',drive='https://drive.google.com/file/d/integrity/view';
    const embedPage=asData(await adminCall('create_page',{title:RUN+' embeds',markdown:docs}));
    await adminCall('edit_page',{pageId:embedPage.id,appendMarkdown:folder});
    const embedRead=asData(await adminCall('get_page',{pageId:embedPage.id}));
    await adminCall('edit_page',{pageId:embedPage.id,replaceBlocks:[{blockId:embedRead.blocks[0].id,expectedRev:embedRead.blocks[0].rev,markdown:drive}]});
    await adminCall('edit_record_body',{recordId:mentionRec,appendMarkdown:docs});
    const embedAfter=asData(await adminCall('get_page',{pageId:embedPage.id})),bodyAfter=asData(await adminCall('get_record',{recordId:mentionRec}));
    check('INT-06 real MCP embeds survive create append replace and record body',embedAfter.markdown===drive+'\n\n'+folder&&bodyAfter.record?.body===docs,JSON.stringify(embedAfter));

    console.log(`\n== ${passCount} passed, ${failCount} failed ==`);
    return failCount ? 1 : 0;
  } finally {
    if (adminClient) await adminClient.close().catch(() => {});
    if (bobClient) await bobClient.close().catch(() => {});
  }
}

main()
  .then((code) => { certification.finish(); process.exit(code || process.exitCode || 0); })
  .catch((error) => {
    certification.record('system', 'none', 'runner exception', 'FAIL', error);
    console.error(`FATAL: ${error?.stack ?? error}`);
    process.exit(2);
  });
