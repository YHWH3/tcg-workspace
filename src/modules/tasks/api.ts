import { useLiveQuery } from 'dexie-react-hooks';
import { generateKeyBetween } from 'fractional-indexing';
import { authStore } from '../../core/auth';
import { logActivity } from '../../core/activity';
import { db, type LocalRow } from '../../core/db';
import { mutate } from '../../core/sync/engine';
import { uuid } from '../../core/utils';

export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

export interface TaskRow extends LocalRow {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: string | null;
  dueDate?: string | null;
  pageId?: string | null;
  order?: string;
  createdBy?: string;
  createdAt?: number;
  deleted?: boolean;
}

export const STATUSES: { id: TaskStatus; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'done', label: 'Done' },
];

export const PRIORITIES: { id: TaskPriority; label: string; cls: string }[] = [
  { id: 'none', label: 'None', cls: 'text-neutral-400' },
  { id: 'low', label: 'Low', cls: 'text-neutral-400' },
  { id: 'medium', label: 'Medium', cls: 'text-amber-500' },
  { id: 'high', label: 'High', cls: 'text-orange-500' },
  { id: 'urgent', label: 'Urgent', cls: 'text-red-500' },
];

export function useTasks(): TaskRow[] {
  return (useLiveQuery(() => db.tasks.toArray(), [], []) ?? []) as TaskRow[];
}

export function liveTasks(tasks: TaskRow[]): TaskRow[] {
  return tasks.filter((t) => !t.deleted);
}

export function byOrder(a: TaskRow, b: TaskRow): number {
  return String(a.order ?? '').localeCompare(String(b.order ?? ''));
}

export async function createTask(status: TaskStatus = 'todo'): Promise<string> {
  const all = await db.tasks.toArray();
  const inCol = all.filter((t) => t.status === status && !t.deleted).sort(byOrder);
  const order = generateKeyBetween(inCol.length ? String(inCol[inCol.length - 1].order ?? '') || null : null, null);
  const id = uuid();
  const me = authStore.get().user;
  await mutate('tasks', id, {
    title: '',
    description: '',
    status,
    priority: 'none',
    assigneeId: null,
    dueDate: null,
    pageId: null,
    order,
    createdBy: me?.id ?? null,
    createdAt: Date.now(),
  });
  return id;
}

export async function setTaskField(id: string, patch: Partial<TaskRow>): Promise<void> {
  const before = await db.tasks.get(id);
  await mutate('tasks', id, patch);
  const title = String(before?.title ?? 'Task');
  if (patch.status !== undefined && before?.status !== patch.status) {
    logActivity(patch.status === 'done' ? 'completed' : 'moved', 'task', id, title, { status: patch.status });
  }
  if (patch.assigneeId !== undefined && before?.assigneeId !== patch.assigneeId) {
    logActivity('assigned', 'task', id, title, { assigneeId: patch.assigneeId });
  }
  if (patch.title !== undefined && before && String(before.title ?? '') === '' && patch.title) {
    logActivity('created', 'task', id, String(patch.title));
  }
}

export async function deleteTask(id: string): Promise<void> {
  await mutate('tasks', id, { deleted: true });
}
