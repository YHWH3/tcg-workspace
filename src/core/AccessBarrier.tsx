import { useEffect, useRef } from 'react';
import { accessClientStore } from './accessClient';
import { useStore } from './store';
import { Button, Spinner } from './ui';
import { syncNow } from './sync/engine';
import { signOut } from './auth';

/** Unmounts private routes and their portals/media/search while access is
 * unresolved. This is presentation safety, never a substitute for server ACL. */
export function AccessBarrier({ children }: { children: React.ReactNode }) {
  const state = useStore(accessClientStore);
  const heading = useRef<HTMLHeadingElement>(null);
  const blocked = state.status === 'checking' || state.status === 'error';
  useEffect(() => { if (blocked) heading.current?.focus(); }, [blocked]);
  if (!blocked) return <>{children}</>;
  const checking = state.status === 'checking', accountChanged = state.reason === 'account_changed' || state.reason === 'session_changed';
  const message = accountChanged ? 'The account or session changed in another tab. Reload to continue with the current account.'
    : state.reason === 'reconnect_required' ? 'Reconnect to check your access before opening this workspace. Local work stays on this device.'
    : checking ? 'Checking which spaces you can open. Local work stays on this device.'
    : 'Unable to check your access. Check your connection and retry. Local work stays on this device.';
  return (
    <main className="flex min-h-dvh items-center justify-center bg-white px-5 py-8 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100" aria-busy={checking}>
      <section className="w-full max-w-sm" aria-labelledby="access-check-title">
        {checking && <span aria-hidden="true" className="mb-4 block"><Spinner size={22} /></span>}
        <h1 ref={heading} id="access-check-title" tabIndex={-1} className="text-lg font-semibold">{checking ? 'Checking access' : 'Access check required'}</h1>
        <p role="status" className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">{message}</p>
        {!checking && <div className="mt-5 flex flex-wrap gap-2">
          {accountChanged ? <Button className="min-h-11" onClick={() => location.reload()}>Reload workspace</Button>
            : <><Button className="min-h-11" onClick={() => void syncNow()}>Retry access check</Button><Button className="min-h-11" variant="ghost" onClick={() => void signOut()}>Sign out</Button></>}
        </div>}
      </section>
    </main>
  );
}
