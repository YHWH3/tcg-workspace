/* Deferred local-store maintenance (review S2). Destructive IndexedDB deletes
 * never run inline: a deleteDatabase request cannot be cancelled once issued,
 * so reporting "aborted, data intact" while a live request pends is a lie —
 * the delete can still complete when the blocker closes. Instead a durable
 * marker is written and a deliberately-confirmed Settings pass performs the
 * delete with a confirmed outcome; on blocked/failure the marker simply
 * stays. Nothing auto-deletes at login (T2). The currently-active account's
 * store is never deleted. */

import Dexie from 'dexie';
import { dropDatabaseByName, isHeldElsewhere } from './db';

interface Row {
  key: string;
  value: unknown;
}

const maint = new Dexie('workspace-maint');
maint.version(1).stores({ kv: 'key' });
const kv = () => maint.table<Row, string>('kv');

export async function getMaint<T>(key: string): Promise<T | undefined> {
  return (await kv().get(key))?.value as T | undefined;
}

export async function setMaint(key: string, value: unknown): Promise<void> {
  await kv().put({ key, value });
}

export async function clearMaint(key: string): Promise<void> {
  await kv().delete(key);
}

/** Wipe every marker (tests / reset flows). */
export async function clearAllMaint(): Promise<void> {
  await kv().clear();
}

const DROP_PREFIX = 'drop:';

/** Queue an on-disk database name for deletion by the startup maintenance
 * pass — `workspace-<uid>` stores and the pre-uid 'workspace' legacy store. */
export async function markDatabaseForDeletion(name: string): Promise<void> {
  await setMaint(`${DROP_PREFIX}${name}`, Date.now());
}

export async function markStoreForDeletion(uid: string): Promise<void> {
  await markDatabaseForDeletion(`workspace-${uid}`);
}

/** Pending deletions as literal db names. */
export async function pendingStoreDrops(): Promise<string[]> {
  const rows = await kv().toArray();
  return rows.filter((r) => r.key.startsWith(DROP_PREFIX)).map((r) => r.key.slice(DROP_PREFIX.length));
}

/**
 * Explicitly-confirmed purge: attempt every queued drop — the ONLY caller is
 * the Settings "clear local data" flow after the user confirms irreversible
 * deletion (T2: nothing auto-deletes at login; a queued marker is intent,
 * never an in-flight request). The currently-active store is always skipped
 * (its marker stays). A blocked/failed delete also leaves the marker.
 * Never throws.
 */
export async function runConfirmedDrops(activeName: string | null): Promise<{ dropped: string[]; remaining: string[] }> {
  const dropped: string[] = [];
  const remaining: string[] = [];
  for (const name of await pendingStoreDrops()) {
    if (activeName && name === activeName) {
      remaining.push(name);
      continue;
    }
    try {
      // Probe first: a held store is skipped WITHOUT issuing deleteDatabase —
      // the armed-request problem (an uncancellable pending delete firing
      // later, e.g. after a re-adoption cleared the marker) is avoided by
      // only ever deleting stores proven unheld a moment ago. A connection
      // racing in the probe→delete gap can still arm one request; that
      // window is microseconds and deletion remains the confirmed intent.
      if (await isHeldElsewhere(name)) {
        remaining.push(name);
        continue;
      }
      await dropDatabaseByName(name);
      await clearMaint(`${DROP_PREFIX}${name}`);
      dropped.push(name);
    } catch {
      remaining.push(name); // blocked or failed — retry next purge
    }
  }
  return { dropped, remaining };
}
