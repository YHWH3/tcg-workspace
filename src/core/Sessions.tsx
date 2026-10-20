import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken } from './api';
import { signOut } from './auth';
import { countLocalPending } from './sync/engine';
import { AdaptiveDialog, Button } from './ui';

interface Session { id: string; current: boolean; device: string; createdAt: number; lastSeenAt: number; expiresAt: number }
interface SessionPage { sessions: Session[]; nextCursor: string | null }

export function Sessions() {
  const [page, setPage] = useState<SessionPage | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ target: Session | 'others'; pending: number } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async (cursor?: string) => {
    setBusy(true); setError(''); const token = getToken();
    try {
      const result = await api<SessionPage>(`/api/sessions${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`);
      if (alive.current && getToken() === token) setPage(result);
    } catch { if (alive.current) setError('Unable to load devices. Check your connection and retry.'); }
    finally { if (alive.current) setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function ask(target: Session | 'others') {
    const pending = typeof target !== 'string' && target.current ? await countLocalPending() : null;
    if (alive.current) setConfirm({ target, pending: pending ? pending.records + pending.media + pending.drafts : 0 });
  }
  async function revoke() {
    if (!confirm) return;
    setBusy(true); setError(''); const token = getToken();
    try {
      if (typeof confirm.target !== 'string' && confirm.target.current) { await signOut(); return; }
      await api(`/api/sessions/${confirm.target === 'others' ? 'others' : confirm.target.id}`, { method: 'DELETE' });
      if (!alive.current || getToken() !== token) return;
      setConfirm(null); await load();
    } catch { if (alive.current) setError('Unable to sign out the selected devices. Check your connection and retry.'); }
    finally { if (alive.current) setBusy(false); }
  }
  return <>
    <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">Devices signed in to your workspace account. Browser names come from the device and may be approximate. AI connectors are managed separately.</p>
    {error && <p className="mt-3 text-sm text-red-600 dark:text-red-300" role="alert">{error}</p>}
    {!page && <p role="status" className="mt-3 text-sm">{busy ? 'Loading devices…' : 'Devices are unavailable.'}</p>}
    {page && <ul className="mt-4 space-y-4" aria-label="Signed-in devices">
      {page.sessions.map(session => <li key={session.id} className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{session.current ? 'This device' : 'Other device'}</p>
          <p className="mt-1 break-all text-xs text-neutral-500">{session.device}</p>
          <p className="mt-1 text-xs text-neutral-500">Last active <time dateTime={new Date(session.lastSeenAt).toISOString()}>{new Date(session.lastSeenAt).toLocaleString()}</time></p>
        </div>
        <Button className="min-h-11" disabled={busy} onClick={() => void ask(session)} aria-label={session.current ? 'Sign out this device' : `Sign out device last active ${new Date(session.lastSeenAt).toLocaleString()}`}>Sign out</Button>
      </li>)}
    </ul>}
    <div className="mt-4 flex flex-wrap gap-2"><Button className="min-h-11" disabled={busy} onClick={() => void load()}>Refresh devices</Button>
      {page?.nextCursor && <Button className="min-h-11" disabled={busy} onClick={() => void load(page.nextCursor!)}>Older devices</Button>}
      {page && <Button className="min-h-11" disabled={busy} onClick={() => void ask('others')}>Sign out other devices</Button>}
    </div>
    {confirm && <AdaptiveDialog title={confirm.target === 'others' ? 'Sign out other devices?' : confirm.target.current ? 'Sign out this device?' : 'Sign out this device session?'} onClose={() => { if (!busy) setConfirm(null); }} guard={() => !busy}>
      <p className="text-sm leading-relaxed">{confirm.target === 'others' ? 'Other devices will need to sign in again. This device stays signed in.' : confirm.target.current ? `Sign out on this device? ${confirm.pending} local operation${confirm.pending === 1 ? '' : 's'} remain unsynced. Your local work stays on this device.` : 'This session will need to sign in again. Its local work remains on that device.'}</p>
      <p className="mt-2 text-sm leading-relaxed">Disconnected devices may retain previously downloaded content. Revocation does not erase their local files.</p>
      <div className="mt-4 flex flex-wrap gap-2"><Button className="min-h-11" variant="danger" disabled={busy} onClick={() => void revoke()}>{busy ? 'Signing out…' : 'Confirm sign out'}</Button><Button className="min-h-11" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button></div>
    </AdaptiveDialog>}
  </>;
}
