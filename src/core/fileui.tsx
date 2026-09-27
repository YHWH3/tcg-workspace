import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, FileText, Pause, Play, Trash2, X } from 'lucide-react';
import { db } from './db';
import { useFileUrl, type FileRow } from './files';
import { IconButton } from './ui';
import { cn } from './utils';
import { useLiveQuery } from 'dexie-react-hooks';

export function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Image thumbnail with graceful states (pending upload, not yet synced). */
export function FileImage({ fileId, thumbId, className, alt }: { fileId: string; thumbId?: string | null; className?: string; alt?: string }) {
  const file = useLiveQuery(() => db.files.get(fileId), [fileId]) as FileRow | undefined;
  const prefer = thumbId ?? (file?.thumbId as string | undefined);
  const { url, missing, failed } = useFileUrl(fileId, prefer);
  if (url) return <img src={url} alt={alt ?? ''} loading="lazy" draggable={false} className={cn('object-cover', className)} />;
  return (
    <div className={cn('flex items-center justify-center bg-neutral-100 text-[11px] text-neutral-400 dark:bg-neutral-800/70 dark:text-neutral-500', className)}>
      {failed ? 'Upload failed' : missing ? 'Waiting for upload…' : <span className="anim-pulse">Loading…</span>}
    </div>
  );
}

/** Inline audio chip: tap to play/pause with a tiny progress bar. */
export function AudioChip({ file, onOpen }: { file: FileRow; onOpen?: () => void }) {
  const { url } = useFileUrl(file.id);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => () => audioRef.current?.pause(), []);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!audioRef.current) return;
    if (playing) audioRef.current.pause();
    else void audioRef.current.play();
  };

  return (
    <span className="relative inline-flex items-center gap-1 overflow-hidden rounded-full bg-neutral-100 py-0.5 pl-1.5 pr-2 text-[11px] font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300" onClick={(e) => e.stopPropagation()}>
      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setProgress(0);
          }}
          onTimeUpdate={(e) => {
            const a = e.currentTarget;
            if (a.duration) setProgress(a.currentTime / a.duration);
          }}
        />
      )}
      <button onClick={toggle} aria-label={playing ? 'Pause voice memo' : 'Play voice memo'} className="flex h-4.5 w-4.5 items-center justify-center rounded-full bg-neutral-300/80 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200" disabled={!url}>
        {playing ? <Pause size={9} /> : <Play size={9} className="ml-px" />}
      </button>
      <span onClick={onOpen} className="cursor-pointer">
        {file.transcriptState === 'pending' ? <span className="anim-pulse text-neutral-400">Transcribing…</span> : file.duration ? fmtDur(Number(file.duration)) : 'Audio'}
      </span>
      <span className="absolute bottom-0 left-0 h-0.5 bg-blue-500/60 transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
    </span>
  );
}

/** Full audio player with optional collapsible transcript. */
export function AudioPlayer({ file, onDelete }: { file: FileRow; onDelete?: () => void }) {
  const { url } = useFileUrl(file.id);
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-neutral-200/80 p-2.5 dark:border-neutral-800">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">🎙️</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{String(file.name ?? 'Voice memo')}</p>
          <p className="text-[11px] text-neutral-400">
            {file.duration ? fmtDur(Number(file.duration)) : 'audio'}
            {file.transcriptState === 'pending' && <span className="anim-pulse"> · Transcribing…</span>}
            {file.transcriptState === 'failed' && ' · Transcription failed'}
          </p>
        </div>
        {onDelete && (
          <IconButton className="h-6 w-6" aria-label="Delete audio" onClick={onDelete}>
            <Trash2 size={12} />
          </IconButton>
        )}
      </div>
      {url ? <audio src={url} controls className="mt-2 h-9 w-full" /> : <p className="mt-2 text-[11px] text-neutral-400">Waiting for upload…</p>}
      {file.transcript && (
        <div className="mt-2">
          <button className="flex items-center gap-1 text-[11px] font-medium text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200" onClick={() => setOpen((o) => !o)}>
            <ChevronDown size={12} className={cn('transition-transform', open && 'rotate-180')} /> Transcript
          </button>
          {open && <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-neutral-600 dark:text-neutral-300">{String(file.transcript)}</p>}
        </div>
      )}
    </div>
  );
}

/** PDF/file preview: inline iframe for PDFs, chip + open/download otherwise. */
export function FilePreview({ file, className }: { file: FileRow; className?: string }) {
  const { url } = useFileUrl(file.id);
  if (file.kind === 'pdf') {
    return (
      <div className={cn('overflow-hidden rounded-xl border border-neutral-200/80 dark:border-neutral-800', className)}>
        <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2 dark:border-neutral-800">
          <FileText size={14} className="shrink-0 text-red-500" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{String(file.name ?? 'document.pdf')}</span>
          {url && (
            <>
              <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:underline dark:text-blue-400">
                <ExternalLink size={11} /> Open
              </a>
              <a href={url} download={String(file.name ?? 'document.pdf')} className="flex items-center gap-1 text-[11px] font-medium text-neutral-500 hover:underline">
                <Download size={11} /> Download
              </a>
            </>
          )}
        </div>
        {url ? (
          <iframe src={url} title={String(file.name ?? 'PDF')} className="h-[70vh] w-full bg-neutral-100 dark:bg-neutral-900" />
        ) : (
          <div className="flex h-20 items-center justify-center text-xs text-neutral-400">Waiting for upload…</div>
        )}
      </div>
    );
  }
  return (
    <div className={cn('flex items-center gap-2 rounded-xl border border-neutral-200/80 p-2.5 dark:border-neutral-800', className)}>
      <FileText size={16} className="shrink-0 text-neutral-400" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{String(file.name ?? 'file')}</span>
      {url && (
        <a href={url} download={String(file.name ?? 'file')} className="text-[11px] font-medium text-blue-600 hover:underline dark:text-blue-400">
          Download
        </a>
      )}
    </div>
  );
}

/** Full-screen image lightbox with swipe/arrows. */
export function Lightbox({ files, startId, onClose }: { files: FileRow[]; startId: string; onClose: () => void }) {
  const [idx, setIdx] = useState(Math.max(0, files.findIndex((f) => f.id === startId)));
  const file = files[idx];
  const touchX = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setIdx((i) => Math.min(files.length - 1, i + 1));
      if (e.key === 'ArrowLeft') setIdx((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [files.length, onClose]);

  if (!file) return null;
  return (
    <div
      className="anim-fade fixed inset-0 z-[60] flex flex-col bg-black/90"
      onClick={onClose}
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        const dx = e.changedTouches[0].clientX - touchX.current;
        if (dx > 50) setIdx((i) => Math.max(0, i - 1));
        if (dx < -50) setIdx((i) => Math.min(files.length - 1, i + 1));
      }}
    >
      <div className="flex items-center justify-between p-3">
        <span className="text-xs text-white/70">
          {idx + 1} / {files.length} · {String(file.name ?? '')}
        </span>
        <IconButton onClick={onClose} aria-label="Close" className="text-white hover:bg-white/10">
          <X size={18} />
        </IconButton>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center" onClick={(e) => e.stopPropagation()}>
        {idx > 0 && (
          <button className="absolute left-2 z-10 rounded-full bg-black/40 p-2 text-white hover:bg-black/60" onClick={() => setIdx(idx - 1)} aria-label="Previous">
            <ChevronLeft size={20} />
          </button>
        )}
        <LightboxImage key={file.id} fileId={file.id} />
        {idx < files.length - 1 && (
          <button className="absolute right-2 z-10 rounded-full bg-black/40 p-2 text-white hover:bg-black/60" onClick={() => setIdx(idx + 1)} aria-label="Next">
            <ChevronRight size={20} />
          </button>
        )}
      </div>
    </div>
  );
}

function LightboxImage({ fileId }: { fileId: string }) {
  const { url } = useFileUrl(fileId);
  if (!url) return <span className="text-xs text-white/60">Loading…</span>;
  return <img src={url} alt="" className="max-h-full max-w-full object-contain" />;
}
