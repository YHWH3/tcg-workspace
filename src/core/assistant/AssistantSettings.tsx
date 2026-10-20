/* Settings → AI assistant. Provider status, BYOK keys (sent once to the
 * server; never stored, logged or echoed client-side), the local ChatGPT-plan
 * companion, external MCP hosts, conversation retention and bulk delete. */
import { useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { ASSISTANT_API, DEFAULT_RETENTION_DAYS, RETENTION_CHOICES, type ProviderStatus } from '../../../shared/assistantProtocol';
import { api, ApiError } from '../api';
import { useStore } from '../store';
import { Button, Dialog, Spinner } from '../ui';
import { cn } from '../utils';
import { McpUrlCopy } from './AssistantPanel';
import { assistantStore, deleteAllConversations, ensureProviders } from './store';

const STATE_BADGE: Record<ProviderStatus['state'], { label: string; cls: string }> = {
  available: { label: 'Available', cls: 'bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-300' },
  needs_credentials: { label: 'Needs API key', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300' },
  disabled_by_operator: { label: 'Disabled by operator', cls: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300' },
  requires_provider_approval: { label: 'Requires provider approval', cls: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300' },
  unavailable: { label: 'Unavailable', cls: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300' },
};

const BILLING: Record<ProviderStatus['billing'], string> = {
  none: 'No charge',
  operator_budget: 'Paid from the workspace AI budget',
  user_api_account: 'Billed to your own API account',
  chatgpt_plan: 'Uses your ChatGPT plan',
};

function KeyForm({ p, onDone }: { p: ProviderStatus; onDone: (msg: string) => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        const apiKey = value.trim();
        // Clear the field before the request: the key never lingers in UI state.
        setValue('');
        if (!apiKey) return;
        setBusy(true);
        setError('');
        void api<{ ok: boolean; models?: unknown[] }>(`${ASSISTANT_API}/credentials/${encodeURIComponent(p.id)}`, { method: 'PUT', body: { apiKey } })
          .then((r) => onDone(`${p.label} connected${Array.isArray(r.models) ? ` · ${r.models.length} model${r.models.length === 1 ? '' : 's'} available` : ''}.`))
          .catch((err) => setError(err instanceof ApiError && err.status === 0 ? 'Could not reach the server. Reconnect and try again.' : 'The key was not accepted. Check it and try again.'))
          .finally(() => setBusy(false));
      }}
    >
      <label htmlFor={id} className="w-full text-xs font-medium text-neutral-600 dark:text-neutral-300">
        {p.label} API key
      </label>
      <input
        id={id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        name={`assistant-key-${p.id}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="min-h-10 min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-3 text-base sm:text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />
      <Button type="submit" className="min-h-10" disabled={busy || !value.trim()}>
        {busy ? <Spinner size={14} className="motion-reduce:animate-none" /> : null} Connect
      </Button>
      {error && (
        <p role="alert" className="w-full text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      <p className="w-full text-[11px] text-neutral-500 dark:text-neutral-400">The key is sent once to this workspace server. It is never stored in this browser and is never shown again.</p>
    </form>
  );
}

export function AssistantSettings() {
  const s = useStore(assistantStore);
  const location = useLocation();
  const root = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const retentionId = useId();

  useEffect(() => {
    void ensureProviders(true);
  }, []);
  useEffect(() => {
    if (location.hash === '#ai-assistant') root.current?.scrollIntoView({ block: 'start' });
  }, [location.hash]);

  const disconnect = (p: ProviderStatus) => {
    setBusy(true);
    void api(`${ASSISTANT_API}/credentials/${encodeURIComponent(p.id)}`, { method: 'DELETE' })
      .then(() => {
        setMessage(`${p.label} disconnected.`);
        return ensureProviders(true);
      })
      .catch(() => setMessage('Disconnect failed. Reconnect and retry.'))
      .finally(() => setBusy(false));
  };

  const hosted = s.providers?.find((p) => p.mode === 'chatgpt-hosted');
  const retention = s.retentionDays ?? DEFAULT_RETENTION_DAYS;

  return (
    <div ref={root} className="space-y-5 text-sm">
      <p className="text-xs leading-5 text-neutral-500 dark:text-neutral-400">
        The assistant is optional — every workspace feature works without it. Answers only use sources you can read, and changes it proposes wait for your approval.
      </p>
      <p role="status" className="text-xs text-neutral-700 dark:text-neutral-200">
        {message}
      </p>

      <div>
        <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400">Providers</h3>
        {s.providersState === 'loading' && !s.providers && (
          <p className="flex items-center gap-2 text-xs text-neutral-500">
            <Spinner size={12} className="motion-reduce:animate-none" /> Loading providers…
          </p>
        )}
        {s.providersState === 'error' && (
          <div role="alert" className="text-xs">
            <p>Providers could not be loaded. Connect to the server and retry.</p>
            <Button className="mt-1 min-h-10" onClick={() => void ensureProviders(true)}>
              Retry
            </Button>
          </div>
        )}
        {s.providers && (
          <ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-200/70 dark:divide-neutral-800 dark:border-neutral-800">
            {s.providers.map((p) => {
              const badge = STATE_BADGE[p.state];
              return (
                <li key={p.id} className="px-3 py-3" data-testid={`assistant-provider-${p.id}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 break-words font-medium">{p.label}</span>
                    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', badge.cls)}>{badge.label}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                    {BILLING[p.billing]}
                    {p.egressHost ? ` · Context is sent to ${p.egressHost}` : ''}
                    {p.models.length ? ` · ${p.models.length} model${p.models.length === 1 ? '' : 's'}` : ''}
                  </p>
                  {p.reason && <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-300">{p.reason}</p>}
                  {p.state === 'needs_credentials' && <KeyForm p={p} onDone={(msg) => { setMessage(msg); void ensureProviders(true); }} />}
                  {p.mode === 'byok' && p.credentialConfigured && (
                    <Button variant="danger" className="mt-2 min-h-10" disabled={busy} onClick={() => disconnect(p)}>
                      Disconnect key
                    </Button>
                  )}
                  {p.manageUsageUrl && /^https:\/\//.test(p.manageUsageUrl) && (
                    <a className="mt-1 inline-flex min-h-10 items-center text-xs underline" href={p.manageUsageUrl} target="_blank" rel="noopener noreferrer">
                      Manage usage
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div>
        <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400">ChatGPT plan</h3>
        {hosted?.state === 'requires_provider_approval' && <p className="mb-1 text-xs text-neutral-600 dark:text-neutral-300">Hosted ChatGPT sign-in: {hosted.reason ?? 'requires approval from the provider before it can be offered here.'}</p>}
        <p className="text-xs leading-5">Use your ChatGPT plan locally with the TCG Workspace Companion. It runs on your computer, signs in to ChatGPT there, and connects to this workspace:</p>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-neutral-100 p-2 text-xs dark:bg-neutral-900">{`node companion/bin/tcg-companion.mjs login\nnode companion/bin/tcg-companion.mjs connect ${window.location.origin}\nnode companion/bin/tcg-companion.mjs chat`}</pre>
      </div>

      <div>
        <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400">Claude, ChatGPT and other hosts</h3>
        <p className="mb-2 text-xs leading-5">Add this MCP connector URL in your AI app. The host’s own subscription and connector rules apply; sign-in uses your workspace account.</p>
        <McpUrlCopy />
      </div>

      <div>
        <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400">Conversations</h3>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={retentionId} className="text-xs">
            Keep conversations for
          </label>
          <select
            id={retentionId}
            value={retention}
            onChange={(e) => {
              const retentionDays = Number(e.target.value);
              void api(`${ASSISTANT_API}/settings`, { method: 'PUT', body: { retentionDays } })
                .then(() => {
                  assistantStore.set((x) => ({ ...x, retentionDays }));
                  setMessage(`Conversations are now kept for ${retentionDays} days.`);
                })
                .catch(() => setMessage('Retention could not be changed. Reconnect and retry.'));
            }}
            className="min-h-10 rounded-lg border border-neutral-200 bg-white px-2 text-base sm:text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {RETENTION_CHOICES.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </div>
        <Button variant="danger" className="mt-3 min-h-10" onClick={() => setConfirmDelete(true)}>
          Delete all AI conversations
        </Button>
      </div>

      {confirmDelete && (
        <Dialog title="Delete all AI conversations?" onClose={() => setConfirmDelete(false)} guard={() => !busy}>
          <p className="text-sm text-neutral-600 dark:text-neutral-300">Every assistant conversation in your account is permanently deleted. Workspace pages, records and approved changes are not affected.</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" className="min-h-10" disabled={busy} onClick={() => setConfirmDelete(false)}>
              Keep conversations
            </Button>
            <Button
              variant="danger"
              className="min-h-10"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void deleteAllConversations()
                  .then((n) => setMessage(`Deleted ${n} conversation${n === 1 ? '' : 's'}.`))
                  .catch(() => setMessage('Delete failed. Reconnect and retry.'))
                  .finally(() => {
                    setBusy(false);
                    setConfirmDelete(false);
                  });
              }}
            >
              Delete all
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
