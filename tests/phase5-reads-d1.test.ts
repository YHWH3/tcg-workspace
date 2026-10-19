// Phase 5 authorized reads on actual D1: every remaining user-visible read surface (MCP reads,
// search, fetch, overview, bodies/mentions/backlinks/relations, closures/templates, history,
// notifications, approvals, shares, public pages/canvas/files, member form routes) refuses
// cross-space content while permissions are enabled, keeps Phase 0–4 behavior while they are
// disabled, and treats unauthorized like nonexistent. Fixtures are disposable; permissions are
// enabled only inside them.
import {fixtureHumanStep} from './humanMcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { openAuditFixture, ctx as executionCtx, type AuditFixture } from './audit-fixture';

const tools = vi.hoisted(() => new Map<string, (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>>());
vi.mock('@modelcontextprotocol/server', () => ({ McpServer: class { registerTool(name: string, _meta: unknown, fn: never) { tools.set(name, fn); } registerPrompt() {} } }));
vi.mock('agents/mcp/server', () => ({ createMcpHandler: vi.fn() }));
vi.mock('../worker/events', async (original) => ({ ...(await original<typeof import('../worker/events')>()), scheduleOutbox: vi.fn() }));
import { createWorkspaceServer } from '../worker/mcp';
import { notificationsApi } from '../worker/notifications';
import { approvalsApi } from '../worker/approvals';
import { changesApi } from '../worker/changesets';
import { shares } from '../worker/shares';
import { publicApi } from '../worker/public';
import { formsApi } from '../worker/forms';
import { automationsApi } from '../worker/automations';
import { loadTemplateSnapshot } from '../worker/templateSnapshot';
import { pageClosure } from '../worker/closure';
import { getRec, listBy } from '../worker/records';
import { createReadGate, readersOf, withReadGate } from '../worker/readAccess';
import { withD1Budget, d1BudgetRemaining } from '../worker/d1budget';
import { mkdirSync, writeFileSync } from 'node:fs';

let fx: AuditFixture, seq = 0;
const enable = (on = true) => fx.db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(on ? 1 : 0).run();
const put = (id: string, collection: string, data: Record<string, unknown>, space = 'space-core', peer: string | null = null) =>
  fx.db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id,peer_space_id) VALUES(?,?,?,?,?,?,?)')
    .bind(id, collection, JSON.stringify(data), JSON.stringify(Object.fromEntries(Object.keys(data).map((k) => [k, 1]))), ++seq, space, peer).run();
const member = (space: string, user: string, role: string, access = 'allow') =>
  fx.db.prepare('INSERT INTO space_members(space_id,user_id,role,access) VALUES(?,?,?,?) ON CONFLICT(space_id,user_id) DO UPDATE SET role=excluded.role,access=excluded.access').bind(space, user, role, access).run();
const revoke = (space: string, user: string) => fx.db.prepare('DELETE FROM space_members WHERE space_id=? AND user_id=?').bind(space, user).run();

function context(userId: string, userRole: 'admin' | 'member' = 'member') {
  return { env: fx.env, ectx: executionCtx, userId, userRole, origin: 'http://localhost', userByKey: new Map(), userNameById: new Map(), pageTitleById: new Map(),
    recordTitleById: new Map(), recordIdByTitle: new Map(), pageIdByTitle: new Map(), cachesReady: false, warnings: [], cs: null, toolName: '' } as never;
}
async function call(userId: string, name: string, args: Record<string, unknown>, role: 'admin' | 'member' = 'member') {
  createWorkspaceServer(context(userId, role));
  const res = await fixtureHumanStep(fx.env,userId,name,args,await tools.get(name)!(args));
  return { text: res.content[0].text, isError: res.isError === true, json: JSON.parse(res.content[0].text) as Record<string, any> };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rest = async (router: Hono<any>, user: string | null, path: string, init: RequestInit = {}) => {
  const res = await router.request(`http://localhost${path}`, { ...init, headers: { ...(user ? fx.auth(user) : {}), 'content-type': 'application/json' } }, fx.env, executionCtx);
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const SECRET = /Vault|mango|confidential|vault comment/;

beforeEach(async () => {
  seq = 0;
  fx = await openAuditFixture([{ id: 'alice', role: 'admin' }, { id: 'bob' }, { id: 'carol', role: 'admin' }, { id: 'gina' }, { id: 'dave' }]);
  for (const [id, role] of [['alice', 'owner'], ['bob', 'member'], ['carol', 'admin'], ['gina', 'guest'], ['dave', 'member']]) {
    await fx.db.prepare('UPDATE users SET workspace_role=? WHERE id=?').bind(role, id).run();
  }
  await fx.db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('vault','Vault','private',1),('team','Team','members',1),('guestspace','Guests','private',1)").run();
  await member('vault', 'alice', 'admin'); await member('guestspace', 'gina', 'viewer'); await member('team', 'dave', 'editor', 'deny');
  await put('pub', 'pages', { title: 'Public plan' });
  await put('pb1', 'blocks', { pageId: 'pub', type: 'p', text: 'See @[page:secret] for details', order: 'a0' });
  await put('pb2', 'blocks', { pageId: 'pub', type: 'tasks', boardId: 'vb', order: 'a1' });
  await put('secret', 'pages', { title: 'Vault Secret' }, 'vault');
  await put('sb1', 'blocks', { pageId: 'secret', type: 'p', text: 'mango launch @[page:pub]', order: 'a0' }, 'vault');
  await put('vb', 'boards', { name: 'Vault Board', columns: [{ id: 'todo', name: 'Todo' }], fields: [] }, 'vault');
  await put('vt', 'tasks', { title: 'Vault Task', boardId: 'vb', status: 'todo' }, 'vault');
  await put('vc', 'comments', { targetType: 'task', targetId: 'vt', body: 'vault comment text', authorId: 'alice' }, 'vault');
  await put('cb', 'boards', { name: 'Core Board', columns: [{ id: 'todo', name: 'Todo' }], fields: [{ id: 'rel', name: 'Rel', type: 'relation', relation: { target: 'vb' } }] });
  await put('ct', 'tasks', { title: 'Core Task', boardId: 'cb', status: 'todo' });
  await put('lk', 'links', { kind: 'relation', fieldId: 'rel', fromType: 'record', fromId: 'ct', toType: 'record', toId: 'vt' }, 'space-core', 'vault');
  await put('tp', 'pages', { title: 'Team Notes' }, 'team');
  await put('gp', 'pages', { title: 'Guest Page' }, 'guestspace');
  await put('mb', 'moodboards', { title: 'Core Board Canvas' });
  await put('mi', 'mooditems', { boardId: 'mb', type: 'card', ref: { type: 'record', id: 'vt' }, x: 0, y: 0 });
  await put('vf', 'forms', { databaseId: 'vb', title: 'Vault intake', fields: [{ fieldKey: 'title', label: 'Title' }], enabled: true, successMessage: 'ok', notifyUserIds: [] }, 'vault');
  await fx.db.prepare("INSERT INTO form_tokens(token,form_id,created_at) VALUES('ftok','vf',1)").run();
  await fx.db.prepare("INSERT INTO shares(token,target_type,page_id,created_by,created_at,space_id) VALUES('tok-pub','page','pub','alice',1,'space-core'),('tok-mb','moodboard','mb','alice',1,'space-core'),('tok-secret','page','secret','alice',1,'vault')").run();
  await fx.db.prepare("INSERT INTO notifications(id,user_id,kind,target_type,target_id,title,body,url,created_at) VALUES('n1','bob','mention','page','secret','Mentioned in Vault Secret','mango launch','/pages/secret',2),('n2','bob','mention','page','pub','Mentioned in Public plan','hi','/pages/pub',1)").run();
  await fx.db.prepare("INSERT INTO approvals(id,target_type,target_id,requested_by,approver_id,status,note,created_at) VALUES('a1','record','vt','alice','bob','pending','confidential note',1)").run();
  await fx.db.prepare("INSERT INTO changesets(id,user_id,source,tool,summary,item_count,created_at) VALUES('cs1','alice','mcp','edit_page','Edited \"Vault Secret\"',1,1),('cs2','alice','mcp','edit_page','Edited core',1,2)").run();
  await fx.db.prepare(`INSERT INTO changeset_items(changeset_id,idx,collection,record_id,before,after,field_ts) VALUES('cs1',0,'pages','secret','{"title":"Vault draft"}','{"title":"Vault Secret"}','{}'),('cs2',0,'pages','pub','{"title":"Old"}','{"title":"Public plan"}','{}')`).run();
});
afterEach(async () => { await fx.dispose(); });

describe('permissions disabled: Phase 0–4 behavior is unchanged', () => {
  it('a member still reads every space through MCP, notifications, approvals and history', async () => {
    expect((await call('bob', 'search', { query: 'vault' })).text).toContain('Vault Secret');
    expect((await call('bob', 'fetch', { id: 'page:secret' })).json.title).toBe('Vault Secret');
    expect((await rest(notificationsApi, 'bob', '/')).text).toContain('Vault Secret');
    expect((await rest(approvalsApi, 'bob', '/')).text).toContain('confidential note');
    expect((await rest(changesApi, 'carol', '/cs1')).text).toContain('Vault draft');
    expect((await rest(shares, 'bob', '/')).json.map((s: { token: string }) => s.token).sort()).toEqual(['tok-mb', 'tok-pub', 'tok-secret']);
    const gate = createReadGate(fx.db, 'bob');
    expect(await gate.enabled()).toBe(false); expect(await gate.canRead('secret')).toBe(true);
  });
});

describe('public share capability (every mode)', () => {
  it('never labels a mention of a page outside the shared tree with that page\'s title', async () => {
    for (const on of [false, true]) {
      await enable(on);
      const page = await rest(publicApi, null, '/tok-pub/pages/pub');
      expect(page.status).toBe(200);
      const mention = page.json.blocks[0].mentions[0];
      expect(mention).toMatchObject({ kind: 'page', id: 'secret', inTree: false, label: 'Restricted item' });
      expect(page.text).not.toContain('Vault Secret');
      // Legacy deliberately keeps an embedded database the author placed on the page; enabled omits it (below).
      if (on) expect(page.text).not.toMatch(SECRET);
    }
  });
});

describe('permissions enabled: MCP reads', () => {
  beforeEach(async () => { await enable(); });

  it('search and fetch show nothing of a private space; unauthorized equals nonexistent', async () => {
    const search = await call('bob', 'search', { query: 'vault' });
    expect(search.text).not.toMatch(SECRET);
    expect((await call('bob', 'search', { query: 'mango' })).json.results).toEqual([]);
    expect((await call('alice', 'search', { query: 'mango' })).json.results.map((r: { id: string }) => r.id)).toEqual(['page:secret']);
    const denied = await call('bob', 'fetch', { id: 'page:secret' }), missing = await call('bob', 'fetch', { id: 'page:never-existed' });
    expect(denied.text).toBe(missing.text);
    expect((await call('bob', 'fetch', { id: 'task:vt' })).text).toBe((await call('bob', 'fetch', { id: 'task:nope' })).text);
  });

  it('a guest sees only its own space; an explicit deny overrides default member access', async () => {
    expect((await call('gina', 'search', { query: 'page' })).json.results.map((r: { id: string }) => r.id)).toEqual(['page:gp']);
    expect((await call('gina', 'search', { query: 'plan' })).json.results).toEqual([]);
    expect((await call('dave', 'search', { query: 'team' })).json.results).toEqual([]);
    expect((await call('bob', 'search', { query: 'team' })).json.results.map((r: { id: string }) => r.id)).toEqual(['page:tp']);
  });

  it('workspace overview, bodies, mentions, backlinks and relations carry no private titles', async () => {
    const overview = await call('bob', 'workspace_overview', {});
    expect(overview.isError).toBe(false); expect(overview.text).not.toMatch(SECRET);
    const page = await call('bob', 'get_page', { pageId: 'pub' });
    expect(page.isError).toBe(false);
    expect(page.text).not.toMatch(SECRET);                     // mention of `secret` and the vault backlink
    expect(page.json.backlinks).toEqual([]);
    expect((await call('alice', 'get_page', { pageId: 'pub' })).json.backlinks.map((b: { pageId: string }) => b.pageId)).toEqual(['secret']);
    const task = await call('bob', 'get_record', { recordId: 'ct' });
    expect(task.text).not.toMatch(SECRET);                     // the relation to a vault record is invisible
    expect((await call('bob', 'list_comments', { targetType: 'task', targetId: 'vt' })).json.comments).toEqual([]);
    expect((await call('alice', 'list_comments', { targetType: 'task', targetId: 'vt' })).json.comments).toHaveLength(1);
  });

  it('a workspace admin without membership does not read a private space, including its history', async () => {
    expect((await call('carol', 'fetch', { id: 'page:secret' }, 'admin')).isError).toBe(true);
    const change = await call('carol', 'get_change', { changesetId: 'cs1' }, 'admin');
    expect(change.text).not.toMatch(SECRET); expect(change.json.items).toEqual([]); expect(change.json.restricted).toBe(1);
    expect((await call('alice', 'get_change', { changesetId: 'cs1' }, 'admin')).text).toContain('Vault draft');
  });

  it('delete previews count only the mentions the caller can read', async () => {
    const bob = await call('bob', 'delete_item', { type: 'page', id: 'pub', dryRun: true, expectedRev: 1 });
    const alice = await call('alice', 'delete_item', { type: 'page', id: 'pub', dryRun: true, expectedRev: 1 });
    expect(JSON.stringify(bob.json.counts)).not.toEqual(JSON.stringify(alice.json.counts));
    expect(bob.text).not.toMatch(SECRET);
  });

  it('closures and template snapshots for a user leave other spaces out; service reads keep everything', async () => {
    const bobEnv = withReadGate(fx.env, 'bob');
    const snap = await loadTemplateSnapshot(bobEnv, 'pub');
    expect(Object.keys(snap.boards ?? {})).toEqual([]); expect(Object.keys(snap.tasks ?? {})).toEqual([]);
    expect(Object.keys((await loadTemplateSnapshot(fx.env, 'pub')).boards ?? {})).toEqual(['vb']);
    expect((await pageClosure(withReadGate(fx.env, 'bob'), 'secret')).pages).toEqual([]);
    expect((await listBy(withReadGate(fx.env, 'bob'), 'tasks', 'boardId', 'vb'))).toEqual([]);
    expect((await listBy(fx.env, 'tasks', 'boardId', 'vb')).map((r) => r.id)).toEqual(['vt']);
  });

  it('a replayed idempotent result is re-filtered after the caller loses access', async () => {
    const first = await call('alice', 'add_comment', { targetType: 'task', targetId: 'vt', text: 'vault reply', requestId: 'req-1' });
    expect(first.isError, first.text).toBe(false);
    await revoke('vault', 'alice');
    const replay = await call('alice', 'add_comment', { targetType: 'task', targetId: 'vt', text: 'vault reply', requestId: 'req-1' });
    expect(replay.json).toMatchObject({ replayed: true, restricted: true });
    expect(replay.text).not.toContain(first.json.id);
  });
});

describe('permissions enabled: authenticated operational endpoints', () => {
  beforeEach(async () => { await enable(); });

  it('notifications keep order but show a neutral row for an unreadable target, also after revocation', async () => {
    const bob = await rest(notificationsApi, 'bob', '/');
    expect(bob.status).toBe(200); expect(bob.text).not.toMatch(SECRET);
    expect(bob.json.notifications.map((n: { id: string; title: string }) => [n.id, n.title])).toEqual([['n1', 'Restricted item'], ['n2', 'Mentioned in Public plan']]);
    await fx.db.prepare("INSERT INTO notifications(id,user_id,kind,target_type,target_id,title,body,created_at) VALUES('n3','alice','mention','page','secret','Vault Secret mention','mango',3)").run();
    expect((await rest(notificationsApi, 'alice', '/')).text).toContain('Vault Secret mention');
    await revoke('vault', 'alice');
    expect((await rest(notificationsApi, 'alice', '/')).text).not.toMatch(SECRET);
  });

  it('approvals hide the target title and notes from a participant who cannot read the target', async () => {
    const list = await rest(approvalsApi, 'bob', '/');
    expect(list.text).not.toMatch(SECRET); expect(list.json.approvals[0]).toMatchObject({ id: 'a1', targetTitle: 'Restricted item', note: null, restricted: true });
    expect((await rest(approvalsApi, 'alice', '/')).text).toContain('confidential note');
    const ask = await rest(approvalsApi, 'bob', '/', { method: 'POST', body: JSON.stringify({ targetType: 'record', targetId: 'vt', approverId: 'alice' }) });
    const ghost = await rest(approvalsApi, 'bob', '/', { method: 'POST', body: JSON.stringify({ targetType: 'record', targetId: 'ghost', approverId: 'alice' }) });
    expect(ask.status).toBe(ghost.status); expect(ask.json).toEqual(ghost.json);
  });

  it('change history withholds items and summaries for unreadable records', async () => {
    const list = await rest(changesApi, 'carol', '/');
    expect(list.text).not.toMatch(SECRET);
    expect(list.json.changesets.find((c: { id: string }) => c.id === 'cs1')).toMatchObject({ summary: 'Restricted change', restricted: true });
    const one = await rest(changesApi, 'carol', '/cs1');
    expect(one.text).not.toMatch(SECRET); expect(one.json.items).toEqual([]);
    expect((await rest(changesApi, 'carol', '/cs2')).json.items).toHaveLength(1);
  });

  it('share tokens are listed, minted and revoked only by an admin of the root\'s space', async () => {
    expect((await rest(shares, 'bob', '/')).json.map((s: { token: string }) => s.token)).not.toContain('tok-secret');
    const denied = await rest(shares, 'bob', '/', { method: 'POST', body: JSON.stringify({ pageId: 'secret' }) });
    const missing = await rest(shares, 'bob', '/', { method: 'POST', body: JSON.stringify({ pageId: 'ghost' }) });
    expect(denied.status).toBe(404); expect(denied.json).toEqual(missing.json);
    expect((await rest(shares, 'alice', '/', { method: 'POST', body: JSON.stringify({ pageId: 'secret' }) })).json.token).toBe('tok-secret');
    await rest(shares, 'bob', '/secret', { method: 'DELETE' });
    expect(await fx.db.prepare("SELECT token FROM shares WHERE page_id='secret'").first('token')).toBe('tok-secret');
    const published = await call('bob', 'publish_page', { pageId: 'secret', enabled: true });
    expect(published.isError).toBe(true); expect(published.text).not.toContain('tok-secret');
  });

  it('member form routes treat an unreadable form like a missing one and keep tokens to editors', async () => {
    const denied = await rest(formsApi, 'bob', '/vf'), missing = await rest(formsApi, 'bob', '/ghost-form');
    expect(denied.status).toBe(404); expect(denied.json).toEqual(missing.json);
    expect((await rest(formsApi, 'alice', '/vf')).json.tokens.map((t: { token: string }) => t.token)).toEqual(['ftok']);
    await member('vault', 'bob', 'viewer');
    const viewer = await rest(formsApi, 'bob', '/vf');
    expect(viewer.status).toBe(200); expect(viewer.json.tokens).toEqual([]);
    expect((await rest(formsApi, 'bob', '/tokens/ftok', { method: 'DELETE' })).status).toBe(404);
    expect(await fx.db.prepare("SELECT revoked_at FROM form_tokens WHERE token='ftok'").first('revoked_at')).toBeNull();
    expect((await rest(automationsApi, 'bob', '/vf/runs')).json).toEqual({ runs: [] });
  });
});

describe('permissions enabled: public capability', () => {
  beforeEach(async () => { await enable(); });

  it('a page share omits an embedded database of another space; a canvas card shows no foreign title', async () => {
    const page = await rest(publicApi, null, '/tok-pub/pages/pub');
    expect(page.status).toBe(200); expect(page.text).not.toMatch(SECRET); expect(page.json.taskBlocks.pb2).toEqual([]);
    const canvas = await rest(publicApi, null, '/canvas/tok-mb');
    expect(canvas.status).toBe(200); expect(canvas.text).not.toMatch(SECRET);
    expect(canvas.json.items[0].card).toEqual({ title: null, stage: null });
  });

  it('a token pinned to a space stops serving once its root moves; an unpinned or forged pin never serves', async () => {
    expect((await rest(publicApi, null, '/tok-secret')).status).toBe(200);
    await fx.db.prepare("UPDATE records SET space_id='team', seq=? WHERE id IN ('secret','sb1')").bind(++seq).run();
    const moved = await rest(publicApi, null, '/tok-secret'), unknown = await rest(publicApi, null, '/no-such-token');
    expect(moved.status).toBe(404); expect(moved.json).toEqual(unknown.json);
    await fx.db.prepare("UPDATE shares SET space_id=NULL WHERE token='tok-pub'").run();
    expect((await rest(publicApi, null, '/tok-pub')).status).toBe(404);
  });
});

describe('permissions enabled: authority changes between content and decision', () => {
  beforeEach(async () => { await enable(); });

  it('a revocation after the content read but before the decision removes the row', async () => {
    const raw = fx.db;
    let armed = true;
    const db = new Proxy(raw, { get(target, prop) {
      if (prop !== 'prepare') return Reflect.get(target, prop, target);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!armed || !sql.startsWith('SELECT id, collection, data')) return statement;
        return new Proxy(statement, { get(s, p) {
          const value = Reflect.get(s, p, s);
          if (p !== 'bind') return typeof value === 'function' ? value.bind(s) : value;
          return (...args: unknown[]) => {
            const bound = s.bind(...args);
            return new Proxy(bound, { get(b, q) {
              const v = Reflect.get(b, q, b);
              if (q !== 'first') return typeof v === 'function' ? v.bind(b) : v;
              return async (...a: unknown[]) => { const row = await b.first(...(a as [])); armed = false; await revoke('vault', 'alice'); return row; };
            } });
          };
        } });
      };
    } }) as D1Database;
    const env = withReadGate({ ...fx.env, DB: db }, 'alice');
    expect(await getRec(env, 'secret')).toBeNull();
  });

  it('a row whose revision changed after it was read is not served from the stale copy', async () => {
    const gate = createReadGate(fx.db, 'alice');
    const stale = { id: 'secret', rev: 4 };
    await fx.db.prepare("UPDATE records SET seq=? WHERE id='secret'").bind(++seq).run();
    expect(await gate.filter([stale])).toEqual([]);
  });

  it('recipients of record-derived content are the target\'s current readers', async () => {
    expect([...await readersOf(fx.db, 'secret', ['alice', 'bob', 'carol', 'gina'])]).toEqual(['alice']);
    expect([...await readersOf(fx.db, 'lk', ['alice', 'bob'])]).toEqual(['alice']);   // both relation endpoints
    expect([...await readersOf(fx.db, 'pub', ['alice', 'bob', 'gina'])].sort()).toEqual(['alice', 'bob']);
  });
});

describe('permissions enabled: bounded D1 cost of gated reads', () => {
  it('search, overview and a page read stay inside the 45-call invocation budget at 1,800 records', async () => {
    await enable();
    const insert = (id: string, data: Record<string, unknown>, space: string) => fx.db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES(?,?,?,?,?,?)').bind(id, 'pages', JSON.stringify(data), '{}', ++seq, space);
    for (let start = 0; start < 1800; start += 100) {
      await fx.db.batch(Array.from({ length: 100 }, (_, i) => { const n = start + i; return insert(`bulk-${n}`, { title: n % 3 ? `Bulk core ${n}` : `Vault bulk ${n}` }, n % 3 ? 'space-core' : 'vault'); }));
    }
    const metrics: Record<string, number> = {};
    for (const [tool, args] of [['search', { query: 'bulk' }], ['workspace_overview', {}], ['get_page', { pageId: 'pub' }]] as const) {
      const budget = withD1Budget(fx.env), before = d1BudgetRemaining(budget.DB);
      createWorkspaceServer({ ...(context('bob') as object), env: budget } as never);
      const res = await tools.get(tool)!(args as Record<string, unknown>);
      expect(res.isError === true, res.content[0].text.slice(0, 200)).toBe(false);
      expect(res.content[0].text).not.toMatch(/Vault bulk/);
      metrics[tool] = before - d1BudgetRemaining(budget.DB);
    }
    for (const calls of Object.values(metrics)) expect(calls).toBeLessThan(40);
    const dir = process.env.CERT_ARTIFACT_DIR ?? '.artifacts/phase5-reads';
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/phase5-reads-cost.json`, JSON.stringify({ records: 1800 + 20, readable: 'space-core', bindingCalls: metrics }, null, 2));
  }, 120_000);
});

it('ENABLED: deletedVia restoration does not revive a descendant in an unreadable peer space',async()=>{
 await enable();
 await fx.db.prepare("UPDATE records SET data=json_set(data,'$.deleted',json('true')) WHERE id='ct'").run();
 await fx.db.prepare("UPDATE records SET data=json_set(data,'$.deleted',json('true'),'$.deletedVia','ct') WHERE id='vt'").run();
 const result=await call('bob','restore_item',{type:'task',id:'ct',requestId:'scoped-cascade-restore'});
 expect(result.isError,result.text).toBe(false);
 expect(JSON.parse((await fx.db.prepare("SELECT data FROM records WHERE id='ct'").first<{data:string}>())!.data).deleted).toBe(false);
 expect(JSON.parse((await fx.db.prepare("SELECT data FROM records WHERE id='vt'").first<{data:string}>())!.data).deleted).toBe(true);
 expect(result.text).not.toMatch(SECRET);
});

it('ENABLED: MCP field history restores use current revision, journal undo and reauthorized replay', async () => {
  await enable();
  const {applyChanges}=await import('../worker/sync');
  await applyChanges(fx.env,'bob',[{id:'ct',collection:'tasks',patch:{title:'Changed through the server'},ts:Date.now()}],{serverTs:true});
  const h=await call('bob','get_record_history',{id:'ct'});
  expect(h.isError,h.text).toBe(false);
  const entry=h.json.entries[0];
  expect(entry.before.title).toBe('Core Task');
  const args={id:'ct',revision:entry.revision,expectedRev:h.json.revision,fields:['title'],side:'before',requestId:'mcp-history-restore'};
  const restored=await call('bob','restore_record_fields',args);
  expect(restored.isError,restored.text).toBe(false);
  expect((await getRec(fx.env,'ct'))?.data.title).toBe('Core Task');
  const replay=await call('bob','restore_record_fields',args);
  expect(replay.isError,replay.text).toBe(false);
  expect((await fx.db.prepare('SELECT COUNT(*) n FROM changeset_items WHERE changeset_id=?').bind(restored.json.changesetId).first())?.n).toBe(1);
  const undo=await call('bob','undo_change',{changesetId:restored.json.changesetId,requestId:'undo-history-restore'});
  expect(undo.isError,undo.text).toBe(false);
  expect((await getRec(fx.env,'ct'))?.data.title).toBe('Changed through the server');
  await fx.db.prepare("UPDATE users SET workspace_role='guest' WHERE id='bob'").run();
  const hidden=await call('bob','get_record_history',{id:'ct'});
  expect(hidden.isError).toBe(true);
  expect(hidden.text).not.toContain('Changed through the server');
  const denied=await call('bob','restore_record_fields',args);
  expect(denied.text).not.toContain('Core Task');
});
