import { useMemo, useState } from 'react';
import { AdaptiveDialog, Button, Field, Input, Select } from '../../core/ui';
import { cardRef, type MoodItem } from './api';

interface Props {
  open: boolean;
  from: string | null;
  to: string | null;
  items: MoodItem[];
  onClose: () => void;
  onCreate: (opts: { label?: string; style?: 'solid' | 'dashed'; arrow?: 'end' | 'both' | 'none'; linkKind?: 'blocks' | 'related' | null }) => Promise<void> | void;
}

const itemLabel = (i: MoodItem | undefined) =>
  i ? `${i.type} · ${String(i.title ?? i.text ?? '').trim().slice(0, 40) || i.id.slice(0, 6)}` : '?';

/** Endpoint pair → connector + optional mirrored record link (one batch). */
export function ConnectFlow({ open, from, to, items, onClose, onCreate }: Props) {
  const [label, setLabel] = useState('');
  const [style, setStyle] = useState<'solid' | 'dashed'>('solid');
  const [arrow, setArrow] = useState<'end' | 'both' | 'none'>('end');
  const [kind, setKind] = useState<'' | 'related' | 'blocks'>('');

  const a = useMemo(() => items.find((i) => i.id === from), [items, from]);
  const b = useMemo(() => items.find((i) => i.id === to), [items, to]);
  // Record links only exist between record cards — degrade to a plain arrow.
  const linkable = !!a && !!b && cardRef(a)?.type === 'record' && cardRef(b)?.type === 'record';

  if (!open) return null;
  return (
    <AdaptiveDialog title="Connect items" onClose={onClose}>
      <div className="px-4 pb-4 pt-1 sm:px-0 sm:pb-0">
        <p className="mb-3 text-xs text-[var(--muted)]">
          {itemLabel(a)} → {itemLabel(b)}
        </p>
        <div className="grid gap-3">
          <Field label="Label">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="optional label" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Style">
              <Select value={style} onChange={(e) => setStyle(e.target.value as 'solid' | 'dashed')}>
                <option value="solid">Solid</option>
                <option value="dashed">Dashed</option>
              </Select>
            </Field>
            <Field label="Arrow">
              <Select value={arrow} onChange={(e) => setArrow(e.target.value as 'end' | 'both' | 'none')}>
                <option value="end">End</option>
                <option value="both">Both</option>
                <option value="none">None</option>
              </Select>
            </Field>
          </div>
          <Field label="Record link" hint={linkable ? 'Also writes a links row (visible in record detail + timeline deps)' : 'Only record→record cards can mirror a link'}>
            <Select value={kind} disabled={!linkable} onChange={(e) => setKind(e.target.value as '' | 'related' | 'blocks')}>
              <option value="">None (plain arrow)</option>
              <option value="related">Related</option>
              <option value="blocks">Blocks</option>
            </Select>
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              void onCreate({ label: label.trim() || undefined, style, arrow, linkKind: kind || null });
              setLabel('');
              setKind('');
            }}
          >
            Connect
          </Button>
        </div>
      </div>
    </AdaptiveDialog>
  );
}
