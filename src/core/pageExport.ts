import { blocksToMarkdown, type MentionResolvers } from '../../shared/markdown';

export interface ExportPage { id: string; title?: string; icon?: string; parentId?: string | null; }
export interface ExportBlock { id: string; pageId?: string; order?: string; type?: string; text?: string; checked?: boolean; fileId?: string; caption?: string; boardId?: string; url?: string; }
export interface ExportFile { id: string; name?: string; }
export interface ExportDatabase { id: string; name?: string; columns?: { id: string; name: string }[]; records: Record<string, unknown>[]; }
export interface PageMarkdownOptions {
  includeSubPages?: boolean;
  files?: readonly ExportFile[];
  databases?: readonly ExportDatabase[];
  resolvers?: MentionResolvers;
}

/** Deterministic page export used by the UI and unit tests. It contains no
 * browser or storage calls, so a downloaded file is reproducible locally. */
export function pageToMarkdown(root: ExportPage, pages: readonly ExportPage[], blocks: readonly ExportBlock[], options: PageMarkdownOptions = {}): string {
  const byParent = new Map<string | null, ExportPage[]>();
  for (const page of pages) {
    const parent = page.parentId ? String(page.parentId) : null;
    const list = byParent.get(parent) ?? [];
    list.push(page);
    byParent.set(parent, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? '')) || a.id.localeCompare(b.id));
  const render = (page: ExportPage, depth: number): string[] => {
    const heading = depth === 0 ? '# ' : `${'#'.repeat(Math.min(6, depth + 1))} `;
    const lines = [`${heading}${String(page.icon ?? '').trim()}${String(page.icon ?? '').trim() ? ' ' : ''}${String(page.title ?? '').trim() || 'Untitled'}`, ''];
    const pageBlocks = blocks.filter((block) => block.pageId === page.id).sort((a, b) => String(a.order ?? '').localeCompare(String(b.order ?? '')) || a.id.localeCompare(b.id));
    for (const block of pageBlocks) {
      if (block.type === 'tasks' && block.boardId) {
        const database = options.databases?.find((candidate) => candidate.id === block.boardId);
        if (database) {
          lines.push(databaseTable(database), '');
          continue;
        }
      }
      lines.push(blocksToMarkdown([block], options.resolvers));
      lines.push('');
    }
    if (options.includeSubPages) {
      for (const child of byParent.get(page.id) ?? []) lines.push('---', '', ...render(child, depth + 1));
    }
    return lines;
  };
  return replaceFileMarkers(render(root, 0).join('\n').replace(/\n{3,}/g, '\n\n').trim(), options.files ?? []);
}

export function recordToMarkdown(record: Record<string, unknown>, fields: readonly { id: string; name: string }[], blocks: readonly ExportBlock[], resolvers: MentionResolvers = {}): string {
  const lines = [`# ${String(record.title ?? 'Untitled')}`, '', '## Properties', '', '| Property | Value |', '| --- | --- |'];
  for (const field of fields) lines.push(`| ${escapeCell(field.name)} | ${escapeCell(String(record[`p_${field.id}`] ?? ''))} |`);
  if (record.status !== undefined) lines.push(`| Stage | ${escapeCell(String(record.status ?? ''))} |`);
  if (record.assigneeId !== undefined) lines.push(`| Assignee | ${escapeCell(String(record.assigneeId ?? ''))} |`);
  lines.push('', '## Body', '');
  lines.push(blocksToMarkdown([...blocks], resolvers));
  return replaceFileMarkers(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), []);
}

function databaseTable(database: ExportDatabase): string {
  const columns = database.columns?.length ? database.columns : [{ id: 'title', name: 'Title' }];
  const headers = columns.map((column) => column.name);
  const lines = [`| ${headers.map(escapeCell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const record of database.records.slice(0, 200)) {
    lines.push(`| ${columns.map((column) => escapeCell(String(record[column.id] ?? (column.id === 'title' ? record.title ?? '' : '')))).join(' | ')} |`);
  }
  if (database.records.length > 200) lines.push(`| …${database.records.length - 200} more |`);
  return lines.join('\n');
}

function escapeCell(value: string): string { return value.replaceAll('|', '\\|').replaceAll('\n', ' '); }

function replaceFileMarkers(markdown: string, files: readonly ExportFile[]): string {
  const names = new Map(files.map((file) => [file.id, file.name ?? file.id]));
  return markdown.replace(/file:([^)]*)/g, (_match, id: string) => names.get(id) ?? id);
}

