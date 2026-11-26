import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  api: vi.fn(),
  token: 'token-a' as string | null,
  uid: 'user-a' as string | null,
  authStatus: 'authed' as 'loading' | 'authed' | 'unauthed',
  epoch: 0,
  dropSession: vi.fn(),
}));

vi.mock('../src/core/api', () => {
  class ApiError extends Error {
    status: number;
    body?: unknown;
    constructor(status: number, message: string, body?: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiError,
    getToken: () => mock.token,
    api: (...args: unknown[]) => mock.api(...args),
  };
});

vi.mock('../src/core/auth', () => ({
  authStore: {
    get: () => ({
      status: mock.authStatus,
      user: mock.uid
        ? { id: mock.uid, username: mock.uid, name: mock.uid, role: 'admin', workspaceRole: 'owner', color: '#000' }
        : null,
    }),
    subscribe: () => () => {},
  },
  dropSession: () => mock.dropSession(),
}));

vi.mock('../src/core/accessClient', () => ({
  accessClientStore: {
    get: () => ({ status: 'ready', manifest: null, reason: null, epoch: mock.epoch }),
    subscribe: () => () => {},
  },
}));

vi.mock('../src/core/live', () => ({
  liveStore: {
    get: () => ({ users: [], connected: false }),
    subscribe: () => () => {},
  },
}));

import {
  CrmTransportError,
  describeCommandError,
  extractUnmergeConflicts,
  fetchMergeHistory,
  fetchMergePreview,
  isIdentityChangedError,
  mergePeople,
  unmergePeople,
} from '../src/apps/crm/api';
import { resetCrmStatusForTest } from '../src/core/crmStatus';

function deferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const samplePreviewPayload = {
  survivor: {
    id: 'p_surv',
    title: 'Nandini Menon',
    rev: 4,
    archived: false,
    mergedInto: null,
    primaryEmail: 'nandini@example.org',
    primaryPhone: '+919800000100',
  },
  loser: {
    id: 'p_lose',
    title: 'Nandini Menon (Alt)',
    rev: 2,
    archived: false,
    mergedInto: null,
    primaryEmail: 'nandini@example.org',
    primaryPhone: '+919800000101',
  },
  alreadyMerged: false,
  fieldComparisons: [],
  endpointPlans: [],
  consentPreviews: [
    {
      channel: 'whatsapp' as const,
      scope: 'updates' as const,
      survivorStatus: 'granted' as const,
      loserStatus: 'withdrawn' as const,
      effectiveStatus: 'withdrawn' as const,
      strictestApplied: true,
    },
  ],
  referenceCounts: {
    syncedRecords: 1,
    links: 1,
    subRecords: 0,
    comments: 0,
    files: 0,
    loserBlocksPreserved: 1,
    endpoints: 2,
    consents: 2,
    conversations: 1,
    duplicateCandidates: 1,
    formPeopleKeys: 1,
    transitiveAliases: 0,
    approvalsAndSuggestions: 0,
  },
  withinBudget: true,
  budgetReasons: [],
  warnings: [],
};

const sampleMovedCounts = {
  fieldsCopied: 1,
  linksMoved: 1,
  linksDeduplicated: 0,
  selfLinksRemoved: 0,
  subRecordsMoved: 0,
  commentsMoved: 0,
  filesMoved: 0,
  endpointsMoved: 1,
  endpointsRetiredDuplicate: 1,
  conversationsMoved: 1,
  duplicateCandidatesUpdated: 1,
  formPeopleKeysMoved: 1,
  transitiveAliasesUpdated: 0,
};

describe('CRM S10 client API contract (merge preview, merge, unmerge, conflicts & identity safety)', () => {
  let storageMap: Map<string, string>;

  beforeEach(() => {
    storageMap = new Map([
      ['ws_uid', 'user-a'],
      ['ws_token', 'token-a'],
    ]);
    mock.uid = 'user-a';
    mock.token = 'token-a';
    mock.authStatus = 'authed';
    mock.epoch = 0;
    mock.api.mockReset();
    mock.dropSession.mockReset();

    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storageMap.set(k, v);
      },
      removeItem: (k: string) => {
        storageMap.delete(k);
      },
    });
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn());
    resetCrmStatusForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('encodes merge preview & history queries, parses responses, and discards delayed reads on identity change', async () => {
    mock.api.mockResolvedValueOnce(samplePreviewPayload);
    const preview = await fetchMergePreview('p/surv', 'p&lose');
    expect(mock.api).toHaveBeenCalledWith('/api/crm/read/merge-preview?survivorId=p%2Fsurv&loserId=p%26lose');
    expect(preview.consentPreviews[0]?.strictestApplied).toBe(true);

    mock.api.mockResolvedValueOnce({
      items: [
        {
          id: 'mg_1',
          survivorId: 'p_surv',
          survivorTitle: 'Nandini Menon',
          survivorRev: 5,
          mergedId: 'p_lose',
          mergedTitle: 'Nandini Menon (Alt)',
          mergedRev: 3,
          actorId: 'user-a',
          actorName: 'Pia Sol',
          commandId: 'cmd_1',
          note: 'Duplicate cleanup',
          movedCounts: sampleMovedCounts,
          createdAt: 1700000000000,
          unmerged: null,
        },
      ],
      next: 'cur_2',
      partial: false,
    });
    const hist = await fetchMergeHistory({ cursor: 'c_1', personId: 'p_surv' });
    expect(mock.api).toHaveBeenCalledWith('/api/crm/read/merges?cursor=c_1&personId=p_surv');
    expect(hist.items).toHaveLength(1);
    expect(hist.next).toBe('cur_2');

    const delayed = deferred<unknown>();
    mock.api.mockReturnValueOnce(delayed.promise);
    const inflight = fetchMergePreview('p_surv', 'p_lose');
    mock.uid = 'user-b';
    mock.token = 'token-b';
    storageMap.set('ws_uid', 'user-b');
    storageMap.set('ws_token', 'token-b');
    delayed.resolve(samplePreviewPayload);
    await expect(inflight).rejects.toSatisfy((e) => isIdentityChangedError(e));
  });

  it('sends expected revisions & reuses requestId for same-identity transient retries, while refusing offline & account-switch retries', async () => {
    const fetchMock = vi.mocked(fetch);

    // Offline refusal
    vi.stubGlobal('navigator', { onLine: false });
    await expect(
      mergePeople({ survivorId: 'p_surv', loserId: 'p_lose', confirm: true }),
    ).rejects.toSatisfy((e) => e instanceof CrmTransportError && e.kind === 'offline');
    expect(fetchMock).not.toHaveBeenCalled();

    // Online 503 retry within same identity reuses exact requestId & expected
    vi.stubGlobal('navigator', { onLine: true });
    const capturedBodies: { requestId: string; expected?: Record<string, number> }[] = [];
    fetchMock
      .mockImplementationOnce(async (_url, init) => {
        capturedBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ error: 'write_interrupted', retryable: true }), { status: 503 });
      })
      .mockImplementationOnce(async (_url, init) => {
        capturedBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            ok: true,
            commandId: 'cmd_m1',
            result: { mergeId: 'mg_1', survivorId: 'p_surv', mergedId: 'p_lose', movedCounts: sampleMovedCounts },
            projections: [],
          }),
          { status: 200 },
        );
      });

    const mergeRes = await mergePeople(
      { survivorId: 'p_surv', loserId: 'p_lose', confirm: true, fieldResolutions: { title: 'survivor' } },
      { expected: { p_surv: 4, p_lose: 2 }, retryDelayMs: 0 },
    );
    expect(mergeRes.ok).toBe(true);
    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[0].requestId).toBe(capturedBodies[1].requestId);
    expect(capturedBodies[0].expected).toEqual({ p_surv: 4, p_lose: 2 });

    // Unmerge retry aborted cleanly on account switch before retry fires
    const d503 = deferred<Response>();
    fetchMock.mockImplementationOnce(() => d503.promise);
    const pendingUnmerge = unmergePeople(
      { mergeId: 'mg_1', confirm: true, reason: 'Oops' },
      { maxTransientRetries: 2, retryDelayMs: 10 },
    );
    d503.resolve(new Response(JSON.stringify({ error: 'write_interrupted', retryable: true }), { status: 503 }));
    await Promise.resolve();
    mock.uid = 'user-b';
    mock.token = 'token-b';
    storageMap.set('ws_uid', 'user-b');
    storageMap.set('ws_token', 'token-b');
    await expect(pendingUnmerge).rejects.toSatisfy((e) => isIdentityChangedError(e));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('extracts structured unmerge conflicts and formats human S10 command error messages', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: 'stale',
          retryable: true,
          detail: {
            reason: 'unmerge_conflicts',
            conflicts: [
              {
                code: 'survivor_edited',
                entityId: 'p_surv',
                message: 'Survivor record changed independently (rev 5 -> 6).',
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const outcome = await unmergePeople({ mergeId: 'mg_1', confirm: true });
    expect(outcome.ok).toBe(false);
    const conflicts = extractUnmergeConflicts(outcome);
    expect(conflicts).toEqual([
      {
        code: 'survivor_edited',
        entityId: 'p_surv',
        message: 'Survivor record changed independently (rev 5 -> 6).',
      },
    ]);
    expect(describeCommandError(outcome)).toContain('Cannot unmerge cleanly');

    expect(
      describeCommandError({ ok: false, error: 'forbidden', detail: { reason: 'admin_required' }, retryable: false }),
    ).toContain('owners and admins');
    expect(
      describeCommandError({ ok: false, error: 'budget_exceeded', detail: { reason: 'merge_budget_exceeded' }, retryable: false }),
    ).toContain('safe batch');
    expect(
      describeCommandError({ ok: false, error: 'invalid_input', detail: { reason: 'same_person' }, retryable: false }),
    ).toContain('two different people');
  });
});
