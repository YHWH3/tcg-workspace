import { z } from 'zod';
import {
  CapabilityAuditPageSchema,
  CapabilityChangeOutputSchema,
  CapabilityOverviewSchema,
  CommandErrorSchema,
  CrmHttpErrorSchema,
  CrmRetryableHttpErrorSchema,
  OWNER_PROTECTED_ERROR,
  REQUEST_ID_PATTERN,
  commandResultSchema,
  type CapabilityAuditPage,
  type CapabilityChangeInput,
  type CapabilityChangeOutput,
  type CapabilityOverview,
  type CommandError,
  type CommandResult,
  type CrmErrorCode,
} from '../../../shared/crm/contracts';
import {
  CrmConsentDtoSchema,
  CrmEndpointDtoSchema,
  DuplicatesPageResponseSchema,
  PersonDetailResponseSchema,
  type AddEndpointInput,
  type BackfillEndpointsInput,
  type CrmConsentDto,
  type CrmEndpointDto,
  type DismissDuplicateInput,
  type DuplicatesPageResponse,
  type PersonDetailResponse,
  type RecordConsentInput,
  type RetireEndpointInput,
  type SetPrimaryEndpointInput,
} from '../../../shared/crm/identity';
import {
  APPLICATION_CONVERT_TARGETS,
  HomeSummaryResponseSchema,
  ProgrammeSummaryDtoSchema,
  ProgrammesListResponseSchema,
  TimelineResponseSchema,
  type ConvertApplicationInput,
  type CreateApplicationFromSubmissionInput,
  type HomeSummaryResponse,
  type ProgrammeSummaryDto,
  type ProgrammesListResponse,
  type TimelineResponse,
  type UpdateProgrammeProfileInput,
} from '../../../shared/crm/programmes';
import {
  ChannelsOverviewResponseSchema,
  CrmChannelAccountDtoSchema,
  CrmTemplateDtoSchema,
  TemplatesListResponseSchema,
  type ChannelsOverviewResponse,
  type ConfigureChannelAccountInput,
  type CrmChannelAccountDto,
  type CrmTemplateDto,
  type PollChannelNowInput,
  type ProcessOutboxNowInput,
  type ResolveMessageReviewInput,
  type SetChannelAccountModeInput,
  type SubmitTemplateInput,
  type SyncTemplateStatusInput,
  type TemplatesListResponse,
  type UpsertTemplateInput,
} from '../../../shared/crm/channels';
import {
  ConversationDetailResponseSchema,
  ConversationsPageResponseSchema,
  CrmConversationDtoSchema,
  CrmFactDtoSchema,
  CrmMessageDtoSchema,
  FactsListResponseSchema,
  type AddMessageNoteInput,
  type AssignConversationInput,
  type ConversationDetailResponse,
  type ConversationsPageResponse,
  type FactsListResponse,
  type GenerateAiDraftInput,
  type LinkConversationPersonInput,
  type LogManualConversationInput,
  type ProposeFactInput,
  type RetireFactInput,
  type RetryMessageInput,
  type SaveMessageDraftInput,
  type SendMessageInput,
  type SetConversationStateInput,
  type SimulateInboundInput,
  type VerifyFactInput,
} from '../../../shared/crm/conversations';
import {
  PatronsReadResponseSchema,
  type HandoffOpportunityToProjectInput,
  type PatronsReadResponse,
} from '../../../shared/crm/pipelines';
import {
  MergeHistoryPageResponseSchema,
  MergePreviewResponseSchema,
  PersonMergeOutputSchema,
  PersonUnmergeOutputSchema,
  UnmergeConflictDtoSchema,
  type MergeHistoryPageResponse,
  type MergePreviewResponse,
  type PersonMergeInput,
  type PersonMergeOutput,
  type PersonUnmergeInput,
  type PersonUnmergeOutput,
  type UnmergeConflictDto,
} from '../../../shared/crm/merge';
import type { PublicUser } from '../../../shared/types';
import { api, ApiError, getToken } from '../../core/api';
import {
  currentCrmIdentityKey,
  handleCrmAuthFailure,
  notifyCrmStatusUpdated,
} from '../../core/crmStatus';

export type CrmTransportFailureKind =
  | 'offline'
  | 'retryable_http'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'bad_response'
  | 'http'
  | 'identity_changed';

export class CrmTransportError extends Error {
  readonly kind: CrmTransportFailureKind;
  readonly status: number;
  readonly code?: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly userMessage: string;

  constructor(opts: {
    kind: CrmTransportFailureKind;
    status: number;
    code?: string;
    retryable: boolean;
    requestId?: string;
    userMessage: string;
    message?: string;
  }) {
    super(opts.message ?? opts.userMessage);
    this.name = 'CrmTransportError';
    this.kind = opts.kind;
    this.status = opts.status;
    this.code = opts.code;
    this.retryable = opts.retryable;
    this.requestId = opts.requestId;
    this.userMessage = opts.userMessage;
  }
}

export function generateCrmRequestId(): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  const id = `crm_${raw}`.slice(0, 64);
  if (!REQUEST_ID_PATTERN.test(id)) {
    throw new Error('Generated invalid requestId');
  }
  return id;
}

export interface RunCrmCommandOptions {
  requestId?: string;
  expected?: Record<string, number>;
  maxTransientRetries?: number;
  retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isIdentityChangedError(err: unknown): boolean {
  return err instanceof CrmTransportError && err.kind === 'identity_changed';
}

interface CrmSessionBinding {
  identityKey: string;
  token: string;
  storageUid: string | null;
}

function captureCrmSessionBinding(requestId?: string): CrmSessionBinding {
  const identityKey = currentCrmIdentityKey();
  const token = getToken();
  const storageUid = typeof localStorage !== 'undefined' ? localStorage.getItem('ws_uid') : null;
  if (!identityKey || !token) {
    throw new CrmTransportError({
      kind: 'unauthenticated',
      status: 401,
      code: 'unauthenticated',
      retryable: false,
      requestId,
      userMessage: 'Your session expired. Sign in again to continue.',
    });
  }
  return { identityKey, token, storageUid };
}

function isSameSession(binding: CrmSessionBinding): boolean {
  if (currentCrmIdentityKey() !== binding.identityKey) return false;
  if (getToken() !== binding.token) return false;
  if (typeof localStorage !== 'undefined' && localStorage.getItem('ws_uid') !== binding.storageUid) {
    return false;
  }
  return true;
}

function assertSameSession(binding: CrmSessionBinding, requestId?: string): void {
  if (!isSameSession(binding)) {
    throw new CrmTransportError({
      kind: 'identity_changed',
      status: 0,
      code: 'identity_changed',
      retryable: false,
      requestId,
      userMessage: 'Signed-in account changed before the request completed.',
    });
  }
}

export async function runCrmCommand<O>(
  name: string,
  input: Record<string, unknown>,
  outputSchema: z.ZodType<O>,
  opts: RunCrmCommandOptions = {},
): Promise<CommandResult<O> | CommandError> {
  const requestId = opts.requestId ?? generateCrmRequestId();
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid CRM command requestId');
  }

  const maxRetries = opts.maxTransientRetries ?? 1;
  const retryDelayMs = opts.retryDelayMs ?? 250;
  const resultSchema = commandResultSchema(outputSchema);
  const envelope = {
    requestId,
    input,
    ...(opts.expected && Object.keys(opts.expected).length > 0 ? { expected: opts.expected } : {}),
  };

  // Bind the entire command lifecycle (and any retries) to the original user,
  // token, and access epoch so a replacement account's credentials can never be reused.
  const binding = captureCrmSessionBinding(requestId);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${binding.token}`,
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    assertSameSession(binding, requestId);

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new CrmTransportError({
        kind: 'offline',
        status: 0,
        code: 'offline',
        retryable: true,
        requestId,
        userMessage: 'Capability changes need a connection',
      });
    }

    let res: Response;
    try {
      res = await fetch(`/api/crm/commands/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(envelope),
      });
    } catch {
      assertSameSession(binding, requestId);
      const online = typeof navigator === 'undefined' ? true : navigator.onLine;
      if (online && attempt < maxRetries) {
        if (retryDelayMs > 0) await sleep(retryDelayMs);
        assertSameSession(binding, requestId);
        continue;
      }
      throw new CrmTransportError({
        kind: 'offline',
        status: 0,
        code: 'network_error',
        retryable: true,
        requestId,
        userMessage: online
          ? 'Connection dropped before the server replied. Retry to confirm safely.'
          : 'Capability changes need a connection',
      });
    }

    assertSameSession(binding, requestId);
    const rawText = await res.text();
    assertSameSession(binding, requestId);

    let parsedJson: unknown = null;
    try {
      parsedJson = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsedJson = null;
    }

    if (res.status === 401) {
      handleCrmAuthFailure('unauthenticated', binding.identityKey);
      throw new CrmTransportError({
        kind: 'unauthenticated',
        status: 401,
        code: 'unauthenticated',
        retryable: false,
        requestId,
        userMessage: 'Your session expired. Sign in again to continue.',
      });
    }

    if (res.status === 403 || res.status === 404) {
      const httpErr = CrmHttpErrorSchema.safeParse(parsedJson);
      const code = httpErr.success ? httpErr.data.error : res.status === 403 ? 'forbidden' : 'not_found';
      handleCrmAuthFailure(res.status === 403 ? 'forbidden' : 'not_found', binding.identityKey);
      throw new CrmTransportError({
        kind: res.status === 403 ? 'forbidden' : 'not_found',
        status: res.status,
        code,
        retryable: false,
        requestId,
        userMessage:
          res.status === 403
            ? 'You no longer have permission to perform this change.'
            : 'CRM is unavailable right now.',
      });
    }

    if (res.status === 503) {
      const retryableErr = CrmRetryableHttpErrorSchema.safeParse(parsedJson);
      if (retryableErr.success) {
        if (attempt < maxRetries) {
          if (retryDelayMs > 0) await sleep(retryDelayMs);
          assertSameSession(binding, requestId);
          continue;
        }
        throw new CrmTransportError({
          kind: 'retryable_http',
          status: 503,
          code: retryableErr.data.error,
          retryable: true,
          requestId,
          userMessage: 'The server was interrupted before confirming. Retry to finish safely.',
        });
      }
    }

    if (!res.ok) {
      const httpErr = CrmHttpErrorSchema.safeParse(parsedJson);
      throw new CrmTransportError({
        kind: 'http',
        status: res.status,
        code: httpErr.success ? httpErr.data.error : undefined,
        retryable: res.status >= 500,
        requestId,
        userMessage: 'The change could not be completed. Refresh and try again.',
      });
    }

    const okResult = resultSchema.safeParse(parsedJson);
    if (okResult.success) {
      assertSameSession(binding, requestId);
      return okResult.data;
    }

    const cmdError = CommandErrorSchema.safeParse(parsedJson);
    if (cmdError.success) {
      assertSameSession(binding, requestId);
      if (cmdError.data.error === 'unauthenticated') {
        handleCrmAuthFailure('unauthenticated', binding.identityKey);
      } else if (cmdError.data.error === 'forbidden') {
        handleCrmAuthFailure('forbidden', binding.identityKey);
      }
      return cmdError.data;
    }

    throw new CrmTransportError({
      kind: 'bad_response',
      status: res.status,
      retryable: false,
      requestId,
      userMessage: 'The server returned an unexpected response.',
    });
  }

  throw new CrmTransportError({
    kind: 'retryable_http',
    status: 503,
    retryable: true,
    requestId,
    userMessage: 'The change could not be confirmed. Retry to verify.',
  });
}

export async function grantCrmCapability(
  input: CapabilityChangeInput,
  opts?: RunCrmCommandOptions,
): Promise<CommandResult<CapabilityChangeOutput> | CommandError> {
  const binding = captureCrmSessionBinding(opts?.requestId);
  const payload = {
    userId: input.userId,
    capability: input.capability,
    scope: input.scope,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
  };
  const outcome = await runCrmCommand('capability.grant', payload, CapabilityChangeOutputSchema, opts);
  assertSameSession(binding, opts?.requestId);
  if (outcome.ok && !outcome.result.already) {
    await notifyCrmStatusUpdated(input.userId, binding.identityKey);
    assertSameSession(binding, opts?.requestId);
  }
  return outcome;
}

export async function revokeCrmCapability(
  input: CapabilityChangeInput,
  opts?: RunCrmCommandOptions,
): Promise<CommandResult<CapabilityChangeOutput> | CommandError> {
  const binding = captureCrmSessionBinding(opts?.requestId);
  const payload = {
    userId: input.userId,
    capability: input.capability,
    scope: input.scope,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
  };
  const outcome = await runCrmCommand('capability.revoke', payload, CapabilityChangeOutputSchema, opts);
  assertSameSession(binding, opts?.requestId);
  if (outcome.ok && !outcome.result.already) {
    await notifyCrmStatusUpdated(input.userId, binding.identityKey);
    assertSameSession(binding, opts?.requestId);
  }
  return outcome;
}

async function fetchCrmRead<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const binding = captureCrmSessionBinding();
  try {
    const raw = await api<unknown>(path);
    assertSameSession(binding);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new CrmTransportError({
        kind: 'bad_response',
        status: 200,
        retryable: false,
        userMessage: 'The server returned an unexpected response.',
      });
    }
    assertSameSession(binding);
    return parsed.data;
  } catch (err) {
    if (err instanceof CrmTransportError) throw err;
    assertSameSession(binding);
    if (err instanceof ApiError) {
      if (err.status === 401) {
        handleCrmAuthFailure('unauthenticated', binding.identityKey);
        throw new CrmTransportError({
          kind: 'unauthenticated',
          status: 401,
          code: 'unauthenticated',
          retryable: false,
          userMessage: 'Your session expired. Sign in again to continue.',
        });
      }
      if (err.status === 403 || err.status === 404) {
        handleCrmAuthFailure(err.status === 403 ? 'forbidden' : 'not_found', binding.identityKey);
        throw new CrmTransportError({
          kind: err.status === 403 ? 'forbidden' : 'not_found',
          status: err.status,
          code: err.message,
          retryable: false,
          userMessage:
            err.status === 403
              ? 'You do not have permission to view CRM capability settings.'
              : 'CRM is unavailable right now.',
        });
      }
      if (err.status === 0) {
        throw new CrmTransportError({
          kind: 'offline',
          status: 0,
          code: 'offline',
          retryable: true,
          userMessage: 'Needs a connection to load CRM capability settings.',
        });
      }
      throw new CrmTransportError({
        kind: err.status === 503 ? 'retryable_http' : 'http',
        status: err.status,
        code: err.message,
        retryable: err.status >= 500,
        userMessage: 'Could not load CRM settings right now. Retry when connected.',
      });
    }
    throw err;
  }
}

export function fetchCapabilityOverview(): Promise<CapabilityOverview> {
  return fetchCrmRead('/api/crm/read/capabilities', CapabilityOverviewSchema);
}

export function fetchCapabilityAudit(cursor?: string | null): Promise<CapabilityAuditPage> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return fetchCrmRead(`/api/crm/read/capability-audit${qs}`, CapabilityAuditPageSchema);
}

export interface WorkspaceInviteRow {
  code: string;
  created_at: number;
  used_by: string | null;
  used_by_name?: string | null;
}

export interface WorkspaceUsersResponse {
  users: PublicUser[];
  seatsTotal: number;
}

async function callWorkspaceAdmin<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const binding = captureCrmSessionBinding();
  try {
    const res = await api<T>(path, opts);
    assertSameSession(binding);
    return res;
  } catch (err) {
    if (err instanceof CrmTransportError) throw err;
    assertSameSession(binding);
    if (err instanceof ApiError && err.status === 401) {
      handleCrmAuthFailure('unauthenticated', binding.identityKey);
    }
    throw err;
  }
}

export function fetchWorkspaceAccounts(): Promise<[WorkspaceUsersResponse, { invites: WorkspaceInviteRow[] }]> {
  return Promise.all([
    callWorkspaceAdmin<WorkspaceUsersResponse>('/api/users'),
    callWorkspaceAdmin<{ invites: WorkspaceInviteRow[] }>('/api/invites'),
  ]);
}

export function createWorkspaceInvite(): Promise<{ code: string }> {
  return callWorkspaceAdmin<{ code: string }>('/api/invites', { method: 'POST' });
}

export function deleteWorkspaceInvite(code: string): Promise<{ ok: boolean }> {
  return callWorkspaceAdmin<{ ok: boolean }>(`/api/invites/${encodeURIComponent(code)}`, { method: 'DELETE' });
}

export function updateWorkspaceUserRole(userId: string, role: 'admin' | 'member'): Promise<{ ok: boolean }> {
  return callWorkspaceAdmin<{ ok: boolean }>(`/api/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: { role },
  });
}

export function disableWorkspaceUser(userId: string): Promise<{ ok: boolean; disabled: boolean; cleanupPending?: boolean }> {
  return callWorkspaceAdmin<{ ok: boolean; disabled: boolean; cleanupPending?: boolean }>(
    `/api/users/${encodeURIComponent(userId)}/disable`,
    { method: 'POST' },
  );
}

export function enableWorkspaceUser(userId: string): Promise<{ ok: boolean; disabled: boolean }> {
  return callWorkspaceAdmin<{ ok: boolean; disabled: boolean }>(
    `/api/users/${encodeURIComponent(userId)}/enable`,
    { method: 'POST' },
  );
}

export function deleteWorkspaceUser(userId: string): Promise<{ ok: boolean }> {
  return callWorkspaceAdmin<{ ok: boolean }>(`/api/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
}

export function renameWorkspaceUser(userId: string, name: string): Promise<{ ok: boolean; name?: string }> {
  return callWorkspaceAdmin<{ ok: boolean; name?: string }>(`/api/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: { name },
  });
}

/* ---------- S1 Identity commands & reads ---------- */

const AddEndpointOutputSchema = z.object({
  endpoint: CrmEndpointDtoSchema,
  already: z.boolean(),
}).strict();

const RetireEndpointOutputSchema = z.object({
  endpointId: z.string(),
  retired: z.boolean(),
}).strict();

const SetPrimaryEndpointOutputSchema = z.object({
  endpointId: z.string(),
  personId: z.string(),
}).strict();

const RecordConsentOutputSchema = z.object({
  consent: CrmConsentDtoSchema,
}).strict();

const DismissDuplicateOutputSchema = z.object({
  candidateId: z.string(),
  state: z.literal('dismissed'),
}).strict();

export const BackfillEndpointsOutputSchema = z.object({
  dryRun: z.boolean(),
  scanned: z.number().int(),
  wouldCreate: z.number().int(),
  created: z.number().int(),
  alreadyPresent: z.number().int(),
  skippedInvalid: z.number().int(),
  conflicts: z.array(z.object({
    personId: z.string(),
    kind: z.enum(['email', 'phone']),
    valueNorm: z.string(),
    existingPersonId: z.string(),
  }).strict()),
  candidatesCreated: z.number().int(),
  next: z.string().nullable(),
}).strict();
export type BackfillEndpointsOutput = z.infer<typeof BackfillEndpointsOutputSchema>;

export function fetchPersonDetail(personId: string): Promise<PersonDetailResponse> {
  return fetchCrmRead(`/api/crm/read/person/${encodeURIComponent(personId)}`, PersonDetailResponseSchema);
}

export function fetchDuplicates(state: 'open' | 'dismissed' = 'open', cursor?: string | null): Promise<DuplicatesPageResponse> {
  const params = new URLSearchParams({ state });
  if (cursor) params.set('cursor', cursor);
  return fetchCrmRead(`/api/crm/read/duplicates?${params.toString()}`, DuplicatesPageResponseSchema);
}

export function addPersonEndpoint(
  input: AddEndpointInput,
  opts?: RunCrmCommandOptions,
): Promise<CommandResult<{ endpoint: CrmEndpointDto; already: boolean }> | CommandError> {
  return runCrmCommand('person.add_endpoint', { ...input }, AddEndpointOutputSchema, opts);
}

export function retirePersonEndpoint(
  input: RetireEndpointInput,
  opts?: RunCrmCommandOptions,
): Promise<CommandResult<{ endpointId: string; retired: boolean }> | CommandError> {
  return runCrmCommand('person.retire_endpoint', { ...input }, RetireEndpointOutputSchema, opts);
}

export function setPrimaryPersonEndpoint(
  input: SetPrimaryEndpointInput,
  opts?: RunCrmCommandOptions,
): Promise<CommandResult<{ endpointId: string; personId: string }> | CommandError> {
  return runCrmCommand('person.set_primary_endpoint', { ...input }, SetPrimaryEndpointOutputSchema, opts);
}

export function recordPersonConsent(
  input: RecordConsentInput,
  opts?: RunCrmCommandOptions,
): Promise<CommandResult<{ consent: CrmConsentDto }> | CommandError> {
  return runCrmCommand('person.record_consent', { ...input }, RecordConsentOutputSchema, opts);
}

export function dismissDuplicateCandidate(
  input: DismissDuplicateInput,
  opts?: RunCrmCommandOptions,
): Promise<CommandResult<{ candidateId: string; state: 'dismissed' }> | CommandError> {
  return runCrmCommand('duplicates.dismiss', { ...input }, DismissDuplicateOutputSchema, opts);
}

export function runEndpointBackfill(
  input: BackfillEndpointsInput,
  opts?: RunCrmCommandOptions,
): Promise<CommandResult<BackfillEndpointsOutput> | CommandError> {
  return runCrmCommand('endpoints.backfill', { ...input }, BackfillEndpointsOutputSchema, opts);
}

// ---------------------------------------------------------------------------
// S2 Programmes, Enquiries, Applications, Timeline & Home My Work APIs
// ---------------------------------------------------------------------------

const UpdateProgrammeProfileOutputSchema = z.object({
  programme: ProgrammeSummaryDtoSchema,
  already: z.boolean(),
}).strict();

const CreateApplicationOutputSchema = z.object({
  applicationId: z.string().min(1),
  already: z.boolean(),
  personId: z.string().nullable(),
  programmeSlug: z.string().nullable(),
}).strict();

const ConvertApplicationOutputSchema = z.object({
  applicationId: z.string().min(1),
  convertedRecordId: z.string().min(1),
  targetKind: z.enum(APPLICATION_CONVERT_TARGETS),
  already: z.boolean(),
}).strict();

export function fetchProgrammes(): Promise<ProgrammesListResponse> {
  return fetchCrmRead('/api/crm/read/programmes', ProgrammesListResponseSchema);
}

export function updateProgrammeProfile(
  input: UpdateProgrammeProfileInput,
  opts?: RunCrmCommandOptions,
): Promise<CommandResult<{ programme: ProgrammeSummaryDto; already: boolean }> | CommandError> {
  return runCrmCommand('programme.update_profile', { ...input }, UpdateProgrammeProfileOutputSchema, opts);
}

export function createApplicationFromSubmission(
  input: CreateApplicationFromSubmissionInput,
  opts?: RunCrmCommandOptions,
): Promise<
  | CommandResult<{ applicationId: string; already: boolean; personId: string | null; programmeSlug: string | null }>
  | CommandError
> {
  return runCrmCommand('application.create_from_submission', { ...input }, CreateApplicationOutputSchema, opts);
}

export function convertApplication(
  input: ConvertApplicationInput,
  opts?: RunCrmCommandOptions,
): Promise<
  | CommandResult<{
      applicationId: string;
      convertedRecordId: string;
      targetKind: ConvertApplicationInput['targetKind'];
      already: boolean;
    }>
  | CommandError
> {
  return runCrmCommand('application.convert', { ...input }, ConvertApplicationOutputSchema, opts);
}

export function fetchTimeline(
  subjectId: string,
  cursor?: string,
  limit = 30,
): Promise<TimelineResponse> {
  const qs = new URLSearchParams({ subject: subjectId, limit: String(limit) });
  if (cursor) qs.set('cursor', cursor);
  return fetchCrmRead(`/api/crm/read/timeline?${qs.toString()}`, TimelineResponseSchema);
}

export function fetchCrmHome(): Promise<HomeSummaryResponse> {
  return fetchCrmRead('/api/crm/read/home', HomeSummaryResponseSchema);
}

// ---------------------------------------------------------------------------
// S4 Conversations & Verified Facts APIs
// ---------------------------------------------------------------------------

export function fetchFacts(opts?: { programmeSlug?: string; status?: string; includeStale?: boolean }): Promise<FactsListResponse> {
  const qs = new URLSearchParams();
  if (opts?.programmeSlug) qs.set('programme', opts.programmeSlug);
  if (opts?.status) qs.set('status', opts.status);
  if (opts?.includeStale === false) qs.set('includeStale', 'false');
  const q = qs.toString();
  return fetchCrmRead(`/api/crm/read/facts${q ? `?${q}` : ''}`, FactsListResponseSchema);
}

export function proposeCrmFact(input: ProposeFactInput, opts?: RunCrmCommandOptions) {
  return runCrmCommand('fact.propose', { ...input }, z.object({ fact: CrmFactDtoSchema }).strict(), opts);
}

export function verifyCrmFact(input: VerifyFactInput, opts?: RunCrmCommandOptions) {
  return runCrmCommand('fact.verify', { ...input }, z.object({ fact: CrmFactDtoSchema }).strict(), opts);
}

export function retireCrmFact(input: RetireFactInput, opts?: RunCrmCommandOptions) {
  return runCrmCommand('fact.retire', { ...input }, z.object({ fact: CrmFactDtoSchema }).strict(), opts);
}

export function fetchConversations(opts?: { filter?: string; channel?: string; cursor?: string }): Promise<ConversationsPageResponse> {
  const qs = new URLSearchParams();
  if (opts?.filter) qs.set('filter', opts.filter);
  if (opts?.channel) qs.set('channel', opts.channel);
  if (opts?.cursor) qs.set('cursor', opts.cursor);
  const q = qs.toString();
  return fetchCrmRead(`/api/crm/read/conversations${q ? `?${q}` : ''}`, ConversationsPageResponseSchema);
}

export function fetchConversationDetail(id: string): Promise<ConversationDetailResponse> {
  return fetchCrmRead(`/api/crm/read/conversation/${encodeURIComponent(id)}`, ConversationDetailResponseSchema);
}

export function logManualConversation(input: LogManualConversationInput, opts?: RunCrmCommandOptions) {
  return runCrmCommand(
    'conversation.log_manual',
    { ...input },
    z.object({ conversation: CrmConversationDtoSchema, message: CrmMessageDtoSchema }).strict(),
    opts,
  );
}

export function simulateInboundConversation(input: SimulateInboundInput, opts?: RunCrmCommandOptions) {
  return runCrmCommand(
    'conversation.simulate_inbound',
    { ...input },
    z.object({
      already: z.boolean(),
      conversationId: z.string(),
      messageId: z.string(),
      personId: z.string().nullable(),
    }).strict(),
    opts,
  );
}

export function linkConversationPerson(input: LinkConversationPersonInput, opts?: RunCrmCommandOptions) {
  return runCrmCommand(
    'conversation.link_person',
    { ...input },
    z.object({ conversationId: z.string(), personId: z.string() }).strict(),
    opts,
  );
}

export function assignConversation(input: AssignConversationInput, opts?: RunCrmCommandOptions) {
  return runCrmCommand(
    'conversation.assign',
    { ...input },
    z.object({ conversationId: z.string(), assigneeId: z.string().nullable() }).strict(),
    opts,
  );
}

export function setConversationState(input: SetConversationStateInput, opts?: RunCrmCommandOptions) {
  return runCrmCommand(
    'conversation.set_state',
    { ...input },
    z.object({ conversationId: z.string(), state: z.string() }).strict(),
    opts,
  );
}

export function addConversationNote(input: AddMessageNoteInput, opts?: RunCrmCommandOptions) {
  return runCrmCommand(
    'message.add_note',
    { ...input },
    z.object({ message: CrmMessageDtoSchema }).strict(),
    opts,
  );
}

export function saveConversationDraft(input: SaveMessageDraftInput, opts?: RunCrmCommandOptions) {
  return runCrmCommand(
    'message.save_draft',
    { ...input },
    z.object({ message: CrmMessageDtoSchema }).strict(),
    opts,
  );
}

export function sendConversationMessage(input: SendMessageInput, opts?: RunCrmCommandOptions) {
  return runCrmCommand(
    'message.send',
    { ...input },
    z.object({ message: CrmMessageDtoSchema, receiptId: z.string() }).strict(),
    opts,
  );
}

export function retryConversationMessage(input: RetryMessageInput, opts?: RunCrmCommandOptions) {
  return runCrmCommand(
    'message.retry',
    { ...input },
    z.object({ messageId: z.string(), receiptId: z.string() }).strict(),
    opts,
  );
}

export function generateAiConversationDraft(input: GenerateAiDraftInput, opts?: RunCrmCommandOptions) {
  return runCrmCommand(
    'message.generate_ai_draft',
    { ...input },
    z.object({
      message: CrmMessageDtoSchema,
      citedFactIds: z.array(z.string()),
      unconfirmedItems: z.array(z.string()),
      staleFactWarnings: z.array(z.string()),
    }).strict(),
    opts,
  );
}

// ---------------------------------------------------------------------------
// P3 Channels, Templates, Polling & Delivery Review APIs (S5, S11, S12)
// ---------------------------------------------------------------------------

export function fetchChannelsOverview(): Promise<ChannelsOverviewResponse> {
  return fetchCrmRead('/api/crm/read/channels', ChannelsOverviewResponseSchema);
}

export function fetchCrmTemplates(opts?: { channel?: string; status?: string }): Promise<TemplatesListResponse> {
  const qs = new URLSearchParams();
  if (opts?.channel) qs.set('channel', opts.channel);
  if (opts?.status) qs.set('status', opts.status);
  const q = qs.toString();
  return fetchCrmRead(`/api/crm/read/templates${q ? `?${q}` : ''}`, TemplatesListResponseSchema);
}

export function configureChannelAccount(
  input: ConfigureChannelAccountInput,
  opts?: RunCrmCommandOptions,
): Promise<CommandResult<{ account: CrmChannelAccountDto }> | CommandError> {
  return runCrmCommand(
    'channel.configure',
    { ...input },
    z.object({ account: CrmChannelAccountDtoSchema }).strict(),
    opts,
  );
}

export function setChannelAccountMode(
  input: SetChannelAccountModeInput,
  opts?: RunCrmCommandOptions,
): Promise<CommandResult<{ account: CrmChannelAccountDto }> | CommandError> {
  return runCrmCommand(
    'channel.set_mode',
    { ...input },
    z.object({ account: CrmChannelAccountDtoSchema }).strict(),
    opts,
  );
}

export function pollChannelAccountNow(
  input: PollChannelNowInput,
  opts?: RunCrmCommandOptions,
) {
  return runCrmCommand(
    'channel.poll_now',
    { ...input },
    z.object({
      accountId: z.string(),
      leased: z.boolean(),
      ingested: z.number().int().nonnegative(),
      duplicatesSkipped: z.number().int().nonnegative(),
      optOutsRecorded: z.number().int().nonnegative(),
      cursor: z.string().nullable(),
      healthState: z.enum(['disconnected', 'connected', 'degraded', 'error']),
    }).strict(),
    opts,
  );
}

export function upsertCrmTemplate(
  input: UpsertTemplateInput,
  opts?: RunCrmCommandOptions,
): Promise<CommandResult<{ template: CrmTemplateDto }> | CommandError> {
  return runCrmCommand(
    'template.upsert',
    { ...input },
    z.object({ template: CrmTemplateDtoSchema }).strict(),
    opts,
  );
}

export function submitCrmTemplate(
  input: SubmitTemplateInput,
  opts?: RunCrmCommandOptions,
): Promise<CommandResult<{ template: CrmTemplateDto }> | CommandError> {
  return runCrmCommand(
    'template.submit',
    { ...input },
    z.object({ template: CrmTemplateDtoSchema }).strict(),
    opts,
  );
}

export function syncCrmTemplateStatus(
  input: SyncTemplateStatusInput,
  opts?: RunCrmCommandOptions,
): Promise<CommandResult<{ template: CrmTemplateDto }> | CommandError> {
  return runCrmCommand(
    'template.sync_status',
    { ...input },
    z.object({ template: CrmTemplateDtoSchema }).strict(),
    opts,
  );
}

export function resolveMessageReview(
  input: ResolveMessageReviewInput,
  opts?: RunCrmCommandOptions,
) {
  return runCrmCommand(
    'message.resolve_review',
    { ...input },
    z.object({
      messageId: z.string(),
      status: z.enum(['sent', 'failed', 'cancelled']),
      providerReceipt: z.string().nullable(),
    }).strict(),
    opts,
  );
}

export function processOutboxNow(
  input: ProcessOutboxNowInput = {},
  opts?: RunCrmCommandOptions,
) {
  return runCrmCommand(
    'outbox.process_now',
    { ...input },
    z.object({
      expiredMovedToReview: z.number().int().nonnegative(),
      attempted: z.number().int().nonnegative(),
      sent: z.number().int().nonnegative(),
      requeued: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      reviewRequired: z.number().int().nonnegative(),
      cancelled: z.number().int().nonnegative(),
    }).strict(),
    opts,
  );
}

// ---------------------------------------------------------------------------
// S9 Pipelines & Patrons APIs
// ---------------------------------------------------------------------------

export function handoffOpportunityToProject(
  input: HandoffOpportunityToProjectInput,
  opts?: RunCrmCommandOptions,
): Promise<CommandResult<{ opportunityId: string; projectId: string; already: boolean }> | CommandError> {
  return runCrmCommand(
    'opportunity.handoff_project',
    { ...input },
    z.object({ opportunityId: z.string(), projectId: z.string(), already: z.boolean() }).strict(),
    opts,
  );
}

export function fetchPatrons(): Promise<PatronsReadResponse> {
  return fetchCrmRead('/api/crm/read/patrons', PatronsReadResponseSchema);
}

// ---------------------------------------------------------------------------
// S10 Reversible Contact Merge APIs
// ---------------------------------------------------------------------------

export function fetchMergePreview(survivorId: string, loserId: string): Promise<MergePreviewResponse> {
  const qs = new URLSearchParams({ survivorId, loserId });
  return fetchCrmRead(`/api/crm/read/merge-preview?${qs.toString()}`, MergePreviewResponseSchema);
}

export function fetchMergeHistory(opts?: { cursor?: string | null; personId?: string | null }): Promise<MergeHistoryPageResponse> {
  const qs = new URLSearchParams();
  if (opts?.cursor) qs.set('cursor', opts.cursor);
  if (opts?.personId) qs.set('personId', opts.personId);
  const q = qs.toString();
  return fetchCrmRead(`/api/crm/read/merges${q ? `?${q}` : ''}`, MergeHistoryPageResponseSchema);
}

export function mergePeople(
  input: PersonMergeInput,
  opts?: RunCrmCommandOptions,
): Promise<CommandResult<PersonMergeOutput> | CommandError> {
  return runCrmCommand('person.merge', { ...input }, PersonMergeOutputSchema, opts);
}

export function unmergePeople(
  input: PersonUnmergeInput,
  opts?: RunCrmCommandOptions,
): Promise<CommandResult<PersonUnmergeOutput> | CommandError> {
  return runCrmCommand('person.unmerge', { ...input }, PersonUnmergeOutputSchema, opts);
}

const UnmergeConflictsArraySchema = z.array(UnmergeConflictDtoSchema);

export function extractUnmergeConflicts(err: CommandError | unknown): UnmergeConflictDto[] {
  if (!err || typeof err !== 'object' || !('ok' in err) || (err as CommandError).ok !== false) {
    return [];
  }
  const cmdErr = err as CommandError;
  if (cmdErr.error !== 'stale' || cmdErr.detail?.reason !== 'unmerge_conflicts') {
    return [];
  }
  const parsed = UnmergeConflictsArraySchema.safeParse(cmdErr.detail?.conflicts);
  return parsed.success ? parsed.data : [];
}

const COMMAND_ERROR_MESSAGES: Record<CrmErrorCode, string> = {
  unauthenticated: 'Your session expired. Sign in again to continue.',
  forbidden: 'You do not have permission to change this capability.',
  not_found: 'That account was not found. Refresh the list and try again.',
  stale: 'Account or capability state changed before saving. The list has been refreshed.',
  idempotency_conflict: 'That request conflicted with an earlier change. Refresh and try again.',
  invalid_input: 'That capability change is not allowed for this account.',
  capacity_exceeded: 'Capacity limit reached.',
  hold_expired: 'Hold expired before confirmation.',
  window_closed: 'Messaging window is closed.',
  consent_withdrawn: 'Consent has been withdrawn.',
  provider_unavailable: 'Provider is temporarily unavailable. Retry shortly.',
  currency_mismatch: 'Currency mismatch.',
  approval_required: 'Approval is required before proceeding.',
  budget_exceeded: 'The response exceeded the size limit.',
  source_changed: 'The source record changed. Refresh and try again.',
};

export function describeCommandError(err: CommandError | CrmTransportError | unknown): string {
  if (err instanceof CrmTransportError) {
    return err.userMessage;
  }
  if (err && typeof err === 'object' && 'ok' in err && (err as CommandError).ok === false) {
    const cmdErr = err as CommandError;
    const reason = typeof cmdErr.detail?.reason === 'string' ? cmdErr.detail.reason : undefined;
    if (cmdErr.error === 'invalid_input' && reason) {
      switch (reason) {
        case 'guest_not_eligible':
          return 'Guests cannot hold CRM capabilities.';
        case 'self_grant':
          return 'You cannot change your own CRM capabilities.';
        case 'owner_implicit':
          return 'The workspace owner already holds every capability.';
        case 'account_disabled':
          return 'Disabled accounts cannot be granted CRM capabilities.';
        case 'not_admin':
          return 'Only admins can be granted Manage capabilities.';
        case 'unknown_capability':
          return 'This capability is not supported in this CRM version.';
        case 'unknown_scope':
          return 'That capability scope is not allowed or valid.';
        case 'endpoint_in_use':
          return 'This endpoint already belongs to another person (see Duplicate review).';
        case 'invalid_endpoint_format':
          return 'Enter a valid email address, phone number (with country code or 10-digit Indian mobile), or social handle.';
        case 'unknown_programme_slug':
          return 'Unknown TCG programme slug.';
        case 'invalid_programme_profile':
          return 'Please review the programme profile fields and try again.';
        case 'applications_board_missing':
          return 'Install the TCG Operating Pack in Workspace or CRM before creating applications.';
        case 'target_board_not_found':
          return 'Choose a valid destination database for conversion.';
        case 'same_person':
          return 'Choose two different people to merge.';
        case 'people_records_only':
          return 'Only records from the People database can be merged here.';
        case 'already_merged':
          return 'One of these person records has already been merged.';
        case 'survivor_archived':
          return 'The selected canonical person record is archived and cannot absorb another record.';
        case 'confirm_required':
          return 'Confirm the merge or unmerge action before continuing.';
        case 'ui_only':
          return 'Merging and unmerging people must be confirmed directly in the CRM interface.';
        case 'already_unmerged':
          return 'This merge has already been unmerged.';
        case 'expected_revisions_required':
          return 'Reload the reviewed records before confirming this merge or unmerge.';
        case 'person_merged_or_archived':
          return 'This person record has been merged or archived. Perform changes on the canonical contact instead.';
        case 'secret_name_required_for_production':
          return 'Provide a Worker secret binding name before enabling production transport.';
        case 'worker_secret_not_bound':
          return 'The configured Worker secret is not bound in this environment. Production transport stays disabled.';
        case 'zoho_config_incomplete_pending_O20':
          return 'Zoho Mail data centre, account ID, and sender address (O-20) are required before enabling production mode.';
        case 'whatsapp_phone_number_id_required_pending_O04':
          return 'WhatsApp Phone Number ID (O-04) is required before enabling production mode.';
        case 'provider_channel_mismatch':
          return 'Selected provider does not match the chosen channel.';
      }
    }
    if (cmdErr.error === 'forbidden' && reason === 'admin_required') {
      return 'Only workspace owners and admins with Merge permission can unmerge records.';
    }
    if (cmdErr.error === 'stale' && reason === 'unmerge_conflicts') {
      return 'Cannot unmerge cleanly because linked data changed after the merge. Review the conflicts below.';
    }
    if (cmdErr.error === 'budget_exceeded' && reason === 'merge_budget_exceeded') {
      return 'This merge touches more linked records than a single safe batch allows.';
    }
    return COMMAND_ERROR_MESSAGES[cmdErr.error] ?? 'Could not update capability. Refresh and retry.';
  }
  if (err instanceof ApiError && err.status === 0) {
    return 'Capability changes need a connection';
  }
  return 'Could not update capability. Refresh and retry.';
}

export function describeAccountError(err: unknown): { message: string; shouldRefresh: boolean } {
  if (err instanceof ApiError) {
    const body = err.body as { error?: unknown; message?: unknown } | null | undefined;
    const code = typeof body?.error === 'string' ? body.error : err.message;
    if (code === OWNER_PROTECTED_ERROR) {
      return { message: 'The owner account can only be changed by the owner.', shouldRefresh: true };
    }
    if (code === 'owner_only') {
      return { message: 'Only the workspace owner can rename another account.', shouldRefresh: false };
    }
    if (code === 'invalid_name') {
      return { message: 'Enter a valid account name (1 to 80 characters).', shouldRefresh: false };
    }
    if (code === 'account_or_authority_changed' || code === 'capacity_or_authority_changed') {
      return { message: 'Someone changed this account. The list has been refreshed.', shouldRefresh: true };
    }
    if (code === 'capacity_full') {
      return {
        message: 'All seven active places are in use. Free a place before restoring access.',
        shouldRefresh: true,
      };
    }
    if (code === 'connector_cleanup_pending') {
      return {
        message: 'Account remains disabled. Retry when connector revocation is available.',
        shouldRefresh: false,
      };
    }
    if (code === 'authority_changed') {
      return { message: 'Your admin access changed. The list has been refreshed.', shouldRefresh: true };
    }
    if (err.status === 0) {
      return { message: 'Connection lost. Retry when connected.', shouldRefresh: false };
    }
    if (err.status === 401) {
      return { message: 'Your session expired. Sign in again to continue.', shouldRefresh: false };
    }
    if (typeof body?.message === 'string' && body.message.trim()) {
      return { message: body.message, shouldRefresh: false };
    }
  }
  return { message: 'Account change failed. Refresh and try again.', shouldRefresh: false };
}
