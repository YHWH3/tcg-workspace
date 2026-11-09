import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAuditFixture, ctx as executionCtx, type AuditFixture } from './audit-fixture';
import { processSearchDirty, searchRecords, SearchError } from '../worker/search';
import { searchApi } from '../worker/searchApi';
import { withReadGate } from '../worker/readAccess';
import { parseSearchDateBounds } from '../worker/searchDates';

let fx: AuditFixture;
let seq = 0;
beforeEach(async () => {
  seq = 0;
  fx = await openAuditFixture([{ id: 'alice', role: 'admin' }, { id: 'bob' }]);
  await fx.db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('vault','Vault','private',1)").run();
  await fx.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('vault','alice','admin')").run();
  await fx.db.prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
});
afterEach(async () => { await fx.dispose(); });

const put = (id: string, title: string, createdAt: number, updatedAt: number, space = 'space-core') => fx.db.prepare(
  'INSERT INTO records(id,collection,data,field_ts,seq,space_id,updated_at) VALUES(?,?,?,?,?,?,?)',
).bind(id, 'pages', JSON.stringify({ title, createdAt }), JSON.stringify({ title: 1, createdAt: 1 }), ++seq, space, updatedAt);

describe('Phase 9.6 date-aware search', () => {
  it('resolves relative bounds in the workspace timezone and rejects inverted ranges', () => {
    expect(parseSearchDateBounds({ updatedFrom: 'today-7', updatedTo: 'today' }, '2026-11-04', 'Asia/Kolkata')).toEqual({
      updatedFrom: Date.parse('2026-10-27T18:30:00.000Z'),
      updatedTo: Date.parse('2026-11-04T18:29:59.999Z'),
    });
    expect(parseSearchDateBounds({ updatedFrom: '2026-11-05', updatedTo: '2026-11-04' }, '2026-11-04', 'UTC')).toBeNull();
    expect(parseSearchDateBounds({ updatedFrom: 'today+3651' }, '2026-11-04', 'UTC')).toBeNull();
  });

  it('filters indexed documents under the read gate and keeps cursors tied to the dates', async () => {
    await fx.db.batch([
      put('old', 'Harvest plan old', 1_700_000_000_000, 1_700_000_000_000),
      put('new', 'Harvest plan new', 1_710_000_000_000, 1_710_000_000_000),
      put('newer', 'Harvest plan newer', 1_712_000_000_000, 1_712_000_000_000),
      put('secret', 'Harvest plan secret', 1_720_000_000_000, 1_720_000_000_000, 'vault'),
    ]);
    await processSearchDirty(fx.env, 50);
    const env = withReadGate(fx.env, 'bob');
    const first = await searchRecords(env, 'bob', { q: 'harvest', updatedFrom: 1_705_000_000_000, updatedTo: 1_715_000_000_000, limit: 1 });
    expect(first.results).toHaveLength(1);
    expect(first.indexPending).toBe(false);
    expect(first.nextCursor).toBeTruthy();
    const second = await searchRecords(env, 'bob', { q: 'harvest', updatedFrom: 1_705_000_000_000, updatedTo: 1_715_000_000_000, cursor: first.nextCursor });
    expect(second.results).toHaveLength(1);
    const page = await searchRecords(env, 'bob', { q: 'harvest', updatedFrom: 1_705_000_000_000, limit: 1 });
    if (page.nextCursor) await expect(searchRecords(env, 'bob', { q: 'harvest', updatedFrom: 1_700_000_000_000, cursor: page.nextCursor })).rejects.toBeInstanceOf(SearchError);
    const api = await searchApi.request('http://localhost/?q=harvest&updatedFrom=2020-01-01&updatedTo=2027-01-01', { headers: fx.auth('bob') }, fx.env, executionCtx);
    const body = await api.json() as { results: { id: string }[] };
    expect(body.results.map((r) => r.id).sort()).toEqual(['new', 'newer', 'old']);
  });

  it('reports pending date metadata and excludes NULL rows until reindexed', async () => {
    await fx.db.batch([put('pending', 'Pending harvest', 1_710_000_000_000, 1_710_000_000_000)]);
    await processSearchDirty(fx.env, 50);
    await fx.db.prepare("UPDATE search_documents SET updated_at=NULL WHERE doc_id='pending'").run();
    const result = await searchRecords(withReadGate(fx.env, 'bob'), 'bob', { q: 'pending', updatedFrom: 1_700_000_000_000 });
    expect(result.results).toEqual([]);
    expect(result.indexPending).toBe(true);
  });
});
