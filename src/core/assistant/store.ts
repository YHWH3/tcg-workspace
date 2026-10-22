/* Embedded assistant UI state (client only).
 *
 * - Panel/full mode, the active conversation, streamed messages, run/approval
 *   state and the composer draft live in memory and are reset whenever the
 *   signed-in user changes (another account on this device must never see the
 *   previous user's chat).
 * - Only the chosen provider/model id is persisted (localStorage, per user):
 *   never credentials, never message content.
 * - Context registry: surfaces publish their current object with
 *   `useAssistantContext(ref)` / `setAssistantContext(ref)`; opening the panel
 *   globally offers exactly ONE removable chip (the editor selection when one
 *   is active, else the current object). Nothing else is attached implicitly.
 * - Provider choice never changes silently: if the remembered provider is no
 *   longer available the user must choose again, and errors never fall back to
 *   another provider. */
import { useEffect } from 'react';
import {
  ASSISTANT_API,
  MAX_CONTEXT_REFS,
  MAX_MESSAGE_CHARS,
  MAX_SELECTION_CHARS,
  type ApprovalView,
  type AssistantErrorCode,
  type AssistantEvent,
  type AssistantMessage,
  type ContextRef,
  type ConversationDetail,
  type ConversationSummary,
  type ProviderId,
  type ProviderStatus,
} from '../../../shared/assistantProtocol';
import { aiAction } from '../../../shared/aiActions';
import { api, ApiError, getToken } from '../api';
import { authStore } from '../auth';
import { accessClientStore } from '../accessClient';
import { createStore } from '../store';
import { cancelRun, streamRun, type StreamRequest } from './client';
import { canTargetSelection } from './applyPlan';

export type PanelMode = 'closed' | 'panel' | 'full';
export type SelectionRef = Extract<ContextRef, { kind: 'selection' }>;

export interface SelectionTarget {
  pageId: string;
  blockId: string;
  /** Token-serialized original selection (exact substring of the block text). */
  text: string;
  actionId: string;
}

export interface UiError {
  code: AssistantErrorCode | 'offline' | 'no_provider';
  message: string;
  retryable: boolean;
}

/** Per-message "Apply to selection" progress — kept here so remounts keep the Undo control. */
export interface ApplyState {
  state: 'busy' | 'applied' | 'changed' | 'error' | 'undone' | 'conflict';
  editorId?: string;
}

export interface ApprovalState {
  phase: 'busy' | 'executed' | 'partial' | 'cancelled' | 'error';
  changesetId?: string;
  message?: string;
}

export interface AssistantState {
  userId: string | null;
  mode: PanelMode;
  showHistory: boolean;
  conversationId: string | null;
  title: string;
  messages: AssistantMessage[];
  loadingConversation: boolean;
  activeRun: ConversationDetail['activeRun'];
  streaming: boolean;
  runId: string | null;
  /** Polite status announcement (start/completion only — never per token). */
  announce: string;
  error: UiError | null;
  attached: ContextRef[];
  draft: string;
  actionId: string | null;
  providers: ProviderStatus[] | null;
  providersState: 'idle' | 'loading' | 'ready' | 'error';
  providerNotice: string | null;
  retentionDays: number | null;
  provider: ProviderId | null;
  model: string | null;
  conversations: ConversationSummary[] | null;
  conversationsState: 'idle' | 'loading' | 'ready' | 'error';
  /** assistant message id → selection it may be applied to (this session only). */
  applyTargets: Record<string, SelectionTarget>;
  applyStates: Record<string, ApplyState>;
  approvals: Record<string, ApprovalState>;
}

const initial = (userId: string | null): AssistantState => ({
  userId,
  mode: 'closed',
  showHistory: false,
  conversationId: null,
  title: '',
  messages: [],
  loadingConversation: false,
  activeRun: null,
  streaming: false,
  runId: null,
  announce: '',
  error: null,
  attached: [],
  draft: '',
  actionId: null,
  providers: null,
  providersState: 'idle',
  providerNotice: null,
  retentionDays: null,
  provider: null,
  model: null,
  conversations: null,
  conversationsState: 'idle',
  applyTargets: {},
  applyStates: {},
  approvals: {},
});

export const assistantStore = createStore<AssistantState>(initial(authStore.get().user?.id ?? null));
const patch = (p: Partial<AssistantState> | ((s: AssistantState) => Partial<AssistantState>)) =>
  assistantStore.set((s) => ({ ...s, ...(typeof p === 'function' ? p(s) : p) }));

/* ---------------- per-run bookkeeping (not rendered) ---------------- */

let controller: AbortController | null = null;
/** Bumped whenever a stream must stop writing into state (reset/switch). */
let streamGen = 0;
let opener: HTMLElement | null = null;
/** Selection a pending rewrite action targets (set on open, consumed on send). */
let pendingTarget: SelectionTarget | null = null;
let lastRequest: { text: string; attached: ContextRef[]; actionId: string | null; target: SelectionTarget | null } | null = null;

function abortLocal(): void {
  streamGen++;
  controller?.abort();
  controller = null;
}

/** Bind every asynchronous UI continuation to identity, session and access.
 * Abort is advisory; the generation/token checks also reject late responses. */
const accessUsable = () => ['ready', 'offline'].includes(accessClientStore.get().status);
function currentRequest(): () => boolean {
  const uid=assistantStore.get().userId, token=getToken();
  const {epoch,status}=accessClientStore.get();
  return ()=>assistantStore.get().userId===uid&&getToken()===token&&accessClientStore.get().epoch===epoch&&accessClientStore.get().status===status&&accessUsable();
}
let boundToken=getToken();

/* ---------------- context registry ---------------- */

const contextStack: { token: symbol; ref: ContextRef }[] = [];
const MANUAL = Symbol('manual');
/** The object the user is currently looking at (top of the registry). */
export const assistantContextStore = createStore<ContextRef | null>(null);
/** The active page-editor selection, if any (published by the selection menu). */
export const assistantSelectionStore = createStore<SelectionRef | null>(null);

function clearSensitive(preservePlainDraft:boolean):void {
  const s=assistantStore.get();
  const plain=preservePlainDraft&&!s.actionId&&!s.attached.length&&!pendingTarget?s.draft:'';
  abortLocal();pendingTarget=null;lastRequest=null;opener=null;
  contextStack.length=0;assistantContextStore.set(null);assistantSelectionStore.set(null);
  const hadSensitive=!!(s.messages.length||s.conversationId||s.attached.length||s.actionId||s.streaming||s.conversations?.length);
  assistantStore.set({...initial(authStore.get().user?.id??null),draft:plain,mode:s.mode,
    providers:s.providers,providersState:s.providersState==='loading'?'idle':s.providersState,retentionDays:s.retentionDays,
    provider:s.provider,model:s.model,error:preservePlainDraft&&hadSensitive?{code:'access_changed',message:'Access changed. Reopen the conversation to check its current sources.',retryable:false}:null});
}
authStore.subscribe(()=>{
  const uid=authStore.get().user?.id??null,token=getToken();
  if(uid===assistantStore.get().userId&&token===boundToken)return;
  boundToken=token;clearSensitive(false);assistantStore.set(initial(uid));
});
let accessSnapshot=accessClientStore.get();
accessClientStore.subscribe(()=>{
  const next=accessClientStore.get(),changed=next.epoch!==accessSnapshot.epoch||next.status!==accessSnapshot.status;
  accessSnapshot=next;
  if(changed)clearSensitive(true);
});


function publishContext(): void {
  assistantContextStore.set(contextStack.length ? contextStack[contextStack.length - 1].ref : null);
}

/** Imperative registration (replaces any previous manual entry). */
export function setAssistantContext(ref: ContextRef | null): void {
  const i = contextStack.findIndex((e) => e.token === MANUAL);
  if (i >= 0) contextStack.splice(i, 1);
  if (ref && accessUsable()) contextStack.push({ token: MANUAL, ref });
  publishContext();
}

export function pushAssistantContext(ref: ContextRef): () => void {
  if(!accessUsable())return ()=>{};
  const token = Symbol('ctx');
  contextStack.push({ token, ref });
  publishContext();
  return () => {
    const i = contextStack.findIndex((e) => e.token === token);
    if (i >= 0) contextStack.splice(i, 1);
    publishContext();
  };
}

export const contextKey = (r: ContextRef): string =>
  r.kind === 'dashboard' ? 'dashboard' : r.kind === 'selection' ? `selection:${r.blockId ?? ''}:${r.text}` : `${r.kind}:${r.id}`;

/** Surfaces call this with their current object; null/undefined registers nothing. */
export function useAssistantContext(ref: ContextRef | null | undefined): void {
  const key = ref ? JSON.stringify(ref) : '';
  useEffect(() => {
    if (!key) return;
    return pushAssistantContext(JSON.parse(key) as ContextRef);
  }, [key]);
}

export function setAssistantSelection(sel: SelectionRef | null): void {
  if(sel&&!accessUsable())return;
  const cur = assistantSelectionStore.get();
  if (cur === sel || (cur && sel && contextKey(cur) === contextKey(sel))) return;
  assistantSelectionStore.set(sel);
}

/* ---------------- provider preference (id only) ---------------- */

const prefKey = (uid: string) => `tcg.assistant.provider.${uid}`;

function readPref(uid: string | null): { provider: string; model?: string } | null {
  if (!uid) return null;
  try {
    const v = JSON.parse(localStorage.getItem(prefKey(uid)) ?? 'null') as unknown;
    if (v && typeof v === 'object' && typeof (v as { provider?: unknown }).provider === 'string') {
      const m = (v as { model?: unknown }).model;
      return { provider: (v as { provider: string }).provider, model: typeof m === 'string' ? m : undefined };
    }
  } catch {
    /* storage unavailable */
  }
  return null;
}

function writePref(uid: string | null, provider: string, model: string | null): void {
  if (!uid) return;
  try {
    localStorage.setItem(prefKey(uid), JSON.stringify({ provider, ...(model ? { model } : {}) }));
  } catch {
    /* storage unavailable — choice lasts for this session */
  }
}

function pickModel(p: ProviderStatus, wanted?: string | null): string | null {
  if (wanted && p.models.some((m) => m.id === wanted)) return wanted;
  return p.defaultModel ?? p.models[0]?.id ?? null;
}

/** Pure-ish resolution of the selected provider: never silently switches payer. */
function resolveProvider(providers: ProviderStatus[], uid: string | null, current: ProviderId | null, currentModel: string | null) {
  const pref = current ? { provider: current, model: currentModel ?? undefined } : readPref(uid);
  if (pref) {
    const p = providers.find((x) => x.id === pref.provider);
    if (p && p.state === 'available') return { provider: p.id, model: pickModel(p, pref.model), notice: null };
    return {
      provider: null,
      model: null,
      notice: `${p?.label ?? 'Your previously selected provider'} is not available${p?.reason ? ` (${p.reason})` : ''}. Choose a provider to continue — no other provider is used automatically.`,
    };
  }
  // No prior choice: only preselect a provider that does not bill the user.
  const free = providers.find((p) => p.state === 'available' && (p.billing === 'none' || p.billing === 'operator_budget'));
  if (free) return { provider: free.id, model: pickModel(free), notice: null };
  return { provider: null, model: null, notice: null };
}

export async function ensureProviders(force = false): Promise<void> {
  const s = assistantStore.get();
  if (!force && (s.providersState === 'ready' || s.providersState === 'loading')) return;
  const uid = s.userId, current=currentRequest();
  if(!accessUsable())return;
  patch({ providersState: 'loading' });
  try {
    const r = await api<{ providers: ProviderStatus[]; retentionDays?: number }>(`${ASSISTANT_API}/providers`);
    if (assistantStore.get().userId !== uid || !current()) return;
    const providers = Array.isArray(r.providers) ? r.providers : [];
    const cur = assistantStore.get();
    const sel = resolveProvider(providers, uid, cur.provider, cur.model);
    patch({ providers, providersState: 'ready', retentionDays: r.retentionDays ?? null, provider: sel.provider, model: sel.model, providerNotice: sel.notice });
  } catch {
    if (assistantStore.get().userId !== uid || !current()) return;
    patch({ providersState: 'error' });
  }
}

/** Explicit user choice — the only way a provider becomes selected besides a no-cost default. */
export function selectProvider(id: ProviderId, model?: string | null): void {
  const s = assistantStore.get();
  const p = s.providers?.find((x) => x.id === id);
  if (!p || p.state !== 'available') return;
  const m = pickModel(p, model ?? null);
  writePref(s.userId, p.id, m);
  patch({ provider: p.id, model: m, providerNotice: null, error: s.error?.code === 'no_provider' ? null : s.error });
}

export function selectedProvider(s: AssistantState = assistantStore.get()): ProviderStatus | null {
  return s.providers?.find((p) => p.id === s.provider) ?? null;
}

/* ---------------- open / close ---------------- */

const NEEDS_INPUT = new Set(['selection_explain', 'search_answer']);

export interface OpenOptions {
  /** Explicit context; omitted → exactly one chip (selection or current object). */
  context?: ContextRef[];
  actionId?: string;
  prompt?: string;
  /** Element focus returns to on close (defaults to the focused element). */
  opener?: HTMLElement | null;
  /** false = never send automatically (the user presses Send next to the disclosure). */
  autoSend?: boolean;
}

function clipContext(refs: ContextRef[]): ContextRef[] {
  const seen = new Set<string>();
  const out: ContextRef[] = [];
  for (const r of refs) {
    const k = contextKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r.kind === 'selection' ? { ...r, text: r.text.slice(0, MAX_SELECTION_CHARS) } : r);
    if (out.length >= MAX_CONTEXT_REFS) break;
  }
  return out;
}

export function openAssistant(opts: OpenOptions = {}): void {
  if(!accessUsable())return;
  const s = assistantStore.get();
  const active = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  // Remember where focus returns on close — only when opening (an action picked
  // inside the open panel must not replace the original opener).
  if (opts.opener || s.mode === 'closed') opener = opts.opener ?? (active && active !== document.body ? active : null);
  const sel = assistantSelectionStore.get();
  const currentContext = assistantContextStore.get();
  const raw = opts.context ?? (sel ? [sel] : currentContext ? [currentContext] : []);
  const attached = clipContext(raw);
  const action = opts.actionId ? aiAction(opts.actionId) : undefined;
  // Judge the target on the UNclipped selection: a truncated one is never applicable.
  const selRef = raw.find((r): r is SelectionRef => r.kind === 'selection');
  pendingTarget =
    action && action.output === 'rewrite' && selRef?.pageId && selRef.blockId && canTargetSelection(selRef.text)
      ? { pageId: selRef.pageId, blockId: selRef.blockId, text: selRef.text, actionId: action.id }
      : null;
  // Only auto-send when the provider (and its egress disclosure) was already
  // known when the user clicked.
  const autoSend = opts.autoSend !== false && s.providersState === 'ready';
  const mode: PanelMode = s.mode === 'full' ? 'full' : 'panel';
  if (action) {
    // A contextual action starts a fresh conversation so it never mixes with unrelated chat.
    if (s.streaming) stop();
    abortLocal();
    patch({ ...freshConversation(), mode, showHistory: false, attached, actionId: action.id, draft: opts.prompt ?? '' });
  } else {
    patch({ mode, showHistory: false, attached: opts.context || s.mode === 'closed' ? attached : s.attached, ...(opts.prompt !== undefined ? { draft: opts.prompt } : {}) });
  }
  if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="assistant-input"]')?.focus());
  const current=currentRequest();
  void ensureProviders().then(() => {
    const st = assistantStore.get();
    if (!current())return;
    if (autoSend && action && st.actionId === action.id && !(NEEDS_INPUT.has(action.id) && !opts.prompt) && canSend(st)) void sendMessage();
  });
}

export function closeAssistant(): void {
  if (assistantStore.get().mode === 'closed') return;
  patch({ mode: 'closed' });
  const el = opener;
  opener = null;
  if (el) requestAnimationFrame(() => el.isConnected && el.focus());
}

export function toggleAssistant(): void {
  const m = assistantStore.get().mode;
  if (m === 'panel') closeAssistant();
  else if (m === 'closed') openAssistant();
}

export function setMode(mode: PanelMode): void {
  patch({ mode });
}

/* ---------------- composer ---------------- */

export const setDraft = (draft: string) => patch({ draft: draft.slice(0, MAX_MESSAGE_CHARS) });
export const clearAction = () => {
  pendingTarget = null;
  patch({ actionId: null });
};
export function removeContext(ref: ContextRef): void {
  const k = contextKey(ref);
  if (ref.kind === 'selection') pendingTarget = null;
  patch((s) => ({ attached: s.attached.filter((r) => contextKey(r) !== k) }));
}
export function addContext(ref: ContextRef): void {
  patch((s) => ({ attached: clipContext([...s.attached, ref]) }));
}

export function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

export function canSend(s: AssistantState = assistantStore.get()): boolean {
  return accessUsable() && !s.streaming && !!s.provider && isOnline() && !!(s.draft.trim() || s.actionId);
}

/* ---------------- conversations ---------------- */

function freshConversation(): Partial<AssistantState> {
  return { conversationId: null, title: '', messages: [], activeRun: null, runId: null, error: null, streaming: false, announce: '', applyTargets: {}, applyStates: {}, approvals: {}, actionId: null };
}

export function newConversation(): void {
  if (assistantStore.get().streaming) stop();
  abortLocal();
  pendingTarget = null;
  patch({ ...freshConversation(), showHistory: false, draft: '' });
}

export async function loadConversations(): Promise<void> {
  if(!accessUsable())return;
  const uid = assistantStore.get().userId,current=currentRequest();
  patch({ conversationsState: 'loading' });
  try {
    const r = await api<{ conversations: ConversationSummary[] }>(`${ASSISTANT_API}/conversations`);
    if (assistantStore.get().userId !== uid || !current()) return;
    patch({ conversations: r.conversations ?? [], conversationsState: 'ready' });
  } catch {
    if (assistantStore.get().userId !== uid || !current()) return;
    patch({ conversationsState: 'error' });
  }
}

export async function openConversation(id: string): Promise<void> {
  if(!accessUsable())return;
  const s = assistantStore.get();
  // Already showing it (including one just created by sending): never reload
  // mid-stream.
  if (s.conversationId === id && (s.messages.length || s.streaming || s.loadingConversation)) {
    patch({ showHistory: false });
    return;
  }
  if (s.streaming) stop();
  abortLocal();
  pendingTarget = null;
  const uid = s.userId;
  const gen = streamGen,current=currentRequest();
  patch({ ...freshConversation(), conversationId: id, loadingConversation: true, showHistory: false });
  try {
    const d = await api<ConversationDetail>(`${ASSISTANT_API}/conversations/${encodeURIComponent(id)}`);
    if (assistantStore.get().userId !== uid || gen !== streamGen || !current()) return;
    patch({ title: d.title, messages: d.messages ?? [], activeRun: d.activeRun ?? null, loadingConversation: false });
  } catch (e) {
    if (assistantStore.get().userId !== uid || gen !== streamGen || !current()) return;
    const access = e instanceof ApiError && (e.status === 403 || e.status === 404);
    patch({
      loadingConversation: false,
      error: access
        ? { code: 'access_changed', message: 'This conversation is unavailable. It may have been deleted, expired, or its sources are no longer accessible to you.', retryable: false }
        : { code: 'provider_stream_interrupted', message: 'The conversation could not be loaded. Reconnect and retry.', retryable: true },
    });
  }
}

export async function renameConversation(id: string, title: string): Promise<void> {
  if(!accessUsable())return;const current=currentRequest();
  const t = title.trim().slice(0, 120);
  if (!t) return;
  await api(`${ASSISTANT_API}/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title: t } });
  if(!current())return;
  patch((s) => ({
    title: s.conversationId === id ? t : s.title,
    conversations: s.conversations?.map((c) => (c.id === id ? { ...c, title: t } : c)) ?? null,
  }));
}

export async function deleteConversation(id: string): Promise<void> {
  if(!accessUsable())return;const current=currentRequest();
  await api(`${ASSISTANT_API}/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if(!current())return;
  if (assistantStore.get().conversationId === id) newConversation();
  patch((s) => ({ conversations: s.conversations?.filter((c) => c.id !== id) ?? null }));
}

export async function deleteAllConversations(): Promise<number> {
  if(!accessUsable())return 0;const current=currentRequest();
  const r = await api<{ ok: boolean; deleted?: number }>(`${ASSISTANT_API}/conversations`, { method: 'DELETE' });
  if(!current())return r.deleted??0;
  newConversation();
  patch({ conversations: [] });
  return r.deleted ?? 0;
}

/* ---------------- streaming ---------------- */

function upsertMessage(list: AssistantMessage[], id: string, fn: (m: AssistantMessage) => AssistantMessage): AssistantMessage[] {
  const i = list.findIndex((m) => m.id === id);
  if (i < 0) return [...list, fn({ id, role: 'assistant', text: '', createdAt: Date.now() })];
  const next = list.slice();
  next[i] = fn(list[i]);
  return next;
}

function applyEvent(ev: AssistantEvent, runMessages: Set<string>): void {
  switch (ev.type) {
    case 'run':
      patch((s) => ({ runId: ev.runId, conversationId: s.conversationId ?? ev.conversationId }));
      return;
    case 'message': {
      const m = ev.message;
      if (m.role !== 'user') runMessages.add(m.id);
      patch((s) => {
        if (m.role === 'user') {
          // Replace the optimistic local copy with the stored message.
          const i = s.messages.map((x) => x.id.startsWith('local-') && x.role === 'user').lastIndexOf(true);
          if (i >= 0) {
            const next = s.messages.slice();
            next[i] = m;
            return { messages: next };
          }
        }
        return { messages: upsertMessage(s.messages, m.id, (prev) => ({ ...prev, ...m })) };
      });
      return;
    }
    case 'text':
      runMessages.add(ev.messageId);
      patch((s) => ({ messages: upsertMessage(s.messages, ev.messageId, (m) => ({ ...m, text: m.text + ev.delta })) }));
      return;
    case 'tool':
      runMessages.add(ev.messageId);
      patch((s) => ({
        messages: upsertMessage(s.messages, ev.messageId, (m) => {
          const calls = m.toolCalls ?? [];
          const i = calls.findIndex((c) => c.id === ev.call.id);
          return { ...m, toolCalls: i < 0 ? [...calls, ev.call] : calls.map((c, j) => (j === i ? ev.call : c)) };
        }),
      }));
      return;
    case 'sources':
      runMessages.add(ev.messageId);
      patch((s) => ({ messages: upsertMessage(s.messages, ev.messageId, (m) => ({ ...m, sources: ev.sources, incomplete: ev.incomplete ?? m.incomplete })) }));
      return;
    case 'approval':
      runMessages.add(ev.messageId);
      patch((s) => ({ messages: upsertMessage(s.messages, ev.messageId, (m) => ({ ...m, approval: ev.approval })) }));
      return;
    case 'error':
      patch({ error: { code: ev.code, message: ev.message, retryable: ev.retryable } });
      return;
    case 'step_end':
      return;
  }
}

async function runStream(req: StreamRequest, target: SelectionTarget | null): Promise<void> {
  abortLocal();
  const gen = streamGen,current=currentRequest();
  if(!accessUsable())return;
  const ctrl = new AbortController();
  controller = ctrl;
  const runMessages = new Set<string>();
  patch({ streaming: true, error: null, activeRun: null, announce: 'Assistant is responding…' });
  const outcome = await streamRun(req, {
    signal: ctrl.signal,
    getToken,
    onEvent: (ev) => {
      if (gen === streamGen && current()) applyEvent(ev, runMessages);
    },
  });
  if (gen !== streamGen || !current()) return;
  controller = null;
  const announce =
    outcome.kind === 'done'
      ? 'Response complete.'
      : outcome.kind === 'approval'
        ? 'Response complete. A proposed change needs your approval.'
        : outcome.kind === 'error'
          ? `Assistant error: ${errorText(outcome.error.code, outcome.error.message)}`
          : 'Response stopped.';
  patch((s) => {
    let applyTargets = s.applyTargets;
    if (target && outcome.kind === 'done') {
      const last = [...s.messages].reverse().find((m) => m.role === 'assistant' && runMessages.has(m.id) && m.text.trim());
      if (last) applyTargets = { ...applyTargets, [last.id]: target };
    }
    return { streaming: false, runId: null, announce, applyTargets };
  });
}

export async function sendMessage(): Promise<void> {
  const s = assistantStore.get();
  if (s.streaming || !accessUsable()) return;
  const action = s.actionId ? aiAction(s.actionId) : undefined;
  const text = (s.draft.trim() || action?.label || '').slice(0, MAX_MESSAGE_CHARS);
  if (!text) return;
  if (!isOnline()) {
    patch({ error: { code: 'offline', message: 'You are offline. Reconnect to send — your workspace keeps working offline without AI.', retryable: true } });
    return;
  }
  const provider = selectedProvider(s);
  if (!provider || provider.state !== 'available') {
    patch({ error: { code: 'no_provider', message: 'Choose an available provider before sending.', retryable: false } });
    return;
  }
  const uid = s.userId;
  const attached = clipContext(s.attached);
  const target = pendingTarget && attached.some((r) => r.kind === 'selection' && r.blockId === pendingTarget!.blockId) ? pendingTarget : null;
  pendingTarget = null;
  lastRequest = { text, attached, actionId: action?.id ?? null, target };
  let conversationId = s.conversationId;
  const gen = streamGen,current=currentRequest();
  patch({ draft: '', actionId: null, error: null, streaming: true, announce: 'Sending…' });
  if (!conversationId) {
    try {
      const c = await api<ConversationSummary>(`${ASSISTANT_API}/conversations`, { method: 'POST', body: { title: text.slice(0, 80) } });
      if (assistantStore.get().userId !== uid || gen !== streamGen || !current()) return;
      conversationId = c.id;
      patch((st) => ({ conversationId: c.id, title: c.title, conversations: st.conversations ? [c, ...st.conversations] : st.conversations }));
    } catch (e) {
      if (assistantStore.get().userId !== uid || !current()) return;
      patch({ streaming: false, draft: text, error: apiFailure(e) });
      return;
    }
  }
  const local: AssistantMessage = { id: `local-${Date.now().toString(36)}`, role: 'user', text, createdAt: Date.now(), context: attached };
  patch((st) => ({ messages: [...st.messages, local] }));
  await runStream(
    {
      path: `${ASSISTANT_API}/conversations/${encodeURIComponent(conversationId)}/messages`,
      body: { text, context: attached, provider: provider.id, ...(s.model ? { model: s.model } : {}), ...(action ? { actionId: action.id } : {}) },
    },
    target,
  );
}

function apiFailure(e: unknown): UiError {
  if (e instanceof ApiError) {
    if (e.status === 0) return { code: 'offline', message: 'Could not reach the server. Reconnect and retry.', retryable: true };
    const body = (e.body ?? {}) as { code?: string; message?: string };
    const code = (body.code ?? '') as AssistantErrorCode;
    if (code) return { code, message: body.message ?? e.message, retryable: e.status >= 500 };
    if (e.status === 401) return { code: 'unauthenticated', message: 'Your session expired. Sign in again.', retryable: false };
    if (e.status === 403) return { code: 'access_changed', message: 'Access changed.', retryable: false };
  }
  return { code: 'internal', message: 'The request failed.', retryable: true };
}

export async function regenerate(): Promise<void> {
  const s = assistantStore.get();
  if (s.streaming || !s.conversationId || !accessUsable()) return;
  if (!isOnline()) {
    patch({ error: { code: 'offline', message: 'You are offline. Reconnect to regenerate.', retryable: true } });
    return;
  }
  const provider = selectedProvider(s);
  if (!provider || provider.state !== 'available') {
    patch({ error: { code: 'no_provider', message: 'Choose an available provider before regenerating.', retryable: false } });
    return;
  }
  const lastUser = s.messages.map((m) => m.role === 'user').lastIndexOf(true);
  const removed = lastUser >= 0 ? s.messages.slice(lastUser + 1) : [];
  const target = removed.map((m) => s.applyTargets[m.id]).find(Boolean) ?? (lastRequest?.target ?? null);
  patch({ messages: lastUser >= 0 ? s.messages.slice(0, lastUser + 1) : s.messages });
  await runStream(
    { path: `${ASSISTANT_API}/conversations/${encodeURIComponent(s.conversationId)}/regenerate`, body: { provider: provider.id, ...(s.model ? { model: s.model } : {}) } },
    target,
  );
}

/** Resume a run a previous session left awaiting its next step. */
export async function continueActiveRun(): Promise<void> {
  const s = assistantStore.get();
  if (!accessUsable() || s.streaming || !s.activeRun || s.activeRun.status !== 'awaiting_continue') return;
  const run = s.activeRun;
  await runStream({ path: `${ASSISTANT_API}/runs/${encodeURIComponent(run.id)}/continue`, body: { step: run.step } }, null);
}

export function stop(): void {
  const { runId } = assistantStore.get();
  abortLocal();
  if (runId) void cancelRun(runId, { getToken });
  patch({ streaming: false, runId: null, announce: 'Response stopped.' });
}

export function retry(): void {
  const s = assistantStore.get();
  if (s.streaming) return;
  if (s.conversationId && s.messages.some((m) => m.role === 'user' && !m.id.startsWith('local-'))) {
    void regenerate();
    return;
  }
  if (lastRequest) {
    const r = lastRequest;
    pendingTarget = r.target;
    patch({ draft: r.text, attached: r.attached, actionId: r.actionId, error: null, messages: s.messages.filter((m) => !m.id.startsWith('local-')) });
    void sendMessage();
  }
}

export const dismissError = () => patch({ error: null });

export const setApplyState = (messageId: string, a: ApplyState) => patch((s) => ({ applyStates: { ...s.applyStates, [messageId]: a } }));

/* ---------------- approvals (reuse the human review endpoints) ---------------- */

const setApproval = (id: string, a: ApprovalState) => patch((s) => ({ approvals: { ...s.approvals, [id]: a } }));

export async function approveAndExecute(a: ApprovalView): Promise<void> {
  if(!accessUsable())return;const current=currentRequest();
  const id = encodeURIComponent(a.previewId);
  setApproval(a.previewId, { phase: 'busy', message: 'Approving…' });
  try {
    await api(`/api/ai/previews/${id}/decision`, { method: 'POST', body: { decision: 'approve', argsHash: a.argsHash } });
  } catch (e) {
    if(!current())return;
    setApproval(a.previewId, { phase: 'error', message: e instanceof ApiError && e.status === 409 ? 'Records changed since this proposal. Ask for a fresh proposal.' : e instanceof ApiError && e.status === 403 ? 'Access changed. This proposal is unavailable.' : 'Approval failed. Retry, or open the full review.' });
    return;
  }
  if(!current())return;
  setApproval(a.previewId, { phase: 'busy', message: 'Executing…' });
  try {
    const r = await api<{ completed: boolean; changesetId: string }>(`/api/ai/previews/${id}/execute`, { method: 'POST', body: { argsHash: a.argsHash } });
    if(!current())return;
    setApproval(a.previewId, r.completed ? { phase: 'executed', changesetId: r.changesetId, message: 'Changes applied.' } : { phase: 'partial', changesetId: r.changesetId, message: 'Partially executed with durable progress. Open the full review to resume.' });
  } catch {
    if(!current())return;
    setApproval(a.previewId, { phase: 'error', message: 'Approved, but execution did not finish. Open the full review to resume.' });
  }
}

export async function cancelApproval(a: ApprovalView): Promise<void> {
  if(!accessUsable())return;const current=currentRequest();
  setApproval(a.previewId, { phase: 'busy', message: 'Cancelling…' });
  try {
    await api(`/api/ai/previews/${encodeURIComponent(a.previewId)}/decision`, { method: 'POST', body: { decision: 'cancel', argsHash: a.argsHash } });
    if(!current())return;
    setApproval(a.previewId, { phase: 'cancelled', message: 'Proposal cancelled. Nothing was changed.' });
  } catch {
    if(!current())return;
    setApproval(a.previewId, { phase: 'error', message: 'Cancel failed. Retry, or open the full review.' });
  }
}

/* ---------------- error copy ---------------- */

export function errorText(code: UiError['code'], fallback: string): string {
  switch (code) {
    case 'provider_usage_limit':
      return 'Your provider usage limit was reached. No other provider was used.';
    case 'provider_auth_failed':
      return 'The provider rejected its credentials. Update or reconnect it in Settings → AI assistant.';
    case 'provider_unavailable':
      return 'The selected provider is unavailable right now. No other provider was used.';
    case 'provider_not_eligible':
      return 'This account is not eligible for the selected provider. No other provider was used.';
    case 'provider_unsupported_capability':
      return 'The selected provider or model does not support this request.';
    case 'provider_stream_interrupted':
      return 'The response was interrupted. Check your connection and retry.';
    case 'provider_failed':
      return 'The provider returned an error. No other provider was used.';
    case 'budget_exhausted':
      return 'The workspace AI budget is exhausted. No other provider was used. Ask the workspace operator about the budget.';
    case 'step_limit':
      return 'The assistant reached its step limit for this request. Narrow the request and try again.';
    case 'run_conflict':
      return 'Another response is already running in this conversation. Wait for it or stop it first.';
    case 'access_changed':
      return 'Your access changed. Sources you can no longer read were not used. Start a new request.';
    case 'unauthenticated':
      return 'Your session expired. Sign in again.';
    case 'invalid_request':
      return fallback || 'The request was not accepted.';
    case 'offline':
    case 'no_provider':
      return fallback;
    default:
      return 'Something went wrong. Retry in a moment.';
  }
}
