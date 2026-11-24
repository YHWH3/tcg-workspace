import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort } from '../certification/core.mjs';
import { connectFixtureMcp } from '../certification/mcp-client.mjs';
import { startFixture, bootstrap, push } from '../phase4-fixture.mjs';
import { verifyRestricted } from '../access-verify.mjs';
import { inventory } from '../access-inventory.mjs';
import { newReport, rows, withDump, writeReport } from './dump.mjs';
import { verifyMigrationManifest } from '../release-rehearsal.mjs';

const root = new URL('../../', import.meta.url);
const prefix = verifyMigrationManifest().slice(0, 35);
const migrations = prefix.map(({ name }, i) => readFileSync(new URL('migrations/' + name, root), 'utf8') + (i ? '' : `
INSERT INTO users(id,username,role,created_at) VALUES ('fixture-owner','fixture-owner','admin',1),('fixture-member','fixture-member','member',2);
INSERT INTO records(id,collection,data,field_ts,seq) VALUES ('core-page','pages','{"title":"Synthetic Core page","createdBy":"fixture-owner"}','{}',1);
`) + `\nINSERT INTO d1_migrations(name) VALUES('${name}');\n`).join('');
const dump = 'CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT UNIQUE,applied_at TEXT DEFAULT CURRENT_TIMESTAMP);\n'
  + migrations + `
INSERT INTO spaces(id,name,default_access,created_at) VALUES('fixture-vault','Private sample','private',1);
INSERT INTO space_members(space_id,user_id,role) VALUES('fixture-vault','fixture-owner','owner');
INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES ('vault-page','pages','{"title":"Synthetic restricted page","createdBy":"fixture-owner"}','{}',2,'fixture-vault');
`;

test('inventory imports a synthetic migration prefix and detects an orphan without altering the input', async () => {
  const folder = newReport('selftest');
  const input = join(folder, 'synthetic-0035.sql');
  writeReport(folder, 'synthetic-0035.sql', dump);
  assert.equal((await withDump(input, async ({ db, applied, pending }) => {
    assert.equal(applied.length, 35);
    assert.equal(pending.at(-1).name, verifyMigrationManifest().at(-1).name);
    const report = await inventory(db, 450);
    assert.deepEqual(report.blockers, []);
    assert.equal(report.limits.activeAccounts, 2);
    assert.equal(report.recordsBySpace.length, 2);
    assert.equal(report.legacyGrants.status, 'OWNER_VERIFICATION_REQUIRED');
    await db.prepare(`UPDATE records SET data=json_set(data,'$.parentId','absent') WHERE id='vault-page'`).run();
    const broken = await inventory(db, 450);
    assert.deepEqual(broken.blockers, ['orphan_pages']);
    return (await rows(db, 'SELECT enabled FROM access_state'))[0].enabled;
  })), 0);
  assert.equal(readFileSync(input, 'utf8'), dump);
  await assert.rejects(withDump('https://example.test/export.sql', async () => {}));
  writeReport(folder, 'wrong-ledger.sql', dump + "UPDATE d1_migrations SET name='0035_unregistered.sql' WHERE name LIKE '0035%';");
  await assert.rejects(withDump(join(folder, 'wrong-ledger.sql'), async () => {}), /migration prefix/);
  console.log('Synthetic replay input:', input);
});

test('restricted verifier reads real HTTP/MCP against a new Worker, and fails with deliberately broadened fixture access', async () => {
  const folder = newReport('selftest-transport');
  const fixture = await startFixture({ port: await freePort(), artifactDirectory: folder });
  try {
    const { admin, bob } = await bootstrap(fixture.base);
    const marker = 'ScopeMarker' + randomBytes(12).toString('hex');
    const publicShareToken = randomBytes(16).toString('hex');
    const now = Date.now();
    const s = { spaceId: 'scope-vault', pageId: 'scope-page', databaseId: 'scope-board', taskId: 'scope-task', marker, publicShareToken };
    await push(fixture.base, admin.token, [
      { id: s.pageId, collection: 'pages', patch: { title: marker, order: 'a0' } },
      { id: 'scope-public-root', collection: 'pages', patch: { title: 'Synthetic public root', order: 'a1' } },
      { id: s.databaseId, collection: 'boards', patch: { name: marker, columns: [{ id: 'todo', name: 'To do', color: 'gray' }, { id: 'done', name: 'Done', color: 'green' }] } },
      { id: s.taskId, collection: 'tasks', patch: { title: marker, boardId: s.databaseId, status: 'todo' } },
    ]);
    await fixture.sql(`
      INSERT INTO spaces(id,name,default_access,created_at) VALUES('${s.spaceId}','Disposable private','private',1);
      INSERT INTO space_members(space_id,user_id,role) VALUES('${s.spaceId}','${admin.user.id}','owner');
      INSERT INTO space_members(space_id,user_id,role) VALUES('${s.spaceId}','${bob.user.id}','viewer');
      UPDATE records SET space_id='${s.spaceId}' WHERE id IN ('${s.pageId}','${s.databaseId}','${s.taskId}');
      INSERT INTO shares(token,page_id,space_id,created_by,created_at) VALUES('${publicShareToken}','scope-public-root','space-core','${admin.user.id}',${now});
      UPDATE record_history SET space_id='${s.spaceId}' WHERE record_id='${s.pageId}';
      INSERT INTO approvals(id,target_type,target_id,requested_by,approver_id,status,created_at) VALUES
        ('scope-a','record','${s.taskId}','${bob.user.id}','${admin.user.id}','pending',${now}),
        ('scope-b','record','${s.taskId}','${admin.user.id}','${bob.user.id}','pending',${now});
      INSERT INTO notifications(id,user_id,kind,target_type,target_id,title,created_at) VALUES
        ('scope-na','${admin.user.id}','mention','record','${s.taskId}','${marker}',${now}),
        ('scope-nb','${bob.user.id}','mention','record','${s.taskId}','${marker}',${now});
      UPDATE access_state SET enabled=1 WHERE id=1;
    `);
    const token = async username => {
      const mcp = await connectFixtureMcp(fixture.base, { username, fixtureHuman: false, includeToken: true });
      await mcp.close();
      return mcp.accessToken;
    };
    const config = { origin: fixture.base, samples: [s],
      reader: { session: admin.token, mcp: await token('admin') },
      restricted: { session: bob.token, mcp: await token('bob') },
    };
    const broad = await verifyRestricted(config, { loopback: true });
    writeReport(folder, 'broadened.json', broad);
    assert.equal(broad.status, 'HOLD');
    assert.ok(broad.checks.some(check => check.name === 'MCP fetch' && check.status === 'FAIL'));
    await fixture.sql(`DELETE FROM space_members WHERE space_id='${s.spaceId}' AND user_id='${bob.user.id}';`);
    const restricted = await verifyRestricted(config, { loopback: true });
    writeReport(folder, 'restricted.json', restricted);
    assert.equal(restricted.status, 'PASS', JSON.stringify(restricted));
    assert.equal(restricted.checks.length, 13);
  } finally {
    await fixture.stop();
  }
});
