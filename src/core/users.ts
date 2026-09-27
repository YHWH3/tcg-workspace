import { useLiveQuery } from 'dexie-react-hooks';
import type { PublicUser } from '../../shared/types';
import { db } from './db';

export function useUsers(): PublicUser[] {
  return useLiveQuery(() => db.users.orderBy('id').toArray(), [], []) ?? [];
}

export function useUser(id: string | undefined | null): PublicUser | undefined {
  const users = useUsers();
  return id ? users.find((u) => u.id === id) : undefined;
}
