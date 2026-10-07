import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { mutate } from '../../core/sync/engine';
import { IconButton, Select } from '../../core/ui';
import { cn, uuid } from '../../core/utils';
import { COLUMN_COLORS } from './model';
import { FIELD_TYPES, fieldsOf, isSelectType, type FieldDef, type FieldType } from './model';
import type { BoardRow } from './api';

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
      {fields.length === 0 && <p className="py-2 text-xs text-neutral-400">No custom fields yet. Fields appear on task cards and in task details.</p>}
      <div className="mt-3 flex items-center gap-2 border-t border-neutral-100 pt-3 dark:border-neutral-800">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Field name" className="h-9 min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900" aria-label="New field name" />
        <Select value={newType} onChange={(e) => setNewType(e.target.value as FieldType)} className="py-1.5 text-xs" aria-label="New field type">
          {FIELD_TYPES.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </Select>
        <IconButton aria-label="Add field" onClick={add} className="bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900">
          <Plus size={16} />
        </IconButton>
      </div>
    </div>
  );
}

function FieldRow({ field, first, last, onChange, onMove, onDelete }: { field: FieldDef; first: boolean; last: boolean; onChange: (p: Partial<FieldDef>) => void; onMove: (d: -1 | 1) => void; onDelete: () => void }) {
  const [name, setName] = useState(field.name);
  const [newOpt, setNewOpt] = useState('');
  const input = 'h-8 min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2 text-xs outline-none focus:ring-2 focus:ring-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900';
  const addOption = () => {
    const n = newOpt.trim();
    if (!n) return;
    setNewOpt('');
    onChange({ options: [...(field.options ?? []), { id: uuid().slice(0, 8), name: n, color: COLUMN_COLORS[(field.options?.length ?? 0) % COLUMN_COLORS.length] }] });
  };
  return (
    <div className="rounded-xl border border-neutral-200/70 p-2.5 dark:border-neutral-800">
      <div className="flex items-center gap-1.5">
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== field.name && onChange({ name: name.trim() })} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} className={input} aria-label="Field name" />
        <Select
          value={field.type}
          onChange={(e) => {
            const type = e.target.value as FieldType;
            onChange({ type, ...(isSelectType(type) && !field.options ? { options: [] } : {}) });
          }}
          className="w-28 shrink-0 py-1 text-xs"
          aria-label="Field type"
        >
          {FIELD_TYPES.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </Select>
        <IconButton aria-label="Move up" className="h-7 w-7" disabled={first} onClick={() => onMove(-1)}>
          <ArrowUp size={13} />
        </IconButton>
        <IconButton aria-label="Move down" className="h-7 w-7" disabled={last} onClick={() => onMove(1)}>
          <ArrowDown size={13} />
        </IconButton>
        <IconButton aria-label="Delete field" className="h-7 w-7" onClick={onDelete}>
          <Trash2 size={13} />
        </IconButton>
      </div>
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
      <label className="mt-2 flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        <input type="checkbox" checked={!!field.showOnCard} onChange={(e) => onChange({ showOnCard: e.target.checked })} className="h-3.5 w-3.5 accent-neutral-900 dark:accent-neutral-200" />
        Show on card
      </label>
    </div>
  );
}
