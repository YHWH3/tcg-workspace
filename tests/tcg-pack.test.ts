import { describe, expect, it } from 'vitest';
import rawPack from '../templates/tcg-pack.json';
import { toBundled, type AuthorTemplate } from '../shared/bundled';
import { planTemplateInstantiation } from '../shared/templates';

const bundle = toBundled('tcg-pack', rawPack as unknown as AuthorTemplate);

// Provenance keys deliberately retain authored identity; references must remap.
// Exclude only this top-level metadata property, never nested content or ids.
function danglingAuthoredReference(patch: Record<string, unknown>): boolean {
  const { templateItemKey: _provenance, ...references } = patch;
  return /"db_[a-z0-9_]+"|"pg_[a-z0-9_]+"|"r_[a-z0-9_]+"|"v_[a-z0-9_]+"/.test(JSON.stringify(references));
}


describe('tcg-pack install pipeline', () => {
  it('author format → snapshot carries every database, view, page, template', () => {
    const s = bundle.snapshot;
    expect(Object.keys(s.boards)).toHaveLength(17);
    expect(Object.keys(s.views ?? {}).length).toBeGreaterThanOrEqual(50);
    expect(Object.keys(s.pages).length).toBeGreaterThanOrEqual(30);
    // 17 reusable page templates ship marked isTemplate.
    const templates = Object.values(s.pages).filter((p) => p.isTemplate === true);
    expect(templates.length).toBeGreaterThanOrEqual(17);
  });

  it('retains provenance while detecting actual dangling references', () => {
    expect(danglingAuthoredReference({templateItemKey:'pg_home',parentId:'installed-parent'})).toBe(false);
    expect(danglingAuthoredReference({templateItemKey:'pg_home',parentId:'pg_parent'})).toBe(true);
    expect(danglingAuthoredReference({templateItemKey:'v_all',config:{databaseId:'db_projects'}})).toBe(true);
  });

  it('planner produces writes with no dangling authored ids', () => {
    let n = 0;
    const id = () => `x${(n++).toString(36)}`;
    const plan = planTemplateInstantiation(bundle.snapshot, { templateId: bundle.root, templateKey: 'tcg-pack', preserveTemplates: true, packInstall: true, actorId: 'u' }, { id, now: Date.now() });
    expect(plan).not.toBeNull();
    expect(plan!.writes.length).toBeGreaterThan(200);
    // All actual references remap; stable templateItemKey is identity metadata.
    const dangling = plan!.writes.filter((w) => danglingAuthoredReference(w.patch));
    expect(dangling.map((w) => `${w.collection}:${JSON.stringify(w.patch).slice(0, 140)}`)).toEqual([]);
    // Dashboard block types survive the copy with remapped databaseIds.
    const dashBlocks = plan!.writes.filter((w) => w.collection === 'blocks' && ['view', 'metric', 'calendar', 'activity', 'mywork'].includes(String(w.patch.type)));
    expect(dashBlocks.length).toBeGreaterThan(10);
    // Pack installs its page templates as templates (preserveTemplates).
    const tplPages = plan!.writes.filter((w) => w.collection === 'pages' && w.patch.isTemplate === true);
    expect(tplPages.length).toBeGreaterThanOrEqual(17);
    // Copied boards carry templateDbKey for dedupe.
    const keyed = plan!.writes.filter((w) => w.collection === 'boards' && typeof w.patch.templateDbKey === 'string');
    expect(keyed.length).toBe(17);
  });
});
