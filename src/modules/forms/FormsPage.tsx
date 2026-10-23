import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, ClipboardList, ExternalLink, Plus } from 'lucide-react';
import { db, type LocalRow } from '../../core/db';
import { Button, EmptyState, Spinner } from '../../core/ui';
import { useBoard } from '../boards/api';
import { saveForm } from './api';

export interface FormRow extends LocalRow {
  databaseId?: string;
  title?: string;
  description?: string;
  fields?: unknown[];
  enabled?: boolean;
  deleted?: boolean;
}

export function useForms(boardId: string | undefined): FormRow[] {
  const rows = useLiveQuery(() => db.collection('forms').toArray(), [], []) as FormRow[] | undefined;
  return (rows ?? []).filter((f) => !f.deleted && (!boardId || f.databaseId === boardId));
}

/** /forms/:boardId — forms bound to one database. Entry point is the
 *  database ⋯ menu ("Forms…"). */
export function FormsPage() {
  const { boardId } = useParams();
  const board = useBoard(boardId);
  const forms = useForms(boardId);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  if (boardId && board === null) return <Navigate to="/boards" replace />;

  const create = async () => {
    if (!boardId || creating) return;
    setCreating(true);
    try {
      const { id } = await saveForm(undefined, {
        databaseId: boardId,
        title: 'Untitled form',
        fields: [{ fieldKey: 'title', label: 'Name', required: true, order: 0 }],
        successMessage: 'Thanks — your response has been recorded.',
        enabled: false,
        notifyUserIds: [],
      });
      navigate(`/forms/${boardId}/${id}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-neutral-200/70 px-4 py-2.5 dark:border-neutral-800/70">
        <Link to={`/boards/${boardId}`} className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800" aria-label="Back to database">
          <ArrowLeft size={17} />
        </Link>
        <h1 className="text-base font-semibold tracking-tight">
          Forms {board?.name ? <span className="font-normal text-neutral-600 dark:text-neutral-400">· {String(board.name)}</span> : null}
        </h1>
        <span className="flex-1" />
        <Button size="sm" onClick={() => void create()} disabled={creating}>
          {creating ? <Spinner size={13} /> : <Plus size={14} />} New form
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!forms.length ? (
          <EmptyState
            icon={ClipboardList}
            title="No forms yet"
            body="Publish a public intake link — each submission lands as a record in this database."
            action={
              <Button size="sm" onClick={() => void create()} disabled={creating}>
                <Plus size={14} /> Create a form
              </Button>
            }
          />
        ) : (
          <ul className="mx-auto flex max-w-2xl flex-col gap-2">
            {forms.map((f) => (
              <li key={f.id}>
                <Link
                  to={`/forms/${boardId}/${f.id}`}
                  className="flex items-center gap-3 rounded-xl border border-neutral-200 px-4 py-3 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
                >
                  <ClipboardList size={17} className="shrink-0 text-neutral-600 dark:text-neutral-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{String(f.title ?? 'Untitled form')}</span>
                    <span className="block truncate text-xs text-neutral-600 dark:text-neutral-400">
                      {(f.fields ?? []).length} field{(f.fields ?? []).length === 1 ? '' : 's'}
                    </span>
                  </span>
                  {f.enabled ? (
                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      <ExternalLink size={10} /> Live
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">Off</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

