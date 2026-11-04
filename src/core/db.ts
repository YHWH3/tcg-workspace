import Dexie, { type Table } from 'dexie';
import {decodeBlobRow} from './blobCodec';
import type { Collection } from '../../shared/collections';
import type { PublicUser } from '../../shared/types';

/** A local row: id + flattened fields + per-field HLC timestamps. */
export interface LocalRow {
  id: string;
  _ts: Record<string, number>;
  [field: string]: unknown;
}

export interface OutboxEntry {
  enqueuedAt?: number;
  ifUnchanged?: import('../../shared/mutationGuard').MutationGuard;
  autoId?: number;
  id: string;
  collection: Collection;
  patch: Record<string, unknown>;
  ts: number;
  /** 'rejected' rows are kept (never silently dropped) until retried/exported —
   * absent on older rows, treat as 'pending' (review B5). */
  state?: 'pending' | 'rejected';
  rejectReason?: string;
  /** Local creation evidence for safe reconciliation; never a server grant. */
  createIntent?: boolean;
}

export interface SyncStageRow { snapshotId: string; id: string; collection: Collection; data: Record<string, unknown>; field_ts: Record<string, number>; seq: number; spaceId: string; peerSpaceId?: string }
export interface AccessQuarantineRow { autoId?: number; id: string; kind: 'outbox' | 'draft' | 'blob'; reason: string; generation: number; payload: unknown; quarantinedAt: number }
export type AccessQuarantineInfo = Omit<AccessQuarantineRow, 'payload' | 'autoId'> & { autoId: number; collection?: string };

export type BlobState = 'pending' | 'uploaded' | 'cached' | 'failed';

export interface BlobRow {
  pendingSince?: number;
  id: string;
  blob: Blob;
  state: BlobState;
  uploadedChunks: number;
  mime?: string;
  error?: string;
}
/** Fallback wire format for engines refusing Blob/File persistence. Never synced. */
export type EncodedBlobRow = Omit<BlobRow, 'blob'> & {blobEncoding:'array-buffer-v1';blobBytes:ArrayBuffer};

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
  blobs!: Table<BlobRow, string, BlobRow | EncodedBlobRow>;
  mediaCache!: Table<{id:string;bytes:number;lastUsed:number},string>;
  syncStage!: Table<SyncStageRow, [string, string]>;
  accessQuarantine!: Table<AccessQuarantineRow, number>;
  accessQuarantineInfo!: Table<AccessQuarantineInfo, number>;

  constructor(name: string = databaseName()) {
    super(name);
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
    // v5: identical schema — gives the purge probe a harmless upgrade
    // version to detect foreign holders with (see isHeldElsewhere).
    this.version(5).stores({});
    // v6 Phase 4: automation + form CONFIG collections (server-controlled
    // operational state stays in D1 tables, never synced here).
    this.version(6).stores({
      automations: 'id, databaseId, order',
      forms: 'id, databaseId, order',
    });
    this.version(7).stores({
      syncStage: '[snapshotId+id], snapshotId, collection',
      accessQuarantine: '++autoId, id, kind, generation',
    });
    this.version(8).stores({ accessQuarantineInfo: 'autoId, id, kind, generation' }).upgrade(async tx => {
      // Metadata-only UI queries must not materialize a workspace of pending
      // binary payloads. Upgrade one retained operation at a time.
      let after = 0;
      for (;;) {
        const row = (await tx.table('accessQuarantine').where(':id').above(after).limit(1).toArray())[0] as AccessQuarantineRow | undefined;
        if (!row?.autoId) break;
        const { payload, ...info } = row;
        const collection = row.kind === 'outbox' && payload && typeof payload === 'object' && 'collection' in payload ? String(payload.collection) : undefined;
        await tx.table('accessQuarantineInfo').put({ ...info, collection }); after = row.autoId;
      }
    });
    this.version(9).stores({mediaCache:'id,lastUsed'}).upgrade(async tx=>{
      let after='',bytes=0;for(;;){const rows=await tx.table('blobs').where(':id').above(after).limit(100).toArray();if(!rows.length)break;for(const r of rows)if(r.state==='cached'){await tx.table('mediaCache').put({id:r.id,bytes:r.blob.size,lastUsed:0});bytes+=r.blob.size;}after=rows[rows.length-1].id;}
      await tx.table('meta').put({key:'download-cache-bytes',value:bytes});
    });
    // IndexedDB indexes and metadata queries keep the compact stored row.
    // Dexie's reading hook decodes returned rows, not update/modify callbacks:
    // https://dexie.org/docs/Table/Table.hook('reading')
    this.blobs.hook('reading', decodeBlobRow);
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
  await dropDatabaseByName(`workspace-${userId}`, timeoutMs);
}

/**
 * Non-destructive probe: is this store held open by another connection?
 * Issues an upgrade-open at SCHEMA_VERSION (a no-op schema) — `onblocked`
 * fires iff another connection holds the db. If the probe request is
 * itself left pending it only completes a schema-identical bump when the
 * holders close — never destructive. Lets the purge detect 'held' WITHOUT
 * arming an uncancellable deleteDatabase request (T2).
 */
export async function isHeldElsewhere(name: string, timeoutMs = 1500): Promise<boolean> {
  // Read the raw on-disk version (fake-indexeddb and real engines can store
  // different raw values, so it must be read, not assumed).
  const version = await new Promise<number>((resolve, reject) => {
    const r = indexedDB.open(name);
    r.onsuccess = () => {
      const v = r.result.version;
      r.result.close();
      resolve(v);
    };
    r.onerror = () => reject(r.error);
  }).catch(() => -1);
  if (version < 0) return true; // unknown → treat as held (safe)
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), timeoutMs); // unknown → held (safe)
    const req = indexedDB.open(name, version + 1);
    req.onblocked = () => {
      clearTimeout(timer);
      resolve(true);
    };
    // Never actually upgrade: abort rolls the bump back — this probe is
    // non-destructive AND non-mutating even when left pending.
    req.onupgradeneeded = () => {
      try {
        req.transaction?.abort();
      } catch {
        /* best effort */
      }
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      req.result.close();
      resolve(false);
    };
    req.onerror = () => {
      clearTimeout(timer);
      resolve(false); // aborted upgrade / non-block failure → not held
    };
  });
}

/** Raw-name variant — also covers the pre-uid 'workspace' legacy store. */
export async function dropDatabaseByName(name: string, timeoutMs = 4000): Promise<void> {
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
