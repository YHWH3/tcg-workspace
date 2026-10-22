/* Floating "Ask AI" menu for a text selection inside one page block.
 *
 * Publishes the selection (token-serialized, the same form block text is
 * stored in) to the assistant context registry so Ctrl/Cmd+J offers it as the
 * single chip — the keyboard path to every selection action. Pointer users get
 * a small toolbar next to the selection; it keeps the editor selection alive
 * (mousedown is prevented) and never covers the selected text. */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles } from 'lucide-react';
import { actionsFor } from '../../../shared/aiActions';
import { MAX_SELECTION_CHARS } from '../../../shared/assistantProtocol';
import { ProviderDisclosure } from '../../core/assistant/AskAiMenu';
import { ensureProviders, openAssistant, setAssistantSelection } from '../../core/assistant/store';
import { serializeDom } from './RichInput';

interface Snap {
  text: string;
  blockId: string;
  rect: { top: number; bottom: number; left: number };
}

function readSelection(container: HTMLElement): Snap | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const el = (n: Node) => (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement);
  const start = el(range.startContainer);
  const end = el(range.endContainer);
  if (!start || !end || !container.contains(start)) return null;
  const box = start.closest<HTMLElement>('[role="textbox"][contenteditable]');
  if (!box || !box.contains(end)) return null; // single block only
  const block = box.closest<HTMLElement>('[data-block-id]');
  if (!block?.dataset.blockId || !container.contains(block)) return null;
  const text = serializeDom(range.cloneContents());
  if (!text.trim()) return null;
  const r = range.getBoundingClientRect();
  return { text, blockId: block.dataset.blockId, rect: { top: r.top, bottom: r.bottom, left: r.left } };
}

export function SelectionAskAi({ pageId, container }: { pageId: string; container: React.RefObject<HTMLElement | null> }) {
  const [snap, setSnap] = useState<Snap | null>(null);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  openRef.current = open;
  /** A tap on the toolbar may collapse the editor selection before click fires. */
  const pressing = useRef(false);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const root = container.current;
        if (!root) return;
        // While our menu is open/focused the editor selection may collapse; keep the snapshot.
        if (openRef.current || pressing.current || menuRef.current?.contains(document.activeElement)) return;
        const next = readSelection(root);
        setSnap(next);
        // Over-limit selections are never published (Ctrl/Cmd+J would attach a
        // truncated copy that could not be applied safely).
        setAssistantSelection(next && next.text.length <= MAX_SELECTION_CHARS ? { kind: 'selection', text: next.text, pageId, blockId: next.blockId } : null);
      });
    };
    document.addEventListener('selectionchange', update);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('selectionchange', update);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      setAssistantSelection(null);
    };
  }, [container, pageId]);

  useEffect(() => {
    if (!open) return;
    void ensureProviders();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  if (!snap) return null;
  const tooLong = snap.text.length > MAX_SELECTION_CHARS;
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  // Touch: native selection callouts sit above the text, so go below it.
  const below = coarse || snap.rect.top < 64;
  const top = below ? snap.rect.bottom + 8 : snap.rect.top - 48;
  const left = Math.max(8, Math.min(snap.rect.left, window.innerWidth - 296));
  const pick = (actionId?: string) => {
    setOpen(false);
    const ref = { kind: 'selection' as const, text: snap.text, pageId, blockId: snap.blockId };
    openAssistant({ context: [ref], actionId });
  };
  const item = 'flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-neutral-400 dark:hover:bg-neutral-800';
  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-40"
      style={{ top, left }}
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={() => {
        pressing.current = true;
        // Safety net when no click follows (pointer dragged away).
        setTimeout(() => {
          pressing.current = false;
        }, 800);
      }}
      onClickCapture={() => {
        setTimeout(() => {
          pressing.current = false;
        }, 0);
      }}
      onPointerCancel={() => {
        pressing.current = false;
      }}
    >
      <button
        type="button"
        data-testid="ask-ai-selection"
        aria-haspopup="true"
        aria-expanded={open}
        aria-keyshortcuts="Control+J Meta+J"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium shadow-lg hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      >
        <Sparkles size={15} className="text-violet-500" aria-hidden="true" /> Ask AI
      </button>
      {open && (
        <div role="group" aria-label="AI actions for the selection" className="anim-slide-up mt-1 w-72 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
          {tooLong ? (
            <p className="p-2 text-xs text-neutral-600 dark:text-neutral-300">Selection is too long for AI actions (max {MAX_SELECTION_CHARS.toLocaleString()} characters). Select less text.</p>
          ) : (
            actionsFor('selection').map((a) => (
              <button key={a.id} type="button" data-testid={`ask-ai-action-${a.id}`} className={item} onClick={() => pick(a.id)}>
                <Sparkles size={13} className="shrink-0 text-violet-500" aria-hidden="true" />
                <span className="min-w-0 flex-1">{a.label}</span>
              </button>
            ))
          )}
          <ProviderDisclosure className="px-2.5 pb-1 pt-1.5" />
        </div>
      )}
    </div>,
    document.body,
  );
}
