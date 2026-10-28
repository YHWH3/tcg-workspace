import {useWorkspaceLocale,workspaceCurrency} from '../../core/workspaceLocale';
import { useMemo } from 'react';
import { Check, ExternalLink, X } from 'lucide-react';
import { mutate } from '../../core/sync/engine';
import { fieldOptionStyle } from '../../core/fieldColors';
import { Popover } from '../../core/ui';
import { resolveUser, useUsers } from '../../core/users';
import { authStore } from '../../core/auth';
import { fieldsOf, formatFieldValue, propKey, type FieldDef } from './model';
import type { BoardRow, TaskRow } from './api';

async function setProp(taskId: string, fieldId: string, value: unknown): Promise<void> {
  await mutate('tasks', taskId, { [propKey(fieldId)]: value ?? null });
}

/** Compact chip for a showOnCard field on a board card. */
export function FieldChip({ field, task }: { field: FieldDef; task: TaskRow }) {
  useWorkspaceLocale();
  const users = useUsers();
  const me = authStore.get().user;
  const raw = task[propKey(field.id)] as unknown;
  if (field.type === 'checkbox' && raw !== true) return null;
  if (field.type === 'select') {
    const o = (field.options ?? []).find((x) => x.id === raw);
    if (!o) return null;
    return (
      <span className="inline-flex max-w-[120px] items-center truncate rounded-full px-1.5 py-0.5 text-[11px] font-medium" style={fieldOptionStyle(o.color)}>
        {o.name}
      </span>
    );
  }
  if (field.type === 'multi_select') {
    const opts = (Array.isArray(raw) ? raw : []).map((id) => (field.options ?? []).find((o) => o.id === id)).filter(Boolean);
    if (!opts.length) return null;
    return (
      <>
        {opts.slice(0, 2).map((o) => (
          <span key={o!.id} className="inline-flex max-w-[100px] items-center truncate rounded-full px-1.5 py-0.5 text-[11px] font-medium" style={fieldOptionStyle(o!.color)}>
            {o!.name}
          </span>
        ))}
        {opts.length > 2 && <span className="text-[11px] text-neutral-400">+{opts.length - 2}</span>}
      </>
    );
  }
  if (field.type === 'checkbox') return <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"><Check size={10} /> {field.name}</span>;
  if (field.type === 'person') {
    const u = resolveUser(typeof raw === 'string' ? raw : null, users, me);
    if (!u) return null;
    return <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">{u.name}</span>;
  }
  const disp = formatFieldValue(field, raw,{workspaceCurrency:workspaceCurrency()});
  if (!disp) return null;
  return <span className="inline-flex max-w-[130px] items-center truncate rounded-full bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400" title={`${field.name}: ${disp}`}>{disp}</span>;
}

/** showOnCard fields as card chips — at most ~3 visible. */
export function FieldChips({ board, task }: { board: BoardRow | undefined; task: TaskRow }) {
  const fields = fieldsOf(board).filter((f) => f.showOnCard);
  if (!fields.length) return null;
  return (
    <>
      {fields.slice(0, 3).map((f) => (
        <FieldChip key={f.id} field={f} task={task} />
      ))}
    </>
  );
}

/** Inline property editor row used in the task detail grid. */
export function FieldRow({ field, task }: { field: FieldDef; task: TaskRow }) {
  useWorkspaceLocale();
  const users = useUsers();
  const raw = task[propKey(field.id)] as unknown;
  const input = 'min-w-0 w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:ring-white/10';
  return (
    <>
      <span className="break-words text-xs text-neutral-600 dark:text-neutral-400">{field.name}</span>
      {field.type === 'checkbox' ? (
        <input type="checkbox" checked={raw === true} onChange={(e) => void setProp(task.id, field.id, e.target.checked)} className="h-4 w-4 accent-neutral-900 dark:accent-neutral-200" aria-label={field.name} />
      ) : field.type === 'select' ? (
        <select value={typeof raw === 'string' ? raw : ''} onChange={(e) => void setProp(task.id, field.id, e.target.value || null)} className={input} aria-label={field.name}>
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
      ) : field.type === 'multi_select' ? (
        <MultiPicker field={field} task={task} values={Array.isArray(raw) ? (raw as string[]) : []} />
      ) : field.type === 'person' ? (
        <select value={typeof raw === 'string' ? raw : ''} onChange={(e) => void setProp(task.id, field.id, e.target.value || null)} className={input} aria-label={field.name}>
          <option value="">Unassigned</option>
          {users.map((u) => (
            <option key={u.id} value={u.id} disabled={u.disabled} className={u.disabled?'text-neutral-500':undefined}>{u.name}{u.disabled?' (disabled)':''}</option>
          ))}
        </select>
      ) : field.type === 'date' ? (
        <input type="date" value={typeof raw === 'string' ? raw : ''} onChange={(e) => void setProp(task.id, field.id, e.target.value || null)} className={input} aria-label={field.name} />
      ) : field.type === 'number' ? (
        <input type="number" value={typeof raw === 'number' ? raw : (raw ?? '') as string | number} onChange={(e) => void setProp(task.id, field.id, e.target.value === '' ? null : Number(e.target.value))} className={input} aria-label={field.name} />
      ) : field.type === 'url' ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <input type="url" value={typeof raw === 'string' ? raw : ''} placeholder="https://…" onBlur={(e) => void setProp(task.id, field.id, e.target.value.trim() || null)} defaultValue={typeof raw === 'string' ? raw : ''} key={task.id + field.id} className={input} aria-label={field.name} />
          {typeof raw === 'string' && raw && (
            <a href={raw} target="_blank" rel="noreferrer" className="shrink-0 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200" aria-label="Open link">
              <ExternalLink size={14} />
            </a>
          )}
        </div>
      ) : (
        <input type="text" defaultValue={typeof raw === 'string' ? raw : ''} key={task.id + field.id} onBlur={(e) => void setProp(task.id, field.id, e.target.value.trim() || null)} className={input} aria-label={field.name} />
      )}
    </>
  );
}

function MultiPicker({ field, task, values }: { field: FieldDef; task: TaskRow; values: string[] }) {
  const opts = field.options ?? [];
  return (
    <Popover
      trigger={
        <button className="flex min-h-[34px] w-full flex-wrap items-center gap-1 rounded-lg border border-neutral-200 bg-white px-2 py-1 text-left text-sm dark:border-neutral-700 dark:bg-neutral-900" aria-label={field.name}>
          {values.length === 0 && <span className="text-neutral-400">Select…</span>}
          {values.map((id) => {
            const o = opts.find((x) => x.id === id);
            if (!o) return null;
            return (
              <span key={id} className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium" style={fieldOptionStyle(o.color)}>
                {o.name}
                <X
                  size={10}
                  className="cursor-pointer opacity-60 hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    void setProp(task.id, field.id, values.filter((v) => v !== id));
                  }}
                />
              </span>
            );
          })}
        </button>
      }
    >
      {() => (
        <div className="w-44 p-1 text-sm">
          {opts.map((o) => {
            const on = values.includes(o.id);
            return (
              <button
                key={o.id}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
                onClick={() => void setProp(task.id, field.id, on ? values.filter((v) => v !== o.id) : [...values, o.id])}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: o.color }} />
                <span className="flex-1 text-xs">{o.name}</span>
                {on && <Check size={12} />}
              </button>
            );
          })}
          {opts.length === 0 && <p className="px-2 py-1.5 text-xs text-neutral-400">No options</p>}
        </div>
      )}
    </Popover>
  );
}

/** Board filter option chips — the board header uses this to filter by a field value. */
export function useFieldFilterOptions(board: BoardRow | undefined) {
  useWorkspaceLocale();
  const users = useUsers();
  return useMemo(() => {
    const fields = fieldsOf(board).filter((f) => f.type === 'select' || f.type === 'multi_select' || f.type === 'person' || f.type === 'checkbox');
    return fields.flatMap((f) => {
      if (f.type === 'select' || f.type === 'multi_select')
        return (f.options ?? []).map((o) => ({ key: `f:${f.id}:${o.id}`, label: `${f.name}: ${o.name}`, test: (t: TaskRow) => { const v = t[propKey(f.id)]; return Array.isArray(v) ? v.includes(o.id) : v === o.id; } }));
      if (f.type === 'person')
        return users.map((u) => ({ key: `f:${f.id}:${u.id}`, label: `${f.name}: ${u.name}`, test: (t: TaskRow) => t[propKey(f.id)] === u.id }));
      return [{ key: `f:${f.id}:true`, label: `${f.name} ✓`, test: (t: TaskRow) => t[propKey(f.id)] === true }];
    });
  }, [board, users]);
}
