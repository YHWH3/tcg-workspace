/* Deferred local-store maintenance (review S2). Destructive IndexedDB deletes
 * never run inline: a deleteDatabase request cannot be cancelled once issued,
 * so reporting "aborted, data intact" while a live request pends is a lie —
 * the delete can still complete when the blocker closes. Instead a durable
 * marker is written and a controlled startup pass performs the delete with a
 * confirmed outcome; on blocked/failure the marker simply stays for the next
 * boot. The currently-active account's store is never deleted. */

import Dexie from 'dexie';
import { dropDatabaseByName } from './db';

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
 * Startup pass: attempt every queued drop. The currently-active store is
 * skipped (its marker stays — it was queued by a switch away, and re-adopting
 * the account reclaims the data). A blocked/failed delete leaves the marker
 * for the next boot. Never throws.
 */
export async function runDeferredDrops(activeName: string | null): Promise<{ dropped: string[]; remaining: string[] }> {
  const dropped: string[] = [];
  const remaining: string[] = [];
  for (const name of await pendingStoreDrops()) {
    if (activeName && name === activeName) {
      remaining.push(name);
      continue;
    }
    try {
      await dropDatabaseByName(name);
      await clearMaint(`${DROP_PREFIX}${name}`);
      dropped.push(name);
    } catch {
      remaining.push(name); // blocked or failed — retry next boot
    }
  }
  return { dropped, remaining };
}
