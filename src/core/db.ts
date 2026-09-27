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
  users!: Table<PublicUser, string>;
  outbox!: Table<OutboxEntry, number>;
  meta!: Table<{ key: string; value: unknown }, string>;
  blobs!: Table<BlobRow, string>;

  constructor() {
    super('workspace');
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
  }

  collection(name: Collection): Table<LocalRow, string> {
    return this.table(name) as Table<LocalRow, string>;
  }
}

export const db = new LocalDB();

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = await db.meta.get(key);
  return row?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}
