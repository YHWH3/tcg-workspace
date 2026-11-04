import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, RotateCcw, Trash2, X } from 'lucide-react';
import { db } from '../db';
import { mutateMany } from '../sync/engine';
import { toast } from '../files';
import { Button, Select } from '../ui';
import { fieldsOf, propKey, type FieldDef } from '../../../shared/fields';
import { gateTransition, parseGate } from '../../../shared/approvals';
import { archivePatch } from '../../../shared/archive';
import { GateMoveDialog, type GateAttempt } from '../../modules/boards/GateMove';
import type { BoardRow, TaskRow } from '../../modules/boards/api';

export const BULK_LIMIT = 500;
export const BULK_JOURNAL_TTL = 7 * 24 * 60 * 60 * 1000;

export interface BulkJournalItem {
  id: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface BulkJournal {
  id: string;
  createdAt: number;
  expiresAt: number;
  collection: 'tasks';
  databaseId: string;
  summary: string;
  items: BulkJournalItem[];
}

export interface BulkPlan {
  patches: { id: string; patch: Record<string, unknown> }[];
  gated: string[];
  journal: BulkJournalItem[];
}

/** Pure bulk planner. Gated stage transitions are returned separately so the
 * caller can request approval instead of applying them locally. */
export function planBulkEdit(board: BoardRow, rows: readonly TaskRow[], patch: Record<string, unknown>): BulkPlan {
  const gate = parseGate(board as unknown as Record<string, unknown>);
  const patches: BulkPlan['patches'] = [];
  const gated: string[] = [];
  const journal: BulkJournalItem[] = [];
  for (const row of rows.slice(0, BULK_LIMIT)) {
    const after = { ...row, ...patch } as Record<string, unknown>;
    const transition = gateTransition(gate, row as Record<string, unknown>, after);
    if (transition.required) {
      gated.push(row.id);
      continue;
    }
    const before = Object.fromEntries(Object.keys(patch).map((key) => [key, row[key]]));
    patches.push({ id: row.id, patch });
    journal.push({ id: row.id, before, after: Object.fromEntries(Object.keys(patch).map((key) => [key, after[key]])) });
  }
  return { patches, gated, journal };
}

export function inverseBulkJournal(current: readonly TaskRow[], journal: BulkJournal): { id: string; patch: Record<string, unknown> }[] {
  const byId = new Map(current.map((row) => [row.id, row]));
  const inverse: { id: string; patch: Record<string, unknown> }[] = [];
  for (const item of journal.items) {
    const row = byId.get(item.id);
    if (!row) continue;
    const unchanged = Object.keys(item.after).every((key) => sameValue(row[key], item.after[key]));
    if (unchanged) inverse.push({ id: item.id, patch: item.before });
  }
  return inverse;
}

export async function saveBulkJournal(journal: BulkJournal): Promise<void> {
  await db.meta.put({ key: `bulk:${journal.id}`, value: journal });
}

export async function getBulkJournal(id: string): Promise<BulkJournal | undefined> {
  const row = await db.meta.get(`bulk:${id}`);
  return row?.value as BulkJournal | undefined;
}

export async function listBulkJournals(now = Date.now()): Promise<BulkJournal[]> {
  const rows = await db.meta.toArray();
  const journals: BulkJournal[] = [];
  for (const row of rows) {
    if (!row.key.startsWith('bulk:')) continue;
    const journal = row.value as BulkJournal;
    if (!journal || journal.expiresAt <= now) {
      await db.meta.delete(row.key);
      continue;
    }
    journals.push(journal);
  }
  return journals.sort((a, b) => b.createdAt - a.createdAt);
}

export async function undoBulkJournal(journal: BulkJournal): Promise<{ restored: number; skipped: number }> {
  const rows = (await db.tasks.bulkGet(journal.items.map((item) => item.id))) as TaskRow[];
  const inverse = inverseBulkJournal(rows.filter(Boolean), journal);
  if (inverse.length) await mutateMany('tasks', inverse);
  await db.meta.delete(`bulk:${journal.id}`);
  return { restored: inverse.length, skipped: journal.items.length - inverse.length };
}

interface BulkSelectionValue {
  rows: readonly TaskRow[];
  selectedIds: ReadonlySet<string>;
  selectionMode: boolean;
  toggle: (id: string, shift?: boolean) => void;
  startLongPress: (id: string) => void;
  cancelLongPress: () => void;
  selectAll: () => void;
  clear: () => void;
  selectedRows: TaskRow[];
}

const BulkSelectionContext = createContext<BulkSelectionValue | null>(null);

export function useBulkSelection(): BulkSelectionValue | null {
  return useContext(BulkSelectionContext);
}

export function BulkSelectionProvider({ rows, children }: { rows: readonly TaskRow[]; children: ReactNode }) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const lastIndex = useRef<number | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ids = useMemo(() => rows.map((row) => row.id), [rows]);

  useEffect(() => {
    const visible = new Set(ids);
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => visible.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [ids]);

  const toggle = (id: string, shift = false) => {
    const index = ids.indexOf(id);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (shift && lastIndex.current !== null && index >= 0) {
        const start = Math.min(lastIndex.current, index);
        const end = Math.max(lastIndex.current, index);
        for (const rangeId of ids.slice(start, end + 1)) next.add(rangeId);
      } else if (next.has(id)) next.delete(id);
      else if (next.size < BULK_LIMIT) next.add(id);
      lastIndex.current = index >= 0 ? index : lastIndex.current;
      return next;
    });
    setSelectionMode(true);
  };
  const selectAll = () => {
    setSelectedIds(new Set(ids.slice(0, BULK_LIMIT)));
    setSelectionMode(true);
  };
  const clear = () => {
    setSelectedIds(new Set());
    setSelectionMode(false);
    lastIndex.current = null;
  };
  const startLongPress = (id: string) => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => {
      toggle(id);
      longPressTimer.current = null;
    }, 550);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };
  const selectedRows = rows.filter((row) => selectedIds.has(row.id));

  return <BulkSelectionContext.Provider value={{ rows, selectedIds, selectionMode, toggle, startLongPress, cancelLongPress, selectAll, clear, selectedRows }}>{children}</BulkSelectionContext.Provider>;
}

export function BulkRowCheckbox({ id, label }: { id: string; label: string }) {
  const selection = useBulkSelection();
  if (!selection) return null;
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={selection.selectedIds.has(id)}
      onChange={(event) => selection.toggle(id, event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const index = selection.rows.findIndex((row) => row.id === id);
          const next = index + (event.key === 'ArrowDown' ? 1 : -1);
          const target = selection.rows[next];
          if (target) selection.toggle(target.id, event.shiftKey);
        }
      }}
      className="h-4 w-4 shrink-0 accent-neutral-900 dark:accent-neutral-200"
    />
  );
}

export function BulkActionBar({ board }: { board: BoardRow }) {
  const selection = useBulkSelection();
  const users = useBulkUsers();
  const [fieldId, setFieldId] = useState('');
  const [fieldValue, setFieldValue] = useState('');
  const [stage, setStage] = useState('');
  const [assignee, setAssignee] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [gated, setGated] = useState<GateAttempt | null>(null);
  const [undoJournal, setUndoJournal] = useState<BulkJournal | null>(null);
  const fields = fieldsOf(board).filter((field) => field.type !== 'relation');
  const stages = Array.isArray(board.columns) ? board.columns : [];
  if (!selection) return null;

  const run = async (patch: Record<string, unknown>, summary: string) => {
    if (!selection.selectedRows.length || busy) return;
    setBusy(true);
    try {
      const plan = planBulkEdit(board, selection.selectedRows, patch);
      if (plan.gated.length) {
        const first = selection.selectedRows.find((row) => plan.gated.includes(row.id));
        const stageId = String(patch.status ?? '');
        if (first && stageId) setGated({ taskId: first.id, boardId: board.id, stageId });
      }
      if (!plan.patches.length) {
        toast(`${plan.gated.length} need approval`, 'error');
        return;
      }
      const id = crypto.randomUUID();
      const journal: BulkJournal = { id, createdAt: Date.now(), expiresAt: Date.now() + BULK_JOURNAL_TTL, collection: 'tasks', databaseId: board.id, summary, items: plan.journal };
      await saveBulkJournal(journal);
      try {
        await mutateMany('tasks', plan.patches);
      } catch (error) {
        await db.meta.delete(`bulk:${id}`);
        throw error;
      }
      setUndoJournal(journal);
      selection.clear();
      toast(`${plan.patches.length} ${summary.toLowerCase()}${plan.gated.length ? ` · ${plan.gated.length} need approval` : ''}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Bulk edit failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!undoJournal || busy) return;
    setBusy(true);
    try {
      const result = await undoBulkJournal(undoJournal);
      setUndoJournal(null);
      toast(`Undo restored ${result.restored}${result.skipped ? ` · ${result.skipped} changed since` : ''}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Undo failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const setField = () => {
    const field = fields.find((candidate) => candidate.id === fieldId);
    if (!field) return;
    void run({ [propKey(field.id)]: coerceBulkValue(field, fieldValue) }, `updated ${field.name}`);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-blue-200 bg-blue-50 px-3 py-2 text-sm dark:border-blue-900/50 dark:bg-blue-950/30" role="region" aria-label="Bulk actions">
        <span className="font-medium">{selection.selectedRows.length} selected</span>
        <button className="rounded-md px-2 py-1 text-xs underline" onClick={selection.selectAll} disabled={selection.rows.length <= selection.selectedRows.length}>Select all filtered ({Math.min(selection.rows.length, BULK_LIMIT)})</button>
        <Select density="compact" aria-label="Bulk stage" value={stage} onChange={(event) => setStage(event.target.value)} className="max-w-40">
          <option value="">Set stage…</option>
          {stages.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}
        </Select>
        <Button size="sm" disabled={!stage || busy} onClick={() => void run({ status: stage }, `set stage to ${stages.find((column) => column.id === stage)?.name ?? stage}`)}>Apply stage</Button>
        <Select density="compact" aria-label="Bulk field" value={fieldId} onChange={(event) => setFieldId(event.target.value)} className="max-w-40">
          <option value="">Set field…</option>
          {fields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
        </Select>
        {fieldId && <BulkFieldValue field={fields.find((field) => field.id === fieldId)!} value={fieldValue} onChange={setFieldValue} users={users} />}
        {fieldId && <Button size="sm" disabled={busy} onClick={setField}>Apply field</Button>}
        <Select density="compact" aria-label="Bulk assignee" value={assignee} onChange={(event) => setAssignee(event.target.value)} className="max-w-40">
          <option value="">Assign…</option>
          <option value="__none">Unassigned</option>
          {users.filter((user) => !user.disabled).map((user) => <option key={user.id} value={user.id}>{user.name || user.username}</option>)}
        </Select>
        <Button size="sm" disabled={!assignee || busy} onClick={() => void run({ assigneeId: assignee === '__none' ? null : assignee }, 'assigned records')}>Assign</Button>
        <input aria-label="Bulk due date" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} className="ws-input ws-input-compact" />
        <Button size="sm" disabled={!dueDate || busy} onClick={() => void run({ dueDate }, 'set due dates')}>Set due date</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(archivePatch(true), 'archived records')}><ChevronDown size={13} /> Archive</Button>
        <Button size="sm" variant="danger" className="text-red-700 dark:text-red-300" disabled={busy} onClick={() => void run({ deleted: true }, 'deleted records')}><Trash2 size={13} /> Delete</Button>
        <Button size="sm" variant="ghost" onClick={selection.clear}><X size={13} /> Clear</Button>
        {undoJournal && <Button size="sm" variant="outline" disabled={busy} onClick={() => void undo()}><RotateCcw size={13} /> Undo</Button>}
      </div>
      {gated && <GateMoveDialog attempt={gated} onClose={() => setGated(null)} />}
    </>
  );
}

function BulkFieldValue({ field, value, onChange, users }: { field: FieldDef; value: string; onChange: (value: string) => void; users: readonly { id: string; name?: string; username?: string; disabled?: boolean }[] }) {
  if (field.type === 'checkbox') return <label className="inline-flex items-center gap-1 text-xs"><input type="checkbox" checked={value === 'true'} onChange={(event) => onChange(String(event.target.checked))} /> True</label>;
  if (field.type === 'date') return <input aria-label={`Bulk ${field.name}`} type="date" value={value} onChange={(event) => onChange(event.target.value)} className="ws-input ws-input-compact max-w-36" />;
  if (field.type === 'number') return <input aria-label={`Bulk ${field.name}`} type="number" value={value} onChange={(event) => onChange(event.target.value)} className="ws-input ws-input-compact max-w-28" />;
  if (field.type === 'select' || field.type === 'person') return <Select density="compact" aria-label={`Bulk ${field.name}`} value={value} onChange={(event) => onChange(event.target.value)} className="max-w-40"><option value="">Clear</option>{field.type === 'person' ? users.filter((user) => !user.disabled).map((user) => <option key={user.id} value={user.id}>{user.name || user.username}</option>) : (field.options ?? []).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</Select>;
  return <input aria-label={`Bulk ${field.name}`} type={field.type === 'url' ? 'url' : 'text'} value={value} onChange={(event) => onChange(event.target.value)} className="ws-input ws-input-compact max-w-44" />;
}

function coerceBulkValue(field: FieldDef, value: string): unknown {
  if (value === '') return null;
  if (field.type === 'checkbox') return value === 'true';
  if (field.type === 'number') return Number(value);
  if (field.type === 'multi_select') return value.split(';').map((item) => item.trim()).filter(Boolean);
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function useBulkUsers(): readonly { id: string; name?: string; username?: string; disabled?: boolean }[] {
  const [users, setUsers] = useState<readonly { id: string; name?: string; username?: string; disabled?: boolean }[]>([]);
  useEffect(() => {
    let live = true;
    void db.users.toArray().then((rows) => { if (live) setUsers(rows); });
    return () => { live = false; };
  }, []);
  return users;
}

