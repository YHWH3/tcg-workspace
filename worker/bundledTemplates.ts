/* Worker-side bundled-template registry (Phase 3 §5): the same author JSON →
 * `toBundled` snapshot pipeline as the client, for the MCP `install_template`
 * tool. Keyed by bundled key for `{bundled: 'tcg-pack' | 'starter-people'}`
 * lookups. */

import rawPeople from '../templates/starter-people.json';
import rawPack from '../templates/tcg-pack.json';
import { toBundled, type AuthorTemplate, type BundledTemplate } from '../shared/bundled';

export const BUNDLED: Record<string, BundledTemplate> = {
  'starter-people': toBundled('starter-people', rawPeople as unknown as AuthorTemplate),
  'tcg-pack': toBundled('tcg-pack', rawPack as unknown as AuthorTemplate),
};
