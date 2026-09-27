import { useEffect, useState } from 'react';
import { Check, Copy, Globe, Share2 } from 'lucide-react';
import { api } from '../../core/api';
import { IconButton, Popover } from '../../core/ui';
import { onlineStore } from '../../core/sync/engine';
import { useStore } from '../../core/store';
import { cn } from '../../core/utils';

interface Share {
  token: string;
  page_id: string;
  created_by: string;
  created_at: number;
}

/** "Publish to web" popover for a page. */
export function SharePopover({ pageId }: { pageId: string }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const online = useStore(onlineStore);

  useEffect(() => {
    if (!open || !online) return;
    void api<Share[]>('/api/shares')
      .then((rows) => setToken(rows.find((s) => s.page_id === pageId)?.token ?? null))
      .catch(() => {});
  }, [open, online, pageId]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) {
        const res = await api<{ token: string }>('/api/shares', { method: 'POST', body: { pageId } });
        setToken(res.token);
      } else {
        await api(`/api/shares/${pageId}`, { method: 'DELETE' });
        setToken(null);
      }
    } catch {
      /* offline / error — leave state */
    }
    setBusy(false);
  };

  const link = token ? `${location.origin}/s/${token}` : '';
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
                aria-checked={!!token}
                disabled={busy}
                onClick={() => void toggle(!token)}
                className={cn('relative h-5 w-9 rounded-full transition-colors', token ? 'bg-emerald-500' : 'bg-neutral-300 dark:bg-neutral-600')}
              >
                <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', token ? 'left-[18px]' : 'left-0.5')} />
              </button>
            </span>
          </div>
          <p className="mt-2 text-xs text-neutral-400">Anyone with the link can view this page and its sub-pages.</p>
          {token && (
            <div className="mt-3 flex items-center gap-2">
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
            </div>
          )}
        </div>
      )}
    </Popover>
  );
}
