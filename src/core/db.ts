import Dexie, { type Table } from 'dexie';
import type { Collection } from '../../shared/collections';
import type { PublicUser } from '../../shared/types';

/** A local row: id + flattened fields + per-field HLC timestamps. */
export interface LocalRow {
  id: string;
  _ts: Record<string, number>;
  [field: string]: unknown;
}

export interface OutboxEntry {
  autoId?: number;
  id: string;
  collection: Collection;
  patch: Record<string, unknown>;
  ts: number;
  /** 'rejected' rows are kept (never silently dropped) until retried/exported —
   * absent on older rows, treat as 'pending' (review B5). */
  state?: 'pending' | 'rejected';
  rejectReason?: string;
}

export type BlobState = 'pending' | 'uploaded' | 'cached' | 'failed';

export interface BlobRow {
  id: string;
  blob: Blob;
  state: BlobState;
  uploadedChunks: number;
  mime?: string;
  error?: string;
}

/** One IndexedDB database per account id (§12.3, review R3): an account
 * switch can never expose or clobber the previous account's store — B gets
 * `workspace-<B>` while A's `workspace-<A>` stays quarantined on disk.
 * Falls back to a stable anonymous name before any identity exists. */
function databaseName(): string {
  const uid = typeof localStorage === 'undefined' ? null : localStorage.getItem('ws_uid');
  return uid ? `workspace-${uid}` : 'workspace-anon';
}

export class LocalDB extends Dexie {
  pages!: Table<LocalRow, string>;
  blocks!: Table<LocalRow, string>;
  tasks!: Table<LocalRow, string>;
  comments!: Table<LocalRow, string>;
  activity!: Table<LocalRow, string>;
  boards!: Table<LocalRow, string>;
  files!: Table<LocalRow, string>;
  moodboards!: Table<LocalRow, string>;
  mooditems!: Table<LocalRow, string>;
  views!: Table<LocalRow, string>;
  links!: Table<LocalRow, string>;
  users!: Table<PublicUser, string>;
  outbox!: Table<OutboxEntry, number>;
  meta!: Table<{ key: string; value: unknown }, string>;
  blobs!: Table<BlobRow, string>;

  constructor() {
    super(databaseName());
    this.version(1).stores({
      pages: 'id, parentId, order',
      blocks: 'id, pageId, order',
      tasks: 'id, status, assigneeId, order, createdAt',
      comments: 'id, targetId, createdAt',
      activity: 'id, createdAt, targetId',
      users: 'id',
      outbox: '++autoId, id',
      meta: 'key',
    });
    this.version(2).stores({
      boards: 'id, order',
      files: 'id, parentId, createdAt',
      blobs: 'id, state',
      tasks: 'id, status, assigneeId, boardId, order, createdAt',
    });
    this.version(3).stores({
      moodboards: 'id, order',
      mooditems: 'id, boardId, z',
    });
    this.version(4).stores({
      views: 'id, databaseId, order',
      links: 'id, fromId, toId, kind, fieldId',
      tasks: 'id, status, assigneeId, boardId, parentId, order, createdAt',
    });
  }

  collection(name: Collection): Table<LocalRow, string> {
    return this.table(name) as Table<LocalRow, string>;
  }
}

export const db = new LocalDB();

/** Delete the on-disk store belonging to `userId` (destroy choice on account
 * switch). Uses the raw deleteDatabase request: `onblocked` rejects as soon
 * as another connection is holding the store open, with `timeoutMs` as a
 * backstop for browsers that swallow the event — the caller MUST treat a
 * rejection as abort, not proceed. */
export async function dropDatabaseFor(userId: string, timeoutMs = 4000): Promise<void> {
  const name = `workspace-${userId}`;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`deleting ${name} timed out`)), timeoutMs);
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => {
      clearTimeout(timer);
      resolve();
    };
    req.onerror = () => {
      clearTimeout(timer);
      reject(req.error ?? new Error(`could not delete ${name}`));
    };
    req.onblocked = () => {
      clearTimeout(timer);
      reject(new Error(`deleting ${name} is blocked by another tab`));
    };
  });
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = await db.meta.get(key);
  return row?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}
