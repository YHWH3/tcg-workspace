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
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) dropSession();
  }
}

function applyIdentity(token: string, user: PublicUser) {
  localStorage.setItem('ws_token', token);
  localStorage.setItem('ws_uid', user.id);
  cacheUser(user);
}

/** Serialize the previous account's local-only data (outbox + drafts + pending
 * blob metadata) to a downloadable JSON file (§12.3 'keep' choice). */
async function exportLocalBackup(prevId: string): Promise<void> {
  const { db } = await import('./db');
  const { listDrafts } = await import('./drafts');
  const [outbox, drafts, blobs] = await Promise.all([
    db.outbox.toArray(),
    listDrafts(prevId),
    db.blobs.where('state').anyOf('pending', 'failed').toArray(),
  ]);
  const payload = {
    exportedAt: Date.now(),
    userId: prevId,
    outbox: outbox.map(({ autoId: _autoId, ...e }) => e),
    drafts,
    // Blob bytes stay behind — listed so nothing is silently forgotten.
    blobs: blobs.map((b) => ({ id: b.id, mime: b.mime ?? null, state: b.state, error: b.error ?? null })),
  };
  const file = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = `workspace-backup-${prevId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

const switchDeps: SwitchDeps = {
  exportBackup: exportLocalBackup,
  wipeLocal: async () => {
    const { db } = await import('./db');
    db.close();
    await db.delete();
  },
  commitIdentity: (userId, token, user) => applyIdentity(token, { ...user, id: userId }),
  revokeToken: async (token) => {
    await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
  },
  reload: () => location.reload(),
};

/** Dialog button handler — resolves the pending account-switch decision. */
export async function resolveAccountSwitch(choice: 'cancel' | 'keep' | 'destroy') {
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
    // Nothing pending: the switch is harmless — wipe for a clean slate anyway.
    applyIdentity(token, user);
    const { db } = await import('./db');
    db.close();
    await db.delete();
    location.reload();
    return;
  }
  applyIdentity(token, user);
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
