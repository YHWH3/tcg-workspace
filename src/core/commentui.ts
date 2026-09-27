import { createStore } from './store';

/**
 * Which block / mood-item comment thread is open. Shared at core level so any
 * UI (block "…" menu, comment badge, mood item menu) can open the thread
 * without module-to-module imports.
 */
export const commentTargetStore = createStore<string | null>(null);
export function openCommentThread(targetId: string): void {
  commentTargetStore.set(targetId);
}
