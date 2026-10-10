/* Pure markdown ⇄ block-list converter, shared by the MCP server and tests.
 * Block type ids match the editor registry: p, h1, h2, h3, bullet, numbered,
 * todo, quote, code, divider — plus `image` carrying a `src` the CALLER must
 * resolve to a fileId before storing. A line that is only a Google Drive/Docs
 * URL becomes an `embed` block {url, provider:'gdrive'} (Phase 1 §4.7). */

import { parseLinkUrl } from './drive';

export interface MdBlock {
  type: string;
  text?: string;
  checked?: boolean;
  /** Image URL marker — callers resolve to `fileId` before writing records. */
  src?: string;
  caption?: string;
  /** Embed blocks: the original external URL + provider. */
  url?: string;
  provider?: 'gdrive' | 'link';
}

export interface MentionResolvers {
  /** Resolve a @-handle or display name to a user id; undefined = no unique match. */
  resolveUser?: (handle: string) => string | undefined;
  /** Resolve a [[page title]] to a page id; undefined = no unique match. */
  resolvePage?: (title: string) => string | undefined;
  /** Resolve a [[record title]] to a record id — tried AFTER resolvePage (Phase 1 §3.6). */
  resolveRecord?: (title: string) => string | undefined;
  /** For blocksToMarkdown: user id → display name. */
  userName?: (id: string) => string | undefined;
  /** For blocksToMarkdown: page id → title. */
  pageTitle?: (id: string) => string | undefined;
  /** For blocksToMarkdown: record id → title. */
  recordTitle?: (id: string) => string | undefined;
}

const TOKEN_RE = /@\[(page|user|rec):([^\]]+)\]/g;
const AT_MENTION_RE = /@([a-z0-9_.-]{2,32})/gi;
const WIKI_RE = /\[\[([^\]]+)\]\]/g;

/** Replace plain-text mention syntax with stored tokens where they resolve uniquely. */
export function resolveMentionText(text: string, r: MentionResolvers): string {
  // 1. [[Title]] → @[page:ID], then @[rec:ID] — pages resolve first (Phase 1 §3.6).
  text = text.replace(WIKI_RE, (m, title: string) => {
    const t = title.trim();
    const pageId = r.resolvePage?.(t);
    if (pageId) return `@[page:${pageId}]`;
    const recId = r.resolveRecord?.(t);
    return recId ? `@[rec:${recId}]` : m;
  });
  // 2. @handle → @[user:ID] — skip when already a token (@ is followed by '[' there).
  text = text.replace(AT_MENTION_RE, (m, handle: string, off: number) => {
    if (text[off + m.length] === ':' || text[off + 1] === '[') return m;
    const id = r.resolveUser?.(handle);
    return id ? `@[user:${id}]` : m;
  });
  return text;
}

const NUM_RE = /^\d+\.\s+/;

/** Markdown → block descriptors. Blank lines separate blocks; unknown lines → paragraphs. */
export function markdownToBlocks(markdown: string, resolvers: MentionResolvers = {}): MdBlock[] {
  const out: MdBlock[] = [];
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const p = (text: string) => ({ type: 'p', text: resolveMentionText(text, resolvers) });
  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      out.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      out.push({ type: 'divider' });
      i++;
      continue;
    }
    const img = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line.trim());
    if (img) {
      out.push({ type: 'image', caption: img[1] || undefined, src: img[2] });
      i++;
      continue;
    }
    // A line that is only a Google Drive/Docs URL becomes an embed block.
    const lone = /^\S+$/.test(line.trim()) ? parseLinkUrl(line.trim()) : null;
    if (lone?.provider === 'gdrive') {
      out.push({ type: 'embed', url: lone.url, provider: 'gdrive' });
      i++;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ type: `h${h[1].length}`, text: resolveMentionText(h[2], resolvers) });
      i++;
      continue;
    }
    const todo = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (todo) {
      out.push({ type: 'todo', text: resolveMentionText(todo[2], resolvers), checked: todo[1] !== ' ' });
      i++;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      out.push({ type: 'bullet', text: resolveMentionText(line.replace(/^[-*]\s+/, ''), resolvers) });
      i++;
      continue;
    }
    if (NUM_RE.test(line)) {
      out.push({ type: 'numbered', text: resolveMentionText(line.replace(NUM_RE, ''), resolvers) });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      out.push({ type: 'quote', text: resolveMentionText(line.replace(/^>\s?/, ''), resolvers) });
      i++;
      continue;
    }
    out.push(p(line));
    i++;
  }
  return out;
}

/** Render stored tokens as readable markdown-ish mention syntax. */
export function renderMentionText(text: string, r: MentionResolvers): string {
  return text.replace(TOKEN_RE, (_m, kind: string, id: string) => {
    if (kind === 'user') return `@${r.userName?.(id) ?? 'user'}`;
    if (kind === 'rec') return `[[${r.recordTitle?.(id) ?? 'record'}]]`;
    return `[[${r.pageTitle?.(id) ?? 'page'}]]`;
  });
}

/** Block list → markdown. Non-text block types are noted as comments/placeholders. */
export function blocksToMarkdown(blocks: { type?: string; text?: string; checked?: boolean; boardId?: string; fileId?: string; caption?: string; url?: string }[], r: MentionResolvers = {}): string {
  const lines: string[] = [];
  let numbered = 0;
  for (const b of blocks) {
    const t = b.type ?? 'p';
    const text = renderMentionText(String(b.text ?? ''), r);
    numbered = t === 'numbered' ? numbered + 1 : 0;
    switch (t) {
      case 'h1':
      case 'h2':
      case 'h3':
        lines.push(`${'#'.repeat(Number(t[1]))} ${text}`);
        break;
      case 'bullet':
        lines.push(`- ${text}`);
        break;
      case 'numbered':
        lines.push(`${numbered}. ${text}`);
        break;
      case 'todo':
        lines.push(`- [${b.checked ? 'x' : ' '}] ${text}`);
        break;
      case 'quote':
        lines.push(`> ${text}`);
        break;
      case 'code':
        lines.push('```', text, '```');
        break;
      case 'divider':
        lines.push('---');
        break;
      case 'image':
      case 'video':
      case 'audio':
        lines.push(`![${b.caption ?? t}](${b.fileId ? `file:${b.fileId}` : ''})`);
        break;
      case 'file':
        lines.push(`[${b.caption ?? 'file'}](${b.fileId ? `file:${b.fileId}` : ''})`);
        break;
      case 'tasks':
        lines.push(`*[task list: ${b.boardId ?? 'board'}]*`);
        break;
      case 'embed':
        // Bare URL on its own line round-trips through markdownToBlocks.
        lines.push(b.url ?? '');
        break;
      default:
        lines.push(text);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
