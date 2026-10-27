// Phase 4-D gate UX for boards: (a) the approvalGate editor on the board menu,
// (b) the request-approval dialog that opens when a member attempts a move into
// a gated stage. The server remains the truth — the move attempt still goes
// through `mutate()` and is rejected `approval_required` by guardStageWrites;
// this UI just makes the gate legible and gets the approval flowing.

import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { createStore } from '../../core/store';
import { useStore } from '../../core/store';
import { mutate } from '../../core/sync/engine';
import { AdaptiveDialog, Field, Select, Textarea, Button } from '../../core/ui';
import { useUsers } from '../../core/users';
import { db } from '../../core/db';
import { parseGate, gateMatches, requiredApproverId } from '../../../shared/approvals';
import { api } from '../../core/api';
import { columnsOf, type BoardRow, type TaskRow } from './api';
import { fieldsOf } from './model';

export interface GateAttempt {
  taskId: string;
  boardId: string;
  stageId: string;
}

export const gateAttemptStore = createStore<GateAttempt | null>(null);

/** Call BEFORE writing a status move: when the target is the board's gated
 * stage, opens the request dialog. The move itself is NOT intercepted — the
 * server decides (approval_required rejection is honest state in the outbox). */
export function noteGatedMove(board: unknown, taskId: string, nextStatus: unknown): void {
  const gate = parseGate(board as Record<string, unknown> | undefined | null);
  if (gateMatches(gate, nextStatus)) {
    gateAttemptStore.set({ taskId, boardId: String((board as { id?: unknown } | null | undefined)?.id ?? ''), stageId: gate.stageId });
  }
}

/** Global dialog host — mount once anywhere gated moves can originate
 * (BoardPage covers board/list/detail; TasksBlock mounts its own for pages). */
export function GateMoveHost() {
  const attempt = useStore(gateAttemptStore);
  if (!attempt) return null;
  return <GateMoveDialog attempt={attempt} />;
}

export function GateMoveDialog({ attempt, onClose }: { attempt: GateAttempt; onClose?: () => void }) {
  const close = onClose ?? (() => gateAttemptStore.set(null));
  const users = useUsers();
  const [board, setBoard] = useState<BoardRow | undefined>();
  const [task, setTask] = useState<TaskRow | undefined>();
  const [approverId, setApproverId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([db.boards.get(attempt.boardId), db.tasks.get(attempt.taskId)]).then(([b, t]) => {
      if (!live) return;
      const br = b as BoardRow | undefined;
      const tr = t as TaskRow | undefined;
      setBoard(br);
      setTask(tr);
      const gate = parseGate(br as unknown as Record<string, unknown> | undefined);
      const req = requiredApproverId(gate, (tr ?? {}) as Record<string, unknown>);
      if (req) setApproverId(req);
    });
    return () => {
      live = false;
    };
  }, [attempt.boardId, attempt.taskId]);

  const cols = columnsOf(board);
  const stage = cols.find((c) => c.id === attempt.stageId);

  const submit = async () => {
    if (!approverId) {
      setErr('Pick an approver');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api('/api/approvals', {
        method: 'POST',
        body: { targetType: 'record', targetId: attempt.taskId, approverId, stageId: attempt.stageId, note: note.trim() || undefined },
      });
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
      setBusy(false);
    }
  };

  return (
    <AdaptiveDialog onClose={close} title="Approval required">
      <div className="space-y-3">
        <p className="text-xs leading-5 text-neutral-500 dark:text-neutral-400">
          Moving <span className="font-semibold text-neutral-700 dark:text-neutral-200">{String(task?.title ?? 'this task')}</span> to{' '}
          <span className="font-semibold text-neutral-700 dark:text-neutral-200">“{stage?.name ?? attempt.stageId}”</span> needs approval — the
          server keeps your change local until it’s granted.
        </p>
        <Field label="Approver">
          <Select value={approverId} onChange={(e) => setApproverId(e.target.value)} autoFocus>
            <option value="">Pick a member…</option>
            {users.map((u) => (
              <option key={u.id} value={u.id} disabled={u.disabled} className={u.disabled?'text-neutral-500':undefined}>
                {u.name}{u.disabled?' (disabled)':''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note (optional)">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Why this move?" />
        </Field>
        {err && <p className="text-xs text-red-500">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Keep local, skip request
          </Button>
          <Button disabled={busy || !approverId} onClick={() => void submit()}>
            Request approval
          </Button>
        </div>
      </div>
    </AdaptiveDialog>
  );
}

/* ---------- Board settings: approvalGate editor ---------- */

/** Sheet content — pick the gated stage and optionally the person field that
 * pins who must approve. Stored on the board record's `approvalGate` field. */
export function GateEditor({ board }: { board: BoardRow }) {
  const gate = parseGate(board as unknown as Record<string, unknown>);
  const cols = columnsOf(board);
  const personFields = fieldsOf(board).filter((f) => f.type === 'person');
  const [stageId, setStageId] = useState(gate?.stageId ?? '');
  const [approverField, setApproverField] = useState(gate?.approverField ?? '');
  const [saved, setSaved] = useState(false);

  const save = async (next: { stageId: string; approverField?: string } | null) => {
    await mutate('boards', board.id, { approvalGate: next });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck size={15} className="text-neutral-500" />
        <p className="text-sm font-semibold">Approval gate</p>
      </div>
      <p className="text-xs leading-5 text-neutral-500 dark:text-neutral-400">
        Moves into the gated stage are held until an approval is granted — the server enforces it on every write path.
      </p>
      <Field label="Gated stage">
        <Select
          value={stageId}
          onChange={(e) => {
            const v = e.target.value;
            setStageId(v);
            if (!v) void save(null);
          }}
        >
          <option value="">No gate — moves always allowed</option>
          {cols.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      {stageId && (
        <Field label="Required approver (optional)" hint="Pin to the member in a person field — their approval unlocks the move">
          <Select
            value={approverField}
            onChange={(e) => {
              const v = e.target.value;
              setApproverField(v);
              void save(v ? { stageId, approverField: v } : { stageId });
            }}
          >
            <option value="">Any approved member</option>
            {personFields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {stageId && gate?.stageId !== stageId && (
        <Button onClick={() => void save(approverField ? { stageId, approverField } : { stageId })}>Enable gate</Button>
      )}
      {saved && <p className="text-xs text-emerald-600 dark:text-emerald-400">Saved</p>}
    </div>
  );
}
