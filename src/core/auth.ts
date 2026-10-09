import type { PublicUser } from '../../shared/types';
import { api, ApiError, getToken } from './api';
import { createStore } from './store';
import { accountSwitchStore, runAccountSwitch, type SwitchDeps } from './accountSwitch';

interface AuthState {
  status: 'loading' | 'authed' | 'unauthed';
  user: PublicUser | null;
}

export const authStore = createStore<AuthState>({ status: 'loading', user: null });

function cachedUser(): PublicUser | null {
  try {
    const raw = localStorage.getItem('ws_user');
    return raw ? (JSON.parse(raw) as PublicUser) : null;
  } catch {
    return null;
  }
}

function cacheUser(user: PublicUser | null) {
  if (user) localStorage.setItem('ws_user', JSON.stringify(user));
  else localStorage.removeItem('ws_user');
}

/** Drop the session but keep all local data + outbox (e.g. on 401). */
export function dropSession() {
  localStorage.removeItem('ws_token');
  cacheUser(null);
  authStore.set({ status: 'unauthed', user: null });
}

/** Post-login maintenance: recover the pre-uid 'workspace' store (S1), then
 * run queued destructive deletes in the controlled pass (S2). Runs before the
 * sync engine starts so the migrated sync cursor/outbox are in place. */
async function postLoginMaintenance(uid: string) {
  try {
    const { migrateLegacyStore } = await import('./legacyMigration');
    await migrateLegacyStore(uid);
  } catch (e) {
    console.warn('legacy migration failed — will retry next sign-in', e);
  }
  try {
    const { runDeferredDrops, clearMaint } = await import('./maintenance');
    // Re-adopting this account rescues its store from the deletion queue —
    // the active connection would block any stray delete while the app is
    // open, but the marker must not linger.
    await clearMaint(`drop:workspace-${uid}`);
    await runDeferredDrops(`workspace-${uid}`);
  } catch (e) {
    console.warn('deferred drops failed — will retry next boot', e);
  }
}

export async function initAuth() {
  const token = getToken();
  const user = cachedUser();
  if (!token) {
    authStore.set({ status: 'unauthed', user: null });
    return;
  }
  // Optimistically authenticated so the app opens offline.
  authStore.set({ status: 'authed', user });
  try {
    const { user: fresh } = await api<{ user: PublicUser }>('/api/me');
    cacheUser(fresh);
    authStore.set({ status: 'authed', user: fresh });
    await postLoginMaintenance(fresh.id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) dropSession();
    else if (user) await postLoginMaintenance(user.id); // offline open — still migrate
  }
}

function applyIdentity(token: string, user: PublicUser) {
  localStorage.setItem('ws_token', token);
  localStorage.setItem('ws_uid', user.id);
  cacheUser(user);
}

const switchDeps: SwitchDeps = {
  // Full archive — outbox + drafts + pending/failed blob BYTES (R1).
  exportBackup: async (prevId) => {
    const { db } = await import('./db');
    const { buildLocalBackup, saveBackupFile } = await import('./localBackup');
    const { listDrafts } = await import('./drafts');
    return saveBackupFile(await buildLocalBackup(db, prevId, listDrafts));
  },
  closeLocal: async () => {
    const { db } = await import('./db');
    db.close();
  },
  markForDeletion: async (prevId) => {
    const { markStoreForDeletion } = await import('./maintenance');
    await markStoreForDeletion(prevId);
  },
  commitIdentity: (userId, token, user) => applyIdentity(token, { ...user, id: userId }),
  revokeToken: async (token) => {
    await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
  },
  reload: () => location.reload(),
};

/** Dialog button handler — resolves the pending account-switch decision. */
export async function resolveAccountSwitch(choice: 'cancel' | 'keep' | 'keep-confirmed' | 'destroy') {
  const d = accountSwitchStore.get();
  if (!d) return;
  await runAccountSwitch(choice, d, switchDeps);
}

async function finishLogin(token: string, user: PublicUser) {
  const prevId = localStorage.getItem('ws_uid');
  if (prevId && prevId !== user.id) {
    // Account switch on this device: if the previous account has unacknowledged
    // local data (outbox, uploads, drafts), block on an explicit choice — never
    // a silent wipe (§12.3, review B4). ws_uid/token stay untouched until then
    // so a stale tab still writing under the old identity is caught.
    const { countLocalPending } = await import('./sync/engine');
    const pending = await countLocalPending();
    if (pending.records + pending.media + pending.drafts > 0) {
      accountSwitchStore.set({ prevId, newUser: user, token, pending });
      return;
    }
    // Nothing unacknowledged: isolation-first — close A's store BEFORE B's
    // identity commits (R3); A's per-account database stays quarantined on
    // disk, B opens workspace-<B> after reload.
    const { db } = await import('./db');
    db.close();
    applyIdentity(token, user);
    location.reload();
    return;
  }
  applyIdentity(token, user);
  // Reload so the Dexie store reopens under this account's name (per-uid
  // databases, R3) — module init reads ws_uid once.
  const { db } = await import('./db');
  if (db.name !== `workspace-${user.id}`) {
    db.close();
    location.reload();
    return;
  }
  authStore.set({ status: 'authed', user });
}

export async function signUp(input: { username: string; name: string; password: string; inviteCode?: string }) {
  const res = await api<{ token: string; user: PublicUser }>('/api/auth/signup', { method: 'POST', body: input });
  await finishLogin(res.token, res.user);
}

export async function signIn(input: { username: string; password: string }) {
  const res = await api<{ token: string; user: PublicUser }>('/api/auth/login', { method: 'POST', body: input });
  await finishLogin(res.token, res.user);
}

export async function signOut() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* offline is fine */
  }
  dropSession();
}

export async function updateMe(patch: { name?: string; color?: string }) {
  const { user } = await api<{ user: PublicUser }>('/api/me', { method: 'PATCH', body: patch });
  cacheUser(user);
  authStore.set({ status: 'authed', user });
}

export async function changePassword(current: string, next: string) {
  await api('/api/me/password', { method: 'POST', body: { current, next } });
}
