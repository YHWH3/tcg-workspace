/**
 * LinkedPanel — the relationships surface on a record/page detail (spec
 * §4.5): each relation field (forward + reverse values), "Related" free
 * links, "Blocks / Blocked by" and "Mentioned in" (blocks containing
 * @[rec:id] / @[page:id] tokens). Empty groups collapse.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronDown, ChevronRight, FileText, Link2, Plus } from 'lucide-react';
import { db } from './db';
import { taskBoardId, type BoardRow } from '../modules/boards/api';
import { fieldsOf } from '../../shared/fields';
import { isRelationField, link, relationValues, unlink, unlinkRelation, useLinks } from './links';
import { ItemPicker, LinkedChips, type PickItem } from './views/picker';
import { useBoardsLite } from './views/shared';
import type { PageRow } from '../modules/pages/api';

/** Blocks that mention this item via @[page:id] / @[rec:id] tokens. */
function useMentions(refType: 'record' | 'page', refId: string) {
  return useLiveQuery(
    async () => {
      const blocks = await db.blocks.toArray();
      const hits = blocks.filter((b) => {
        if (b.deleted) return false;
        const want = refType === 'record' ? 'rec' : 'page';
        return String(b.text ?? '').match(new RegExp(`@\\[${want}:${refId}\\]`));
      });
      return hits.map((b) => ({ id: b.id as string, pageId: String(b.pageId ?? '') }));
    },
    [refType, refId],
    [],
  );
}

interface Target {
  id: string;
  title: string;
  kind: 'record' | 'page' | 'mooditem' | 'file';
  boardId?: string;
}

export function LinkedPanel({ refType, refId, board }: { refType: 'record' | 'page'; refId: string; board?: BoardRow }) {
  const links = useLinks();
  const boards = useBoardsLite();
  const mentions = useMentions(refType, refId);
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []);
  const pages = useLiveQuery(() => db.pages.toArray(), [], []);

  // title lookup for any linked id
  const titles = useMemo(() => {
    const m = new Map<string, Target>();
    for (const t of tasks ?? []) {
      if (t.deleted) continue;
      m.set(t.id, { id: t.id, title: String(t.title ?? ''), kind: 'record', boardId: taskBoardId(t) });
    }
    for (const p of (pages ?? []) as PageRow[]) {
      if (p.deleted) continue;
      m.set(p.id, { id: p.id, title: String(p.title ?? ''), kind: 'page' });
    }
    return m;
  }, [tasks, pages]);

  const relFields = board ? fieldsOf(board).filter(isRelationField) : [];

  // forward + reverse groups per relation field
  const relGroups = relFields.map((f) => ({
    field: f,
    ids: relationValues(links, refId, f),
  }));

  const related = links.filter((l) => !l.deleted && l.kind === 'related' && (l.fromId === refId || l.toId === refId));
  const blockers = links.filter((l) => !l.deleted && l.kind === 'blocks' && l.toId === refId).map((l) => String(l.fromId));
  const blockingIds = links.filter((l) => !l.deleted && l.kind === 'blocks' && l.fromId === refId).map((l) => String(l.toId));

  const pickItems: PickItem[] = useMemo(() => {
    const items: PickItem[] = [];
    for (const t of titles.values()) {
      if (t.id === refId) continue;
      const b = t.boardId ? boards.find((x) => x.id === t.boardId) : undefined;
      items.push({ ref: { type: t.kind === 'page' ? 'page' : 'record', id: t.id }, title: t.title || 'Untitled', subtitle: t.kind === 'page' ? 'Page' : String(b?.name ?? 'Record'), icon: String(t.kind === 'page' ? '📄' : b?.icon ?? '') });
    }
    return items;
  }, [titles, boards, refId]);

  const refSelf: { type: 'record' | 'page'; id: string } = { type: refType, id: refId };

  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold text-neutral-500 dark:text-neutral-400">Linked</h3>
      {relGroups.map(({ field, ids }) => (
        <Group key={field.id} label={field.name} count={ids.length}>
          <LinkedChips ids={ids} kind={field.relation.target === 'pages' ? 'page' : 'record'} boards={boards} onRemove={refType === 'record' ? (id) => void unlinkRelation(refId, field, id) : undefined} />
        </Group>
      ))}
      <Group label="Blocks" count={blockingIds.length}>
        <LinkedChips ids={blockingIds} kind="record" boards={boards} />
      </Group>
      <Group label="Blocked by" count={blockers.length}>
        <LinkedChips ids={blockers} kind="record" boards={boards} />
      </Group>
      <Group label="Related" count={related.length}>
        {related.map((l) => {
          const otherId = l.fromId === refId ? String(l.toId) : String(l.fromId);
          const otherType = l.fromId === refId ? l.toType : l.fromType;
          const t = titles.get(otherId);
          return <LinkedRow key={l.id} target={t ?? { id: otherId, title: 'Untitled', kind: otherType === 'page' ? 'page' : 'record' }} onRemove={() => void unlink(l.id)} />;
        })}
      </Group>
      <Group label="Mentioned in" count={mentions?.length ?? 0}>
        {(mentions ?? []).map((m) => (
          <MentionRow key={m.id} ownerId={m.pageId} titles={titles} />
        ))}
      </Group>
      <ItemPicker
        trigger={
          <button className="flex items-center gap-1 rounded-lg px-1.5 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-300" style={{ minHeight: 32 }}>
            <Plus size={12} /> Link
          </button>
        }
        items={pickItems}
        placeholder="Link a page or record…"
        onPick={(i) => void link(refSelf, i.ref, 'related')}
      />
    </section>
  );
}

function Group({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(count > 0);
  if (count === 0) {
    return (
      <div className="flex items-center gap-1 px-1 py-0.5">
        <span className="text-xs text-neutral-600 dark:text-neutral-400">{label}</span>
      </div>
    );
  }
  return (
    <div>
      <button className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs text-neutral-500 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-900" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className="font-medium">{label}</span>
        <span className="text-[10px] text-neutral-600 dark:text-neutral-400">{count}</span>
      </button>
      {open && <div className="space-y-0.5 px-1 py-0.5">{children}</div>}
    </div>
  );
}

function LinkedRow({ target, onRemove }: { target: Target; onRemove?: () => void }) {
  const navigate = useNavigate();
  const href = target.kind === 'page' ? `/pages/${target.id}` : `/boards/${target.boardId ?? ''}/tasks/${target.id}`;
  return (
    <div className="group flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-neutral-50 dark:hover:bg-neutral-900">
      <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm" onClick={() => navigate(href)}>
        {target.kind === 'page' ? <FileText size={12} className="shrink-0 text-neutral-400" /> : <Link2 size={12} className="shrink-0 text-neutral-400" />}
        <span className="truncate">{target.title || 'Untitled'}</span>
      </button>
      {onRemove && (
        <button className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 opacity-0 hover:text-red-500 focus:opacity-100 group-hover:opacity-100" onClick={onRemove} aria-label="Unlink">
          ×
        </button>
      )}
    </div>
  );
}

function MentionRow({ ownerId, titles }: { ownerId: string; titles: Map<string, Target> }) {
  const navigate = useNavigate();
  const owner = titles.get(ownerId);
  if (!owner) return null;
  const href = owner.kind === 'page' ? `/pages/${owner.id}` : `/boards/${owner.boardId ?? ''}/tasks/${owner.id}`;
  return (
    <button className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900" onClick={() => navigate(href)}>
      <FileText size={12} className="shrink-0 text-neutral-400" />
      <span className="truncate">{owner.title || 'Untitled'}</span>
    </button>
  );
}
