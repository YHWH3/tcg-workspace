import rawPeople from '../../templates/starter-people.json';
import { toBundled, type AuthorTemplate, type BundledTemplate } from '../../shared/bundled';

export type { AuthorTemplate, BundledTemplate };

/** Bundled JSON templates (data, not code) — instantiated via planTemplateInstantiation. */
export const BUNDLED_TEMPLATES: BundledTemplate[] = [toBundled('starter-people', rawPeople as unknown as AuthorTemplate)];
