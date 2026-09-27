import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { MessageSquare, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { authStore } from '../../core/auth';
import { logActivity } from '../../core/activity';
import { db, type LocalRow } from '../../core/db';
import { mutate } from '../../core/sync/engine';
import { Avatar, IconButton, Menu, Popover, Textarea } from '../../core/ui';
import { useUsers } from '../../core/users';
import { relTime, uuid } from '../../core/utils';
import type { AppModule } from '../types';

export interface CommentRow extends LocalRow {
  targetType?: 'task' | 'page';
  targetId?: string;
  body?: string;
  authorId?: string;
  createdAt?: number;
  editedAt?: number;
  deleted?: boolean;
}

export function Comments({ targetType, targetId }: { targetType: 'task' | 'page'; targetId: string }) {
  const raw = useLiveQuery(() => db.comments.where('targetId').equals(targetId).toArray(), [targetId], []);
  const comments = ((raw ?? []) as CommentRow[]).filter((c) => !c.deleted && c.targetType === targetType).sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));
  const [draft, setDraft] = useState('');
  const me = authStore.get().user;
  const users = useUsers();
  const target = useLiveQuery(() => (targetType === 'task' ? db.tasks.get(targetId) : db.pages.get(targetId)), [targetId, targetType]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || !me) return;
    setDraft('');
    const id = uuid();
    await mutate('comments', id, { targetType, targetId, body, authorId: me.id, createdAt: Date.now() });
    logActivity('commented', targetType, targetId, String(target?.title ?? targetType));
  };

  return (
    <div className="border-t border-neutral-100 px-4 py-4 dark:border-neutral-800">
      <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-neutral-500 dark:text-neutral-400">
        <MessageSquare size={13} /> Comments {comments.length > 0 && <span className="text-neutral-300 dark:text-neutral-600">{comments.length}</span>}
      </p>
      <div className="flex flex-col gap-4">
        {comments.map((c) => (
          <CommentItem key={c.id} comment={c} isOwn={c.authorId === me?.id} authorName={users.find((u) => u.id === c.authorId)?.name ?? 'Someone'} authorColor={users.find((u) => u.id === c.authorId)?.color} />
        ))}
      </div>
      <div className="mt-4 flex items-start gap-2.5">
        {me && <Avatar name={me.name} color={me.color} size={24} className="mt-1.5" />}
        <div className="flex-1">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write a comment…"
            className="min-h-9 py-2 text-[13px]"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {draft.trim() && (
            <div className="mt-1.5 flex justify-end">
              <button className="rounded-lg bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white dark:bg-white dark:text-neutral-900" onClick={() => void submit()}>
                Comment
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CommentItem({ comment, isOwn, authorName, authorColor }: { comment: CommentRow; isOwn: boolean; authorName: string; authorColor?: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(String(comment.body ?? ''));

  return (
    <div className="group flex items-start gap-2.5">
      <Avatar name={authorName} color={authorColor} size={24} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium">{authorName}</span>
          <span className="text-[11px] text-neutral-400">
            {relTime(Number(comment.createdAt ?? 0))}
            {comment.editedAt ? ' · edited' : ''}
          </span>
          {isOwn && !editing && (
            <span className="opacity-0 transition-opacity group-hover:opacity-100">
              <Popover
                align="right"
                trigger={
                  <IconButton className="h-5 w-5" aria-label="Comment options">
                    <MoreHorizontal size={13} />
                  </IconButton>
                }
              >
                {(close) => (
                  <Menu
                    close={close}
                    items={[
                      { label: 'Edit', icon: Pencil, onClick: () => setEditing(true) },
                      { label: 'Delete', icon: Trash2, danger: true, onClick: () => void mutate('comments', comment.id, { deleted: true }) },
                    ]}
                  />
                )}
              </Popover>
            </span>
          )}
        </div>
        {editing ? (
          <div className="mt-1">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-9 py-1.5 text-[13px]" autoFocus />
            <div className="mt-1 flex gap-2">
              <button
                className="rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white dark:bg-white dark:text-neutral-900"
                onClick={async () => {
                  setEditing(false);
                  if (text.trim()) await mutate('comments', comment.id, { body: text.trim(), editedAt: Date.now() });
                }}
              >
                Save
              </button>
              <button className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="whitespace-pre-wrap text-[13px] leading-5 text-neutral-700 dark:text-neutral-300">{String(comment.body ?? '')}</p>
        )}
      </div>
    </div>
  );
}

export const commentsModule: AppModule = {
  id: 'comments',
  label: 'Comments',
  icon: MessageSquare,
  routes: [],
  collections: ['comments'],
  slots: {
    taskDetail: ({ taskId }) => <Comments targetType="task" targetId={taskId} />,
    pageFooter: ({ pageId }) => (
      <div className="mt-8">
        <Comments targetType="page" targetId={pageId} />
      </div>
    ),
  },
};
