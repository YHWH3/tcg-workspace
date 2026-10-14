import { describe, expect, it } from 'vitest';
import { blocksToMarkdown, markdownToBlocks, renderMentionText, resolveMentionText } from '../shared/markdown';

describe('markdownToBlocks', () => {
  it('parses the editor block types', () => {
    const md = `# Heading\n## Sub\n### Minor\ntext\n- item\n* star\n1. first\n2. second\n- [ ] open\n- [x] done\n> quoted\n\`\`\`js\nconst a=1\n\`\`\`\n---`;
    const types = markdownToBlocks(md).map((b) => b.type);
    expect(types).toEqual(['h1', 'h2', 'h3', 'p', 'bullet', 'bullet', 'numbered', 'numbered', 'todo', 'todo', 'quote', 'code', 'divider']);
  });

  it('keeps todo checked state and text', () => {
    const [open, done] = markdownToBlocks('- [ ] call Maya\n- [x] ship it');
    expect(open).toMatchObject({ type: 'todo', checked: false, text: 'call Maya' });
    expect(done).toMatchObject({ type: 'todo', checked: true, text: 'ship it' });
  });

  it('turns ![caption](url) into an image block carrying src', () => {
    const [b] = markdownToBlocks('![cover shot](https://x.test/a.png)');
    expect(b).toMatchObject({ type: 'image', src: 'https://x.test/a.png', caption: 'cover shot' });
  });

  it('collapses blank lines and skips empty', () => {
    expect(markdownToBlocks('\n\nhello\n\n\nworld\n').map((b) => b.text)).toEqual(['hello', 'world']);
  });
});

describe('mentions in markdown', () => {
  const resolvers = {
    resolveUser: (h: string) => (h === 'maya' || h === 'Maya' ? 'u-maya' : undefined),
    resolvePage: (t: string) => (t === 'Roadmap' ? 'p-road' : undefined),
  };

  it('resolves @handle to @[user:id] only on unique match', () => {
    expect(resolveMentionText('talk to @maya today', resolvers)).toBe('talk to @[user:u-maya] today');
    expect(resolveMentionText('talk to @ghost today', resolvers)).toBe('talk to @ghost today');
  });

  it('resolves [[Page]] to @[page:id]', () => {
    expect(resolveMentionText('see [[Roadmap]]', resolvers)).toBe('see @[page:p-road]');
    expect(resolveMentionText('see [[Missing]]', resolvers)).toBe('see [[Missing]]');
  });

  it('leaves existing tokens untouched', () => {
    expect(resolveMentionText('@[user:u-maya] said hi', resolvers)).toBe('@[user:u-maya] said hi');
  });

  it('resolves [[Title]] to pages first, then records', () => {
    const r = {
      resolvePage: (t: string) => (t === 'Shared' ? 'p-1' : undefined),
      resolveRecord: (t: string) => (t === 'Shared' || t === 'Maya Person' ? 'r-9' : undefined),
    };
    expect(resolveMentionText('see [[Shared]]', r)).toBe('see @[page:p-1]'); // page wins
    expect(resolveMentionText('see [[Maya Person]]', r)).toBe('see @[rec:r-9]'); // falls through to record
    expect(resolveMentionText('see [[Nobody]]', r)).toBe('see [[Nobody]]');
  });

  it('passes existing @[rec:] tokens through untouched', () => {
    expect(resolveMentionText('ping @[rec:r-9] now', resolvers)).toBe('ping @[rec:r-9] now');
  });
});

describe('record mentions', () => {
  it('renderMentionText renders @[rec:] as [[title]] via recordTitle', () => {
    const r = { recordTitle: (id: string) => (id === 'r-9' ? 'Maya Person' : undefined) };
    expect(renderMentionText('ask @[rec:r-9]', r)).toBe('ask [[Maya Person]]');
    // Missing/deleted record titles stay opaque tokens so read/edit cannot
    // erase the reference or disclose a deleted title.
    expect(renderMentionText('ask @[rec:r-x]', r)).toBe('ask @[rec:r-x]');
    expect(resolveMentionText(renderMentionText('ask @[rec:r-x]', r), r)).toBe('ask @[rec:r-x]');
  });
});

describe('drive embeds in markdown', () => {
  it('a lone Google Drive URL becomes an embed block', () => {
    const blocks = markdownToBlocks('check this\nhttps://drive.google.com/file/d/AbC-123/view?usp=sharing');
    expect(blocks).toEqual([
      { type: 'p', text: 'check this' },
      { type: 'embed', url: 'https://drive.google.com/file/d/AbC-123/view?usp=sharing', provider: 'gdrive' },
    ]);
  });

  it('docs.google.com URLs embed too; non-drive URLs stay paragraphs', () => {
    const [doc, link] = markdownToBlocks('https://docs.google.com/document/d/D1/edit\nhttps://example.com/page');
    expect(doc).toMatchObject({ type: 'embed', provider: 'gdrive' });
    expect(link).toMatchObject({ type: 'p', text: 'https://example.com/page' });
  });

  it('blocksToMarkdown renders an embed back to its bare URL (round-trip)', () => {
    const url = 'https://drive.google.com/file/d/AbC-123/view';
    const md = blocksToMarkdown([{ type: 'embed', url }]);
    expect(md).toBe(url);
    const [again] = markdownToBlocks(md);
    expect(again).toMatchObject({ type: 'embed', url, provider: 'gdrive' });
  });
});

describe('blocksToMarkdown', () => {
  const resolvers = { userName: (id: string) => (id === 'u1' ? 'Maya' : undefined), pageTitle: (id: string) => (id === 'p1' ? 'Spec' : undefined) };

  it('renders round-trippable markdown', () => {
    const md = blocksToMarkdown(
      [
        { type: 'h1', text: 'Title' },
        { type: 'p', text: 'hi @[user:u1] see @[page:p1]' },
        { type: 'todo', text: 'x', checked: true },
        { type: 'numbered', text: 'one' },
        { type: 'numbered', text: 'two' },
      ],
      resolvers,
    );
    expect(md).toContain('# Title');
    expect(md).toContain('hi @Maya see [[Spec]]');
    expect(md).toContain('- [x] x');
    expect(md).toContain('1. one');
    expect(md).toContain('2. two');
  });

  it('renders tasks embed + file blocks legibly', () => {
    const md = blocksToMarkdown([{ type: 'tasks', boardId: 'b1' }, { type: 'image', fileId: 'f9', caption: 'shot' }]);
    expect(md).toContain('task list: b1');
    expect(md).toContain('![shot](file:f9)');
  });

  it('renderMentionText degrades gracefully without resolvers', () => {
    expect(renderMentionText('@[user:x] @[page:y]', {})).toBe('@user [[page]]');
  });
});
