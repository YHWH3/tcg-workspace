import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {localDump,dumpStatements} from '../prod-copy-rehearsal.mjs';

test('copy rehearsal refuses URLs, remote flags and symlinks',()=>{
  for(const value of ['https://example.org/dump.sql','file:///tmp/dump.sql','--remote','//host/share.sql',''])assert.throws(()=>localDump(value));
  mkdirSync('.artifacts/prod-copy-selftests',{recursive:true});const dir=mkdtempSync('.artifacts/prod-copy-selftests/path-');
  writeFileSync(join(dir,'dump.sql'),'SELECT 1;');symlinkSync('dump.sql',join(dir,'link.sql'));
  assert.throws(()=>localDump(join(dir,'link.sql')));assert.ok(localDump(join(dir,'dump.sql')).endsWith('/dump.sql'));
});
test('SQL parser preserves quoted semicolons and comment-like text',()=>{
  const statements=dumpStatements("CREATE TABLE t(x); INSERT INTO t VALUES('semi; -- literal'); -- comment\nSELECT 'it''s;valid';");
  assert.equal(statements.length,3);assert.match(statements[1],/semi; -- literal/);assert.match(statements[2],/it''s;valid/);
});
test('SQL parser preserves complete triggers and trailing comments',()=>{
  const statements=dumpStatements('CREATE TABLE t(x); CREATE TRIGGER ai AFTER INSERT ON t BEGIN UPDATE t SET x=2; SELECT 1; END; -- trailing comment');
  assert.equal(statements.length,2);assert.match(statements[1],/SELECT 1; END;/);
});
test('SQL parser rejects truncated export instead of silently dropping data',()=>{
  for(const sql of ["INSERT INTO t VALUES('cut",'CREATE TABLE t(x)','CREATE TRIGGER ai AFTER INSERT ON t BEGIN SELECT 1;'])assert.throws(()=>dumpStatements(sql));
});
