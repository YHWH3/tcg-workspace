import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { expect, it } from 'vitest';
import { LocalDB } from '../src/core/db';

it('upgrades a version-7 account store without losing held payloads, pending work or canonical rows', async () => {
  const name = `workspace-upgrade-${crypto.randomUUID()}`, old = new Dexie(name);
  // The published v7 schema, independently opened without the new migration.
  old.version(7).stores({
    pages: 'id, parentId, order', blocks: 'id, pageId, order',
    tasks: 'id, status, assigneeId, boardId, parentId, order, createdAt', comments: 'id, targetId, createdAt',
    activity: 'id, createdAt, targetId', users: 'id', outbox: '++autoId, id', meta: 'key',
    boards: 'id, order', files: 'id, parentId, createdAt', blobs: 'id, state',
    moodboards: 'id, order', mooditems: 'id, boardId, z', views: 'id, databaseId, order',
    links: 'id, fromId, toId, kind, fieldId', automations: 'id, databaseId, order', forms: 'id, databaseId, order',
    syncStage: '[snapshotId+id], snapshotId, collection', accessQuarantine: '++autoId, id, kind, generation',
  });
  const bytes = new Blob(['held binary payload']);
  await old.open();
  await old.table('pages').put({ id: 'allowed', title: 'Keep me', _ts: {} });
  await old.table('outbox').add({ id: 'allowed', collection: 'pages', patch: { title: 'Pending' }, ts: 1 });
  await old.table('accessQuarantine').bulkAdd([
    { id: 'hidden', kind: 'outbox', payload: { collection: 'pages', patch: { title: 'Private held text' } }, reason: 'access_revoked_or_read_only', generation: 20, quarantinedAt: 1 },
    { id: 'upload', kind: 'blob', payload: { blob: bytes, state: 'pending' }, reason: 'file_access_revoked', generation: 20, quarantinedAt: 2 },
  ]);
  old.close(); const upgraded = new LocalDB(name);
  try {
    await upgraded.open();
    expect((await upgraded.pages.get('allowed'))!.title).toBe('Keep me'); expect(await upgraded.outbox.count()).toBe(1);
    const held = await upgraded.accessQuarantine.toArray(), info = await upgraded.accessQuarantineInfo.toArray();
    expect(info).toHaveLength(2); expect(info.map(row => row.autoId)).toEqual(held.map(row => row.autoId));
    expect(info[0]).toMatchObject({ kind: 'outbox', collection: 'pages' });
    expect(JSON.stringify(info)).not.toMatch(/Private held text|payload|blob.*state/);
    expect(await (held[1].payload as { blob: Blob }).blob.text()).toBe('held binary payload');
    upgraded.close(); await upgraded.open(); expect(await upgraded.accessQuarantineInfo.count()).toBe(2);
  } finally { await upgraded.delete(); }
});
