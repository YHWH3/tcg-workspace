import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';
import { accessClientStore } from '../../core/accessClient';
import { authStore } from '../../core/auth';
import { db, type LocalRow } from '../../core/db';
import { captureMediaAccess, loadMoodboardImage, mediaAccessCurrent } from '../../core/files';
import { useStore } from '../../core/store';
import { AdaptiveDialog, Button } from '../../core/ui';
import { cardRef, type MoodItem } from '../../../shared/mooditems';
import { exportableMoodItems, MAX_MOODBOARD_EXPORT_ITEMS, moodboardSvg } from '../../../shared/moodboardExport';
import { PERMISSION_PROTOCOL } from '../../../shared/protocol';

const IMAGE_BUDGET = 6 * 1024 * 1024;

function canExportMoodboard(board: LocalRow): boolean {
  const { manifest, status } = accessClientStore.get();
  const user = authStore.get().user;
  if (!user || !['ready', 'offline'].includes(status)) return false;
  if (manifest?.protocol !== PERMISSION_PROTOCOL) return true;
  return manifest.workspaceRole !== 'guest'
    && manifest.spaces.some(space => space.id === board._spaceId && space.exportPolicy === 'members');
}

async function rasterData(blob: Blob): Promise<string | undefined> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/webp', .86);
  } finally {
    URL.revokeObjectURL(url);
  }
}

type ExportDocument = ReturnType<typeof moodboardSvg> & { url: string; access: ReturnType<typeof captureMediaAccess> };

export function MoodboardExport({ board, items, selection }: {
  board: LocalRow;
  items: MoodItem[];
  selection: ReadonlySet<string>;
}) {
  const access = useStore(accessClientStore);
  const auth = useStore(authStore);
  const [open, setOpen] = useState(false);
  const allowed = canExportMoodboard(board);
  useEffect(() => {
    if (!allowed) setOpen(false);
  }, [allowed]);
  if (!allowed || !items.some(item => item.type !== 'connector' && !item.deleted)) return null;
  return <>
    <Button size="icon" variant="ghost" aria-label="Export moodboard" title="Export moodboard" onClick={() => setOpen(true)}>
      <Download size={18} aria-hidden="true" />
    </Button>
    {open && <ExportDialog key={`${board.id}:${access.epoch}:${auth.user?.id}`} board={board} items={items} selection={selection} onClose={() => setOpen(false)} />}
  </>;
}

function ExportDialog({ board, items, selection, onClose }: {
  board: LocalRow;
  items: MoodItem[];
  selection: ReadonlySet<string>;
  onClose: () => void;
}) {
  const title = String(board.title || 'Moodboard');
  const selected = useMemo(() => exportableMoodItems(items, selection), [items, selection]);
  const selectable = selected.some(item => item.type !== 'connector');
  const [scope, setScope] = useState<'board' | 'selection'>(selectable ? 'selection' : 'board');
  const activeItems = useMemo(() => scope === 'selection' ? selected : exportableMoodItems(items), [items, scope, selected]);
  const [document, setDocument] = useState<ExportDocument>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [printReady, setPrintReady] = useState(false);
  const [rasterizing, setRasterizing] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const access = captureMediaAccess();
    let url: string | undefined;
    setDocument(undefined);
    setPrintReady(false);
    setError('');
    setDownloadError('');
    async function build() {
      if (activeItems.length > MAX_MOODBOARD_EXPORT_ITEMS) throw new Error('Select up to 600 items to export.');
      const images = new Map<string, string>();
      const cardTitles = new Map<string, string>();
      let used = 0;
      const sources = activeItems.filter(item => (item.type === 'image' || item.type === 'svg') && item.fileId);
      for (let start = 0; start < sources.length && used < IMAGE_BUDGET; start += 4) {
        if (controller.signal.aborted) return;
        const batch = await Promise.all(sources.slice(start, start + 4).map(async item => {
          const fileId = item.fileId!;
          try {
            const blob = await loadMoodboardImage(fileId, item.id, access, controller.signal);
            return { fileId, data: blob ? await rasterData(blob) : undefined };
          } catch {
            // An unreadable attachment has a labeled placeholder in the export.
            return { fileId, data: undefined };
          }
        }));
        for (const { fileId, data } of batch) {
          if (!data || images.has(fileId) || used + data.length > IMAGE_BUDGET) continue;
          used += data.length;
          images.set(fileId, data);
        }
      }
      const cards = activeItems.flatMap(item => {
        if (item.type !== 'card') return [];
        const ref = cardRef(item);
        return ref ? [{ id: item.id, ref }] : [];
      });
      const pages = await db.pages.bulkGet(cards.filter(card => card.ref.type === 'page').map(card => card.ref.id));
      const tasks = await db.tasks.bulkGet(cards.filter(card => card.ref.type === 'record').map(card => card.ref.id));
      const targets = new Map([...pages, ...tasks].flatMap(row => row ? [[row.id, row] as const] : []));
      for (const { id, ref } of cards) {
        const row = targets.get(ref.id);
        if (row && !row.deleted && !row.archived && row._spaceId === board._spaceId && typeof row.title === 'string') cardTitles.set(id, row.title);
      }
      if (controller.signal.aborted || !canExportMoodboard(board)
        || !mediaAccessCurrent(access)) return;
      const result = moodboardSvg({ title, items: activeItems, images, cardTitles });
      url = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' }));
      setDocument({ ...result, url, access });
    }
    void build().catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'The export could not be prepared.');
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [activeItems, board, retry, title]);

  const filename = (title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'moodboard')
    + (scope === 'selection' ? '-selection' : '');

  const downloadPng = async () => {
    if (!document || !mediaAccessCurrent(document.access) || !canExportMoodboard(board)) return;
    setRasterizing(true);
    setDownloadError('');
    const epoch = accessClientStore.get().epoch;
    try {
      const blob = await rasterizePng(document);
      if (epoch !== accessClientStore.get().epoch || !mediaAccessCurrent(document.access) || !canExportMoodboard(board)) return;
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = filename + '.png';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setDownloadError('The image could not be converted to PNG. Try again or download the SVG.');
    } finally {
      setRasterizing(false);
    }
  };

  return <AdaptiveDialog title="Export moodboard" onClose={onClose}>
    <div className="space-y-3">
      <fieldset className="flex flex-wrap gap-3">
        <legend className="text-sm font-medium">Items to export</legend>
        <label className="inline-flex min-h-11 items-center gap-2"><input type="radio" name="moodboard-export-scope" checked={scope === 'board'} onChange={() => setScope('board')} /> Whole board</label>
        <label className="inline-flex min-h-11 items-center gap-2"><input type="radio" name="moodboard-export-scope" checked={scope === 'selection'} disabled={!selectable} onChange={() => setScope('selection')} /> Selection</label>
      </fieldset>
      {!document && !error && <p role="status">Preparing the preview…</p>}
      {error && <div role="alert"><p>{error}</p><Button size="sm" variant="outline" onClick={() => setRetry(value => value + 1)}>Try again</Button></div>}
      {document && <>
        <img src={document.url} alt="Moodboard export preview" className="mx-auto max-h-[36vh] max-w-full rounded border border-neutral-200 bg-white object-contain dark:border-neutral-700" onLoad={() => setPrintReady(true)} />
        {document.missing > 0 && <p role="status" className="text-sm">{document.missing} {document.missing === 1 ? 'image is' : 'images are'} shown as placeholders. Some images may be unavailable or exceed the export limit.</p>}
        {downloadError && <p role="alert">{downloadError}</p>}
        <div className="flex flex-wrap gap-2">
          <Button className="min-h-11" onClick={() => {
            if (!mediaAccessCurrent(document.access) || !canExportMoodboard(board)) return;
            const link = window.document.createElement('a');
            link.href = document.url;
            link.download = filename + '.svg';
            link.click();
          }}>Download SVG</Button>
          <Button className="min-h-11" variant="outline" disabled={rasterizing || !printReady} onClick={() => void downloadPng()}>{rasterizing ? 'Creating PNG…' : 'Download PNG'}</Button>
          <Button className="min-h-11" variant="outline" disabled={!printReady} onClick={() => { if (mediaAccessCurrent(document.access) && canExportMoodboard(board)) window.print(); }}>Print or save PDF</Button>
        </div>
        {createPortal(
          <section className="moodboard-print" aria-hidden="true"><h1>{title}</h1><img src={document.url} alt="" /></section>,
          window.document.body,
        )}
      </>}
    </div>
  </AdaptiveDialog>;
}

async function rasterizePng(source: ExportDocument): Promise<Blob> {
  const image = new Image();
  image.src = source.url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable.');
  context.drawImage(image, 0, 0);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG encoding is unavailable.');
  return blob;
}
