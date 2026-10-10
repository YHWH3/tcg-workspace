import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, BringToFront, Combine, SendToBack, Spline, X } from 'lucide-react';
import { db, type LocalRow } from '../../core/db';
import { toast } from '../../core/files';
import { link, unlink } from '../../core/links';
import { mutate } from '../../core/sync/engine';
import { Button, Field, Input, Select, Textarea } from '../../core/ui';
import { ItemPicker, type PickItem } from '../../core/views/picker';
import { columnsOf, type BoardRow } from '../boards/api';
import { alignOps, type GeometryOp } from '../../../shared/mooditems';
import { validateDiagramSpec } from '../../../shared/diagramLayout';
import { addFrame, cardRef, duplicateItem, removeItem, type ItemRef, type MoodItem } from './api';

const OPS: { op: GeometryOp; icon: typeof AlignStartVertical; label: string }[] = [
  { op: 'left', icon: AlignStartVertical, label: 'Align left' },
  { op: 'centerX', icon: AlignCenterVertical, label: 'Align center X' },
  { op: 'right', icon: AlignEndVertical, label: 'Align right' },
  { op: 'top', icon: AlignStartHorizontal, label: 'Align top' },
  { op: 'centerY', icon: AlignCenterHorizontal, label: 'Align center Y' },
  { op: 'bottom', icon: AlignEndHorizontal, label: 'Align bottom' },
];

function NumField({ label, value, onCommit, min }: { label: string; value: number; onCommit: (n: number) => void; min?: number }) {
  const [v, setV] = useState(String(Math.round(value)));
  useEffect(() => setV(String(Math.round(value))), [value]);
  return (
    <Field label={label}>
      <Input
        type="number"
        inputMode="numeric"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = Number(v);
          if (Number.isFinite(n)) onCommit(min !== undefined ? Math.max(min, n) : n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </Field>
  );
}

interface Props {
  items: MoodItem[];
  allItems: MoodItem[];
  boards: LocalRow[];
  boardId: string;
  onClose: () => void;
  onConnect: () => void;
  onConnectPair: (from: string, to: string) => void;
}

/** Selection inspector: full pointer-free editing — geometry, refs, style,
 * frame/stage mirror, link kind, alignment, z-order. */
export function Inspector({ items, allItems, boards, boardId, onClose, onConnect, onConnectPair }: Props) {
  const single = items.length === 1 ? items[0] : null;
  const frames = useMemo(() => allItems.filter((i) => i.type === 'frame' && !i.deleted), [allItems]);
  const [specDraft, setSpecDraft] = useState('');
  useEffect(() => {
    if (single?.type === 'diagram') setSpecDraft(JSON.stringify(single.spec ?? { layout: 'auto-lr', nodes: [], edges: [] }, null, 2));
  }, [single?.id]);

  const stageDb = single?.frameStageOf ? boards.find((b) => b.id === single.frameStageOf!.databaseId) : undefined;
  const stageCols = stageDb ? columnsOf(stageDb as BoardRow) : [];

  const setGeom = (id: string, key: 'x' | 'y' | 'w' | 'h' | 'z', n: number) => void mutate('mooditems', id, { [key]: n });

  const applyAlign = async (op: GeometryOp) => {
    const map = alignOps(items.map((i) => i.id), op, allItems);
    for (const [id, patch] of map) await mutate('mooditems', id, patch);
  };

  const zAll = async (dir: 'front' | 'back') => {
    const zs = allItems.map((i) => Number(i.z ?? 0));
    const maxZ = Math.max(0, ...zs);
    const minZ = Math.min(0, ...zs);
    for (const it of items) await mutate('mooditems', it.id, { z: dir === 'front' ? maxZ + 1 : minZ - 1 });
  };

  const groupSelection = async () => {
    const movable = items.filter((i) => i.type !== 'frame' && i.type !== 'connector');
    if (!movable.length) return;
    const minX = Math.min(...movable.map((i) => Number(i.x ?? 0)));
    const minY = Math.min(...movable.map((i) => Number(i.y ?? 0)));
    const maxX = Math.max(...movable.map((i) => Number(i.x ?? 0) + Number(i.w ?? 100)));
    const maxY = Math.max(...movable.map((i) => Number(i.y ?? 0) + Number(i.h ?? 100)));
    await addFrame(boardId, { x: minX - 24, y: minY - 40, w: maxX - minX + 48, h: maxY - minY + 64, memberIds: movable.map((i) => i.id) });
  };

  const setLinkKind = async (item: MoodItem, kind: '' | 'related' | 'blocks') => {
    if (item.linkId) await unlink(String(item.linkId));
    let mirrorId: string | null = null;
    if (kind) {
      const a = allItems.find((i) => i.id === item.from);
      const b = allItems.find((i) => i.id === item.to);
      const ra = a ? cardRef(a) : null;
      const rb = b ? cardRef(b) : null;
      if (ra?.type === 'record' && rb?.type === 'record') {
        mirrorId = await link({ type: 'record', id: ra.id }, { type: 'record', id: rb.id }, kind, null);
      } else {
        toast('Links only apply between two record cards', 'error');
      }
    }
    await mutate('mooditems', item.id, { linkKind: mirrorId ? kind : null, linkId: mirrorId });
  };

  const setFrameMembership = async (item: MoodItem, frameId: string) => {
    await mutate('mooditems', item.id, { parentFrameId: frameId || null });
    const frame = frames.find((f) => f.id === frameId);
    const ref = cardRef(item);
    if (frame?.frameStageOf?.stageId && ref?.type === 'record') {
      const rec = await db.tasks.get(ref.id);
      if (rec && !rec.deleted && String(rec.boardId ?? '') === frame.frameStageOf!.databaseId && String(rec.status ?? '') !== frame.frameStageOf!.stageId) {
        await mutate('tasks', ref.id, { status: frame.frameStageOf!.stageId });
      }
    }
  };

  return (
    <div className="absolute right-3 top-3 z-20 flex max-h-[calc(100%-6rem)] w-72 flex-col overflow-y-auto rounded-2xl border border-neutral-200/80 bg-white/95 p-3 shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/95" data-testid="mood-inspector">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Inspector</h3>
        <button className="rounded p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={onClose} aria-label="Close inspector">
          <X size={14} />
        </button>
      </div>

      {items.length === 0 && <p className="text-sm text-neutral-400">Select item(s) to edit.</p>}

      {items.length >= 2 && (
        <div className="grid gap-2">
          <p className="text-xs text-neutral-400">{items.length} selected</p>
          <div className="grid grid-cols-6 gap-1">
            {OPS.map(({ op, icon: Icon, label }) => (
              <button key={op} title={label} aria-label={label} className="flex h-8 items-center justify-center rounded-md border border-neutral-200 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800" onClick={() => void applyAlign(op)}>
                <Icon size={14} />
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1">
            <Button size="sm" variant="ghost" disabled={items.length < 3} title="Distribute horizontally" onClick={() => void applyAlign('distribute-h')}>
              <AlignHorizontalDistributeCenter size={14} /> H
            </Button>
            <Button size="sm" variant="ghost" disabled={items.length < 3} title="Distribute vertically" onClick={() => void applyAlign('distribute-v')}>
              <AlignVerticalDistributeCenter size={14} /> V
            </Button>
          </div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="ghost" onClick={() => void zAll('front')} title="Bring to front">
              <BringToFront size={14} /> Front
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void zAll('back')} title="Send to back">
              <SendToBack size={14} /> Back
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void groupSelection()} title="Group into frame (⌘G)">
              <Combine size={14} /> Frame
            </Button>
            {items.length === 2 && (
              <Button size="sm" variant="ghost" onClick={() => onConnectPair(items[0].id, items[1].id)} title="Connect the two items">
                <Spline size={14} /> Connect
              </Button>
            )}
            <Button size="sm" variant="ghost" className="text-red-500" onClick={() => void items.forEach((i) => removeItem(i))}>
              Delete
            </Button>
          </div>
        </div>
      )}

      {single && (
        <div className="grid gap-3">
          <p className="text-xs font-medium text-neutral-500">
            {single.type} · <span className="font-mono">{single.id.slice(0, 8)}</span>
          </p>

          {single.type !== 'connector' && (
            <div className="grid grid-cols-2 gap-2">
              <NumField label="X" value={Number(single.x ?? 0)} onCommit={(n) => setGeom(single.id, 'x', n)} />
              <NumField label="Y" value={Number(single.y ?? 0)} onCommit={(n) => setGeom(single.id, 'y', n)} />
              <NumField label="W" value={Number(single.w ?? 100)} min={10} onCommit={(n) => setGeom(single.id, 'w', n)} />
              <NumField label="H" value={Number(single.h ?? 100)} min={10} onCommit={(n) => setGeom(single.id, 'h', n)} />
              <NumField label="Z" value={Number(single.z ?? 0)} onCommit={(n) => setGeom(single.id, 'z', n)} />
            </div>
          )}

          {(single.type === 'frame' || single.type === 'svg' || single.type === 'diagram' || single.type === 'card') && (
            <Field label="Title">
              <Input defaultValue={String(single.title ?? '')} onBlur={(e) => void mutate('mooditems', single.id, { title: e.target.value })} />
            </Field>
          )}

          {(single.type === 'note' || single.type === 'text' || single.type === 'shape') && (
            <Field label="Text">
              <Textarea rows={3} defaultValue={String(single.text ?? '')} onBlur={(e) => void mutate('mooditems', single.id, { text: e.target.value })} />
            </Field>
          )}

          {(single.type === 'note' || single.type === 'color' || single.type === 'shape') && (
            <Field label={single.type === 'shape' ? 'Fill' : 'Color'}>
              <div className="flex items-center gap-2">
                <input type="color" value={String(single.fill ?? single.color ?? '#a5b4fc')} className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent" onChange={(e) => void mutate('mooditems', single.id, single.type === 'shape' ? { fill: e.target.value } : { color: e.target.value })} />
                <Input defaultValue={String(single.fill ?? single.color ?? '')} className="font-mono text-xs" onBlur={(e) => void mutate('mooditems', single.id, single.type === 'shape' ? { fill: e.target.value } : { color: e.target.value })} />
              </div>
            </Field>
          )}

          {single.type === 'shape' && (
            <>
              <Field label="Shape">
                <Select value={single.shape ?? 'rect'} onChange={(e) => void mutate('mooditems', single.id, { shape: e.target.value })}>
                  <option value="rect">Rectangle</option>
                  <option value="ellipse">Ellipse</option>
                  <option value="diamond">Diamond</option>
                  <option value="pill">Pill</option>
                </Select>
              </Field>
              <Field label="Stroke">
                <input type="color" value={String(single.stroke ?? '#6366f1')} className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent" onChange={(e) => void mutate('mooditems', single.id, { stroke: e.target.value })} />
              </Field>
            </>
          )}

          {single.type === 'frame' && (
            <>
              <Field label="Stage mirror" hint="Dropping a record card here writes the record's stage">
                <Select
                  value={single.frameStageOf?.databaseId ?? ''}
                  onChange={(e) => {
                    const dbId = e.target.value;
                    void mutate('mooditems', single.id, { frameStageOf: dbId ? { databaseId: dbId, stageId: '' } : null });
                  }}
                >
                  <option value="">None</option>
                  {boards.map((b) => (
                    <option key={b.id} value={b.id}>
                      {String(b.icon ?? '')} {String(b.name ?? 'Database')}
                    </option>
                  ))}
                </Select>
              </Field>
              {single.frameStageOf?.databaseId && (
                <Field label="Stage">
                  <Select
                    value={single.frameStageOf?.stageId ?? ''}
                    onChange={(e) => void mutate('mooditems', single.id, { frameStageOf: { databaseId: single.frameStageOf!.databaseId, stageId: e.target.value } })}
                  >
                    <option value="">Pick stage…</option>
                    {stageCols.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </>
          )}

          {single.type === 'card' && <RefEditor item={single} />}

          {single.type !== 'frame' && single.type !== 'connector' && (
            <Field label="Frame">
              <Select value={String(single.parentFrameId ?? '')} onChange={(e) => void setFrameMembership(single, e.target.value)}>
                <option value="">None</option>
                {frames.map((f) => (
                  <option key={f.id} value={f.id}>
                    {String(f.title ?? 'Frame')}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {single.type === 'connector' && (
            <>
              <Field label="Label">
                <Input defaultValue={String(single.label ?? '')} onBlur={(e) => void mutate('mooditems', single.id, { label: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Style">
                  <Select value={single.style ?? 'solid'} onChange={(e) => void mutate('mooditems', single.id, { style: e.target.value })}>
                    <option value="solid">Solid</option>
                    <option value="dashed">Dashed</option>
                  </Select>
                </Field>
                <Field label="Arrow">
                  <Select value={single.arrow ?? 'end'} onChange={(e) => void mutate('mooditems', single.id, { arrow: e.target.value })}>
                    <option value="end">End</option>
                    <option value="both">Both</option>
                    <option value="none">None</option>
                  </Select>
                </Field>
              </div>
              <Field label="Link kind" hint={single.linkId ? 'Mirrored to the links collection' : 'Creates a links row between the endpoint records'}>
                <Select value={single.linkKind ?? ''} onChange={(e) => void setLinkKind(single, e.target.value as '' | 'related' | 'blocks')}>
                  <option value="">None</option>
                  <option value="related">Related</option>
                  <option value="blocks">Blocks</option>
                </Select>
              </Field>
            </>
          )}

          {single.type === 'diagram' && (
            <Field label="Spec JSON" hint="Validated on apply">
              <Textarea rows={6} className="font-mono text-xs" value={specDraft} onChange={(e) => setSpecDraft(e.target.value)} />
              <Button
                size="sm"
                className="mt-1"
                variant="primary"
                onClick={() => {
                  try {
                    const spec = JSON.parse(specDraft);
                    const v = validateDiagramSpec(spec);
                    if (!v.ok) {
                      toast(`Diagram rejected: ${v.reasons.join(', ')}`, 'error');
                      return;
                    }
                    void mutate('mooditems', single.id, { spec: v.spec });
                  } catch {
                    toast('Invalid JSON', 'error');
                  }
                }}
              >
                Apply spec
              </Button>
            </Field>
          )}

          <div className="flex flex-wrap gap-1 border-t border-neutral-100 pt-2 dark:border-neutral-800">
            <Button size="sm" variant="ghost" onClick={() => void duplicateItem(boardId, single)} title="Duplicate (⌘D)">
              Duplicate
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void zAll('front')} title="Bring to front">
              <BringToFront size={14} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void zAll('back')} title="Send to back">
              <SendToBack size={14} />
            </Button>
            <Button size="sm" variant="ghost" onClick={onConnect} title="Connect from this item">
              <Spline size={14} /> Connect
            </Button>
            <Button size="sm" variant="ghost" className="text-red-500" onClick={() => void removeItem(single)}>
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Card ref re-picker: record or page via the shared ItemPicker. */
function RefEditor({ item }: { item: MoodItem }) {
  const tasks = useLiveQuery(() => db.tasks.filter((t) => !t.deleted).toArray(), [], []) as LocalRow[] | undefined;
  const pages = useLiveQuery(() => db.pages.filter((p) => !p.deleted).toArray(), [], []) as LocalRow[] | undefined;
  const ref = cardRef(item);
  const items = useMemo<PickItem[]>(() => {
    const out: PickItem[] = [];
    for (const t of tasks ?? []) out.push({ ref: { type: 'record', id: t.id }, title: String(t.title ?? 'Untitled'), subtitle: 'Record' });
    for (const p of pages ?? []) out.push({ ref: { type: 'page', id: p.id }, title: String(p.title ?? 'Untitled'), subtitle: 'Page' });
    return out;
  }, [tasks, pages]);
  return (
    <Field label="Links to" hint={ref ? `${ref.type} · ${ref.id.slice(0, 8)}` : 'unlinked'}>
      <ItemPicker
        trigger={
          <Button size="sm" variant="ghost" className="w-full justify-start">
            Change…
          </Button>
        }
        items={items}
        placeholder="Search records and pages…"
        onPick={(it) => void mutate('mooditems', item.id, { ref: it.ref as ItemRef })}
      />
    </Field>
  );
}
