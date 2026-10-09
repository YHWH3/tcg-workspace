import { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Circle, CreditCard, Diamond, FileText, Frame as FrameIcon, Image as ImageIcon, Paintbrush, Pill, Plus, Spline, Square, StickyNote, Type, Workflow } from 'lucide-react';
import { db, type LocalRow } from '../../core/db';
import { Button, Popover, Textarea } from '../../core/ui';
import { ItemPicker, type PickItem } from '../../core/views/picker';
import { taskBoardIdOf } from '../../core/views/shared';
import type { ItemRef } from './api';

interface Props {
  boards: { id: string; name?: unknown; icon?: unknown }[];
  toolBtn: string;
  swatchColor: string;
  onSwatch: (c: string) => void;
  onAddImages: (files: File[]) => void;
  onAddNote: () => void;
  onAddText: () => void;
  onAddColor: (c: string) => void;
  onAdd: (kind: string, extra?: unknown) => void;
  onAddSvg: (f: File) => void;
}

/** Add-item menu: images, notes, text, swatches (legacy) + card/frame/shape/
 * svg/diagram/connector (phase 2). Every entry is a real button or file input
 * so it's usable on touch and by keyboard. */
export function AddMenu({ boards, toolBtn, swatchColor, onSwatch, onAddImages, onAddNote, onAddText, onAddColor, onAdd, onAddSvg }: Props) {
  const [json, setJson] = useState('');
  const [jsonErr, setJsonErr] = useState('');
  const svgInput = useRef<HTMLInputElement>(null);
  const imgInput = useRef<HTMLInputElement>(null);

  const tasks = useLiveQuery(() => db.tasks.filter((t) => !t.deleted).toArray(), [], []) as LocalRow[] | undefined;
  const pages = useLiveQuery(() => db.pages.filter((p) => !p.deleted).toArray(), [], []) as LocalRow[] | undefined;

  const pickItems = useMemo<PickItem[]>(() => {
    const out: PickItem[] = [];
    for (const t of tasks ?? []) {
      const b = boards.find((x) => x.id === taskBoardIdOf(t));
      out.push({ ref: { type: 'record', id: t.id } as PickItem['ref'], title: String(t.title ?? 'Untitled'), subtitle: String(b?.name ?? 'Records'), icon: String(b?.icon ?? '📋') });
    }
    for (const p of pages ?? []) {
      out.push({ ref: { type: 'page', id: p.id } as PickItem['ref'], title: String(p.title ?? 'Untitled'), subtitle: 'Page', icon: String(p.icon ?? '📄') });
    }
    return out;
  }, [tasks, pages, boards]);

  const row = 'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800';

  return (
    <Popover
      align="center"
      adaptive
      trigger={
        <button className={toolBtn} title="Add item" data-testid="mood-add">
          <Plus size={17} />
        </button>
      }
    >
      {(close) => (
        <div className="w-72 p-1.5">
          <p className="px-2 py-1 text-xs font-semibold text-neutral-400">Add to canvas</p>
          <button className={row} onClick={() => imgInput.current?.click()}>
            <ImageIcon size={15} /> Image(s)
          </button>
          <input
            ref={imgInput}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length) {
                close();
                onAddImages(files);
              }
            }}
          />
          <button className={row} onClick={() => { close(); onAddNote(); }}>
            <StickyNote size={15} /> Sticky note
          </button>
          <button className={row} onClick={() => { close(); onAddText(); }}>
            <Type size={15} /> Text
          </button>
          <div className={row}>
            <Paintbrush size={15} />
            <span>Color swatch</span>
            <input type="color" value={swatchColor} onChange={(e) => onSwatch(e.target.value)} className="ml-auto h-7 w-9 cursor-pointer rounded border-0 bg-transparent" aria-label="Swatch color" />
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                close();
                onAddColor(swatchColor);
              }}
            >
              Add
            </Button>
          </div>

          <p className="mt-1 border-t border-neutral-100 px-2 pb-1 pt-2 text-xs font-semibold text-neutral-400 dark:border-neutral-800">Structured</p>
          <div className="px-1 pb-1">
            <ItemPicker
              trigger={
                <button className={row}>
                  <CreditCard size={15} /> Card (record / page)
                </button>
              }
              items={pickItems}
              placeholder="Search records and pages…"
              onPick={(it) => {
                close();
                onAdd('card', it.ref as ItemRef);
              }}
            />
          </div>
          <button className={row} onClick={() => { close(); onAdd('frame'); }}>
            <FrameIcon size={15} /> Frame
          </button>
          <div className="px-2 py-1">
            <p className="mb-1 text-xs text-neutral-400">Shape</p>
            <div className="flex gap-1">
              {(
                [
                  ['rect', Square, 'Rectangle'],
                  ['ellipse', Circle, 'Ellipse'],
                  ['diamond', Diamond, 'Diamond'],
                  ['pill', Pill, 'Pill'],
                ] as const
              ).map(([shape, Icon, label]) => (
                <button
                  key={shape}
                  className="flex h-10 flex-1 items-center justify-center rounded-lg border border-neutral-200 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                  title={label}
                  aria-label={`Add ${label}`}
                  onClick={() => {
                    close();
                    onAdd('shape', shape);
                  }}
                >
                  <Icon size={15} />
                </button>
              ))}
            </div>
          </div>
          <button className={row} onClick={() => svgInput.current?.click()}>
            <FileText size={15} /> SVG file
          </button>
          <input
            ref={svgInput}
            type="file"
            accept=".svg,image/svg+xml"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) {
                close();
                onAddSvg(f);
              }
            }}
          />
          <div className="px-2 py-1">
            <p className="mb-1 flex items-center gap-1 text-xs text-neutral-400">
              <Workflow size={12} /> Diagram — paste spec JSON
            </p>
            <Textarea
              value={json}
              onChange={(e) => setJson(e.target.value)}
              placeholder='{"layout":"auto-lr","nodes":[{"id":"a","label":"A"}],"edges":[]}'
              className="h-20 font-mono text-xs"
              rows={4}
            />
            {jsonErr && <p className="mt-1 text-xs text-red-500">{jsonErr}</p>}
            <Button
              size="sm"
              variant="primary"
              className="mt-1.5"
              onClick={() => {
                try {
                  const spec = JSON.parse(json);
                  setJsonErr('');
                  close();
                  onAdd('diagram', spec);
                } catch {
                  setJsonErr('Invalid JSON');
                }
              }}
            >
              Add diagram
            </Button>
          </div>
          <button
            className={row}
            onClick={() => {
              close();
              onAdd('connector');
            }}
          >
            <Spline size={15} /> Connector (pick two items)
          </button>
        </div>
      )}
    </Popover>
  );
}
