import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Spinner } from '../core/ui';
import { cn } from '../core/utils';

interface PubNode {
  id: string;
  title: string;
  icon: string;
  parentId: string | null;
}

interface PubMention {
  kind: string;
  id: string;
  label: string;
  inTree: boolean;
}

interface PubBlock {
  id: string;
  type: string;
  text: string;
  checked?: boolean;
  fileId?: string | null;
  caption?: string;
  boardId?: string | null;
  mentions: PubMention[];
}

interface PubTask {
  id: string;
  title: string;
  stage: string;
  coverFileId?: string | null;
}

const MENTION_RE = /@\[(page|user):([A-Za-z0-9_-]+)\]/g;

function fileUrl(token: string, fileId: string | null | undefined): string {
  return `/api/public/${token}/files/${fileId}`;
}

/** Render block text with mention chips resolved (links only inside the tree). */
function RichText({ text, mentions, token }: { text: string; mentions: PubMention[]; token: string }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  const byToken = new Map(mentions.map((m) => [`@[${m.kind}:${m.id}]`, m]));
  for (const m of text.matchAll(MENTION_RE)) {
    out.push(text.slice(last, m.index));
    const men = byToken.get(m[0]);
    const label = men?.label ?? 'mention';
    if (men?.kind === 'page' && men.inTree) {
      out.push(
        <Link key={i} to={`/s/${token}/${men.id}`} className="rounded bg-blue-50 px-1 py-0.5 font-medium text-blue-700 hover:underline dark:bg-blue-950 dark:text-blue-300">
          {label}
        </Link>,
      );
    } else {
      out.push(
        <span key={i} className={cn('rounded px-1 py-0.5 font-medium', men?.kind === 'user' ? 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300' : 'bg-neutral-100 dark:bg-neutral-800')}>
          {label}
        </span>,
      );
    }
    last = (m.index ?? 0) + m[0].length;
    i += 1;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

function Block({ block, token, taskBlocks }: { block: PubBlock; token: string; taskBlocks: Record<string, PubTask[]> }) {
  const text = <RichText text={String(block.text ?? '')} mentions={block.mentions ?? []} token={token} />;
  switch (block.type) {
    case 'h1':
      return <h1 className="mt-6 mb-1 text-3xl font-bold tracking-tight">{text}</h1>;
    case 'h2':
      return <h2 className="mt-5 mb-1 text-2xl font-semibold tracking-tight">{text}</h2>;
    case 'h3':
      return <h3 className="mt-4 mb-1 text-xl font-semibold">{text}</h3>;
    case 'bullet':
      return (
        <p className="my-0.5 flex gap-2 pl-1">
          <span className="text-neutral-400">•</span>
          <span>{text}</span>
        </p>
      );
    case 'number':
      return (
        <p className="my-0.5 flex gap-2 pl-1">
          <span className="text-neutral-400">1.</span>
          <span>{text}</span>
        </p>
      );
    case 'todo':
      return (
        <p className="my-0.5 flex items-center gap-2">
          <span className={cn('flex h-4 w-4 items-center justify-center rounded border', block.checked ? 'border-blue-500 bg-blue-500 text-white' : 'border-neutral-300 dark:border-neutral-600')}>
            {block.checked && '✓'}
          </span>
          <span className={block.checked ? 'text-neutral-400 line-through' : ''}>{text}</span>
        </p>
      );
    case 'divider':
      return <hr className="my-4 border-neutral-200 dark:border-neutral-800" />;
    case 'image':
      return block.fileId ? (
        <figure className="my-4">
          <img src={fileUrl(token, block.fileId)} alt={block.caption ?? ''} className="max-h-[70vh] w-auto rounded-xl" loading="lazy" />
          {block.caption && <figcaption className="mt-1.5 text-xs text-neutral-400">{block.caption}</figcaption>}
        </figure>
      ) : null;
    case 'video':
      return block.fileId ? <video controls playsInline className="my-4 max-h-[70vh] w-full rounded-xl bg-black" src={fileUrl(token, block.fileId)} /> : null;
    case 'audio':
      return block.fileId ? <audio controls className="my-3 w-full" src={fileUrl(token, block.fileId)} /> : null;
    case 'file':
      return block.fileId ? (
        <div className="my-4 overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800">
          <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2 text-xs dark:border-neutral-800">
            <span className="truncate font-medium">{block.caption || 'Attachment'}</span>
            <a href={fileUrl(token, block.fileId)} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">
              Open
            </a>
          </div>
          <iframe title="preview" src={fileUrl(token, block.fileId)} className="h-[60vh] w-full bg-white" />
        </div>
      ) : null;
    case 'tasks': {
      const tasks = taskBlocks[block.id] ?? [];
      return (
        <div className="my-4 overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800">
          {tasks.length === 0 && <p className="px-3 py-2 text-xs text-neutral-400">No tasks</p>}
          {tasks.map((t) => (
            <div key={t.id} className="flex items-center gap-2.5 border-b border-neutral-100 px-3 py-2 last:border-0 dark:border-neutral-800">
              {t.coverFileId && <img src={fileUrl(token, t.coverFileId)} alt="" className="h-8 w-8 rounded-md object-cover" loading="lazy" />}
              <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
              <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">{t.stage}</span>
            </div>
          ))}
        </div>
      );
    }
    default:
      return <p className="my-1">{text}</p>;
  }
}

export function PublicView() {
  const { token = '', pageId } = useParams();
  const [error, setError] = useState<'inactive' | 'missing' | null>(null);
  const [tree, setTree] = useState<{ page: PubNode; tree: PubNode[] } | null>(null);
  const [data, setData] = useState<{ page: PubNode; blocks: PubBlock[]; taskBlocks: Record<string, PubTask[]> } | null>(null);

  // noindex + title for shared pages
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    const prev = document.title;
    return () => {
      meta.remove();
      document.title = prev;
    };
  }, []);

  useEffect(() => {
    let dead = false;
    void fetch(`/api/public/${token}`)
      .then(async (r) => {
        if (dead) return;
        if (r.status === 404) return setError('inactive');
        const j = (await r.json()) as { page: PubNode; tree: PubNode[] };
        setTree(j);
        document.title = `${j.page.title} · Shared`;
      })
      .catch(() => !dead && setError('inactive'));
    return () => {
      dead = true;
    };
  }, [token]);

  const currentId = pageId ?? tree?.page.id;
  useEffect(() => {
    if (!currentId) return;
    let dead = false;
    void fetch(`/api/public/${token}/pages/${currentId}`)
      .then(async (r) => {
        if (dead) return;
        if (!r.ok) {
          const j = (await r.json().catch(() => null)) as { error?: string } | null;
          return setError(j?.error === 'inactive' ? 'inactive' : 'missing');
        }
        setData(await r.json());
      })
      .catch(() => !dead && setError('missing'));
    return () => {
      dead = true;
    };
  }, [token, currentId]);

  if (error === 'inactive')
    return (
      <Center>
        <p className="text-5xl">🔗</p>
        <h1 className="text-lg font-semibold">This link is no longer active</h1>
        <p className="text-sm text-neutral-400">The owner may have stopped sharing this page.</p>
      </Center>
    );
  if (error === 'missing')
    return (
      <Center>
        <p className="text-5xl">📄</p>
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="text-sm text-neutral-400">This page isn't part of the shared pages.</p>
      </Center>
    );
  if (!tree || !data || data.page.id !== currentId)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={20} />
      </div>
    );

  const children = tree.tree.filter((n) => n.parentId === currentId);
  return (
    <div className="min-h-full bg-white dark:bg-neutral-950">
      <div className="mx-auto max-w-3xl px-5 pb-16 pt-10 sm:px-8">
        <p className="mb-1 text-xs text-neutral-400">{tree.page.id !== currentId && <Link to={`/s/${token}`} className="hover:text-neutral-600 dark:hover:text-neutral-300">{tree.page.icon} {tree.page.title} /</Link>}</p>
        <div className="mb-6 flex items-center gap-3">
          <span className="text-4xl leading-none">{data.page.icon}</span>
          <h1 className="text-4xl font-bold tracking-tight">{data.page.title}</h1>
        </div>
        {data.blocks.map((b) => (
          <Block key={b.id} block={b} token={token} taskBlocks={data.taskBlocks} />
        ))}
        {children.length > 0 && (
          <div className="mt-8 border-t border-neutral-100 pt-4 dark:border-neutral-800">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">Pages</p>
            {children.map((n) => (
              <Link key={n.id} to={`/s/${token}/${n.id}`} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800">
                <span>{n.icon || '📄'}</span> {n.title || 'Untitled'}
              </Link>
            ))}
          </div>
        )}
        <footer className="mt-14 border-t border-neutral-100 pt-4 text-center text-[11px] text-neutral-400 dark:border-neutral-800">Shared from Workspace</footer>
      </div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">{children}</div>;
}
