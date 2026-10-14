import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Archive, ArchiveRestore, ImagePlus, Paperclip, Trash2, X } from 'lucide-react';
import { authStore } from '../../core/auth';
import { db } from '../../core/db';
import { addFile, deleteFile, useAttachments, useFileUrl, type FileRow } from '../../core/files';
import { AudioPlayer, FileImage, FilePreview, Lightbox } from '../../core/fileui';
import { RecordButton } from '../../core/recorder';
import { useIsMobile } from '../../core/mobile';
import { PresenceStack } from '../../core/presence';
import { Avatar, IconButton, Select, Sheet } from '../../core/ui';
import { resolveUser, useUsers } from '../../core/users';
import { useStore } from '../../core/store';
import { cn, debounce, todayISO } from '../../core/utils';
import { modules } from '..';
import { Slot } from '../slots';
import { columnsOf, columnIdFor, deleteTask, isDone, moveTaskToBoard, PRIORITIES, setTaskField, taskBoardId, useBoards, type TaskRow } from './api';
import { noteGatedMove } from './GateMove';
import { fieldsOf } from './model';
import { FieldRow } from './FieldValue';
import { archivePatch, isArchived } from '../../../shared/archive';

export function TaskDetail({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const mobile = useIsMobile();
  const inner = <DetailBody taskId={taskId} onClose={onClose} />;
  if (mobile) return <Sheet onClose={onClose} side="bottom">{inner}</Sheet>;
  return <aside className="anim-slide-right flex w-[400px] shrink-0 flex-col border-l border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-neutral-950">{inner}</aside>;
}

function DetailBody({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const task = useLiveQuery(() => db.tasks.get(taskId), [taskId]) as TaskRow | undefined;
  const users = useUsers();
  const boards = useBoards();
  const files = useAttachments(taskId);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !lightbox) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, lightbox]);

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
    return <div className="flex h-full items-center justify-center text-sm text-neutral-400">Task not found</div>;
  }

  const board = boards.find((b) => b.id === taskBoardId(task));
  const cols = columnsOf(board);
  const curCol = columnIdFor(task, board);
  const done = isDone(task, board);
  const overdue = task.dueDate && String(task.dueDate) < todayISO() && !done;

  const images = files.filter((f) => f.kind === 'image');
  const audios = files.filter((f) => f.kind === 'audio');
  const videos = files.filter((f) => f.kind === 'video');
  const others = files.filter((f) => f.kind === 'file' || f.kind === 'pdf');
  const coverId = task.coverFileId ?? images[0]?.id;

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    for (const f of Array.from(list)) {
      try {
        await addFile(f, { parentType: 'task', parentId: task.id });
      } catch {
        /* toast already shown */
      }
    }
  };

  return (
    <>
      <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-2.5 dark:border-neutral-800">
        <span className="flex items-center gap-1.5 text-xs font-medium text-neutral-400">
          <span>{String(board?.icon ?? '🗂️')}</span> {String(board?.name ?? 'Board')}
        </span>
        <div className="flex items-center gap-1">
          <PresenceStack path={`/boards/${taskBoardId(task)}/tasks/${task.id}`} />
          <IconButton aria-label={isArchived(task) ? 'Unarchive task' : 'Archive task'} onClick={() => void setTaskField(task.id, archivePatch(!isArchived(task)))}>
            {isArchived(task) ? <ArchiveRestore size={15} /> : <Archive size={15} />}
          </IconButton>
          <IconButton aria-label="Delete task" onClick={async () => { await deleteTask(task.id); onClose(); }}>
            <Trash2 size={15} />
          </IconButton>
          <IconButton onClick={onClose} aria-label="Close">
            <X size={16} />
          </IconButton>
        </div>
      </div>
      {isArchived(task) && (
        <div className="flex items-center gap-2 border-b border-neutral-100 bg-neutral-50 px-4 py-1.5 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          <Archive size={12} />
          <span className="flex-1">Archived</span>
          <button className="rounded-md px-2 py-0.5 font-medium text-neutral-700 hover:bg-neutral-200/70 dark:text-neutral-200 dark:hover:bg-neutral-800" onClick={() => void setTaskField(task.id, archivePatch(false))}>
            Unarchive
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* cover */}
        {coverId && (
          <div className="relative h-40 w-full overflow-hidden bg-neutral-100 dark:bg-neutral-800">
            <FileImage fileId={coverId} className="h-full w-full" alt="cover" />
          </div>
        )}
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
            <span className="text-xs text-neutral-400">Board</span>
            <Select value={board?.id ?? ''} onChange={(e) => void moveTaskToBoard(task.id, e.target.value)} className="py-1.5">
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {String(b.icon ?? '')} {String(b.name ?? '')}
                </option>
              ))}
            </Select>
            <span className="text-xs text-neutral-400">Stage</span>
            <Select
              value={curCol}
              onChange={(e) => {
                noteGatedMove(board, task.id, e.target.value); // P4-D: gated stage → request dialog
                void setTaskField(task.id, { status: e.target.value });
              }}
              className="py-1.5"
            >
              {cols.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
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
              className={cn('w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:ring-white/10', overdue && 'border-red-300 text-red-600 dark:border-red-800 dark:text-red-400')}
            />
            {fieldsOf(board).map((f) => (
              <FieldRow key={f.id} field={f} task={task} />
            ))}
          </div>
          <div className="mt-4">
            <span className="mb-1 block text-xs text-neutral-400">Description</span>
            <textarea
              value={desc}
              rows={4}
              placeholder="Add details…"
              className="-m-1 w-full resize-none overflow-hidden rounded-lg bg-transparent p-1 text-sm leading-6 outline-none placeholder:text-neutral-300 focus:bg-neutral-50 dark:placeholder:text-neutral-600 dark:focus:bg-neutral-900/60"
              onChange={(e) => {
                setDesc(e.target.value);
                debouncedDesc.current(task.id, e.target.value);
              }}
              onBlur={() => debouncedDesc.current.flush(task.id, desc)}
            />
          </div>

          {/* attachments */}
          <Attachments task={task} files={files} images={images} audios={audios} videos={videos} others={others} coverId={coverId} onLightbox={setLightbox} />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input ref={photoInput} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void addFiles(e.target.files).then(() => { if (photoInput.current) photoInput.current.value = ''; })} />
            <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => void addFiles(e.target.files).then(() => { if (fileInput.current) fileInput.current.value = ''; })} />
            <button onClick={() => photoInput.current?.click()} className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800">
              <ImagePlus size={13} /> Add photo
            </button>
            <button onClick={() => fileInput.current?.click()} className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800">
              <Paperclip size={13} /> Add file
            </button>
            <RecordButton onDone={(blob) => void addFile(new File([blob], `voice-${Date.now()}.webm`, { type: blob.type }), { parentType: 'task', parentId: task.id, transcriptState: 'pending' })} />
          </div>

          <div className="mt-3 flex items-center gap-2 text-xs text-neutral-400">
            {task.createdBy && <Creator id={String(task.createdBy)} />}
            {task.createdAt && <span>{new Date(Number(task.createdAt)).toLocaleDateString()}</span>}
          </div>
        </div>
        <Slot modules={modules} kind="taskDetail" props={{ taskId: task.id }} />
      </div>
      {lightbox && <Lightbox files={images} startId={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}

function Attachments({ task, files, images, audios, videos, others, coverId, onLightbox }: { task: TaskRow; files: FileRow[]; images: FileRow[]; audios: FileRow[]; videos: FileRow[]; others: FileRow[]; coverId?: string; onLightbox: (id: string) => void }) {
  if (files.length === 0) return null;
  return (
    <div className="mt-5">
      <span className="mb-2 block text-xs font-semibold text-neutral-500 dark:text-neutral-400">Attachments · {files.length}</span>
      {images.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5">
          {images.map((f) => (
            <div key={f.id} className="group/img relative aspect-square overflow-hidden rounded-lg bg-neutral-100 dark:bg-neutral-800">
              <button className="block h-full w-full" onClick={() => onLightbox(f.id)} aria-label={`View ${f.name}`}>
                <FileImage fileId={f.id} className="h-full w-full" />
              </button>
              <div className="absolute inset-x-0 bottom-0 flex justify-between bg-gradient-to-t from-black/50 to-transparent p-1 opacity-0 transition-opacity group-hover/img:opacity-100">
                {coverId === f.id ? (
                  <span className="rounded bg-black/60 px-1 py-0.5 text-[10px] text-white">Cover</span>
                ) : (
                  <button className="rounded bg-black/60 px-1 py-0.5 text-[10px] text-white hover:bg-black/80" onClick={(e) => { e.stopPropagation(); void setTaskField(task.id, { coverFileId: f.id }); }}>
                    Set cover
                  </button>
                )}
                <button className="rounded bg-black/60 px-1 py-0.5 text-[10px] text-white hover:bg-black/80" onClick={(e) => { e.stopPropagation(); void deleteFile(f.id); }} aria-label="Delete image">
                  <Trash2 size={10} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {audios.map((f) => (
        <AudioPlayer key={f.id} file={f} onDelete={() => void deleteFile(f.id)} />
      ))}
      {videos.map((f) => (
        <VideoFile key={f.id} file={f} />
      ))}
      {others.map((f) => (
        <div key={f.id} className="mt-2"><FilePreview file={f} /></div>
      ))}
    </div>
  );
}

function VideoFile({ file }: { file: FileRow }) {
  const { url } = useFileUrl(file.id);
  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-neutral-200/80 dark:border-neutral-800">
      {url ? <video src={url} controls playsInline className="max-h-64 w-full bg-black" /> : <div className="flex h-24 items-center justify-center text-xs text-neutral-400">Video not synced yet</div>}
    </div>
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
