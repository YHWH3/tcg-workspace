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
