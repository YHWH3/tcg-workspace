/* Pre-uid legacy store recovery (review S1). Installs created before
 * per-account databases stored everything in a Dexie db literally named
 * 'workspace'; db.ts now opens workspace-<uid>, which would strand that data.
 * On sign-in we detect the legacy store, establish that it belongs to the
 * signed-in account, copy records/meta (cursor + drafts)/outbox/blobs into
 * workspace-<uid> with verification, and only then queue the legacy store for
 * deferred deletion. Copying another account's data is never automatic —
 * ambiguous ownership surfaces a blocking recovery dialog (explicit confirm,
 * export, or leave). Interrupted runs are safe to retry: copies only insert
 * absent ids and the completion marker lands last. */

import Dexie from 'dexie';
import { COLLECTIONS } from '../../shared/collections';
import { LocalDB, type BlobRow } from './db';
import { createStore } from './store';
import { getMaint, setMaint, markDatabaseForDeletion } from './maintenance';
import type { DraftEnvelope } from './drafts';

export const LEGACY_NAME = 'workspace';
const DONE_PREFIX = 'migrated:';
const CONFIRM_PREFIX = 'legacy-confirm:';

export interface LegacyRecovery {
  uid: string;
  /** What the legacy store holds — shown so the choice is informed. */
  counts: { records: number; outbox: number; drafts: number; blobs: number };
  /** 'foreign' = drafts prove only OTHER accounts; 'mixed' = this account's
   * drafts coexist with other users' drafts — either way, importing means
   * bringing someone else's data in and needs explicit informed confirm. */
  foreign: boolean;
  mixed: boolean;
}

/** Non-null → blocking recovery dialog over everything (ambiguous owner). */
export const legacyRecoveryStore = createStore<LegacyRecovery | null>(null);

export type LegacyVerdict = 'none' | 'migrated' | 'foreign' | 'needs-confirm' | 'failed';

function draftOwnerIds(legacy: LocalDB): Promise<Set<string>> {
  return legacy.meta.toArray().then((rows) => {
    const owners = new Set<string>();
    for (const r of rows) {
      const m = /^draft:([^:]+):/.exec(r.key);
      if (m) owners.add(m[1]);
    }
    return owners;
  });
}

async function legacyCounts(legacy: LocalDB): Promise<LegacyRecovery['counts']> {
  const outbox = await legacy.outbox.count();
  const drafts = (await legacy.meta.toArray()).filter((r) => r.key.startsWith('draft:')).length;
  const blobs = await legacy.blobs.where('state').anyOf('pending', 'failed').count();
  let records = 0;
  for (const c of COLLECTIONS) records += await legacy.collection(c).count();
  return { records, outbox, drafts, blobs };
}

/** Insert-only copy: existing rows in the target are never overwritten
 * (sync may already have refreshed them — LWW resolves server-side anyway). */
async function copyStore(legacy: LocalDB, target: LocalDB): Promise<{ copied: number }> {
  let copied = 0;
  for (const c of COLLECTIONS) {
    const rows = await legacy.collection(c).toArray();
    const have = new Set(await target.collection(c).toCollection().primaryKeys());
    const fresh = rows.filter((r) => !have.has(r.id));
    if (fresh.length) await target.collection(c).bulkPut(fresh);
    copied += fresh.length;
  }
  for (const m of await legacy.meta.toArray()) {
    if (!(await target.meta.get(m.key))) {
      await target.meta.put(m);
      copied++;
    }
  }
  const outboxRows = await legacy.outbox.toArray();
  const seen = new Set((await target.outbox.toArray()).map((e) => `${e.collection}:${e.id}:${e.ts}`));
  const freshOut = outboxRows.filter((e) => !seen.has(`${e.collection}:${e.id}:${e.ts}`));
  for (const { autoId: _a, ...e } of freshOut) await target.outbox.add(e as Parameters<typeof target.outbox.add>[0]);
  copied += freshOut.length;
  const blobIds = new Set(await target.blobs.toCollection().primaryKeys());
  for (const b of await legacy.blobs.toArray()) {
    if (!blobIds.has(b.id)) {
      await target.blobs.put({ id: b.id, blob: b.blob, state: b.state, uploadedChunks: b.uploadedChunks, mime: b.mime, error: b.error } as BlobRow);
      copied++;
    }
  }
  return { copied };
}

/** Every legacy row must exist in the target: id sets for records/meta/blobs,
 * (collection,id,ts) tuples for outbox, byte length for blobs. */
async function verifyCopy(legacy: LocalDB, target: LocalDB): Promise<boolean> {
  for (const c of COLLECTIONS) {
    const have = new Set(await target.collection(c).toCollection().primaryKeys());
    for (const r of await legacy.collection(c).toArray()) if (!have.has(r.id)) return false;
  }
  const haveMeta = new Set(await target.meta.toCollection().primaryKeys());
  for (const m of await legacy.meta.toArray()) if (!haveMeta.has(m.key)) return false;
  const haveOut = new Set((await target.outbox.toArray()).map((e) => `${e.collection}:${e.id}:${e.ts}`));
  for (const e of await legacy.outbox.toArray()) if (!haveOut.has(`${e.collection}:${e.id}:${e.ts}`)) return false;
  const targetBlobs = new Map((await target.blobs.toArray()).map((b) => [b.id, b]));
  for (const b of await legacy.blobs.toArray()) {
    const t = targetBlobs.get(b.id);
    if (!t || t.blob.size !== b.blob.size) return false;
  }
  return true;
}

async function copyAndVerify(legacy: LocalDB, uid: string): Promise<LegacyVerdict> {
  const target = new LocalDB(`workspace-${uid}`);
  try {
    await copyStore(legacy, target);
    if (!(await verifyCopy(legacy, target))) return 'failed';
    await setMaint(`${DONE_PREFIX}${uid}`, Date.now());
    // Verified — queue the legacy store for MANUAL deletion only (T2): the
    // marker lets Settings offer "clear local data"; nothing deletes it
    // automatically, and the copy keeps it recoverable until then.
    await markDatabaseForDeletion(LEGACY_NAME);
    return 'migrated';
  } finally {
    target.close();
  }
}

/**
 * Run once per sign-in before the sync engine starts. Verdicts:
 *  none          — no legacy store (or already migrated)
 *  migrated      — copy verified; legacy queued for deferred deletion
 *  foreign       — drafts prove another account: nothing copied, durable
 *                  recovery surface (export only) instead
 *  needs-confirm — ownership unprovable: blocking dialog offers copy/export/leave
 *  failed        — copy/verify incomplete; retried next sign-in
 */
export async function migrateLegacyStore(uid: string): Promise<LegacyVerdict> {
  if (await getMaint(`${DONE_PREFIX}${uid}`)) return 'migrated';
  if (await getMaint(`${CONFIRM_PREFIX}${uid}`) === 'leave') return 'none'; // user said leave it
  const legacy = new LocalDB(LEGACY_NAME);
  try {
    if (!(await Dexie.exists(LEGACY_NAME))) {
      await setMaint(`${DONE_PREFIX}${uid}`, 'none');
      return 'none';
    }
    const owners = await draftOwnerIds(legacy);
    const counts = await legacyCounts(legacy);
    if (counts.records + counts.outbox + counts.drafts + counts.blobs === 0) {
      await setMaint(`${DONE_PREFIX}${uid}`, 'empty');
      await markDatabaseForDeletion(LEGACY_NAME);
      return 'migrated';
    }
    // Exclusive affirmative proof ONLY (T1): auto-copy iff the sole proven
    // owner is this account. Mixed ownership (drafts for this AND other
    // accounts) is just as ambiguous as foreign/unknown — never auto-copy.
    const soleOwner = owners.size === 1 && owners.has(uid);
    if (!soleOwner) {
      const foreign = owners.size > 0 && !owners.has(uid);
      const mixed = owners.size > 1 && owners.has(uid);
      await setMaint(`${CONFIRM_PREFIX}${uid}`, 'pending');
      legacyRecoveryStore.set({ uid, counts, foreign, mixed });
      return foreign || mixed ? 'foreign' : 'needs-confirm';
    }
    return await copyAndVerify(legacy, uid);
  } finally {
    legacy.close();
  }
}

/** Resolve the recovery dialog. 'copy' runs the verified copy — when the
 * legacy store's known owners include other users (foreign/mixed), the
 * caller MUST pass allowForeign:true, which only the dialog's explicit
 * informed-confirm step sets; anything less refuses with 'needs-confirm'.
 * 'export' writes the unsynced subset to a file and closes WITHOUT
 * persisting a decision (the store — and this gate — stay recoverable);
 * 'leave' marks the decision so the dialog stops re-asking. */
export async function resolveLegacyRecovery(
  choice: 'copy' | 'export' | 'leave',
  r: LegacyRecovery,
  opts: { allowForeign?: boolean } = {},
): Promise<LegacyVerdict> {
  const legacy = new LocalDB(LEGACY_NAME);
  try {
    if (choice === 'copy') {
      const owners = await draftOwnerIds(legacy);
      const hasForeign = owners.size > 1 || (owners.size > 0 && !owners.has(r.uid));
      if (hasForeign && !opts.allowForeign) return 'needs-confirm'; // refuse silent foreign import
      const out = await copyAndVerify(legacy, r.uid);
      if (out === 'migrated') legacyRecoveryStore.set(null);
      return out;
    }
    if (choice === 'export') {
      const { buildLocalBackup, saveBackupFile } = await import('./localBackup');
      const backup = await buildLocalBackup(legacy, 'legacy', async () => {
        const rows = await legacy.meta.toArray();
        return rows.filter((row) => row.key.startsWith('draft:')).map((row) => row.value as DraftEnvelope);
      });
      await saveBackupFile(backup);
      // NOT 'leave': the export only covers unsynced changes/uploads (T3) —
      // the legacy store stays untouched and this gate re-offers recovery.
      legacyRecoveryStore.set(null);
      return 'none';
    }
    await setMaint(`${CONFIRM_PREFIX}${r.uid}`, 'leave');
    legacyRecoveryStore.set(null);
    return 'none';
  } finally {
    legacy.close();
  }
}
