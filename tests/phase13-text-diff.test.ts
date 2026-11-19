import {expect, it} from 'vitest';
import {textDiff} from '../shared/textDiff';

it.each([
  ['', ''], ['', 'New'], ['Old', ''], ['Same', 'Same'],
  ['Plan a garden today', 'Plan a school today'],
  ['नमस्ते 👨‍👩‍👧‍👦 café e\u0301', 'नमस्ते 👨‍👩‍👧‍👦 école e\u0301'],
  ['<script>one</script>\n  two', '<script>three</script>\n  two'],
])('preserves complete before and after inputs %j', (before, after) => {
  const {parts} = textDiff(before, after);
  expect(parts.filter(p => p.kind !== 'added').map(p => p.text).join('')).toBe(before);
  expect(parts.filter(p => p.kind !== 'removed').map(p => p.text).join('')).toBe(after);
});
it('marks word changes while preserving whitespace and whole emoji segments', () => {
  expect(textDiff('The green garden', 'The blue garden').parts).toEqual([
    {kind:'equal', text:'The '}, {kind:'removed', text:'green'},
    {kind:'added', text:'blue'}, {kind:'equal', text:' garden'},
  ]);
  const emoji = '👨‍👩‍👧‍👦';
  expect(textDiff('Hello '+emoji, 'Hello 🌻').parts.find(p => p.kind === 'removed')?.text).toBe(emoji);
});
it('bounds comparison work without dropping long source values', () => {
  const before = 'before '.repeat(2000), after = 'after '.repeat(2000);
  const result = textDiff(before, after);
  expect(result.simplified).toBe(true);
  expect(result.parts.filter(p => p.kind !== 'added').map(p => p.text).join('')).toBe(before);
  expect(result.parts.filter(p => p.kind !== 'removed').map(p => p.text).join('')).toBe(after);
});
