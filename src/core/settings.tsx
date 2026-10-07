import { useCallback, useEffect, useState } from 'react';
import { Copy, Plus, Trash2, Check } from 'lucide-react';
import type { PublicUser } from '../../shared/types';
import { api } from './api';
import { authStore, changePassword, updateMe } from './auth';
import { USER_COLORS } from './config';
import { useStore } from './store';
import { Avatar, Button, Field, Input, Spinner } from './ui';
import { cn } from './utils';

interface InviteRow {
  code: string;
  created_at: number;
  used_by: string | null;
  used_by_name?: string | null;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-neutral-900/50">
      <h2 className="border-b border-neutral-100 px-5 py-3 text-xs font-semibold tracking-wide text-neutral-500 uppercase dark:border-neutral-800 dark:text-neutral-400">{title}</h2>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function SettingsPage() {
  const user = useStore(authStore).user;
  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto px-5 py-8">
      <h1 className="mb-6 text-xl font-semibold tracking-tight">Settings</h1>
      <div className="flex flex-col gap-5">
        <ProfileSection user={user} />
        <AIConnectorsSection />
        <StorageSection />
        <PasswordSection />
        {user?.role === 'admin' && <AdminSection />}
      </div>
    </div>
  );
}

function ProfileSection({ user }: { user: PublicUser | null }) {
  const [name, setName] = useState(user?.name ?? '');
  const [color, setColor] = useState(user?.color ?? USER_COLORS[0]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (user) {
      setName(user.name);
      setColor(user.color);
    }
  }, [user?.id]);
  if (!user) return null;
  const dirty = name.trim() !== user.name || color !== user.color;
  return (
    <Section title="Profile">
      <div className="flex items-center gap-4">
        <Avatar name={name || user.name} color={color} size={44} />
        <div className="flex-1">
          <Field label="Display name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
      </div>
      <div className="mt-4">
        <span className="mb-1.5 block text-xs font-medium text-neutral-500 dark:text-neutral-400">Color</span>
        <div className="flex flex-wrap gap-2">
          {USER_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={cn('flex h-7 w-7 items-center justify-center rounded-full transition-transform hover:scale-110', color === c && 'ring-2 ring-neutral-900 ring-offset-2 dark:ring-white dark:ring-offset-neutral-900')}
              style={{ backgroundColor: c }}
              aria-label={c}
            >
              {color === c && <Check size={13} className="text-white" />}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || busy}
          onClick={async () => {
            setBusy(true);
            await updateMe({ name: name.trim(), color });
            setBusy(false);
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
          }}
        >
          {busy ? <Spinner size={13} /> : 'Save'}
        </Button>
        {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">Saved</span>}
        <span className="text-xs text-neutral-400">@{user.username}</span>
      </div>
    </Section>
  );
}

function fmtMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function StorageSection() {
  const [usage, setUsage] = useState<{ used: number; limit: number } | null>(null);
  useEffect(() => {
    api<{ used: number; limit: number }>('/api/files/usage')
      .then(setUsage)
      .catch(() => setUsage(null));
  }, []);
  const pct = usage ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
  return (
    <Section title="Storage">
      {usage ? (
        <div>
          <div className="mb-1.5 flex items-center justify-between text-sm">
            <span className="font-medium">Storage</span>
            <span className="text-xs text-neutral-400">
              {fmtMB(usage.used)} of {fmtMB(usage.limit)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
            <div
              className={cn('h-full rounded-full transition-all', pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-neutral-900 dark:bg-white')}
              style={{ width: `${Math.max(pct, 1)}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-neutral-400">Files are stored in D1 and capped at 20 MB each. The workspace quota is shared by all members.</p>
        </div>
      ) : (
        <p className="text-xs text-neutral-400">Storage usage is unavailable while offline.</p>
      )}
    </Section>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Section title="Change password">
      <div className="flex max-w-xs flex-col gap-3">
        <Field label="Current password">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label="New password" hint="At least 8 characters">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            disabled={!current || next.length < 8 || busy}
            onClick={async () => {
              setBusy(true);
              setMsg(null);
              try {
                await changePassword(current, next);
                setMsg({ ok: true, text: 'Password updated' });
                setCurrent('');
                setNext('');
              } catch (e) {
                setMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed' });
              } finally {
                setBusy(false);
              }
            }}
          >
            Update
          </Button>
          {msg && <span className={cn('text-xs', msg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500')}>{msg.text}</span>}
        </div>
      </div>
    </Section>
  );
}

function AdminSection() {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const me = useStore(authStore).user;

  const load = useCallback(async () => {
    const [{ users }, { invites }] = await Promise.all([
      api<{ users: PublicUser[] }>('/api/users'),
      api<{ invites: InviteRow[] }>('/api/invites'),
    ]);
    setUsers(users);
    setInvites(invites);
  }, []);

  useEffect(() => {
    void load().catch(() => {});
  }, [load]);

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      /* clipboard unavailable */
    }
    setCopied(code);
    setTimeout(() => setCopied(null), 1500);
  };

  const unused = invites.filter((i) => !i.used_by);

  return (
    <>
      <Section title={`Members — ${users.length}/7 seats used`}>
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {users.map((u) => (
            <li key={u.id} className="flex items-center gap-3 py-2.5">
              <Avatar name={u.name} color={u.color} size={30} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{u.name}</p>
                <p className="truncate text-xs text-neutral-400">@{u.username}</p>
              </div>
              {u.id === me?.id ? (
                <span className="text-xs text-neutral-400">you · {u.role}</span>
              ) : (
                <>
                  <button
                    className="rounded-lg border border-neutral-200 px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                    onClick={async () => {
                      await api(`/api/users/${u.id}`, { method: 'PATCH', body: { role: u.role === 'admin' ? 'member' : 'admin' } }).catch((e) => alert(e.message));
                      void load();
                    }}
                  >
                    {u.role}
                  </button>
                  <button
                    className="rounded-lg p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
                    onClick={async () => {
                      if (!confirm(`Remove ${u.name} from the workspace?`)) return;
                      await api(`/api/users/${u.id}`, { method: 'DELETE' }).catch((e) => alert(e.message));
                      void load();
                    }}
                    aria-label={`Remove ${u.name}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Invite codes">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs text-neutral-400">Share a code to let someone join. Each code works once.</p>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await api('/api/invites', { method: 'POST' });
              void load();
            }}
          >
            <Plus size={13} /> New code
          </Button>
        </div>
        {unused.length === 0 ? (
          <p className="py-2 text-xs text-neutral-400">No active codes.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {unused.map((inv) => (
              <li key={inv.code} className="flex items-center gap-2 rounded-lg border border-neutral-200/80 px-3 py-2 dark:border-neutral-800">
                <code className="flex-1 text-sm font-medium tracking-[0.2em]">{inv.code}</code>
                <button className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => void copy(inv.code)} aria-label="Copy code">
                  {copied === inv.code ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                </button>
                <button
                  className="rounded-md p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
                  onClick={async () => {
                    await api(`/api/invites/${inv.code}`, { method: 'DELETE' });
                    void load();
                  }}
                  aria-label="Revoke code"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {invites.some((i) => i.used_by) && (
          <p className="mt-3 text-xs text-neutral-400">
            Used: {invites.filter((i) => i.used_by).map((i) => `${i.code}${i.used_by_name ? ` (${i.used_by_name})` : ''}`).join(', ')}
          </p>
        )}
      </Section>
    </>
  );
}

interface GrantRow {
  id: string;
  clientId: string;
  clientName: string;
  scope: string[];
  createdAt: number;
  expiresAt: number | null;
}

function AIConnectorsSection() {
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [copied, setCopied] = useState(false);
  const mcpUrl = `${location.origin}/mcp`;

  const load = useCallback(async () => {
    try {
      const r = await api<{ grants: GrantRow[] }>('/api/oauth/grants');
      setGrants(r.grants);
    } catch {
      /* endpoint unreachable (older build) — show section anyway */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(mcpUrl);
    } catch {
      /* noop */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const revoke = async (id: string) => {
    await api(`/api/oauth/grants/${id}`, { method: 'DELETE' });
    setGrants((g) => g.filter((x) => x.id !== id));
  };

  return (
    <Section title="AI connectors">
      <p className="mb-3 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
        Connect Claude, ChatGPT or Gemini to read and build in this workspace. Paste the MCP URL when the app asks for a
        connector endpoint — sign-in uses your workspace account.
      </p>
      <div className="mb-4 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-900">{mcpUrl}</code>
        <Button variant="secondary" size="sm" onClick={() => void copy()}>
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <details className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
        <summary className="cursor-pointer font-medium text-neutral-700 dark:text-neutral-300">Setup steps per app</summary>
        <ul className="mt-2 space-y-1.5 pl-4 leading-5">
          <li><b>Claude</b>: Settings → Connectors → Add custom connector → paste the URL.</li>
          <li><b>ChatGPT</b>: Settings → Apps & Connectors → Advanced → Developer mode → Create. Write tools need Business/Enterprise/Edu; Plus/Pro get read-only search.</li>
          <li><b>Gemini</b>: gemini.google.com → Settings → Connected Apps → Add a custom app (US personal accounts, English).</li>
        </ul>
      </details>
      {grants.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">Connected apps</p>
          <ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-200/70 dark:divide-neutral-800 dark:border-neutral-800">
            {grants.map((g) => (
              <li key={g.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">{g.clientName}</span>
                <span className="shrink-0 text-[11px] text-neutral-400">{new Date(g.createdAt < 1e12 ? g.createdAt * 1000 : g.createdAt).toLocaleDateString()}</span>
                <button className="shrink-0 text-xs font-medium text-red-500 hover:text-red-600" onClick={() => void revoke(g.id)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
