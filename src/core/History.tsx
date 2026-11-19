import {useEffect, useId, useRef, useState} from 'react';
import {api, ApiError, getToken} from './api';
import {Sheet, Button} from './ui';
import {accessClientStore} from './accessClient';
import {authStore} from './auth';
import {useStore} from './store';
import {textDiff} from '../../shared/textDiff';

interface Entry {
  revision: number;
  actor_name: string | null;
  source: string;
  created_at: number;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  omitted: string[];
  recordId?: string;
  currentRevision?: number;
  change?: 'added' | 'removed' | 'changed';
}
interface Reply {revision?: number; entries: Entry[]; nextBefore: number | null; coverage?: string}
type Mode = 'fields' | 'body';
interface RestorePreview {entry: Entry; fields: string[]; targetId: string; expectedRev: number; requestId: string}
const display = (value: unknown) => value == null ? 'Empty' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);

export function HistoryButton({recordId}: {recordId: string}) {
  const [open, setOpen] = useState(false);
  return <><Button onClick={() => setOpen(true)}>History</Button>{open && <History recordId={recordId} close={() => setOpen(false)}/>}</>;
}

function Difference({before, after}: {before: unknown; after: unknown}) {
  const diff = textDiff(display(before), display(after));
  return <div className="min-w-0 space-y-1">
    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{diff.parts.map((part, index) => part.kind === 'removed'
      ? <del key={index} className="bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200">{part.text}</del>
      : part.kind === 'added'
        ? <ins key={index} className="bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200">{part.text}</ins>
        : <span key={index}>{part.text}</span>)}</p>
    {diff.simplified && <p className="text-xs">This large change is shown as complete removed and added text.</p>}
  </div>;
}

function History({recordId, close}: {recordId: string; close: () => void}) {
  const access = useStore(accessClientStore), auth = useStore(authStore), token = getToken();
  const revisionId = useId();
  const key = JSON.stringify([auth.user?.id, token, access.epoch, access.status, recordId]);
  const identity = useRef(key), generation = useRef(0), mounted = useRef(true);
  identity.current = key;
  const [mode, setMode] = useState<Mode>('fields'), [reply, setReply] = useState<Reply | null>(null);
  const [owner, setOwner] = useState(''), [selected, setSelected] = useState<number | null>(null);
  const [fields, setFields] = useState<string[]>([]), [preview, setPreview] = useState<RestorePreview | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const safe = access.status === 'ready' && owner === key;
  const current = () => mounted.current && identity.current === key && authStore.get().user?.id === auth.user?.id
    && getToken() === token && accessClientStore.get().epoch === access.epoch && accessClientStore.get().status === 'ready';

  async function load(nextMode = mode, before?: number) {
    const request = ++generation.current;
    setBusy(true); setError(''); setPreview(null);
    try {
      const suffix = nextMode === 'body' ? '/body' : '';
      const result = await api<Reply>(`/api/history/${encodeURIComponent(recordId)}${suffix}${before ? '?before=' + before : ''}`);
      if (!current() || generation.current !== request) return;
      setReply(old => before ? {...result, entries: [...(old?.entries ?? []), ...result.entries]} : result);
      setOwner(key); setMode(nextMode);
      if (!before) {setSelected(result.entries[0]?.revision ?? null); setFields([]);}
    } catch (failure) {
      if (current() && generation.current === request) setError(failure instanceof Error ? failure.message : 'History unavailable');
    } finally {
      if (current() && generation.current === request) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    setReply(null); setPreview(null); setSelected(null); setFields([]); setOwner('');
    if (access.status === 'ready') void load(mode);
    return () => {mounted.current = false; generation.current++;};
  }, [key]);

  function prepare(entry: Entry, chosen: string[]) {
    const expectedRev = entry.currentRevision ?? reply?.revision;
    if (!safe || expectedRev === undefined) return;
    setPreview({entry, fields: chosen, targetId: entry.recordId ?? recordId, expectedRev, requestId: crypto.randomUUID()});
  }
  async function restore() {
    if (!preview || !current()) return;
    setBusy(true); setError('');
    try {
      await api(`/api/history/${encodeURIComponent(preview.targetId)}/restore`, {method: 'POST', body: {
        revision: preview.entry.revision, expectedRev: preview.expectedRev, side: 'before', fields: preview.fields, requestId: preview.requestId,
      }});
      if (!current()) return;
      setPreview(null); await load(mode);
    } catch (failure) {
      if (!current()) return;
      if (failure instanceof ApiError && failure.status === 409) {
        setPreview(null); setError('The record changed or access changed. Refresh history and review the latest value before retrying.');
      } else setError(failure instanceof Error ? failure.message : 'Restore failed. Retry to check the same restore request.');
    } finally {if (current()) setBusy(false);}
  }
  const entry = safe ? reply?.entries.find(item => item.revision === selected) : null;
  const keys = entry ? [...new Set([...Object.keys(entry.before), ...Object.keys(entry.after)])] : [];
  return <Sheet label="Record history" onClose={close} side="right">
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <h2 className="text-lg font-semibold">Record history</h2>
      <div className="flex flex-wrap gap-2" aria-label="History type">
        <Button aria-pressed={mode === 'fields'} disabled={busy} onClick={() => void load('fields')}>Fields</Button>
        <Button aria-pressed={mode === 'body'} disabled={busy} onClick={() => void load('body')}>Body changes</Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto">
        {safe && reply && <>
          {reply.coverage && <details className="text-sm"><summary className="min-h-11 cursor-pointer">About body history</summary><p>Body changes are available from when tracking was added. Older changes may be unavailable.</p></details>}
          {reply.entries.length === 0 && <p>No recorded changes yet.</p>}
          {reply.entries.length > 0 && <div className="space-y-1 text-sm"><label htmlFor={revisionId}>Revision</label>
            <select id={revisionId} className="min-h-11 w-full min-w-0 rounded border bg-white p-2 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100"
              value={selected ?? ''} disabled={busy} onChange={event => {setSelected(Number(event.target.value)); setFields([]); setPreview(null);}}>
              {reply.entries.map(item => <option key={item.revision} value={item.revision}>
                {item.revision} · {item.actor_name ?? 'Former member'} · {new Date(item.created_at).toLocaleString()}
              </option>)}
            </select>
          </div>}
          {entry && <article className="min-w-0 space-y-4 rounded border p-3" aria-label={`Revision ${entry.revision}`}>
            <h3 className="font-semibold">{entry.change ? `Block ${entry.change}` : 'Field changes'} · Revision {entry.revision}</h3>
            <p className="break-words text-sm">{entry.actor_name ?? 'Former member'} · {entry.source}</p>
            <p className="text-xs"><del className="text-red-800 dark:text-red-200">Removed</del> · <ins className="text-green-800 dark:text-green-200">Added</ins></p>
            {keys.map(field => <section className="min-w-0 space-y-2" key={field} aria-label={`Change to ${field}`}>
              <h4 className="break-words font-semibold">{field}</h4>
              <Difference before={entry.before[field]} after={entry.after[field]}/>
              {field !== 'deleted' && <div className="flex flex-wrap items-center gap-2">
                <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={fields.includes(field)} disabled={busy}
                  onChange={event => setFields(old => event.target.checked ? [...old, field] : old.filter(item => item !== field))}/>
                  Select {field} for restore
                </label>
                <Button disabled={busy} onClick={() => prepare(entry, [field])}>Preview restore {field}</Button>
              </div>}
            </section>)}
            {entry.omitted.length > 0 && <p className="break-words text-sm">Not retained: {entry.omitted.join(', ')}</p>}
            <Button disabled={busy || fields.length === 0} onClick={() => prepare(entry, fields)}>Preview restore selected fields</Button>
          </article>}
          {reply.nextBefore && <Button disabled={busy} onClick={() => void load(mode, reply.nextBefore!)}>Load older changes</Button>}
        </>}
      </div>
      {safe && preview && <section aria-label="Restore preview" className="min-w-0 space-y-2 rounded border p-3">
        <h3 className="font-semibold">Restore {preview.fields.join(', ')}</h3>
        <p className="text-sm">This writes a new revision if revision {preview.expectedRev} is still current.</p>
        <div className="max-h-40 space-y-2 overflow-auto text-sm">{preview.fields.map(field => <p key={field} className="whitespace-pre-wrap [overflow-wrap:anywhere]">{field}: {display(preview.entry.before[field])}</p>)}</div>
        <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void restore()}>{preview.fields.length === 1 ? 'Confirm field restore' : 'Restore these fields'}</Button>
          <Button disabled={busy} onClick={() => setPreview(null)}>Cancel</Button></div>
      </section>}
      {error && <p role="alert" className="break-words text-sm text-red-700 dark:text-red-300">{error}</p>}
      <p role="status" className="text-sm">{access.status !== 'ready' ? 'Connect to verify access and read history.' : busy ? 'Loading…' : ''}</p>
      <div className="flex flex-wrap gap-2"><Button disabled={busy || access.status !== 'ready'} onClick={() => void load(mode)}>Refresh history</Button><Button onClick={close}>Close</Button></div>
    </div>
  </Sheet>;
}
