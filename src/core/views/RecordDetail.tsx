/**
 * RecordDetail — generic record page body for both tasks and records.
 * Section order (spec §4.4): title → stage/builtins → all fields (incl.
 * relation pickers) → Sub-records → Dependencies → Body blocks
 * (BlockEditor with parentType:'record') → attachments (+ 'Add Drive link')
 * → LinkedPanel → comments slot.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowRight, Calendar, ChevronDown, ChevronRight, CornerDownRight, Link2, MoreHorizontal, Plus, Trash2, Users, X } from 'lucide-react';
import { db } from '../db';
import { renderPlain } from '../mentions';
import { useTokenResolver } from '../resolveMentions';
import { mutate } from '../sync/engine';
import { Popover, Select } from '../ui';
import { useUsers } from '../users';
import { cn } from '../utils';
import { modules } from '../../modules';
import { Slot } from '../../modules/slots';
import { BlockEditor } from '../../modules/pages/BlockEditor';
import { FieldRow } from '../../modules/boards/FieldValue';
import { PresenceStack } from '../presence';
import { LinkedPanel } from '../LinkedPanel';
import { columnIdFor, isDone, PRIORITIES, taskBoardId, useBoards, useTasks, type BoardRow, type TaskRow } from '../../modules/boards/api';
import { fieldsOf } from '../../../shared/fields';
import { addDependency, blockedBy, blocking, dependencyEdges, isRelationField, removeDependency, useLinks, wouldCreateDependencyCycle, type RelationFieldDef } from '../links';
import { childrenOf, createRecord, deleteRecord, isRecordsDb, recordNoun, recordTitle, setParent, showBuiltinsOf, stagesOf } from '../records';
import { toast } from '../files';
import { RecordAttachments } from './attachments';
import { ItemPicker, RelationPicker, type PickItem } from './picker';
import { MoveRecordDialog } from './move';

export function RecordDetail({ recordId, board: boardProp, onClose }: { recordId: string; board?: BoardRow; onClose: () => void }) {
  const rec = useLiveQuery(() => db.tasks.get(recordId), [recordId]) as TaskRow | undefined;
  const allBoards = useBoards();
  const board = boardProp ?? (rec ? allBoards.find((b) => b.id === taskBoardId(rec)) : undefined);
  if (rec === undefined || board === undefined) return null;
  if (!rec) return <div className="p-4 text-sm text-neutral-400">Record not found.</div>;
  return <RecordDetailInner rec={rec} board={board} onClose={onClose} />;
}

function RecordDetailInner({ rec, board, onClose }: { rec: TaskRow; board: BoardRow; onClose: () => void }) {
  const navigate = useNavigate();
  const tasks = useTasks();
  const links = useLinks();
  const users = useUsers();
  const resolve = useTokenResolver();
  const titleRef = useRef<string | null>(null);
  useEffect(() => {
    const id = rec.id;
    const orig = String(rec.title ?? '');
    return () => {
      const v = titleRef.current;
      if (v !== null && v !== orig) void mutate('tasks', id, { title: v });
      titleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.id]);
  const [moveOpen, setMoveOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(true);

  const cols = stagesOf(board);
  const builtins = showBuiltinsOf(board);
  const noun = recordNoun(board);
  const fields = fieldsOf(board);
  const kids = childrenOf(tasks, rec.id);
  const parent = rec.parentId ? tasks.find((t) => t.id === rec.parentId) : undefined;

  const blockers = blockedBy(links, rec.id);
  const blockingIds = blocking(links, rec.id);
  const edges = dependencyEdges(links);

  const isRecord = isRecordsDb(board);

  const siblingPickerItems: PickItem[] = useMemo(
    () =>
      tasks
        .filter((t) => !t.deleted && taskBoardId(t) === board.id && t.id !== rec.id)
        .map((t) => ({ ref: { type: 'record' as const, id: t.id }, title: recordTitle(t), subtitle: noun })),
    [tasks, board.id, rec.id, noun],
  );


  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-neutral-200/70 px-3 py-2 dark:border-neutral-800/70">
        <button className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
        <span className="text-xs text-neutral-400">
          {String(board.icon ?? '')} {String(board.name ?? '')}
        </span>
        <span className="flex-1" />
        <PresenceStack path={`/boards/${board.id}/tasks/${rec.id}`} />
        <Popover
          align="right"
          trigger={
            <button className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800" aria-label={`${noun} menu`}>
              <MoreHorizontal size={16} />
            </button>
          }
        >
          {(close) => (
            <div className="w-52 p-1 text-sm">
              <button
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
                onClick={() => {
                  close();
                  setMoveOpen(true);
                }}
              >
                <CornerDownRight size={14} /> Move {noun.toLowerCase()}…
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
                onClick={() => {
                  close();
                  void deleteRecord(rec.id).then(onClose);
                }}
              >
                <Trash2 size={14} /> Delete {noun.toLowerCase()}
              </button>
            </div>
          )}
        </Popover>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {/* title */}
        <input
          key={rec.id + String(rec.title ?? '')}
          defaultValue={String(rec.title ?? '')}
          onChange={(e) => { titleRef.current = e.target.value; }}
          onBlur={(e) => {
            const v = e.target.value;
            titleRef.current = v;
            if (v !== String(rec.title ?? '')) void mutate('tasks', rec.id, { title: v });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
          }}
          placeholder={`${noun} title`}
          aria-label={`${noun} title`}
          className="w-full bg-transparent text-xl font-semibold tracking-tight outline-none placeholder:text-neutral-300 dark:placeholder:text-neutral-600"
        />

        {parent && (
          <button className="flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-600" onClick={() => navigate(`/boards/${board.id}/tasks/${parent.id}`)}>
            ↩ under <span className="font-medium">{renderPlain(recordTitle(parent), resolve)}</span>
          </button>
        )}

        {/* stage + builtins */}
        <div className="grid grid-cols-[88px_1fr] items-center gap-y-2 text-sm">
          {cols.length > 0 && (
            <>
              <span className="text-xs text-neutral-400">Stage</span>
              <Select value={columnIdFor(rec, board)} onChange={(e) => void mutate('tasks', rec.id, { status: e.target.value })} className="h-8 w-48 text-xs" aria-label="Stage">
                {cols.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </>
          )}
          {builtins.priority && (
            <>
              <span className="text-xs text-neutral-400">Priority</span>
              <Select value={rec.priority ?? 'none'} onChange={(e) => void mutate('tasks', rec.id, { priority: e.target.value })} className="h-8 w-48 text-xs" aria-label="Priority">
                {PRIORITIES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </>
          )}
          {builtins.assignee && (
            <>
              <span className="flex items-center gap-1 text-xs text-neutral-400">
                <Users size={11} /> Assignee
              </span>
              <Select value={String(rec.assigneeId ?? '')} onChange={(e) => void mutate('tasks', rec.id, { assigneeId: e.target.value || null })} className="h-8 w-48 text-xs" aria-label="Assignee">
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </>
          )}
          {builtins.due && (
            <>
              <span className="flex items-center gap-1 text-xs text-neutral-400">
                <Calendar size={11} /> Due
              </span>
              <input type="date" value={String(rec.dueDate ?? '')} onChange={(e) => void mutate('tasks', rec.id, { dueDate: e.target.value || null })} className="h-8 w-48 rounded-lg border border-neutral-200 bg-transparent px-2 text-xs dark:border-neutral-700" aria-label="Due date" />
            </>
          )}
          {/* all fields incl. relation pickers */}
          {fields.map((f) =>
            isRelationField(f) ? (
              <RelationRow key={f.id} field={f} rec={rec} />
            ) : (
              <FieldRow key={f.id} field={f} task={rec} />
            ),
          )}
        </div>

        {/* sub-records */}
        <section>
          <div className="mb-1.5 flex items-center gap-1">
            <button className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => setSubOpen((s) => !s)} aria-expanded={subOpen} aria-label="Toggle sub-records">
              {subOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
            <h3 className="text-xs font-semibold text-neutral-500 dark:text-neutral-400">Sub-{noun.toLowerCase()}s</h3>
            <span className="text-[10px] text-neutral-400">{kids.length || ''}</span>
            <span className="flex-1" />
            <button
              className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800"
              onClick={async () => {
                try {
                  const id = await createRecord(board.id, { parentId: rec.id });
                  navigate(`/boards/${board.id}/tasks/${id}`);
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Failed', 'error');
                }
              }}
            >
              <Plus size={11} /> Add
            </button>
          </div>
          {subOpen && (
            <div className="space-y-0.5">
              {kids.map((k) => (
                <SubRow key={k.id} rec={k} board={board} onOpen={() => navigate(`/boards/${board.id}/tasks/${k.id}`)} onDetach={() => void setParent(k.id, null)} />
              ))}
              {kids.length === 0 && <p className="px-1 text-xs text-neutral-400">None yet — sub-{noun.toLowerCase()}s nest up to 3 levels.</p>}
            </div>
          )}
        </section>

        {/* dependencies */}
        <section className="space-y-2">
          <DepList
            title="Blocked by"
            ids={blockers}
            tasks={tasks}
            board={board}
            onRemove={(id) => void removeDependency(id, rec.id)}
            picker={
              <ItemPicker
                trigger={
                  <button className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800">
                    <Plus size={11} /> Add blocker
                  </button>
                }
                items={siblingPickerItems.filter((i) => !blockers.includes(i.ref.id) && !wouldCreateDependencyCycle(edges, i.ref.id, rec.id))}
                placeholder={`Search ${noun.toLowerCase()}s…`}
                onPick={(i) => void addDependency(i.ref.id, rec.id).catch((e) => toast(String(e instanceof Error ? e.message : e), 'error'))}
              />
            }
          />
          <DepList title="Blocking" ids={blockingIds} tasks={tasks} board={board} onRemove={(id) => void removeDependency(rec.id, id)} />
        </section>

        {/* body blocks */}
        <section>
          <h3 className="mb-1.5 text-xs font-semibold text-neutral-500 dark:text-neutral-400">{isRecord ? 'Body' : 'Description'}</h3>
          <BlockEditor pageId={rec.id} />
        </section>

        {/* attachments + Drive link */}
        <section>
          <h3 className="mb-1.5 text-xs font-semibold text-neutral-500 dark:text-neutral-400">Attachments</h3>
          <RecordAttachments parentId={rec.id} />
        </section>

        {/* linked panel */}
        <LinkedPanel refType="record" refId={rec.id} board={board} />

        {/* comments slot */}
        <section>
          <Slot modules={modules} kind="taskDetail" props={{ taskId: rec.id }} />
        </section>
      </div>

      {moveOpen && <MoveRecordDialog rec={rec} board={board} tasks={tasks} onClose={() => setMoveOpen(false)} />}
    </div>
  );
}

function RelationRow({ field, rec }: { field: RelationFieldDef; rec: TaskRow }) {
  return (
    <>
      <span className="flex items-center gap-1 text-xs text-neutral-400">
        <Link2 size={11} /> {field.name}
      </span>
      <RelationPicker record={rec} field={field} />
    </>
  );
}

function SubRow({ rec, board, onOpen, onDetach }: { rec: TaskRow; board: BoardRow; onOpen: () => void; onDetach: () => void }) {
  const tasks = useTasks();
  const resolve = useTokenResolver();
  const done = isDone(rec, board);
  const grandkids = childrenOf(tasks, rec.id);
  return (
    <div className="group flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-900" style={{ minHeight: 36 }}>
      <button className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm" onClick={onOpen}>
        <span className={cn('truncate', done && 'text-neutral-400 line-through')}>{renderPlain(recordTitle(rec), resolve)}</span>
        {stagesOf(board).length > 0 && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: stagesOf(board).find((c) => c.id === columnIdFor(rec, board))?.color }} />}
        {grandkids.length > 0 && <span className="shrink-0 text-[10px] text-neutral-400">+{grandkids.length}</span>}
      </button>
      <Popover
        align="right"
        trigger={
          <button className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 opacity-0 hover:bg-neutral-100 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-800" aria-label="Sub-record menu">
            ⋯
          </button>
        }
      >
        {(close) => (
          <div className="w-44 p-1 text-xs">
            <button className="flex w-full rounded-md px-2 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => { close(); onDetach(); }}>
              Detach (move to top level)
            </button>
            <button className="flex w-full rounded-md px-2 py-1.5 text-left text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40" onClick={() => { close(); void deleteRecord(rec.id); }}>
              Delete
            </button>
          </div>
        )}
      </Popover>
    </div>
  );
}

function DepList({ title, ids, tasks, board, onRemove, picker }: { title: string; ids: string[]; tasks: TaskRow[]; board: BoardRow; onRemove: (id: string) => void; picker?: React.ReactNode }) {
  const navigate = useNavigate();
  const resolve = useTokenResolver();
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h4 className="text-xs font-semibold text-neutral-500 dark:text-neutral-400">{title}</h4>
        <span className="text-[10px] text-neutral-400">{ids.length || ''}</span>
        {picker}
      </div>
      {ids.length > 0 && (
        <div className="space-y-0.5">
          {ids.map((id) => {
            const t = tasks.find((x) => x.id === id);
            if (!t) return null;
            const tBoard = board;
            return (
              <div key={id} className="group flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-neutral-50 dark:hover:bg-neutral-900">
                <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm" onClick={() => navigate(`/boards/${taskBoardId(t)}/tasks/${id}`)}>
                  <ArrowRight size={11} className="shrink-0 text-neutral-300" />
                  <span className="truncate">{renderPlain(recordTitle(t), resolve)}</span>
                  {isDone(t, tBoard) && <span className="shrink-0 rounded bg-green-50 px-1 text-[10px] text-green-600 dark:bg-green-950/40">done</span>}
                </button>
                {onRemove && (
                  <button className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 opacity-0 hover:text-red-500 focus:opacity-100 group-hover:opacity-100" onClick={() => onRemove(id)} aria-label="Remove dependency">
                    <X size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
