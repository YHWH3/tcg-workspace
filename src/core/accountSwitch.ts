/* Account-switch protection (§12.3, reviews B4 + R1/R2/R3). finishLogin must
 * never silently erase a previous account's unacknowledged local data —
 * unsent outbox writes (ANY state, including server-rejected), pending/failed
 * uploads, unsent drafts. The blocking dialog lists the counts and NOTHING
 * about the device identity is committed until the user chooses:
 *
 *   cancel  → revoke the new token; local data + identity untouched
 *   keep    → FULL backup (blob bytes included) saved + verified/confirmed,
 *             then the old store is closed and B's identity commits. With
 *             per-account databases the old store stays quarantined on disk.
 *   destroy → old account's database is deleted FIRST, and only if that
 *             succeeds is B's identity committed; a blocked delete aborts
 *             the switch with A fully intact.
 *
 * `ws_uid` only moves after the decision so a sibling tab still writing under
 * the old identity is caught by assertSameAccount. */

import type { PublicUser } from '../../shared/types';
import { createStore } from './store';

export interface PendingCounts {
  /** All unacknowledged outbox rows (pending + rejected + any other state). */
  records: number;
  /** Of `records`, how many were server-rejected (kept locally per B5). */
  rejected: number;
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
  /** Set once a backup archive has been produced in this session. */
  backup?: 'verified' | 'downloaded-unconfirmed';
}

/** Non-null → the app renders the blocking switch dialog over everything. */
export const accountSwitchStore = createStore<SwitchDecision | null>(null);

export type SwitchChoice = 'cancel' | 'keep' | 'keep-confirmed' | 'destroy';

export interface SwitchDeps {
  /** Build + save the full archive (blob bytes included). 'verified' means a
   * confirmed write (FS Access API); 'clicked' means the download was
   * triggered but cannot be verified — requires an explicit user confirm. */
  exportBackup(prevId: string): Promise<'verified' | 'clicked'>;
  /** Close the current local DB connection (never throws). */
  closeLocal(): Promise<void>;
  /** Delete the previous account's on-disk store; rejects when blocked. */
  dropLocal(prevId: string): Promise<void>;
  /** Persist the new identity (ws_token, ws_user, ws_uid). */
  commitIdentity(userId: string, token: string, user: PublicUser): void;
  /** Best-effort server logout for a token we never stored. */
  revokeToken(token: string): Promise<void>;
  reload(): void;
}

async function finishSwitch(d: SwitchDecision, deps: SwitchDeps): Promise<void> {
  // Isolation-first (R3): the old store is closed/removed BEFORE B's identity
  // commits — a failure here must leave A's session and data fully intact.
  await deps.closeLocal();
  accountSwitchStore.set(null);
  deps.commitIdentity(d.newUser.id, d.token, d.newUser);
  deps.reload();
}

/**
 * Resolve the switch decision.
 *  - 'keep' produces the archive; 'clicked' saves surface as a confirm step —
 *    the identity is NOT committed until the user sends 'keep-confirmed'.
 *  - 'destroy' deletes A's store BEFORE committing B; a blocked delete
 *    propagates and aborts, leaving A's identity/data untouched.
 */
export async function runAccountSwitch(choice: SwitchChoice, d: SwitchDecision, deps: SwitchDeps): Promise<SwitchChoice> {
  if (choice === 'cancel') {
    accountSwitchStore.set(null);
    await deps.revokeToken(d.token).catch(() => undefined);
    return 'cancel';
  }
  if (choice === 'keep') {
    if (d.backup !== 'verified' && d.backup !== 'downloaded-unconfirmed') {
      const how = await deps.exportBackup(d.prevId);
      if (how === 'clicked') {
        // Download triggered, not verifiable — require explicit confirmation.
        accountSwitchStore.set({ ...d, backup: 'downloaded-unconfirmed' });
        return 'keep';
      }
      accountSwitchStore.set({ ...d, backup: 'verified' });
    }
    await finishSwitch(d, deps);
    return 'keep';
  }
  if (choice === 'keep-confirmed') {
    if (!d.backup) throw new Error('no backup was produced yet');
    await finishSwitch(d, deps);
    return 'keep';
  }
  // destroy: explicit destructive switch — delete A's store first; commit B
  // only if that fully succeeds.
  accountSwitchStore.set(null);
  await deps.closeLocal();
  await deps.dropLocal(d.prevId);
  deps.commitIdentity(d.newUser.id, d.token, d.newUser);
  deps.reload();
  return 'destroy';
}

/**
 * A tab writes under the identity it booted with. If the device uid moved on
 * (a sibling tab completed an account switch — or the session was dropped),
 * refuse the write instead of landing it under the new identity.
 */
export function assertSameAccount(tabUid: string | null, currentUid: string | null): void {
  if (tabUid && currentUid !== tabUid) throw new Error('the signed-in account changed on this device — reload this tab before writing');
}
