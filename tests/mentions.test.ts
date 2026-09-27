import { describe, expect, it } from 'vitest';
import { domToTextOffset, mentionTokens, parseText, renderPlain, serialize, textOffsetToDom } from '../src/core/mentions';

describe('mentions serializer', () => {
  it('round-trips plain text and chips', () => {
    const cases = [
      'hello world',
      'see @[page:abc123] for details',
      '@[page:p1] at start',
      'at end @[user:u9]',
      '@[page:a]@[user:b] adjacent',
      'a @[user:x] b @[page:y] c',
      '',
    ];
    for (const s of cases) {
      expect(serialize(parseText(s))).toBe(s);
    }
  });

  it('keeps adjacent chips atomic', () => {
    const nodes = parseText('@[page:a]@[user:b]');
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toEqual({ t: 'chip', kind: 'page', id: 'a' });
    expect(nodes[1]).toEqual({ t: 'chip', kind: 'user', id: 'b' });
  });

  it('resolves tokens to names in plain rendering', () => {
    const out = renderPlain('meet @[user:u1] at @[page:p1]', (kind) => (kind === 'user' ? 'Maya' : 'Spec page'));
    expect(out).toBe('meet Maya at Spec page');
  });

  it('falls back when a token cannot resolve', () => {
    expect(renderPlain('hi @[user:gone]', () => undefined)).toBe('hi @someone');
  });

  it('lists mention tokens for diffs', () => {
    expect(mentionTokens('a @[page:p1] b @[user:u2] @[page:p1]')).toEqual([
      { kind: 'page', id: 'p1' },
      { kind: 'user', id: 'u2' },
      { kind: 'page', id: 'p1' },
    ]);
  });
});

describe('caret offset mapping', () => {
  const text = 'hi @[page:p1] end';
  const nodes = parseText(text);
  const chipStart = 3; // after 'hi '
  const chipLen = '@[page:p1]'.length;

  it('maps text offsets to dom positions and back', () => {
    for (let off = 0; off <= text.length; off++) {
      const dom = textOffsetToDom(nodes, off);
      const back = domToTextOffset(nodes, dom.index, dom.char);
      // Inside the chip the caret snaps to a chip edge.
      if (off > chipStart && off < chipStart + chipLen) {
        expect([chipStart, chipStart + chipLen]).toContain(back);
      } else {
        expect(back).toBe(off);
      }
    }
  });

  it('snaps mid-chip positions to the nearest edge', () => {
    expect(textOffsetToDom(nodes, chipStart + 1)).toEqual({ index: 1, char: 0 });
    expect(textOffsetToDom(nodes, chipStart + chipLen - 1)).toEqual({ index: 2, char: 0 });
  });

  it('handles offsets at start and end', () => {
    expect(domToTextOffset(nodes, ...(() => { const d = textOffsetToDom(nodes, 0); return [d.index, d.char] as const; })())).toBe(0);
    const end = textOffsetToDom(nodes, text.length);
    expect(domToTextOffset(nodes, end.index, end.char)).toBe(text.length);
  });
});
