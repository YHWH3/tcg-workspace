import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Camera, Check, CheckSquare, Eye, FileText, ImagePlus, MapPin, Mic, Paperclip, Receipt, RotateCcw, Square, StickyNote, Trash2, Type, X } from 'lucide-react';
import { logActivity } from '../../core/activity';
import { authStore } from '../../core/auth';
import { db, getMeta, setMeta } from '../../core/db';
import { draftKey } from '../../core/drafts';
import { addFile, addLink, putBlobRow } from '../../core/files';
import { link } from '../../core/links';
import { useRecorder } from '../../core/recorder';
import { takeShared } from '../../core/sharedInbox';
import { useIsMobile } from '../../core/mobile';
import { Button, Field, IconButton, Input, Select, Textarea } from '../../core/ui';
import { cn, todayISO } from '../../core/utils';
import { ContextPicker } from './ContextPicker';
import { createRecord } from '../../core/records';
import { setTaskField, useBoards, type TaskRow } from './api';
import {
  actionsForContext,
  bodyForKind,
  CAPTURE_KIND_LABELS,
  captureBoardKey,
  capturePlanIds,
  cleanDraft,
  draftHasContent,
  isRoutedKind,
  loadFieldContext,
  propsForForm,
  resolveDestination,
  saveFieldContext,
  titleFor,
  type CaptureDraft,
  type CaptureForm,
  type CaptureKind,
  type FieldContext,
} from './fieldMode';
import type { LucideIcon } from 'lucide-react';

const meId = () => authStore.get().user?.id;

const KIND_ICONS: Record<CaptureKind, LucideIcon> = {
  photo: Camera,
  voice: Mic,
  text: Type,
  note: StickyNote,
  task: CheckSquare,
  observation: Eye,
  expense: Receipt,
};

function stamp(): string {
  return new Date().toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/* ---------- durable capture draft ----------
 * Envelope lives in `meta` under draft:<user>:capture:pending — same account
 * scoping + shape as core/drafts.ts, but 'capture' is intentionally NOT a
 * synced collection so the row check in saveDraft() doesn't apply here. */
/** Blob ids the draft stages its media under — references, never bytes,
 * ride in the meta envelope. */
interface DraftMediaRefs {
  photos?: string[];
  docs?: { name: string; type: string; blobId: string }[];
  voice?: string | null;
}

interface CaptureDraftEnvelope {
  v: 1;
  userId: string;
  collection: 'capture';
  id: 'pending';
  values: { form: CaptureDraft; media?: DraftMediaRefs };
  baseTs: Record<string, number>;
  updatedAt: number;
  source: 'edit';
}

/** P3-R2: media bytes persist in the existing account-scoped `blobs`
 * pipeline (state 'cached' so uploadPendingBlobs never sweeps them) — a
 * photo/voice/document survives reload, offline and account restore. Only
 * blob-id references live in the meta envelope, so draft saves never carry
 * Blob payloads and can't stall the save path on engines with slow IDB
 * Blob writes (WebKit). */
export interface CaptureMedia {
  photos?: Blob[];
  docs?: { name: string; type: string; data: Blob }[];
  voice?: Blob | null;
}

const DRAFT_COLLECTION = 'capture';
const DRAFT_ID = 'pending';
const draftBlobPrefix = (uid: string) => `capdraft_${uid}_`;

async function saveCaptureDraft(form: CaptureDraft): Promise<void> {
  const userId = authStore.get().user?.id;
  if (!userId) return;
  const key = draftKey(userId, DRAFT_COLLECTION, DRAFT_ID);
  const prev = await getMeta<CaptureDraftEnvelope>(key);
  const media = prev?.values?.media;
  const hasMedia = !!(media?.photos?.length || media?.docs?.length || media?.voice);
  if (!draftHasContent(form) && !hasMedia) {
    await db.meta.delete(key);
    return;
  }
  const env: CaptureDraftEnvelope = { v: 1, userId, collection: DRAFT_COLLECTION, id: DRAFT_ID, values: { form, media }, baseTs: {}, updatedAt: Date.now(), source: 'edit' };
  await setMeta(key, env);
}

/** Best-effort byte durability: staged under capdraft_<uid>_* in `blobs`.
 * A blob the engine can't store simply leaves no ref — the restore path
 * then shows the honest re-attach note instead of a broken draft. */
async function stageDraftMedia(media: CaptureMedia): Promise<void> {
  const userId = authStore.get().user?.id;
  if (!userId) return;
  const key = draftKey(userId, DRAFT_COLLECTION, DRAFT_ID);
  const prefix = draftBlobPrefix(userId);
  await db.blobs.where('id').startsWith(prefix).delete();
  const refs: DraftMediaRefs = {};
  const stage = (id: string, blob: Blob): Promise<boolean> => putBlobRow({ id, blob, state: 'cached', uploadedChunks: 0, mime: blob.type });
  for (const [i, p] of (media.photos ?? []).entries()) {
    const id = `${prefix}photo_${i}`;
    if (await stage(id, p)) (refs.photos ??= []).push(id);
  }
  for (const [i, d] of (media.docs ?? []).entries()) {
    const id = `${prefix}doc_${i}`;
    if (await stage(id, d.data)) (refs.docs ??= []).push({ name: d.name, type: d.type, blobId: id });
  }
  if (media.voice) {
    const id = `${prefix}voice`;
    if (await stage(id, media.voice)) refs.voice = id;
  }
  const env = await getMeta<CaptureDraftEnvelope>(key);
  if (env) {
    env.values.media = refs;
    await setMeta(key, env);
  }
}

/** The debounced draft write: form envelope first (cheap meta write), then
 * media bytes staged best-effort into `blobs`. Never called from save() —
 * a slow engine can only lag byte-staging, not the save path itself. */
async function persistDraft(form: CaptureDraft, media: CaptureMedia): Promise<void> {
  await saveCaptureDraft(form);
  await stageDraftMedia(media).catch(() => {});
}

async function loadCaptureDraft(): Promise<{ form: CaptureDraft; media: CaptureMedia } | undefined> {
  const userId = authStore.get().user?.id;
  if (!userId) return undefined;
  const env = await getMeta<CaptureDraftEnvelope>(draftKey(userId, DRAFT_COLLECTION, DRAFT_ID));
  if (env?.userId !== userId) return undefined;
  const form = cleanDraft(env.values?.form);
  if (!form) return undefined;
  const refs = env.values?.media ?? {};
  const media: CaptureMedia = {};
  if (refs.photos?.length) {
    const rows = await db.blobs.bulkGet(refs.photos);
    media.photos = rows.map((r) => r?.blob).filter((b): b is Blob => !!b);
  }
  if (refs.docs?.length) {
    const rows = await db.blobs.bulkGet(refs.docs.map((d) => d.blobId));
    media.docs = refs.docs.map((d, i) => ({ name: d.name, type: d.type, data: rows[i]?.blob })).filter((d): d is { name: string; type: string; data: Blob } => !!d.data);
  }
  if (refs.voice) media.voice = (await db.blobs.get(refs.voice))?.blob ?? null;
  return { form, media };
}

async function clearCaptureDraft(): Promise<void> {
  const userId = authStore.get().user?.id;
  if (!userId) return;
  await db.meta.delete(draftKey(userId, DRAFT_COLLECTION, DRAFT_ID));
  await db.blobs.where('id').startsWith(draftBlobPrefix(userId)).delete().catch(() => {});
}

/** /capture — field-mode quick capture: context chip, kind chips, routed forms. */
export function CapturePage() {
  const mobile = useIsMobile();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const boards = useBoards();

  const [kind, setKind] = useState<CaptureKind>('text');
  const [ctx, setCtxState] = useState<FieldContext | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [destId, setDestId] = useState('');
  const [destTouched, setDestTouched] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [photos, setPhotos] = useState<Blob[]>([]);
  const [docs, setDocs] = useState<File[]>([]);
  const [voiceBlob, setVoiceBlob] = useState<Blob | null>(null);
  const [micDenied, setMicDenied] = useState(false);
  const [caption, setCaption] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [date, setDate] = useState(todayISO());
  const [measurement, setMeasurement] = useState('');
  const [unit, setUnit] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [due, setDue] = useState('');
  const [driveUrl, setDriveUrl] = useState('');

  const [saved, setSaved] = useState<null | 'saved' | 'offline'>(null);
  const [busy, setBusy] = useState(false);
  const [restoreNote, setRestoreNote] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveRecordId, setSaveRecordId] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const close = () => navigate(-1);

  const onVoiceDone = (blob: Blob) => setVoiceBlob(blob);
  const voice = useRecorder(onVoiceDone);
  const startVoice = () => {
    setMicDenied(false);
    return voice.start().catch(() => setMicDenied(true));
  };

  const setCtx = (c: FieldContext | null) => {
    setCtxState(c);
    saveFieldContext(meId(), c);
    // New context re-resolves routing; an explicit earlier pick is dropped.
    setDestTouched(false);
  };

  /* Mount: restore durable draft, else seed context from ws_field_ctx and
   * honor PWA shortcut modes. */
  useEffect(() => {
    let live = true;
    void loadCaptureDraft().then((d) => {
      if (!live) return;
      if (d) {
        const f = d.form;
        setKind(f.kind);
        setCtxState(f.ctx);
        if (f.destId) {
          setDestId(f.destId);
          setDestTouched(true);
        }
        setTitle(f.title ?? '');
        setText(f.text ?? '');
        setCaption(f.caption ?? '');
        if (f.date) setDate(f.date);
        setMeasurement(f.measurement ?? '');
        setUnit(f.unit ?? '');
        setAmount(f.amount ?? '');
        setCategory(f.category ?? '');
        setDue(f.due ?? '');
        setDriveUrl(f.driveUrl ?? '');
        // Byte-durable media (P3-R2): bytes restore directly; only legacy
        // drafts written before media persistence need the re-attach note.
        const mp = d.media;
        if (mp.photos?.length) setPhotos(mp.photos);
        if (mp.docs?.length) setDocs(mp.docs.map((x) => new File([x.data], x.name, { type: x.type })));
        if (mp.voice) setVoiceBlob(mp.voice);
        const legacyMissing = (f.photoCount ?? 0) - (mp.photos?.length ?? 0) + (f.hasVoice && !mp.voice ? 1 : 0);
        if (legacyMissing > 0) setRestoreNote('Restored draft. Re-attach missing media before saving; some original files were not stored.');
        else if (mp.photos?.length || mp.voice || mp.docs?.length) setRestoreNote('Restored draft with attachments.');
        if (f.recordId) setSaveRecordId(f.recordId);
        if (f.stage && f.stage !== 'done') setRestoreNote((n) => n ?? 'Restored a partially saved capture — press Save to finish it.');
      } else {
        const stored = loadFieldContext(meId());
        if (stored) setCtxState(stored);
        const mode = params.get('mode');
        if (mode === 'photo') {
          setKind('photo');
          setTimeout(() => photoInput.current?.click(), 350);
        }
        if (mode === 'voice') {
          setKind('voice');
          void startVoice();
        }
      }
      setLoaded(true);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Files received via the PWA share target.
  useEffect(() => {
    if (params.get('shared') === '1') {
      void takeShared().then((items) => {
        if (!items.length) return;
        setPhotos((p) => [...p, ...items.map((i) => i.file)]);
        setKind((k) => (k === 'text' ? 'photo' : k));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Context row liveness — a deleted context keeps the draft but blocks Save
   * until the user explicitly re-picks or clears (never silently reassign). */
  const ctxRow = useLiveQuery(
    async () => {
      if (!ctx?.id) return null;
      const t = await db.tasks.get(ctx.id);
      if (t) return t;
      return (await db.pages.get(ctx.id)) ?? null;
    },
    [ctx?.id],
  );
  const ctxMissing = !!ctx && ctxRow !== undefined && (ctxRow === null || !!ctxRow.deleted);

  const ctxBoardId = ctx?.kind === 'record' ? String((ctxRow as TaskRow | null)?.boardId ?? ctx.databaseId ?? '') || undefined : undefined;
  const ctxBoard = ctxBoardId ? boards.find((b) => b.id === ctxBoardId) : undefined;
  const actions = useMemo(() => actionsForContext(ctxBoard), [ctxBoard]);

  // Auto-resolve destination until the user picks one explicitly.
  useEffect(() => {
    if (destTouched || !loaded) return;
    const uid = meId();
    const r = resolveDestination(kind, ctxBoard, boards, uid ? localStorage.getItem(captureBoardKey(uid)) : null);
    setDestId(r.databaseId ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, ctxBoardId, boards, loaded, destTouched]);

  const resolved = resolveDestination(kind, ctxBoard, boards, meId() ? localStorage.getItem(captureBoardKey(meId()!)) : null);
  const destBoard = destId ? boards.find((b) => b.id === destId) : undefined;
  const destValid = !!destBoard;

  /* Draft: persist on change (debounced), cleared on save. Media bytes ride
   * along (P3-R2) — photo/doc/voice survive reload + offline. */
  const draftObj = useMemo<CaptureDraft>(
    () => ({
      v: 1,
      kind,
      ctx,
      destId: destTouched ? destId : undefined,
      destTouched: destTouched || undefined,
      title: title || undefined,
      text: text || undefined,
      caption: caption || undefined,
      date: date || undefined,
      measurement: measurement || undefined,
      unit: unit || undefined,
      amount: amount || undefined,
      category: category || undefined,
      due: due || undefined,
      driveUrl: driveUrl || undefined,
      photoCount: photos.length || undefined,
      hasVoice: voiceBlob ? true : undefined,
      recordId: saveRecordId ?? undefined,
    }),
    [kind, ctx, destId, destTouched, title, text, caption, date, measurement, unit, amount, category, due, driveUrl, photos, voiceBlob, saveRecordId],
  );
  const mediaObj = useMemo<CaptureMedia>(
    () => ({
      photos: photos.length ? photos : undefined,
      docs: docs.length ? docs.map((f) => ({ name: f.name, type: f.type, data: f })) : undefined,
      voice: voiceBlob,
    }),
    [photos, docs, voiceBlob],
  );
  useEffect(() => {
    if (!loaded || saved) return;
    const t = setTimeout(() => void persistDraft(draftObj, mediaObj), 400);
    return () => clearTimeout(t);
  }, [loaded, saved, draftObj, mediaObj]);

  const hasContent = (() => {
    switch (kind) {
      case 'task':
        return !!title.trim();
      case 'observation':
        return !!(measurement.trim() || unit.trim() || text.trim() || photos.length || voiceBlob);
      case 'expense':
        return !!(amount.trim() || category.trim() || photos.length || docs.length || voiceBlob || driveUrl.trim());
      case 'note':
        return !!(text.trim() || photos.length || voiceBlob || docs.length || driveUrl.trim());
      case 'photo':
        return photos.length > 0 || !!caption.trim() || !!voiceBlob;
      case 'voice':
        return !!voiceBlob || !!caption.trim();
      case 'text':
        return !!caption.trim() || photos.length > 0 || !!voiceBlob || docs.length > 0 || !!driveUrl.trim();
    }
  })();
  const canSave = !busy && !saved && !ctxMissing && destValid && hasContent;
  const blockReason = ctxMissing
    ? 'Context no longer available — choose a new context or clear it'
    : !destValid
      ? isRoutedKind(kind)
        ? 'Choose a destination — no capture target resolves this kind'
        : 'Choose a board'
      : null;

  const save = async () => {
    if (!canSave || !destBoard) return;
    setBusy(true);
    setSaveError(null);
    // P3-R2: mint the operation's record id once and persist it BEFORE the
    // first write — every sub-op id is derived from it, so a retry after a
    // mid-save failure completes the SAME record instead of creating another.
    const recId = saveRecordId ?? `cap_${crypto.randomUUID()}`;
    if (!saveRecordId) setSaveRecordId(recId);
    const ids = capturePlanIds(recId, { photos: photos.length, docs: docs.length, hasVoice: !!voiceBlob, hasLink: !!driveUrl.trim() });
    // Form + stage only: media bytes were already staged by the debounced
    // draft write (capdraft_* blob rows) — the envelope merge keeps their
    // refs, so a checkpoint is a cheap meta write that can never stall the
    // save path on engines with slow IDB Blob writes.
    const checkpoint = async (stage: 'record' | 'files' | 'links' | 'done') => {
      await saveCaptureDraft({ ...draftObj, recordId: recId, stage });
    };
    try {
      await checkpoint(draftObj.stage === 'done' ? 'done' : 'record');
      const form: CaptureForm = { title, text, caption, date, measurement, unit, amount, category, due, driveUrl };
      const routed = isRoutedKind(kind);
      const { props, leftovers } = routed ? propsForForm(destBoard, kind, form) : { props: {}, leftovers: [] };
      const recTitle = titleFor(kind, form, stamp());
      const description = bodyForKind(kind, form, leftovers);
      await createRecord(destBoard.id, { id: ids.recordId, title: recTitle, extra: { ...props, ...(description ? { description } : {}), captureEvidence:{v:1,photoCount:photos.length} } });
      await checkpoint('record');

      let coverId: string | undefined;
      for (const [i, p] of photos.entries()) {
        const fid = await addFile(new File([p], `photo-${i}.jpg`, { type: p.type || 'image/jpeg' }), { parentType: 'task', parentId: ids.recordId, id: ids.photoIds[i] });
        if (i === 0) coverId = fid;
      }
      for (const [i, f] of docs.entries()) {
        await addFile(f, { parentType: 'task', parentId: ids.recordId, id: ids.docIds[i] });
      }
      if (voiceBlob) {
        await addFile(new File([voiceBlob], `voice.${voiceBlob.type.includes('mp4') ? 'm4a' : 'webm'}`, { type: voiceBlob.type }), {
          parentType: 'task',
          parentId: ids.recordId,
          id: ids.voiceId,
          name: `Voice memo ${stamp()}`,
          transcriptState: 'pending',
        });
      }
      if (driveUrl.trim()) {
        await addLink(driveUrl.trim(), { parentType: 'task', parentId: ids.recordId, id: ids.linkFileId });
      }
      await checkpoint('files');
      if (coverId) await setTaskField(ids.recordId, { coverFileId: coverId });
      if (ctx) {
        await link({ type: 'record', id: ids.recordId }, { type: ctx.kind, id: ctx.id }, 'related', null);
      }
      logActivity('captured', 'task', ids.recordId, recTitle, { kind, ...(ctx ? { contextId: ctx.id } : {}) });

      const uid = meId();
      if (uid) localStorage.setItem(captureBoardKey(uid), destBoard.id);
      await clearCaptureDraft();
      setSaved(navigator.onLine ? 'saved' : 'offline');
      setTimeout(() => navigate(`/boards/${destBoard.id}`), 900);
    } catch (e) {
      // Honest partial state: the draft (with the operation's recordId + media
      // bytes) stays on disk; pressing Save again re-runs the SAME plan.
      await checkpoint(draftObj.stage ?? 'record').catch(() => {});
      const stage = draftObj.stage;
      const landed = stage === 'record' ? 'the record' : stage === 'files' ? 'the record and attachments' : 'part of the capture';
      setSaveError(`Saved partially — ${landed} landed. Press Save again to finish; nothing will duplicate.`);
      console.warn('capture save failed', e);
    } finally {
      setBusy(false);
    }
  };

  /* ---------- shared attachment UI ---------- */
  const photoStrip = photos.length > 0 && (
    <div className="mt-2 flex gap-2 overflow-x-auto">
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
  );

  const voiceBlock = (
    <div className="mt-2">
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
      ) : null}
    </div>
  );

  const docList = docs.length > 0 && (
    <div className="mt-2 space-y-1">
      {docs.map((f, i) => (
        <div key={i} className="flex items-center gap-2 rounded-xl border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-700">
          <Paperclip size={13} className="shrink-0 text-neutral-400" />
          <span className="min-w-0 flex-1 truncate">{f.name}</span>
          <span className="shrink-0 text-xs text-neutral-400">{fmtBytes(f.size)}</span>
          <button aria-label={`Remove ${f.name}`} onClick={() => setDocs((d) => d.filter((_, j) => j !== i))} className="text-neutral-400 hover:text-neutral-600">
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );

  const attachments = (
    <div className="mt-4">
      <span className="mb-1.5 block text-xs font-medium text-neutral-500 dark:text-neutral-400">Attachments</span>
      <div className="flex flex-wrap gap-2">
        {kind !== 'photo' && (
          <Button size="sm" variant="outline" onClick={() => photoInput.current?.click()}>
            <Camera size={13} /> Photo
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
          <Paperclip size={13} /> File
        </Button>
        {kind !== 'voice' && voice.supported && !voiceBlob && voice.state !== 'recording' && (
          <Button size="sm" variant="outline" onClick={() => void startVoice()}>
            <Mic size={13} /> Voice
          </Button>
        )}
        {!voice.supported && !voiceBlob && <span className="self-center text-xs text-neutral-400">Voice recording unavailable — attach a file instead</span>}
      </div>
      {micDenied && <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">Microphone unavailable or denied — attach a file or write text instead.</p>}
      {photoStrip}
      {docList}
      {voiceBlock}
      <div className="mt-2">
        <Input value={driveUrl} onChange={(e) => setDriveUrl(e.target.value)} inputMode="url" placeholder="Paste a Drive link…" aria-label="Drive link URL" />
      </div>
    </div>
  );

  /* ---------- kind forms ---------- */
  const form = (() => {
    switch (kind) {
      case 'photo':
        return (
          <>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => photoInput.current?.click()} className="flex flex-col items-center justify-center gap-1.5 rounded-2xl bg-neutral-900 py-5 text-sm font-medium text-white active:bg-neutral-700 dark:bg-white dark:text-neutral-900">
                <Camera size={22} /> Take photo
              </button>
              <button onClick={() => galleryInput.current?.click()} className="flex flex-col items-center justify-center gap-1.5 rounded-2xl border border-neutral-200 py-5 text-sm font-medium text-neutral-600 active:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300">
                <ImagePlus size={22} /> Choose photos
              </button>
            </div>
            <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={3} placeholder="Add a caption…" aria-label="Caption" className="mt-3" />
          </>
        );
      case 'voice':
        return (
          <>
            {voice.state === 'recording' || voiceBlob ? null : (
              <button
                onClick={() => void startVoice()}
                disabled={!voice.supported}
                className="flex w-full flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-neutral-300 py-5 text-sm font-medium text-neutral-500 active:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400"
              >
                <Mic size={22} /> Record voice memo
              </button>
            )}
            {!voice.supported && <p className="mt-1.5 text-xs text-neutral-400">Voice recording isn't supported here — attach an audio file or write text below.</p>}
            <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={3} placeholder="Add a caption…" aria-label="Caption" className="mt-3" />
          </>
        );
      case 'text':
        return <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={4} placeholder="Write something…" aria-label="Text" />;
      case 'note':
        return (
          <Field label="Note">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="Write a note — first line becomes the title…" />
          </Field>
        );
      case 'task':
        return (
          <div className="space-y-3">
            <Field label="Title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" />
            </Field>
            <Field label="Due date (optional)">
              <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
          </div>
        );
      case 'observation':
        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Date">
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label="Unit">
                <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="cm, kg, °C…" />
              </Field>
            </div>
            <Field label="Measurement">
              <Input value={measurement} onChange={(e) => setMeasurement(e.target.value)} inputMode="decimal" placeholder="0.00" />
            </Field>
            <Field label="Observation">
              <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="What did you observe?" />
            </Field>
          </div>
        );
      case 'expense':
        return (
          <div className="space-y-3">
            <Field label="Amount">
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Date">
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label="Category">
                <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Materials, travel…" />
              </Field>
            </div>
            <p className="text-xs text-neutral-400">Attach a receipt below (photo, file or Drive link).</p>
          </div>
        );
    }
  })();

  const body = showPicker ? (
    <ContextPicker
      current={ctx}
      onClose={() => setShowPicker(false)}
      onPick={(c) => {
        setCtx(c);
        setShowPicker(false);
      }}
    />
  ) : (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
        <span className="text-sm font-semibold">Quick capture</span>
        <IconButton onClick={close} aria-label="Close capture">
          <X size={17} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {/* context chip */}
        <div className="mb-3 flex items-center gap-2">
          <button
            onClick={() => setShowPicker(true)}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm',
              ctx ? 'border-neutral-200 dark:border-neutral-700' : 'border-dashed border-neutral-300 text-neutral-500 dark:border-neutral-700',
            )}
          >
            <MapPin size={14} className="shrink-0 text-neutral-400" />
            {ctx ? (
              <>
                <span className="min-w-0 flex-1 truncate font-medium">{ctx.title || 'Untitled'}</span>
                <span className="shrink-0 truncate text-xs text-neutral-400" style={{ maxWidth: '40%' }}>
                  {ctxMissing ? 'Unavailable' : ctxBoard ? String(ctxBoard.name ?? '') : ctx.kind}
                </span>
              </>
            ) : (
              <span className="flex-1">
                Add context <span className="text-neutral-400">(place, project, page…)</span>
              </span>
            )}
          </button>
          {ctx && (
            <IconButton onClick={() => setCtx(null)} aria-label="Clear context" title="Clear context">
              <X size={14} />
            </IconButton>
          )}
        </div>
        {ctx && ctxMissing && (
          <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300" role="alert">
            This context no longer exists — your draft is kept. Choose a new context or clear it before saving.
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowPicker(true)}>
                Choose context…
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCtx(null)}>
                Clear context
              </Button>
            </div>
          </div>
        )}

        {/* kind chips */}
        <div className="mb-3 flex gap-1.5 overflow-x-auto pb-0.5" role="group" aria-label="Capture kind">
          {actions.map((k) => {
            const Icon = KIND_ICONS[k];
            const active = kind === k;
            return (
              <button
                key={k}
                onClick={() => setKind(k)}
                aria-pressed={active}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                  active
                    ? 'border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900'
                    : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300',
                )}
              >
                <Icon size={13} /> {CAPTURE_KIND_LABELS[k]}
              </button>
            );
          })}
        </div>

        {restoreNote && <p className="mb-3 rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">{restoreNote}</p>}

        {/* hidden inputs shared by all kinds */}
        <input ref={photoInput} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) setPhotos((p) => [...p, f]); e.target.value = ''; }} />
        <input ref={galleryInput} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { const files=Array.from(e.target.files??[]);setPhotos((p) => [...p, ...files]); e.target.value = ''; }} />
        <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => { const files=Array.from(e.target.files??[]);setDocs((d) => [...d, ...files]); e.target.value = ''; }} />

        {form}
        {attachments}

        {/* destination — always visible before Save */}
        <div className="mt-4 flex items-center gap-2">
          <FileText size={14} className="shrink-0 text-neutral-400" />
          <span className="shrink-0 text-xs text-neutral-400">Save to</span>
          <Select
            value={destId}
            onChange={(e) => {
              setDestId(e.target.value);
              setDestTouched(true);
            }}
            className="w-auto min-w-0 flex-1 py-1.5 text-sm"
            aria-label="Destination database"
          >
            {!destBoard && <option value="">Choose a database…</option>}
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {String(b.icon ?? '')} {String(b.name ?? 'Board')}
              </option>
            ))}
          </Select>
          {resolved.via === 'target' && <span className="shrink-0 text-[10px] text-neutral-400">via capture target</span>}
        </div>
      </div>
      <div className="pb-safe border-t border-neutral-100 p-4 dark:border-neutral-800">
        {saved ? (
          <div className={cn('flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-medium', saved === 'offline' ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400' : 'bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400')}>
            <Check size={15} /> {saved === 'offline' ? 'Saved offline — will upload when online' : 'Saved'}
          </div>
        ) : (
          <>
            {blockReason && <p className="mb-2 text-center text-xs text-amber-600 dark:text-amber-400">{blockReason}</p>}
            {saveError && <p role="alert" className="mb-2 rounded-xl bg-amber-50 px-3 py-2 text-center text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">{saveError}</p>}
            <button onClick={() => void save()} disabled={!canSave} className="w-full rounded-xl bg-neutral-900 py-3 text-sm font-semibold text-white transition-colors enabled:hover:bg-neutral-700 disabled:opacity-40 dark:bg-white dark:text-neutral-900">
              Save to {destBoard ? String(destBoard.name ?? 'database') : '…'}
            </button>
          </>
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
