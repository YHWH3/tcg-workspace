import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ShieldCheck } from 'lucide-react';
import { authStore } from '../../core/auth';
import { db } from '../../core/db';
import { useStore } from '../../core/store';
import { AdaptiveDialog, Field, Select, Textarea } from '../../core/ui';
import { resolveUser, useUsers } from '../../core/users';
import { cn, relTime } from '../../core/utils';
import { useBoards, columnsOf, taskBoardId, type TaskRow } from '../boards/api';
import { approvalsApi, gateOf, type Approval, type ApprovalTargetType } from './api';
import type { AppModule } from '../types';

function useApprovals(targetId: string) {
  const [rows, setRows] = useState<Approval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const res = await approvalsApi.list(targetId);
      setRows(res.approvals);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load');
    }
  }, [targetId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { rows, error, refresh };
}

/** Approvals section — the record/page "⋯ → Request approval" entry lives
 * here via the taskDetail / pageFooter slots (module-owned UI only). Approvals
 * are server-only D1 rows: this list is REST-fetched, never synced, so a
 * member can never mint or edit one through the generic write path. */
export function ApprovalsSection({ targetType, targetId }: { targetType: ApprovalTargetType; targetId: string }) {
  const me = useStore(authStore).user;
  const users = useUsers();
  const boards = useBoards();
  const { rows, error, refresh } = useApprovals(targetId);
  const [requestOpen, setRequestOpen] = useState(false);

  const task = useLiveQuery(() => (targetType === 'record' ? (db.tasks.get(targetId) as Promise<TaskRow | undefined>) : Promise.resolve(undefined)), [targetType, targetId]);
  const board = targetType === 'record' ? boards.find((b) => b.id === taskBoardId(task ?? {})) : undefined;
  const gate = gateOf(board);
  const cols = useMemo(() => columnsOf(board), [board]);
  const stageName = (id: string | null) => (id ? (cols.find((c) => c.id === id)?.name ?? id) : null);

  // A rejected outbox row proves a gated-stage attempt bounced off the gate —
  // show the approval_required state honestly plus the request affordance.
  const rejected = useLiveQuery(
    () => db.outbox.where('id').equals(targetId).filter((e) => e.state === 'rejected' && e.rejectReason === 'approval_required').toArray(),
    [targetId],
    [],
  );
  const gatedAttempt = (rejected ?? []).length > 0;
  const attemptedStage = String((rejected ?? []).map((e) => e.patch?.status).find((s) => typeof s === 'string') ?? gate?.stageId ?? '');

  const pending = (rows ?? []).filter((r) => r.status === 'pending');
  const history = (rows ?? []).filter((r) => r.status !== 'pending');
  const requiredApproverId = gate?.approverField ? String(task?.[`p_${gate.approverField}`] ?? '') : '';

  return (
    <div className="border-t border-neutral-100 px-4 py-4 dark:border-neutral-800">
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-neutral-500 dark:text-neutral-400">
          <ShieldCheck size={13} /> Approvals {pending.length > 0 && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">{pending.length}</span>}
        </p>
        <button
          onClick={() => setRequestOpen(true)}
          className="rounded-md px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Request approval
        </button>
      </div>

      {error && <p className="mb-2 text-xs text-neutral-600 dark:text-neutral-400">Approvals need a connection — {error}</p>}

      {gatedAttempt && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-900/50 dark:bg-amber-950/30">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-300">Approval required{attemptedStage && stageName(attemptedStage) ? ` — moving to “${stageName(attemptedStage)}”` : ''} is gated</p>
          <p className="mt-0.5 text-[11px] leading-4 text-amber-700/80 dark:text-amber-400/80">
            Kept locally, rejected by the server — it syncs only after {requiredApproverId ? 'the required approver' : 'an approver'} approves.
          </p>
          <button
            onClick={() => setRequestOpen(true)}
            className="mt-2 rounded-md bg-amber-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-amber-700"
          >
            Request approval
          </button>
        </div>
      )}

      {pending.map((a) => (
        <PendingRow key={a.id} approval={a} me={me?.id ?? ''} stageName={stageName} users={users} onDone={() => void refresh()} />
      ))}

      {history.length > 0 && (
        <div className={cn(pending.length > 0 && 'mt-3')}>
          {history.map((a) => (
            <HistoryRow key={a.id} approval={a} stageName={stageName} users={users} />
          ))}
        </div>
      )}

      {!error && rows !== null && rows.length === 0 && !gatedAttempt && <p className="text-xs text-neutral-500 dark:text-neutral-400">No approvals on this {targetType}.</p>}

      {requestOpen && (
        <RequestDialog
          targetType={targetType}
          targetId={targetId}
          defaultStageId={attemptedStage || gate?.stageId || ''}
          defaultApproverId={requiredApproverId}
          stages={cols}
          onClose={() => setRequestOpen(false)}
          onDone={() => {
            setRequestOpen(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function PendingRow({ approval, me, stageName, users, onDone }: { approval: Approval; me: string; stageName: (id: string | null) => string | null; users: ReturnType<typeof useUsers>; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const requester = resolveUser(approval.requestedBy, users, null);
  const approver = resolveUser(approval.approverId, users, null);
  const isApprover = approval.approverId === me;
  const isRequester = approval.requestedBy === me;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
      setBusy(false);
    }
  };

  return (
    <div className="mb-2 rounded-lg border border-neutral-200/80 px-3 py-2.5 dark:border-neutral-800">
      <p className="text-[13px] text-neutral-800 dark:text-neutral-200">
        <span className="font-semibold">{requester?.name ?? 'Someone'}</span> requested approval
        {stageName(approval.stageId) ? (
          <>
            {' '}for <span className="font-semibold">“{stageName(approval.stageId)}”</span>
          </>
        ) : (
          ''
        )}{' '}
        from <span className="font-semibold">{approver?.name ?? 'a member'}</span>
      </p>
      {approval.note && <p className="mt-1 text-xs italic text-neutral-500 dark:text-neutral-400">“{approval.note}”</p>}
      <p className="mt-0.5 text-[11px] text-neutral-600 dark:text-neutral-400">{relTime(approval.createdAt)}</p>

      {isApprover && (
        <div className="mt-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Decision note (optional)"
            className="mb-1.5 h-8 w-full rounded-md border border-neutral-200 bg-transparent px-2 text-xs outline-none focus:ring-1 focus:ring-neutral-400 dark:border-neutral-700"
          />
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={() => void act(() => approvalsApi.decide(approval.id, 'approved', note.trim() || undefined, approval.rev))}
              className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-neutral-800 disabled:opacity-40 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              Approve
            </button>
            <button
              disabled={busy}
              onClick={() => void act(() => approvalsApi.decide(approval.id, 'rejected', note.trim() || undefined, approval.rev))}
              className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-semibold text-neutral-700 hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Reject
            </button>
          </div>
        </div>
      )}
      {isRequester && !isApprover && (
        <button
          disabled={busy}
          onClick={() => void act(() => approvalsApi.cancel(approval.id))}
          className="mt-2 text-[11px] font-medium text-neutral-600 dark:text-neutral-400 hover:text-neutral-600 disabled:opacity-40 dark:hover:text-neutral-300"
        >
          Cancel request
        </button>
      )}
      {err && <p className="mt-1 text-[11px] text-red-500">{err}</p>}
    </div>
  );
}

function HistoryRow({ approval, stageName, users }: { approval: Approval; stageName: (id: string | null) => string | null; users: ReturnType<typeof useUsers> }) {
  const requester = resolveUser(approval.requestedBy, users, null);
  const approver = resolveUser(approval.approverId, users, null);
  const chip =
    approval.status === 'approved'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
      : approval.status === 'rejected'
        ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
        : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400';
  return (
    <div className="flex items-start gap-2 py-1.5">
      <span className={cn('mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold capitalize', chip)}>{approval.status}</span>
      <div className="min-w-0 text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">
        <span className="text-neutral-700 dark:text-neutral-300">{requester?.name ?? 'Someone'}</span> → {approver?.name ?? 'member'}
        {stageName(approval.stageId) ? ` · “${stageName(approval.stageId)}”` : ''}
        {approval.decidedAt ? ` · ${relTime(approval.decidedAt)}` : ''}
        {approval.decidedNote ? <span className="block italic">“{approval.decidedNote}”</span> : null}
      </div>
    </div>
  );
}

function RequestDialog({
  targetType,
  targetId,
  defaultStageId,
  defaultApproverId,
  stages,
  onClose,
  onDone,
}: {
  targetType: ApprovalTargetType;
  targetId: string;
  defaultStageId: string;
  defaultApproverId: string;
  stages: { id: string; name: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const users = useUsers();
  const [approverId, setApproverId] = useState(defaultApproverId);
  const [stageId, setStageId] = useState(defaultStageId);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!approverId) {
      setErr('Pick an approver');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await approvalsApi.request({ targetType, targetId, approverId, stageId: stageId || undefined, note: note.trim() || undefined });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
      setBusy(false);
    }
  };

  return (
    <AdaptiveDialog onClose={onClose} title="Request approval">
      <div className="space-y-3">
        <Field label="Approver">
          <Select value={approverId} onChange={(e) => setApproverId(e.target.value)}>
            <option value="">Pick a member…</option>
            {users.map((u) => (
              <option key={u.id} value={u.id} disabled={u.disabled} className={u.disabled?'text-neutral-500':undefined}>
                {u.name}{u.disabled?' (disabled)':''}
              </option>
            ))}
          </Select>
        </Field>
        {targetType === 'record' && stages.length > 0 && (
          <Field label="For stage" hint="Only needed to unlock a gated stage move">
            <Select value={stageId} onChange={(e) => setStageId(e.target.value)}>
              <option value="">General approval</option>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Note (optional)">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="What should they check?" />
        </Field>
        {err && <p className="text-xs text-red-500">{err}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-xs font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800">
            Cancel
          </button>
          <button
            disabled={busy || !approverId}
            onClick={() => void submit()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-neutral-800 disabled:opacity-40 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Send request
          </button>
        </div>
      </div>
    </AdaptiveDialog>
  );
}

/* ---------- /approvals — needs-my-decision inbox + my requests ---------- */

function useAllApprovals(mine: 'approver' | 'requested' | undefined, status: Approval['status'] | undefined, pollMs = 30000) {
  const [rows, setRows] = useState<Approval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const res = await approvalsApi.listAll(mine, status);
      setRows(res.approvals);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load');
    }
  }, [mine, status]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);
  return { rows, error, refresh };
}

/** Stage name for a record-targeted approval, resolved locally via Dexie. */
function useStageLabel(a: Approval): string | null {
  const task = useLiveQuery(() => (a.targetType === 'record' ? (db.tasks.get(a.targetId) as Promise<TaskRow | undefined>) : Promise.resolve(undefined)), [a.targetType, a.targetId]);
  const boards = useBoards();
  if (!a.stageId) return null;
  const board = task ? boards.find((b) => b.id === taskBoardId(task)) : undefined;
  return columnsOf(board).find((c) => c.id === a.stageId)?.name ?? a.stageId;
}

function ApprovalPageRow({ a, me, onDone }: { a: Approval; me: string; onDone: () => void }) {
  const users = useUsers();
  const stageLabel = useStageLabel(a);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const requester = resolveUser(a.requestedBy, users, null);
  const approver = resolveUser(a.approverId, users, null);
  const isApprover = a.approverId === me && a.status === 'pending';
  const isRequester = a.requestedBy === me && a.status === 'pending';

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
      setBusy(false);
    }
  };

  return (
    <li className="rounded-xl border border-neutral-200/80 px-3.5 py-3 dark:border-neutral-800">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <a href={a.url ?? '#'} className="block truncate text-[13px] font-semibold text-neutral-800 hover:underline dark:text-neutral-100">
            {a.targetTitle ?? a.targetId}
          </a>
          <p className="mt-0.5 text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">
            <span className="font-medium text-neutral-700 dark:text-neutral-300">{requester?.name ?? 'Someone'}</span> → {approver?.name ?? 'member'}
            {stageLabel ? ` · “${stageLabel}”` : ''} · {relTime(a.createdAt)}
          </p>
          {a.note && <p className="mt-1 text-xs italic text-neutral-500 dark:text-neutral-400">“{a.note}”</p>}
        </div>
        {a.status !== 'pending' && (
          <span
            className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold capitalize',
              a.status === 'approved' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' : a.status === 'rejected' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
            )}
          >
            {a.status}
          </span>
        )}
      </div>
      {isApprover && (
        <div className="mt-2 flex items-center gap-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Decision note (optional)" className="h-8 min-w-0 flex-1 rounded-md border border-neutral-200 bg-transparent px-2 text-xs outline-none focus:ring-1 focus:ring-neutral-400 dark:border-neutral-700" />
          <button disabled={busy} onClick={() => void act(() => approvalsApi.decide(a.id, 'approved', note.trim() || undefined, a.rev))} className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-neutral-800 disabled:opacity-40 dark:bg-white dark:text-neutral-900">
            Approve
          </button>
          <button disabled={busy} onClick={() => void act(() => approvalsApi.decide(a.id, 'rejected', note.trim() || undefined, a.rev))} className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-semibold text-neutral-700 hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300">
            Reject
          </button>
        </div>
      )}
      {isRequester && (
        <button disabled={busy} onClick={() => void act(() => approvalsApi.cancel(a.id))} className="mt-2 text-[11px] font-medium text-neutral-600 dark:text-neutral-400 hover:text-neutral-600 disabled:opacity-40 dark:hover:text-neutral-300">
          Cancel request
        </button>
      )}
      {err && <p className="mt-1 text-[11px] text-red-500">{err}</p>}
    </li>
  );
}

export function ApprovalsPage() {
  const me = useStore(authStore).user?.id ?? '';
  const inbox = useAllApprovals('approver', 'pending');
  const mine = useAllApprovals('requested', undefined);
  const refreshAll = () => {
    void inbox.refresh();
    void mine.refresh();
  };
  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <h1 className="mb-4 flex items-center gap-2 text-lg font-semibold tracking-tight">
        <ShieldCheck size={18} /> Approvals
      </h1>

      <p className="mb-2 text-xs font-semibold tracking-wide text-neutral-600 dark:text-neutral-400 uppercase">Needs my decision</p>
      {inbox.error && <p className="mb-2 text-xs text-neutral-600 dark:text-neutral-400">Needs a connection — {inbox.error}</p>}
      <ul className="mb-6 space-y-2">
        {(inbox.rows ?? []).map((a) => (
          <ApprovalPageRow key={a.id} a={a} me={me} onDone={refreshAll} />
        ))}
      </ul>
      {inbox.rows !== null && inbox.rows.length === 0 && <p className="mb-6 text-xs text-neutral-600 dark:text-neutral-400">Nothing waiting on you.</p>}

      <p className="mb-2 text-xs font-semibold tracking-wide text-neutral-600 dark:text-neutral-400 uppercase">My requests</p>
      {mine.error && <p className="mb-2 text-xs text-neutral-600 dark:text-neutral-400">Needs a connection — {mine.error}</p>}
      <ul className="space-y-2">
        {(mine.rows ?? []).map((a) => (
          <ApprovalPageRow key={a.id} a={a} me={me} onDone={refreshAll} />
        ))}
      </ul>
      {mine.rows !== null && mine.rows.length === 0 && <p className="text-xs text-neutral-600 dark:text-neutral-400">No requests sent.</p>}
    </div>
  );
}

/** Nav badge — count of pending approvals where I'm the approver. */
export function ApprovalsBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const res = await approvalsApi.listAll('approver', 'pending');
        if (live) setCount(res.approvals.length);
      } catch {
        /* offline — keep last count */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 30000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  if (!count) return null;
  return <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">{count}</span>;
}

export const approvalsModule: AppModule = {
  id: 'approvals',
  label: 'Approvals',
  icon: ShieldCheck,
  navItem: { path: '/approvals', label: 'Approvals', icon: ShieldCheck },
  navBadge: ApprovalsBadge,
  routes: [{ path: 'approvals', element: <ApprovalsPage /> }],
  collections: [],
  slots: {
    taskDetail: ({ taskId }) => <ApprovalsSection targetType="record" targetId={taskId} />,
    pageFooter: ({ pageId }) => <ApprovalsSection targetType="page" targetId={pageId} />,
  },
};
