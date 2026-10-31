import {useWorkspaceLocale,workspaceCurrency,workspaceTimeZone} from '../workspaceLocale';
/**
 * Field-key → compact cell editors/renderers shared by TableView, ListView
 * and GalleryView. Builtin keys render read/write controls; p_* keys reuse
 * the field-type editors; rel_* keys use the relation picker.
 */
import { Check } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { authStore } from '../auth';
import { fieldOptionStyle } from '../fieldColors';
import { db } from '../db';
import { mutate } from '../sync/engine';
import { Avatar, Popover, Select } from '../ui';
import { resolveUser, useUsers } from '../users';
import { cn, formatDate } from '../utils';
import { useTokenResolver } from '../resolveMentions';
import { renderPlain } from '../mentions';
import { columnIdFor, lastColumnId, PRIORITIES, type BoardRow, type TaskRow } from '../../modules/boards/api';
import { fieldsOf, propKey,formatNumber, type FieldDef } from '../../../shared/fields';
import { isRelationField, useLinks, type RelationFieldDef } from '../links';
import { stagesOf, showBuiltinsOf } from '../records';
import { RelationPicker } from './picker';

const cellInput =
  'w-full min-w-0 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-base text-ellipsis sm:text-[13px] focus:border-neutral-200 focus:bg-white focus:outline-none dark:focus:border-neutral-700 dark:focus:bg-neutral-900';

export async function setRecordProp(recordId: string, key: string, value: unknown): Promise<void> {
  await mutate('tasks', recordId, { [key]: value ?? null });
}

/* ---------- read-only display ---------- */

/** Compact display value for chips/cards (no editing). */
export function CellValue({ board, rec, keyName }: { board: BoardRow | undefined; rec: TaskRow; keyName: string }) {
  useWorkspaceLocale();
  const users = useUsers();
  const me = authStore.get().user;
  const links = useLinks();
  const resolve = useTokenResolver();
  if (keyName === 'title') return <span className="truncate">{renderPlain(String(rec.title ?? ''), resolve) || 'Untitled'}</span>;
  if (keyName === 'status') {
    const col = stagesOf(board).find((c) => c.id === columnIdFor(rec, board));
    return col ? (
      <span className="inline-flex items-center gap-1 truncate text-neutral-500 dark:text-neutral-400">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: col.color }} />
        {col.name}
      </span>
    ) : null;
  }
  if (keyName === 'assigneeId') {
    const u = resolveUser(rec.assigneeId ? String(rec.assigneeId) : null, users, me);
    return u ? (
      <span className="inline-flex items-center gap-1 truncate text-neutral-500 dark:text-neutral-400">
        <Avatar name={u.name} color={u.color} size={16} /> {u.name}{u.disabled?' (disabled)':''}
      </span>
    ) : null;
  }
  if (keyName === 'dueDate') return rec.dueDate ? <span className="text-neutral-500 dark:text-neutral-400">{formatDate(String(rec.dueDate))}</span> : null;
  if (keyName === 'priority') {
    const p = PRIORITIES.find((x) => x.id === rec.priority);
    return p && p.id !== 'none' ? <span className={p.cls}>{p.label}</span> : null;
  }
  if (keyName === 'createdAt') return rec.createdAt ? <span className="text-neutral-500 dark:text-neutral-400">{new Date(Number(rec.createdAt)).toLocaleDateString(undefined,{timeZone:workspaceTimeZone()})}</span> : null;
  if (keyName === 'createdBy') {
    const u = resolveUser(rec.createdBy ? String(rec.createdBy) : null, users, me);
    return u ? <span className="truncate text-neutral-500 dark:text-neutral-400">{u.name}</span> : null;
  }
  if (keyName.startsWith('rel_')) {
    const fid = keyName.slice(4);
    const ids = links.filter((l) => !l.deleted && l.kind === 'relation' && l.fieldId === fid && l.fromId === rec.id).map((l) => String(l.toId));
    const revIds = links.filter((l) => !l.deleted && l.kind === 'relation' && l.fieldId === fid && l.toId === rec.id).map((l) => String(l.fromId));
    const all = [...new Set([...ids, ...revIds])];
    if (!all.length) return null;
    return (
      <span className="inline-flex items-center gap-0.5">
        <RelChipTitles ids={all.slice(0, 3)} />
        {all.length > 3 && <span className="text-[11px] text-neutral-400">+{all.length - 3}</span>}
      </span>
    );
  }
  if (keyName.startsWith('p_')) {
    const f = fieldsOf(board).find((x) => x.id === keyName.slice(2));
    if (!f) return null;
    return <PropValue field={f} raw={rec[propKey(f.id)]} />;
  }
  return null;
}

function RelChipTitles({ ids }: { ids: string[] }) {
  const titles = useLiveQuery(
    async () => {
      const map = new Map<string, string>();
      for (const id of ids) {
        const t = await db.tasks.get(id);
        if (t && !t.deleted) {
          map.set(id, String(t.title ?? 'Untitled'));
          continue;
        }
        const p = await db.pages.get(id);
        if (p && !p.deleted) map.set(id, String(p.title ?? 'Untitled'));
      }
      return map;
    },
    [ids.join(',')],
    new Map<string, string>(),
  );
  return (
    <>
      {ids.slice(0, 3).map((id) => (
        <span key={id} className="inline-flex max-w-28 truncate rounded-full bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
          {titles.get(id) ?? '…'}
        </span>
      ))}
    </>
  );
}

function PropValue({ field, raw }: { field: FieldDef; raw: unknown }) {
  useWorkspaceLocale();
  const users = useUsers();
  const me = authStore.get().user;
  if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && !raw.length)) return null;
  if (field.type === 'select') {
    const o = (field.options ?? []).find((x) => x.id === raw);
    return o ? (
      <span className="inline-flex max-w-32 items-center truncate rounded-full px-1.5 py-0.5 text-[11px] font-medium" style={fieldOptionStyle(o.color)}>
        {o.name}
      </span>
    ) : null;
  }
  if (field.type === 'multi_select') {
    const opts = (Array.isArray(raw) ? raw : []).map((id) => (field.options ?? []).find((o) => o.id === id)).filter(Boolean);
    return (
      <span className="inline-flex items-center gap-0.5">
        {opts.slice(0, 2).map((o) => (
          <span key={o!.id} className="inline-flex max-w-28 truncate rounded-full px-1.5 py-0.5 text-[11px] font-medium" style={fieldOptionStyle(o!.color)}>
            {o!.name}
          </span>
        ))}
        {opts.length > 2 && <span className="text-[11px] text-neutral-400">+{opts.length - 2}</span>}
      </span>
    );
  }
  if (field.type === 'checkbox') return raw === true ? <Check size={13} className="text-neutral-500" /> : null;
  if (field.type === 'person') {
    const u = resolveUser(typeof raw === 'string' ? raw : null, users, me);
    return u ? (
      <span className="inline-flex items-center gap-1 text-neutral-500 dark:text-neutral-400">
        <Avatar name={u.name} color={u.color} size={15} /> {u.name}{u.disabled?' (disabled)':''}
      </span>
    ) : null;
  }
  return <span className="truncate text-neutral-500 dark:text-neutral-400">{field.type==='number'?formatNumber(Number(raw),field,workspaceCurrency()):String(raw)}</span>;
}

/* ---------- editable cells (table) ---------- */

export function CellEditor({ board, rec, keyName, onCommit }: { board: BoardRow | undefined; rec: TaskRow; keyName: string; onCommit?: () => void }) {
  const users = useUsers();
  const cols = stagesOf(board);
  const builtins = showBuiltinsOf(board);
  void builtins;

  if (keyName === 'title') {
    return (
      <input
        key={rec.id + String(rec.title ?? '')}
        defaultValue={String(rec.title ?? '')}
        className={cn(cellInput, 'font-medium')}
        placeholder="Untitled"
        aria-label="Title"
        title={String(rec.title ?? 'Untitled')}
        onBlur={(e) => {
          const v = e.target.value;
          if (v !== String(rec.title ?? '')) void mutate('tasks', rec.id, { title: v });
          onCommit?.();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
        }}
      />
    );
  }
  if (keyName === 'status' && cols.length) {
    return (
      <Select density="compact" value={columnIdFor(rec, board)} onChange={(e) => void mutate('tasks', rec.id, { status: e.target.value })} className="py-0.5" aria-label="Stage">
        {cols.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
    );
  }
  if (keyName === 'assigneeId') {
    return (
      <Select density="compact" value={String(rec.assigneeId ?? '')} onChange={(e) => void mutate('tasks', rec.id, { assigneeId: e.target.value || null })} className="py-0.5" aria-label="Assignee">
        <option value="">—</option>
        {users.map((u) => (
          <option key={u.id} value={u.id} disabled={u.disabled} className={u.disabled?'text-neutral-500':undefined}>
            {u.name}{u.disabled?' (disabled)':''}
          </option>
        ))}
      </Select>
    );
  }
  if (keyName === 'dueDate') {
    return <input type="date" value={String(rec.dueDate ?? '')} onChange={(e) => void mutate('tasks', rec.id, { dueDate: e.target.value || null })} className={cellInput} aria-label="Due date" />;
  }
  if (keyName === 'priority') {
    return (
      <Select density="compact" value={rec.priority ?? 'none'} onChange={(e) => void mutate('tasks', rec.id, { priority: e.target.value })} className="py-0.5" aria-label="Priority">
        {PRIORITIES.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </Select>
    );
  }
  if (keyName === 'createdAt' || keyName === 'createdBy') return <CellValue board={board} rec={rec} keyName={keyName} />;
  if (keyName.startsWith('rel_')) {
    const f = fieldsOf(board).find((x) => x.id === keyName.slice(4));
    if (!f || !isRelationField(f as RelationFieldDef)) return null;
    return <RelationPicker record={rec} field={f as RelationFieldDef} />;
  }
  if (keyName.startsWith('p_')) {
    const f = fieldsOf(board).find((x) => x.id === keyName.slice(2));
    if (!f) return null;
    return <PropCell field={f} rec={rec} />;
  }
  return null;
}

function PropCell({ field, rec }: { field: FieldDef; rec: TaskRow }) {
  const users = useUsers();
  const raw = rec[propKey(field.id)] as unknown;
  const set = (v: unknown) => void mutate('tasks', rec.id, { [propKey(field.id)]: v ?? null });

  switch (field.type) {
    case 'checkbox':
      return <input type="checkbox" checked={raw === true} onChange={(e) => set(e.target.checked)} className="h-4 w-4 accent-neutral-900 dark:accent-neutral-200" aria-label={field.name} />;
    case 'select':
      return (
        <Select density="compact" value={typeof raw === 'string' ? raw : ''} onChange={(e) => set(e.target.value || null)} className="py-0.5" aria-label={field.name}>
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      );
    case 'multi_select': {
      const values = Array.isArray(raw) ? (raw as string[]) : [];
      return (
        <Popover
          trigger={
            <button className="flex min-h-[28px] w-full flex-wrap items-center gap-0.5 rounded-md px-1 text-left text-[13px]">
              <span className="sr-only">{field.name}: </span>
              {values.length === 0 ? <span className="text-neutral-400">—</span> : <PropValue field={field} raw={values} />}
            </button>
          }
        >
          {() => (
            <div className="w-44 p-1 text-sm">
              {(field.options ?? []).map((o) => {
                const on = values.includes(o.id);
                return (
                  <button key={o.id} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => set(on ? values.filter((v) => v !== o.id) : [...values, o.id])}>
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: o.color }} />
                    <span className="flex-1 text-xs">{o.name}</span>
                    {on && <Check size={12} />}
                  </button>
                );
              })}
              {(field.options ?? []).length === 0 && <p className="px-2 py-1.5 text-xs text-neutral-400">No options</p>}
            </div>
          )}
        </Popover>
      );
    }
    case 'person':
      return (
        <Select density="compact" value={typeof raw === 'string' ? raw : ''} onChange={(e) => set(e.target.value || null)} className="py-0.5" aria-label={field.name}>
          <option value="">—</option>
          {users.map((u) => (
            <option key={u.id} value={u.id} disabled={u.disabled} className={u.disabled?'text-neutral-500':undefined}>
              {u.name}{u.disabled?' (disabled)':''}
            </option>
          ))}
        </Select>
      );
    case 'date':
      return <input type="date" value={typeof raw === 'string' ? raw : ''} onChange={(e) => set(e.target.value || null)} className={cellInput} aria-label={field.name} />;
    case 'number':
      return <NumberCell field={field} raw={raw} recordId={rec.id} onCommit={set}/>;
    case 'url':
    case 'text':
    default:
      return (
        <input
          type={field.type === 'url' ? 'url' : 'text'}
          key={rec.id + field.id + String(raw ?? '')}
          defaultValue={typeof raw === 'string' ? raw : ''}
          onBlur={(e) => {
            if (e.target.value.trim() !== String(raw ?? '')) set(e.target.value.trim() || null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
          }}
          className={cellInput}
          aria-label={field.name}
          title={String(raw ?? '')}
        />
      );
  }
}

/* ---------- card helpers ---------- */

/** sub-progress "2/5" for cards, and blocked badge. */
export function subProgress(rec: TaskRow, allTasks: TaskRow[], board: BoardRow | undefined): { done: number; total: number } {
  const kids = allTasks.filter((t) => !t.deleted && String(t.parentId ?? '') === rec.id);
  return { done: kids.filter((k) => columnIdFor(k, board) === lastColumnId(board) && stagesOf(board).length > 0).length, total: kids.length };
}

function NumberCell({field,raw,recordId,onCommit}:{field:FieldDef;raw:unknown;recordId:string;onCommit:(value:unknown)=>void}){
 useWorkspaceLocale();const currency=field.currency??workspaceCurrency(),formatted=field.format&&field.format!=='plain',empty=raw===null||raw===undefined||raw==='';
 return <div className="relative w-full" title={field.format==='currency'?currency+(field.currency?', field currency':', workspace default'):undefined}>
  <input type="number" key={recordId+field.id+String(raw??'')} defaultValue={typeof raw==='number'?raw:((raw??'') as string|number)} onBlur={e=>onCommit(e.target.value===''?null:Number(e.target.value))} className={cn(cellInput,formatted&&'peer text-transparent focus:text-neutral-900 dark:focus:text-white')} aria-label={field.name+(field.format==='currency'?' ('+currency+')':'')}/>
  {formatted&&<span aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center truncate px-1.5 text-[13px] peer-focus:hidden">{empty?'':formatNumber(Number(raw),field,workspaceCurrency())}</span>}
 </div>;
}
