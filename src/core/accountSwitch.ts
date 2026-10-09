/* Account-switch protection (§12.3, review B4). finishLogin must never
 * silently erase a previous account's unacknowledged local data — unsent
 * outbox writes, pending/failed uploads, unsent drafts. When the new login's
 * identity differs from the device's, the counts are surfaced through a
 * blocking dialog and NOTHING about the device identity is committed until
 * the user chooses. `ws_uid` only moves after the decision so a sibling tab
 * still writing under the old identity is caught by assertSameAccount. */

import type { PublicUser } from '../../shared/types';
import { createStore } from './store';

export interface PendingCounts {
  records: number;
  media: number;
  drafts: number;
}

export interface SwitchDecision {
  /** Local account id being replaced. */
  prevId: string;
  /** Freshly authenticated account. */
  newUser: PublicUser;
  /** Session token for newUser — NOT stored until the user decides. */
  token: string;
  pending: PendingCounts;
}

/** Non-null → the app renders the blocking switch dialog over everything. */
export const accountSwitchStore = createStore<SwitchDecision | null>(null);

export type SwitchChoice = 'cancel' | 'keep' | 'destroy';

export interface SwitchDeps {
  /** Serialize the previous account's local-only data to a downloadable file. */
  exportBackup(prevId: string): Promise<void>;
  /** Wipe the local database. */
  wipeLocal(): Promise<void>;
  /** Persist the new identity (ws_token, ws_user, ws_uid). */
  commitIdentity(userId: string, token: string, user: PublicUser): void;
  /** Best-effort server logout for a token we never stored. */
  revokeToken(token: string): Promise<void>;
  reload(): void;
}

/**
 * Resolve the switch decision. 'keep' exports a backup BEFORE wiping; a failed
 * export aborts the switch and leaves the dialog open so nothing is lost.
 * 'cancel' discards the new session server-side and keeps everything local.
 */
export async function runAccountSwitch(choice: SwitchChoice, d: SwitchDecision, deps: SwitchDeps): Promise<SwitchChoice> {
  if (choice === 'cancel') {
    accountSwitchStore.set(null);
    await deps.revokeToken(d.token).catch(() => undefined);
    return 'cancel';
  }
  if (choice === 'keep') {
    try {
      await deps.exportBackup(d.prevId);
    } catch (e) {
      // Export failed → stay open; wipe/commit haven't run.
      throw e;
    }
  }
  accountSwitchStore.set(null);
  deps.commitIdentity(d.newUser.id, d.token, d.newUser);
  await deps.wipeLocal();
  deps.reload();
  return choice;
}

/**
 * A tab writes under the identity it booted with. If the device uid moved on
 * (a sibling tab completed an account switch — or the session was dropped),
 * refuse the write instead of landing it under the new identity.
 */
export function assertSameAccount(tabUid: string | null, currentUid: string | null): void {
  if (tabUid && currentUid !== tabUid) throw new Error('the signed-in account changed on this device — reload this tab before writing');
}
