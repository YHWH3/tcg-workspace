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

import { crmApi, createS0CommandRegistry } from '../worker/crm';
import { runCommand } from '../worker/crm/commands';
import { createWorkspaceServer } from '../worker/mcp';
import { ingestWebsiteEvent } from '../worker/websiteIngest';
import { d1BudgetRemaining, withD1Budget } from '../worker/d1budget';
import { MAX_MERGE_ENDPOINTS, MergeHistoryPageResponseSchema, MergePreviewResponseSchema } from '../shared/crm/merge';
import { linkId } from '../shared/linkid';
import { sha256Hex } from '../worker/password';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';
import { interceptD1Batches } from './d1WriteBoundary';

const bgTasks: Promise<unknown>[] = [];
const waitCtx = {
  waitUntil: (p: Promise<unknown>) => {
    bgTasks.push(p);
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

let fx: AuditFixture | undefined;
afterEach(async () => {
  await Promise.allSettled(bgTasks.splice(0));
  capturedTools.clear();
  await fx?.dispose();
  fx = undefined;
});

async function setupFixture(opts: { permissionsEnabled?: boolean; localTest?: boolean } = {}) {
  fx = await openAuditFixture(
    [
      { id: 'owner1', role: 'admin' },
      { id: 'admin1', role: 'admin' },
      { id: 'merger1', role: 'member' },
      { id: 'reader1', role: 'member' },
    ],
    {
      CRM_ENABLED: '1',
      ...(opts.localTest ? { WORKSPACE_ENV: 'local-test' } : {}),
    },
  );

  const peopleFields = [
    { id: 'f_role', name: 'Role', type: 'text' },
    { id: 'f_email', name: 'Email', type: 'text' },
    { id: 'f_phone', name: 'Phone', type: 'text' },
    {
      id: 'f_tags',
      name: 'Tags',
      type: 'multi_select',
      options: [
        { id: 'tag-art', name: 'Artisan', color: 'blue' },
        { id: 'tag-ment', name: 'Mentor', color: 'green' },
      ],
    },
    { id: 'f_pnotes', name: 'Notes', type: 'text' },
    { id: 'f_applications', name: 'Applications', type: 'relation', relation: { target: 'board-apps' } },
  ];

  await fx.db.batch([
    fx.db.prepare('UPDATE access_state SET enabled = ? WHERE id = 1').bind(opts.permissionsEnabled ? 1 : 0),
    fx.db
      .prepare("UPDATE users SET workspace_role = CASE id WHEN 'owner1' THEN 'owner' WHEN 'admin1' THEN 'admin' ELSE 'member' END"),
    fx.db.prepare(`INSERT INTO spaces (id, name, default_access, created_at) VALUES ('space-restricted', 'Restricted', 'private', 1)`),
    fx.db.prepare(
      `INSERT INTO space_members (space_id, user_id, role)
       VALUES
         ('space-core', 'admin1', 'admin'),
         ('space-core', 'merger1', 'editor'),
         ('space-core', 'reader1', 'editor'),
         ('space-restricted', 'admin1', 'admin')`,
    ),
    fx.db.prepare(
      `INSERT INTO crm_capability_grants (user_id, capability, scope, granted_by, granted_at)
       VALUES
         ('admin1', 'crm.access', '*', 'owner1', 1),
         ('admin1', 'crm.merge', '*', 'owner1', 1),
         ('admin1', 'crm.send:whatsapp', '*', 'owner1', 1),
         ('merger1', 'crm.access', '*', 'owner1', 1),
         ('merger1', 'crm.merge', '*', 'owner1', 1),
         ('merger1', 'crm.send:whatsapp', '*', 'owner1', 1),
         ('reader1', 'crm.access', '*', 'owner1', 1)`,
    ),
    fx.db.prepare(
      `INSERT INTO records (id, collection, data, field_ts, seq, space_id, updated_at)
       VALUES
         ('board-people', 'boards', ?, '{"name":1,"templateDbKey":1,"fields":1}', 1, 'space-core', 100),
         ('board-people-sec', 'boards', ?, '{"name":1,"templateDbKey":1,"fields":1}', 1, 'space-restricted', 100),
         ('board-apps', 'boards', '{"name":"Applications","templateDbKey":"applications","fields":[{"id":"f_applicant","name":"Applicant","type":"relation"}]}', '{"name":1}', 1, 'space-core', 100),
         ('board-website-inbox', 'boards', '{"name":"Website Inbox","fields":[{"id":"wi_email","name":"Email","type":"text"}]}', '{"name":1}', 1, 'space-core', 100),
         ('person-surv', 'tasks', ?, '{"boardId":1,"title":1,"p_f_role":1,"p_f_email":1,"p_f_tags":1,"p_f_pnotes":1}', 1, 'space-core', 100),
         ('person-lose', 'tasks', ?, '{"boardId":1,"title":1,"p_f_email":1,"p_f_phone":1,"p_f_tags":1,"p_f_pnotes":1}', 2, 'space-core', 100),
         ('person-c', 'tasks', '{"boardId":"board-people","title":"Meera Third"}', '{"boardId":1,"title":1}', 3, 'space-core', 100),
         ('person-sec', 'tasks', '{"boardId":"board-people-sec","title":"Restricted Person"}', '{"boardId":1,"title":1}', 4, 'space-restricted', 100),
         ('app-shared', 'tasks', '{"boardId":"board-apps","title":"Shared App"}', '{"boardId":1,"title":1}', 5, 'space-core', 100),
         ('app-loser-only', 'tasks', '{"boardId":"board-apps","title":"Loser App"}', '{"boardId":1,"title":1}', 6, 'space-core', 100),
         ('sub-lose-1', 'tasks', '{"boardId":"board-people","parentId":"person-lose","title":"Child Note Task"}', '{"boardId":1,"parentId":1,"title":1}', 7, 'space-core', 100),
         ('blk-lose-1', 'blocks', '{"pageId":"person-lose","type":"text","text":"Legacy profile paragraph","order":"a0"}', '{"pageId":1,"type":1,"text":1}', 8, 'space-core', 100),
         ('cmt-lose-1', 'comments', '{"targetType":"task","targetId":"person-lose","body":"Comment on loser","createdBy":"owner1"}', '{"targetType":1,"targetId":1}', 9, 'space-core', 100),
         ('file-lose-1', 'files', '{"parentType":"task","parentId":"person-lose","name":"portfolio.pdf","mime":"application/pdf"}', '{"parentType":1,"parentId":1}', 10, 'space-core', 100)`,
    ).bind(
      JSON.stringify({ name: 'People', templateDbKey: 'people', fields: peopleFields }),
      JSON.stringify({ name: 'Restricted People', templateDbKey: 'people', fields: peopleFields }),
      JSON.stringify({
        boardId: 'board-people',
        title: 'Asha Rao',
        p_f_role: 'Pottery Lead',
        p_f_email: 'asha@primary.org',
        p_f_tags: ['tag-art'],
        p_f_pnotes: 'Survivor note',
        _crm_primary_email: 'asha@primary.org',
        _crm_endpoint_count: 2,
      }),
      JSON.stringify({
        boardId: 'board-people',
        title: 'Asha R.',
        p_f_email: 'asha@secondary.org',
        p_f_phone: '+919800001111',
        p_f_tags: ['tag-art', 'tag-ment'],
        p_f_pnotes: 'Loser note',
        _crm_primary_email: 'asha@secondary.org',
        _crm_primary_phone: '+919800001111',
        _crm_endpoint_count: 2,
      }),
    ),
    fx.db.prepare(
      `INSERT INTO records (id, collection, data, field_ts, seq, space_id, updated_at)
       VALUES
         (?, 'links', ?, '{"fromId":1,"toId":1}', 11, 'space-core', 100),
         (?, 'links', ?, '{"fromId":1,"toId":1}', 12, 'space-core', 100),
         (?, 'links', ?, '{"fromId":1,"toId":1}', 13, 'space-core', 100),
         (?, 'links', ?, '{"fromId":1,"toId":1}', 14, 'space-core', 100)`,
    ).bind(
      linkId('relation', 'f_applicant', 'app-shared', 'person-surv'),
      JSON.stringify({ fromType: 'record', fromId: 'app-shared', toType: 'record', toId: 'person-surv', kind: 'relation', fieldId: 'f_applicant', deleted: false }),
      linkId('relation', 'f_applicant', 'app-shared', 'person-lose'),
      JSON.stringify({ fromType: 'record', fromId: 'app-shared', toType: 'record', toId: 'person-lose', kind: 'relation', fieldId: 'f_applicant', deleted: false }),
      linkId('relation', 'f_applicant', 'app-loser-only', 'person-lose'),
      JSON.stringify({ fromType: 'record', fromId: 'app-loser-only', toType: 'record', toId: 'person-lose', kind: 'relation', fieldId: 'f_applicant', deleted: false }),
      linkId('related', '', 'person-surv', 'person-lose'),
      JSON.stringify({ fromType: 'record', fromId: 'person-surv', toType: 'record', toId: 'person-lose', kind: 'related', fieldId: null, deleted: false }),
    ),
    fx.db.prepare(
      `INSERT INTO crm_endpoints (id, person_id, kind, value_raw, value_norm, is_primary, source, created_by, created_at, updated_at)
       VALUES
         ('ep-surv-em', 'person-surv', 'email', 'asha@primary.org', 'asha@primary.org', 1, 'manual', 'owner1', 100, 100),
         ('ep-surv-wa', 'person-surv', 'whatsapp', '+919800002222', '+919800002222', 1, 'manual', 'owner1', 100, 100),
         ('ep-lose-em', 'person-lose', 'email', 'asha@secondary.org', 'asha@secondary.org', 1, 'manual', 'owner1', 100, 100),
         ('ep-lose-ph', 'person-lose', 'phone', '+919800001111', '+919800001111', 1, 'manual', 'owner1', 100, 100)`,
    ),
    fx.db.prepare(
      `INSERT INTO crm_consents (id, person_id, channel, scope, status, source, recorded_by, recorded_at)
       VALUES
         ('con-surv-wa', 'person-surv', 'whatsapp', 'transactional', 'granted', 'manual', 'owner1', 200),
         ('con-lose-wa', 'person-lose', 'whatsapp', 'transactional', 'withdrawn', 'optout', 'owner1', 100)`,
    ),
    fx.db.prepare(
      `INSERT INTO crm_conversations (id, channel, person_id, subject, state, assignee_id, window_expires_at, last_message_at, last_inbound_at, rev, created_at, updated_at)
       VALUES
         ('conv-surv', 'whatsapp', 'person-surv', 'Survivor WA thread', 'open', 'admin1', ?, 1000, 1000, 1, 100, 1000),
         ('conv-lose', 'whatsapp', 'person-lose', 'Loser WA thread', 'open', 'admin1', ?, 1200, 1200, 1, 100, 1200)`,
    ).bind(Date.now() + 86_400_000, Date.now() + 86_400_000),
    fx.db.prepare(
      `INSERT INTO crm_duplicate_candidates (id, person_a_id, person_b_id, reason, confidence, state, created_at)
       VALUES
         ('dup-sl', 'person-lose', 'person-surv', 'Name match', 'medium', 'open', 100),
         ('dup-lc', 'person-c', 'person-lose', 'Other pair', 'medium', 'open', 101)`,
    ),
    fx.db.prepare(
      `INSERT INTO form_people_keys (database_id, field_key, email, record_id)
       VALUES ('board-people', 'p_f_email', 'asha@secondary.org', 'person-lose')`,
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
      headers: fx!.auth(opts.actor ?? 'admin1'),
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    },
    scoped,
    ctx,
  );
  expect(45 - d1BudgetRemaining(scoped.DB)).toBeLessThanOrEqual(45);
  return res;
}

describe('CRM S10 Reversible Contact Merge & Unmerge (D1)', () => {
  it('previews accurately, executes atomic merge across all reference types, enforces non-broadening consent, and supports clean unmerge', async () => {
    await setupFixture({ permissionsEnabled: false, localTest: true });

    // 1. Reader without crm.merge cannot read preview or merges; admin/merger CAN read preview
    expect((await reqCrm('/read/merge-preview?survivorId=person-surv&loserId=person-lose', { actor: 'reader1' })).status).toBe(403);
    expect((await reqCrm('/read/merges', { actor: 'reader1' })).status).toBe(403);

    const prevRes = await reqCrm('/read/merge-preview?survivorId=person-surv&loserId=person-lose', { actor: 'merger1' });
    expect(prevRes.status).toBe(200);
    const preview = MergePreviewResponseSchema.parse(await prevRes.json());
    expect(preview.withinBudget).toBe(true);
    expect(preview.alreadyMerged).toBe(false);
    expect(preview.referenceCounts).toMatchObject({
      links: 3,
      subRecords: 1,
      comments: 1,
      files: 1,
      loserBlocksPreserved: 1,
      endpoints: 4,
      conversations: 1,
      duplicateCandidates: 2,
      formPeopleKeys: 1,
    });
    expect(preview.consentPreviews.find((c) => c.channel === 'whatsapp')).toMatchObject({
      survivorStatus: 'granted',
      loserStatus: 'withdrawn',
      effectiveStatus: 'withdrawn',
      strictestApplied: true,
    });

    // 2. Stale preview revision refuses with stale
    const staleRes = await reqCrm('/commands/person.merge', {
      method: 'POST',
      actor: 'merger1',
      body: {
        requestId: 'mrg_stale_01',
        input: { survivorId: 'person-surv', loserId: 'person-lose', confirm: true },
        expected: { 'person-surv': 999, 'person-lose': preview.loser.rev },
      },
    });
    expect(await staleRes.json()).toMatchObject({ ok: false, error: 'stale' });

    // 3. Execute merge cleanly (with member holding crm.merge)
    const mergeRes = await reqCrm('/commands/person.merge', {
      method: 'POST',
      actor: 'merger1',
      body: {
        requestId: 'mrg_clean_01',
        input: {
          survivorId: 'person-surv',
          loserId: 'person-lose',
          confirm: true,
          fieldResolutions: { title: 'survivor', p_f_email: 'survivor', p_f_tags: 'union', p_f_pnotes: 'concat' },
          primaryEndpoints: { email: 'ep-lose-em' },
          note: 'Confirmed same studio member',
        },
        expected: { 'person-surv': preview.survivor.rev, 'person-lose': preview.loser.rev },
      },
    });
    const mergeJson = (await mergeRes.json()) as {
      ok: boolean;
      result: { mergeId: string; survivorId: string; mergedId: string; movedCounts: Record<string, number> };
    };
    expect(mergeJson).toMatchObject({ ok: true });
    expect(mergeJson.result.movedCounts).toMatchObject({
      linksMoved: 1,
      linksDeduplicated: 1,
      selfLinksRemoved: 1,
      subRecordsMoved: 1,
      commentsMoved: 0,
      filesMoved: 1,
      endpointsMoved: 2,
      conversationsMoved: 1,
      duplicateCandidatesUpdated: 2,
      formPeopleKeysMoved: 1,
    });

    // Check survivor & loser record states & projections
    const survRow = JSON.parse((await fx!.db.prepare("SELECT data FROM records WHERE id = 'person-surv'").first<string>('data'))!) as Record<string, unknown>;
    const loseRow = JSON.parse((await fx!.db.prepare("SELECT data FROM records WHERE id = 'person-lose'").first<string>('data'))!) as Record<string, unknown>;
    expect(survRow.title).toBe('Asha Rao');
    expect(survRow.p_f_tags).toEqual(['tag-art', 'tag-ment']);
    expect(String(survRow.p_f_pnotes)).toContain('Survivor note');
    expect(String(survRow.p_f_pnotes)).toContain('Loser note');
    expect(survRow._crm_primary_email).toBe('asha@secondary.org');
    expect(survRow._crm_endpoint_count).toBe(4);
    expect(survRow._crm_open_conversations).toBe(2);
    expect(loseRow.archived).toBe(true);
    expect(loseRow._crm_merged_into).toBe('person-surv');

    // Loser's body block and comment remain intact on archived record; subrecord/file repointed
    expect(JSON.parse((await fx!.db.prepare("SELECT data FROM records WHERE id = 'blk-lose-1'").first<string>('data'))!).pageId).toBe('person-lose');
    expect(JSON.parse((await fx!.db.prepare("SELECT data FROM records WHERE id = 'sub-lose-1'").first<string>('data'))!).parentId).toBe('person-surv');
    expect(JSON.parse((await fx!.db.prepare("SELECT data FROM records WHERE id = 'cmt-lose-1'").first<string>('data'))!).targetId).toBe('person-lose');
    expect(JSON.parse((await fx!.db.prepare("SELECT data FROM records WHERE id = 'file-lose-1'").first<string>('data'))!).parentId).toBe('person-surv');

    // Check moved link, dedup link, removed self-link
    const movedNewLink = await fx!.db
      .prepare('SELECT data FROM records WHERE id = ?')
      .bind(linkId('relation', 'f_applicant', 'app-loser-only', 'person-surv'))
      .first<string>('data');
    expect(JSON.parse(movedNewLink!).deleted).toBe(false);
    const oldSelfLink = await fx!.db
      .prepare('SELECT data FROM records WHERE id = ?')
      .bind(linkId('related', '', 'person-surv', 'person-lose'))
      .first<string>('data');
    expect(JSON.parse(oldSelfLink!).deleted).toBe(true);

    // Check endpoints, alias, duplicate pair & third-party candidate, form_people_keys
    const epsAfter = (await fx!.db.prepare('SELECT id, person_id, is_primary FROM crm_endpoints ORDER BY id').all()).results as {
      id: string;
      person_id: string;
      is_primary: number;
    }[];
    expect(epsAfter.every((e) => e.person_id === 'person-surv')).toBe(true);
    expect(epsAfter.find((e) => e.id === 'ep-lose-em')?.is_primary).toBe(1);
    expect(epsAfter.find((e) => e.id === 'ep-surv-em')?.is_primary).toBe(0);

    expect(await fx!.db.prepare("SELECT survivor_id FROM crm_person_aliases WHERE alias_id = 'person-lose'").first('survivor_id')).toBe('person-surv');
    expect(await fx!.db.prepare("SELECT state FROM crm_duplicate_candidates WHERE id = 'dup-sl'").first('state')).toBe('merged');
    expect(await fx!.db.prepare("SELECT person_b_id FROM crm_duplicate_candidates WHERE id = 'dup-lc'").first()).toMatchObject({ person_b_id: 'person-surv' });
    expect(await fx!.db.prepare("SELECT record_id FROM form_people_keys WHERE email = 'asha@secondary.org'").first('record_id')).toBe('person-surv');

    // Append-only triggers protect crm_merges
    await expect(fx!.db.prepare("UPDATE crm_merges SET note = 'tamper'").run()).rejects.toThrow(/append-only/i);
    await expect(fx!.db.prepare('DELETE FROM crm_merges').run()).rejects.toThrow(/append-only/i);

    // 4. Non-broadening consent enforcement: WhatsApp send MUST fail with consent_withdrawn due to loser's pre-merge withdrawal!
    const blockedSend = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'admin1',
      body: { requestId: 'send_blocked_merged', input: { conversationId: 'conv-surv', bodyText: 'Attempt blocked WA' } },
    });
    expect(await blockedSend.json()).toMatchObject({ ok: false, error: 'consent_withdrawn' });

    // Confirm crm_consents rows were never mutated by merge
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_consents').first('n')).toBe(2);

    // 5. Unmerge capability & admin role check: non-admin merger1 CANNOT unmerge -> forbidden; admin1 CAN unmerge!
    const memberUnmerge = await reqCrm('/commands/person.unmerge', {
      method: 'POST',
      actor: 'merger1',
      body: { requestId: 'umg_forbidden_member', input: { mergeId: mergeJson.result.mergeId, confirm: true } },
    });
    expect(await memberUnmerge.json()).toMatchObject({ ok: false, error: 'forbidden' });

    const histBefore = MergeHistoryPageResponseSchema.parse(await (await reqCrm('/read/merges', { actor: 'admin1' })).json());
    expect(histBefore.items).toHaveLength(1);
    expect(histBefore.items[0]!.unmerged).toBeNull();

    const unmergeRes = await reqCrm('/commands/person.unmerge', {
      method: 'POST',
      actor: 'admin1',
      body: {
        requestId: 'umg_clean_01',
        input: { mergeId: mergeJson.result.mergeId, confirm: true, reason: 'Two distinct siblings share phone' },
      },
    });
    expect(await unmergeRes.json()).toMatchObject({
      ok: true,
      result: { mergeId: mergeJson.result.mergeId, survivorId: 'person-surv', restoredId: 'person-lose' },
    });

    // Double unmerge refuses cleanly
    const doubleUnmerge = await reqCrm('/commands/person.unmerge', {
      method: 'POST',
      actor: 'admin1',
      body: { requestId: 'umg_double_01', input: { mergeId: mergeJson.result.mergeId, confirm: true } },
    });
    expect(await doubleUnmerge.json()).toMatchObject({ ok: false, error: 'stale', detail: { reason: 'already_unmerged' } });

    // Verify full lossless restoration of records, links, endpoints/primaries, convs, duplicates, form keys, and aliases
    const survRestored = JSON.parse((await fx!.db.prepare("SELECT data FROM records WHERE id = 'person-surv'").first<string>('data'))!) as Record<string, unknown>;
    const loseRestored = JSON.parse((await fx!.db.prepare("SELECT data FROM records WHERE id = 'person-lose'").first<string>('data'))!) as Record<string, unknown>;
    expect(survRestored.p_f_tags).toEqual(['tag-art']);
    expect(survRestored.p_f_pnotes).toBe('Survivor note');
    expect(survRestored._crm_primary_email).toBe('asha@primary.org');
    expect(loseRestored.archived).toBe(false);
    expect(loseRestored._crm_merged_into).toBeNull();
    expect(loseRestored._crm_primary_email).toBe('asha@secondary.org');
    expect(JSON.parse((await fx!.db.prepare("SELECT data FROM records WHERE id = 'sub-lose-1'").first<string>('data'))!).parentId).toBe('person-lose');
    expect(JSON.parse((await fx!.db.prepare("SELECT data FROM records WHERE id = 'cmt-lose-1'").first<string>('data'))!).targetId).toBe('person-lose');
    expect(JSON.parse((await fx!.db.prepare("SELECT data FROM records WHERE id = 'file-lose-1'").first<string>('data'))!).parentId).toBe('person-lose');
    expect(JSON.parse((await fx!.db.prepare('SELECT data FROM records WHERE id = ?').bind(linkId('relation', 'f_applicant', 'app-shared', 'person-surv')).first<string>('data'))!).deleted).toBe(false);
    expect(JSON.parse((await fx!.db.prepare('SELECT data FROM records WHERE id = ?').bind(linkId('relation', 'f_applicant', 'app-shared', 'person-lose')).first<string>('data'))!).deleted).toBe(false);
    expect(JSON.parse((await fx!.db.prepare('SELECT data FROM records WHERE id = ?').bind(linkId('relation', 'f_applicant', 'app-loser-only', 'person-surv')).first<string>('data'))!).deleted).toBe(true);
    expect(JSON.parse((await fx!.db.prepare('SELECT data FROM records WHERE id = ?').bind(linkId('relation', 'f_applicant', 'app-loser-only', 'person-lose')).first<string>('data'))!).deleted).toBe(false);
    expect(await fx!.db.prepare("SELECT person_id FROM crm_conversations WHERE id = 'conv-lose'").first('person_id')).toBe('person-lose');
    expect(await fx!.db.prepare("SELECT person_id, is_primary FROM crm_endpoints WHERE id = 'ep-lose-em'").first()).toMatchObject({ person_id: 'person-lose', is_primary: 1 });
    expect(await fx!.db.prepare("SELECT person_id, is_primary FROM crm_endpoints WHERE id = 'ep-surv-em'").first()).toMatchObject({ person_id: 'person-surv', is_primary: 1 });
    expect(await fx!.db.prepare("SELECT state FROM crm_duplicate_candidates WHERE id = 'dup-sl'").first('state')).toBe('open');
    expect(await fx!.db.prepare("SELECT record_id FROM form_people_keys WHERE email = 'asha@secondary.org'").first('record_id')).toBe('person-lose');
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_person_aliases').first('n')).toBe(0);

    // Append-only triggers protect crm_merge_unmerges
    await expect(fx!.db.prepare("UPDATE crm_merge_unmerges SET reason = 'tamper'").run()).rejects.toThrow(/append-only/i);
    await expect(fx!.db.prepare('DELETE FROM crm_merge_unmerges').run()).rejects.toThrow(/append-only/i);
  });

  it('refuses unmerge with explicit conflicts when later independent edits occur (never silently discards edits)', async () => {
    await setupFixture({ permissionsEnabled: false, localTest: true });

    const mergeRes = await reqCrm('/commands/person.merge', {
      method: 'POST',
      actor: 'admin1',
      body: { requestId: 'mrg_conflict_setup', input: { survivorId: 'person-surv', loserId: 'person-lose', confirm: true } },
    });
    const mergeJson2 = (await mergeRes.json()) as { ok: boolean; result: { mergeId: string } };
    expect(mergeJson2).toMatchObject({ ok: true });
    const mergeId = mergeJson2.result.mergeId;

    // Independent edit: record explicit post-merge consent on survivor (bumps survivor seq) AND re-grant unblocks WhatsApp send!
    const regrantRes = await reqCrm('/commands/person.record_consent', {
      method: 'POST',
      actor: 'admin1',
      body: {
        requestId: 'con_post_merge_01',
        input: { personId: 'person-surv', channel: 'whatsapp', scope: 'transactional', status: 'granted', source: 'verbal_confirmation' },
      },
    });
    expect(await regrantRes.json()).toMatchObject({ ok: true });

    // Post-merge send now SUCCEEDS because consent recorded strictly AFTER merge effective_at
    const sendOk = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'admin1',
      body: { requestId: 'send_post_regrant', input: { conversationId: 'conv-surv', bodyText: 'Hello after re-grant!' } },
    });
    expect(await sendOk.json()).toMatchObject({ ok: true });

    // Also modify moved conversation 'conv-lose'
    await fx!.db.prepare("UPDATE crm_conversations SET subject = 'Edited after merge', rev = rev + 1 WHERE id = 'conv-lose'").run();

    // Attempt unmerge -> MUST refuse stale with structured conflicts and preserve post-merge edits intact!
    const umgRes = await reqCrm('/commands/person.unmerge', {
      method: 'POST',
      actor: 'admin1',
      body: { requestId: 'umg_conflict_01', input: { mergeId, confirm: true } },
    });
    const umgJson = (await umgRes.json()) as {
      ok: boolean;
      error: string;
      detail: { reason: string; conflicts: { code: string; entityId: string }[] };
    };
    expect(umgJson.ok).toBe(false);
    expect(umgJson.error).toBe('stale');
    expect(umgJson.detail.reason).toBe('unmerge_conflicts');
    expect(umgJson.detail.conflicts.some((c) => c.code === 'survivor_edited' && c.entityId === 'person-surv')).toBe(true);
    expect(umgJson.detail.conflicts.some((c) => c.code === 'conversation_edited' && c.entityId === 'conv-lose')).toBe(true);
    expect(await fx!.db.prepare("SELECT subject FROM crm_conversations WHERE id = 'conv-lose'").first('subject')).toBe('Edited after merge');
  });

  it('handles concurrent merge races, mid-request capability/session revocation, lost ack recovery, rollback on failure & budget refusal', async () => {
    await setupFixture({ permissionsEnabled: true });

    // 1. Concurrent opposite-direction merges (A <- B vs B <- A) -> at most one succeeds!
    const [r1, r2] = await Promise.all([
      reqCrm('/commands/person.merge', {
        method: 'POST',
        actor: 'admin1',
        body: { requestId: 'mrg_race_ab', input: { survivorId: 'person-surv', loserId: 'person-lose', confirm: true } },
      }),
      reqCrm('/commands/person.merge', {
        method: 'POST',
        actor: 'admin1',
        body: { requestId: 'mrg_race_ba', input: { survivorId: 'person-lose', loserId: 'person-surv', confirm: true } },
      }),
    ]);
    const j1 = (await r1.json()) as { ok: boolean; error?: string };
    const j2 = (await r2.json()) as { ok: boolean; error?: string };
    expect([j1.ok, j2.ok].filter(Boolean)).toHaveLength(1);
    const loserJson = j1.ok ? j2 : j1;
    expect(loserJson.ok).toBe(false);
    expect(['stale', 'invalid_input']).toContain(loserJson.error);

    // 2. Fresh fixture for mid-commit failure rollback, lost ack replay & capability revocation
    await fx!.dispose();
    await setupFixture({ permissionsEnabled: false });

    const failMidCommitDb = interceptD1Batches(fx!.db, async (target, statements, sql) => {
      if (sql.some((s) => s.includes('INSERT INTO crm_merges'))) {
        throw new Error('injected_mid_merge_failure');
      }
      return target.batch(statements);
    });
    const failedRes = await reqCrm('/commands/person.merge', {
      method: 'POST',
      actor: 'admin1',
      dbOverride: failMidCommitDb,
      body: { requestId: 'mrg_rollback_01', input: { survivorId: 'person-surv', loserId: 'person-lose', confirm: true } },
    });
    expect(failedRes.status).toBe(503);
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_merges').first('n')).toBe(0);
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_person_aliases').first('n')).toBe(0);
    expect(await fx!.db.prepare("SELECT person_id FROM crm_conversations WHERE id = 'conv-lose'").first('person_id')).toBe('person-lose');

    // Revoking crm.merge mid-merge between plan and commit aborts atomically with zero writes!
    let capRevokedOnce = false;
    const midRevokeDb = interceptD1Batches(fx!.db, async (target, statements, sql) => {
      if (!capRevokedOnce && sql.some((s) => s.includes('INSERT INTO crm_merges'))) {
        capRevokedOnce = true;
        await target.prepare("DELETE FROM crm_capability_grants WHERE user_id = 'merger1' AND capability = 'crm.merge'").run();
      }
      return target.batch(statements);
    });
    const midRevokeRes = await reqCrm('/commands/person.merge', {
      method: 'POST',
      actor: 'merger1',
      dbOverride: midRevokeDb,
      body: { requestId: 'mrg_mid_revoke_01', input: { survivorId: 'person-surv', loserId: 'person-lose', confirm: true } },
    });
    expect(capRevokedOnce).toBe(true);
    expect(await midRevokeRes.json()).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_merges').first('n')).toBe(0);
    await fx!.db
      .prepare("INSERT OR REPLACE INTO crm_capability_grants (user_id, capability, scope, granted_by, granted_at) VALUES ('merger1', 'crm.merge', '*', 'owner1', 1)")
      .run();

    // Lost ack on commit -> 503 then idempotent replay returns same mergeId cleanly!
    let ackFails = 0;
    const lostAckDb = interceptD1Batches(fx!.db, async (target, statements, sql) => {
      if (ackFails === 1) {
        ackFails += 1;
        throw new Error('recovery_transient');
      }
      const res = await target.batch(statements);
      if (ackFails === 0 && sql.some((s) => s.includes('INSERT INTO crm_merges'))) {
        ackFails += 1;
        throw new Error('lost_ack');
      }
      return res;
    });
    const first503 = await reqCrm('/commands/person.merge', {
      method: 'POST',
      actor: 'merger1',
      dbOverride: lostAckDb,
      body: { requestId: 'mrg_lost_ack_01', input: { survivorId: 'person-surv', loserId: 'person-lose', confirm: true } },
    });
    expect(first503.status).toBe(503);

    const replayOk = await reqCrm('/commands/person.merge', {
      method: 'POST',
      actor: 'merger1',
      body: { requestId: 'mrg_lost_ack_01', input: { survivorId: 'person-surv', loserId: 'person-lose', confirm: true } },
    });
    expect(await replayOk.json()).toMatchObject({ ok: true, result: { survivorId: 'person-surv', mergedId: 'person-lose' } });
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_merges').first('n')).toBe(1);

    // Revoking crm.merge blocks replay!
    await fx!.db.prepare("DELETE FROM crm_capability_grants WHERE user_id = 'merger1' AND capability = 'crm.merge'").run();
    const replayRevoked = await reqCrm('/commands/person.merge', {
      method: 'POST',
      actor: 'merger1',
      body: { requestId: 'mrg_lost_ack_01', input: { survivorId: 'person-surv', loserId: 'person-lose', confirm: true } },
    });
    expect(await replayRevoked.json()).toMatchObject({ ok: false, error: 'forbidden' });

    // Bounded budget refusal (> MAX_MERGE_ENDPOINTS) refuses budget_exceeded BEFORE any writes!
    await fx!.dispose();
    await setupFixture({ permissionsEnabled: false });
    const bulkEps: D1PreparedStatement[] = [];
    for (let i = 0; i <= MAX_MERGE_ENDPOINTS; i += 1) {
      bulkEps.push(
        fx!.db
          .prepare(
            `INSERT INTO crm_endpoints (id, person_id, kind, value_raw, value_norm, is_primary, source, created_by, created_at, updated_at)
             VALUES (?, 'person-lose', 'email', ?, ?, 0, 'import', 'owner1', 100, 100)`,
          )
          .bind(`ep-bulk-${i}`, `bulk${i}@example.org`, `bulk${i}@example.org`),
      );
    }
    await fx!.db.batch(bulkEps);

    const overBudgetPrev = await (
      await reqCrm('/read/merge-preview?survivorId=person-surv&loserId=person-lose', { actor: 'admin1' })
    ).json() as { withinBudget: boolean; budgetReasons: string[] };
    expect(overBudgetPrev.withinBudget).toBe(false);

    const overBudgetMerge = await reqCrm('/commands/person.merge', {
      method: 'POST',
      actor: 'admin1',
      body: { requestId: 'mrg_budget_over', input: { survivorId: 'person-surv', loserId: 'person-lose', confirm: true } },
    });
    expect(await overBudgetMerge.json()).toMatchObject({ ok: false, error: 'budget_exceeded' });
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_merges').first('n')).toBe(0);
  });

  it('resolves aliases in Website ingest + replay, inbound messaging, restricted spaces, and blocks MCP merge execution', async () => {
    await setupFixture({ permissionsEnabled: true, localTest: true });

    // Configure website authority grant so ingestWebsiteEvent operates on board-website-inbox / board-people
    await fx!.db.batch([
      fx!.db.prepare(
        `INSERT INTO website_ingest_grant (id, sponsor_id, space_id, inbox_id, people_id, version, updated_at)
         VALUES (1, 'owner1', 'space-core', 'board-website-inbox', 'board-people', 1, 100)`,
      ),
      fx!.db.prepare(
        `INSERT INTO crm_endpoints (id, person_id, kind, value_raw, value_norm, is_primary, source, created_by, created_at, updated_at)
         VALUES ('ep-lose-wa', 'person-lose', 'whatsapp', '+919800003333', '+919800003333', 1, 'manual', 'owner1', 100, 100)`,
      ),
    ]);

    // 1. Pre-merge website event matching person-lose via asha@secondary.org
    const preBody = {
      id: 'evt_pre_merge_01',
      event: 'form.submitted' as const,
      occurred_at: new Date().toISOString(),
      reply_to: 'asha@secondary.org',
      form_id: 'contact',
      subject: 'Pre-merge enquiry',
      answers: [
        { name: 'name', label: 'Name', value: 'Asha R' },
        { name: 'email', label: 'Email', value: 'asha@secondary.org' },
        { name: 'message', label: 'Note', value: 'Pre-merge enquiry' },
      ],
    };
    const preRes = await ingestWebsiteEvent(fx!.env, preBody as never, waitCtx);
    expect(preRes.status).toBe(200);
    expect(preRes.body.personId).toBe('person-lose');

    // 2. Restricted space visibility: reader1/merger1 lacking space-restricted gets 404 on merge-preview & merge with person-sec
    expect((await reqCrm('/read/merge-preview?survivorId=person-surv&loserId=person-sec', { actor: 'merger1' })).status).toBe(404);
    expect(
      await (
        await reqCrm('/commands/person.merge', {
          method: 'POST',
          actor: 'merger1',
          body: { requestId: 'mrg_sec_blocked', input: { survivorId: 'person-surv', loserId: 'person-sec', confirm: true } },
        })
      ).json(),
    ).toMatchObject({ ok: false, error: 'not_found' });

    // Admin1 merges person-sec into person-surv AND merges person-lose into person-surv
    expect(
      await (
        await reqCrm('/commands/person.merge', {
          method: 'POST',
          actor: 'admin1',
          body: { requestId: 'mrg_sec_admin', input: { survivorId: 'person-surv', loserId: 'person-sec', confirm: true } },
        })
      ).json(),
    ).toMatchObject({ ok: true });
    // Restricted merge stays hidden from merger1 in /read/merges!
    const mergerHist = MergeHistoryPageResponseSchema.parse(await (await reqCrm('/read/merges', { actor: 'merger1' })).json());
    expect(mergerHist.items.some((i) => i.mergedId === 'person-sec')).toBe(false);
    expect(mergerHist.partial).toBe(true);

    // Merge person-lose -> person-surv
    const mrgLoseJson = await (
      await reqCrm('/commands/person.merge', {
        method: 'POST',
        actor: 'merger1',
        body: { requestId: 'mrg_lose_for_ingest', input: { survivorId: 'person-surv', loserId: 'person-lose', confirm: true } },
      })
    ).json();
    expect(mrgLoseJson).toMatchObject({ ok: true });

    // 3. Replaying pre-merge accepted website event resolves person-lose -> person-surv (not unusable_identity!)
    const replayIngest = await ingestWebsiteEvent(fx!.env, preBody as never, waitCtx);
    expect(replayIngest.status).toBe(200);
    expect(replayIngest.body.personId).toBe('person-surv');

    // 4. New website submission with loser's email lands directly on canonical person-surv with 0 duplicate records!
    const postBody = {
      id: 'evt_post_merge_01',
      event: 'form.submitted' as const,
      occurred_at: new Date().toISOString(),
      reply_to: 'asha@secondary.org',
      form_id: 'contact',
      subject: 'Second submission after merge',
      answers: [
        { name: 'name', label: 'Name', value: 'Asha Secondary' },
        { name: 'email', label: 'Email', value: 'asha@secondary.org' },
        { name: 'message', label: 'Note', value: 'Second submission after merge' },
      ],
    };
    const postRes = await ingestWebsiteEvent(fx!.env, postBody as never, waitCtx);
    expect(postRes.status).toBe(200);
    expect(postRes.body.matchingStatus).toBe('matched');
    expect(postRes.body.personId).toBe('person-surv');

    // 5. Simulated inbound WhatsApp for loser's endpoint lands on person-surv
    const inboundRes = await reqCrm('/commands/conversation.simulate_inbound', {
      method: 'POST',
      actor: 'admin1',
      body: {
        requestId: 'inb_merged_01',
        input: { channel: 'whatsapp', externalEventId: 'wa_ev_mrg_01', fromValue: '+919800003333', bodyText: 'Message to secondary whatsapp' },
      },
    });
    expect(await inboundRes.json()).toMatchObject({ ok: true, result: { personId: 'person-surv' } });

    // 6. MCP cannot execute merge or unmerge (neither registered nor allowed via='mcp')
    createWorkspaceServer({
      env: fx!.env,
      ectx: ctx,
      userId: 'admin1',
      userRole: 'admin',
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
    expect(capturedTools.has('person.merge')).toBe(false);
    expect(capturedTools.has('person.unmerge')).toBe(false);
    expect(capturedTools.has('crm_merge')).toBe(false);
    expect(capturedTools.has('crm_unmerge')).toBe(false);

    // Direct runCommand via 'mcp' channel is refused forbidden for both person.merge & person.unmerge
    const registry = createS0CommandRegistry();
    const adminHash = await sha256Hex(fx!.token('admin1'));
    const mcpMergeRefusal = await runCommand({
      env: fx!.env,
      executionCtx: ctx,
      actorId: 'admin1',
      tokenHash: adminHash,
      via: 'mcp',
      name: 'person.merge',
      envelope: { requestId: 'mcp_merge_deny_01', input: { survivorId: 'person-surv', loserId: 'person-c', confirm: true } },
      registry,
    });
    expect(mcpMergeRefusal.body).toMatchObject({ ok: false, error: 'forbidden' });

    const mcpUnmergeRefusal = await runCommand({
      env: fx!.env,
      executionCtx: ctx,
      actorId: 'admin1',
      tokenHash: adminHash,
      via: 'mcp',
      name: 'person.unmerge',
      envelope: { requestId: 'mcp_unmerge_deny_01', input: { mergeId: 'any_merge', confirm: true } },
      registry,
    });
    expect(mcpUnmergeRefusal.body).toMatchObject({ ok: false, error: 'forbidden' });

    // /read/person/:id returns alias metadata on survivor and mergedInto on loser
    const survDetail = (await (await reqCrm('/read/person/person-surv', { actor: 'admin1' })).json()) as {
      aliases: string[];
      mergedInto: string | null;
      latestConsents: { channel: string; status: string }[];
    };
    expect(survDetail.mergedInto).toBeNull();
    expect(survDetail.aliases).toContain('person-lose');
    expect(survDetail.latestConsents.find((c) => c.channel === 'whatsapp')?.status).toBe('withdrawn');

    const loseDetail = (await (await reqCrm('/read/person/person-lose', { actor: 'admin1' })).json()) as {
      mergedInto: string | null;
    };
    expect(loseDetail.mergedInto).toBe('person-surv');
  });
});
