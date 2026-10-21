/* Embedded assistant UI: the dock (desktop side panel / tablet drawer / phone
 * full-screen sheet), the full-screen route (/ai/chat[/:conversationId]) and
 * the shared conversation surface they both render.
 *
 * All model output and record text render as React text nodes through the
 * markdown-lite AST (richtext.ts) — never HTML. Status is announced politely
 * on start/completion only; the message list is a log with live updates off. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, matchPath, useLocation, useNavigate, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle, ArrowUp, Check, ChevronLeft, Copy, ExternalLink, FileText, History, Maximize2, MessageSquarePlus, Pencil,
  RefreshCw, Sparkles, Square, Trash2, Wrench, X,
} from 'lucide-react';
import { aiAction, actionsFor, type ActionModule } from '../../../shared/aiActions';
import { previewImpactText } from '../../../shared/previewImpact';
import { MAX_CONTEXT_REFS, MAX_MESSAGE_CHARS, type ApprovalView, type AssistantMessage, type ContextRef, type ProviderStatus, type SourceRef, type ToolCallView } from '../../../shared/assistantProtocol';
import { db } from '../db';
import { useLayoutMode } from '../mobile';
import { useStore } from '../store';
import { onlineStore } from '../sync/engine';
import { Button, Dialog, Sheet, Spinner } from '../ui';
import { cn } from '../utils';
import { applyToSelection, undoApply } from './applySelection';
import { contextKindLabel, contextPath, safeInternalPath, sourcePath, useContextTitle } from './contextLabel';
import { parseRich, type Inline } from './richtext';
import {
  addContext, approveAndExecute, assistantContextStore, assistantSelectionStore, assistantStore, cancelApproval, canSend, clearAction,
  closeAssistant, contextKey, continueActiveRun, deleteConversation, dismissError, ensureProviders, errorText, loadConversations,
  newConversation, openAssistant, openConversation, regenerate, removeContext, renameConversation, retry, selectProvider, selectedProvider,
  sendMessage, setApplyState, setDraft, setMode, stop, type ApplyState, type AssistantState, type SelectionTarget,
} from './store';

const ICON_BTN =
  'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white';

const BILLING_LABEL: Record<ProviderStatus['billing'], string> = {
  none: 'No charge',
  operator_budget: 'Workspace budget',
  user_api_account: 'Billed to your API account',
  chatgpt_plan: 'Uses your ChatGPT plan',
};

const STATE_LABEL: Record<ProviderStatus['state'], string> = {
  available: 'Available',
  needs_credentials: 'Needs API key',
  disabled_by_operator: 'Disabled by operator',
  requires_provider_approval: 'Requires provider approval',
  unavailable: 'Unavailable',
};

const KIND_MODULES: Record<ContextRef['kind'], ActionModule[]> = {
  page: ['pages', 'notes'],
  record: ['tasks', 'projects'],
  database: ['databases'],
  moodboard: ['moodboards'],
  dashboard: ['dashboards'],
  selection: ['selection'],
};

/* ====================================================================== */
/* Dock: decides presentation per layout; remounts never lose the draft   */
/* (draft/stream state live in the store).                                */
/* ====================================================================== */

export function AssistantDock() {
  const mode = useStore(assistantStore).mode;
  const layout = useLayoutMode();
  const location = useLocation();
  if (mode !== 'panel' || matchPath('/ai/chat/*', location.pathname)) return null;
  if (layout === 'expanded') return <DesktopPanel />;
  return (
    <Sheet onClose={closeAssistant} side={layout === 'compact' ? 'full' : 'right'} label="AI assistant">
      <div data-testid="assistant-panel" className="flex h-full min-h-0 flex-col">
        <AssistantSurface variant="panel" />
      </div>
    </Sheet>
  );
}

function DesktopPanel() {
  // Non-modal side panel: no focus trap, pushes content instead of covering it.
  return (
    <aside
      data-testid="assistant-panel"
      aria-label="AI assistant"
      className="anim-slide-right flex h-full min-h-0 w-[clamp(300px,26vw,400px)] shrink-0 flex-col border-l border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-neutral-950"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          // Prevent window-level Escape handlers (e.g. task detail) from also closing.
          e.preventDefault();
          e.stopPropagation();
          closeAssistant();
        }
      }}
    >
      <AssistantSurface variant="panel" />
    </aside>
  );
}

/* ====================================================================== */
/* Full-screen route                                                       */
/* ====================================================================== */

export function AssistantPage() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const s = useStore(assistantStore);
  const layout = useLayoutMode();
  useEffect(() => {
    setMode('full');
    void ensureProviders();
    return () => {
      if (assistantStore.get().mode === 'full') setMode('closed');
    };
  }, []);
  useEffect(() => {
    if (conversationId) void openConversation(conversationId);
  }, [conversationId]);
  // Keep the URL in step with a conversation created by sending.
  useEffect(() => {
    if (s.conversationId && s.conversationId !== conversationId) navigate(`/ai/chat/${encodeURIComponent(s.conversationId)}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.conversationId]);
  const wide = layout !== 'compact';
  return (
    <div className="flex h-full min-h-0">
      {wide && (
        <nav aria-label="AI conversations" className="flex w-72 shrink-0 flex-col border-r border-neutral-200/70 dark:border-neutral-800/70">
          <HistoryList variant="full" />
        </nav>
      )}
      <div data-testid="assistant-panel" className="mx-auto flex h-full min-h-0 w-full max-w-3xl min-w-0 flex-1 flex-col">
        <AssistantSurface variant="full" />
      </div>
    </div>
  );
}

/* ====================================================================== */
/* Conversation surface                                                    */
/* ====================================================================== */

function AssistantSurface({ variant }: { variant: 'panel' | 'full' }) {
  const s = useStore(assistantStore);
  const online = useStore(onlineStore);
  const navigate = useNavigate();
  const layout = useLayoutMode();
  const titleId = useId();
  useEffect(() => {
    void ensureProviders();
  }, []);
  const showHistory = s.showHistory && (variant === 'panel' || layout === 'compact');
  const available = s.providers?.filter((p) => p.state === 'available') ?? [];
  const noProvider = s.providersState === 'ready' && available.length === 0;

  return (
    <section aria-labelledby={titleId} className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain">
      <header className="flex shrink-0 items-center gap-1 border-b border-neutral-200/70 px-2 py-1.5 dark:border-neutral-800/70">
        {showHistory ? (
          <button type="button" className={ICON_BTN} aria-label="Back to conversation" onClick={() => assistantStore.set((x) => ({ ...x, showHistory: false }))}>
            <ChevronLeft size={18} />
          </button>
        ) : (
          <Sparkles size={16} className="ml-2 shrink-0 text-violet-500" aria-hidden="true" />
        )}
        <h2 id={titleId} className="min-w-0 flex-1 truncate px-1 text-sm font-semibold">
          {showHistory ? 'Conversations' : s.title || 'Assistant'}
        </h2>
        {(variant === 'panel' || layout === 'compact') && (
          <button
            type="button"
            className={ICON_BTN}
            aria-label="Conversation history"
            aria-pressed={s.showHistory}
            onClick={() => assistantStore.set((x) => ({ ...x, showHistory: !x.showHistory }))}
          >
            <History size={17} />
          </button>
        )}
        <button
          type="button"
          className={ICON_BTN}
          aria-label="New conversation"
          onClick={() => {
            newConversation();
            if (variant === 'full') navigate('/ai/chat');
            requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="assistant-input"]')?.focus());
          }}
        >
          <MessageSquarePlus size={17} />
        </button>
        {variant === 'panel' && (
          <button
            type="button"
            className={ICON_BTN}
            aria-label="Open full screen"
            onClick={() => {
              const id = assistantStore.get().conversationId;
              setMode('full');
              navigate(id ? `/ai/chat/${encodeURIComponent(id)}` : '/ai/chat');
            }}
          >
            <Maximize2 size={16} />
          </button>
        )}
        {variant === 'panel' && (
          <button type="button" className={ICON_BTN} aria-label="Close assistant" aria-keyshortcuts="Escape" onClick={closeAssistant}>
            <X size={18} />
          </button>
        )}
      </header>

      <div role="status" aria-live="polite" className="sr-only">
        {s.announce}
      </div>

      {showHistory ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <HistoryList variant={variant} />
        </div>
      ) : (
        <>
          <ProviderBar state={s} />
          <div className="min-h-24 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
            {s.providersState === 'error' && <ProvidersError />}
            {noProvider && <NoProviderState />}
            {s.loadingConversation && (
              <p role="status" className="flex items-center gap-2 py-6 text-sm text-neutral-500">
                <Spinner className="motion-reduce:animate-none" /> Loading conversation…
              </p>
            )}
            {!s.loadingConversation && !s.messages.length && !noProvider && <EmptySuggestions state={s} />}
            <MessageLog state={s} />
            {s.activeRun?.status === 'awaiting_continue' && !s.streaming && (
              <div className="my-3 rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-700">
                <p className="mb-2">A response in this conversation was paused before it finished.</p>
                <Button className="min-h-10" disabled={!online || !s.provider} onClick={() => void continueActiveRun()}>
                  Continue response
                </Button>
              </div>
            )}
            {s.error && <ErrorBanner state={s} />}
          </div>
          <Composer state={s} online={online} />
        </>
      )}
    </section>
  );
}

/* ---------------- provider selection ---------------- */

function ProviderBar({ state: s }: { state: AssistantState }) {
  const p = selectedProvider(s);
  const selectId = useId();
  if (s.providersState !== 'ready' || !s.providers?.length) return null;
  return (
    <div className="shrink-0 space-y-1 border-b border-neutral-100 px-3 py-2 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={selectId} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
          Provider
        </label>
        <select
          id={selectId}
          data-testid="assistant-provider-select"
          value={p?.id ?? ''}
          onChange={(e) => {
            if (e.target.value) selectProvider(e.target.value as ProviderStatus['id']);
          }}
          className="min-h-10 min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-2 text-base sm:text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          <option value="">Choose a provider…</option>
          {s.providers.map((x) => (
            <option key={x.id} value={x.id} disabled={x.state !== 'available'}>
              {x.label}
              {x.state === 'available' ? ` — ${BILLING_LABEL[x.billing]}` : ` — ${STATE_LABEL[x.state]}`}
            </option>
          ))}
        </select>
        {p && p.models.length > 1 && (
          <select
            aria-label={`${p.label} model`}
            value={s.model ?? ''}
            onChange={(e) => selectProvider(p.id, e.target.value)}
            className="min-h-10 max-w-[45%] rounded-lg border border-neutral-200 bg-white px-2 text-base sm:text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {p.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        )}
      </div>
      {p && (
        <p className="text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">{p.label}</span> · {BILLING_LABEL[p.billing]}
          {p.egressHost ? <> · Context you attach is sent to <span className="break-all font-medium">{p.egressHost}</span></> : null}
        </p>
      )}
      {s.providerNotice && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
          {s.providerNotice}
        </p>
      )}
    </div>
  );
}

function ProvidersError() {
  return (
    <div role="alert" className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
      <p>AI providers could not be loaded. The assistant needs a server connection; every workspace feature keeps working without it.</p>
      <Button className="mt-2 min-h-10" onClick={() => void ensureProviders(true)}>
        <RefreshCw size={14} /> Retry
      </Button>
    </div>
  );
}

export function McpUrlCopy() {
  const url = `${location.origin}/mcp`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 break-all rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-900">{url}</code>
      <Button
        className="min-h-10"
        aria-label="Copy MCP URL"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(url)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => setCopied(false));
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

function NoProviderState() {
  return (
    <div className="space-y-3 rounded-xl border border-neutral-200 p-4 text-sm dark:border-neutral-700" data-testid="assistant-no-provider">
      <p className="font-medium">No AI provider is connected</p>
      <p className="text-neutral-600 dark:text-neutral-300">AI is optional — every workspace feature works without it. To use the assistant, choose one:</p>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          Connect your own API key in{' '}
          <Link className="underline" to="/settings#ai-assistant" onClick={closeAssistant}>
            Settings → AI assistant
          </Link>
          . Usage is billed to your API account.
        </li>
        <li>
          Use your ChatGPT plan locally with the TCG Workspace Companion:
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-neutral-100 p-2 text-xs dark:bg-neutral-900">{`node companion/bin/tcg-companion.mjs login\nnode companion/bin/tcg-companion.mjs connect ${location.origin}\nnode companion/bin/tcg-companion.mjs chat`}</pre>
        </li>
        <li>
          Use Claude, ChatGPT or another MCP host with this connector URL. The host’s own subscription and connector rules apply.
          <div className="mt-1">
            <McpUrlCopy />
          </div>
        </li>
      </ol>
    </div>
  );
}

/* ---------------- empty state ---------------- */

function EmptySuggestions({ state: s }: { state: AssistantState }) {
  const kinds = new Set(s.attached.map((r) => r.kind));
  const modules = [...new Set([...s.attached.flatMap((r) => KIND_MODULES[r.kind]), 'search' as const, 'people' as const])];
  const actions = modules
    .flatMap((m) => actionsFor(m))
    .filter((a) => a.context.every((k) => kinds.has(k)))
    .slice(0, 8);
  return (
    <div className="py-4">
      <p className="mb-1 text-sm font-medium">How can I help?</p>
      <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
        Answers cite workspace sources you can read. Proposed changes always wait for your approval.
      </p>
      <ul className="space-y-1.5" aria-label="Suggested actions">
        {actions.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              className="flex min-h-10 w-full items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-left text-sm hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-neutral-400 dark:border-neutral-700 dark:hover:bg-neutral-900"
              onClick={() => openAssistant({ context: a.context.length ? s.attached.filter((r) => a.context.includes(r.kind)) : [], actionId: a.id })}
            >
              <Sparkles size={14} className="shrink-0 text-violet-500" aria-hidden="true" />
              <span className="min-w-0 flex-1">{a.label}</span>
              {a.output === 'proposal' && <span className="text-[10px] text-neutral-500">Review first</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------- messages ---------------- */

function MessageLog({ state: s }: { state: AssistantState }) {
  const end = useRef<HTMLDivElement>(null);
  const lastLen = s.messages.at(-1)?.text.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: 'auto' });
  }, [s.messages.length, lastLen]);
  if (!s.messages.length) return null;
  const lastAssistant = [...s.messages].reverse().find((m) => m.role === 'assistant')?.id;
  return (
    <div role="log" aria-live="off" aria-label="Conversation" aria-busy={s.streaming} className="space-y-4">
      {s.messages.map((m) => (
        <MessageView key={m.id} m={m} state={s} isLastAssistant={m.id === lastAssistant} />
      ))}
      {s.streaming && (
        <p className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <Spinner size={12} className="motion-reduce:animate-none" /> Responding…
        </p>
      )}
      <div ref={end} />
    </div>
  );
}

function MessageView({ m, state: s, isLastAssistant }: { m: AssistantMessage; state: AssistantState; isLastAssistant: boolean }) {
  if (m.role === 'user') {
    return (
      <div data-testid="assistant-message-user" className="ml-8 flex flex-col items-end gap-1">
        {!!m.context?.length && (
          <div className="flex flex-wrap justify-end gap-1">
            {m.context.map((r) => (
              <ContextChip key={contextKey(r)} r={r} small />
            ))}
          </div>
        )}
        <div className="max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-neutral-100 px-3 py-2 text-[15px] leading-6 dark:bg-neutral-800">{m.text}</div>
      </div>
    );
  }
  const streamingThis = s.streaming && isLastAssistant;
  return (
    <article data-testid={`assistant-message-${m.role}`} aria-label={m.role === 'tool' ? 'Tool activity' : 'Assistant response'} className="min-w-0 space-y-2">
      {m.redacted ? (
        <p className="rounded-lg bg-neutral-100 px-3 py-2 text-sm italic text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">Hidden: source access cannot be verified</p>
      ) : (
        m.text && <RichText text={m.text} />
      )}
      {m.toolCalls?.map((c) => <ToolCard key={c.id} call={c} />)}
      {m.incomplete && !m.redacted && (
        <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> Retrieval was partial — some sources were truncated or not searched. Results may be incomplete.
        </p>
      )}
      {!!m.sources?.length && !m.redacted && (
        <div>
          <p className="mb-1 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">Sources</p>
          <ul className="flex flex-wrap gap-1.5">
            {m.sources.map((src, i) => (
              <li key={`${src.id}:${i}`}>
                <SourceChip s={src} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {m.approval && !m.redacted && <ApprovalCard a={m.approval} state={s} />}
      {m.role === 'assistant' && !streamingThis && !m.redacted && m.text.trim() && (
        <MessageActions m={m} target={s.applyTargets[m.id]} apply={s.applyStates[m.id]} canRegenerate={isLastAssistant && !s.streaming && !!s.conversationId} />
      )}
      {(m.provider || m.model) && !streamingThis && (
        <p className="text-[10px] text-neutral-400">
          {[m.provider, m.model].filter(Boolean).join(' · ')}
        </p>
      )}
    </article>
  );
}

function RichText({ text }: { text: string }) {
  const blocks = parseRich(text);
  return (
    <div className="min-w-0 space-y-2 break-words text-[15px] leading-6 text-neutral-800 dark:text-neutral-100">
      {blocks.map((b, i) => {
        if (b.t === 'p')
          return (
            <p key={i}>
              {b.lines.map((l, j) => (
                <span key={j}>
                  {j > 0 && <br />}
                  <Inlines nodes={l} />
                </span>
              ))}
            </p>
          );
        if (b.t === 'h')
          return (
            <p key={i} className="font-semibold">
              <Inlines nodes={b.inl} />
            </p>
          );
        if (b.t === 'code')
          return (
            <pre key={i} className="overflow-x-auto rounded-lg bg-neutral-100 p-2 text-[13px] leading-5 dark:bg-neutral-900">
              <code>{b.text}</code>
            </pre>
          );
        const List = b.t === 'ul' ? 'ul' : 'ol';
        return (
          <List key={i} className={cn('space-y-1 pl-5', b.t === 'ul' ? 'list-disc' : 'list-decimal')}>
            {b.items.map((it, j) => (
              <li key={j}>
                <Inlines nodes={it} />
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) =>
        n.t === 'text' ? (
          <span key={i}>{n.v}</span>
        ) : n.t === 'b' ? (
          <strong key={i}>{n.v}</strong>
        ) : n.t === 'code' ? (
          <code key={i} className="rounded bg-neutral-100 px-1 py-px text-[13px] dark:bg-neutral-800">
            {n.v}
          </code>
        ) : (
          <MentionChip key={i} kind={n.kind} id={n.id} />
        ),
      )}
    </>
  );
}

function MentionChip({ kind, id }: { kind: 'page' | 'user' | 'rec'; id: string }) {
  const title = useLiveQuery(async () => {
    if (kind === 'page') return (await db.pages.get(id))?.title;
    if (kind === 'rec') return (await db.tasks.get(id))?.title;
    return undefined;
  }, [kind, id]);
  if (kind === 'user') return <span className="rounded bg-blue-50 px-1 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">@member</span>;
  const to = kind === 'page' ? `/pages/${encodeURIComponent(id)}` : `/tasks/${encodeURIComponent(id)}`;
  return (
    <Link to={to} className="rounded bg-blue-50 px-1 text-blue-700 underline-offset-2 hover:underline dark:bg-blue-950/60 dark:text-blue-300">
      {String(title ?? '') || (kind === 'page' ? 'Page' : 'Record')}
    </Link>
  );
}

function SourceChip({ s }: { s: SourceRef }) {
  const path = sourcePath(s);
  const label = s.title?.trim() || `${s.type} ${s.id.slice(0, 8)}`;
  const cls = 'inline-flex min-h-10 max-w-[16rem] items-center gap-1 rounded-full border border-neutral-200 px-2.5 py-1 text-xs dark:border-neutral-700';
  return path ? (
    <Link data-testid="assistant-source-chip" to={path} className={cn(cls, 'hover:bg-neutral-50 dark:hover:bg-neutral-900')} title={label}>
      <FileText size={12} className="shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </Link>
  ) : (
    <span data-testid="assistant-source-chip" className={cls} title={label}>
      <FileText size={12} className="shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}

const TOOL_STATUS: Record<ToolCallView['status'], string> = {
  pending: 'Queued',
  running: 'Running…',
  done: 'Done',
  error: 'Failed',
  awaiting_approval: 'Waiting for your approval',
};

function ToolCard({ call }: { call: ToolCallView }) {
  return (
    <div data-testid="assistant-tool-card" className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-2.5 text-xs dark:border-neutral-800 dark:bg-neutral-900/50">
      <div className="flex flex-wrap items-center gap-1.5">
        <Wrench size={12} className="shrink-0 text-neutral-500" aria-hidden="true" />
        <span className="break-all font-medium">{call.name}</span>
        <span className={cn('rounded-full px-1.5 py-px text-[10px] font-medium', call.kind === 'read' ? 'bg-neutral-200/70 dark:bg-neutral-800' : 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300')}>
          {call.kind === 'read' ? 'Read' : call.kind === 'write' ? 'Write' : 'Proposal'}
        </span>
        <span className="ml-auto flex items-center gap-1 text-neutral-600 dark:text-neutral-300">
          {call.status === 'running' && <Spinner size={11} className="motion-reduce:animate-none" />}
          {call.status === 'done' && <Check size={12} aria-hidden="true" />}
          {call.status === 'error' && <AlertTriangle size={12} className="text-red-600" aria-hidden="true" />}
          {TOOL_STATUS[call.status]}
        </span>
      </div>
      <p className="mt-1 break-words text-neutral-500 dark:text-neutral-400">
        <span className="sr-only">Capability: </span>
        {call.capability}
        {call.argsSummary ? ` · ${call.argsSummary}` : ''}
      </p>
      {call.resultSummary && <p className="mt-1 break-words text-neutral-700 dark:text-neutral-200">{call.resultSummary}</p>}
      {call.error && <p className="mt-1 break-words text-red-700 dark:text-red-400">{call.error}</p>}
    </div>
  );
}

function ApprovalCard({ a, state: s }: { a: ApprovalView; state: AssistantState }) {
  const online = useStore(onlineStore);
  const st = s.approvals[a.previewId];
  const busy = st?.phase === 'busy';
  const done = st && st.phase !== 'busy' && st.phase !== 'error';
  const review = safeInternalPath(a.reviewUrl) ?? `/ai/review/${encodeURIComponent(a.previewId)}`;
  const imp = a.impact;
  return (
    <div data-testid="assistant-approval-card" role="group" aria-label="Proposed change awaiting approval" className="rounded-xl border border-violet-200 bg-violet-50/50 p-3 text-sm dark:border-violet-900/50 dark:bg-violet-950/20">
      <p className="font-medium">Proposed change needs your approval</p>
      <p className="mt-0.5 break-all text-xs text-neutral-600 dark:text-neutral-300">Operation: {a.tool}</p>
      {imp && previewImpactText(imp).map(line=><p key={line} className="mt-1 text-xs">{line}</p>)}
      {imp?.irreversible && (
        <p className="mt-1 flex items-start gap-1 text-xs font-semibold text-red-700 dark:text-red-400">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> Includes an irreversible step (attachment bytes are permanently reclaimed). Undo cannot recover them.
        </p>
      )}
      {imp?.warnings?.map((w) => (
        <p key={w} className="mt-1 text-xs text-amber-800 dark:text-amber-300">
          {w}
        </p>
      ))}
      {!done && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button data-testid="assistant-approve" variant="primary" className="min-h-10" disabled={busy || !online} onClick={() => void approveAndExecute(a)}>
            Approve &amp; execute
          </Button>
          <Button className="min-h-10" disabled={busy || !online} onClick={() => void cancelApproval(a)}>
            Cancel
          </Button>
          <Link to={review} className="inline-flex min-h-10 items-center gap-1 px-1 text-xs underline">
            Open full review <ExternalLink size={11} aria-hidden="true" />
          </Link>
        </div>
      )}
      {!online && !done && <p className="mt-1 text-xs text-neutral-500">Reconnect to review this proposal against current server revisions.</p>}
      {st?.message && (
        <p role="status" className={cn('mt-2 text-xs', st.phase === 'error' ? 'text-red-700 dark:text-red-400' : 'text-neutral-700 dark:text-neutral-200')}>
          {st.message}
        </p>
      )}
      {st?.changesetId && (
        <p className="mt-1 break-all text-xs">
          Changeset {st.changesetId} ·{' '}
          <Link className="underline" to={`/ai/undo/${encodeURIComponent(st.changesetId)}`}>
            Review or undo
          </Link>
          {st.phase === 'partial' && (
            <>
              {' '}
              ·{' '}
              <Link className="underline" to={review}>
                Resume in full review
              </Link>
            </>
          )}
        </p>
      )}
    </div>
  );
}

function MessageActions({ m, target, apply = { state: 'idle' }, canRegenerate }: { m: AssistantMessage; target?: SelectionTarget; apply?: ApplyState | { state: 'idle'; editorId?: undefined }; canRegenerate: boolean }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const setApply = (a: ApplyState) => setApplyState(m.id, a);
  const online = useStore(onlineStore);
  const copy = () =>
    void (navigator.clipboard?.writeText(m.text) ?? Promise.reject(new Error('no clipboard')))
      .then(() => setCopied('ok'))
      .catch(() => setCopied('fail'))
      .finally(() => setTimeout(() => setCopied('idle'), 2000));
  const btn = 'inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-neutral-400 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-800';
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        {target && (
          <button
            type="button"
            data-testid="assistant-apply-selection"
            className={cn(btn, 'bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200')}
            disabled={apply.state === 'busy' || apply.state === 'applied'}
            onClick={() => {
              setApply({ state: 'busy' });
              void applyToSelection(target, m.text)
                .then((r) => setApply(r.status === 'applied' ? { state: 'applied', editorId: r.editorId } : { state: r.status === 'changed' ? 'changed' : 'error' }))
                .catch(() => setApply({ state: 'error' }));
            }}
          >
            <Check size={13} aria-hidden="true" /> {apply.state === 'applied' ? 'Applied' : 'Apply to selection'}
          </button>
        )}
        <button type="button" className={btn} onClick={copy} aria-label="Copy response">
          {copied === 'ok' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />} {copied === 'ok' ? 'Copied' : 'Copy'}
        </button>
        {canRegenerate && (
          <button type="button" className={btn} disabled={!online} onClick={() => void regenerate()}>
            <RefreshCw size={13} aria-hidden="true" /> Regenerate
          </button>
        )}
      </div>
      <div role="status" className="text-xs">
        {copied === 'fail' && <span className="text-red-700 dark:text-red-400">Copy failed — select the text and copy it manually.</span>}
        {apply.state === 'changed' && <span className="text-amber-700 dark:text-amber-400">Text changed since selection; copy instead.</span>}
        {apply.state === 'error' && <span className="text-red-700 dark:text-red-400">Could not apply — the block is no longer available. Copy instead.</span>}
        {apply.state === 'applied' && (
          <span className="flex flex-wrap items-center gap-2">
            Applied as a normal synced edit to this block. Ctrl/⌘+Z in the editor does not revert it — use Undo apply here.
            <button
              type="button"
              className={btn}
              onClick={() => {
                if (!apply.editorId) return;
                void undoApply(apply.editorId).then((r) => setApply({ state: r.status === 'conflict' ? 'conflict' : 'undone' }));
              }}
            >
              Undo apply
            </button>
          </span>
        )}
        {apply.state === 'undone' && <span>Apply undone.</span>}
        {apply.state === 'conflict' && <span className="text-amber-700 dark:text-amber-400">The block changed after applying, so undo was not replayed. The previous text was kept as a draft.</span>}
      </div>
    </div>
  );
}

/* ---------------- errors ---------------- */

function ErrorBanner({ state: s }: { state: AssistantState }) {
  const e = s.error!;
  const p = selectedProvider(s);
  const manage = e.code === 'provider_usage_limit' ? p?.manageUsageUrl : undefined;
  const manageSafe = manage && /^https:\/\//.test(manage) ? manage : safeInternalPath(manage);
  const retryable = e.retryable && e.code !== 'access_changed' && e.code !== 'no_provider';
  return (
    <div role="alert" className="my-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
      <p className="flex items-start gap-1.5">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>{errorText(e.code, e.message)}</span>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {retryable && (
          <Button className="min-h-10" disabled={s.streaming} onClick={retry}>
            <RefreshCw size={14} /> Retry
          </Button>
        )}
        {manageSafe && (
          <a className="inline-flex min-h-10 items-center gap-1 underline" href={manageSafe} target="_blank" rel="noopener noreferrer">
            Manage usage <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
        {(e.code === 'provider_auth_failed' || e.code === 'provider_not_eligible') && (
          <Link className="inline-flex min-h-10 items-center underline" to="/settings#ai-assistant" onClick={closeAssistant}>
            AI assistant settings
          </Link>
        )}
        <Button variant="ghost" className="min-h-10" onClick={dismissError}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/* ---------------- composer ---------------- */

function ContextChip({ r, onRemove, small }: { r: ContextRef; onRemove?: () => void; small?: boolean }) {
  const title = useContextTitle(r);
  const path = contextPath(r);
  const kind = contextKindLabel(r);
  const body = (
    <>
      <span className="font-medium">{kind}:</span>
      <span className="min-w-0 truncate">{title}</span>
    </>
  );
  return (
    <span
      data-testid="assistant-context-chip"
      className={cn('inline-flex max-w-full items-center gap-1 rounded-full border border-neutral-200 bg-white text-xs dark:border-neutral-700 dark:bg-neutral-900', small ? 'px-2 py-0.5' : 'min-h-10 pl-2.5')}
    >
      {path && !onRemove && !small ? (
        <Link to={path} className="inline-flex min-w-0 items-center gap-1 hover:underline">
          {body}
        </Link>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-1">{body}</span>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${kind.toLowerCase()} ${title} from context`} className="inline-flex h-10 w-10 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-white">
          <X size={13} />
        </button>
      )}
    </span>
  );
}

function AddCurrentContext({ attached }: { attached: ContextRef[] }) {
  const current = useStore(assistantContextStore);
  const selection = useStore(assistantSelectionStore);
  const keys = new Set(attached.map(contextKey));
  const offers = [selection, current].filter((r): r is ContextRef => !!r && !keys.has(contextKey(r)));
  if (!offers.length || attached.length >= MAX_CONTEXT_REFS) return null;
  return (
    <>
      {offers.map((r) => (
        <AddChip key={contextKey(r)} r={r} />
      ))}
    </>
  );
}

function AddChip({ r }: { r: ContextRef }) {
  const title = useContextTitle(r);
  const kind = r.kind === 'record' ? 'record' : r.kind === 'selection' ? 'selection' : contextKindLabel(r).toLowerCase();
  return (
    <button
      type="button"
      onClick={() => addContext(r)}
      className="inline-flex min-h-10 max-w-full items-center gap-1 rounded-full border border-dashed border-neutral-300 px-2.5 text-xs text-neutral-600 hover:bg-neutral-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-900"
    >
      + Add current {kind}
      <span className="min-w-0 truncate text-neutral-400">{title}</span>
    </button>
  );
}

function Composer({ state: s, online }: { state: AssistantState; online: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const actionButton = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  const action = s.actionId ? aiAction(s.actionId) : undefined;
  const p = selectedProvider(s);
  // Focus the composer when the surface opens (Overlay also honors data-autofocus).
  useEffect(() => {
    requestAnimationFrame(() => input.current?.focus());
  }, []);
  // Grow with content up to a bound.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    // Long drafts can exceed the keyboard-shrunk visual viewport. The surface
    // scrolls its chrome rather than clipping the primary Send/Stop action.
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === el) actionButton.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [s.draft]);
  // Keyboard/toolbars can resize the sheet without changing the draft.
  useEffect(() => {
    const surface = input.current?.closest('section');
    if (!surface) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (document.activeElement === input.current) actionButton.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    });
    observer.observe(surface);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  const sendable = canSend(s) && online;
  const reason = !online
    ? 'You are offline. Sending is disabled; your workspace keeps working offline.'
    : !p
      ? 'Choose an available provider to send.'
      : '';
  return (
    <div className="shrink-0 border-t border-neutral-200/70 px-3 pb-3 pt-2 dark:border-neutral-800/70">
      {(s.attached.length > 0 || action) && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label="Attached context">
          {action && (
            <span className="inline-flex min-h-10 items-center gap-1 rounded-full bg-violet-100 pl-2.5 text-xs text-violet-800 dark:bg-violet-950/60 dark:text-violet-200">
              <Sparkles size={12} aria-hidden="true" /> {action.label}
              <button type="button" aria-label={`Remove action ${action.label}`} onClick={clearAction} className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-violet-200/60 dark:hover:bg-violet-900/60">
                <X size={13} />
              </button>
            </span>
          )}
          {s.attached.map((r) => (
            <ContextChip key={contextKey(r)} r={r} onRemove={() => removeContext(r)} />
          ))}
        </div>
      )}
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        <AddCurrentContext attached={s.attached} />
      </div>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          // The send button is replaced by Stop while streaming; keep focus in the
          // composer so keyboard users (and Escape) stay inside the assistant.
          (e.currentTarget.querySelector('textarea') as HTMLTextAreaElement | null)?.focus();
          if (sendable) void sendMessage();
        }}
      >
        <label className="sr-only" htmlFor={`${hintId}-input`}>
          Message the assistant
        </label>
        <textarea
          id={`${hintId}-input`}
          ref={input}
          data-testid="assistant-input"
          data-autofocus
          rows={1}
          value={s.draft}
          maxLength={MAX_MESSAGE_CHARS}
          style={{ maxHeight: 'clamp(44px, calc(var(--vvh, 100dvh) - 64px), 200px)' }}
          aria-describedby={hintId}
          placeholder={action ? (action.id === 'selection_explain' ? 'Ask about the selection…' : 'Add details (optional)…') : 'Ask anything about your workspace…'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (sendable) void sendMessage();
            }
          }}
          className="max-h-[200px] min-h-11 min-w-0 flex-1 resize-none rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-base leading-6 placeholder:text-neutral-400 focus:border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:ring-white/10"
        />
        {s.streaming ? (
          <button ref={actionButton} type="button" data-testid="assistant-stop" onClick={stop} aria-label="Stop response" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900">
            <Square size={15} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button ref={actionButton} type="submit" data-testid="assistant-send" disabled={!sendable} aria-label="Send message" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-40 dark:bg-white dark:text-neutral-900">
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        )}
      </form>
      <p id={hintId} className="mt-1.5 text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">
        {reason || (p?.egressHost ? `Context you attach is sent to ${p.egressHost}. ` : '')}
        {!reason && <span className="hidden sm:inline">Enter to send · Shift+Enter for a new line · Ctrl/⌘+J to toggle</span>}
      </p>
    </div>
  );
}

/* ---------------- history ---------------- */

function HistoryList({ variant }: { variant: 'panel' | 'full' }) {
  const s = useStore(assistantStore);
  const navigate = useNavigate();
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; title: string } | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    void loadConversations();
  }, []);
  const open = (id: string) => {
    if (variant === 'full') navigate(`/ai/chat/${encodeURIComponent(id)}`);
    else void openConversation(id);
  };
  let body: ReactNode;
  if (s.conversationsState === 'error')
    body = (
      <div role="alert" className="p-3 text-sm">
        <p>Conversations need a server connection.</p>
        <Button className="mt-2 min-h-10" onClick={() => void loadConversations()}>
          Retry
        </Button>
      </div>
    );
  else if (!s.conversations) body = <p className="p-3 text-sm text-neutral-500">Loading…</p>;
  else if (!s.conversations.length) body = <p className="p-3 text-sm text-neutral-500">No conversations yet.</p>;
  else
    body = (
      <ul className="space-y-0.5 p-1.5">
        {s.conversations.map((c) => (
          <li key={c.id} className={cn('group flex items-center gap-1 rounded-lg', c.id === s.conversationId && 'bg-neutral-100 dark:bg-neutral-800')}>
            {editing?.id === c.id ? (
              <form
                className="flex min-w-0 flex-1 items-center gap-1 p-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  void renameConversation(c.id, editing.title)
                    .then(() => setMessage('Conversation renamed.'))
                    .catch(() => setMessage('Rename failed. Reconnect and retry.'))
                    .finally(() => setEditing(null));
                }}
              >
                <input
                  autoFocus
                  aria-label="Conversation title"
                  value={editing.title}
                  maxLength={120}
                  onChange={(e) => setEditing({ id: c.id, title: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setEditing(null);
                    }
                  }}
                  className="min-h-10 min-w-0 flex-1 rounded-lg border border-neutral-200 px-2 text-base sm:text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
                <Button type="submit" className="min-h-10">
                  Save
                </Button>
              </form>
            ) : (
              <>
                <button type="button" onClick={() => open(c.id)} aria-current={c.id === s.conversationId ? 'true' : undefined} className="min-h-10 min-w-0 flex-1 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
                  <span className="block truncate">{c.title || 'Untitled conversation'}</span>
                  <span className="block text-[11px] text-neutral-500">{new Date(c.updatedAt).toLocaleString()}</span>
                </button>
                <button type="button" className={ICON_BTN} aria-label={`Rename ${c.title || 'conversation'}`} onClick={() => setEditing({ id: c.id, title: c.title })}>
                  <Pencil size={14} />
                </button>
                <button type="button" className={ICON_BTN} aria-label={`Delete ${c.title || 'conversation'}`} onClick={() => setConfirm({ id: c.id, title: c.title })}>
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {variant === 'full' && (
        <div className="flex items-center gap-2 border-b border-neutral-200/70 p-2 dark:border-neutral-800/70">
          <h2 className="flex-1 px-1 text-sm font-semibold">Conversations</h2>
          <Link to="/ai" className="inline-flex min-h-10 items-center px-2 text-xs underline">
            AI workflows
          </Link>
        </div>
      )}
      {body}
      <p role="status" className="sr-only">
        {message}
      </p>
      {s.retentionDays ? <p className="px-3 pb-3 text-[11px] text-neutral-500">Conversations are deleted after {s.retentionDays} days. Change this in Settings → AI assistant.</p> : null}
      {confirm && (
        <Dialog title="Delete conversation?" onClose={() => setConfirm(null)}>
          <p className="text-sm text-neutral-600 dark:text-neutral-300">“{confirm.title || 'Untitled conversation'}” will be permanently deleted. Workspace records are not affected.</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" className="min-h-10" onClick={() => setConfirm(null)}>
              Keep
            </Button>
            <Button
              variant="danger"
              className="min-h-10"
              onClick={() => {
                const id = confirm.id;
                setConfirm(null);
                void deleteConversation(id)
                  .then(() => {
                    setMessage('Conversation deleted.');
                    if (variant === 'full' && id === assistantStore.get().conversationId) navigate('/ai/chat');
                  })
                  .catch(() => setMessage('Delete failed. Reconnect and retry.'));
              }}
            >
              Delete
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
