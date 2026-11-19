import { useLiveQuery } from 'dexie-react-hooks';
import { authStore } from './auth';
import { db } from './db';
import {useStore} from './store';
import {accessClientStore} from './accessClient';
import { renderPlain } from './mentions';
import { resolveUser, useUsers } from './users';

/** Resolver for `@[page:ID]` / `@[user:ID]` tokens against local data. */
export function useTokenResolver(): (kind: string, id: string) => string {
  const users = useUsers();
  const access = useStore(accessClientStore);
  const spaces = (access.status === 'ready' || access.status === 'offline') && access.manifest?.protocol === 3 ? access.manifest.spaces : [];
  const me = authStore.get().user;
  const pages = useLiveQuery(() => db.pages.toArray(), [], []) ?? [];
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []) ?? [];
  return (kind, id) => {
    if (kind === 'group') return spaces.find(space => space.id === id)?.name ?? 'Unavailable Space';
    if (kind === 'page') return String(pages.find((p) => p.id === id)?.title ?? 'Untitled');
    if (kind === 'rec') return String(tasks.find((t) => t.id === id)?.title ?? 'Record');
    return resolveUser(id, users, me)?.name ?? 'Someone';
  };
}

/** Plain-text version of a string that may contain mention tokens. */
export function usePlainText(text: string): string {
  const resolve = useTokenResolver();
  return renderPlain(text, resolve);
}
