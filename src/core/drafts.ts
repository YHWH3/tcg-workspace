/* Durable account-owned local drafts (Phase 1 §12.1, platform spec §7).
 *
 * A draft envelope lives in the existing Dexie `meta` table under
 * `draft:<userId>:<collection>:<id>` so uncommitted editor/capture values
 * survive reload, offline reopen and OS suspension — in-memory React state
 * and debounces are NOT durable saves. Envelopes carry candidate values plus
 * the field timestamps they diverged from (base) and never contain tokens.
 * Canonical records still write only via mutate(); a draft is cleared per
 * field once pull reconciliation sees the canonical value equal the
 * candidate — a pushed-then-deleted outbox entry alone is not proof the
 * field won LWW.
 *
 * Keep envelopes small: reference pending file bytes by file id (see
 * `blobs`), never embed blob data into meta.
 */

import { useCallback, useEffect, useState } from 'react';
import { stableJson } from '../../shared/stablejson';
import type { Collection } from '../../shared/collections';
import { authStore } from './auth';
import { db, getMeta, setMeta } from './db';

export interface DraftEnvelope {
  v: 1;
  /** Owning account — drafts never leak across sign-in identities. */
  userId: string;
  collection: Collection;
  id: string;
  /** Candidate field values not yet confirmed as canonical. */
  values: Record<string, unknown>;
  /** Canonical field timestamp each value diverged from (review aid). */
  baseTs: Record<string, number>;
  updatedAt: number;
  /** 'edit' = unsent editor input; 'undo-conflict' = inverse preserved for review. */
  source: 'edit' | 'undo-conflict';
}

export function draftKey(userId: string, collection: string, id: string): string {
  return `draft:${userId}:${collection}:${id}`;
}

function currentUserId(): string | undefined {
  return authStore.get().user?.id;
}

function eqValue(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return stableJson(a) === stableJson(b);
}

/**
 * Merge `values` into the draft envelope for (collection, id). Fields already
 * equal to the canonical row are dropped instead of stored — a draft only
 * holds what hasn't been confirmed. Returns the stored envelope, or
 * undefined when nothing needed persisting (or no signed-in user).
 */
export async function saveDraft(
  collection: Collection,
  id: string,
  values: Record<string, unknown>,
  opts?: { source?: DraftEnvelope['source'] },
): Promise<DraftEnvelope | undefined> {
  const userId = currentUserId();
  if (!userId) return undefined;
  const key = draftKey(userId, collection, id);
  const row = await db.collection(collection).get(id);
  const prev = await getMeta<DraftEnvelope>(key);
  const out = { ...(prev?.values ?? {}) };
  const baseTs = { ...(prev?.baseTs ?? {}) };
  let dirty = false;
  for (const [f, v] of Object.entries(values)) {
    if (row && eqValue(row[f], v)) {
      // Candidate already matches the canonical record — nothing to recover.
      if (f in out) {
        delete out[f];
        delete baseTs[f];
        dirty = true;
      }
      continue;
    }
    if (!(f in out) || !eqValue(out[f], v)) {
      out[f] = v;
      dirty = true;
    }
    if (!(f in baseTs)) baseTs[f] = (row?._ts as Record<string, number> | undefined)?.[f] ?? 0;
  }
  if (!Object.keys(out).length) {
    if (prev) await db.meta.delete(key);
    return undefined;
  }
  if (!dirty && prev) return prev;
  const env: DraftEnvelope = {
    v: 1,
    userId,
    collection,
    id,
    values: out,
    baseTs,
    updatedAt: Date.now(),
    source: opts?.source ?? prev?.source ?? 'edit',
  };
  await setMeta(key, env);
  return env;
}

/** Convenience for single-field text editing. */
export function saveDraftField(collection: Collection, id: string, field: string, value: unknown): Promise<DraftEnvelope | undefined> {
  return saveDraft(collection, id, { [field]: value });
}

/** Load the current user's draft for a record (undefined when none). */
export async function loadDraft(collection: Collection, id: string): Promise<DraftEnvelope | undefined> {
  const userId = currentUserId();
  if (!userId) return undefined;
  const env = await getMeta<DraftEnvelope>(draftKey(userId, collection, id));
  return env?.userId === userId && Object.keys(env.values).length ? env : undefined;
}

export async function clearDraft(collection: Collection, id: string): Promise<void> {
  const userId = currentUserId();
  if (!userId) return;
  await db.meta.delete(draftKey(userId, collection, id));
}

/** Drop specific fields from a draft (e.g. fields just committed via mutate). */
export async function clearDraftFields(collection: Collection, id: string, fields: string[]): Promise<void> {
  const userId = currentUserId();
  if (!userId) return;
  const key = draftKey(userId, collection, id);
  const env = await getMeta<DraftEnvelope>(key);
  if (!env) return;
  const values = { ...env.values };
  const baseTs = { ...env.baseTs };
  for (const f of fields) {
    delete values[f];
    delete baseTs[f];
  }
  if (Object.keys(values).length) await setMeta(key, { ...env, values, baseTs });
  else await db.meta.delete(key);
}

/** All draft envelopes owned by `userId` (default: current session user). */
export async function listDrafts(userId = currentUserId()): Promise<DraftEnvelope[]> {
  if (!userId) return [];
  const rows = await db.meta.where('key').startsWith(`draft:${userId}:`).toArray();
  return rows.map((r) => r.value as DraftEnvelope).filter((e) => e?.userId === userId);
}

export async function countDrafts(userId = currentUserId()): Promise<number> {
  if (!userId) return 0;
  return db.meta.where('key').startsWith(`draft:${userId}:`).count();
}

/**
 * Reconcile drafts against a freshly pulled/rebased record (called inside the
 * pull transaction). A candidate field is dropped once the canonical value
 * equals it — confirmed save. A field the remote/other replica won keeps its
 * candidate so the user can review, compare or reapply (via mutate with fresh
 * timestamps) instead of losing the edit silently.
 */
export async function reconcileDraft(
  collection: Collection,
  id: string,
  data: Record<string, unknown>,
  _fieldTs: Record<string, number>,
): Promise<void> {
  const userId = currentUserId();
  if (!userId) return;
  const key = draftKey(userId, collection, id);
  const env = await getMeta<DraftEnvelope>(key);
  if (!env) return;
  const values = { ...env.values };
  const baseTs = { ...env.baseTs };
  for (const f of Object.keys(env.values)) {
    if (eqValue(data[f], env.values[f])) {
      delete values[f];
      delete baseTs[f];
    }
  }
  if (Object.keys(values).length) await setMeta(key, { ...env, values, baseTs });
  else await db.meta.delete(key);
}

/**
 * React helper for editors: loads the durable draft on mount and exposes
 * save/clear. Editors call `save` on input (their own debounce may batch)
 * and `clear` after an acknowledged local commit they don't need to recover.
 */
export function useDraft(collection: Collection, id: string | undefined): {
  draft: DraftEnvelope | undefined;
  save: (values: Record<string, unknown>) => Promise<void>;
  clear: () => Promise<void>;
} {
  const [draft, setDraft] = useState<DraftEnvelope | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setDraft(undefined);
    if (id) void loadDraft(collection, id).then((d) => live && setDraft(d));
    return () => {
      live = false;
    };
  }, [collection, id]);
  const save = useCallback(
    async (values: Record<string, unknown>) => {
      if (!id) return;
      setDraft(await saveDraft(collection, id, values));
    },
    [collection, id],
  );
  const clear = useCallback(async () => {
    if (!id) return;
    await clearDraft(collection, id);
    setDraft(undefined);
  }, [collection, id]);
  return { draft, save, clear };
}

/* ---------- origin storage (quota/persistence, platform spec §3/§7) ------- */

export interface StorageReport {
  supported: boolean;
  persisted?: boolean;
  usage?: number;
  quota?: number;
}

export async function storageReport(): Promise<StorageReport> {
  const sm = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!sm?.estimate) return { supported: false };
  try {
    const est = await sm.estimate();
    const persisted = sm.persisted ? await sm.persisted() : undefined;
    return { supported: true, persisted, usage: est.usage, quota: est.quota };
  } catch {
    return { supported: false };
  }
}

/**
 * Ask the browser for persistent storage (best effort — denial is nonfatal).
 * Called after real storage use (first successful sync), not at bare load.
 */
export async function ensurePersistentStorage(): Promise<boolean> {
  const sm = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!sm?.persist) return false;
  try {
    return await sm.persist();
  } catch {
    return false;
  }
}
