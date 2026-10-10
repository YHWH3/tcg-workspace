import { authStore } from './auth';
import { mutate } from './sync/engine';
import { uuid } from './utils';

/** Append an activity record. Safe no-op when signed out. */
export function logActivity(
  verb: string,
  targetType: 'page' | 'task' | 'comment' | 'board' | 'file' | 'block' | 'mooditem',
  targetId: string,
  targetTitle: string,
  meta?: Record<string, unknown>,
): void {
  const user = authStore.get().user;
  if (!user) return;
  void mutate('activity', uuid(), {
    actorId: user.id,
    verb,
    targetType,
    targetId,
    targetTitle,
    meta: meta ?? null,
    createdAt: Date.now(),
  }).catch(() => {});
}

/* ---------- Phase 1: change sets (MCP writes) + undo ---------- */

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { toast } from './files';

export interface ChangesetRow {
  id: string;
  user_id: string;
  source?: string;
  client_name?: string | null;
  tool?: string | null;
  summary?: string | null;
  request_id?: string | null;
  undoes?: string | null;
  undone_by?: string | null;
  item_count: number;
  created_at: number;
}

/** Last N change sets authored through MCP connectors (`mine=1`). */
export function useChangesets(limit = 20) {
  const [rows, setRows] = useState<ChangesetRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<{ changesets: ChangesetRow[] }>('/api/changes?mine=1');
      setRows(r.changesets.slice(0, limit));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load changes');
      setRows([]);
    }
  }, [limit]);
  useEffect(() => {
    void load();
  }, [load]);
  return { rows, error, reload: load };
}

/** True when an activity entry came from an MCP connector write. */
export function isAIChange(meta: unknown): boolean {
  const m = meta as { via?: unknown; changesetId?: unknown } | null | undefined;
  return Boolean(m && (m.changesetId || m.via));
}

export async function undoChangeset(changesetId: string): Promise<{ restored: number; skipped: number } | null> {
  try {
    const r = await api<{ ok: boolean; restored: number; skipped: number }>(`/api/changes/${encodeURIComponent(changesetId)}/undo`, { method: 'POST' });
    toast(`Undone — ${r.restored} item${r.restored === 1 ? '' : 's'} restored${r.skipped ? `, ${r.skipped} skipped` : ''}`);
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    toast(msg.includes('409') || /already/i.test(msg) ? 'Already undone' : `Undo failed: ${msg}`, 'error');
    return null;
  }
}
