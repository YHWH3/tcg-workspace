/**
 * GroupBoard — kanban grouped by a select/person field (view.config.groupBy
 * when it isn't 'status'). Drag between groups writes the field; every card
 * has a 'Move to…' menu so the same change is possible by keyboard/touch.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { DndContext, DragOverlay, TouchSensor, MouseSensor, useDroppable, useDraggable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { Plus } from 'lucide-react';
import { useStore } from '../store';
import { authStore } from '../auth';
import { Popover } from '../ui';
import { useUsers } from '../users';
import { cn, todayISO } from '../utils';
import { mutate } from '../sync/engine';
import { applyView, createRecord, propKeyOf, recordTitle, viewCtx, type ViewRow } from '../records';
import { fieldsOf, isSelectType } from '../../../shared/fields';
import { columnIdFor, lastColumnId, useTasks, type BoardRow, type TaskRow } from '../../modules/boards/api';
import { dependencyEdges, isBlocked, useLinks } from '../links';
import { CellValue } from './cells';
import { useTokenResolver } from '../resolveMentions';
import { renderPlain } from '../mentions';
import { subProgress } from './cells';

interface Group {
  key: string;
  label: string;
  rows: TaskRow[];
}

export function GroupBoard({ board, view, records }: { board: BoardRow; view: ViewRow; records: TaskRow[] }) {
  const tasks = useTasks();
  const links = useLinks();
  const users = useUsers();
  const me = useStore(authStore).user?.id;
  const [active, setActive] = useState<TaskRow | null>(null);
  const groupBy = view.config?.groupBy;
  const field = fieldsOf(board).find((f) => `p_${f.id}` === groupBy);

  const ctx = useMemo(() => viewCtx(board, tasks, links, me, todayISO()), [me, board, links, tasks]);
  const { rows } = useMemo(() => applyView(records, view.config ?? {}, { ...ctx }), [records, view, ctx]);

  const groups: Group[] = useMemo(() => {
    if (!field) return [];
    const byGroup = new Map<string, TaskRow[]>();
    for (const r of rows) {
      const raw = field.type === 'person' ? r[propKeyOf(field)] : r[propKeyOf(field)];
      const k = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k)!.push(r);
    }
    const opts =
      field.type === 'person'
        ? users.map((u) => ({ id: u.id, label: u.name }))
        : isSelectType(field.type)
          ? (field.options ?? []).map((o) => ({ id: o.id, label: o.name, color: o.color }))
          : [];
    const gs: Group[] = opts.map((o) => ({ key: o.id, label: o.label, rows: byGroup.get(o.id) ?? [] }));
    const rest = rows.filter((r) => {
      const raw = r[propKeyOf(field)];
      const k = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
      return !opts.some((o) => o.id === k);
    });
    if (rest.length || gs.length === 0) gs.push({ key: '', label: 'No value', rows: rest });
    return gs;
  }, [rows, field, users]);

  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }));

  const setGroup = (rec: TaskRow, groupKey: string) => {
    if (!field) return;
    const key = propKeyOf(field);
    const value = groupKey || null;
    void mutate('tasks', rec.id, { [key]: field.type === 'multi_select' ? (value ? [value] : []) : value });
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActive(null);
    const t = tasks.find((x) => x.id === e.active.id);
    if (!t || !e.over) return;
    const overId = String(e.over.id);
    const groupKey = overId.startsWith('g:') ? overId.slice(2) : '';
    if (overId.startsWith('g:')) setGroup(t, groupKey);
  };

  if (!field) return <p className="p-6 text-sm text-neutral-400">Choose a select or person field to group by.</p>;

  return (
    <DndContext sensors={sensors} onDragStart={(e: DragStartEvent) => setActive(tasks.find((x) => x.id === e.active.id) ?? null)} onDragEnd={onDragEnd} onDragCancel={() => setActive(null)}>
      <div className="flex h-full gap-3 overflow-x-auto px-4 py-4">
        {groups.map((g) => (
          <GroupColumn key={g.key || 'none'} board={board} view={view} group={g} onAdd={() => void createRecord(board.id, { extra: { [propKeyOf(field)]: field.type === 'multi_select' ? (g.key ? [g.key] : []) : g.key || null } })} onMove={(rec, k) => setGroup(rec, k)} groups={groups} />
        ))}
      </div>
      <DragOverlay>{active ? <div className="w-56 rounded-xl bg-white p-3 text-sm shadow-lg dark:bg-neutral-900">{recordTitle(active)}</div> : null}</DragOverlay>
    </DndContext>
  );
}

function GroupColumn({ board, view, group, groups, onAdd, onMove }: { board: BoardRow; view: ViewRow; group: Group; groups: Group[]; onAdd: () => void; onMove: (r: TaskRow, k: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `g:${group.key}` });
  return (
    <div className="flex w-64 shrink-0 flex-col">
      <div className="mb-1.5 flex items-center gap-2 px-1.5">
        <span className="text-xs font-semibold text-neutral-600 dark:text-neutral-300">{group.label}</span>
        <span className="text-[11px] text-neutral-400">{group.rows.length}</span>
      </div>
      <div ref={setNodeRef} className={cn('min-h-24 flex-1 space-y-2 rounded-xl p-1 transition-colors', isOver && 'bg-blue-50/70 dark:bg-blue-950/30')}>
        {group.rows.map((r) => (
          <GroupCard key={r.id} board={board} view={view} rec={r} groups={groups} onMove={onMove} />
        ))}
      </div>
      <button onClick={onAdd} className="mt-1.5 flex items-center gap-1 rounded-lg px-2 py-2 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800" style={{ minHeight: 40 }}>
        <Plus size={13} /> New
      </button>
    </div>
  );
}

function GroupCard({ board, view, rec, groups, onMove }: { board: BoardRow; view: ViewRow; rec: TaskRow; groups: Group[]; onMove: (r: TaskRow, k: string) => void }) {
  const navigate = useNavigate();
  const resolve = useTokenResolver();
  const tasks = useTasks();
  const links = useLinks();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: rec.id });
  const edges = dependencyEdges(links);
  const done = (id: string) => {
    const t = tasks.find((x) => x.id === id);
    return t ? columnIdFor(t, board) === lastColumnId(board) : false;
  };
  const kids = subProgress(rec, tasks, board);
  const visible = (view.config?.visible?.length ? view.config.visible : []).filter((k) => k !== 'title' && !k.startsWith('rel_')).slice(0, 3);
  const cur = groups.find((g) => g.rows.some((x) => x.id === rec.id))?.key ?? '';
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className={cn('group rounded-xl border border-neutral-200/70 bg-white p-3 text-sm shadow-sm dark:border-neutral-800 dark:bg-neutral-900', isDragging && 'opacity-40')}>
      <div className="flex items-start gap-1">
        <button className="min-w-0 flex-1 text-left" onClick={() => navigate(`/boards/${board.id}/views/${view.id}/records/${rec.id}`)}>
          <span className="block truncate font-medium">{renderPlain(recordTitle(rec), resolve)}</span>
        </button>
        <Popover
          align="right"
          trigger={
            <button className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 opacity-0 hover:bg-neutral-100 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-800" aria-label="Card menu" onClick={(e) => e.stopPropagation()}>
              ⋯
            </button>
          }
        >
          {(close) => (
            <div className="w-44 p-1 text-xs">
              <p className="px-2 pb-0.5 pt-1 font-semibold text-neutral-500">Move to…</p>
              {groups.map((g) => (
                <button
                  key={g.key || 'none'}
                  className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800', g.key === cur && 'text-blue-600 dark:text-blue-400')}
                  onClick={() => {
                    close();
                    onMove(rec, g.key);
                  }}
                >
                  {g.label} {g.key === cur && '✓'}
                </button>
              ))}
            </div>
          )}
        </Popover>
      </div>
      {isBlocked(rec.id, edges, done) && <span className="mt-1 inline-block rounded bg-red-50 px-1 py-0.5 text-[10px] font-medium text-red-500 dark:bg-red-950/40">blocked</span>}
      {visible.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {visible.map((k) => (
            <CellValue key={k} board={board} rec={rec} keyName={k} />
          ))}
        </div>
      )}
      {kids.total > 0 && <p className="mt-1 text-[10px] text-neutral-400">Sub-records {kids.done}/{kids.total}</p>}
    </div>
  );
}
