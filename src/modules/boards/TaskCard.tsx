import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { CalendarDays, FileText, MessageSquare } from 'lucide-react';
import { authStore } from '../../core/auth';
import { db } from '../../core/db';
import { useAttachments, type FileRow } from '../../core/files';
import { AudioChip, FileImage } from '../../core/fileui';
import { Avatar } from '../../core/ui';
import { resolveUser, useUsers } from '../../core/users';
import { cn, formatDate, todayISO } from '../../core/utils';
import { isDone, taskBoardId, type BoardRow, type TaskRow } from './api';
import { FieldChips } from './FieldValue';

export function TaskCard({ task, board, overlay }: { task: TaskRow; board: BoardRow | undefined; overlay?: boolean }) {
  const navigate = useNavigate();
  const users = useUsers();
  const me = authStore.get().user;
  const files = useAttachments(task.id);
  const commentCount = useLiveQuery(() => db.comments.where('targetId').equals(task.id).filter((c) => !c.deleted).count(), [task.id], 0) ?? 0;

  const images = files.filter((f) => f.kind === 'image');
  const audios = files.filter((f) => f.kind === 'audio');
  const coverId = task.coverFileId ?? images[0]?.id;
  const cover = coverId ? files.find((f) => f.id === coverId) : undefined;
  const assignee = resolveUser(task.assigneeId ?? null, users, me);
  const overdue = task.dueDate && String(task.dueDate) < todayISO() && !isDone(task, board);
  const open = () => navigate(`/boards/${taskBoardId(task)}/tasks/${task.id}`);

  return (
    <div
      onClick={open}
      className={cn(
        'group cursor-pointer overflow-hidden rounded-xl border border-neutral-200/80 bg-white shadow-sm transition-shadow hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900',
        overlay && 'rotate-1 shadow-xl',
      )}
      data-task-card={task.id}
    >
      {cover && (
        <div className="aspect-[4/3] w-full overflow-hidden bg-neutral-100 dark:bg-neutral-800">
          <FileImage fileId={cover.id} thumbId={cover.thumbId} className="h-full w-full" alt={String(task.title ?? '')} />
        </div>
      )}
      <div className="px-2.5 pb-2 pt-2">
        <p className={cn('text-[13px] font-medium leading-5', isDone(task, board) && 'text-neutral-400 line-through')}>{String(task.title ?? '') || 'Untitled task'}</p>
        <CardFooter audios={audios} fileCount={files.length} commentCount={commentCount} assignee={assignee} dueDate={task.dueDate} overdue={!!overdue} fieldChips={<FieldChips board={board} task={task} />} />
      </div>
    </div>
  );
}

function CardFooter({ audios, fileCount, commentCount, assignee, dueDate, overdue, fieldChips }: { audios: FileRow[]; fileCount: number; commentCount: number; assignee: { name: string; color?: string } | undefined; dueDate?: string | null; overdue: boolean; fieldChips?: ReactNode }) {
  const extras: ReactNode[] = [fieldChips];
  for (const a of audios.slice(0, 1)) extras.push(<AudioChip key={a.id} file={a} />);
  if (fileCount > audios.length) extras.push(<Chip key="files" icon={<FileText size={10} />} label={String(fileCount - audios.length)} />);
  if (commentCount > 0) extras.push(<Chip key="comments" icon={<MessageSquare size={10} />} label={String(commentCount)} />);
  if (dueDate) extras.push(<Chip key="due" icon={<CalendarDays size={10} />} label={formatDate(String(dueDate))} danger={overdue} />);
  if (extras.length === 0 && !assignee) return null;
  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1">{extras}</div>
      <span className="flex-1" />
      {assignee && <Avatar name={assignee.name} color={assignee.color} size={18} />}
    </div>
  );
}

function Chip({ icon, label, danger }: { icon: ReactNode; label: string; danger?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium dark:bg-neutral-800', danger ? 'text-red-500' : 'text-neutral-500 dark:text-neutral-400')}>
      {icon}
      {label}
    </span>
  );
}
