import { afterEach, describe, expect, it } from 'vitest';
import { applyChanges, sync } from '../worker/sync';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';

let fx: AuditFixture | undefined;
afterEach(async () => {
  await fx?.dispose();
  fx = undefined;
});

async function setup(permissionsEnabled: boolean, crmEnabled?: string) {
  fx = await openAuditFixture(
    [
      { id: 'alice', role: 'admin' },
      { id: 'bob', role: 'member' },
    ],
    crmEnabled !== undefined ? { CRM_ENABLED: crmEnabled } : {},
  );
  await fx.db.batch([
    fx.db.prepare('UPDATE access_state SET enabled = ? WHERE id = 1').bind(permissionsEnabled ? 1 : 0),
    fx.db.prepare(
      "UPDATE users SET workspace_role = CASE id WHEN 'alice' THEN 'owner' ELSE 'member' END",
    ),
    fx.db.prepare(
      `INSERT INTO records(id, collection, data, field_ts, seq, space_id)
       VALUES
         ('board-crm', 'boards', '{"name":"CRM","columns":[{"id":"todo","name":"To do","color":"gray"}]}', '{"name":1}', 1, 'space-core'),
         ('task-1', 'tasks', '{"title":"Person A","boardId":"board-crm","status":"todo"}', '{"title":1,"boardId":1,"status":1}', 2, 'space-core'),
         ('page-1', 'pages', '{"title":"Notes"}', '{"title":1}', 3, 'space-core')`,
    ),
  ]);
}

describe.each([
  { permissionsEnabled: false, crmEnabled: undefined },
  { permissionsEnabled: false, crmEnabled: '1' },
  { permissionsEnabled: true, crmEnabled: undefined },
  { permissionsEnabled: true, crmEnabled: '1' },
])(
  'SC-3 unconditional _crm_ projection key protection (permissions=$permissionsEnabled, CRM_ENABLED=$crmEnabled)',
  ({ permissionsEnabled, crmEnabled }) => {
    it('rejects client /api/sync/push writing _crm_* on tasks and pages while keeping clean writes intact', async () => {
      await setup(permissionsEnabled, crmEnabled);
      const now = Date.now();
      const body = {
        ...(permissionsEnabled ? { protocol: 3 } : {}),
        changes: [
          { id: 'task-1', collection: 'tasks', patch: { _crm_stage: 'qualified', title: 'Hijack' }, ts: now },
          { id: 'task-1', collection: 'tasks', patch: { _crm_score: 99 }, ts: now + 1 },
          { id: 'page-1', collection: 'pages', patch: { title: 'Clean update' }, ts: now + 2 },
        ],
      };
      const res = await sync.request(
        '/push',
        { method: 'POST', headers: fx!.auth('alice'), body: JSON.stringify(body) },
        fx!.env,
        ctx,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        rejected: number;
        rejectedItems: { id: string; collection: string; reason: string }[];
      };
      expect(json.ok).toBe(true);
      expect(json.rejected).toBe(2);
      expect(json.rejectedItems).toEqual([
        { id: 'task-1', collection: 'tasks', reason: 'protected_field' },
        { id: 'task-1', collection: 'tasks', reason: 'protected_field' },
      ]);
      // Ensure rejected === rejectedItems.length even with multiple mutations sharing an id.
      expect(json.rejected).toBe(json.rejectedItems.length);

      const task = JSON.parse(
        (await fx!.db.prepare("SELECT data FROM records WHERE id = 'task-1'").first<string>('data'))!,
      ) as Record<string, unknown>;
      expect(task._crm_stage).toBeUndefined();
      expect(task._crm_score).toBeUndefined();
      expect(task.title).toBe('Person A');

      const page = JSON.parse(
        (await fx!.db.prepare("SELECT data FROM records WHERE id = 'page-1'").first<string>('data'))!,
      ) as Record<string, unknown>;
      expect(page.title).toBe('Clean update');
    });

    it('allows granted _crm_* keys ONLY on tasks for the exact granted keys, rejecting other keys and non-task collections', async () => {
      await setup(permissionsEnabled, crmEnabled);
      const now = Date.now();
      const projection = { command: 'test.project', keys: new Set(['_crm_stage']) };

      // Granted key on tasks succeeds
      const okRes = await applyChanges(
        fx!.env,
        'alice',
        [{ id: 'task-1', collection: 'tasks', patch: { _crm_stage: 'enrolled' }, ts: now }],
        { atomic: true, serverTs: true, projection },
      );
      expect(okRes.rejected).toBe(0);
      expect(okRes.changed).toBe(1);
      const taskData = JSON.parse(
        (await fx!.db.prepare("SELECT data FROM records WHERE id = 'task-1'").first<string>('data'))!,
      ) as Record<string, unknown>;
      expect(taskData._crm_stage).toBe('enrolled');

      // Disallowed _crm_* key on tasks fails atomically without mutating title
      const badKeyRes = await applyChanges(
        fx!.env,
        'alice',
        [{ id: 'task-1', collection: 'tasks', patch: { _crm_other: 'nope', title: 'ShouldNotLand' }, ts: now + 10 }],
        { atomic: true, serverTs: true, projection },
      );
      expect(badKeyRes.rejected).toBe(1);
      expect(badKeyRes.changed).toBe(0);
      expect(badKeyRes.rejectedItems).toEqual([
        { id: 'task-1', collection: 'tasks', reason: 'protected_field' },
      ]);

      // Granted key on pages (non-tasks) fails atomically
      const wrongCollectionRes = await applyChanges(
        fx!.env,
        'alice',
        [{ id: 'page-1', collection: 'pages', patch: { _crm_stage: 'enrolled' }, ts: now + 20 }],
        { atomic: true, serverTs: true, projection },
      );
      expect(wrongCollectionRes.rejected).toBe(1);
      expect(wrongCollectionRes.changed).toBe(0);
      expect(wrongCollectionRes.rejectedItems).toEqual([
        { id: 'page-1', collection: 'pages', reason: 'protected_field' },
      ]);
    });

    it('preserves existing non-_crm_ underscore behavior across permission modes', async () => {
      await setup(permissionsEnabled, crmEnabled);
      const now = Date.now();
      const res = await applyChanges(
        fx!.env,
        'alice',
        [{ id: 'task-1', collection: 'tasks', patch: { _legacy: 'v1' }, ts: now }],
        { serverTs: true },
      );
      if (permissionsEnabled) {
        // When permissions are on, authorizeMutations rejects all _ keys except granted _crm_*
        expect(res.rejected).toBe(1);
        expect(res.rejectedItems?.[0]?.reason).toBe('protected_field');
      } else {
        // When permissions are off, non-_crm_ underscore fields retain legacy behavior
        expect(res.rejected).toBe(0);
        expect(res.changed).toBe(1);
      }
    });
  },
);
