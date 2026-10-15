import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Copy, Eye, LayoutTemplate, Plus, Trash2, Check, Undo2 } from 'lucide-react';
import type { PublicUser } from '../../shared/types';
import { findReusableBoards, planInstallPreview, type AuthorTemplate, type BundledTemplate, type ExistingBoardLike } from '../../shared/bundled';
import { BUNDLED_TEMPLATES } from './bundledTemplates';
import { instantiateTemplate, usePages } from '../modules/pages/api';
import { NotificationPrefs } from '../modules/inbox';
import { api } from './api';
import { authStore, changePassword, updateMe } from './auth';
import { useChangesets, undoChangeset } from './activity';
import { USER_COLORS } from './config';
import { db } from './db';
import { toast } from './files';
import { useStore } from './store';
import { AdaptiveDialog, Avatar, Button, Field, Input, Spinner } from './ui';
import { cn } from './utils';
import { Sessions } from './Sessions';

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
        <RecentAIChangesSection />
        <TemplateGallerySection />
        <StorageSection />
        <NotificationsSection />
        <LocalDataSection user={user} />
        <PasswordSection />
        <Section title="Signed-in devices"><Sessions /></Section>
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

/* Quarantined local stores (account-switch 'discard' choices + migrated
 * legacy 'workspace' data). Deletion runs ONLY here, behind an explicit
 * two-step confirm — nothing auto-deletes at login (T2). */
function LocalDataSection({ user }: { user: PublicUser | null }) {
  const [queued, setQueued] = useState<string[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const { pendingStoreDrops } = await import('./maintenance');
    const active = user ? `workspace-${user.id}` : null;
    setQueued((await pendingStoreDrops()).filter((n) => n !== active));
  }, [user?.id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!queued || queued.length === 0) return null;
  const purge = async () => {
    setBusy(true);
    try {
      const { runConfirmedDrops } = await import('./maintenance');
      await runConfirmedDrops(user ? `workspace-${user.id}` : null);
    } finally {
      setBusy(false);
      setConfirming(false);
      await refresh();
    }
  };
  return (
    <Section title="Local data">
      <p className="text-xs text-neutral-400">
        Offline data kept on this device from other accounts or earlier versions.
      </p>
      <ul className="mt-2 space-y-1">
        {queued.map((n) => (
          <li key={n} className="flex items-center justify-between text-sm">
            <span className="font-mono text-xs text-neutral-600 dark:text-neutral-300">{n}</span>
          </li>
        ))}
      </ul>
      {!confirming ? (
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => setConfirming(true)}>
          Delete permanently…
        </Button>
      ) : (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/50 dark:bg-red-950/30">
          <p className="text-xs text-red-600 dark:text-red-400">
            This permanently erases the listed local data — including any unsynced changes, drafts and uploads still inside it.
            There is no cancel or reclaim once it starts.
          </p>
          <div className="mt-2 flex gap-2">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void purge()}>
              {busy ? <Spinner size={13} /> : 'Yes, delete it all'}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

function NotificationsSection() {
  return (
    <Section title="Notifications">
      <NotificationPrefs />
    </Section>
  );
}

function TemplateGallerySection() {
  const nav = useNavigate();
  const boards = (useLiveQuery(() => db.boards.toArray(), [], []) ?? []) as ExistingBoardLike[];
  const pages = usePages();
  const [preview, setPreview] = useState<BundledTemplate | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /** Installed = a non-deleted root page stamped with this templateKey. */
  const installed = (key: string) => pages.some((p) => !p.deleted && p.templateKey === key);
  const tplPages = pages.filter((p) => p.isTemplate && !p.deleted);

  const install = async (t: BundledTemplate) => {
    setBusy(t.key);
    try {
      const authorLike: AuthorTemplate = {
        name: t.name,
        description: t.description,
        icon: t.icon,
        databases: Object.entries(t.snapshot.boards ?? {}).map(([id, b]) => ({
          id,
          key: b.key as string | undefined,
          name: String(b.name ?? ''),
        })),
        pages: [],
      };
      const reuseBoards = findReusableBoards(boards, authorLike);
      const res = await instantiateTemplate(t.root, {
        snapshot: t.snapshot,
        templateKey: t.key,
        title: t.name,
        reuseBoards,
        preserveTemplates: true,
        packInstall: true,
        stableIds: true,
      });
      if (res) {
        setPreview(null);
        toast(res.kept
          ? `Installed ${t.name} — wrote ${res.applied} missing rows, kept ${res.kept} existing`
          : `Installed ${t.name}`);
        nav(`/pages/${res.rootPageId}`);
      } else {
        toast('Install failed — nothing was written', 'error');
      }
    } catch (e) {
      // Stable ids make a re-run reconcile missing rows — say so honestly
      // instead of claiming nothing was written.
      toast(`Install interrupted — run Install again to finish (${e instanceof Error ? e.message : 'write error'})`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const addPageTemplate = async (pageId: string, title: string) => {
    setBusy(pageId);
    try {
      const res = await instantiateTemplate(pageId, { title });
      if (res) nav(`/pages/${res.rootPageId}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="Template gallery">
      <ul className="flex flex-col gap-2">
        {BUNDLED_TEMPLATES.map((t) => {
          const isIn = installed(t.key);
          return (
            <li key={t.key} className="flex items-center gap-3 rounded-xl border border-neutral-200/70 px-3 py-2.5 dark:border-neutral-800">
              <span className="text-lg" aria-hidden>{t.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {t.name}
                  {isIn && <span className="ml-2 rounded bg-green-50 px-1.5 py-0.5 text-[10px] font-medium text-green-600 dark:bg-green-950/40 dark:text-green-400"><Check size={10} className="mr-0.5 inline" />Installed</span>}
                </span>
                <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">{t.description}</span>
              </span>
              <Button size="sm" variant="secondary" onClick={() => setPreview(t)}>
                <Eye size={14} /> Preview
              </Button>
              <Button size="sm" disabled={busy === t.key} onClick={() => setPreview(t)}>
                {busy === t.key ? <Spinner className="h-3.5 w-3.5" /> : <Plus size={14} />}
                {isIn ? 'Reinstall' : 'Add to workspace'}
              </Button>
            </li>
          );
        })}
      </ul>
      {tplPages.length > 0 && (
        <>
          <p className="mb-1 mt-4 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">Workspace page templates</p>
          <ul className="flex flex-col gap-2">
            {tplPages.map((p) => (
              <li key={p.id} className="flex items-center gap-3 rounded-xl border border-neutral-200/70 px-3 py-2.5 dark:border-neutral-800">
                <span className="text-lg" aria-hidden>{String(p.icon ?? '📄')}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{String(p.title ?? '') || 'Untitled'}</span>
                  <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400"><LayoutTemplate size={11} className="mr-1 inline" />Page template</span>
                </span>
                <Button size="sm" variant="secondary" disabled={busy === p.id} onClick={() => void addPageTemplate(p.id, String(p.title ?? '') || 'Untitled')}>
                  {busy === p.id ? <Spinner className="h-3.5 w-3.5" /> : <Plus size={14} />}
                  Add to workspace
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {preview && <TemplatePreviewSheet t={preview} boards={boards} installed={installed(preview.key)} busy={busy === preview.key} onClose={() => setPreview(null)} onInstall={() => void install(preview)} />}
    </Section>
  );
}

/**
 * Preview sheet = the dry-run (§4): planInstallPreview output — databases to
 * create vs reuse, per-collection counts, and warnings — plus the explicit
 * Install/Reinstall action. Nothing is written until the button is clicked.
 */
function TemplatePreviewSheet({ t, boards, installed, busy, onClose, onInstall }: { t: BundledTemplate; boards: ExistingBoardLike[]; installed: boolean; busy: boolean; onClose: () => void; onInstall: () => void }) {
  const plan = planInstallPreview(t, boards);
  return (
    <AdaptiveDialog title={`Install ${t.name}`} onClose={onClose} guard={() => !busy}>
      <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">{t.description}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-3">
        <Count label="Pages" n={plan.pages} />
        <Count label="Views" n={plan.views} />
        <Count label="Links" n={plan.links} note={plan.reused.links ? `+${plan.reused.links} on reused records — skipped` : undefined} />
        <Count label="Records" n={plan.records} />
        <Count label="Blocks" n={plan.blocks} />
        <Count label="Databases" n={plan.databases.create.length + plan.databases.reuse.length} />
      </dl>
      {plan.databases.create.length > 0 && (
        <div className="mt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">Databases — will be created</p>
          <p className="mt-0.5 text-sm">{plan.databases.create.join(', ')}</p>
        </div>
      )}
      {plan.databases.reuse.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-200/70 bg-amber-50 px-3 py-2 dark:border-amber-900/40 dark:bg-amber-950/30">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">Reused, not duplicated</p>
          {plan.databases.reuse.map((name) => (
            <p key={name} className="mt-0.5 text-sm text-amber-800 dark:text-amber-300">
              {name} exists — already installed, will be reused.
            </p>
          ))}
        </div>
      )}
      {installed && <p className="mt-3 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300">Already installed. Reinstalling reconciles against the existing rows — it never duplicates pages or records.</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={onInstall} disabled={busy}>
          {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
          {installed ? 'Reinstall' : 'Install'}
        </Button>
      </div>
    </AdaptiveDialog>
  );
}

function Count({ label, n, note }: { label: string; n: number; note?: string }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{n}</dd>
      {note && <dd className="text-[10px] leading-tight text-neutral-400">{note}</dd>}
    </div>
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

/* ---------- Phase 1: recent AI change sets + template gallery ---------- */

function RecentAIChangesSection() {
  const { rows, error, reload } = useChangesets(20);
  const [undoId, setUndoId] = useState<string | null>(null);
  return (
    <Section title="Recent AI changes">
      <p className="mb-3 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
        The last 20 change sets made by connected AI apps. Undo restores the previous field values; edits made since are skipped.
      </p>
      {error && <p className="text-xs text-neutral-400">Change history unavailable on this server.</p>}
      {rows !== null && rows.length === 0 && !error && <p className="text-xs text-neutral-400">No AI changes yet.</p>}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-200/70 dark:divide-neutral-800 dark:border-neutral-800">
          {rows.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <span className="block truncate font-medium">{c.summary || c.tool || 'Change'}</span>
                <span className="text-[11px] text-neutral-400">
                  {c.client_name ? `via ${c.client_name} · ` : ''}{c.item_count} item{c.item_count === 1 ? '' : 's'} · {new Date(c.created_at < 1e12 ? c.created_at * 1000 : c.created_at).toLocaleString()}
                  {c.undone_by && ' · undone'}
                </span>
              </div>
              {!c.undone_by && (
                <Button variant="secondary" size="sm" onClick={() => setUndoId(c.id)}>
                  <Undo2 size={12} /> Undo
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {undoId && (
        <div className="mt-3 rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-700">
          <p className="mb-2 text-neutral-600 dark:text-neutral-300">Undo this change set?</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setUndoId(null)}>Cancel</Button>
            <Button size="sm" onClick={() => void undoChangeset(undoId).then(() => { setUndoId(null); void reload(); })}>Undo</Button>
          </div>
        </div>
      )}
    </Section>
  );
}

