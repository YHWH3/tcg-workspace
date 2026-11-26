import { afterEach, describe, expect, it, vi } from 'vitest';

const capturedTools = vi.hoisted(
  () => new Map<string, { handler: (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }> }>(),
);

vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: class {
    registerTool(
      name: string,
      _meta: unknown,
      handler: (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>,
    ) {
      capturedTools.set(name, { handler });
      return { disable() {} };
    }
    registerPrompt() {}
    registerResource() {}
  },
  ResourceTemplate: class {},
}));
vi.mock('agents/mcp/server', () => ({ createMcpHandler: vi.fn() }));

import { crmApi } from '../worker/crm';
import { aiPreviewApi } from '../worker/aiPreviews';
import { createWorkspaceServer } from '../worker/mcp';
import { reduceConnection } from '../worker/connectorAccess';
import { d1BudgetRemaining, withD1Budget } from '../worker/d1budget';
import { HomeSummaryResponseSchema } from '../shared/crm/programmes';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';
import { sha256Hex } from '../worker/password';
import { interceptD1Batches } from './d1WriteBoundary';

let fx: AuditFixture | undefined;
afterEach(async () => {
  vi.useRealTimers();
  capturedTools.clear();
  await fx?.dispose();
  fx = undefined;
});

function wrapDbOnTrigger(
  rawDb: D1Database,
  opts: {
    onBatchIndex?: number;
    onSqlMatch?: RegExp;
    beforeBatchSqlMatch?: RegExp;
    matchOccurrence?: number;
    effect: () => Promise<void>;
  },
): { db: D1Database; fired: () => boolean } {
  const targetOccurrence = opts.matchOccurrence ?? 1;
  let batchCount = 0;
  let sqlMatchCount = 0;
  let batchMatchCount = 0;
  let didFire = false;
  const originals = new WeakMap<object, D1PreparedStatement>();
  const sqls = new WeakMap<object, string>();

  const fireOnce = async () => {
    if (didFire) return;
    didFire = true;
    await opts.effect();
  };

  const wrapStmt = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(stmt, {
      get(target, key) {
        if (key === 'bind') {
          return (...vals: Parameters<D1PreparedStatement['bind']>) => wrapStmt(target.bind(...vals), sql);
        }
        const orig = Reflect.get(target, key);
        if (['first', 'all', 'run', 'raw'].includes(String(key))) {
          return async (...args: unknown[]) => {
            if (!didFire && opts.onSqlMatch?.test(sql)) {
              sqlMatchCount += 1;
              if (sqlMatchCount >= targetOccurrence) {
                await fireOnce();
              }
            }
            return (orig as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof orig === 'function' ? orig.bind(target) : orig;
      },
    });
    originals.set(wrapped, stmt);
    sqls.set(wrapped, sql);
    sqls.set(stmt, sql);
    return wrapped;
  };

  const wrapSession = (source: D1Database | D1DatabaseSession): D1Database =>
    new Proxy(source, {
      get(target, key) {
        if (key === 'prepare') {
          return (sql: string) => wrapStmt(target.prepare(sql), sql);
        }
        if (key === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            batchCount += 1;
            const rawStmts = statements.map((s) => originals.get(s) ?? s);
            if (!didFire && opts.beforeBatchSqlMatch && statements.some((s) => opts.beforeBatchSqlMatch!.test(sqls.get(s) ?? ''))) {
              batchMatchCount += 1;
              if (batchMatchCount >= targetOccurrence) {
                await fireOnce();
              }
            }
            const res = await target.batch(rawStmts);
            if (!didFire && opts.onBatchIndex !== undefined && batchCount === opts.onBatchIndex) {
              await fireOnce();
            }
            return res;
          };
        }
        if (key === 'withSession') {
          return (...args: unknown[]) => wrapSession(((target as D1Database).withSession as (...a: unknown[]) => D1DatabaseSession)(...args));
        }
        const orig = Reflect.get(target, key);
        return typeof orig === 'function' ? orig.bind(target) : orig;
      },
    }) as D1Database;

  return { db: wrapSession(rawDb), fired: () => didFire };
}

async function setupFixture(opts: { permissionsEnabled?: boolean; localTest?: boolean } = {}) {
  fx = await openAuditFixture(
    [
      { id: 'owner1', role: 'admin' },
      { id: 'member1', role: 'member' },
      { id: 'member2', role: 'member' },
    ],
    {
      CRM_ENABLED: '1',
      ...(opts.localTest ? { WORKSPACE_ENV: 'local-test' } : {}),
    },
  );
  await fx.db.batch([
    fx.db.prepare('UPDATE access_state SET enabled = ? WHERE id = 1').bind(opts.permissionsEnabled ? 1 : 0),
    fx.db.prepare(
      "UPDATE users SET workspace_role = CASE id WHEN 'owner1' THEN 'owner' ELSE 'member' END",
    ),
    fx.db.prepare(`INSERT INTO spaces (id, name, default_access, created_at) VALUES ('space-restricted', 'Restricted', 'private', 1)`),
    fx.db.prepare(`INSERT INTO space_members (space_id, user_id, role) VALUES ('space-core', 'member1', 'editor'), ('space-core', 'member2', 'editor')`),
    fx.db.prepare(
      `INSERT INTO crm_capability_grants (user_id, capability, scope, granted_by, granted_at)
       VALUES
         ('member1', 'crm.access', '*', 'owner1', 1),
         ('member1', 'crm.send:whatsapp', '*', 'owner1', 1),
         ('member1', 'crm.configure', 'programme:common-lab', 'owner1', 1),
         ('member2', 'crm.access', '*', 'owner1', 1)`,
    ),
    fx.db.prepare(
      `INSERT INTO records (id, collection, data, field_ts, seq, space_id, updated_at)
       VALUES
         ('board-people', 'boards', '{"name":"People","templateDbKey":"people","fields":[]}', '{"name":1,"templateDbKey":1,"fields":1}', 1, 'space-core', 100),
         ('board-people-sec', 'boards', '{"name":"Restricted People","templateDbKey":"people","fields":[]}', '{"name":1,"templateDbKey":1,"fields":1}', 1, 'space-restricted', 100),
         ('board-programs', 'boards', '{"name":"Programs","templateDbKey":"programs","fields":[{"id":"f_slug","name":"Slug","type":"text"}]}', '{"name":1,"templateDbKey":1,"fields":1}', 1, 'space-core', 100),
         ('board-apps', 'boards', '{"name":"Applications","templateDbKey":"applications","fields":[]}', '{"name":1,"templateDbKey":1,"fields":1}', 1, 'space-core', 100),
         ('board-acts', 'boards', '{"name":"Activities","templateDbKey":"activities","fields":[]}', '{"name":1,"templateDbKey":1,"fields":1}', 1, 'space-core', 100),
         ('board-website-inbox', 'boards', '{"name":"Website Inbox","fields":[]}', '{"name":1,"fields":1}', 1, 'space-core', 100),
         ('person-pub', 'tasks', '{"boardId":"board-people","title":"Asha Open"}', '{"boardId":1,"title":1}', 1, 'space-core', 100),
         ('person-sec', 'tasks', '{"boardId":"board-people-sec","title":"Secret Contact"}', '{"boardId":1,"title":1}', 1, 'space-restricted', 100)`,
    ),
    fx.db.prepare(
      `INSERT INTO crm_endpoints (id, person_id, kind, value_raw, value_norm, is_primary, source, created_by, created_at, updated_at)
       VALUES
         ('ep-pub-wa', 'person-pub', 'whatsapp', '+919800000001', '+919800000001', 1, 'manual', 'owner1', 100, 100),
         ('ep-sec-wa', 'person-sec', 'whatsapp', '+919800000002', '+919800000002', 1, 'manual', 'owner1', 100, 100),
         ('ep-sec-email', 'person-sec', 'email', 'secret@example.org', 'secret@example.org', 1, 'manual', 'owner1', 100, 100)`,
    ),
    fx.db.prepare(
      `INSERT INTO crm_consents (id, person_id, channel, scope, status, source, recorded_by, recorded_at)
       VALUES ('cons-pub', 'person-pub', 'whatsapp', 'transactional', 'granted', 'manual', 'owner1', 100)`,
    ),
    fx.db.prepare(
      `INSERT INTO crm_duplicate_candidates (id, person_a_id, person_b_id, reason, confidence, state, created_at)
       VALUES ('dup-pub-sec', 'person-pub', 'person-sec', 'Test dup', 'high', 'open', 100)`,
    ),
    fx.db.prepare(
      `INSERT INTO crm_conversations (id, channel, person_id, programme_slug, subject, state, assignee_id, window_expires_at, last_message_at, last_inbound_at, rev, created_at, updated_at)
       VALUES
         ('conv-pub', 'whatsapp', 'person-pub', 'common-lab', 'Public studio thread', 'open', 'member1', ?, 1000, 1000, 1, 100, 1000),
         ('conv-sec', 'whatsapp', 'person-sec', 'common-lab', 'CONFIDENTIAL restricted thread', 'open', 'member1', ?, 1200, 1200, 1, 100, 1200)`,
    ).bind(Date.now() + 86_400_000, Date.now() + 86_400_000),
    fx.db.prepare(
      `INSERT INTO crm_messages (id, conversation_id, direction, status, channel, body_text, created_at, updated_at)
       VALUES ('msg-sec-in', 'conv-sec', 'inbound', 'received', 'whatsapp', 'CONFIDENTIAL message text', 100, 100)`,
    ),
    fx.db.prepare(
      `INSERT INTO crm_facts (id, scope, programme_slug, category, title, statement, status, rev, created_by, created_at, updated_at)
       VALUES ('fact-pub', 'programme:common-lab', 'common-lab', 'general', 'Hours', 'Open Tue-Sat', 'verified', 1, 'owner1', 100, 100)`,
    ),
  ]);
}

async function reqCrm(
  path: string,
  opts: { method?: string; actor?: string; body?: unknown; dbOverride?: D1Database } = {},
) {
  const baseEnv = opts.dbOverride ? { ...fx!.env, DB: opts.dbOverride } : fx!.env;
  const scoped = withD1Budget(baseEnv, 45);
  const res = await crmApi.request(
    path,
    {
      method: opts.method ?? 'GET',
      headers: fx!.auth(opts.actor ?? 'owner1'),
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    },
    scoped,
    ctx,
  );
  expect(45 - d1BudgetRemaining(scoped.DB)).toBeLessThanOrEqual(45);
  return res;
}

describe('P1 Hardening: protected reads, authority races, MCP preview integrity, messaging & My Work', () => {
  it('enforces ReadGate on readCrmHome() unanswered conversations (subjects, IDs, counts) and rejects mid-request authority/space races in both permission modes', async () => {
    // 1. Permissions ON: readCrmHome must hide conv-sec subject, id, and count
    await setupFixture({ permissionsEnabled: true });
    const homeRes = await reqCrm('/read/home', { actor: 'member1' });
    expect(homeRes.status).toBe(200);
    const homeBody = HomeSummaryResponseSchema.parse(await homeRes.json());
    expect(JSON.stringify(homeBody)).not.toContain('CONFIDENTIAL');
    expect(homeBody.today.some((i) => i.conversationId === 'conv-sec')).toBe(false);
    expect(homeBody.today.some((i) => i.conversationId === 'conv-pub')).toBe(true);
    expect(homeBody.counts.unansweredConversations).toBe(1);
    expect(homeBody.partial).toBe(true);

    // Also add patron submission pointing to person-sec's email and verify readPatrons does NOT leak personId 'person-sec'
    await fx!.db.prepare(
      `INSERT INTO records (id, collection, data, field_ts, seq, space_id, updated_at)
       VALUES ('pat-sec', 'tasks', ?, '{"boardId":1}', 1, 'space-core', 500)`,
    )
      .bind(
        JSON.stringify({
          boardId: 'board-website-inbox',
          title: 'Secret Patron',
          p_wi_family: 'patrons',
          p_wi_tier: 'founding',
          p_wi_email: 'secret@example.org',
        }),
      )
      .run();
    const patronsRes = await reqCrm('/read/patrons', { actor: 'member1' });
    expect(patronsRes.status).toBe(200);
    const patronsBody = (await patronsRes.json()) as { items: { submissionId: string; personId: string | null }[] };
    const patItem = patronsBody.items.find((i) => i.submissionId === 'pat-sec');
    expect(patItem).toBeDefined();
    expect(patItem?.personId).toBeNull();
    expect(JSON.stringify(patronsBody)).not.toContain('person-sec');

    // 2. Test mid-request authority & space revocation races across BOTH permission modes (0 and 1)
    for (const permissionsEnabled of [false, true]) {
      await fx!.dispose();
      await setupFixture({ permissionsEnabled });
      await fx!.db
        .prepare(
          `INSERT INTO records (id, collection, data, field_ts, seq, space_id, updated_at)
           VALUES ('pat-sec', 'tasks', ?, '{"boardId":1}', 1, 'space-core', 500)`,
        )
        .bind(
          JSON.stringify({
            boardId: 'board-website-inbox',
            title: 'Secret Patron',
            p_wi_family: 'patrons',
            p_wi_tier: 'founding',
            p_wi_email: 'secret@example.org',
          }),
        )
        .run();

      const memberTokenHash = await sha256Hex(fx!.token('member1'));
      const scenarios: {
        label: string;
        expectedStatuses: number[];
        mutate: () => Promise<void>;
        restore: () => Promise<void>;
      }[] = [
        {
          label: 'crm.access revoked mid-read',
          expectedStatuses: [403],
          mutate: async () => {
            await fx!.db.prepare("DELETE FROM crm_capability_grants WHERE user_id = 'member1'").run();
          },
          restore: async () => {
            await fx!.db
              .prepare(
                `INSERT OR REPLACE INTO crm_capability_grants (user_id, capability, scope, granted_by, granted_at)
                 VALUES
                   ('member1', 'crm.access', '*', 'owner1', 1),
                   ('member1', 'crm.send:whatsapp', '*', 'owner1', 1),
                   ('member1', 'crm.configure', 'programme:common-lab', 'owner1', 1)`,
              )
              .run();
          },
        },
        {
          label: 'demoted to guest mid-read',
          expectedStatuses: permissionsEnabled ? [403, 404] : [403],
          mutate: async () => {
            await fx!.db.prepare("UPDATE users SET workspace_role = 'guest' WHERE id = 'member1'").run();
          },
          restore: async () => {
            await fx!.db.prepare("UPDATE users SET workspace_role = 'member' WHERE id = 'member1'").run();
          },
        },
        {
          label: 'account disabled mid-read',
          expectedStatuses: permissionsEnabled ? [401, 404] : [401],
          mutate: async () => {
            await fx!.db.prepare('UPDATE users SET disabled_at = 1 WHERE id = ?').bind('member1').run();
          },
          restore: async () => {
            await fx!.db.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').bind('member1').run();
          },
        },
        {
          label: 'session revoked mid-read',
          expectedStatuses: [401],
          mutate: async () => {
            await fx!.db.prepare("DELETE FROM sessions WHERE user_id = 'member1'").run();
          },
          restore: async () => {
            await fx!.db
              .prepare(
                'INSERT OR REPLACE INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
              )
              .bind(memberTokenHash, 'member1', Date.now() + 86_400_000 * 30, Date.now())
              .run();
          },
        },
      ];

      const multiBatchRoutes = [
        '/read/home',
        '/read/person/person-pub',
        '/read/duplicates?state=open',
        '/read/programmes',
        '/read/timeline?subject=person-pub',
        '/read/conversations',
        '/read/conversation/conv-pub',
        '/read/patrons',
      ];

      for (const sc of scenarios) {
        for (const path of multiBatchRoutes) {
          const race = wrapDbOnTrigger(fx!.db, {
            onBatchIndex: 1, // Fires immediately after initial auth batch
            effect: sc.mutate,
          });
          const res = await reqCrm(path, { actor: 'member1', dbOverride: race.db });
          await sc.restore();
          expect(race.fired(), `${sc.label} fired on ${path}`).toBe(true);
          expect(sc.expectedStatuses, `${sc.label} (perm=${permissionsEnabled}) on ${path}`).toContain(res.status);
          const payloadText = await res.text();
          expect(payloadText).not.toContain('ep-pub-wa');
          expect(payloadText).not.toContain('Public studio thread');
          expect(payloadText).not.toContain('Open Tue-Sat');
        }

        // /read/facts reads auth + payload in ONE atomic batch; test race right before that atomic batch!
        const factsRace = wrapDbOnTrigger(fx!.db, {
          beforeBatchSqlMatch: /FROM crm_facts/,
          effect: sc.mutate,
        });
        const factsRes = await reqCrm('/read/facts', { actor: 'member1', dbOverride: factsRace.db });
        await sc.restore();
        expect(factsRace.fired(), `${sc.label} fired on /read/facts`).toBe(true);
        expect(sc.expectedStatuses, `${sc.label} (perm=${permissionsEnabled}) on /read/facts`).toContain(factsRes.status);
        expect(await factsRes.text()).not.toContain('Open Tue-Sat');
      }

      if (permissionsEnabled) {
        // Space access removed between observation and final validateObserved()
        await fx!.db.prepare("UPDATE spaces SET default_access = 'private' WHERE id = 'space-core'").run();
        const spaceRoutes: {
          path: string;
          trigger: { onSqlMatch?: RegExp; beforeBatchSqlMatch?: RegExp; matchOccurrence?: number };
        }[] = [
          { path: '/read/home', trigger: { beforeBatchSqlMatch: /FROM spaces s LEFT JOIN space_members/, matchOccurrence: 3 } },
          { path: '/read/person/person-pub', trigger: { beforeBatchSqlMatch: /FROM crm_endpoints/, matchOccurrence: 1 } },
          { path: '/read/conversation/conv-pub', trigger: { onSqlMatch: /FROM crm_messages/, matchOccurrence: 1 } },
        ];
        for (const sr of spaceRoutes) {
          const race = wrapDbOnTrigger(fx!.db, {
            ...sr.trigger,
            effect: async () => {
              await fx!.db.prepare("DELETE FROM space_members WHERE space_id = 'space-core' AND user_id = 'member1'").run();
            },
          });
          const res = await reqCrm(sr.path, { actor: 'member1', dbOverride: race.db });
          await fx!.db
            .prepare("INSERT OR REPLACE INTO space_members (space_id, user_id, role, access) VALUES ('space-core', 'member1', 'editor', 'allow')")
            .run();
          expect(race.fired(), `space race fired on ${sr.path}`).toBe(true);
          expect([403, 404]).toContain(res.status);
          const bodyTxt = await res.text();
          expect(bodyTxt).not.toContain('ep-pub-wa');
          expect(bodyTxt).not.toContain('Public studio thread');
        }
      }
    }
  });

  it('enforces MCP frozen previews, retry requestId dedupe, connector revocation & UI/MCP authority parity', async () => {
    await setupFixture({ permissionsEnabled: true, localTest: true });
    await fx!.db.prepare(
      `INSERT INTO ai_connections (id, user_id, client_id, spaces_json, version, created_at, expires_at)
       VALUES ('conn-1', 'member1', 'assistant', '["space-core"]', 1, ?, ?)`,
    )
      .bind(Date.now(), Date.now() + 86_400_000)
      .run();

    const connector = { id: 'conn-1', version: 1 };
    const boot = (userId: string) => {
      capturedTools.clear();
      createWorkspaceServer({
        env: { ...fx!.env, CONNECTOR: connector },
        ectx: ctx,
        userId,
        userRole: 'member',
        origin: 'https://crm.test',
        userByKey: new Map(),
        userNameById: new Map(),
        pageTitleById: new Map(),
        recordTitleById: new Map(),
        recordIdByTitle: new Map(),
        pageIdByTitle: new Map(),
        cachesReady: false,
        warnings: [],
        cs: null,
        toolName: '',
      } as never);
    };

    boot('member1');

    // Restricted conversation cannot even produce a preview
    const secDraft = await capturedTools.get('crm_draft_message')!.handler({ conversationId: 'conv-sec' });
    expect(secDraft.isError).toBe(true);
    expect(JSON.parse(secDraft.content[0].text)).toMatchObject({ error: 'not_found' });

    // 1. Propose draft with requestId -> creates 1 pending ai_preview, 0 crm_messages rows; retry with same requestId replays!
    const d1 = await capturedTools.get('crm_draft_message')!.handler({
      conversationId: 'conv-pub',
      guidance: 'Confirm hours',
      requestId: 'idemp_draft_001',
    });
    expect(d1.isError).toBeFalsy();
    const d1Json = JSON.parse(d1.content[0].text) as { previewId: string; argsHash: string; status: string };
    expect(d1Json.status).toBe('pending');
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_messages WHERE conversation_id = \'conv-pub\'').first('n')).toBe(0);

    const dReplay = await capturedTools.get('crm_draft_message')!.handler({
      conversationId: 'conv-pub',
      guidance: 'Confirm hours',
      requestId: 'idemp_draft_001',
    });
    expect(JSON.parse(dReplay.content[0].text)).toMatchObject({ previewId: d1Json.previewId, replayed: true });
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM ai_previews').first('n')).toBe(1);

    // Different args under same requestId -> conflict
    const dConflict = await capturedTools.get('crm_draft_message')!.handler({
      conversationId: 'conv-pub',
      guidance: 'Different guidance',
      requestId: 'idemp_draft_001',
    });
    expect(dConflict.isError).toBe(true);
    expect(JSON.parse(dConflict.content[0].text)).toMatchObject({ error: 'requestId_conflict' });

    // Same idempotent retry test for crm_propose_triage
    const t1 = await capturedTools.get('crm_propose_triage')!.handler({
      recordId: 'person-pub',
      suggestedStatus: 'in_review',
      rationale: 'Needs review',
      requestId: 'idemp_triage_001',
    });
    const t2 = await capturedTools.get('crm_propose_triage')!.handler({
      recordId: 'person-pub',
      suggestedStatus: 'in_review',
      rationale: 'Needs review',
      requestId: 'idemp_triage_001',
    });
    expect(JSON.parse(t2.content[0].text).suggestionId).toBe(JSON.parse(t1.content[0].text).suggestionId);
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM ai_suggestions').first('n')).toBe(1);

    // 2. Human approval required before execute_preview
    const preApproveExec = await capturedTools.get('execute_preview')!.handler({
      previewId: d1Json.previewId,
      argsHash: d1Json.argsHash,
    });
    expect(preApproveExec.isError).toBe(true);
    expect(JSON.parse(preApproveExec.content[0].text)).toMatchObject({ error: 'human_approval_required' });

    // Human approves in browser
    const apprRes = await aiPreviewApi.request(
      `/${d1Json.previewId}/decision`,
      {
        method: 'POST',
        headers: fx!.auth('member1'),
        body: JSON.stringify({ decision: 'approve', argsHash: d1Json.argsHash }),
      },
      fx!.env,
      ctx,
    );
    expect(apprRes.status).toBe(200);

    // 3. Reducing connector spaces (bumps version) OR revoking crm.access blocks BOTH MCP & UI execute (parity!)
    expect(await reduceConnection(fx!.env, 'member1', 'conn-1', [], 1)).toBe(true);
    const mcpAfterReduce = await capturedTools.get('execute_preview')!.handler({
      previewId: d1Json.previewId,
      argsHash: d1Json.argsHash,
    });
    expect(mcpAfterReduce.isError).toBe(true);
    expect(['preview_connection_changed', 'access changed during request; re-read current data']).toContain(
      JSON.parse(mcpAfterReduce.content[0].text).error,
    );

    const uiAfterReduce = await aiPreviewApi.request(
      `/${d1Json.previewId}/execute`,
      {
        method: 'POST',
        headers: fx!.auth('member1'),
        body: JSON.stringify({ argsHash: d1Json.argsHash }),
      },
      fx!.env,
      ctx,
    );
    expect(uiAfterReduce.status).toBe(403);
    expect(await uiAfterReduce.json()).toMatchObject({ error: 'preview_connection_changed' });
    expect(await fx!.db.prepare("SELECT COUNT(*) n FROM crm_messages WHERE conversation_id = 'conv-pub'").first('n')).toBe(0);

    // 4. Fresh preview with active v2 connector; revoke crm.access after approval -> UI & MCP both fail closed!
    const connectorV2 = { id: 'conn-1', version: 2 };
    await fx!.db.prepare("UPDATE ai_connections SET spaces_json = '[\"space-core\"]' WHERE id = 'conn-1'").run();
    capturedTools.clear();
    createWorkspaceServer({
      env: { ...fx!.env, CONNECTOR: connectorV2 },
      ectx: ctx,
      userId: 'member1',
      userRole: 'member',
      origin: 'https://crm.test',
      userByKey: new Map(),
      userNameById: new Map(),
      pageTitleById: new Map(),
      recordTitleById: new Map(),
      recordIdByTitle: new Map(),
      pageIdByTitle: new Map(),
      cachesReady: false,
      warnings: [],
      cs: null,
      toolName: '',
    } as never);

    const fProp = await capturedTools.get('crm_propose_fact')!.handler({
      title: 'Workshop fees',
      statement: 'Published per edition.',
      programmeSlug: 'common-lab',
      requestId: 'idemp_fact_002',
    });
    const fJson = JSON.parse(fProp.content[0].text) as { previewId: string; argsHash: string };
    expect(
      (
        await aiPreviewApi.request(
          `/${fJson.previewId}/decision`,
          { method: 'POST', headers: fx!.auth('member1'), body: JSON.stringify({ decision: 'approve', argsHash: fJson.argsHash }) },
          fx!.env,
          ctx,
        )
      ).status,
    ).toBe(200);

    await fx!.db.prepare("DELETE FROM crm_capability_grants WHERE user_id = 'member1' AND capability = 'crm.access'").run();
    const mcpNoCrmAccess = await capturedTools.get('execute_preview')!.handler({
      previewId: fJson.previewId,
      argsHash: fJson.argsHash,
    });
    expect(mcpNoCrmAccess.isError).toBe(true);
    expect(JSON.parse(mcpNoCrmAccess.content[0].text)).toMatchObject({ error: 'preview_access_changed' });

    const uiNoCrmAccess = await aiPreviewApi.request(
      `/${fJson.previewId}/execute`,
      { method: 'POST', headers: fx!.auth('member1'), body: JSON.stringify({ argsHash: fJson.argsHash }) },
      fx!.env,
      ctx,
    );
    expect(uiNoCrmAccess.status).toBe(403);
    expect(await fx!.db.prepare("SELECT COUNT(*) n FROM crm_facts WHERE status = 'draft'").first('n')).toBe(0);
  });

  it('hardens message.send/retry/drafts against inaccessible targets, already-sent rewrites, concurrent consent withdrawal, 0-row updates & recovery via preservation', async () => {
    await setupFixture({ permissionsEnabled: true, localTest: true });

    // 1. Inaccessible linked person blocks ALL conversation/message commands
    for (const [cmd, input] of [
      ['conversation.assign', { conversationId: 'conv-sec', assigneeId: 'member1' }],
      ['conversation.set_state', { conversationId: 'conv-sec', state: 'closed' }],
      ['conversation.link_person', { conversationId: 'conv-sec', personId: 'person-pub' }],
      ['message.add_note', { conversationId: 'conv-sec', bodyText: 'Attempt note' }],
      ['message.save_draft', { conversationId: 'conv-sec', bodyText: 'Attempt draft' }],
      ['message.generate_ai_draft', { conversationId: 'conv-sec' }],
      ['message.send', { conversationId: 'conv-sec', bodyText: 'Attempt send' }],
    ] as const) {
      const res = await reqCrm(`/commands/${cmd}`, {
        method: 'POST',
        actor: 'member1',
        body: { requestId: `sec_${cmd.replace(/\W/g, '_')}`, input },
      });
      expect(await res.json(), cmd).toMatchObject({ ok: false, error: 'not_found' });
    }

    // 2. Nonexistent messageId in message.send -> not_found (never ok:true on 0 rows updated!)
    const missingMsgRes = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 'send_missing_msg_01', input: { conversationId: 'conv-pub', messageId: 'no-such-draft', bodyText: 'Hi' } },
    });
    expect(await missingMsgRes.json()).toMatchObject({ ok: false, error: 'not_found' });

    // 3. Save draft, detect stale draft edit, then send once and block NEW requestId resend/overwrite
    const dSave = await reqCrm('/commands/message.save_draft', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 'draft_save_01', input: { conversationId: 'conv-pub', bodyText: 'First draft' } },
    });
    const draftId = ((await dSave.json()) as { result: { message: { id: string } } }).result.message.id;

    // Concurrent edit between save_draft -> send with stale expected timestamp fails closed
    const dEdit = await reqCrm('/commands/message.save_draft', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 'draft_save_02', input: { conversationId: 'conv-pub', messageId: draftId, bodyText: 'Edited draft' } },
    });
    expect((await dEdit.json() as { ok: boolean }).ok).toBe(true);
    const staleSend = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'member1',
      body: {
        requestId: 'send_stale_draft_01',
        input: { conversationId: 'conv-pub', messageId: draftId, bodyText: 'Stale draft' },
        expected: { [draftId]: 1 },
      },
    });
    expect(await staleSend.json()).toMatchObject({ ok: false, error: 'stale' });

    // 4. Concurrent consent withdrawal BETWEEN pre-check and commit batch aborts send cleanly!
    const consentRace = wrapDbOnTrigger(fx!.db, {
      beforeBatchSqlMatch: /INSERT INTO crm_outbox/,
      effect: async () => {
        await fx!.db
          .prepare(
            `INSERT INTO crm_consents (id, person_id, channel, scope, status, source, recorded_by, recorded_at)
             VALUES ('cons-wd-race', 'person-pub', 'whatsapp', 'transactional', 'withdrawn', 'manual', 'owner1', ?)`,
          )
          .bind(Date.now() + 500)
          .run();
      },
    });
    const raceSend = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'member1',
      dbOverride: consentRace.db,
      body: {
        requestId: 'send_consent_race_01',
        input: { conversationId: 'conv-pub', messageId: draftId, bodyText: 'Should abort on withdrawn consent' },
      },
    });
    expect(consentRace.fired()).toBe(true);
    expect(await raceSend.json()).toMatchObject({ ok: false, error: 'consent_withdrawn' });
    expect(await fx!.db.prepare(`SELECT status FROM crm_messages WHERE id = ?`).bind(draftId).first('status')).toBe('draft');
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_outbox').first('n')).toBe(0);

    // Re-grant consent & send successfully
    await fx!.db
      .prepare(
        `INSERT INTO crm_consents (id, person_id, channel, scope, status, source, recorded_by, recorded_at)
         VALUES ('cons-regrant', 'person-pub', 'whatsapp', 'transactional', 'granted', 'manual', 'owner1', ?)`,
      )
      .bind(Date.now() + 1000)
      .run();

    // 5. Simulated post-commit ack failure & lost acknowledgement:
    // Case A: error after commit ack while recovery batch succeeds -> recoverAfterCommitFailure preserves via='ui' & returns ok:true!
    let ackDroppedOnce = false;
    const postCommitErrorDb = interceptD1Batches(fx!.db, async (target, statements, sql) => {
      const res = await target.batch(statements);
      if (!ackDroppedOnce && sql.some((s) => s.includes('INSERT INTO crm_commands'))) {
        ackDroppedOnce = true;
        throw new Error('simulated_post_commit_ack_drop');
      }
      return res;
    });
    const recoveredInPlace = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'member1',
      dbOverride: postCommitErrorDb,
      body: {
        requestId: 'send_lost_ack_01',
        input: { conversationId: 'conv-pub', messageId: draftId, bodyText: 'Sent cleanly once' },
      },
    });
    expect(recoveredInPlace.status).toBe(200);
    expect(await recoveredInPlace.json()).toMatchObject({ ok: true, result: { message: { id: draftId, status: 'sent' } } });

    // Case B: both post-commit ack AND recovery query fail -> 503 write_interrupted, then client retries with same requestId -> ok:true & 1 outbox row!
    let failCount = 0;
    const lostAckDb503 = interceptD1Batches(fx!.db, async (target, statements, sql) => {
      if (failCount === 1) {
        failCount += 1;
        throw new Error('simulated_recovery_transient_error');
      }
      const res = await target.batch(statements);
      if (failCount === 0 && sql.some((s) => s.includes('INSERT INTO crm_commands'))) {
        failCount += 1;
        throw new Error('simulated_lost_ack');
      }
      return res;
    });
    const draftFor503 = await (
      await reqCrm('/commands/message.save_draft', {
        method: 'POST',
        actor: 'member1',
        body: { requestId: 'draft_save_503', input: { conversationId: 'conv-pub', bodyText: '503 recovery test' } },
      })
    ).json() as { result: { message: { id: string } } };
    const firstTry = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'member1',
      dbOverride: lostAckDb503,
      body: {
        requestId: 'send_lost_ack_02',
        input: { conversationId: 'conv-pub', messageId: draftFor503.result.message.id, bodyText: '503 recovery test' },
      },
    });
    expect(firstTry.status).toBe(503);
    expect(await firstTry.json()).toMatchObject({ error: 'write_interrupted', retryable: true });

    // Replay same requestId on normal DB -> MUST return ok: true (via='ui' preserved!) & NOT duplicate outbox
    const replayOk = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'member1',
      body: {
        requestId: 'send_lost_ack_01',
        input: { conversationId: 'conv-pub', messageId: draftId, bodyText: 'Sent cleanly once' },
      },
    });
    expect(await replayOk.json()).toMatchObject({ ok: true, result: { message: { id: draftId, status: 'sent' } } });
    const replay503Ok = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'member1',
      body: {
        requestId: 'send_lost_ack_02',
        input: { conversationId: 'conv-pub', messageId: draftFor503.result.message.id, bodyText: '503 recovery test' },
      },
    });
    expect(await replay503Ok.json()).toMatchObject({ ok: true, result: { message: { id: draftFor503.result.message.id, status: 'sent' } } });
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_outbox').first('n')).toBe(2);

    // Replay with REVOKED crm.send:whatsapp must refuse forbidden!
    await fx!.db.prepare("DELETE FROM crm_capability_grants WHERE user_id = 'member1' AND capability = 'crm.send:whatsapp'").run();
    const replayNoCap = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'member1',
      body: {
        requestId: 'send_lost_ack_01',
        input: { conversationId: 'conv-pub', messageId: draftId, bodyText: 'Sent cleanly once' },
      },
    });
    expect(await replayNoCap.json()).toMatchObject({ ok: false, error: 'forbidden' });

    // Restore send cap; sending already-sent draftId under a NEW requestId MUST refuse stale and NOT overwrite body!
    await fx!.db
      .prepare("INSERT INTO crm_capability_grants (user_id, capability, scope, granted_by, granted_at) VALUES ('member1', 'crm.send:whatsapp', '*', 'owner1', 2)")
      .run();
    const rewriteAttempt = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'member1',
      body: {
        requestId: 'send_rewrite_new_id',
        input: { conversationId: 'conv-pub', messageId: draftId, bodyText: 'REWRITTEN BODY' },
      },
    });
    expect(await rewriteAttempt.json()).toMatchObject({ ok: false, error: 'stale', detail: { reason: 'message_already_sent', status: 'sent' } });
    expect(await fx!.db.prepare('SELECT body_text FROM crm_messages WHERE id = ?').bind(draftId).first('body_text')).toBe('Sent cleanly once');

    // message.retry refuses already-sent messages cleanly
    const retrySent = await reqCrm('/commands/message.retry', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 'retry_sent_01', input: { messageId: draftId } },
    });
    expect(await retrySent.json()).toMatchObject({ ok: false, error: 'stale', detail: { reason: 'message_not_retryable', status: 'sent' } });

    // 6. Concurrent endpoint retirement aborts message.send atomically; failed retry checks approved template when window closed
    const draft2Res = await reqCrm('/commands/message.save_draft', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 'draft_save_03', input: { conversationId: 'conv-pub', bodyText: 'Endpoint race draft' } },
    });
    const draft2Id = ((await draft2Res.json()) as { result: { message: { id: string } } }).result.message.id;
    const endpointRace = wrapDbOnTrigger(fx!.db, {
      beforeBatchSqlMatch: /INSERT INTO crm_outbox/,
      effect: async () => {
        await fx!.db.prepare("UPDATE crm_endpoints SET retired_at = ? WHERE id = 'ep-pub-wa'").bind(Date.now()).run();
      },
    });
    const epRaceSend = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'member1',
      dbOverride: endpointRace.db,
      body: { requestId: 'send_ep_race_01', input: { conversationId: 'conv-pub', messageId: draft2Id, bodyText: 'Should fail on retired endpoint' } },
    });
    expect(endpointRace.fired()).toBe(true);
    expect(await epRaceSend.json()).toMatchObject({ ok: false, error: 'invalid_input', detail: { reason: 'no_active_endpoint' } });
    expect(await fx!.db.prepare(`SELECT status FROM crm_messages WHERE id = ?`).bind(draft2Id).first('status')).toBe('draft');

    // Re-activate endpoint, insert a failed message with closed window and unapproved template -> retry refuses window_closed; approving template lets retry succeed!
    await fx!.db.prepare("UPDATE crm_endpoints SET retired_at = NULL WHERE id = 'ep-pub-wa'").run();
    await fx!.db.batch([
      fx!.db.prepare("UPDATE crm_conversations SET window_expires_at = 1 WHERE id = 'conv-pub'"),
      fx!.db.prepare(
        `INSERT INTO crm_templates (id, channel, name, language, category, status, body_text, created_by, created_at, updated_at)
         VALUES ('tpl-wa-1', 'whatsapp', 'Follow up', 'en', 'utility', 'draft', 'Hello {{1}}', 'owner1', 100, 100)`,
      ),
      fx!.db.prepare(
        `INSERT INTO crm_messages (id, conversation_id, direction, status, channel, recipient_endpoint, author_user_id, body_text, template_id, created_at, updated_at)
         VALUES ('msg-failed-1', 'conv-pub', 'outbound', 'failed', 'whatsapp', '+919800000001', 'member1', 'Retry body', 'tpl-wa-1', 100, 100)`,
      ),
      fx!.db.prepare(
        `INSERT INTO crm_outbox (id, message_id, conversation_id, actor_id, request_id, status, attempts, created_at, updated_at)
         VALUES ('ob-failed-1', 'msg-failed-1', 'conv-pub', 'member1', 'orig_req', 'failed', 1, 100, 100)`,
      ),
    ]);
    const retryUnapprovedTpl = await reqCrm('/commands/message.retry', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 'retry_tpl_draft', input: { messageId: 'msg-failed-1' } },
    });
    expect(await retryUnapprovedTpl.json()).toMatchObject({ ok: false, error: 'window_closed' });

    await fx!.db.prepare("UPDATE crm_templates SET status = 'approved' WHERE id = 'tpl-wa-1'").run();
    const retryOk = await reqCrm('/commands/message.retry', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 'retry_tpl_ok', input: { messageId: 'msg-failed-1' } },
    });
    expect(await retryOk.json()).toMatchObject({ ok: true, result: { messageId: 'msg-failed-1' } });
    expect(await fx!.db.prepare("SELECT status FROM crm_messages WHERE id = 'msg-failed-1'").first('status')).toBe('sent');
    expect(await fx!.db.prepare("SELECT status FROM crm_outbox WHERE message_id = 'msg-failed-1'").first('status')).toBe('sent');
  });

  it('assigns personal follow-ups to owner, preserves shared unassigned queue, uses per-programme responseTargetDays & honors workspace timeZone boundaries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 2026-11-26T20:00:00Z === 2026-11-26 in UTC, 2026-11-27 01:30 in Asia/Kolkata!
    const nowUtcNight = Date.UTC(2026, 10, 26, 20, 0, 0);
    vi.setSystemTime(nowUtcNight);

    await setupFixture({ permissionsEnabled: false });
    await fx!.db.batch([
      fx!.db.prepare("UPDATE workspace_settings SET time_zone = 'Asia/Kolkata' WHERE id = 'workspace'"),
      fx!.db.prepare(
        `INSERT INTO crm_programme_profiles (slug, work_area, name, profile_json, rev, updated_at)
         VALUES
           ('common-lab', 'experiences_learning', 'Common Lab', ?, 1, ?),
           ('tribal-habitat-workshop', 'experiences_learning', 'Tribal Habitat Workshop', ?, 1, ?)`,
      ).bind(
        JSON.stringify({
          version: 1,
          area: 'experiences_learning',
          engines: { applications: true, bookings: true, membership: null, opportunities: [], patrons: false },
          responseTargetDays: 2,
        }),
        nowUtcNight,
        JSON.stringify({
          version: 1,
          area: 'experiences_learning',
          engines: { applications: true, bookings: true, membership: null, opportunities: [], patrons: false },
          responseTargetDays: 10,
        }),
        nowUtcNight,
      ),
      fx!.db.prepare(
        `INSERT INTO records (id, collection, data, field_ts, seq, space_id, updated_at)
         VALUES
           ('act-mine-boundary', 'tasks', ?, '{"boardId":1,"title":1,"p_f_owner":1,"p_f_due":1}', 1, 'space-core', ?),
           ('act-other-owner', 'tasks', ?, '{"boardId":1,"title":1,"p_f_owner":1,"p_f_due":1}', 1, 'space-core', ?),
           ('act-unassigned', 'tasks', ?, '{"boardId":1,"title":1,"p_f_due":1}', 1, 'space-core', ?),
           ('app-fast-age', 'tasks', ?, '{"boardId":1,"title":1,"status":1,"createdAt":1}', 1, 'space-core', ?),
           ('app-slow-ok', 'tasks', ?, '{"boardId":1,"title":1,"status":1,"createdAt":1}', 1, 'space-core', ?),
           ('app-unconf-ok', 'tasks', ?, '{"boardId":1,"title":1,"status":1,"createdAt":1}', 1, 'space-core', ?)`,
      ).bind(
        JSON.stringify({ boardId: 'board-acts', title: 'Member1 Nov26 Follow-up', status: 'planned', p_f_owner: 'member1', p_f_due: '2026-11-26' }),
        nowUtcNight,
        JSON.stringify({ boardId: 'board-acts', title: 'Member2 Private Follow-up', status: 'planned', p_f_owner: 'member2', p_f_due: '2026-11-26' }),
        nowUtcNight,
        JSON.stringify({ boardId: 'board-acts', title: 'Team Unassigned Follow-up', status: 'planned', p_f_due: '2026-11-26' }),
        nowUtcNight,
        JSON.stringify({ boardId: 'board-apps', title: 'Lab App (4d > 2d)', status: 'received', _crm_programme_slug: 'common-lab', createdAt: nowUtcNight - 4 * 86_400_000 }),
        nowUtcNight,
        JSON.stringify({ boardId: 'board-apps', title: 'Tribal App (4d < 10d)', status: 'received', _crm_programme_slug: 'tribal-habitat-workshop', createdAt: nowUtcNight - 4 * 86_400_000 }),
        nowUtcNight,
        JSON.stringify({ boardId: 'board-apps', title: 'Unconfigured App (20d, null target)', status: 'received', _crm_programme_slug: 'parambu-habitat', createdAt: nowUtcNight - 20 * 86_400_000 }),
        nowUtcNight,
      ),
      fx!.db.prepare(
        `INSERT INTO crm_conversations (id, channel, person_id, subject, state, assignee_id, last_message_at, last_inbound_at, rev, created_at, updated_at)
         VALUES
           ('conv-unassigned', 'email', 'person-pub', 'Shared Unassigned Thread', 'open', NULL, 2000, 2000, 1, 100, 2000),
           ('conv-other', 'email', 'person-pub', 'Member2 Owned Thread', 'open', 'member2', 2000, 2000, 1, 100, 2000)`,
      ),
    ]);

    const istRes = await reqCrm('/read/home', { actor: 'member1' });
    expect(istRes.status).toBe(200);
    const istHome = HomeSummaryResponseSchema.parse(await istRes.json());

    // Owner isolation: Member1 sees ONLY Member1's follow-up in personal `today`, NOT Member2's or unassigned
    const mineItem = istHome.today.find((i) => i.title === 'Member1 Nov26 Follow-up');
    expect(mineItem?.kind).toBe('followup_overdue'); // Overdue in Asia/Kolkata because Nov 27 01:30 > Nov 26!
    expect(istHome.today.some((i) => i.title === 'Member2 Private Follow-up')).toBe(false);
    expect(istHome.today.some((i) => i.title === 'Team Unassigned Follow-up')).toBe(false);
    expect(istHome.today.some((i) => i.title === 'Member2 Owned Thread')).toBe(false);
    expect(istHome.counts.dueFollowUps).toBe(1);

    // Shared queue explicitly carries unassigned follow-ups and unassigned conversations
    expect(istHome.shared.some((i) => i.title === 'Team Unassigned Follow-up')).toBe(true);
    expect(istHome.shared.some((i) => i.title === 'Shared Unassigned Thread')).toBe(true);
    expect(istHome.counts.unassignedFollowUps).toBe(1);
    expect(istHome.counts.unassignedConversations).toBe(1);

    // Programme-specific response targets: ONLY Common Lab (target=2d) flags at 4d!
    expect(istHome.counts.ageingApplications).toBe(1);
    expect(istHome.thisWeek.map((i) => i.title)).toContain('Lab App (4d > 2d)');
    expect(istHome.thisWeek.map((i) => i.title)).not.toContain('Tribal App (4d < 10d)');
    expect(istHome.thisWeek.map((i) => i.title)).not.toContain('Unconfigured App (20d, null target)');

    // Switch workspace timezone to UTC -> exact same Nov 26 20:00Z timestamp now makes Nov 26 `followup_due` (Today in UTC)
    await fx!.db.prepare("UPDATE workspace_settings SET time_zone = 'UTC' WHERE id = 'workspace'").run();
    const utcRes = await reqCrm('/read/home', { actor: 'member1' });
    const utcHome = HomeSummaryResponseSchema.parse(await utcRes.json());
    expect(utcHome.today.find((i) => i.title === 'Member1 Nov26 Follow-up')?.kind).toBe('followup_due');
  });
});
