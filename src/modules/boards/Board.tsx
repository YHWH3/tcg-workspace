import { useState } from 'react';
import { DndContext, DragOverlay, MouseSensor, TouchSensor, useSensor, useSensors, closestCorners, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Check, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { mutate } from '../../core/sync/engine';
import { IconButton, Menu, Popover } from '../../core/ui';
import { cn, cmpOrder, orderBetween } from '../../core/utils';
import { TaskCard } from './TaskCard';
import { addColumn, columnIdFor, columnsOf, createTask, deleteColumn, moveColumn, COLUMN_COLORS, recolorColumn, renameColumn, setTaskField, type BoardColumn, type BoardRow, type TaskRow } from './api';
import { noteGatedMove } from './GateMove';

export function Board({ board, tasks }: { board: BoardRow; tasks: TaskRow[] }) {
  const cols = columnsOf(board);
  const [activeTask, setActiveTask] = useState<TaskRow | null>(null);
  const [addingCol, setAddingCol] = useState(false);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Long-press to lift on touch so scrolling still works.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  const onDragStart = (e: DragStartEvent) => {
    const t = tasks.find((x) => x.id === e.active.id);
    setActiveTask(t ?? null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = e;
    if (!over) return;
    const task = tasks.find((t) => t.id === active.id);
    if (!task) return;

    const overId = String(over.id);
    let targetColId: string;
    let before: string | null;
    let after: string | null;

    if (overId.startsWith('col:')) {
      targetColId = overId.slice(4);
      const inCol = sortedIn(targetColId);
      before = inCol.length ? String(inCol[inCol.length - 1].order ?? '') || null : null;
      after = null;
      if (targetColId === columnIdFor(task, board) && inCol.length && inCol[inCol.length - 1].id === task.id) return;
    } else {
      const overTask = tasks.find((t) => t.id === overId);
      if (!overTask || overTask.id === task.id) return;
      targetColId = columnIdFor(overTask, board);
      const inCol = sortedIn(targetColId).filter((t) => t.id !== task.id);
      const idx = inCol.findIndex((t) => t.id === overTask.id);
      before = idx > 0 ? String(inCol[idx - 1].order ?? '') || null : null;
      after = String(overTask.order ?? '') || null;
    }
    if (!cols.some((c) => c.id === targetColId)) return;
    const order = orderBetween(before, after);
    noteGatedMove(board, task.id, targetColId); // P4-D: gated stage → request dialog (server still decides)
    void mutate('tasks', task.id, { status: targetColId, order });
  };

  const sortedIn = (colId: string) => tasks.filter((t) => columnIdFor(t, board) === colId).sort((a, b) => cmpOrder(a.order, b.order));

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveTask(null)}>
      <div className="flex h-full snap-x snap-mandatory items-start gap-3 overflow-x-auto p-4">
        {cols.map((col) => (
          <Column key={col.id} board={board} col={col} tasks={sortedIn(col.id)} />
        ))}
        <div className="shrink-0">
          {addingCol ? (
            <NewColumnInput
              onDone={async (name) => {
                setAddingCol(false);
                if (name) await addColumn(board, name);
              }}
            />
          ) : (
            <button
              onClick={() => setAddingCol(true)}
              className="flex w-64 items-center gap-1.5 rounded-xl border border-dashed border-neutral-300 px-3 py-2.5 text-xs font-medium text-neutral-600 dark:text-neutral-400 transition-colors hover:border-neutral-400 hover:text-neutral-600 sm:w-72 dark:border-neutral-700 dark:hover:border-neutral-600 dark:hover:text-neutral-300"
            >
              <Plus size={14} /> Add stage
            </button>
          )}
        </div>
      </div>
      <DragOverlay>{activeTask ? <TaskCard task={activeTask} board={board} overlay /> : null}</DragOverlay>
    </DndContext>
  );
}

function NewColumnInput({ onDone }: { onDone: (name: string) => void }) {
  const [v, setV] = useState('');
  return (
    <input
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      placeholder="Stage name"
      className="w-64 rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-xs outline-none focus:ring-2 focus:ring-neutral-900/10 sm:w-72 dark:border-neutral-700 dark:bg-neutral-900"
      onBlur={() => void onDone(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void onDone(v);
        if (e.key === 'Escape') onDone('');
      }}
    />
  );
}

function Column({ board, col, tasks }: { board: BoardRow; col: BoardColumn; tasks: TaskRow[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${col.id}` });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');

  const quickAdd = async () => {
    const name = title.trim();
    setTitle('');
    setAdding(false);
    if (!name) return;
    const id = await createTask(board.id, col.id);
    await setTaskField(id, { title: name });
  };

  return (
    <section
      ref={setNodeRef}
      className={cn('flex w-64 shrink-0 snap-start flex-col rounded-xl bg-neutral-50 p-2 transition-colors sm:w-72 dark:bg-neutral-900/60', isOver && 'ring-2 ring-blue-400/50')}
    >
      <ColumnHeader board={board} col={col} count={tasks.length} />
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div className="flex min-h-8 flex-col gap-1.5">
          {tasks.map((t) => (
            <SortableCard key={t.id} task={t} board={board} cols={columnsOf(board)} col={col} />
          ))}
        </div>
      </SortableContext>
      {adding ? (
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Task title"
          className="mt-1.5 w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-[13px] outline-none focus:ring-2 focus:ring-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900"
          onBlur={() => void quickAdd()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void quickAdd().then(() => setAdding(true));
            if (e.key === 'Escape') setAdding(false);
          }}
        />
      ) : (
        <button onClick={() => setAdding(true)} className="mt-1.5 flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-neutral-600 dark:text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300">
          <Plus size={13} /> Add task
        </button>
      )}
    </section>
  );
}

function SortableCard({ task, board, cols, col }: { task: TaskRow; board: BoardRow; cols: BoardColumn[]; col: BoardColumn }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} role="group" tabIndex={-1} className={cn(isDragging && 'opacity-40')}>
      <div className="relative">
        <TaskCard task={task} board={board} />
        <span className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100 [.group:hover_&]:opacity-100">
          <Popover
            align="right"
            trigger={
              <IconButton className="h-6 w-6 bg-white/90 shadow-sm dark:bg-neutral-900/90" aria-label="Card menu">
                <MoreHorizontal size={13} />
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
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">Move to</p>
                        {cols
                          .filter((c) => c.id !== col.id)
                          .map((c) => (
                            <button
                              key={c.id}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
                              onClick={() => {
                                close();
                                noteGatedMove(board, task.id, c.id);
                                void setTaskField(task.id, { status: c.id });
                              }}
                            >
                              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: c.color }} />
                              {c.name}
                            </button>
                          ))}
                      </div>
                    ),
                  },
                ]}
              />
            )}
          </Popover>
        </span>
      </div>
    </div>
  );
}

function ColumnHeader({ board, col, count }: { board: BoardRow; col: BoardColumn; count: number }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(col.name);
  const hasTasks = count > 0;

  return (
    <div className="flex items-center justify-between px-2 py-1.5">
      {renaming ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-28 rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 text-xs font-semibold outline-none dark:border-neutral-700 dark:bg-neutral-900"
          onBlur={() => {
            setRenaming(false);
            void renameColumn(board, col.id, name);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setName(col.name);
              setRenaming(false);
            }
          }}
        />
      ) : (
        <span className="flex items-center gap-2 text-xs font-semibold text-neutral-600 dark:text-neutral-300">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: col.color }} />
          {col.name}
          <span className="font-normal text-neutral-600 dark:text-neutral-400">{count}</span>
        </span>
      )}
      <Popover
        align="right"
        trigger={
          <IconButton className="h-6 w-6" aria-label="Column menu">
            <MoreHorizontal size={14} />
          </IconButton>
        }
      >
        {(close) => (
          <Menu
            close={close}
            items={[
              { label: 'Rename', onClick: () => setRenaming(true) },
              {
                node: (
                  <div className="px-2.5 py-1.5">
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">Color</p>
                    <div className="flex gap-1.5">
                      {COLUMN_COLORS.map((c) => (
                        <button
                          key={c}
                          aria-label={`Color ${c}`}
                          className="flex h-5 w-5 items-center justify-center rounded-full transition-transform hover:scale-110"
                          style={{ backgroundColor: c }}
                          onClick={() => {
                            close();
                            void recolorColumn(board, col.id, c);
                          }}
                        >
                          {col.color === c && <Check size={11} className="text-white" />}
                        </button>
                      ))}
                    </div>
                  </div>
                ),
              },
              'divider',
              { label: 'Move left', onClick: () => void moveColumn(board, col.id, -1) },
              { label: 'Move right', onClick: () => void moveColumn(board, col.id, 1) },
              'divider',
              hasTasks
                ? {
                    node: (
                      <div className="px-2.5 py-1.5">
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">Delete stage — move {count} task{count === 1 ? '' : 's'} to:</p>
                        {columnsOf(board)
                          .filter((c) => c.id !== col.id)
                          .map((c) => (
                            <button
                              key={c.id}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
                              onClick={async () => {
                                close();
                                await deleteColumn(board, col.id, c.id);
                              }}
                            >
                              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: c.color }} />
                              {c.name}
                            </button>
                          ))}
                      </div>
                    ),
                  }
                : { label: 'Delete stage', icon: Trash2, danger: true, onClick: () => void deleteColumn(board, col.id) },
            ]}
          />
        )}
      </Popover>
    </div>
  );
}
