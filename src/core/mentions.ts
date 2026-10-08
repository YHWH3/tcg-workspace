/**
 * Inline mention chips in block text. Stored text keeps tokens
 * `@[page:ID]` / `@[user:ID]`; titles and names resolve live at render so
 * renames propagate. All functions here are pure (unit-tested); the DOM glue
 * for contentEditable lives in `modules/pages/RichInput.tsx`.
 */
export type MentionKind = 'page' | 'user' | 'rec';

export interface InlineText {
  t: 'text';
  v: string;
}
export interface InlineChip {
  t: 'chip';
  kind: MentionKind;
  id: string;
}
export type InlineNode = InlineText | InlineChip;

const TOKEN_RE = /@\[(page|user|rec):([A-Za-z0-9_-]{1,64})\]/g;

/** Stored text → inline nodes (chips become atomic units). */
export function parseText(s: string): InlineNode[] {
  const out: InlineNode[] = [];
  let last = 0;
  for (const m of s.matchAll(TOKEN_RE)) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    out.push({ t: 'chip', kind: m[1] as MentionKind, id: m[2] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}

/** Inline nodes → stored text. */
export function serialize(nodes: InlineNode[]): string {
  return nodes.map((n) => (n.t === 'text' ? n.v : `@[${n.kind}:${n.id}]`)).join('');
}

export function chipToken(kind: MentionKind, id: string): string {
  return `@[${kind}:${id}]`;
}

/** Mention tokens present in a stored string (for activity diffing, backlinks). */
export function mentionTokens(s: string): { kind: MentionKind; id: string }[] {
  const out: { kind: MentionKind; id: string }[] = [];
  for (const m of s.matchAll(TOKEN_RE)) out.push({ kind: m[1] as MentionKind, id: m[2] });
  return out;
}

/** Render stored text with tokens resolved to display names (⌘K, backlinks, tasks). */
export function renderPlain(s: string, resolve: (kind: MentionKind, id: string) => string | undefined): string {
  return s.replace(TOKEN_RE, (_tok, kind: string, id: string) => {
    const name = resolve(kind as MentionKind, id);
    if (name) return name;
    return kind === 'user' ? '@someone' : '@page';
  });
}

/**
 * Map a position inside the serialized string to a (node index, char offset)
 * pair over the node list — used to place the caret after DOM edits. A caret
 * inside a chip snaps to its nearest edge (chips are atomic).
 */
export function textOffsetToDom(nodes: InlineNode[], offset: number): { index: number; char: number } {
  let pos = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const len = n.t === 'text' ? n.v.length : chipToken(n.kind, n.id).length;
    if (offset <= pos + len) {
      if (n.t === 'text') return { index: i, char: offset - pos };
      return offset - pos <= len / 2 ? { index: i, char: 0 } : { index: i + 1, char: 0 };
    }
    pos += len;
  }
  return { index: nodes.length, char: 0 };
}

/**
 * Map a (node index, char offset) pair back to a serialized offset. A DOM
 * position inside a chip counts as "after the chip" (its full token length).
 */
export function domToTextOffset(nodes: InlineNode[], index: number, char: number): number {
  let pos = 0;
  for (let i = 0; i < Math.min(index, nodes.length); i++) {
    const n = nodes[i];
    pos += n.t === 'text' ? n.v.length : chipToken(n.kind, n.id).length;
  }
  const cur = nodes[index];
  if (!cur) return pos;
  if (cur.t === 'text') return pos + Math.min(char, cur.v.length);
  return char > 0 ? pos + chipToken(cur.kind, cur.id).length : pos;
}
