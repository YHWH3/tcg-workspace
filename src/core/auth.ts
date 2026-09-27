import type { PublicUser } from '../../shared/types';
import { api, ApiError, getToken } from './api';
import { createStore } from './store';

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

async function finishLogin(token: string, user: PublicUser) {
  const prevId = localStorage.getItem('ws_uid');
  localStorage.setItem('ws_token', token);
  cacheUser(user);
  if (prevId && prevId !== user.id) {
    // Different user on this device: wipe local DB (including outbox), then reload clean.
    localStorage.setItem('ws_uid', user.id);
    const { db } = await import('./db');
    db.close();
    await db.delete();
    location.reload();
    return;
  }
  localStorage.setItem('ws_uid', user.id);
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
