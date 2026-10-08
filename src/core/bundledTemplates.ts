import type { RecSnapshot } from '../../shared/templates';
import starterPeople from '../../templates/starter-people.json';

export interface BundledTemplate {
  key: string;
  name: string;
  description: string;
  icon: string;
  root: string;
  snapshot: RecSnapshot;
}

/** Bundled JSON templates (data, not code) — instantiated via planTemplateInstantiation. */
export const BUNDLED_TEMPLATES: BundledTemplate[] = [starterPeople as unknown as BundledTemplate];
