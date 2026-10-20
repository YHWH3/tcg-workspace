import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router';
import { AtSign, FilePlus2 } from 'lucide-react';
import { db } from '../../core/db';
import { authStore } from '../../core/auth';
import { Avatar } from '../../core/ui';
import { resolveUser, useUsers } from '../../core/users';
import { cn } from '../../core/utils';
import { chipToken, parseText, type MentionKind } from '../../core/mentions';
import { mutate } from '../../core/sync/engine';
import { createPage, type PageRow } from './api';

/** Handle exposed to BlockEditor: serialized-text caret ops, mention insertion. */
export interface RichHandle {
  el(): HTMLElement | null;
  /** Serialized caret offset, or -1 when the selection isn't inside. */
  caret(): number;
  /** Serialized text of the current DOM. */
  text(): string;
  /** Focus and place the caret at a serialized offset (defaults to end). */
  focus(pos?: number): void;
  /** Replace the current `@query` range with a chip + trailing space. */
  insertMention(kind: MentionKind, id: string): void;
}

const CHIP_CLS =
  'mx-px inline-block rounded-md bg-blue-50 px-1 py-px text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 select-none align-baseline';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function chipHtml(kind: MentionKind, id: string, label: string): string {
  const label2 = label || (kind === 'user' ? 'someone' : 'Untitled');
  return `<span class="mention ${CHIP_CLS}" contenteditable="false" data-mk="${kind}" data-mid="${id}">${kind === 'user' ? '@' : ''}${esc(label2)}</span>`;
}

/** Serialize a DOM node tree back to token text. Chips → tokens, <br> → \n. */
export function serializeDom(node: Node): string {
  let out = '';
  node.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? '';
    else {
      const el = n as HTMLElement;
      if (el.dataset?.mk) out += chipToken(el.dataset.mk as MentionKind, el.dataset.mid ?? '');
      else if (el.tagName === 'BR') out += '\n';
      else out += serializeDom(n);
    }
  });
  return out;
}

/** Serialized offset of the selection anchor inside `root` (-1 when outside). */
function caretOffset(root: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) return -1;
  const range = sel.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  return serializeDom(pre.cloneContents()).length;
}

/**
 * DOM position (container + offset for Range.setStart) at a serialized text
 * offset. Text nodes contribute their length; chips contribute their token
 * length and snap the position to before/after the chip element.
 */
function domPosAt(root: HTMLElement, offset: number): { node: Node; off: number } {
  let pos = 0;
  let lastText: Text | null = null;
  const walk = (parent: Node): { node: Node; off: number } | null => {
    for (const n of parent.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        const t = n as Text;
        lastText = t;
        const len = t.length;
        if (offset <= pos + len) return { node: t, off: offset - pos };
        pos += len;
      } else {
        const el = n as HTMLElement;
        if (el.dataset?.mk) {
          const len = chipToken(el.dataset.mk as MentionKind, el.dataset.mid ?? '').length;
          if (offset < pos + len) return offset - pos <= len / 2 ? { node: parent, off: [...parent.childNodes].indexOf(n) } : { node: parent, off: [...parent.childNodes].indexOf(n) + 1 };
          pos += len;
        } else if (el.tagName === 'BR') {
          if (offset <= pos + 1) return { node: parent, off: [...parent.childNodes].indexOf(n) };
          pos += 1;
        } else {
          const r = walk(n);
          if (r) return r;
        }
      }
    }
    return null;
  };
  return walk(root) ?? { node: lastText ?? root, off: lastText ? (lastText as Text).length : 0 };
}

interface MentionSession {
  /** Serialized offset of the '@'. */
  at: number;
  query: string;
}

export const RichInput = forwardRef<
  RichHandle,
  {
    value: string;
    onChange: (s: string) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    onPasteFiles?: (files: FileList) => void;
    className?: string;
    placeholder?: string;
    'data-block'?: boolean;
    disabled?: boolean;
  }
>(function RichInput(props, ref) {
  const edRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const mention = useRef<MentionSession | null>(null);
  const [menu, setMenu] = useState<{ query: string } | null>(null);
  const [menuSel, setMenuSel] = useState(0);
  const users = useUsers();
  const me = authStore.get().user;
  const nav = useNavigate();
  const pages = useLiveQuery(() => db.pages.toArray(), [], []) ?? [];

  const recs = useLiveQuery(() => db.tasks.toArray(), [], []) ?? [];

  const resolve = useCallback(
    (kind: MentionKind, id: string): string | undefined => {
      if (kind === 'user') return resolveUser(id, users, me)?.name;
      if (kind === 'rec') {
        const t = recs.find((x) => x.id === id);
        return t ? String(t.title ?? '') || 'Untitled' : undefined;
      }
      const p = pages.find((x) => x.id === id) as PageRow | undefined;
      return p ? String(p.title ?? '') || 'Untitled' : undefined;
    },
    [users, me, pages, recs],
  );

  const buildHtml = useCallback(
    (value: string) =>
      parseText(value)
        .map((n) => (n.t === 'text' ? esc(n.v).replace(/\n/g, '<br>') : chipHtml(n.kind, n.id, resolve(n.kind, n.id) ?? '')))
        .join(''),
    [resolve],
  );

  // Fill DOM when the text changes (mount, remote edits, type changes like
  // the markdown shortcuts resetting to ''). While composing (IME) the DOM
  // is the source of truth and must not be rebuilt.
  useEffect(() => {
    const el = edRef.current;
    if (!el) return;
    if (!composing.current && serializeDom(el) !== props.value) {
      const focused = document.activeElement === el;
      el.innerHTML = buildHtml(props.value);
      if (focused) setCaret(props.value.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);

  // Chip labels resolve live: renames propagate without touching the text.
  useEffect(() => {
    const el = edRef.current;
    if (!el) return;
    el.querySelectorAll<HTMLElement>('.mention').forEach((chip) => {
      const kind = chip.dataset.mk as MentionKind;
      const label = resolve(kind, chip.dataset.mid ?? '');
      const next = `${kind === 'user' ? '@' : ''}${label ?? (kind === 'user' ? 'someone' : 'Untitled')}`;
      if (chip.textContent !== next) chip.textContent = next;
    });
  }, [resolve]);

  const setCaret = useCallback((offset: number) => {
    const el = edRef.current;
    if (!el) return;
    const sel = window.getSelection();
    if (!sel) return;
    const p = domPosAt(el, offset);
    const range = document.createRange();
    range.setStart(p.node, p.off);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }, []);

  const closeMention = useCallback(() => {
    mention.current = null;
    setMenu(null);
  }, []);

  const emitChange = useCallback(() => {
    const el = edRef.current;
    if (!el) return;
    const s = serializeDom(el);
    // Track the @-session: it lives until the caret leaves the query span or
    // the query gains a character that can't be part of a lookup.
    if (mention.current) {
      const c = caretOffset(el);
      const m = mention.current;
      const q = c > m.at ? s.slice(m.at + 1, c) : null;
      if (q === null || c === m.at || !/^[\p{L}\p{N}_ .\-()]*$/u.test(q)) {
        mention.current = null;
        setMenu(null);
      } else {
        m.query = q;
        setMenu({ query: q });
      }
    }
    props.onChange(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handle = useMemo<RichHandle>(
    () => ({
      el: () => edRef.current,
      caret: () => (edRef.current ? caretOffset(edRef.current) : -1),
      text: () => (edRef.current ? serializeDom(edRef.current) : ''),
      focus: (pos?: number) => {
        const el = edRef.current;
        if (!el) return;
        el.focus();
        setCaret(pos ?? serializeDom(el).length);
      },
      insertMention: (kind, id) => {
        const el = edRef.current;
        const m = mention.current;
        if (!el || !m) return;
        const end = caretOffset(el);
        const startP = domPosAt(el, m.at);
        const endP = domPosAt(el, end);
        const range = document.createRange();
        range.setStart(startP.node, startP.off);
        range.setEnd(endP.node, endP.off);
        range.deleteContents();
        const chip = document.createElement('span');
        chip.className = `mention ${CHIP_CLS}`;
        chip.contentEditable = 'false';
        chip.dataset.mk = kind;
        chip.dataset.mid = id;
        chip.textContent = `${kind === 'user' ? '@' : ''}${resolve(kind, id) ?? ''}`;
        range.insertNode(chip);
        chip.after(' ');
        const sel = window.getSelection();
        sel?.collapse(chip.nextSibling ?? chip, 1);
        closeMention();
        emitChange();
      },
    }),
    [closeMention, emitChange, resolve, setCaret],
  );
  useImperativeHandle(ref, () => handle, [handle]);

  /* ---------- mention picker data ---------- */
  const hits = useMemo(() => {
    if (!menu) return [];
    const q = menu.query.trim().toLowerCase();
    const livePages = (pages as PageRow[]).filter((p) => !p.deleted);
    const ph = livePages.filter((p) => !q || String(p.title ?? '').toLowerCase().includes(q)).slice(0, 5).map((p) => ({ kind: 'page' as const, id: p.id, label: String(p.title ?? '') || 'Untitled', icon: String(p.icon ?? '📄') }));
    const uh = users.filter((u) => !q || u.name.toLowerCase().includes(q) || u.username.includes(q)).slice(0, 4).map((u) => ({ kind: 'user' as const, id: u.id, label: u.name, user: u }));
    return [...ph, ...uh];
  }, [menu, pages, users]);
  const createLabel = menu?.query.trim() ?? '';
  const rowCount = hits.length + (menu ? 1 : 0);

  const pickMention = (kind: MentionKind, id: string) => handle.insertMention(kind, id);
  const pickCreate = async () => {
    const id = await createPage(null);
    const q = menu?.query.trim();
    if (q) await mutate('pages', id, { title: q });
    handle.insertMention('page', id);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (composing.current) return;
    if (menu && rowCount > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenuSel((s) => (s + 1) % rowCount);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuSel((s) => (s - 1 + rowCount) % rowCount);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const i = menuSel % rowCount;
        if (i < hits.length) pickMention(hits[i].kind, hits[i].id);
        else void pickCreate();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMention();
        return;
      }
    }
    // Backspace immediately after a chip deletes the whole chip (chips are
    // atomic — the serialized text before the caret ends with a token).
    if (e.key === 'Backspace') {
      const el = edRef.current;
      if (el) {
        const c = caretOffset(el);
        const s = serializeDom(el);
        if (c > 0 && /@\[(page|user):[A-Za-z0-9_-]{1,64}\]$/.test(s.slice(0, c))) {
          const p = domPosAt(el, c);
          const prevNode =
            p.node === el && p.off > 0
              ? p.node.childNodes[p.off - 1]
              : p.node.nodeType === Node.TEXT_NODE && p.off === 0
                ? p.node.previousSibling
                : p.node === el
                  ? p.node.childNodes[p.off - 1] ?? null
                  : null;
          if (prevNode instanceof HTMLElement && prevNode.classList.contains('mention')) {
            e.preventDefault();
            prevNode.remove();
            emitChange();
            return;
          }
        }
      }
    }
    props.onKeyDown?.(e);
  };

  return (
    <div className="relative">
      <div
        ref={edRef}
        contentEditable={!props.disabled}
        role="textbox"
        aria-label={props.placeholder || "Block content"}
        aria-multiline="true"
        spellCheck={false}
        suppressContentEditableWarning
        data-block={props['data-block']}
        className={cn('min-w-0 whitespace-pre-wrap break-words outline-none empty:before:content-none', props.className)}
        onInput={(e) => {
          if (composing.current) return;
          const ne = e.nativeEvent as InputEvent;
          if (ne.inputType === 'insertText' && ne.data === '@' && !mention.current) {
            const c = caretOffset(edRef.current!);
            mention.current = { at: c - 1, query: '' };
            setMenu({ query: '' });
            setMenuSel(0);
          }
          emitChange();
        }}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => {
          composing.current = false;
          emitChange();
        }}
        onKeyDown={handleKey}
        onClick={(e) => {
          // Page chips navigate; user chips are inert.
          const chip = (e.target as HTMLElement).closest?.('.mention') as HTMLElement | null;
          if (chip?.dataset.mk === 'page' && chip.dataset.mid) {
            e.preventDefault();
            nav(`/pages/${chip.dataset.mid}`);
          }
        }}
        onFocus={props.onFocus}
        onBlur={() => {
          closeMention();
          props.onBlur?.();
        }}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault();
            props.onPasteFiles?.(e.clipboardData.files);
            return;
          }
          // Plain text only — chips can't be pasted as rich HTML.
          e.preventDefault();
          const text = e.clipboardData.getData('text/plain');
          if (text) document.execCommand('insertText', false, text.replace(/\r\n?/g, '\n'));
        }}
      />
      {props.value === '' && props.placeholder && (
        <span className="pointer-events-none absolute left-0 top-0 select-none text-neutral-300 dark:text-neutral-600">{props.placeholder}</span>
      )}
      {menu && (
        <div className="absolute left-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-xl border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900" data-mention-menu>
          {hits.map((h, i) => (
            <button
              key={`${h.kind}:${h.id}`}
              className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm', i === menuSel % Math.max(rowCount, 1) && 'bg-neutral-100 dark:bg-neutral-800')}
              onMouseDown={(e) => {
                e.preventDefault();
                pickMention(h.kind, h.id);
              }}
              onMouseEnter={() => setMenuSel(i)}
            >
              {h.kind === 'page' ? <span className="text-base leading-none">{h.icon}</span> : <Avatar name={h.label} color={h.user?.color} size={20} />}
              <span className="min-w-0 flex-1 truncate">{h.label}</span>
              <span className="text-[10px] uppercase tracking-wide text-neutral-400">{h.kind}</span>
            </button>
          ))}
          <button
            className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-neutral-500 dark:text-neutral-400', menuSel % Math.max(rowCount, 1) === hits.length && 'bg-neutral-100 dark:bg-neutral-800')}
            onMouseDown={(e) => {
              e.preventDefault();
              void pickCreate();
            }}
            onMouseEnter={() => setMenuSel(hits.length)}
          >
            <FilePlus2 size={15} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">Create page “{createLabel || 'Untitled'}”</span>
          </button>
          {hits.length === 0 && !createLabel && (
            <p className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-neutral-400">
              <AtSign size={12} /> Type to search pages and people
            </p>
          )}
        </div>
      )}
    </div>
  );
});
