import type { RecSnapshot } from '../../shared/templates';
import rawPeople from '../../templates/starter-people.json';

export interface BundledTemplate {
  key: string;
  name: string;
  description: string;
  icon: string;
  root: string;
  snapshot: RecSnapshot;
}

interface AuthorDb {
  id: string; name: string; icon?: string; kind?: string; recordNoun?: string;
  showBuiltins?: Record<string, boolean>; columns?: unknown[]; fields?: unknown[];
  views?: { id: string; name: string; type?: string; config?: Record<string, unknown> }[];
  defaultViewId?: string;
}
interface AuthorPage { id: string; title: string; icon?: string; blocks?: string[] }
interface AuthorTemplate { $schema?: string; name: string; description: string; icon: string; databases: AuthorDb[]; pages: AuthorPage[] }

let n = 0;
const oid = () => `tpl_${(n++).toString(36)}`;

/** Convert the hand-authored template format ({databases,pages}) into the RecSnapshot the planner consumes. */
function toBundled(key: string, t: AuthorTemplate): BundledTemplate {
  const boards: RecSnapshot['boards'] = {};
  const views: RecSnapshot['views'] = {};
  const blocks: RecSnapshot['blocks'] = {};
  const pages: RecSnapshot['pages'] = {};
  const dbIds = new Set((t.databases ?? []).map((d) => d.id));
  for (const d of t.databases ?? []) {
    let order = 'a0';
    for (const v of d.views ?? []) {
      order += '0';
      views[v.id] = { databaseId: d.id, name: v.name, type: v.type ?? 'table', config: v.config ?? {}, order };
    }
    boards[d.id] = {
      name: d.name, icon: d.icon, kind: d.kind, recordNoun: d.recordNoun,
      showBuiltins: d.showBuiltins, columns: d.columns, fields: d.fields,
      defaultViewId: d.defaultViewId ?? d.views?.[0]?.id, order,
    };
  }
  const root = t.pages[0]?.id ?? 'root';
  for (const pg of t.pages ?? []) {
    pages[pg.id] = { title: pg.title, icon: pg.icon, parentId: null, order: 'a0', isTemplate: true };
    let order = 'a0';
    for (const line of pg.blocks ?? []) {
      order += '0';
      const m = /^Embed:\s*(\S+)$/.exec(String(line).trim());
      if (m && dbIds.has(m[1])) {
        const id = oid();
        blocks[id] = { pageId: pg.id, order, type: 'tasks', boardId: m[1] };
      } else {
        const id = oid();
        blocks[id] = { pageId: pg.id, order, type: 'text', text: String(line) };
      }
    }
  }
  return { key, name: t.name, description: t.description, icon: t.icon, root, snapshot: { pages, blocks, boards, tasks: {}, views, links: {} } };
}

/** Bundled JSON templates (data, not code) — instantiated via planTemplateInstantiation. */
export const BUNDLED_TEMPLATES: BundledTemplate[] = [toBundled('starter-people', rawPeople as unknown as AuthorTemplate)];
