import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, expect, it } from 'vitest';

let runtime: Miniflare | undefined;
afterEach(async () => { await runtime?.dispose(); runtime = undefined; });

it('P5-0: actual local D1 supports FTS5 prefix queries, ranking, snippets and SQL access filtering', async () => {
  runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'phase5-runtime-probe', modules: true,
    script: 'export default {fetch(){return new Response("disposable Phase 5 fixture")}}',
    compatibilityDate: '2026-09-25', d1Databases: { DB: 'disposable-phase5-runtime' },
  }] }));
  const db = await runtime.getD1Database('DB') as D1Database;
  await db.batch([
    db.prepare('CREATE VIRTUAL TABLE search_fts USING fts5(record_id UNINDEXED, collection UNINDEXED, space_id UNINDEXED, title, body)'),
    db.prepare('CREATE TABLE readable_spaces(id TEXT PRIMARY KEY)'),
    db.prepare("INSERT INTO readable_spaces VALUES('core')"),
    db.prepare('INSERT INTO search_fts VALUES(?,?,?,?,?)').bind('visible', 'pages', 'core', 'Funding Opportunity', 'Funding applications open'),
    db.prepare('INSERT INTO search_fts VALUES(?,?,?,?,?)').bind('secret', 'pages', 'private', 'Funding Secret', 'Hidden funding application'),
  ]);
  const result = await db.prepare(`SELECT record_id, bm25(search_fts) rank,
    snippet(search_fts,4,'[',']','…',10) snippet FROM search_fts
    WHERE search_fts MATCH ? AND space_id IN (SELECT id FROM readable_spaces)
    ORDER BY rank,record_id LIMIT 50`).bind('fund*').all<{ record_id: string; rank: number; snippet: string }>();
  expect(result.results).toHaveLength(1);
  expect(result.results[0]).toMatchObject({ record_id: 'visible', snippet: '[Funding] applications open' });
  expect(result.results[0].rank).toBeLessThan(0);
  expect(JSON.stringify(result.results)).not.toContain('secret');
  expect(result.meta.rows_read).toBeGreaterThan(0);
});
