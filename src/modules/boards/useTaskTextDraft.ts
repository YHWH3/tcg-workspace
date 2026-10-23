import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { accessClientStore } from '../../core/accessClient';
import { logActivity } from '../../core/activity';
import { authStore } from '../../core/auth';
import { db } from '../../core/db';
import { loadDraft, saveDraftField } from '../../core/drafts';
import { useStore } from '../../core/store';
import { mutate } from '../../core/sync/engine';

/** Local durability starts in the input event, before an access recheck can
 * unmount the editor. Canonical records still use the ordinary mutation gate;
 * retained drafts never grant permission or overwrite a changed source. */
export function useTaskTextDraft(taskId: string, field: 'title' | 'description', source: string, baseTs: number, available: boolean) {
  const [value, setValue] = useState(source), [error, setError] = useState<string | null>(null);
  const latest = useRef(source), sourceRef = useRef(source), owner = useRef(authStore.get().user?.id);
  const dirty = useRef(false), focused = useRef(false), generation = useRef(0), creationNoted = useRef(false);
  sourceRef.current = source;
  const access = useStore(accessClientStore);
  const recovered = useLiveQuery(() => available ? loadDraft('tasks', taskId) : undefined, [taskId, available]);
  const sameOwner = () => !!owner.current && authStore.get().user?.id === owner.current;

  const persist = (next: string) => {
    if (!sameOwner() || !available) return;
    const attempt = ++generation.current, firstTitle = field === 'title' && !sourceRef.current && !!next;
    // The draft read/merge/write is one account-local transaction, including
    // both text fields' envelopes. Concurrent title/description saves cannot
    // replace each other's retained candidate. It contains no session tokens.
    const durable = db.transaction('rw', db.tasks, db.meta, () => {
      if (!sameOwner()) throw new Error('Account changed before draft save');
      return saveDraftField('tasks', taskId, field, next);
    });
    // Do not await a preliminary read before the normal authority precheck.
    // This writes local state/outbox now; the sync engine batches server work.
    const canonical = mutate('tasks', taskId, { [field]: next });
    void Promise.allSettled([durable, canonical]).then(([draftResult, recordResult]) => {
      if (!sameOwner()) return;
      if (recordResult.status === 'fulfilled') {
        if (attempt === generation.current) setError(null);
        if (firstTitle && !creationNoted.current) {
          creationNoted.current = true;
          logActivity('created', 'task', taskId, latest.current);
        }
      } else if (attempt === generation.current) {
        setError(draftResult.status === 'fulfilled' ? 'Text retained in a local draft. Retry when access is ready.' : 'Local save failed. Keep this view open and retry.');
      }
    });
  };
  const persistRef = useRef(persist);persistRef.current = persist;

  useEffect(() => {
    if (source === latest.current) dirty.current = false;
    if (dirty.current || focused.current) return;
    latest.current = source;
    setValue(source);
  }, [source]);

  useEffect(() => {
    const candidate = recovered?.values[field];
    if (!available || generation.current > 0 || typeof candidate !== 'string' || candidate === source) return;
    latest.current = candidate;dirty.current = true;setValue(candidate);
    if (recovered?.baseTs[field] !== baseTs) {
      setError('Recovered local draft differs from the saved text. Review it before retrying.');
      return;
    }
    if (access.status === 'ready' || access.status === 'offline') persistRef.current(candidate);
  }, [recovered, field, source, baseTs, available, access.status]);

  return {
    value, error,
    retry: () => persistRef.current(latest.current),
    focus: () => { focused.current = true; },
    change: (next: string) => {
      latest.current = next;dirty.current = true;setValue(next);persist(next);
    },
    blur: () => {
      focused.current = false;
      if (!dirty.current) { latest.current = sourceRef.current;setValue(sourceRef.current); }
    },
  };
}
