import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowDown, ArrowUp, GripVertical, MessageSquare, Trash2 } from 'lucide-react';
import { db, type LocalRow } from '../../core/db';
import { logActivity } from '../../core/activity';
import { openCommentThread } from '../../core/commentui';
import { addFile } from '../../core/files';
import { mentionTokens } from '../../core/mentions';
import { mutate } from '../../core/sync/engine';
import { IconButton, Menu, Popover } from '../../core/ui';
import { cn, cmpOrder, debounce, orderBetween, uuid } from '../../core/utils';
import { blockRenderer, insertEntries } from './blocks/registry';
import { RichInput, type RichHandle } from './RichInput';
import { modules } from '..';
import { Slot } from '../slots';

export const BLOCK_TYPES = [
  { id: 'p', label: 'Text' },
  { id: 'h1', label: 'Heading 1' },
  { id: 'h2', label: 'Heading 2' },
  { id: 'h3', label: 'Heading 3' },
  { id: 'bullet', label: 'Bullet list' },
  { id: 'numbered', label: 'Numbered list' },
  { id: 'todo', label: 'To-do' },
  { id: 'quote', label: 'Quote' },
  { id: 'code', label: 'Code' },
  { id: 'divider', label: 'Divider' },
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number]['id'];

export interface BlockRow extends LocalRow {
  pageId?: string;
  order?: string;
  /** Built-in text types (see BLOCK_TYPES) plus registered media types (image/video/audio/file/tasks…). */
  type?: string;
  text?: string;
  checked?: boolean;
  fileId?: string;
  caption?: string;
  boardId?: string;
  deleted?: boolean;
}

function blockTypeForFile(mime: string): string {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

const MD_PATTERNS: [RegExp, BlockType][] = [
  [/^# $/, 'h1'],
  [/^## $/, 'h2'],
  [/^### $/, 'h3'],
  [/^[-*] $/, 'bullet'],
  [/^\d+\. $/, 'numbered'],
  [/^\[\] $/, 'todo'],
  [/^\[ \] $/, 'todo'],
  [/^> $/, 'quote'],
  [/^```$/, 'code'],
];

const TEXT_CLS: Record<string, string> = {
  p: 'text-[15px] leading-7',
  h1: 'text-2xl font-bold leading-9 mt-2',
  h2: 'text-xl font-semibold leading-8 mt-2',
  h3: 'text-base font-semibold leading-7 mt-1',
  bullet: 'text-[15px] leading-7',
  numbered: 'text-[15px] leading-7',
  todo: 'text-[15px] leading-7',
  quote: 'text-[15px] leading-7 italic text-neutral-600 dark:text-neutral-300',
  code: 'text-[13px] leading-6 font-mono',
};

const byOrder = (a: BlockRow, b: BlockRow) => cmpOrder(a.order, b.order);

interface FocusReq {
  id: string;
  pos: number;
}

export function BlockEditor({ pageId }: { pageId: string }) {
  const raw = useLiveQuery(() => db.blocks.where('pageId').equals(pageId).toArray(), [pageId], []);
  const blocks = useMemo(() => ((raw ?? []) as BlockRow[]).filter((b) => !b.deleted).sort(byOrder), [raw]);
  const refs = useRef(new Map<string, RichHandle>());
  const pendingText = useRef(new Map<string, string>());
  const debouncers = useRef(new Map<string, ReturnType<typeof debounce<[string]>>>());
  const [focusReq, setFocusReq] = useState<FocusReq | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const flushBlock = useCallback((id: string) => {
    const d = debouncers.current.get(id);
    const text = pendingText.current.get(id);
    if (d && text !== undefined) {
      d.flush(text);
      pendingText.current.delete(id);
    }
  }, []);

  // Never lose text on unmount / navigation.
  useEffect(() => {
    const pending = pendingText.current;
    const flush = flushBlock;
    return () => {
      for (const id of [...pending.keys()]) flush(id);
    };
  }, [flushBlock]);

  useEffect(() => {
    if (!focusReq) return;
    const el = refs.current.get(focusReq.id);
    if (el) {
      el.focus(focusReq.pos);
      setFocusReq(null);
    }
  }, [focusReq, blocks]);

  const writeText = useCallback((blockId: string, text: string) => {
    pendingText.current.set(blockId, text);
    let d = debouncers.current.get(blockId);
    if (!d) {
      d = debounce((t: string) => {
        void mutate('blocks', blockId, { text: t });
      }, 300);
      debouncers.current.set(blockId, d);
    }
    d(text);
  }, []);

  const idxOf = useCallback((id: string) => blocks.findIndex((b) => b.id === id), [blocks]);

  const insertBlock = useCallback(
    async (afterIndex: number, type: string, text: string): Promise<string> => {
      const prev = blocks[afterIndex];
      const next = blocks[afterIndex + 1];
      const order = orderBetween(prev ? String(prev.order) : null, next ? String(next.order) : null);
      const id = uuid();
      await mutate('blocks', id, { pageId, order, type, text, ...(type === 'todo' ? { checked: false } : {}) });
      return id;
    },
    [blocks, pageId],
  );

  /** Files pasted/dropped into the editor become media blocks using the file pipeline. */
  const insertFiles = useCallback(
    async (afterIndex: number, files: FileList | File[]) => {
      let i = afterIndex;
      for (const f of Array.from(files)) {
        const id = await insertBlock(i, blockTypeForFile(f.type), '');
        i += 1;
        const fid = await addFile(f, { parentType: 'block', parentId: id, transcriptState: f.type.startsWith('audio/') ? 'pending' : undefined });
        await mutate('blocks', id, { fileId: fid });
      }
    },
    [insertBlock],
  );

  const splitBlock = useCallback(
    async (block: BlockRow, caret: number, currentText: string) => {
      flushBlock(block.id);
      const before = currentText.slice(0, caret);
      const after = currentText.slice(caret);
      const i = idxOf(block.id);
      // List types continue on Enter; headings/quotes/code break back to text.
      const nextType: BlockType = block.type === 'bullet' || block.type === 'numbered' || block.type === 'todo' ? block.type : 'p';
      const id = await insertBlock(i, nextType, after);
      await mutate('blocks', block.id, { text: before });
      setFocusReq({ id, pos: 0 });
    },
    [flushBlock, idxOf, insertBlock],
  );

  const mergeUp = useCallback(
    async (block: BlockRow, currentText: string) => {
      const i = idxOf(block.id);
      const prev = blocks[i - 1];
      if (!prev) return;
      flushBlock(prev.id);
      const prevText = String(prev.text ?? '');
      const joinPos = prevText.length;
      if (prev.type === 'divider') {
        await mutate('blocks', prev.id, { deleted: true });
        setFocusReq({ id: block.id, pos: 0 });
        return;
      }
      await mutate('blocks', prev.id, { text: prevText + currentText });
      await mutate('blocks', block.id, { deleted: true });
      setFocusReq({ id: prev.id, pos: joinPos });
    },
    [blocks, flushBlock, idxOf],
  );

  const moveBlock = useCallback(
    async (block: BlockRow, dir: -1 | 1) => {
      const i = idxOf(block.id);
      const j = i + dir;
      if (j < 0 || j >= blocks.length) return;
      const order =
        dir === -1
          ? orderBetween(j > 0 ? String(blocks[j - 1].order) : null, String(blocks[j].order))
          : orderBetween(String(blocks[j].order), j + 1 < blocks.length ? String(blocks[j + 1].order) : null);
      await mutate('blocks', block.id, { order });
      setFocusReq({ id: block.id, pos: refs.current.get(block.id)?.caret() ?? 0 });
    },
    [blocks, idxOf],
  );

  const dropOn = useCallback(
    async (target: BlockRow, draggedId: string) => {
      if (target.id === draggedId) return;
      const ti = idxOf(target.id);
      const next = blocks[ti + 1];
      const order = orderBetween(String(target.order), next?.id === draggedId ? String(blocks[ti + 2]?.order ?? '') || null : next ? String(next.order) : null);
      await mutate('blocks', draggedId, { order });
    },
    [blocks, idxOf],
  );

  if (raw === undefined) return null;

  const focusLastOrCreate = async () => {
    const last = blocks[blocks.length - 1];
    if (last && (last.type ?? 'p') === 'p' && !String(last.text ?? '').length) {
      setFocusReq({ id: last.id, pos: 0 });
    } else {
      const id = await insertBlock(blocks.length - 1, 'p', '');
      setFocusReq({ id, pos: 0 });
    }
  };

  return (
    <div
      className="min-h-40 pb-24"
      onClick={(e) => {
        // Click in the empty area below the blocks → focus/create last block.
        if (e.target === e.currentTarget) void focusLastOrCreate();
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          e.stopPropagation();
          void insertFiles(blocks.length - 1, e.dataTransfer.files);
        }
      }}
    >
      {blocks.length === 0 && (
        <button
          className="block w-full cursor-text rounded-md px-1 py-0.5 text-left text-[15px] leading-7 text-neutral-600 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-900/50"
          onClick={() => void focusLastOrCreate()}
          data-placeholder-block
        >
          Type &apos;/&apos; for commands
        </button>
      )}
      {blocks.map((block, i) => {
        let number = 0;
        if (block.type === 'numbered') {
          for (let k = i; k >= 0; k--) {
            if (blocks[k].type === 'numbered') number++;
            else break;
          }
        }
        return (
          <BlockItem
            key={block.id}
            block={block}
            number={number}
            dragOver={dragOver === block.id}
            onlyBlock={blocks.length === 1}
            registerRef={(el: RichHandle | null) => {
              if (el) refs.current.set(block.id, el);
              else refs.current.delete(block.id);
            }}
            onText={(text) => writeText(block.id, text)}
            onFlush={() => flushBlock(block.id)}
            onSplit={(caret, text) => void splitBlock(block, caret, text)}
            onMergeUp={(text) => void mergeUp(block, text)}
            onDelete={async () => {
              await mutate('blocks', block.id, { deleted: true });
              const prev = blocks[i - 1] ?? blocks[i + 1];
              if (prev) setFocusReq({ id: prev.id, pos: 0 });
            }}
            onMove={(dir) => void moveBlock(block, dir)}
            onFocusPrev={() => {
              const prev = blocks[i - 1];
              if (prev) setFocusReq({ id: prev.id, pos: String(prev.text ?? '').length });
            }}
            onFocusNext={() => {
              const nxt = blocks[i + 1];
              if (nxt) setFocusReq({ id: nxt.id, pos: 0 });
            }}
            onNewBelow={async () => {
              const id = await insertBlock(i, 'p', '');
              setFocusReq({ id, pos: 0 });
            }}
            onDragStart={(e) => e.dataTransfer.setData('text/block-id', block.id)}
            onDragOver={() => setDragOver(block.id)}
            onDrop={(e) => {
              setDragOver(null);
              if (e.dataTransfer.files.length) {
                e.preventDefault();
                e.stopPropagation();
                void insertFiles(i, e.dataTransfer.files);
                return;
              }
              const id = e.dataTransfer.getData('text/block-id');
              if (id) void dropOn(block, id);
            }}
            onPasteFiles={(files) => void insertFiles(i, files)}
            onChangeType={(type) => void mutate('blocks', block.id, { type, ...(type === 'todo' ? { checked: false } : {}) })}
            onToggleChecked={(checked) => void mutate('blocks', block.id, { checked })}
          />
        );
      })}
    </div>
  );
}

/* ---------- single block ---------- */

interface BlockItemProps {
  block: BlockRow;
  number: number;
  dragOver: boolean;
  onlyBlock: boolean;
  registerRef: (el: RichHandle | null) => void;
  onText: (text: string) => void;
  onFlush: () => void;
  onSplit: (caret: number, text: string) => void;
  onMergeUp: (text: string) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  onFocusPrev: () => void;
  onFocusNext: () => void;
  onNewBelow: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: () => void;
  onDrop: (e: React.DragEvent) => void;
  onPasteFiles: (files: FileList) => void;
  onChangeType: (t: string) => void;
  onToggleChecked: (checked: boolean) => void;
}

function BlockItem(props: BlockItemProps) {
  const { block } = props;
  const [val, setVal] = useState(String(block.text ?? ''));
  const [slashSel, setSlashSel] = useState(0);
  const [focused, setFocused] = useState(false);
  const taRef = useRef<RichHandle | null>(null);

  // Pull in remote changes when not focused.
  useEffect(() => {
    if (document.activeElement !== taRef.current?.el()) setVal(String(block.text ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.text]);

  const mentionDiff = (prev: string, next: string) => {
    const seen = new Set(mentionTokens(prev).filter((t) => t.kind === 'user').map((t) => t.id));
    const fresh = mentionTokens(next).filter((t) => t.kind === 'user' && !seen.has(t.id));
    if (fresh.length === 0) return;
    void (async () => {
      const page = block.pageId ? await db.pages.get(String(block.pageId)) : undefined;
      for (const t of fresh) logActivity('mentioned', 'page', String(block.pageId ?? ''), String(page?.title ?? 'page'), { userId: t.id });
    })();
  };

  const type = block.type ?? 'p';
  const slashFilter = val.startsWith('/') ? val.slice(1).toLowerCase() : null;
  const slashAll = useMemo(() => [...BLOCK_TYPES, ...insertEntries().map((e) => ({ id: e.type, label: e.label }))], []);
  const slashItems = slashFilter !== null ? slashAll.filter((t) => t.label.toLowerCase().includes(slashFilter)) : [];

  const setRef = (el: RichHandle | null) => {
    taRef.current = el;
    props.registerRef(el);
  };

  const commit = (text: string) => {
    mentionDiff(val, text);
    setVal(text);
    props.onText(text);
  };

  const handleChange = (text: string) => {
    for (const [re, t] of MD_PATTERNS) {
      if (re.test(text)) {
        props.onChangeType(t);
        commit('');
        return;
      }
    }
    commit(text);
  };

  const pickSlash = (t: string) => {
    props.onChangeType(t);
    commit('');
    setSlashSel(0);
    taRef.current?.focus(0);
  };

  if (type === 'divider') {
    return (
      <div
        className={cn('group relative flex items-center py-2', props.dragOver && 'border-t-2 border-blue-400')}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Backspace' || e.key === 'Delete') {
            e.preventDefault();
            props.onDelete();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            void props.onNewBelow();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          props.onDragOver();
        }}
        onDragLeave={() => props.onDragOver()}
        onDrop={props.onDrop}
      >
        <Handle {...props} />
        <div className="mx-1 h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
        <BlockMenu {...props} />
      </div>
    );
  }

  // Registered media blocks (image, video, audio, file, tasks…) render via the registry.
  const Media = blockRenderer(type);
  if (Media) {
    const dashboard=['metric','view','calendar','mywork','activity','attention','projecthealth','budget'].includes(type);
    return (
      <div
        className={cn('group relative flex items-start gap-0.5 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-blue-300', props.dragOver && 'border-t-2 border-blue-400')}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Backspace' || e.key === 'Delete') {
            e.preventDefault();
            props.onDelete();
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void props.onNewBelow();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          props.onDragOver();
        }}
        onDrop={props.onDrop}
      >
        <Handle {...props} />
        <div className="relative min-w-0 flex-1">
          <Media block={block} onNewBelow={props.onNewBelow} onDelete={props.onDelete} />
          <Slot modules={modules} kind="commentBadge" props={{ targetType: 'block', targetId: block.id, overlay: !dashboard, alwaysVisible:dashboard }} />
        </div>
        <BlockMenu {...props} />
      </div>
    );
  }

  return (
    <div
      data-block-id={block.id}
      className={cn('group relative flex items-start gap-0.5 rounded-md', props.dragOver && 'border-t-2 border-blue-400')}
      onDragOver={(e) => {
        e.preventDefault();
        props.onDragOver();
      }}
      onDrop={props.onDrop}
    >
      <Handle {...props} />
      {type === 'bullet' && <span className="mt-[13px] w-5 shrink-0 text-center text-neutral-400 select-none">•</span>}
      {type === 'numbered' && <span className="mt-[7px] w-5 shrink-0 text-right text-[15px] text-neutral-400 select-none">{props.number}.</span>}
      {type === 'todo' && (
        <button
          className={cn(
            'mt-[9px] mr-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border transition-colors',
            block.checked ? 'border-blue-500 bg-blue-500 text-white' : 'border-neutral-300 hover:border-neutral-400 dark:border-neutral-600',
          )}
          style={{ width: 18, height: 18 }}
          onClick={() => props.onToggleChecked(!block.checked)}
          aria-label="Toggle to-do"
        >
          {block.checked && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          )}
        </button>
      )}
      <div className={cn('relative min-w-0 flex-1', type === 'quote' && 'border-l-2 border-neutral-300 pl-3 dark:border-neutral-600', type === 'code' && 'rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-900')}>
        <RichInput
          ref={setRef}
          value={val}
          data-block
          placeholder={type === 'p' ? (focused || props.onlyBlock ? "Type '/' for commands" : undefined) : BLOCK_TYPES.find((t) => t.id === type)?.label}
          className={cn(
            'block w-full bg-transparent outline-none',
            TEXT_CLS[type] ?? TEXT_CLS.p,
            type === 'todo' && block.checked && 'text-neutral-400 line-through',
          )}
          onChange={handleChange}
          onPasteFiles={(files) => props.onPasteFiles(files)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            props.onFlush();
          }}
          onKeyDown={(e) => {
            const h = taRef.current;
            if (slashItems.length > 0) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSel((s) => (s + 1) % slashItems.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSel((s) => (s - 1 + slashItems.length) % slashItems.length); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(slashItems[slashSel % slashItems.length].id); return; }
              if (e.key === 'Escape') { commit(''); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              const full = h?.text() ?? val;
              const caret = h?.caret() ?? full.length;
              // Empty list item + Enter → convert to paragraph (Notion-style).
              if (full === '' && (type === 'bullet' || type === 'numbered' || type === 'todo')) {
                props.onChangeType('p');
                return;
              }
              // Truncate this block's text immediately and blur it, so keystrokes
              // can't leak into the old block while the new one mounts+focuses.
              const before = full.slice(0, caret);
              commit(before);
              h?.el()?.blur();
              props.onSplit(caret, full);
            } else if (e.key === 'Backspace' && (h?.caret() ?? -1) === 0) {
              e.preventDefault();
              props.onMergeUp(h?.text() ?? val);
            } else if (e.key === 'ArrowUp' && (h?.caret() ?? -1) === 0) {
              e.preventDefault();
              props.onFocusPrev();
            } else if (e.key === 'ArrowDown' && (h?.caret() ?? -1) === (h?.text() ?? val).length) {
              e.preventDefault();
              props.onFocusNext();
            }
          }}
        />
        {slashItems.length > 0 && (
          <div className="absolute left-0 top-full z-40 mt-1 w-52 overflow-hidden rounded-xl border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
            {slashItems.slice(0, 8).map((t, i) => (
              <button
                key={t.id}
                className={cn('w-full rounded-lg px-2.5 py-1.5 text-left text-sm', i === slashSel % slashItems.length ? 'bg-neutral-100 dark:bg-neutral-800' : '')}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSlash(t.id);
                }}
                onMouseEnter={() => setSlashSel(i)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <Slot modules={modules} kind="commentBadge" props={{ targetType: 'block', targetId: block.id }} />
      <BlockMenu {...props} />
    </div>
  );
}

function Handle({ onDragStart }: BlockItemProps) {
  return (
    <span
      draggable
      onDragStart={onDragStart}
      className="mt-1.5 hidden h-5 w-4 shrink-0 cursor-grab items-center justify-center rounded text-neutral-300 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-neutral-100 hover:text-neutral-500 sm:flex dark:text-neutral-600 dark:hover:bg-neutral-800"
      title="Drag to reorder"
    >
      <GripVertical size={14} />
    </span>
  );
}

function BlockMenu(props: BlockItemProps) {
  return (
    <span className="mt-0.5">
      <Popover
        align="right"
        trigger={
          <IconButton className="h-8 w-8 text-neutral-600 dark:text-neutral-400" aria-label="Block options">
            <span className="text-sm leading-none">···</span>
          </IconButton>
        }
      >
        {(close) => (
          <Menu
            close={close}
            items={[
              {
                node: (
                  <div className="px-2.5 py-1.5">
                    <p className="mb-1 text-[10px] font-semibold tracking-wide text-neutral-600 uppercase dark:text-neutral-400">Turn into</p>
                    <div className="grid grid-cols-2 gap-0.5">
                      {BLOCK_TYPES.map((t) => (
                        <button
                          key={t.id}
                          className={cn('rounded-md px-2 py-1 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800', (props.block.type ?? 'p') === t.id && 'bg-neutral-100 font-medium dark:bg-neutral-800')}
                          onClick={() => {
                            close();
                            props.onChangeType(t.id);
                          }}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ),
              },
              'divider',
              {
                label: 'Comments',
                icon: MessageSquare,
                onClick: () => openCommentThread(props.block.id),
              },
              { label: 'Move up', icon: ArrowUp, onClick: () => props.onMove(-1) },
              { label: 'Move down', icon: ArrowDown, onClick: () => props.onMove(1) },
              'divider',
              { label: 'Delete', icon: Trash2, danger: true, onClick: () => props.onDelete() },
            ]}
          />
        )}
      </Popover>
    </span>
  );
}
