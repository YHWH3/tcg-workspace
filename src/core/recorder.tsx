import { useEffect, useRef, useState } from 'react';
import { Mic, Square, Trash2 } from 'lucide-react';
import { cn } from './utils';

export const MAX_RECORD_SECONDS = 300; // 5 minutes
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'];

export function pickAudioMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

export interface RecorderHandle {
  state: 'idle' | 'recording';
  seconds: number;
  level: number;
  start: () => Promise<void>;
  stop: () => void;
  discard: () => void;
  supported: boolean;
}

/** MediaRecorder wrapper with a live level meter and a 5-minute cap. */
export function useRecorder(onDone: (blob: Blob) => void): RecorderHandle {
  const [state, setState] = useState<'idle' | 'recording'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const raf = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const discardNext = useRef(false);

  const cleanup = () => {
    cancelAnimationFrame(raf.current);
    clearInterval(timer.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    rec.current = null;
    setLevel(0);
    setSeconds(0);
  };

  useEffect(() => cleanup, []);

  const start = async () => {
    stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickAudioMime();
    const r = new MediaRecorder(stream.current, mime ? { mimeType: mime } : undefined);
    const parts: Blob[] = [];
    r.ondataavailable = (e) => {
      if (e.data.size) parts.push(e.data);
    };
    r.onstop = () => {
      const blob = new Blob(parts, { type: r.mimeType || 'audio/webm' });
      const discard = discardNext.current;
      discardNext.current = false;
      cleanup();
      setState('idle');
      if (!discard && blob.size > 0) onDone(blob);
    };
    rec.current = r;
    r.start(250);

    // Level meter
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream.current).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(buf);
        setLevel(Math.min(1, buf.reduce((a, b) => a + b, 0) / buf.length / 140));
        raf.current = requestAnimationFrame(tick);
      };
      tick();
      // Close the context when tracks end.
      stream.current.getTracks()[0]?.addEventListener('ended', () => void ctx.close());
      r.onstop = ((prev) => (e: Event) => {
        void ctx.close();
        prev?.(e);
      })(r.onstop as ((e: Event) => void) | null) as (e: Event) => void;
    } catch {
      /* meter optional */
    }

    const t0 = Date.now();
    timer.current = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      setSeconds(s);
      if (s >= MAX_RECORD_SECONDS) rec.current?.stop();
    }, 250);
    setState('recording');
  };

  return {
    state,
    seconds,
    level,
    supported: typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
    start,
    stop: () => rec.current?.stop(),
    discard: () => {
      discardNext.current = true;
      rec.current?.stop();
    },
  };
}

/** Compact record/stop button with elapsed timer and live level meter. */
export function RecordButton({ onDone, className }: { onDone: (blob: Blob) => void; className?: string }) {
  const r = useRecorder(onDone);
  if (!r.supported) return null;
  if (r.state === 'recording') {
    return (
      <span className={cn('flex items-center gap-2 rounded-full bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 dark:bg-red-950/50 dark:text-red-400', className)}>
        <span className="flex h-3 items-end gap-px">
          {[0.4, 0.7, 1, 0.7, 0.4].map((f, i) => (
            <span key={i} className="w-0.5 rounded-sm bg-red-500 transition-all" style={{ height: `${Math.max(15, r.level * 100 * f)}%` }} />
          ))}
        </span>
        {Math.floor(r.seconds / 60)}:{String(r.seconds % 60).padStart(2, '0')}
        <button onClick={r.stop} className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white" aria-label="Stop recording">
          <Square size={9} />
        </button>
        <button onClick={r.discard} className="text-red-400 hover:text-red-600" aria-label="Discard recording">
          <Trash2 size={12} />
        </button>
      </span>
    );
  }
  return (
    <button onClick={() => void r.start()} className={cn('flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800', className)}>
      <Mic size={13} /> Record voice memo
    </button>
  );
}
