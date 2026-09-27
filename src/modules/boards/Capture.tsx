import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Camera, Check, ImagePlus, Mic, RotateCcw, Square, Trash2, X } from 'lucide-react';
import { logActivity } from '../../core/activity';
import { addFile } from '../../core/files';
import { useRecorder } from '../../core/recorder';
import { takeShared } from '../../core/sharedInbox';
import { useIsMobile } from '../../core/shell';
import { IconButton, Select } from '../../core/ui';
import { cn } from '../../core/utils';
import { createTask, INBOX_BOARD_ID, setTaskField, useBoards } from './api';


const LAST_BOARD_KEY = 'ws_capture_board';

function stamp(): string {
  return new Date().toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** /capture — one-thumb quick capture: photo(s), voice memo, caption, board. */
export function CapturePage() {
  const mobile = useIsMobile();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const boards = useBoards();
  const [photos, setPhotos] = useState<Blob[]>([]);
  const [caption, setCaption] = useState('');
  const [boardId, setBoardId] = useState(() => localStorage.getItem(LAST_BOARD_KEY) ?? INBOX_BOARD_ID);
  const [saved, setSaved] = useState<null | 'saved' | 'offline'>(null);
  const [busy, setBusy] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);

  const close = () => navigate(-1);

  // Files received via the PWA share target.
  useEffect(() => {
    if (params.get('shared') === '1') {
      void takeShared().then((items) => {
        setPhotos((p) => [...p, ...items.map((i) => i.file)]);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pre-open the camera / recorder when launched from a PWA shortcut.
  useEffect(() => {
    const mode = params.get('mode');
    if (mode === 'photo') setTimeout(() => photoInput.current?.click(), 350);
    if (mode === 'voice') void voice.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onVoiceDone = (blob: Blob) => setVoiceBlob(blob);
  const [voiceBlob, setVoiceBlob] = useState<Blob | null>(null);
  const voice = useRecorder(onVoiceDone);

  const canSave = !busy && (photos.length > 0 || voiceBlob || caption.trim());

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      const board = boards.find((b) => b.id === boardId) ?? boards.find((b) => b.id === INBOX_BOARD_ID) ?? boards[0];
      const lines = caption.trim().split('\n');
      const firstLine = lines[0]?.trim() ?? '';
      const kind = photos.length > 0 ? 'Photo' : voiceBlob ? 'Voice memo' : 'Note';
      const title = firstLine || `${kind} · ${stamp()}`;
      const description = firstLine ? lines.slice(1).join('\n').trim() : '';
      const taskId = await createTask(board?.id ?? INBOX_BOARD_ID);
      const patch: Record<string, unknown> = { title };
      if (description) patch.description = description;

      let coverId: string | undefined;
      for (const [i, p] of photos.entries()) {
        const fid = await addFile(new File([p], `photo-${Date.now()}-${i}.jpg`, { type: p.type || 'image/jpeg' }), { parentType: 'task', parentId: taskId });
        if (i === 0) coverId = fid;
      }
      if (voiceBlob) {
        await addFile(new File([voiceBlob], `voice-${Date.now()}.${voiceBlob.type.includes('mp4') ? 'm4a' : 'webm'}`, { type: voiceBlob.type }), {
          parentType: 'task',
          parentId: taskId,
          name: `Voice memo ${stamp()}`,
          transcriptState: 'pending',
        });
      }
      if (coverId) patch.coverFileId = coverId;
      if (Object.keys(patch).length) await setTaskField(taskId, patch);
      logActivity('captured', 'task', taskId, title);

      localStorage.setItem(LAST_BOARD_KEY, board?.id ?? boardId);
      setSaved(navigator.onLine ? 'saved' : 'offline');
      setTimeout(() => navigate(`/boards/${board?.id ?? INBOX_BOARD_ID}`), 900);
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
        <span className="text-sm font-semibold">Quick capture</span>
        <IconButton onClick={close} aria-label="Close capture">
          <X size={17} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {/* photo strip */}
        {photos.length > 0 && (
          <div className="mb-3 flex gap-2 overflow-x-auto">
            {photos.map((p, i) => (
              <div key={i} className="relative h-24 w-24 shrink-0 overflow-hidden rounded-xl">
                <img src={URL.createObjectURL(p)} alt="" className="h-full w-full object-cover" />
                <button
                  className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white"
                  aria-label="Remove photo"
                  onClick={() => setPhotos((ps) => ps.filter((_, j) => j !== i))}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <input ref={photoInput} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) setPhotos((p) => [...p, f]); e.target.value = ''; }} />
          <input ref={galleryInput} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { setPhotos((p) => [...p, ...Array.from(e.target.files ?? [])]); e.target.value = ''; }} />
          <button onClick={() => photoInput.current?.click()} className="flex flex-col items-center justify-center gap-1.5 rounded-2xl bg-neutral-900 py-5 text-sm font-medium text-white active:bg-neutral-700 dark:bg-white dark:text-neutral-900">
            <Camera size={22} /> Take photo
          </button>
          <button onClick={() => galleryInput.current?.click()} className="flex flex-col items-center justify-center gap-1.5 rounded-2xl border border-neutral-200 py-5 text-sm font-medium text-neutral-600 active:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300">
            <ImagePlus size={22} /> Choose photos
          </button>
        </div>

        {/* voice */}
        <div className="mt-3">
          {voice.state === 'recording' ? (
            <div className="flex items-center gap-3 rounded-2xl bg-red-50 px-4 py-3.5 dark:bg-red-950/40">
              <span className="flex h-5 items-end gap-0.5">
                {[0.5, 0.9, 0.6, 1, 0.7, 0.4].map((f, i) => (
                  <span key={i} className="w-1 rounded-sm bg-red-500 transition-all" style={{ height: `${Math.max(12, voice.level * 100 * f)}%` }} />
                ))}
              </span>
              <span className="text-sm font-medium tabular-nums text-red-600 dark:text-red-400">
                {Math.floor(voice.seconds / 60)}:{String(voice.seconds % 60).padStart(2, '0')}
              </span>
              <span className="flex-1" />
              <IconButton onClick={voice.discard} aria-label="Discard recording" className="text-red-500">
                <Trash2 size={15} />
              </IconButton>
              <button onClick={voice.stop} className="flex h-9 w-9 items-center justify-center rounded-full bg-red-500 text-white" aria-label="Stop recording">
                <Square size={13} />
              </button>
            </div>
          ) : voiceBlob ? (
            <div className="flex items-center gap-2 rounded-2xl border border-neutral-200 px-4 py-3 dark:border-neutral-700">
              <Mic size={15} className="text-neutral-400" />
              <span className="flex-1 text-sm">Voice memo · {fmtBytes(voiceBlob.size)}</span>
              <audio src={URL.createObjectURL(voiceBlob)} controls className="h-8 w-40" />
              <IconButton onClick={() => setVoiceBlob(null)} aria-label="Re-record" title="Re-record">
                <RotateCcw size={14} />
              </IconButton>
            </div>
          ) : (
            <button
              onClick={() => void voice.start()}
              disabled={!voice.supported}
              className="flex w-full flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-neutral-300 py-5 text-sm font-medium text-neutral-500 active:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400"
            >
              <Mic size={22} /> Record voice memo
            </button>
          )}
        </div>

        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          rows={3}
          placeholder="Add a caption…"
          className="mt-3 w-full resize-none rounded-2xl border border-neutral-200 bg-transparent px-4 py-3 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-300 dark:border-neutral-700"
        />

        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs text-neutral-400">Board</span>
          <Select
            value={boardId}
            onChange={(e) => setBoardId(e.target.value)}
            className="w-auto py-1.5 text-sm"
            aria-label="Target board"
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {String(b.icon ?? '')} {String(b.name ?? 'Board')}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="pb-safe border-t border-neutral-100 p-4 dark:border-neutral-800">
        {saved ? (
          <div className={cn('flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-medium', saved === 'offline' ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400' : 'bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400')}>
            <Check size={15} /> {saved === 'offline' ? 'Saved offline — will upload when online' : 'Saved'}
          </div>
        ) : (
          <button onClick={() => void save()} disabled={!canSave} className="w-full rounded-xl bg-neutral-900 py-3 text-sm font-semibold text-white transition-colors enabled:hover:bg-neutral-700 disabled:opacity-40 dark:bg-white dark:text-neutral-900">
            Save to {String(boards.find((b) => b.id === boardId)?.name ?? 'board')}
          </button>
        )}
      </div>
    </div>
  );

  if (mobile) {
    return <div className="anim-slide-bottom fixed inset-0 z-[55] flex flex-col bg-white dark:bg-neutral-950">{body}</div>;
  }
  return (
    <div className="anim-fade fixed inset-0 z-[55] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="anim-slide-up flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-950">{body}</div>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
