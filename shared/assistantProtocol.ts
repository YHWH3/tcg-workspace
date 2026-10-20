/** Embedded assistant wire contract shared by the Worker (`worker/assistant/*`),
 * the browser (`src/core/assistant/*`) and tests. Pure types/constants only.
 *
 * One HTTP request = one bounded runtime STEP (a model segment and at most one
 * tool dispatch). Steps stream Server-Sent Events; when a step ends with
 * `{type:'step_end',next:'continue'}` the client POSTs `/runs/:id/continue`
 * with the returned `step`. This keeps every request inside the Workers
 * per-invocation D1/subrequest/CPU budgets. */

/* Endpoints (session bearer auth, all JSON unless marked SSE):
 *  GET    /api/assistant/providers                 -> {providers: ProviderStatus[], retentionDays}
 *  PUT    /api/assistant/credentials/:provider     {apiKey} -> {ok:true, models}   (BYOK; key never returned)
 *  DELETE /api/assistant/credentials/:provider     -> {ok:true}
 *  GET    /api/assistant/capabilities              -> {capabilities: CapabilityView[]}
 *  GET    /api/assistant/conversations             -> {conversations: ConversationSummary[]}
 *  POST   /api/assistant/conversations             {title?} -> ConversationSummary
 *  GET    /api/assistant/conversations/:id         -> ConversationDetail (re-validated against current access)
 *  PATCH  /api/assistant/conversations/:id         {title} -> {ok:true}
 *  DELETE /api/assistant/conversations/:id         -> {ok:true}
 *  DELETE /api/assistant/conversations             -> {ok:true, deleted:number}
 *  POST   /api/assistant/conversations/:id/messages SendMessageBody -> SSE AssistantEvent stream
 *  POST   /api/assistant/conversations/:id/regenerate {provider, model?} -> SSE (replaces the last reply)
 *  POST   /api/assistant/runs/:runId/continue      {step} -> SSE
 *  POST   /api/assistant/runs/:runId/cancel        -> {ok:true}
 *  PUT    /api/assistant/settings                  {retentionDays} -> {ok:true}
 * Approvals reuse the existing human review endpoints:
 *  POST /api/ai/previews/:previewId/decision {decision:'approve'|'cancel', argsHash}
 *  POST /api/ai/previews/:previewId/execute  {argsHash} */
export interface CapabilityView { id: string; module: string; kind: 'read' | 'write' | 'proposal'; description: string; available: boolean }

export const ASSISTANT_API = '/api/assistant' as const;
export const MAX_CONTEXT_REFS = 3;
export const MAX_MESSAGE_CHARS = 8000;
export const MAX_SELECTION_CHARS = 6000;
export const MAX_RUN_STEPS = 8;
export const DEFAULT_RETENTION_DAYS = 30;
export const RETENTION_CHOICES = [7, 30, 90] as const;

/** Explicit, user-chosen context. The server re-reads every referenced object
 * through the caller's current read gate; client-supplied text is untrusted. */
export type ContextRef =
  | { kind: 'page'; id: string }
  | { kind: 'record'; id: string }
  | { kind: 'database'; id: string }
  | { kind: 'moodboard'; id: string }
  | { kind: 'dashboard' }
  | { kind: 'selection'; text: string; pageId?: string; blockId?: string };

export type ProviderMode =
  | 'none'
  | 'simulated'
  | 'workers-ai'
  | 'byok'
  | 'chatgpt-hosted'
  | 'chatgpt-local'
  | 'external-mcp';

export type ProviderId = 'simulated' | 'workers-ai' | 'openai' | 'anthropic' | 'chatgpt-hosted';

export interface ProviderModel { id: string; label: string }
export interface ProviderStatus {
  id: ProviderId;
  label: string;
  mode: ProviderMode;
  /** available = may be selected for embedded inference now. */
  state: 'available' | 'needs_credentials' | 'disabled_by_operator' | 'requires_provider_approval' | 'unavailable';
  reason?: string;
  /** Who pays: never silently changes. */
  billing: 'none' | 'operator_budget' | 'user_api_account' | 'chatgpt_plan';
  /** Host that receives conversation context when this provider is used. */
  egressHost?: string;
  models: ProviderModel[];
  defaultModel?: string;
  supportsImages: boolean;
  credentialConfigured?: boolean;
  manageUsageUrl?: string;
}

export interface SourceRef { id: string; type: string; title?: string; url?: string; rev?: number }

export interface ToolCallView {
  id: string;
  name: string;
  /** Capability id from shared/aiCapabilities.ts. */
  capability: string;
  kind: 'read' | 'write' | 'proposal';
  argsSummary: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'awaiting_approval';
  resultSummary?: string;
  error?: string;
}

export interface ApprovalView {
  previewId: string;
  argsHash: string;
  reviewUrl: string;
  tool: string;
  impact?: { create: number; update: number; delete: number; irreversible?: boolean; warnings?: string[] };
}

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  createdAt: number;
  provider?: string;
  model?: string;
  context?: ContextRef[];
  toolCalls?: ToolCallView[];
  sources?: SourceRef[];
  approval?: ApprovalView;
  /** True when sources became unreadable since this message was stored. */
  redacted?: boolean;
  /** True when retrieval was bounded/truncated. */
  incomplete?: boolean;
}

export interface ConversationSummary {
  id: string;
  title: string;
  provider: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

export interface ConversationDetail extends ConversationSummary {
  messages: AssistantMessage[];
  activeRun: { id: string; step: number; status: RunStatus } | null;
}

export type RunStatus = 'running' | 'awaiting_continue' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

/** SSE `data:` payloads, one JSON object per event. */
export type AssistantEvent =
  | { type: 'run'; runId: string; conversationId: string; step: number; provider: string; model: string }
  | { type: 'message'; message: AssistantMessage }
  | { type: 'text'; messageId: string; delta: string }
  | { type: 'tool'; messageId: string; call: ToolCallView }
  | { type: 'sources'; messageId: string; sources: SourceRef[]; incomplete?: boolean }
  | { type: 'approval'; messageId: string; approval: ApprovalView }
  | { type: 'step_end'; runId: string; step: number; next: 'continue' | 'done' | 'approval' | 'cancelled' }
  | { type: 'error'; code: AssistantErrorCode; message: string; retryable: boolean };

export type AssistantErrorCode =
  | 'unauthenticated'
  | 'provider_unavailable'
  | 'provider_auth_failed'
  | 'provider_usage_limit'
  | 'provider_not_eligible'
  | 'provider_unsupported_capability'
  | 'provider_stream_interrupted'
  | 'provider_failed'
  | 'budget_exhausted'
  | 'step_limit'
  | 'run_conflict'
  | 'access_changed'
  | 'invalid_request'
  | 'internal';

export interface SendMessageBody {
  text: string;
  context?: ContextRef[];
  provider: ProviderId;
  model?: string;
  /** Optional catalog action from shared/aiActions.ts. */
  actionId?: string;
}
