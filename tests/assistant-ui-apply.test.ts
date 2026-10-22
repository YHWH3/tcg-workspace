import { describe, expect, it } from 'vitest';
import { canTargetSelection, countOccurrences, planSelectionReplace, sanitizeReplacement } from '../src/core/assistant/applyPlan';
import { MAX_SELECTION_CHARS } from '../shared/assistantProtocol';
import { parseInline, parseRich } from '../src/core/assistant/richtext';
import { safeInternalPath, sourcePath } from '../src/core/assistant/contextPaths';

describe('planSelectionReplace', () => {
  it('replaces a selection that is present exactly once', () => {
    expect(planSelectionReplace('Hello wrold, bye', 'wrold', 'world')).toEqual({ ok: true, next: 'Hello world, bye' });
  });

  it('refuses when the text changed since selection', () => {
    expect(planSelectionReplace('Hello there', 'wrold', 'world')).toEqual({ ok: false, reason: 'missing' });
  });

  it('refuses when the selection is ambiguous (appears more than once, including overlaps)', () => {
    expect(planSelectionReplace('ab ab', 'ab', 'x')).toEqual({ ok: false, reason: 'ambiguous' });
    expect(countOccurrences('aaa', 'aa')).toBe(2);
    expect(planSelectionReplace('aaa', 'aa', 'b')).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('never targets a selection that would be truncated before reaching the model', () => {
    expect(canTargetSelection('x'.repeat(MAX_SELECTION_CHARS))).toBe(true);
    expect(canTargetSelection('x'.repeat(MAX_SELECTION_CHARS + 1))).toBe(false);
    expect(canTargetSelection('   ')).toBe(false);
  });

  it('refuses empty replacements', () => {
    expect(planSelectionReplace('keep me', 'keep', '   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('works on token-serialized text and keeps only mention tokens from the original', () => {
    const current = 'See @[page:abc] for details today';
    const original = 'See @[page:abc] for details';
    const plan = planSelectionReplace(current, original, 'Details are in @[page:abc] and @[user:evil]');
    expect(plan).toEqual({ ok: true, next: 'Details are in @[page:abc] and today' });
    expect(sanitizeReplacement('plain', 'x @[rec:r1] y\r\nz')).toBe('x  y\nz');
  });
});

describe('markdown-lite', () => {
  it('parses paragraphs, lists, headings and code without HTML', () => {
    const b = parseRich('# Title\n\nPara one\nline two\n\n- a\n- **b**\n1. x\n2) y\n\n```\n<script>x</script>\n```');
    expect(b.map((x) => x.t)).toEqual(['h', 'p', 'ul', 'ol', 'code']);
    expect(b[4]).toEqual({ t: 'code', text: '<script>x</script>' });
    const ul = b[2] as { t: 'ul'; items: unknown[][] };
    expect(ul.items[1]).toEqual([{ t: 'b', v: 'b' }]);
  });

  it('keeps raw HTML as text and turns mention tokens into mention nodes', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([{ t: 'text', v: '<img src=x onerror=alert(1)>' }]);
    expect(parseInline('see @[page:p1] and `code`')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'mention', kind: 'page', id: 'p1' },
      { t: 'text', v: ' and ' },
      { t: 'code', v: 'code' },
    ]);
  });
});

describe('link safety', () => {
  it('accepts only same-app paths', () => {
    expect(safeInternalPath('/pages/1')).toBe('/pages/1');
    expect(safeInternalPath('//evil.example/x')).toBeNull();
    expect(safeInternalPath('/\\evil.example')).toBeNull();
    expect(safeInternalPath('https://evil.example')).toBeNull();
    expect(safeInternalPath('javascript:alert(1)')).toBeNull();
    expect(sourcePath({ id: 'p1', type: 'page', url: 'https://evil.example' })).toBe('/pages/p1');
    expect(sourcePath({ id: 'x', type: 'unknown' })).toBeNull();
  });
});
