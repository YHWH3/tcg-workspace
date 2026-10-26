import {test} from 'node:test';
import assert from 'node:assert/strict';
import {d1TestFiles} from './test-files.mjs';

test('D1 certification discovers phases 4 through 13, including Phase 7', () => {
  const files = Array.from({length:10}, (_, i) => `tests/phase${i+4}-example-d1.test.ts`);
  assert.deepEqual(d1TestFiles(files), files);
});

test('D1 certification preserves audit/assistant coverage and excludes pure tests', () => {
  const included = ['tests/audit-example-d1.test.ts', 'tests/assistant-example-d1.test.ts'];
  const excluded = ['tests/phase7-example.test.ts', 'tests/phase14-example-d1.test.ts', 'tests/phase3-example-d1.test.ts', 'tests/phase7-example-d1.test.ts.bak'];
  assert.deepEqual(d1TestFiles([...included, ...excluded]), included);
});
