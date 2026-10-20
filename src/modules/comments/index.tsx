import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { MessageSquare, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { authStore } from '../../core/auth';
import { logActivity } from '../../core/activity';
import { db, type LocalRow } from '../../core/db';
import { useIsMobile } from '../../core/mobile';
import { commentTargetStore } from '../../core/commentui';
import { useStore } from '../../core/store';
import { mutate } from '../../core/sync/engine';
import { Avatar, IconButton, Menu, Popover, Sheet, Textarea } from '../../core/ui';
import { resolveUser, useUsers } from '../../core/users';
import { cn, relTime, uuid } from '../../core/utils';
import type { AppModule } from '../types';

export type CommentTarget = 'task' | 'page' | 'block' | 'mooditem';

export interface CommentRow extends LocalRow {
  targetType?: CommentTarget;
  targetId?: string;
  body?: string;
  authorId?: string;
  createdAt?: number;
  editedAt?: number;
  deleted?: boolean;
}

/** Non-deleted comment count for any target (badges on blocks/mood items). */
export function useCommentCount(targetId: string | undefined): number {
  return useLiveQuery(() => (targetId ? db.comments.where('targetId').equals(targetId).filter((c) => !c.deleted).count() : Promise.resolve(0)), [targetId], 0) ?? 0;
}

async function targetTitle(targetType: CommentTarget, targetId: string): Promise<string> {
  if (targetType === 'task') {
    const t = await db.tasks.get(targetId);
    return String(t?.title ?? 'task');
  }
  if (targetType === 'page') {
    const p = await db.pages.get(targetId);
    return String(p?.title ?? 'page');
  }
  if (targetType === 'block') {
    const b = await db.blocks.get(targetId);
    const p = b?.pageId ? await db.pages.get(String(b.pageId)) : undefined;
    return String(p?.title ?? 'page');
  }
  const item = await db.mooditems.get(targetId);
  const mb = item?.boardId ? await db.moodboards.get(String(item.boardId)) : undefined;
  return String(item?.text ?? mb?.title ?? 'mood board');
}

/**
 * Instagram-style thread: avatar, **name** inline with the text, muted
 * relative time below; composer pinned to the bottom.
 */
export function CommentThread({ targetType, targetId, compact }: { targetType: CommentTarget; targetId: string; compact?: boolean }) {
  const raw = useLiveQuery(() => db.comments.where('targetId').equals(targetId).toArray(), [targetId], []);
  const comments = ((raw ?? []) as CommentRow[]).filter((c) => !c.deleted && c.targetType === targetType).sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));
  const [draft, setDraft] = useState('');
  const me = authStore.get().user;
  const users = useUsers();

  const submit = async () => {
    const body = draft.trim();
    if (!body || !me) return;
    setDraft('');
    const id = uuid();
    await mutate('comments', id, { targetType, targetId, body, authorId: me.id, createdAt: Date.now() });
    logActivity('commented', targetType, targetId, await targetTitle(targetType, targetId));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn('flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto', compact ? 'px-4 py-3' : 'py-1')}>
        {comments.length === 0 && <p className="py-4 text-center text-xs text-neutral-500 dark:text-neutral-400">No comments yet</p>}
        {comments.map((c) => {
          const author = resolveUser(c.authorId ?? null, users, me);
          return <CommentItem key={c.id} comment={c} isOwn={c.authorId === me?.id} authorName={author?.name ?? 'Someone'} authorColor={author?.color} />;
        })}
      </div>
      <div className={cn('flex shrink-0 items-center gap-2.5 border-t border-neutral-100 pt-3 dark:border-neutral-800', compact && 'mx-4 pb-3')}>
        {me && <Avatar name={me.name} color={me.color} size={26} />}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a comment…"
          className="h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-neutral-400"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button
          onClick={() => void submit()}
          disabled={!draft.trim()}
          className="shrink-0 text-[13px] font-semibold text-blue-500 transition-opacity disabled:opacity-30"
        >
          Post
        </button>
      </div>
    </div>
  );
}

/** Section used in the task detail / page footer slots. */
export function Comments({ targetType, targetId }: { targetType: CommentTarget; targetId: string }) {
  const count = useCommentCount(targetId);
  return (
    <div className="border-t border-neutral-100 px-4 py-4 dark:border-neutral-800">
      <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-neutral-500 dark:text-neutral-400">
        <MessageSquare size={13} /> Comments {count > 0 && <span className="text-neutral-300 dark:text-neutral-600">{count}</span>}
      </p>
      <CommentThread targetType={targetType} targetId={targetId} />
    </div>
  );
}

function CommentItem({ comment, isOwn, authorName, authorColor }: { comment: CommentRow; isOwn: boolean; authorName: string; authorColor?: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(String(comment.body ?? ''));

  return (
    <div className="group flex items-start gap-2.5">
      <Avatar name={authorName} color={authorColor} size={26} className="mt-0.5" />
      <div className="min-w-0 flex-1">
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
          <>
            <p className="text-[13px] leading-5 text-neutral-700 dark:text-neutral-300">
              <span className="font-semibold text-neutral-900 dark:text-white">{authorName}</span>{' '}
              <span className="whitespace-pre-wrap">{String(comment.body ?? '')}</span>
            </p>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-neutral-400">
              {relTime(Number(comment.createdAt ?? 0))}
              {comment.editedAt ? '· edited' : ''}
              {isOwn && (
                <span className="opacity-0 transition-opacity group-hover:opacity-100">
                  <Popover
                    align="left"
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
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Comment badge for a block / mood item. Desktop: icon + count opens a
 * popover thread (icon is hover-only when the count is 0). Mobile: the badge
 * shows the count and the thread opens as a bottom sheet — entry point is the
 * block "…" menu (openCommentThread) or tapping the badge.
 */
function CommentBadge({ targetType, targetId, overlay }: { targetType: CommentTarget; targetId: string; overlay?: boolean }) {
  const mobile = useIsMobile();
  const count = useCommentCount(targetId);
  const openTarget = useStore(commentTargetStore);
  const [open, setOpen] = useState(false);
  const isOpen = open || openTarget === targetId;
  const close = () => {
    setOpen(false);
    if (openTarget === targetId) commentTargetStore.set(null);
  };

  const badge = (
    <button
      aria-label={`Comments${count ? ` (${count})` : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        setOpen(true);
      }}
      className={cn(
        'flex items-center gap-1 rounded-md px-1.5 py-1 text-neutral-400 transition-all hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300',
        overlay
          ? 'bg-white/90 shadow-sm dark:bg-neutral-900/90'
          : cn('mt-0.5', mobile ? (count > 0 ? '' : 'hidden') : count > 0 ? '' : 'opacity-0 group-hover:opacity-100'),
      )}
    >
      <MessageSquare size={overlay ? 12 : 13} />
      {count > 0 && <span className="text-[10px] font-semibold">{count}</span>}
    </button>
  );

  return (
    <>
      {!mobile ? (
        <span className={overlay ? 'absolute right-1.5 top-1.5 z-10' : 'inline-flex'}>
          <Popover
            open={isOpen}
            onOpenChange={(v) => (v ? setOpen(true) : close())}
            align="right"
            trigger={badge}
            className={cn('w-72', overlay && 'mt-6')}
          >
            {() => (
              <div className="flex h-80 flex-col">
                <p className="border-b border-neutral-100 px-4 py-2.5 text-xs font-semibold dark:border-neutral-800">Comments</p>
                <CommentThread targetType={targetType} targetId={targetId} compact />
              </div>
            )}
          </Popover>
        </span>
      ) : (
        <>
          {badge}
          {isOpen && (
            <Sheet side="bottom" onClose={close}>
              <div className="flex h-full flex-col">
                <p className="border-b border-neutral-100 px-4 py-3 text-xs font-semibold dark:border-neutral-800">Comments</p>
                <CommentThread targetType={targetType} targetId={targetId} compact />
              </div>
            </Sheet>
          )}
        </>
      )}
    </>
  );
}

export const commentsModule: AppModule = {
  id: 'comments',
  label: 'Comments',
  icon: MessageSquare,
  routes: [],
  collections: ['comments'],
  slots: {
    commentBadge: CommentBadge,
    taskDetail: ({ taskId }) => <Comments targetType="task" targetId={taskId} />,
    pageFooter: ({ pageId }) => (
      <div className="mt-8">
        <Comments targetType="page" targetId={pageId} />
      </div>
    ),
  },
};
