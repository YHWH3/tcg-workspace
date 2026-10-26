import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it} from 'vitest';

it('R2 rehearses a synthetic 0001–0003 SQL export, backfills and restores it on actual local D1', () => {
  mkdirSync('.artifacts/prod-copy-selftests',{recursive:true});
  const folder=mkdtempSync('.artifacts/prod-copy-selftests/d1-'),input=join(folder,'synthetic.sql');
  const migrations=JSON.parse(readFileSync('scripts/certification/migrations.json','utf8')).slice(0,3) as {name:string}[];
  const schema=migrations.map(m=>readFileSync('migrations/'+m.name,'utf8')).join('\n');
  const dump=schema+`\nCREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT DEFAULT CURRENT_TIMESTAMP);
${migrations.map(m=>`INSERT INTO d1_migrations(name) VALUES('${m.name}');`).join('\n')}
INSERT INTO users(id,username,role) VALUES('owner','owner','admin');
INSERT INTO records(id,collection,data,field_ts,seq) VALUES('board','boards','{"name":"Synthetic","fields":[{"id":"deadline","name":"Deadline","type":"date"}]}','{}',1);
INSERT INTO records(id,collection,data,field_ts,seq) VALUES('record','tasks','{"boardId":"board","title":"Semi; -- quoted","p_deadline":"2026-11-01"}','{}',2);
INSERT INTO files(id,mime,size,chunks,uploaded_by,created_at,complete) VALUES('file','text/plain',4,1,'owner',1,1);
INSERT INTO file_chunks(file_id,idx,data) VALUES('file',0,X'01020304');\n`;
  writeFileSync(input,dump,{mode:0o600});
  const run=execFileSync(process.execPath,['scripts/prod-copy-rehearsal.mjs',input],{encoding:'utf8',timeout:120_000});
  const output=JSON.parse(run.trim());expect(output.status).toBe('PASS');
  const report=JSON.parse(readFileSync(output.report,'utf8'));
  expect(report.checks).toHaveLength(7);expect(report.migrations).toHaveLength(32);
  expect(report.originalRecordCount).toBe(2);expect(report.originalMigrationCount).toBe(3);
  expect(report.maxBindingCalls).toBeLessThanOrEqual(45);
  expect(report.oauth.status).toBe('OWNER_VERIFICATION_REQUIRED');
  expect(report.remoteOperations).toBe(false);
  const bad=join(folder,'wrong-ledger.sql');writeFileSync(bad,dump+"UPDATE d1_migrations SET name='0003_unregistered.sql' WHERE name='0003_shares.sql';\n",{mode:0o600});
  const refused=spawnSync(process.execPath,['scripts/prod-copy-rehearsal.mjs',bad],{encoding:'utf8',timeout:120_000});
  expect(refused.status).toBe(1);const held=JSON.parse(refused.stdout.trim());expect(held.status).toBe('HOLD');
  const failed=JSON.parse(readFileSync(held.report,'utf8'));expect(failed.checks).toHaveLength(1);expect(failed.migrations).toEqual([]);
  expect(readFileSync(input,'utf8')).toBe(dump);
},150_000);
