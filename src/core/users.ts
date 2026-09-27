import { useLiveQuery } from 'dexie-react-hooks';
import type { PublicUser } from '../../shared/types';
import { authStore } from './auth';
import { db } from './db';
import { useStore } from './store';

export function useUsers(): PublicUser[] {
  return useLiveQuery(() => db.users.orderBy('id').toArray(), [], []) ?? [];
}

/**
 * Resolve a user by id: Dexie cache first, then the signed-in user as a
 * fallback (the cache may lag right after login).
 */
export function resolveUser(id: string | null | undefined, users: PublicUser[], me: PublicUser | null): PublicUser | undefined {
  if (!id) return undefined;
  return users.find((u) => u.id === id) ?? (me && me.id === id ? me : undefined);
}

export function useResolvedUser(id: string | undefined | null): PublicUser | undefined {
  const users = useUsers();
  const me = useStore(authStore).user;
  return resolveUser(id, users, me);
}
