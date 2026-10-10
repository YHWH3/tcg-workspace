/**
 * Attachments section for record detail: upload files, record audio, and
 * 'Add Drive link' (creates a kind:'link' file row — bytes stay in Drive).
 * Renders link rows as cards; desktop Drive links offer an in-place preview.
 */
import { useRef, useState } from 'react';
import { ExternalLink, Link2, Paperclip, X } from 'lucide-react';
import { addFile, addLink, deleteFile, useAttachments, useFileUrl, type FileRow } from '../files';
import { DRIVE_NOTE_KEY, DRIVE_ACCESS_NOTE } from '../drive';
import { FilePreview, Lightbox } from '../fileui';
import { Button, Dialog } from '../ui';
import { driveEmbed } from '../drive';

export function RecordAttachments({ parentId }: { parentId: string }) {
  const files = useAttachments(parentId);
  const fileInput = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    for (const f of Array.from(list)) await addFile(f, { parentType: 'task', parentId });
  };

  const images = files.filter((f) => f.kind === 'image');
  const rest = files.filter((f) => f.kind !== 'image');

  return (
    <div>
      {images.length > 0 && (
        <div className="mb-2 grid grid-cols-3 gap-1.5">
          {images.map((f) => (
            <button key={f.id} className="aspect-square overflow-hidden rounded-lg bg-neutral-100 dark:bg-neutral-800" onClick={() => setLightbox(f.id)} aria-label={`View ${f.name ?? 'image'}`}>
              <FileThumb file={f} />
            </button>
          ))}
        </div>
      )}
      <div className="space-y-1.5">
        {rest.map((f) => ((f.kind as string) === 'link' ? <LinkCard key={f.id} file={f} /> : <FilePreview key={f.id} file={f} />))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => void addFiles(e.target.files).then(() => { if (fileInput.current) fileInput.current.value = ''; })} />
        <button onClick={() => fileInput.current?.click()} className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800" style={{ minHeight: 36 }}>
          <Paperclip size={13} /> Add file
        </button>
        <button onClick={() => setLinkOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800" style={{ minHeight: 36 }}>
          <Link2 size={13} /> Add Drive link
        </button>
      </div>
      {linkOpen && <AddLinkDialog parentId={parentId} onClose={() => setLinkOpen(false)} />}
      {lightbox && <Lightbox files={images} startId={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function FileThumb({ file }: { file: FileRow }) {
  const { url } = useFileUrl(file.id, file.thumbId ?? undefined);
  return url ? <img src={url} alt={file.name ?? ''} className="h-full w-full object-cover" loading="lazy" /> : <span className="flex h-full items-center justify-center text-xs text-neutral-400">…</span>;
}

/** A kind:'link' file row: Drive links get an 'Open in Drive' card (+ optional inline preview toggle); plain links are external cards. */
export function LinkCard({ file }: { file: FileRow }) {
  const url = String((file as Record<string, unknown>).url ?? '');
  const embed = driveEmbed(url);
  const [preview, setPreview] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200/70 dark:border-neutral-800">
      <div className="flex items-center gap-2 px-3 py-2">
        <Link2 size={13} className="shrink-0 text-neutral-400" />
        <a href={url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm text-blue-600 hover:underline dark:text-blue-400">
          {file.name ?? embed.title}
        </a>
        {embed.provider === 'gdrive' && (
          <button className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => setPreview((p) => !p)} aria-expanded={preview}>
            {preview ? 'Hide preview' : 'Preview'}
          </button>
        )}
        <a href={url} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800">
          {embed.provider === 'gdrive' ? 'Open in Drive' : 'Open'} <ExternalLink size={10} />
        </a>
        <button className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 hover:text-red-500" onClick={() => void deleteFile(file.id)} aria-label="Remove link">
          <X size={11} />
        </button>
      </div>
      {preview && embed.embedUrl && (
        <iframe
          src={embed.embedUrl}
          title={embed.title}
          sandbox="allow-scripts allow-same-origin allow-popups"
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-72 w-full border-t border-neutral-200/70 dark:border-neutral-800"
        />
      )}
    </div>
  );
}

export function AddLinkDialog({ parentId, onClose }: { parentId: string; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const noteSeen = typeof localStorage !== 'undefined' && localStorage.getItem(DRIVE_NOTE_KEY) === '1';
  return (
    <Dialog title="Add link" onClose={onClose} guard={() => !url.trim() && !name.trim()}>
      <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
        Paste a Google Drive or Docs link — the file stays in Drive, we keep a preview. Any other URL is added as a link card.
      </p>
      <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://drive.google.com/file/d/…" type="url" className="w-full rounded-lg border border-neutral-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700" aria-label="URL" />
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className="mt-2 w-full rounded-lg border border-neutral-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700" aria-label="Name" />
      {!noteSeen && <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">{DRIVE_ACCESS_NOTE}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          disabled={!url.trim()}
          onClick={() => {
            void (async () => {
              try {
                localStorage.setItem(DRIVE_NOTE_KEY, '1');
              } catch { /* noop */ }
              await addLink(url.trim(), { parentType: 'task', parentId, name: name.trim() || undefined });
              onClose();
            })();
          }}
        >
          Add
        </Button>
      </div>
    </Dialog>
  );
}
