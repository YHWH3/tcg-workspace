import { describe, it, expect, vi } from 'vitest';
import { runAccountSwitch, assertSameAccount, accountSwitchStore, type SwitchDecision, type SwitchDeps } from '../src/core/accountSwitch';

/* Review B4 — deterministic coverage of every account-switch branch without
 * IndexedDB: deps are injected, call ORDER is asserted so 'keep' can never
 * wipe before exporting, and 'cancel' can never touch identity or storage. */

const decision: SwitchDecision = {
  prevId: 'user-A',
  newUser: { id: 'user-B', username: 'b', name: 'B', color: '#000', role: 'member', createdAt: 0 } as SwitchDecision['newUser'],
  token: 'tok-B',
  pending: { records: 2, media: 1, drafts: 1 },
};

function makeDeps() {
  const calls: string[] = [];
  const deps: SwitchDeps = {
    exportBackup: vi.fn(async () => void calls.push('export')),
    wipeLocal: vi.fn(async () => void calls.push('wipe')),
    commitIdentity: vi.fn(() => void calls.push('commit')),
    revokeToken: vi.fn(async () => void calls.push('revoke')),
    reload: vi.fn(() => void calls.push('reload')),
  };
  return { deps, calls };
}

describe('account switch data-loss protection (review B4)', () => {
  it('cancel: identity and local data untouched, new token revoked', async () => {
    const { deps, calls } = makeDeps();
    accountSwitchStore.set(decision);
    const out = await runAccountSwitch('cancel', decision, deps);
    expect(out).toBe('cancel');
    expect(calls).toEqual(['revoke']); // nothing else ran
    expect(deps.wipeLocal).not.toHaveBeenCalled();
    expect(deps.commitIdentity).not.toHaveBeenCalled();
    expect(accountSwitchStore.get()).toBeNull(); // decision resolved
  });

  it('keep: export runs BEFORE wipe, then identity commits and reloads', async () => {
    const { deps, calls } = makeDeps();
    accountSwitchStore.set(decision);
    const out = await runAccountSwitch('keep', decision, deps);
    expect(out).toBe('keep');
    // Order is the contract: backup → commit → wipe → reload.
    expect(calls).toEqual(['export', 'commit', 'wipe', 'reload']);
    expect(deps.exportBackup).toHaveBeenCalledWith('user-A');
    expect(deps.commitIdentity).toHaveBeenCalledWith('user-B', 'tok-B', decision.newUser);
  });

  it('destroy: explicit destructive switch — no export, wipe + commit', async () => {
    const { deps, calls } = makeDeps();
    accountSwitchStore.set(decision);
    await runAccountSwitch('destroy', decision, deps);
    expect(calls).toEqual(['commit', 'wipe', 'reload']);
    expect(deps.exportBackup).not.toHaveBeenCalled();
  });

  it('failed export aborts the switch: nothing wiped, decision stays open', async () => {
    const { deps, calls } = makeDeps();
    deps.exportBackup = vi.fn(async () => {
      calls.push('export');
      throw new Error('download blocked');
    });
    accountSwitchStore.set(decision);
    await expect(runAccountSwitch('keep', decision, deps)).rejects.toThrow('download blocked');
    expect(calls).toEqual(['export']); // nothing else ran
    expect(deps.wipeLocal).not.toHaveBeenCalled();
    expect(deps.commitIdentity).not.toHaveBeenCalled();
    expect(accountSwitchStore.get()).not.toBeNull(); // still open — retryable
  });

  it('stale-tab guard: writes refuse once the device identity moved', () => {
    // Tab booted as A; ws_uid now B → refuse.
    expect(() => assertSameAccount('user-A', 'user-B')).toThrow(/reload this tab/);
    // Session dropped entirely → also refuse (no writes under no identity).
    expect(() => assertSameAccount('user-A', null)).toThrow(/reload this tab/);
    // Same identity → allowed.
    expect(() => assertSameAccount('user-A', 'user-A')).not.toThrow();
    // Tab was never signed in → nothing to guard.
    expect(() => assertSameAccount(null, 'user-B')).not.toThrow();
  });
});
