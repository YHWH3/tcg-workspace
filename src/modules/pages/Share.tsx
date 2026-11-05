import { useEffect, useState } from 'react';
import { Check, Copy, Globe, Share2 } from 'lucide-react';
import { api } from '../../core/api';
import { IconButton, Popover } from '../../core/ui';
import { onlineStore } from '../../core/sync/engine';
import { useStore } from '../../core/store';
import { cn } from '../../core/utils';
import { useWorkspaceLocale, workspaceTimeZone } from '../../core/workspaceLocale';
import { toDateOnlyInZone } from '../../../shared/dates';

interface Share {
  token: string;
  page_id: string;
  target_type?: string;
  created_by: string;
  created_at: number;
  expires_at?: number | null;
  rotated_at?: number | null;
  expiresAt?: number | null;
}

/** "Publish to web" popover — for a page (`/s/:token`) or a mood board (`/s/canvas/:token`). */
export function SharePopover({ pageId, moodboardId }: { pageId?: string; moodboardId?: string }) {
  const targetId = pageId ?? moodboardId ?? '';
  const targetType = moodboardId ? 'moodboard' : 'page';
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState<Share | null>(null);
  const [expiry, setExpiry] = useState<'none' | '7' | '30' | '90'>('none');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const online = useStore(onlineStore);
  const locale = useWorkspaceLocale();

  useEffect(() => {
    if (!open || !online) return;
    void api<Share[]>('/api/shares')
      .then((rows) => setShare(rows.find((s) => s.page_id === targetId && (s.target_type ?? 'page') === targetType) ?? null))
      .catch(() => {});
  }, [open, online, targetId, targetType]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) {
        const expiresInDays = expiry === 'none' ? null : Number(expiry);
        const res = await api<{ token: string; expiresAt?: number | null }>('/api/shares', { method: 'POST', body: moodboardId ? { moodboardId, expiresInDays } : { pageId, expiresInDays } });
        setShare({ token: res.token, page_id: targetId, target_type: targetType, created_by: '', created_at: Date.now(), expiresAt: res.expiresAt });
      } else {
        await api(`/api/shares/${targetId}`, { method: 'DELETE' });
        setShare(null);
      }
    } catch {
      /* offline / error — leave state */
    }
    setBusy(false);
  };

  const rotate = async () => {
    if (!share || !window.confirm('Replace this public link? The current link will stop working immediately.')) return;
    setBusy(true);
    try {
      const res = await api<{ token: string; expiresAt?: number | null }>(`/api/shares/${targetId}/rotate`, { method: 'POST' });
      setShare((current) => current ? { ...current, token: res.token, expiresAt: res.expiresAt ?? current.expiresAt, expires_at: res.expiresAt ?? current.expires_at, rotated_at: Date.now() } : current);
    } catch {
      /* leave the old link visible if rotation fails */
    } finally {
      setBusy(false);
    }
  };

  const token = share?.token ?? null;
  const expiresAt = share?.expiresAt ?? share?.expires_at ?? null;
  const expiresOn = expiresAt ? toDateOnlyInZone(expiresAt, locale.settings?.timeZone ?? workspaceTimeZone()) : null;
  const link = token ? `${location.origin}${moodboardId ? '/s/canvas/' : '/s/'}${token}` : '';
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="right"
      className="w-80"
      trigger={
        <IconButton aria-label="Share">
          <Share2 size={16} />
        </IconButton>
      }
    >
      {() => (
        <div className="p-3.5" data-testid="share-popover">
          <div className="flex items-center gap-2">
            <Globe size={16} className="text-neutral-500" />
            <span className="text-sm font-semibold">Publish to web</span>
            <span className="ml-auto">
              <button
                role="switch"
                aria-label="Publish link"
                aria-checked={!!token}
                disabled={busy}
                onClick={() => void toggle(!token)}
                className={cn('relative h-5 w-9 rounded-full transition-colors', token ? 'bg-emerald-500' : 'bg-neutral-300 dark:bg-neutral-600')}
              >
                <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', token ? 'left-[18px]' : 'left-0.5')} />
              </button>
            </span>
          </div>
          <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">{moodboardId ? 'Anyone with the link can view this canvas read-only.' : 'Anyone with the link can view this page and its sub-pages.'}</p>
          {!token && <label className="mt-3 block text-xs font-medium text-neutral-600 dark:text-neutral-300">Link expiry<select aria-label="Link expiry" value={expiry} onChange={(e) => setExpiry(e.target.value as typeof expiry)} className="mt-1 block min-h-10 w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"><option value="none">Never expires</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select></label>}
          {token && (
            <>
            {expiresOn && <p className="mt-3 text-xs text-neutral-600 dark:text-neutral-300">Expires on {expiresOn}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                readOnly
                value={link}
                className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-800"
                onFocus={(e) => e.target.select()}
              />
              <IconButton
                aria-label="Copy link"
                onClick={() => {
                  void navigator.clipboard?.writeText(link);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check size={15} /> : <Copy size={15} />}
              </IconButton>
              <button type="button" className="min-h-10 rounded-lg border border-neutral-200 px-2.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800" disabled={busy} onClick={() => void rotate()}>Replace link</button>
            </div>
            </>
          )}
        </div>
      )}
    </Popover>
  );
}
