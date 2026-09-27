import { useMemo } from 'react';
import { authStore } from './auth';
import { liveStore, type PresenceUser } from './live';
import { useStore } from './store';
import { Avatar } from './ui';
import { resolveUser, useUsers } from './users';
import { cn } from './utils';

/** Other users (deduped, excluding me) whose live path matches `match`. */
export function usePresenceAt(match: (path: string) => boolean): PresenceUser[] {
  const { users } = useStore(liveStore);
  const me = authStore.get().user;
  return useMemo(() => {
    const seen = new Set<string>();
    return users.filter((u) => {
      if (u.userId === me?.id || seen.has(u.userId) || !match(u.path)) return false;
      seen.add(u.userId);
      return true;
    });
  }, [users, me?.id, match]);
}

/** Avatar stack of other people currently on the same path. */
export function PresenceStack({ path }: { path: string }) {
  const present = usePresenceAt((p) => p === path);
  const users = useUsers();
  const me = authStore.get().user;
  if (present.length === 0) return null;
  return (
    <span className="flex -space-x-1.5" title={present.map((u) => `${resolveUser(u.userId, users, me)?.name ?? 'Someone'} is here`).join(', ')}>
      {present.slice(0, 4).map((u) => {
        const user = resolveUser(u.userId, users, me);
        return <Avatar key={u.userId} name={user?.name ?? '?'} color={user?.color} size={22} className="ring-2 ring-white dark:ring-neutral-950" />;
      })}
    </span>
  );
}

/** Tiny colored dots marking sidebar items where other people currently are. */
export function PresenceDots({ match }: { match: (path: string) => boolean }) {
  const present = usePresenceAt(match);
  const users = useUsers();
  const me = authStore.get().user;
  if (present.length === 0) return null;
  return (
    <span className="ml-auto flex items-center gap-1">
      {present.slice(0, 3).map((u) => {
        const user = resolveUser(u.userId, users, me);
        return (
          <span
            key={u.userId}
            title={`${user?.name ?? 'Someone'} is here`}
            className={cn('inline-block h-1.5 w-1.5 rounded-full')}
            style={{ backgroundColor: user?.color ?? '#888' }}
          />
        );
      })}
    </span>
  );
}
