import {useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {AlertTriangle} from 'lucide-react';
import {db} from './db';
import {authStore} from './auth';
import {getToken} from './api';
import {useStore} from './store';
import {accessClientStore, assertClientMutationReady} from './accessClient';
import {mutate} from './sync/engine';
import {CONFLICT_RETENTION, resolveConflict, type Conflict, type ConflictEnvelope} from './sync/conflicts';
import {AdaptiveDialog, Button} from './ui';

const display = (value: unknown) => value == null ? 'Empty' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
function useConflicts(recordId?: string) {
  const auth = useStore(authStore), access = useStore(accessClientStore), token = getToken();
  const uid = auth.user?.id, key = JSON.stringify([uid, token, access.epoch, access.status, recordId]);
  const available = !!uid && !!token && db.name === `workspace-${uid}` && (access.status === 'ready' || access.status === 'offline');
  const current = () => {
    const latest = accessClientStore.get();
    assertClientMutationReady();
    if (!available || authStore.get().user?.id !== uid || localStorage.getItem('ws_uid') !== uid || getToken() !== token || latest.epoch !== access.epoch || (latest.status !== 'ready' && latest.status !== 'offline')) throw new Error('Access changed. Reopen this review.');
  };
  const result = useLiveQuery(async () => {
    if (!available) return {key, rows: []};
    const meta = await db.meta.where('key').startsWith('conflicts:').toArray();
    const rows: {envelope: ConflictEnvelope; title: string}[] = [];
    for (const item of meta) {
      const envelope = item.value as ConflictEnvelope;
      const row = await db.collection(envelope.collection).get(envelope.id);
      if (!row || row.deleted || recordId && envelope.id !== recordId && !(envelope.collection === 'blocks' && row.pageId === recordId)) continue;
      const entries = envelope.entries.filter(entry => entry.at > Date.now() - CONFLICT_RETENTION);
      if (entries.length) rows.push({envelope: {...envelope, entries}, title: String(row.title ?? row.name ?? (envelope.collection === 'blocks' ? 'Body text' : 'Record'))});
    }
    return {key, rows};
  }, [key, available]);
  return {rows: available && result?.key === key ? result.rows : [], current, available, loading: available && result?.key !== key};
}

export function ConflictPanel() {
  const {rows, loading} = useConflicts(), [open, setOpen] = useState(false);
  const count = rows.reduce((total, row) => total + row.envelope.entries.length, 0);
  return <section aria-label="Changes that did not win" className="space-y-2">
    <h4 className="text-sm font-semibold">Changes that didn't win</h4>
    <p className="text-sm">{loading ? 'Reading retained changes…' : count ? `${count} field change${count === 1 ? '' : 's'} to review on this device.` : 'No retained conflicts observed by this device.'}</p>
    <p className="text-sm text-neutral-600 dark:text-neutral-400">Up to 200 field changes are kept for 14 days. This device cannot report every change made elsewhere.</p>
    {count > 0 && <Button className="h-auto min-h-11 py-2" onClick={() => setOpen(true)}>Review changes that didn't win</Button>}
    {open && <ConflictReview close={() => setOpen(false)}/>}
  </section>;
}

export function ConflictIndicator({recordId}: {recordId: string}) {
  const {rows} = useConflicts(recordId), [open, setOpen] = useState(false);
  if (!rows.length && !open) return null;
  return <><Button className="h-auto min-h-11 gap-2 py-2 text-amber-800 dark:text-amber-300" onClick={() => setOpen(true)}><AlertTriangle size={16} aria-hidden/>Review conflicting edits</Button>{open && <ConflictReview recordId={recordId} close={() => setOpen(false)}/>}</>;
}

function ConflictReview({recordId, close}: {recordId?: string; close: () => void}) {
  const {rows, current, available, loading} = useConflicts(recordId), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  async function act(envelope: ConflictEnvelope, entry: Conflict, action: 'mine' | 'dismiss') {
    setBusy(true); setError(''); setMessage('');
    try {
      current();
      await resolveConflict(db, envelope, entry, action, current, mutate);
      current(); setMessage(action === 'mine' ? 'Your value is saved on this device and queued for sync. The server will check current access and the field value.' : 'This retained change was dismissed.');
    } catch (failure) {setError(failure instanceof Error ? failure.message : 'This action could not finish.');}
    finally {setBusy(false);}
  }
  return <AdaptiveDialog title="Changes that didn't win" onClose={close} guard={() => !busy}>
    <p className="text-sm">Conflicts observed by this device. The other editor's identity is unavailable. Values stay here for up to 14 days, within the 200-change limit.</p>
    <p role="status" className="mt-2 text-sm">{message}</p>
    {error && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
    {!available ? <p className="mt-3">Check access before reviewing retained edits.</p> : loading ? <p className="mt-3">Reading retained changes…</p> : !rows.length ? <p className="mt-3">No retained changes remain for this review.</p> : <ol className="mt-4 space-y-5" aria-label="Conflicting field changes">
      {rows.flatMap(({envelope, title}) => envelope.entries.map(entry => <li key={entry.token} className="min-w-0 space-y-3 rounded-xl border border-neutral-200 p-3 dark:border-neutral-700">
        <h3 className="break-words font-semibold">{title} · {entry.field}</h3>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">Observed {new Date(entry.at).toLocaleString()}</p>
        <dl className="space-y-3 text-sm"><div><dt className="font-semibold">Your retained value</dt><dd className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{display(entry.mine)}</dd></div><div><dt className="font-semibold">Server value when observed</dt><dd className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{display(entry.theirs)}</dd></div></dl>
        <div className="flex flex-wrap gap-3"><Button className="h-auto min-h-11 py-2" disabled={busy} onClick={() => void act(envelope, entry, 'mine')}>Use mine</Button><Button className="h-auto min-h-11 py-2" disabled={busy} onClick={() => void act(envelope, entry, 'dismiss')}>Dismiss</Button></div>
      </li>))}
    </ol>}
  </AdaptiveDialog>;
}
