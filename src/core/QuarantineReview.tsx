import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { AdaptiveDialog, Button } from './ui';
import { refreshPending } from './sync/engine';
import { authStore } from './auth';

const reasons: Record<string, string> = {
  access_revoked_or_unconfirmed_creation: 'Access was removed or the original record could not be confirmed.',
  access_review_required: 'This operation needs an access review.',
  access_revoked_or_read_only: 'Access was removed or changed to read-only.',
  explicit_move_required: 'A space move requires review.',
  parent_unavailable: 'The parent item is no longer available.',
  parent_access_rejected: 'An operation on the parent item was refused.',
  file_access_revoked: 'Upload access was removed.',
};
const collections: Record<string, string> = { pages: 'Page edit', blocks: 'Body edit', tasks: 'Record edit', boards: 'Database edit', comments: 'Comment edit', files: 'Attachment edit', links: 'Relation edit', views: 'View edit', moodboards: 'Canvas edit', mooditems: 'Canvas item edit', forms: 'Form edit', automations: 'Automation edit', activity: 'Activity update' };

export function QuarantineReview({ onClose }: { onClose: () => void }) {
  const [before, setBefore] = useState<number | null>(null), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const count = useLiveQuery(() => db.accessQuarantine.count(), [], 0);
  // Never fetch binary/content payloads for this review UI.
  const rows = useLiveQuery(() => (before === null ? db.accessQuarantineInfo.orderBy('autoId') : db.accessQuarantineInfo.where('autoId').below(before)).reverse().limit(10).toArray(), [before], []);
  async function discard() {
    const userId = authStore.get().user?.id;
    const current = () => !!userId && db.name === `workspace-${userId}` && localStorage.getItem('ws_uid') === userId;
    if (!current()) { setError('The account changed. Reload before discarding work.'); return; }
    setBusy(true); setError('');
    try {
      await db.transaction('rw', db.accessQuarantine, db.accessQuarantineInfo, async () => {
        if (!current()) throw new Error('account changed');
        await db.accessQuarantine.clear(); await db.accessQuarantineInfo.clear();
        if (!current()) throw new Error('account changed');
      });
      refreshPending(); setConfirm(false); onClose();
    } catch { setError('Unable to discard held work. Reload and retry.'); }
    finally { setBusy(false); }
  }
  return <AdaptiveDialog title={confirm ? 'Discard all held work?' : 'Held work'} onClose={() => { if (!busy) onClose(); }} guard={() => !busy}>
    {confirm ? <>
      <p className="text-sm leading-relaxed">Discard {count} held operation{count === 1 ? '' : 's'} from this account on this device? This removes the retained edits, drafts and upload bytes. It cannot be undone.</p>
      <div className="mt-4 flex flex-wrap gap-2"><Button className="min-h-11" variant="danger" disabled={busy} onClick={() => void discard()}>{busy ? 'Discarding…' : 'Discard held work'}</Button><Button className="min-h-11" disabled={busy} onClick={() => setConfirm(false)}>Cancel</Button></div>
    </> : <>
      <p className="text-sm leading-relaxed">{count} operation{count === 1 ? ' is' : 's are'} held on this device after an access change and {count === 1 ? 'is' : 'are'} not syncing. Ask a space owner to review your access. Recovery and export are currently unavailable.</p>
      <ol className="mt-4 max-h-[40dvh] space-y-3 overflow-y-auto text-xs" aria-label="Held operations">
        {rows.map(row => <li key={row.autoId}><p className="font-medium">{row.kind === 'blob' ? 'File upload' : row.kind === 'draft' ? 'Draft' : collections[row.collection ?? ''] ?? 'Record edit'}</p><p className="mt-0.5 text-neutral-600 dark:text-neutral-300">{reasons[row.reason] ?? 'Access to this operation requires review.'}</p><time className="text-neutral-500" dateTime={new Date(row.quarantinedAt).toISOString()}>{new Date(row.quarantinedAt).toLocaleString()}</time></li>)}
      </ol>
      <div className="mt-4 flex flex-wrap gap-2">
        {rows.length === 10 && <Button className="min-h-11" onClick={() => setBefore(rows[rows.length - 1].autoId)}>Older operations</Button>}
        {before !== null && <Button className="min-h-11" onClick={() => setBefore(null)}>Newest operations</Button>}
        <Button className="min-h-11" variant="danger" disabled={!count} onClick={() => setConfirm(true)}>Discard all held work</Button>
      </div>
    </>}
    {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-300">{error}</p>}
  </AdaptiveDialog>;
}
