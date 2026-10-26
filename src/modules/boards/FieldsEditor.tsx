import {useWorkspaceLocale,workspaceCurrency} from '../../core/workspaceLocale';
import {validCurrency} from '../../../shared/workspaceSettings';
import { useEffect,useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { mutate } from '../../core/sync/engine';
import { IconButton, Select } from '../../core/ui';
import { cn, uuid } from '../../core/utils';
import { COLUMN_COLORS } from './model';
import { FIELD_TYPES, fieldsOf, isSelectType, type FieldDef, type FieldType } from './model';
import { useBoards, type BoardRow } from './api';
import { actionsForContext, BASE_CAPTURE_KINDS, CAPTURE_KIND_LABELS, captureTargetsOf, fieldActionsOf, ROUTED_KINDS, type CaptureKind, type CaptureTarget, type RoutedKind } from './fieldMode';

/**
 * Board custom-field editor — shown as a sheet (parent decides popover/sheet).
 * Edits the board's single `fields` LWW array.
 */
export function FieldsEditor({ board }: { board: BoardRow }) {
  const fields = fieldsOf(board);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<FieldType>('text');

  const save = (next: FieldDef[]) => void mutate('boards', board.id, { fields: next });
  const update = (id: string, patch: Partial<FieldDef>) => save(fields.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const move = (id: string, dir: -1 | 1) => {
    const i = fields.findIndex((f) => f.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j], next[i]];
    save(next);
  };
  const add = () => {
    const name = newName.trim();
    if (!name) return;
    setNewName('');
    save([...fields, { id: uuid().slice(0, 8), name, type: newType, ...(isSelectType(newType) ? { options: [] } : {}) }]);
  };

  return (
    <div className="flex min-h-0 flex-col gap-1 p-4">
      <h3 className="mb-2 text-sm font-semibold">Fields</h3>
      {fields.map((f, i) => (
        <FieldRow key={f.id} field={f} first={i === 0} last={i === fields.length - 1} onChange={(p) => update(f.id, p)} onMove={(d) => move(f.id, d)} onDelete={() => save(fields.filter((x) => x.id !== f.id))} />
      ))}
      {fields.length === 0 && <p className="py-2 text-xs text-neutral-600 dark:text-neutral-400">No custom fields yet. Fields appear on task cards and in task details.</p>}
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-neutral-100 pt-3 sm:flex dark:border-neutral-800">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Field name" className="col-span-2 h-11 min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-3 text-base outline-none sm:h-9 sm:min-w-28 sm:text-sm focus:ring-2 focus:ring-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900" aria-label="New field name" />
        <Select value={newType} onChange={(e) => setNewType(e.target.value as FieldType)} className="h-11 min-w-0 py-1.5 text-base sm:h-9 sm:w-32 sm:text-xs" aria-label="New field type">
          {FIELD_TYPES.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </Select>
        <IconButton aria-label="Add field" onClick={add} className="h-11 w-11 shrink-0 bg-neutral-900 text-white hover:bg-neutral-700 sm:h-8 sm:w-8 dark:bg-white dark:text-neutral-900">
          <Plus size={16} />
        </IconButton>
      </div>
      <CaptureTargetsSection board={board} />
    </div>
  );
}

/**
 * Phase 3 field mode — per-database capture routing. When a record (or the
 * database itself) is the field-capture context, each routable kind resolves
 * to a destination database; fieldActions limits which quick actions the
 * capture sheet offers. Edits board.captureTargets / board.fieldActions.
 */
function CaptureTargetsSection({ board }: { board: BoardRow }) {
  const boards = useBoards();
  const targets = captureTargetsOf(board);
  const explicit = fieldActionsOf(board);
  const effective = actionsForContext(board);

  const setTarget = (kind: RoutedKind, databaseId: string) => {
    const next: CaptureTarget[] = targets.filter((t) => t.kind !== kind);
    if (databaseId) next.push({ kind, databaseId });
    void mutate('boards', board.id, { captureTargets: next });
  };
  const toggleAction = (kind: CaptureKind) => {
    const next = effective.includes(kind) ? effective.filter((k) => k !== kind) : [...effective, kind];
    void mutate('boards', board.id, { fieldActions: next });
  };

  const sel = 'h-11 sm:h-8 min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2 text-base sm:text-xs outline-none focus:ring-2 focus:ring-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900';
  return (
    <div className="mt-4 border-t border-neutral-100 pt-3 dark:border-neutral-800">
      <h3 className="mb-1 text-sm font-semibold">Capture targets</h3>
      <p className="mb-2 text-xs text-neutral-600 dark:text-neutral-400">When a record here is the field-capture context, route each kind to a database.</p>
      <div className="space-y-1.5">
        {ROUTED_KINDS.map((k) => {
          const current = targets.find((t) => t.kind === k)?.databaseId ?? '';
          return (
            <div key={k} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-neutral-600 dark:text-neutral-300">{CAPTURE_KIND_LABELS[k]}</span>
              <Select density="compact" value={current} onChange={(e) => setTarget(k, e.target.value)} className={sel} aria-label={`${CAPTURE_KIND_LABELS[k]} destination`}>
                <option value="">{k === 'task' || k === 'note' ? 'Default (Inbox)' : 'Ask each time'}</option>
                {boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {String(b.icon ?? '')} {String(b.name ?? 'Board')}
                  </option>
                ))}
              </Select>
            </div>
          );
        })}
      </div>
      <p className="mb-1.5 mt-3 text-xs font-medium text-neutral-500 dark:text-neutral-400">Field actions</p>
      <p className="mb-2 text-xs text-neutral-600 dark:text-neutral-400">Quick actions offered when this database is the capture context.</p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Field actions">
        {BASE_CAPTURE_KINDS.map((k) => {
          const on = effective.includes(k);
          return (
            <button
              key={k}
              onClick={() => toggleAction(k)}
              aria-pressed={on}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                on
                  ? 'border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900'
                  : 'border-neutral-200 text-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400',
              )}
            >
              {CAPTURE_KIND_LABELS[k]}
            </button>
          );
        })}
      </div>
      {explicit && <p className="mt-2 text-[10px] text-neutral-600 dark:text-neutral-400">Custom set active — reset by toggling all on/off states back to the default mix.</p>}
    </div>
  );
}

function FieldRow({ field, first, last, onChange, onMove, onDelete }: { field: FieldDef; first: boolean; last: boolean; onChange: (p: Partial<FieldDef>) => void; onMove: (d: -1 | 1) => void; onDelete: () => void }) {
  useWorkspaceLocale();
  const [currencyDraft,setCurrencyDraft]=useState(field.currency??''),[currencyDirty,setCurrencyDirty]=useState(false);
  useEffect(()=>{if(!currencyDirty)setCurrencyDraft(field.currency??'');},[field.currency,currencyDirty]);
  const [name, setName] = useState(field.name);
  const [newOpt, setNewOpt] = useState('');
  const input = 'h-11 sm:h-8 min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2 text-base sm:text-xs outline-none focus:ring-2 focus:ring-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900';
  const addOption = () => {
    const n = newOpt.trim();
    if (!n) return;
    setNewOpt('');
    onChange({ options: [...(field.options ?? []), { id: uuid().slice(0, 8), name: n, color: COLUMN_COLORS[(field.options?.length ?? 0) % COLUMN_COLORS.length] }] });
  };
  return (
    <div className="rounded-xl border border-neutral-200/70 p-2.5 dark:border-neutral-800">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 sm:flex sm:flex-wrap">
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== field.name && onChange({ name: name.trim() })} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} className={cn(input,'col-span-2 sm:min-w-28')} aria-label="Field name" />
        <Select
          value={field.type}
          onChange={(e) => {
            const type = e.target.value as FieldType;
            onChange({ type, ...(isSelectType(type) && !field.options ? { options: [] } : {}) });
          }}
          className="h-11 min-w-0 py-1 text-base sm:h-9 sm:w-28 sm:shrink-0 sm:text-xs"
          aria-label="Field type"
        >
          {FIELD_TYPES.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </Select>
        <div className="flex shrink-0 items-center">
          <IconButton aria-label="Move up" className="h-11 w-11 sm:h-8 sm:w-8" disabled={first} onClick={() => onMove(-1)}>
            <ArrowUp size={13} />
          </IconButton>
          <IconButton aria-label="Move down" className="h-11 w-11 sm:h-8 sm:w-8" disabled={last} onClick={() => onMove(1)}>
            <ArrowDown size={13} />
          </IconButton>
          <IconButton aria-label="Delete field" className="h-11 w-11 sm:h-8 sm:w-8" onClick={onDelete}>
            <Trash2 size={13} />
          </IconButton>
        </div>
      </div>
      {field.type==='number'&&<div className="mt-2 space-y-2">
        <Select value={field.format??'plain'} aria-label={field.name+' number format'} onChange={e=>onChange({format:e.target.value as FieldDef['format']})}><option value="plain">Plain number</option><option value="currency">Currency</option><option value="percent">Percent</option></Select>
        {field.format==='percent'&&<p className="text-xs text-neutral-600 dark:text-neutral-400">Enter fractions: 0.25 displays as 25%.</p>}
        {field.format==='currency'&&<><input value={currencyDraft} maxLength={3} placeholder={workspaceCurrency()+' (workspace default)'} className={input+' w-full'} aria-label={field.name+' currency override'} aria-invalid={!!currencyDraft&&!validCurrency(currencyDraft)} onChange={e=>{setCurrencyDirty(true);setCurrencyDraft(e.target.value.toUpperCase());}} onBlur={()=>{if(currencyDirty&&(!currencyDraft||validCurrency(currencyDraft))){if(currencyDraft!==(field.currency??''))onChange({currency:currencyDraft||undefined});setCurrencyDirty(false);}}}/>
        <p className="text-xs text-neutral-600 dark:text-neutral-400">{field.currency?field.currency+', field currency':workspaceCurrency()+', workspace default'}. No currency conversion.</p>{currencyDraft&&!validCurrency(currencyDraft)&&<p role="alert" className="text-xs">Enter a valid ISO currency code or leave blank.</p>}</>}
      </div>}
      {isSelectType(field.type) && (
        <div className="mt-2 space-y-1">
          {(field.options ?? []).map((o, oi) => (
            <div key={o.id} className="flex items-center gap-1.5">
              <span className="flex flex-wrap gap-0.5">
                {COLUMN_COLORS.map((c) => (
                  <button key={c} onClick={() => onChange({ options: (field.options ?? []).map((x) => (x.id === o.id ? { ...x, color: c } : x)) })} className={cn('h-3.5 w-3.5 rounded-full transition-transform', o.color === c && 'ring-2 ring-neutral-400 ring-offset-1')} style={{ background: c }} aria-label={`Color ${c}`} />
                ))}
              </span>
              <input
                defaultValue={o.name}
                key={o.id}
                onBlur={(e) => e.target.value.trim() && e.target.value !== o.name && onChange({ options: (field.options ?? []).map((x) => (x.id === o.id ? { ...x, name: e.target.value.trim() } : x)) })}
                className={cn(input, 'flex-1')}
                aria-label={`Option ${oi + 1}`}
              />
              <IconButton aria-label="Delete option" className="h-6 w-6" onClick={() => onChange({ options: (field.options ?? []).filter((x) => x.id !== o.id) })}>
                <X size={12} />
              </IconButton>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <input value={newOpt} onChange={(e) => setNewOpt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addOption()} placeholder="Add option…" className={input} aria-label="New option name" />
          </div>
        </div>
      )}
      <label className="mt-2 flex min-h-11 items-center gap-2 text-xs sm:min-h-0 text-neutral-500 dark:text-neutral-400">
        <input type="checkbox" checked={!!field.showOnCard} onChange={(e) => onChange({ showOnCard: e.target.checked })} className="h-3.5 w-3.5 accent-neutral-900 dark:accent-neutral-200" />
        Show on card
      </label>
    </div>
  );
}
