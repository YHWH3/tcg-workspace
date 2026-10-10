/* Thin registry of bundled JSON templates (data, not code). The author-format
 * parser (`toBundled`) lives in shared/bundled.ts (Phase 3 §4) so the worker
 * and client share one implementation. */

import rawPeople from '../../templates/starter-people.json';
import rawPack from '../../templates/tcg-pack.json';
import { toBundled, type AuthorTemplate, type BundledTemplate } from '../../shared/bundled';

export type { AuthorTemplate, BundledTemplate };

/** Bundled JSON templates (data, not code) — instantiated via planTemplateInstantiation. */
export const BUNDLED_TEMPLATES: BundledTemplate[] = [
  toBundled('starter-people', rawPeople as unknown as AuthorTemplate),
  toBundled('tcg-pack', rawPack as unknown as AuthorTemplate),
];
