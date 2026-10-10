/* Complete local backup for the account-switch 'keep' path (review R1):
 * outbox entries (every unacknowledged state) + draft envelopes + pending/
 * failed blob rows WITH their bytes, serialized to one JSON file. A matching
 * importer reconstitutes all three into a Dexie store. The switch only
 * proceeds after the save is verified (File System Access write) or the user
 * explicitly confirms the download — a bare a.click() is never trusted. */

import type { BlobRow, LocalDB, OutboxEntry } from './db';
import type { DraftEnvelope } from './drafts';

export interface BackupBlob {
  id: string;
  state: BlobRow['state'];
  uploadedChunks: number;
  mime?: string;
  error?: string;
  /** data: URL — bytes ride inside the archive. */
  dataUrl: string;
}

export interface LocalBackup {
  version: 1;
  exportedAt: number;
  userId: string;
  outbox: Omit<OutboxEntry, 'autoId'>[];
  drafts: DraftEnvelope[];
  blobs: BackupBlob[];
}

const CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  if (typeof btoa === 'function') return btoa(s);
  return Buffer.from(s, 'binary').toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export async function blobToDataUrl(blob: Blob, mime?: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${mime ?? blob.type ?? 'application/octet-stream'};base64,${bytesToBase64(bytes)}`;
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const m = /^data:([^;,]*);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('invalid backup blob payload');
  const bytes = base64ToBytes(m[2]);
  return new Blob([bytes.buffer as ArrayBuffer], { type: m[1] || 'application/octet-stream' });
}

/** Serialize everything unacknowledged belonging to `userId`, blob bytes
 * included. Takes the DB as a param so it works against any account store. */
export async function buildLocalBackup(store: LocalDB, userId: string, listDraftsFor: (uid: string) => Promise<DraftEnvelope[]>): Promise<LocalBackup> {
  const [outbox, drafts, blobRows] = await Promise.all([
    store.outbox.toArray(),
    listDraftsFor(userId),
    store.blobs.where('state').anyOf('pending', 'failed').toArray(),
  ]);
  const blobs: BackupBlob[] = [];
  for (const b of blobRows) {
    blobs.push({ id: b.id, state: b.state, uploadedChunks: b.uploadedChunks, mime: b.mime, error: b.error, dataUrl: await blobToDataUrl(b.blob, b.mime) });
  }
  return { version: 1, exportedAt: Date.now(), userId, outbox: outbox.map(({ autoId: _autoId, ...e }) => e), drafts, blobs };
}

/** Reconstitute a backup into `store` (any account's DB). Idempotent per
 * outbox entry identity (id+collection+ts upsert), blobs put by id. */
export async function importLocalBackup(store: LocalDB, backup: LocalBackup): Promise<{ outbox: number; drafts: number; blobs: number }> {
  if (backup.version !== 1) throw new Error(`unsupported backup version ${backup.version}`);
  for (const e of backup.outbox) await store.outbox.put({ ...e } as OutboxEntry);
  for (const d of backup.drafts) {
    await store.meta.put({ key: `draft:${d.userId}:${d.collection}:${d.id}`, value: d });
  }
  for (const b of backup.blobs) {
    await store.blobs.put({ id: b.id, blob: dataUrlToBlob(b.dataUrl), state: b.state, uploadedChunks: b.uploadedChunks, mime: b.mime, error: b.error });
  }
  return { outbox: backup.outbox.length, drafts: backup.drafts.length, blobs: backup.blobs.length };
}

export type SaveResult = 'verified' | 'clicked';

/** Persist the archive to disk. Returns 'verified' only when a real write was
 * confirmed (File System Access API); the plain <a download> fallback cannot
 * be verified — callers must require an explicit user confirmation. */
export async function saveBackupFile(backup: LocalBackup): Promise<SaveResult> {
  const json = JSON.stringify(backup);
  const name = `workspace-backup-${backup.userId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;
  const picker = (window as unknown as { showSaveFilePicker?: (o: object) => Promise<{ createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }> }> }).showSaveFilePicker;
  if (picker) {
    const handle = await picker({ suggestedName: name, types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] });
    const w = await handle.createWritable();
    await w.write(new Blob([json], { type: 'application/json' }));
    await w.close(); // close() resolves only after the bytes hit disk
    return 'verified';
  }
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return 'clicked';
}

/** Convenience for a File/Open restore path: parse + validate an archive. */
export function parseBackup(json: string): LocalBackup {
  const p = JSON.parse(json) as LocalBackup;
  if (!p || p.version !== 1 || typeof p.userId !== 'string' || !Array.isArray(p.outbox) || !Array.isArray(p.drafts) || !Array.isArray(p.blobs)) {
    throw new Error('not a workspace backup file');
  }
  return p;
}
