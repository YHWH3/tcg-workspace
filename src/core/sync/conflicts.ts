/** Device-local recovery, never a synced collection or an authorization grant. */
import type {Collection} from '../../../shared/collections';
import {stableJson} from '../../../shared/stablejson';
import type {StoredRecord} from '../../../shared/types';
import {validMutationGuard, type MutationGuard} from '../../../shared/mutationGuard';
import type {LocalDB, OutboxEntry} from '../db';
import type {PendingChange} from './rebase';

export const CONFLICT_LIMIT = 200;
export const CONFLICT_RETENTION = 14 * 24 * 60 * 60 * 1000;
export interface Candidate {field: string; mine: unknown; mineTs: number; at: number}
export interface Conflict extends Candidate {theirs: unknown; theirsTs: number; theirsBy: null; token: string}
export interface ConflictEnvelope {id: string; collection: Collection; entries: Conflict[]}
interface Candidates {id: string; collection: Collection; entries: Candidate[]}
export const conflictKey = (id: string) => `conflicts:${id}`;
const candidateKey = (id: string) => `sync-candidates:${id}`;
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

/** Reused by pending and acknowledged paths. Guarded/refused changes already
 * have a separate recovery surface and must not become ordinary LWW conflicts. */
export function losingFields(server: StoredRecord, candidates: Candidate[], pending: PendingChange[], now: number): Conflict[] {
  const latest = new Map(candidates.map(entry => [entry.field, entry]));
  for (const change of pending) {
    if (change.ts <= 1 || change.ifUnchanged || change.state === 'rejected') continue;
    for (const [field, mine] of Object.entries(change.patch)) {
      if (change.ts >= (latest.get(field)?.mineTs ?? -Infinity)) latest.set(field, {field, mine, mineTs: change.ts, at: now});
    }
  }
  return [...latest.values()].filter(entry => entry.at > now - CONFLICT_RETENTION
    && (server.field_ts[entry.field] ?? -Infinity) >= entry.mineTs && !same(entry.mine, server.data[entry.field]))
    .map(entry => ({...entry, theirs: server.data[entry.field], theirsTs: server.field_ts[entry.field], theirsBy: null, token: crypto.randomUUID()}));
}

/** Call inside the queue-acknowledgement transaction, before deleting entries. */
export async function retainAcknowledged(store: LocalDB, entries: OutboxEntry[], now = Date.now()) {
  const groups = new Map<string, OutboxEntry[]>();
  for (const entry of entries) if (entry.ts > 1 && !entry.ifUnchanged && entry.state !== 'rejected') groups.set(entry.id, [...(groups.get(entry.id) ?? []), entry]);
  for (const [id, group] of groups) {
    const key = candidateKey(id), old = (await store.meta.get(key))?.value as Candidates | undefined;
    const fields = new Map((old?.entries ?? []).map(entry => [entry.field, entry]));
    for (const entry of group) for (const [field, mine] of Object.entries(entry.patch)) {
      if (entry.ts >= (fields.get(field)?.mineTs ?? -Infinity)) fields.set(field, {field, mine, mineTs: entry.ts, at: now});
    }
    await store.meta.put({key, value: {id, collection: group[0].collection, entries: [...fields.values()]}});
  }
  await pruneRecovery(store, now);
}

/** Must share the pull transaction with the winning record and cursor. */
export async function observeConflicts(store: LocalDB, collection: Collection, id: string, server: StoredRecord, pending: PendingChange[], now = Date.now()) {
  const candidate = (await store.meta.get(candidateKey(id)))?.value as Candidates | undefined;
  const key = conflictKey(id), old = (await store.meta.get(key))?.value as ConflictEnvelope | undefined;
  const lost = losingFields(server, candidate?.entries ?? [], pending, now);
  const remaining = (candidate?.entries ?? []).filter(entry => entry.at > now - CONFLICT_RETENTION && (server.field_ts[entry.field] ?? -Infinity) < entry.mineTs);
  if (remaining.length) await store.meta.put({key: candidateKey(id), value: {...candidate!, entries: remaining}});
  else await store.meta.delete(candidateKey(id));
  const fields = new Map((old?.entries ?? []).filter(entry => entry.at > now - CONFLICT_RETENTION).map(entry => [entry.field, entry]));
  for (const entry of lost) {
    const previous = fields.get(entry.field);
    // Repeated feeds must not reset age or invalidate an unchanged review.
    if (!previous || previous.mineTs !== entry.mineTs || !same(previous.mine, entry.mine) || previous.theirsTs !== entry.theirsTs || !same(previous.theirs, entry.theirs)) fields.set(entry.field, entry);
  }
  // Refresh the server side of an unresolved conflict, including its token.
  for (const [field, entry] of fields) {
    const remoteTs = server.field_ts[field] ?? -Infinity;
    if (remoteTs >= entry.mineTs && same(entry.mine, server.data[field])) fields.delete(field);
    else if (remoteTs > entry.theirsTs) fields.set(field, {...entry, theirs: server.data[field], theirsTs: remoteTs, token: crypto.randomUUID()});
  }
  if (fields.size) await store.meta.put({key, value: {id, collection, entries: [...fields.values()]}});
  else await store.meta.delete(key);
}

/** Prefix scans touch only bounded recovery metadata, never whole collections. */
export async function pruneRecovery(store: LocalDB, now = Date.now()) {
  for (const prefix of ['conflicts:', 'sync-candidates:']) {
    const rows = await store.meta.where('key').startsWith(prefix).toArray();
    const entries = rows.flatMap(row => ((row.value as Candidates).entries).map(entry => ({key: row.key, entry})))
      .filter(({entry}) => entry.at > now - CONFLICT_RETENTION).sort((a, b) => b.entry.at - a.entry.at).slice(0, CONFLICT_LIMIT);
    const keep = new Map<string, Candidate[]>();
    for (const {key, entry} of entries) keep.set(key, [...(keep.get(key) ?? []), entry]);
    for (const row of rows) {
      const retained = keep.get(row.key);
      if (!retained?.length) await store.meta.delete(row.key);
      else if (retained.length !== (row.value as Candidates).entries.length) await store.meta.put({key: row.key, value: {...row.value as Candidates, entries: retained}});
    }
  }
}

export async function clearRecovery(store: LocalDB, ids: Iterable<string>) {
  await store.meta.bulkDelete([...ids].flatMap(id => [conflictKey(id), candidateKey(id)]));
}

export async function resolveConflict(store: LocalDB, envelope: ConflictEnvelope, entry: Conflict, action: 'mine' | 'dismiss', assertCurrent: () => void,
  write: (collection: Collection, id: string, patch: Record<string, unknown>, guard: MutationGuard) => Promise<void>, now = Date.now()) {
  await store.transaction('rw', store.tables, async () => {
    assertCurrent();
    const key = conflictKey(envelope.id), current = (await store.meta.get(key))?.value as ConflictEnvelope | undefined;
    const found = current?.entries.find(value => value.field === entry.field && value.token === entry.token);
    if (!found || found.at <= now - CONFLICT_RETENTION || current!.collection !== envelope.collection) throw new Error('This review changed. Reopen it before continuing.');
    const row = await store.collection(envelope.collection).get(envelope.id);
    if (!row || row.deleted) throw new Error('This record is unavailable. Check access before continuing.');
    if (action === 'mine') {
      if (row._ts[entry.field] !== entry.theirsTs || !same(row[entry.field], entry.theirs)) throw new Error('This field changed. Sync and review it again.');
      const guard = {fields: {[entry.field]: entry.theirs}};
      if (!validMutationGuard(guard)) throw new Error('This server value is too large for guarded recovery. Copy your retained value and edit the field directly.');
      await write(envelope.collection, envelope.id, {[entry.field]: entry.mine}, guard);
    }
    assertCurrent();
    const remaining = current!.entries.filter(value => value.token !== entry.token);
    if (remaining.length) await store.meta.put({key, value: {...current!, entries: remaining}});
    else await store.meta.delete(key);
  });
}
