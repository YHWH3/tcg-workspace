import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Trash2, X } from 'lucide-react';
import { useIsMobile } from '../../core/shell';
import { db } from '../../core/db';
import { Avatar, IconButton, Select, Sheet } from '../../core/ui';
import { resolveUser, useUsers } from '../../core/users';
import { authStore } from '../../core/auth';
import { useStore } from '../../core/store';
import { cn, debounce, todayISO } from '../../core/utils';
import { modules } from '..';
import { Slot } from '../slots';
import { deleteTask, PRIORITIES, setTaskField, STATUSES, type TaskRow } from './api';

export function TaskDetail({ taskId }: { taskId: string }) {
  const mobile = useIsMobile();
  const navigate = useNavigate();
  const close = () => navigate('/tasks');

  const inner = <DetailBody taskId={taskId} onClose={close} />;

  if (mobile) {
    return (
      <Sheet onClose={close} side="bottom">
        {inner}
      </Sheet>
    );
  }
  return <aside className="anim-slide-right flex w-[400px] shrink-0 flex-col border-l border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-neutral-950">{inner}</aside>;
}

function DetailBody({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const task = useLiveQuery(() => db.tasks.get(taskId), [taskId]) as TaskRow | undefined;
  const users = useUsers();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const debouncedDesc = useRef(debounce((id: string, v: string) => void setTaskField(id, { description: v }), 400));
  const debouncedTitle = useRef(debounce((id: string, v: string) => void setTaskField(id, { title: v }), 400));

  useEffect(() => {
    if (task) {
      if (!editingTitle) setTitle(String(task.title ?? ''));
      setDesc(String(task.description ?? ''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, task?.title]);

  useEffect(() => {
    if (task && !editingTitle) setDesc(String(task.description ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.description]);

  if (!task || task.deleted) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-400">
        Task not found
      </div>
    );
  }

  const overdue = task.dueDate && task.dueDate < todayISO() && task.status !== 'done';

  return (
    <>
      <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-2.5 dark:border-neutral-800">
        <span className="text-xs font-medium text-neutral-400">Task</span>
        <div className="flex items-center gap-1">
          <IconButton
            aria-label="Delete task"
            onClick={async () => {
              await deleteTask(task.id);
              onClose();
            }}
          >
            <Trash2 size={15} />
          </IconButton>
          <IconButton onClick={onClose} aria-label="Close">
            <X size={16} />
          </IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="p-4">
          <textarea
            value={title}
            rows={1}
            placeholder="Task title"
            className="w-full resize-none overflow-hidden bg-transparent text-lg font-semibold outline-none placeholder:text-neutral-300 dark:placeholder:text-neutral-600"
            onFocus={() => setEditingTitle(true)}
            onBlur={() => {
              setEditingTitle(false);
              debouncedTitle.current.flush(task.id, title);
            }}
            onChange={(e) => {
              setTitle(e.target.value);
              debouncedTitle.current(task.id, e.target.value);
            }}
          />
          <div className="mt-3 grid grid-cols-[88px_1fr] items-center gap-y-2.5 text-sm">
            <span className="text-xs text-neutral-400">Status</span>
            <Select value={task.status ?? 'todo'} onChange={(e) => void setTaskField(task.id, { status: e.target.value as TaskRow['status'] })} className="py-1.5">
              {STATUSES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
            <span className="text-xs text-neutral-400">Priority</span>
            <Select value={task.priority ?? 'none'} onChange={(e) => void setTaskField(task.id, { priority: e.target.value as TaskRow['priority'] })} className="py-1.5">
              {PRIORITIES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
            <span className="text-xs text-neutral-400">Assignee</span>
            <Select value={String(task.assigneeId ?? '')} onChange={(e) => void setTaskField(task.id, { assigneeId: e.target.value || null })} className="py-1.5">
              <option value="">Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
            <span className="text-xs text-neutral-400">Due date</span>
            <input
              type="date"
              value={String(task.dueDate ?? '')}
              onChange={(e) => void setTaskField(task.id, { dueDate: e.target.value || null })}
              className={cn(
                'w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:ring-white/10',
                overdue && 'border-red-300 text-red-600 dark:border-red-800 dark:text-red-400',
              )}
            />
          </div>
          <div className="mt-4">
            <span className="mb-1 block text-xs text-neutral-400">Description</span>
            <textarea
              value={desc}
              rows={4}
              placeholder="Add details…"
              className="w-full resize-none overflow-hidden rounded-lg bg-transparent text-sm leading-6 outline-none placeholder:text-neutral-300 focus:bg-neutral-50 dark:placeholder:text-neutral-600 dark:focus:bg-neutral-900/60 p-1 -m-1"
              onChange={(e) => {
                setDesc(e.target.value);
                debouncedDesc.current(task.id, e.target.value);
              }}
              onBlur={() => debouncedDesc.current.flush(task.id, desc)}
            />
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-neutral-400">
            {task.createdBy && <Creator id={String(task.createdBy)} />}
            {task.createdAt && <span>{new Date(Number(task.createdAt)).toLocaleDateString()}</span>}
          </div>
        </div>
        <Slot modules={modules} kind="taskDetail" props={{ taskId: task.id }} />
      </div>
    </>
  );
}

function Creator({ id }: { id: string }) {
  const users = useUsers();
  const me = useStore(authStore).user;
  const u = resolveUser(id, users, me);
  if (!u) return null;
  return (
    <span className="flex items-center gap-1.5">
      <Avatar name={u.name} color={u.color} size={16} /> {u.name}
    </span>
  );
}
