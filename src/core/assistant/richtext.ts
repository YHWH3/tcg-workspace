/* Markdown-lite for assistant replies — a pure parser into a tiny AST that the
 * panel renders with React elements (never innerHTML). Model output and record
 * text are untrusted: no raw HTML, no images, no external links. Supported:
 * paragraphs, line breaks, `-`/`*`/`•` bullets, `1.` numbered lists, `#`
 * headings, ``` fenced code, **bold**, `inline code`, and stored mention
 * tokens (`@[page:ID]` etc.) which render as internal chips. */
import { parseText, type MentionKind } from '../mentions';

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'b'; v: string }
  | { t: 'code'; v: string }
  | { t: 'mention'; kind: MentionKind; id: string };

export type RichBlock =
  | { t: 'p'; lines: Inline[][] }
  | { t: 'h'; inl: Inline[] }
  | { t: 'ul' | 'ol'; items: Inline[][] }
  | { t: 'code'; text: string };

const INLINE_RE = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  for (const node of parseText(s)) {
    if (node.t === 'chip') {
      out.push({ t: 'mention', kind: node.kind, id: node.id });
      continue;
    }
    let last = 0;
    for (const m of node.v.matchAll(INLINE_RE)) {
      const i = m.index ?? 0;
      if (i > last) out.push({ t: 'text', v: node.v.slice(last, i) });
      const tok = m[0];
      out.push(tok.startsWith('**') ? { t: 'b', v: tok.slice(2, -2) } : { t: 'code', v: tok.slice(1, -1) });
      last = i + tok.length;
    }
    if (last < node.v.length) out.push({ t: 'text', v: node.v.slice(last) });
  }
  // Merge adjacent text runs for stable rendering.
  return out.reduce<Inline[]>((acc, n) => {
    const prev = acc[acc.length - 1];
    if (n.t === 'text' && prev?.t === 'text') acc[acc.length - 1] = { t: 'text', v: prev.v + n.v };
    else if (!(n.t === 'text' && n.v === '')) acc.push(n);
    return acc;
  }, []);
}

const BULLET = /^\s{0,3}[-*•]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const FENCE = /^\s{0,3}```/;

export function parseRich(text: string): RichBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: RichBlock[] = [];
  let para: Inline[][] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ t: 'p', lines: para });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flushPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      blocks.push({ t: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flushPara();
      blocks.push({ t: 'h', inl: parseInline(h[1]) });
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    if (b || n) {
      flushPara();
      const kind = b ? 'ul' : 'ol';
      const item = parseInline((b ?? n)![1]);
      const prev = blocks[blocks.length - 1];
      if (prev && prev.t === kind) prev.items.push(item);
      else blocks.push({ t: kind, items: [item] });
      continue;
    }
    para.push(parseInline(line));
  }
  flushPara();
  return blocks;
}
