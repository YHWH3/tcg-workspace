/* Pure planning for "Apply to selection" (unit-tested in
 * tests/assistant-ui-apply.test.ts). Works on token-serialized block text —
 * the same form RichInput stores (`@[page:ID]` chips are tokens). */
import { MAX_SELECTION_CHARS } from '../../../shared/assistantProtocol';
import { mentionTokens } from '../mentions';

/** A selection can be an apply target only when it was sent to the model in
 * full — a truncated selection would replace just its head on apply. */
export function canTargetSelection(text: string): boolean {
  return text.trim().length > 0 && text.length <= MAX_SELECTION_CHARS;
}

export type ApplyPlan =
  | { ok: true; next: string }
  | { ok: false; reason: 'missing' | 'ambiguous' | 'empty' };

/** Occurrences of `needle` in `hay`, counting overlaps. */
export function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

/**
 * Model output is untrusted. Keep mention tokens only when they already
 * appeared in the original selection (the model may preserve, never invent,
 * references), normalise line endings and trim surrounding whitespace.
 */
export function sanitizeReplacement(original: string, replacement: string): string {
  const allowed = new Set(mentionTokens(original).map((t) => `@[${t.kind}:${t.id}]`));
  return replacement
    .replace(/\r\n?/g, '\n')
    .replace(/@\[(page|user|rec):([A-Za-z0-9_-]{1,64})\]/g, (tok) => (allowed.has(tok) ? tok : ''))
    .trim();
}

/** Replace the original selection only if it is still present exactly once. */
export function planSelectionReplace(current: string, original: string, replacement: string): ApplyPlan {
  if (!original) return { ok: false, reason: 'missing' };
  const text = sanitizeReplacement(original, replacement);
  if (!text) return { ok: false, reason: 'empty' };
  const n = countOccurrences(current, original);
  if (n === 0) return { ok: false, reason: 'missing' };
  if (n > 1) return { ok: false, reason: 'ambiguous' };
  const at = current.indexOf(original);
  return { ok: true, next: current.slice(0, at) + text + current.slice(at + original.length) };
}
