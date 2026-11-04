import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {d1TestFiles,partitionTestFiles} from './test-files.mjs';

test('D1 certification discovers phases 4 through 13, including Phase 7', () => {
  const files = Array.from({length:10}, (_, i) => `tests/phase${i+4}-example-d1.test.ts`);
  assert.deepEqual(d1TestFiles(files), files);
});

test('D1 certification preserves audit/assistant coverage and excludes pure tests', () => {
  const included = ['tests/audit-example-d1.test.ts', 'tests/assistant-example-d1.test.ts'];
  const excluded = ['tests/phase7-example.test.ts', 'tests/phase14-example-d1.test.ts', 'tests/phase3-example-d1.test.ts', 'tests/phase7-example-d1.test.ts.bak'];
  assert.deepEqual(d1TestFiles([...included, ...excluded]), included);
});

test('the actual unit and D1 selections cover every file exactly once',()=>{
  const files=readdirSync(new URL('../../tests/',import.meta.url),{recursive:true}).filter(name=>name.endsWith('.test.ts')).map(name=>'tests/'+name);
  const {unit,d1}=partitionTestFiles(files);
  assert.ok(unit.length&&d1.length);
  assert.deepEqual(d1,d1TestFiles(files));
  assert.equal(new Set([...unit,...d1]).size,files.length);
  assert.equal(unit.length+d1.length,files.length);
  assert.deepEqual([...unit,...d1].sort(),files.sort());
  for(const name of ['phase4-performance-d1','phase5-cost-d1','phase6-cost-d1','phase5-review-d1'])assert.ok(d1.includes('tests/'+name+'.test.ts'),name);
  assert.ok(unit.includes('tests/website-mcp-d1.test.ts'),'Legacy Website coverage must not disappear');
});
