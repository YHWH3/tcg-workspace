import { describe, expect, it } from 'vitest';
import { pageToMarkdown, recordToMarkdown } from '../src/core/pageExport';

describe('Phase 9 page and record Markdown export', () => {
  it('exports headings, mentions, files and a capped embedded database table', () => {
    const pages = [{ id: 'p', title: 'Project', icon: '📌' }, { id: 'child', title: 'Child', parentId: 'p' }];
    const blocks = [
      { id: 'b1', pageId: 'p', order: 'a', type: 'h2', text: 'Notes @[user:u1]' },
      { id: 'b2', pageId: 'p', order: 'b', type: 'image', fileId: 'file-1', caption: 'Photo' },
      { id: 'b3', pageId: 'p', order: 'c', type: 'tasks', boardId: 'db' },
      { id: 'b4', pageId: 'child', order: 'a', type: 'p', text: 'Child body' },
    ];
    const markdown = pageToMarkdown(pages[0], pages, blocks, {
      includeSubPages: true,
      files: [{ id: 'file-1', name: 'photo.webp' }],
      databases: [{ id: 'db', columns: [{ id: 'title', name: 'Title' }], records: [{ title: 'One' }, { title: 'Two' }] }],
      resolvers: { userName: (id) => id === 'u1' ? 'Asha' : undefined },
    });
    expect(markdown).toContain('# 📌 Project');
    expect(markdown).toContain('## Notes @Asha');
    expect(markdown).toContain('![Photo](photo.webp)');
    expect(markdown).toContain('| One |');
    expect(markdown).toContain('## Child');
  });

  it('caps embedded tables at 200 records and emits record properties', () => {
    const records = Array.from({ length: 201 }, (_, i) => ({ title: `Record ${i}` }));
    const markdown = pageToMarkdown({ id: 'p', title: 'Page' }, [{ id: 'p', title: 'Page' }], [{ id: 'b', pageId: 'p', type: 'tasks', boardId: 'db' }], { databases: [{ id: 'db', records }] });
    expect(markdown).toContain('…1 more');
    expect(recordToMarkdown({ title: 'Budget', p_amount: 120 }, [{ id: 'amount', name: 'Amount' }], [{ id: 'b', type: 'p', text: 'Body' }])).toContain('| Amount | 120 |');
  });
});
