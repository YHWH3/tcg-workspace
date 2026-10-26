import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowDown, ArrowLeft, ArrowUp, ChevronDown, ChevronRight, History, Plus, Trash2, Zap } from 'lucide-react';
import type { AppModule } from '../types';
import { db } from '../../core/db';
import { mutate } from '../../core/sync/engine';
import { api } from '../../core/api';
import { AskAiMenu } from '../../core/assistant/AskAiMenu';
import { useAssistantContext } from '../../core/assistant/store';
import { useBoard, type BoardRow } from '../boards/api';
import { availableFieldKeys, fieldKeyLabel } from '../../core/records';
import { useUsers } from '../../core/users';
import { Button, EmptyState, Input, Select, Textarea } from '../../core/ui';
import { fieldsOf, type FieldDef } from '../../../shared/fields';
import {
  ACTION_TYPES,
  TRIGGER_KINDS,
  type AutomationAction,
  type AutomationConfig,
  type AutomationTrigger,
} from '../../../shared/automations';
import {changeFilterOperator,isDateFilterKey,type FieldKey,type Filter,type FilterOp} from '../../../shared/views';
import {DateFilterControl,DATE_VALUE_OPERATORS} from '../../core/views/DateFilterControl';

/* Phase 4 — automation editor (Workstream E). Database ⋯ → "Automations…"
 * opens `/automations/:boardId`. Config rows live in the synced `automations`
 * collection and are written via mutate(); the worker engine runs them. */

interface AutomationRow extends AutomationConfig {
  id: string;
}

const FILTER_OPS: { id: FilterOp; label: string }[] = [
  { id: 'is', label: 'is' },
  { id: 'is_not', label: 'is not' },
  { id: 'contains', label: 'contains' },
  { id: 'not_contains', label: "doesn't contain" },
  { id: 'empty', label: 'is empty' },
  { id: 'not_empty', label: 'is not empty' },
  { id: 'before', label: 'before' },
  { id: 'after', label: 'after' },
  { id: 'on_or_before', label: 'on or before' },
  { id: 'on_or_after', label: 'on or after' },
  { id: 'within', label: 'within range' },
  { id: 'checked', label: 'checked' },
  { id: 'unchecked', label: 'unchecked' },
  { id: 'me', label: 'is me' },
];

const NO_VALUE_OPS: FilterOp[] = ['empty', 'not_empty', 'checked', 'unchecked', 'me'];

const dateFieldKeys = (board: BoardRow | undefined): FieldKey[] => {
  const keys: FieldKey[] = [];
  const builtins = new Set(availableFieldKeys(board));
  if (builtins.has('dueDate')) keys.push('dueDate');
  for (const f of fieldsOf(board)) if (f.type === 'date') keys.push(`p_${f.id}`);
  return keys;
};

const personFields = (board: BoardRow | undefined): FieldDef[] => fieldsOf(board).filter((f) => f.type === 'person');

const selectCls = 'min-w-0 flex-1';
const labelCls = 'mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400';

function SectionLabel({ children }: { children: string }) {
  return <p className={labelCls}>{children}</p>;
}

function TriggerEditor({ board, allForms, trigger, onChange }: {
  board: BoardRow | undefined;
  allForms: { id: string; title?: string }[];
  trigger: AutomationTrigger | undefined;
  onChange: (t: AutomationTrigger) => void;
}) {
  const t = trigger ?? { kind: 'record.created' as const };
  const columns = Array.isArray(board?.columns) ? (board!.columns as { id: string; name: string }[]) : [];
  const keys = availableFieldKeys(board);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select density="compact"
        value={t.kind}
        className={selectCls}
        onChange={(e) => onChange({ kind: e.target.value as AutomationTrigger['kind'] })}
        aria-label="Trigger"
      >
        {TRIGGER_KINDS.map((k) => (
          <option key={k.id} value={k.id}>{k.label}</option>
        ))}
      </Select>
      {t.kind === 'stage_changed' && (
        <Select density="compact" value={t.to ?? ''} className={selectCls} onChange={(e) => onChange({ ...t, to: e.target.value || undefined })} aria-label="Target stage">
          <option value="">any stage</option>
          {columns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Select>
      )}
      {t.kind === 'field_changed' && (
        <Select density="compact" value={t.fieldId ?? ''} className={selectCls} onChange={(e) => onChange({ ...t, fieldId: (e.target.value || undefined) as FieldKey | undefined })} aria-label="Field">
          <option value="">any field</option>
          {keys.map((k) => (
            <option key={k} value={k}>{fieldKeyLabel(board, k)}</option>
          ))}
        </Select>
      )}
      {t.kind === 'date_offset' && (
        <>
          <Input density="compact"
            type="number"
            value={t.days ?? -1}
            className="w-20"
            onChange={(e) => onChange({ ...t, days: Number(e.target.value) })}
            aria-label="Days offset"
          />
          <span className="text-xs text-neutral-400">days from</span>
          <Select density="compact" value={t.dateKey ?? 'dueDate'} className={selectCls} onChange={(e) => onChange({ ...t, dateKey: e.target.value })} aria-label="Date field">
            {dateFieldKeys(board).map((k) => (
              <option key={k} value={k}>{fieldKeyLabel(board, k)}</option>
            ))}
          </Select>
        </>
      )}
      {t.kind === 'form.submitted' && (
        <Select density="compact" value={t.formId ?? ''} className={selectCls} onChange={(e) => onChange({ ...t, formId: e.target.value || undefined })} aria-label="Form">
          <option value="">any form</option>
          {allForms.map((f) => (
            <option key={f.id} value={f.id}>{f.title ?? f.id}</option>
          ))}
        </Select>
      )}
    </div>
  );
}

function ConditionRow({ board, keys, filter, onChange }: {
  board: BoardRow | undefined;
  keys: FieldKey[];
  filter: Filter;
  onChange: (f: Filter | null) => void;
}) {
  const noValue = NO_VALUE_OPS.includes(filter.op);
  const fields=fieldsOf(board),isDate=isDateFilterKey(filter.key,fields);
  const structuredDate=isDate&&DATE_VALUE_OPERATORS.includes(filter.op);
  return (
    <div className="mb-1">
    <div className={isDate ? 'grid grid-cols-[minmax(0,1fr)_2rem] gap-1' : 'flex items-center gap-1'}>
      <Select density="compact" value={filter.key} onChange={(e) => {const key=e.target.value as FieldKey;onChange({...filter,key,...(filter.op==='within'&&!isDateFilterKey(key,fields)?{op:'is',value:''}:{})});}} className={isDate ? 'col-span-2 w-full' : selectCls} aria-label="Condition field">
        {keys.map((k) => (
          <option key={k} value={k}>{fieldKeyLabel(board, k)}</option>
        ))}
      </Select>
      <Select density="compact" value={filter.op} onChange={(e) => onChange(changeFilterOperator(filter,e.target.value as FilterOp))} className={isDate ? 'col-span-2 w-full' : 'w-24 shrink-0'} aria-label="Condition operator">
        {FILTER_OPS.filter(o=>o.id===filter.op||(isDate?['is','is_not','empty','not_empty',...DATE_VALUE_OPERATORS].includes(o.id):o.id!=='within')).map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </Select>
      {!noValue && (structuredDate ? <div className="col-span-2 min-w-0"><DateFilterControl filter={filter} onChange={onChange} label="Condition" fields={fields}/></div>
        : <input value={String(filter.value ?? '')} placeholder="value" onChange={e=>onChange({...filter,value:e.target.value})}
          className={`h-8 shrink-0 rounded-md border border-neutral-200 bg-transparent px-1.5 text-xs dark:border-neutral-700 ${isDate?'col-span-2 w-full min-w-0':'w-20'}`} aria-label="Condition value"/>)}
      <button className="min-h-8 min-w-8 shrink-0 rounded-md text-neutral-400 hover:text-red-500 focus-visible:outline-2 focus-visible:outline-offset-2" onClick={() => onChange(null)} aria-label="Remove condition">
        <Trash2 size={12} />
      </button>
    </div>
    </div>
  );
}

function UserFieldOrIds({ board, userField, userIds, onField, onIds }: {
  board: BoardRow | undefined;
  userField?: string;
  userIds?: string[];
  onField: (v: string | undefined) => void;
  onIds: (v: string[]) => void;
}) {
  const users = useUsers();
  const pf = personFields(board);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select density="compact" value={userField ?? ''} className={selectCls} onChange={(e) => onField(e.target.value || undefined)} aria-label="Person field">
        <option value="">person field…</option>
        {pf.map((f) => (
          <option key={f.id} value={f.id}>{f.name} (record field)</option>
        ))}
      </Select>
      <Select density="compact"
        value=""
        className={selectCls}
        onChange={(e) => {
          const v = e.target.value;
          if (v && !(userIds ?? []).includes(v)) onIds([...(userIds ?? []), v]);
        }}
        aria-label="Add recipient"
      >
        <option value="">add member…</option>
        {users.filter((u) => !u.disabled && !(userIds ?? []).includes(u.id)).map((u) => (
          <option key={u.id} value={u.id}>{u.name}</option>
        ))}
      </Select>
      {(userIds ?? []).map((uid) => (
        <button
          key={uid}
          className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-red-50 hover:text-red-500 dark:bg-neutral-800 dark:text-neutral-300"
          onClick={() => onIds((userIds ?? []).filter((x) => x !== uid))}
          title="Remove recipient"
        >
          {users.find((u) => u.id === uid)?.name ?? uid} ×
        </button>
      ))}
    </div>
  );
}

function ActionEditor({ board, allBoards, action, onChange, onMove, onDelete, first, last }: {
  board: BoardRow | undefined;
  allBoards: BoardRow[];
  action: AutomationAction;
  onChange: (a: AutomationAction) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
  first: boolean;
  last: boolean;
}) {
  const a = action;
  const targetBoard = allBoards.find((b) => b.id === a.databaseId);
  return (
    <div className="mb-1.5 rounded-lg border border-neutral-200/70 p-2 dark:border-neutral-800">
      <div className="mb-1.5 flex items-center gap-1">
        <Select density="compact" value={a.type} className="min-w-0 flex-1" onChange={(e) => onChange({ type: e.target.value as AutomationAction['type'] })} aria-label="Action type">
          {ACTION_TYPES.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </Select>
        <button className="min-h-8 min-w-8 rounded-md text-neutral-400 hover:text-neutral-600 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-30 dark:hover:text-neutral-300" disabled={first} onClick={() => onMove(-1)} aria-label="Move up"><ArrowUp size={13} aria-hidden="true" /></button>
        <button className="min-h-8 min-w-8 rounded-md text-neutral-400 hover:text-neutral-600 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-30 dark:hover:text-neutral-300" disabled={last} onClick={() => onMove(1)} aria-label="Move down"><ArrowDown size={13} aria-hidden="true" /></button>
        <button className="min-h-8 min-w-8 rounded-md text-neutral-400 hover:text-red-500 focus-visible:outline-2 focus-visible:outline-offset-2" onClick={onDelete} aria-label="Delete action"><Trash2 size={13} aria-hidden="true" /></button>
      </div>

      {a.type === 'create_record' && (
        <div className="space-y-1.5">
          <Select density="compact" value={a.databaseId ?? ''} className={selectCls} onChange={(e) => onChange({ ...a, databaseId: e.target.value || undefined })} aria-label="Target database">
            <option value="">database…</option>
            {allBoards.map((b) => (
              <option key={b.id} value={b.id}>{String(b.icon ?? '')} {String(b.name ?? b.id)}</option>
            ))}
          </Select>
          <Input density="compact" value={a.title ?? ''} placeholder="Title — {{record.title}} works" className="" onChange={(e) => onChange({ ...a, title: e.target.value })} aria-label="Record title" />
          <Select density="compact"
            value={a.link === undefined ? '' : a.link === null ? '__none' : (a.link.fieldId ?? '__related')}
            className={selectCls}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '') onChange({ ...a, link: undefined });
              else if (v === '__related') onChange({ ...a, link: { fieldId: null } });
              else onChange({ ...a, link: { fieldId: v } });
            }}
            aria-label="Link back to record"
          >
            <option value="">no link back</option>
            <option value="__related">link as "related"</option>
            {fieldsOf(targetBoard).filter((f) => f.type === 'relation').map((f) => (
              <option key={f.id} value={f.id}>link via {f.name}</option>
            ))}
          </Select>
        </div>
      )}

      {a.type === 'create_from_template' && (
        <Input density="compact" value={a.templateId ?? ''} placeholder="Template page id" className="" onChange={(e) => onChange({ ...a, templateId: e.target.value })} aria-label="Template id" />
      )}

      {a.type === 'ai_classify' && <div className="space-y-2"><p className="text-xs">Optional; creates a suggestion only. Requires operator configuration and budget.</p><Select value={a.fieldKey??''} aria-label="Classification field" onChange={e=>onChange({...a,fieldKey:e.target.value})}><option value="">Choose field</option>{availableFieldKeys(board).filter(k=>!k.startsWith('rel_')).map(k=><option key={k} value={k}>{fieldKeyLabel(board,k)}</option>)}</Select><Input value={(a.options??[]).join(', ')} aria-label="Classification options" placeholder="Comma-separated labels" onChange={e=>onChange({...a,options:e.target.value.split(',').map(x=>x.trim()).filter(Boolean)})}/></div>}

      {a.type === 'set_field' && (
        <div className="flex items-center gap-1.5">
          <Select density="compact" value={a.fieldKey ?? ''} className={selectCls} onChange={(e) => onChange({ ...a, fieldKey: e.target.value || undefined })} aria-label="Field to set">
            <option value="">field…</option>
            {availableFieldKeys(board).map((k) => (
              <option key={k} value={k}>{fieldKeyLabel(board, k)}</option>
            ))}
          </Select>
          <Input density="compact" value={typeof a.value === 'string' ? a.value : String(a.value ?? '')} placeholder="value" className="w-24 shrink-0" onChange={(e) => onChange({ ...a, value: e.target.value })} aria-label="Value" />
        </div>
      )}

      {a.type === 'notify' && (
        <div className="space-y-1.5">
          <UserFieldOrIds board={board} userField={a.userField} userIds={a.userIds} onField={(v) => onChange({ ...a, userField: v })} onIds={(v) => onChange({ ...a, userIds: v })} />
          <Textarea value={a.message ?? ''} placeholder="Message — {{record.title}}, {{field:Name}}, {{today}} work" rows={2} className="text-xs" onChange={(e) => onChange({ ...a, message: e.target.value })} aria-label="Message" />
        </div>
      )}

      {a.type === 'request_approval' && (
        <div className="space-y-1.5">
          <UserFieldOrIds board={board} userField={a.approverField} userIds={a.approverId ? [a.approverId] : []} onField={(v) => onChange({ ...a, approverField: v, approverId: v ? undefined : a.approverId })} onIds={(v) => onChange({ ...a, approverId: v[0], approverField: v[0] ? undefined : a.approverField })} />
          <Input density="compact" value={a.note ?? ''} placeholder="Note for the approver (optional)" className="" onChange={(e) => onChange({ ...a, note: e.target.value })} aria-label="Approval note" />
        </div>
      )}

      {a.type === 'add_subrecords' && (
        <Textarea
          value={(a.titles ?? []).join('\n')}
          placeholder={'One title per line — {{record.title}} works'}
          rows={Math.min(6, Math.max(3, (a.titles ?? []).length + 1))}
          className="text-xs"
          onChange={(e) => onChange({ ...a, titles: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
          aria-label="Sub-record titles"
        />
      )}
    </div>
  );
}

interface RunRow {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'retryable_failure' | 'terminal_failure';
  error: string | null;
  changeset_id: string | null;
  created_at: number;
}

const RUN_STATUS_LABELS: Record<RunRow['status'], string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  retryable_failure: 'Retryable failure',
  terminal_failure: 'Terminal failure',
};

const runStatusLabel = (status: string): string => RUN_STATUS_LABELS[status as RunRow['status']] ?? 'Unknown status';
const runStatusClass = (status: string): string => {
  if (status === 'completed') return 'text-emerald-600 dark:text-emerald-400';
  if (status === 'retryable_failure' || status === 'terminal_failure') return 'text-red-500 dark:text-red-400';
  return 'text-neutral-500 dark:text-neutral-400';
};

function RunHistory({ autoId }: { autoId: string }) {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [undoMsg, setUndoMsg] = useState<string>('');
  useEffect(() => {
    let live = true;
    void api<{ runs: RunRow[] }>(`/api/automations/${autoId}/runs`).then((r) => { if (live) setRuns(r.runs); }).catch(() => { if (live) setRuns([]); });
    void api<{ errors: string[] }>(`/api/automations/${autoId}/validate`).then((r) => { if (live) setErrors(r.errors); }).catch(() => {});
    return () => { live = false; };
  }, [autoId]);
  return (
    <div className="mt-2 border-t border-neutral-200/70 pt-2 text-xs dark:border-neutral-800">
      {errors.length > 0 && (
        <div className="mb-2 rounded-lg bg-red-50 px-2 py-1.5 text-red-600 dark:bg-red-950/40 dark:text-red-400">
          {errors.map((e) => <p key={e}>⚠ {e}</p>)}
        </div>
      )}
      {runs === null && <p className="text-neutral-400">Loading runs…</p>}
      {runs !== null && !runs.length && <p className="text-neutral-400">No runs yet.</p>}
      {undoMsg && <p className="mb-1 text-neutral-500">{undoMsg}</p>}
      <div role="list" aria-label="Automation runs">
      {(runs ?? []).map((r) => (
        <div key={r.id} role="listitem" className="mb-1 flex min-h-8 items-center gap-2">
          <span className={runStatusClass(r.status)}>{runStatusLabel(r.status)}</span>
          <span className="text-neutral-400">{new Date(r.created_at).toLocaleString()}</span>
          {r.error && <span className="min-w-0 flex-1 truncate text-neutral-500" title={r.error}>{r.error}</span>}
          {r.status === 'completed' && r.changeset_id && (
            <button
              className="min-h-8 shrink-0 rounded-md px-2 py-1 text-blue-600 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-offset-2 dark:text-blue-400 dark:hover:bg-blue-950/40"
              onClick={() => void api(`/api/changes/${r.changeset_id}/undo`, { method: 'POST' }).then(() => setUndoMsg(`Undid changeset ${r.changeset_id!.slice(0, 8)}…`)).catch((e) => setUndoMsg(`Undo failed: ${e instanceof Error ? e.message : String(e)}`))}
            >
              Undo
            </button>
          )}
        </div>
      ))}
      </div>
    </div>
  );
}

function AutomationCard({ row, board, allBoards, allForms }: {
  row: AutomationRow;
  board: BoardRow | undefined;
  allBoards: BoardRow[];
  allForms: { id: string; title?: string }[];
}) {
  const [showRuns, setShowRuns] = useState(false);
  const patch = (p: Partial<AutomationConfig>) => void mutate('automations', row.id, p);
  const conditions = row.conditions ?? [];
  const actions = row.actions ?? [];
  const keys = availableFieldKeys(board);
  const setAction = (i: number, a: AutomationAction | null) =>
    patch({ actions: a === null ? actions.filter((_, j) => j !== i) : actions.map((x, j) => (j === i ? a : x)) });

  return (
    <section className="mb-3 rounded-xl border border-neutral-200/70 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-2 flex items-center gap-2">
        <Input density="compact" value={row.name ?? ''} placeholder="Automation name" className="min-w-0 flex-1 border-transparent px-0 text-sm font-semibold focus:border-neutral-200 dark:focus:border-neutral-700" onChange={(e) => patch({ name: e.target.value })} aria-label="Automation name" />
        <button
          onClick={() => patch({ enabled: row.enabled === false })}
          aria-pressed={row.enabled !== false}
          className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${row.enabled !== false ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400' : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400'}`}
          style={{ minHeight: 28 }}
        >
          {row.enabled !== false ? 'On' : 'Off'}
        </button>
        <button className="shrink-0 p-1 text-neutral-400 hover:text-red-500" onClick={() => patch({ deleted: true })} aria-label="Delete automation">
          <Trash2 size={14} />
        </button>
      </div>

      <SectionLabel>When</SectionLabel>
      <TriggerEditor board={board} allForms={allForms} trigger={row.trigger} onChange={(t) => patch({ trigger: t })} />

      <div className="mt-3">
        <SectionLabel>If all of these match</SectionLabel>
        {row.trigger?.kind === 'date_offset' && (
          <p className="mb-1 text-[11px] text-neutral-400">Checked again until this date window ends. A miss does not skip a later match.</p>
        )}
        {conditions.map((f, i) => (
          <ConditionRow key={i} board={board} keys={keys} filter={f} onChange={(nf) => patch({ conditions: nf ? conditions.map((x, j) => (j === i ? nf : x)) : conditions.filter((_, j) => j !== i) })} />
        ))}
        <button className="flex items-center gap-1 rounded-md px-1.5 py-1.5 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40" onClick={() => patch({ conditions: [...conditions, { key: keys[0] ?? 'title', op: 'is', value: '' }] })}>
          <Plus size={12} /> Add condition
        </button>
      </div>

      <div className="mt-3">
        <SectionLabel>Then</SectionLabel>
        {actions.map((a, i) => (
          <ActionEditor
            key={i}
            board={board}
            allBoards={allBoards}
            action={a}
            first={i === 0}
            last={i === actions.length - 1}
            onChange={(na) => setAction(i, na)}
            onDelete={() => setAction(i, null)}
            onMove={(dir) => {
              const j = i + dir;
              const next = [...actions];
              [next[i], next[j]] = [next[j], next[i]];
              patch({ actions: next });
            }}
          />
        ))}
        <button className="flex items-center gap-1 rounded-md px-1.5 py-1.5 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40" onClick={() => patch({ actions: [...actions, { type: 'notify', userIds: [], message: '' }] })}>
          <Plus size={12} /> Add action
        </button>
      </div>

      <button className="mt-2 flex min-h-8 items-center gap-1 rounded-md px-1 text-xs text-neutral-600 dark:text-neutral-400 hover:text-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 dark:hover:text-neutral-300" aria-expanded={showRuns} onClick={() => setShowRuns((s) => !s)}>
        {showRuns ? <ChevronDown size={12} /> : <ChevronRight size={12} />} <History size={12} /> Run history
      </button>
      {showRuns && <RunHistory autoId={row.id} />}
    </section>
  );
}

export function AutomationsEditor() {
  const { boardId } = useParams();
  const navigate = useNavigate();
  const board = useBoard(boardId);
  useAssistantContext(boardId && board ? { kind: 'database', id: boardId } : null);
  const allBoards = useLiveQuery(() => db.boards.filter((b) => b.deleted !== true).toArray(), [], [] as BoardRow[]) ?? [];
  const allForms = (useLiveQuery(() => db.collection('forms').filter((f) => f.deleted !== true).toArray(), []) ?? []) as { id: string; title?: string }[];
  const autos = (useLiveQuery(
    () => (boardId ? (db.collection('automations').where('databaseId').equals(boardId).filter((a) => (a as AutomationRow).deleted !== true).toArray() as Promise<AutomationRow[]>) : Promise.resolve<AutomationRow[]>([])),
    [boardId],
  ) ?? []) as AutomationRow[];

  const createAutomation = () =>
    void mutate('automations', `auto_${crypto.randomUUID().slice(0, 12)}`, {
      databaseId: boardId,
      name: 'New automation',
      enabled: true,
      trigger: { kind: 'record.created' },
      conditions: [],
      actions: [{ type: 'notify', userIds: [], message: '' }],
      createdAt: Date.now(),
    });

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-4">
      <header className="mb-4 flex items-center gap-2">
        <button className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => navigate(-1)} aria-label="Back">
          <ArrowLeft size={17} />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight">
          <Zap size={15} className="mr-1 inline-block -mt-0.5" /> Automations — {String(board?.name ?? 'database')}
        </h1>
        <AskAiMenu modules={['automations']} refs={boardId ? { database: { kind: 'database', id: boardId } } : {}} compact />
        <Button size="sm" onClick={createAutomation}>
          <Plus size={14} /> New automation
        </Button>
      </header>
      {!autos.length && (
        <EmptyState
          icon={Zap}
          title="No automations yet"
          body="Run a rule when records in this database change — create follow-ups, notify owners, request approvals."
          action={<Button size="sm" onClick={createAutomation}><Plus size={14} /> New automation</Button>}
        />
      )}
      {autos.map((a) => (
        <AutomationCard key={a.id} row={a} board={board} allBoards={allBoards} allForms={allForms} />
      ))}
    </div>
  );
}

export const automationsModule: AppModule = {
  id: 'automations',
  label: 'Automations',
  icon: Zap,
  routes: [{ path: 'automations/:boardId', element: <AutomationsEditor /> }],
  collections: ['automations', 'forms'],
};
