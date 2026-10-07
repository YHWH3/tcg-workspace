import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { authStore } from './auth';
import { api, ApiError, getToken } from './api';
import { CHUNK_SIZE, chunkCount, chunkSlice, MAX_FILE_SIZE } from './chunks';
import { db, type BlobRow, type BlobState, type LocalRow } from './db';
import { mutate, syncStore } from './sync/engine';
import { createStore, useStore } from './store';
import { uuid } from './utils';

import { kindOf } from '../../shared/filekinds';
export type { FileKind, ParentType } from '../../shared/filekinds';
import type { FileKind, ParentType } from '../../shared/filekinds';

export interface FileRow extends LocalRow {
  name?: string;
  mime?: string;
  size?: number;
  kind?: FileKind;
  width?: number;
  height?: number;
  duration?: number;
  thumbId?: string;
  parentType?: ParentType;
  parentId?: string;
  uploadedBy?: string;
  createdAt?: number;
  transcript?: string;
  transcriptState?: 'pending' | 'done' | 'failed';
  transcriptAttempts?: number;
  deleted?: boolean;
}

export { CHUNK_SIZE, MAX_FILE_SIZE, chunkCount, chunkSlice };
export { kindOf };

/* ---------- toasts ---------- */
interface ToastItem {
  id: number;
  text: string;
  tone: 'info' | 'error';
}
export const toastStore = createStore<{ items: ToastItem[] }>({ items: [] });
let toastSeq = 0;
export function toast(text: string, tone: 'info' | 'error' = 'info') {
  const id = ++toastSeq;
  toastStore.set((s) => ({ items: [...s.items, { id, text, tone }] }));
  setTimeout(() => toastStore.set((s) => ({ items: s.items.filter((t) => t.id !== id) })), 4500);
}

/* ---------- image processing ---------- */

async function decodeBitmap(blob: Blob): Promise<ImageBitmap> {
  return await createImageBitmap(blob);
}

async function toWebp(bitmap: ImageBitmap, maxEdge: number, quality: number): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  let out = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', quality));
  if (!out || out.type !== 'image/webp') {
    // Older Safari can't encode webp → jpeg fallback.
    out = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  }
  if (!out) throw new Error('image encode failed');
  return { blob: out, width, height };
}

async function mediaDuration(blob: Blob, kind: 'audio' | 'video'): Promise<number | undefined> {
  try {
    const url = URL.createObjectURL(blob);
    try {
      const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
      el.preload = 'metadata';
      const dur = await new Promise<number | undefined>((resolve) => {
        const done = () => resolve(Number.isFinite(el.duration) ? Math.round(el.duration) : undefined);
        el.onloadedmetadata = done;
        el.onerror = () => resolve(undefined);
        setTimeout(() => resolve(undefined), 4000);
      });
      return dur;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return undefined;
  }
}

/* ---------- addFile ---------- */

export async function addFile(input: Blob | File, opts: { parentType: ParentType; parentId: string; name?: string; transcriptState?: 'pending' }): Promise<string> {
  const id = uuid();
  const me = authStore.get().user;
  const originalName = opts.name ?? (input instanceof File ? input.name : undefined) ?? 'file';
  const mime = input.type || 'application/octet-stream';
  let kind = kindOf(mime);
  let blob = input as Blob;
  let width: number | undefined;
  let height: number | undefined;
  let duration: number | undefined;
  let thumbId: string | undefined;

  if (kind === 'image' && input.size > 256 * 1024) {
    try {
      const bmp = await decodeBitmap(input);
      const full = await toWebp(bmp, 2048, 0.82);
      blob = full.blob;
      width = full.width;
      height = full.height;
      const thumb = await toWebp(bmp, 480, 0.8);
      thumbId = uuid();
      await db.blobs.put({ id: thumbId, blob: thumb.blob, state: 'pending', uploadedChunks: 0, mime: thumb.blob.type });
      bmp.close();
    } catch {
      /* fall through: store original bytes */
    }
  } else if (kind === 'image') {
    try {
      const bmp = await decodeBitmap(input);
      width = bmp.width;
      height = bmp.height;
      const thumb = await toWebp(bmp, 480, 0.8);
      thumbId = uuid();
      await db.blobs.put({ id: thumbId, blob: thumb.blob, state: 'pending', uploadedChunks: 0, mime: thumb.blob.type });
      bmp.close();
    } catch {
      /* keep original */
    }
  }

  if (kind === 'audio' || kind === 'video') duration = await mediaDuration(blob, kind);

  if (blob.size > MAX_FILE_SIZE) {
    toast(`"${originalName}" is larger than 20 MB — not saved`, 'error');
    throw new ApiError(413, 'file too large');
  }

  await db.blobs.put({ id, blob, state: 'pending', uploadedChunks: 0, mime: blob.type });
  await mutate('files', id, {
    name: originalName,
    mime: blob.type,
    size: blob.size,
    kind,
    width,
    height,
    duration,
    thumbId,
    parentType: opts.parentType,
    parentId: opts.parentId,
    uploadedBy: me?.id ?? null,
    createdAt: Date.now(),
    ...(opts.transcriptState ? { transcriptState: opts.transcriptState } : {}),
  });
  return id;
}

/** Soft-delete the metadata record and best-effort delete the blob everywhere. */
export async function deleteFile(fileId: string): Promise<void> {
  const meta = await db.files.get(fileId);
  await mutate('files', fileId, { deleted: true });
  const ids = [fileId, meta?.thumbId as string | undefined].filter(Boolean) as string[];
  await db.blobs.bulkDelete(ids);
  for (const id of ids) {
    try {
      await api(`/api/files/${id}`, { method: 'DELETE' });
    } catch {
      /* offline/best-effort */
    }
  }
}

/* ---------- queries ---------- */

export function useAttachments(parentId: string | undefined): FileRow[] {
  const raw = useLiveQuery(async () => (parentId ? ((await db.files.where('parentId').equals(parentId).toArray()) as FileRow[]) : []), [parentId], []);
  return (raw ?? []).filter((f) => !f.deleted).sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));
}

export function useBlobState(fileId: string | undefined): BlobState | undefined {
  return useLiveQuery(async () => (fileId ? (await db.blobs.get(fileId))?.state : undefined), [fileId]);
}

/* ---------- upload queue (called from the sync engine) ---------- */

async function putChunk(fileId: string, idx: number, data: Blob): Promise<void> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api/files/${fileId}/chunks/${idx}`, { method: 'PUT', headers, body: await data.arrayBuffer() });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  }
}

/** Upload pending blobs chunk-by-chunk (resumable), complete, then transcribe voice memos. */
export async function uploadPendingBlobs(): Promise<void> {
  const pending = await db.blobs.where('state').equals('pending').toArray();
  for (const row of pending) {
    try {
      const total = chunkCount(row.blob.size);
      for (let i = row.uploadedChunks; i < total; i++) {
        await putChunk(row.id, i, chunkSlice(row.blob, i));
        await db.blobs.update(row.id, { uploadedChunks: i + 1 });
      }
      await api(`/api/files/${row.id}/complete`, { method: 'POST', body: { mime: row.blob.type, size: row.blob.size, chunks: total } });
      await db.blobs.update(row.id, { state: 'uploaded' });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 413 || e.status === 507)) {
        await db.blobs.update(row.id, { state: 'failed', error: e.message });
        toast(`Upload failed: ${e.message}`, 'error');
        continue; // never jam the queue
      }
      if (e instanceof ApiError && e.status === 401) throw e;
      throw e; // transient → abort the pass; next sync retries
    }
  }
  await transcribePending();
}

/** After a successful upload, transcribe audio attachments flagged pending. */
async function transcribePending(): Promise<void> {
  const all = (await db.files.toArray()) as FileRow[];
  for (const f of all) {
    if (f.deleted || f.transcriptState !== 'pending') continue;
    const blob = await db.blobs.get(f.id);
    if (!blob || blob.state !== 'uploaded') continue;
    try {
      const { text } = await api<{ text: string }>(`/api/files/${f.id}/transcribe`, { method: 'POST', body: {} });
      await mutate('files', f.id, { transcript: text, transcriptState: 'done' });
      if (f.parentType === 'task' && f.parentId) await applyTranscriptToTask(String(f.parentId), text);
      else if (f.parentType === 'block' && f.parentId) await applyTranscriptToBlock(f, text);
    } catch (e) {
      // Permanent errors (bad input, too large) fail immediately; transient
      // errors (network, auth, AI 5xx) stay 'pending' and retry — but cap the
      // attempts so a file Whisper can't handle doesn't retry forever.
      const attempts = (typeof f.transcriptAttempts === 'number' ? f.transcriptAttempts : 0) + 1;
      const permanent = e instanceof ApiError && (e.status === 400 || e.status === 413);
      await mutate('files', f.id, { transcriptAttempts: attempts, ...(permanent || attempts >= 5 ? { transcriptState: 'failed' } : {}) });
    }
  }
}

async function applyTranscriptToTask(taskId: string, text: string): Promise<void> {
  const task = await db.tasks.get(taskId);
  if (!task) return;
  const title = String(task.title ?? '');
  const patch: Record<string, unknown> = {};
  // Placeholder titles get replaced by the transcript's first sentence.
  if (/^(Voice memo|Photo|Note) · /.test(title)) {
    const first = text.split(/(?<=[.!?])\s+|\n/)[0]?.trim() ?? '';
    if (first) patch.title = first.slice(0, 80);
  }
  if (!String(task.description ?? '').trim()) {
    patch.description = `Transcript\n${text}`;
  }
  if (Object.keys(patch).length) await mutate('tasks', taskId, patch);
}

async function applyTranscriptToBlock(file: FileRow, text: string): Promise<void> {
  const block = await db.blocks.get(String(file.parentId));
  if (!block) return;
  if (!String(block.caption ?? '').trim()) await mutate('blocks', block.id, { caption: text.split('\n')[0]?.slice(0, 80) ?? '' });
}

/* ---------- useFileUrl ---------- */

/**
 * Object URL for a file's blob. Local Dexie copy wins; if absent and online,
 * downloads with the bearer token and caches it. Returns undefined while the
 * blob isn't available yet (still on another device / not uploaded).
 */
export function useFileUrl(fileId: string | undefined, preferId?: string | undefined): { url?: string; missing: boolean; failed: boolean } {
  const target = preferId ?? fileId;
  const blobRow = useLiveQuery(async () => (target ? await db.blobs.get(target) : undefined), [target]);
  const { lastSyncedAt } = useStore(syncStore);
  const [url, setUrl] = useState<string | undefined>();
  const [missing, setMissing] = useState(false);
  const tried = useRef(0);

  useEffect(() => {
    let revoke: string | undefined;
    let cancelled = false;
    setMissing(false);
    (async () => {
      if (!target) return;
      const row = await db.blobs.get(target);
      if (cancelled) return;
      if (row) {
        revoke = URL.createObjectURL(row.blob);
        setUrl(revoke);
        return;
      }
      if (!navigator.onLine || !getToken()) {
        setMissing(true);
        return;
      }
      try {
        const res = await fetch(`/api/files/${target}`, { headers: { Authorization: `Bearer ${getToken()}` } });
        if (!res.ok) {
          setMissing(true);
          return;
        }
        const blob = await res.blob();
        await db.blobs.put({ id: target, blob, state: 'cached', uploadedChunks: 0, mime: blob.type });
        if (cancelled) return;
        revoke = URL.createObjectURL(blob);
        setUrl(revoke);
      } catch {
        setMissing(true);
      }
    })();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
      setUrl(undefined);
    };
    // lastSyncedAt → retry missing fetches after each successful sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, blobRow?.state, lastSyncedAt, tried.current]);

  const failed = blobRow?.state === 'failed';
  return { url, missing: missing && !blobRow, failed };
}

export { type BlobRow };
