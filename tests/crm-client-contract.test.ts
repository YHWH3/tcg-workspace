import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  api: vi.fn(),
  token: 'token-a' as string | null,
  uid: 'user-a' as string | null,
  authStatus: 'authed' as 'loading' | 'authed' | 'unauthed',
  epoch: 0,
  liveConnected: false,
  dropSession: vi.fn(),
  authListeners: new Set<() => void>(),
  accessListeners: new Set<() => void>(),
  liveListeners: new Set<() => void>(),
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
        ? { id: mock.uid, username: mock.uid, name: mock.uid, role: 'admin', color: '#000' }
        : null,
    }),
    subscribe: (fn: () => void) => {
      mock.authListeners.add(fn);
      return () => mock.authListeners.delete(fn);
    },
  },
  dropSession: () => mock.dropSession(),
}));

vi.mock('../src/core/accessClient', () => ({
  accessClientStore: {
    get: () => ({ status: 'ready', manifest: null, reason: null, epoch: mock.epoch }),
    subscribe: (fn: () => void) => {
      mock.accessListeners.add(fn);
      return () => mock.accessListeners.delete(fn);
    },
  },
}));

vi.mock('../src/core/live', () => ({
  liveStore: {
    get: () => ({ users: [], connected: mock.liveConnected }),
    subscribe: (fn: () => void) => {
      mock.liveListeners.add(fn);
      return () => mock.liveListeners.delete(fn);
    },
  },
}));

import {
  CRM_STATUS_STORAGE_HINT_KEY,
  crmStatusStore,
  notifyCrmStatusUpdated,
  refreshCrmStatus,
  resetCrmStatusForTest,
  startCrmStatus,
} from '../src/core/crmStatus';
import {
  CrmTransportError,
  describeAccountError,
  describeCommandError,
  grantCrmCapability,
  runCrmCommand,
} from '../src/apps/crm/api';
import { CapabilityChangeOutputSchema } from '../shared/crm/contracts';

function deferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class MockWindow extends EventTarget {}
class MockDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
}

describe('CRM client status store & command contract (SC-1, SC-2.3, SC-4)', () => {
  let storageMap: Map<string, string>;
  let cleanups: (() => void)[];
  let mockWin: MockWindow;
  let mockDoc: MockDocument;

  beforeEach(() => {
    cleanups = [];
    storageMap = new Map([
      ['ws_uid', 'user-a'],
      ['ws_token', 'token-a'],
    ]);
    mock.uid = 'user-a';
    mock.token = 'token-a';
    mock.authStatus = 'authed';
    mock.epoch = 0;
    mock.liveConnected = false;
    mock.api.mockReset();
    mock.dropSession.mockReset();
    mock.authListeners.clear();
    mock.accessListeners.clear();
    mock.liveListeners.clear();

    mockWin = new MockWindow();
    mockDoc = new MockDocument();
    vi.stubGlobal('window', mockWin);
    vi.stubGlobal('document', mockDoc);
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => storageMap.set(k, v),
      removeItem: (k: string) => storageMap.delete(k),
    });
    vi.stubGlobal('fetch', vi.fn());
    resetCrmStatusForTest();
  });

  afterEach(() => {
    for (const c of cleanups) c();
    resetCrmStatusForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refreshes on all SC-2.3 triggers and never persists status/grants to localStorage', async () => {
    mock.api.mockResolvedValue({
      contract: 'crm-s0-v2',
      enabled: true,
      access: true,
      owner: false,
      capabilities: [{ capability: 'crm.access', scope: '*' }],
    });

    cleanups.push(startCrmStatus());
    await vi.waitFor(() => expect(crmStatusStore.get().status).toBe('ready'));
    expect(mock.api).toHaveBeenCalledTimes(1);

    // 1. ws-records-changed
    mockWin.dispatchEvent(new Event('ws-records-changed'));
    await vi.waitFor(() => expect(mock.api).toHaveBeenCalledTimes(2));

    // 2. focus / pageshow / visibilitychange (visible)
    mockWin.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(mock.api).toHaveBeenCalledTimes(3));
    mockWin.dispatchEvent(new Event('pageshow'));
    await vi.waitFor(() => expect(mock.api).toHaveBeenCalledTimes(4));
    mockDoc.visibilityState = 'hidden';
    mockDoc.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(mock.api).toHaveBeenCalledTimes(4);
    mockDoc.visibilityState = 'visible';
    mockDoc.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(mock.api).toHaveBeenCalledTimes(5));

    // 3. Live WebSocket reconnect
    mock.liveConnected = true;
    for (const fn of mock.liveListeners) fn();
    await vi.waitFor(() => expect(mock.api).toHaveBeenCalledTimes(6));

    // 4. Cross-tab storage hint
    mockWin.dispatchEvent(
      Object.assign(new Event('storage'), { key: CRM_STATUS_STORAGE_HINT_KEY, newValue: '{"nonce":"1"}' }),
    );
    await vi.waitFor(() => expect(mock.api).toHaveBeenCalledTimes(7));

    // 5. Offline then online reconnect
    vi.stubGlobal('navigator', { onLine: false });
    mockWin.dispatchEvent(new Event('offline'));
    expect(crmStatusStore.get().offline).toBe(true);
    expect(crmStatusStore.get().status).toBe('offline');
    // Presentation-only cached status remains within same session; never written to localStorage.
    expect(crmStatusStore.get().data?.access).toBe(true);
    expect(storageMap.has('crmStatus')).toBe(false);

    vi.stubGlobal('navigator', { onLine: true });
    mockWin.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(mock.api).toHaveBeenCalledTimes(8));
    expect(crmStatusStore.get().offline).toBe(false);
    expect(crmStatusStore.get().status).toBe('ready');

    // Local notify writes only lightweight hint, never grants
    await notifyCrmStatusUpdated('user-b');
    const hint = JSON.parse(storageMap.get(CRM_STATUS_STORAGE_HINT_KEY) ?? '{}');
    expect(hint.userId).toBe('user-b');
    expect(hint.capabilities).toBeUndefined();
  });

  it('discards stale responses across account switch and accessClientStore epoch changes', async () => {
    const reqA = deferred<unknown>();
    const reqB = deferred<unknown>();
    mock.api.mockReturnValueOnce(reqA.promise).mockReturnValueOnce(reqB.promise);

    cleanups.push(startCrmStatus());

    // Switch to user-b before user-a response settles
    mock.uid = 'user-b';
    mock.token = 'token-b';
    mock.epoch = 1;
    storageMap.set('ws_uid', 'user-b');
    storageMap.set('ws_token', 'token-b');
    for (const fn of mock.authListeners) fn();

    expect(crmStatusStore.get().data).toBeNull();

    // Late user-a response must be discarded
    reqA.resolve({
      contract: 'crm-s0-v2',
      enabled: true,
      access: true,
      owner: true,
      capabilities: [{ capability: 'crm.access', scope: '*' }],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(crmStatusStore.get().data).toBeNull();

    // Current user-b response is accepted
    reqB.resolve({
      contract: 'crm-s0-v2',
      enabled: true,
      access: false,
      owner: false,
      capabilities: [],
    });
    await vi.waitFor(() => expect(crmStatusStore.get().status).toBe('ready'));
    expect(crmStatusStore.get().data?.access).toBe(false);
  });

  it('drops session on 401 only when identity matches, and clears protected state on 403/404', async () => {
    const { ApiError } = await import('../src/core/api');
    mock.api.mockRejectedValueOnce(new ApiError(401, 'unauthenticated'));

    await refreshCrmStatus();
    expect(mock.dropSession).toHaveBeenCalledTimes(1);
    expect(crmStatusStore.get().status).toBe('unauthed');
    expect(crmStatusStore.get().data).toBeNull();

    // Stale 401 from previous account must not drop replacement session
    const stale401 = deferred<unknown>();
    mock.api.mockReturnValueOnce(stale401.promise);
    const pending = refreshCrmStatus({ force: true });
    mock.uid = 'user-b';
    mock.token = 'token-b';
    stale401.reject(new ApiError(401, 'unauthenticated'));
    await pending;
    expect(mock.dropSession).toHaveBeenCalledTimes(1);
  });

  it('reuses identical requestId on 503 write_interrupted retry and generates fresh IDs per action', async () => {
    const fetchMock = vi.mocked(fetch);
    const seenIds: string[] = [];

    fetchMock
      .mockImplementationOnce(async (_url, init) => {
        seenIds.push(JSON.parse(String(init?.body)).requestId);
        return new Response(JSON.stringify({ error: 'write_interrupted', retryable: true }), {
          status: 503,
        });
      })
      .mockImplementationOnce(async (_url, init) => {
        seenIds.push(JSON.parse(String(init?.body)).requestId);
        return new Response(
          JSON.stringify({
            ok: true,
            commandId: 'cmd-1',
            result: {
              already: false,
              grant: { userId: 'u2', capability: 'crm.access', scope: '*', held: true },
            },
            projections: [],
          }),
          { status: 200 },
        );
      });

    mock.api.mockResolvedValue({
      contract: 'crm-s0-v2',
      enabled: true,
      access: true,
      owner: true,
      capabilities: [{ capability: 'crm.access', scope: '*' }],
    });

    const first = await grantCrmCapability(
      { userId: 'u2', capability: 'crm.access', scope: '*' },
      { retryDelayMs: 0 },
    );
    expect(first.ok).toBe(true);
    expect(seenIds).toHaveLength(2);
    expect(seenIds[0]).toBe(seenIds[1]);

    // Second user action generates a fresh requestId
    fetchMock.mockImplementationOnce(async (_url, init) => {
      seenIds.push(JSON.parse(String(init?.body)).requestId);
      return new Response(
        JSON.stringify({
          ok: true,
          commandId: 'cmd-2',
          result: {
            already: true,
            grant: { userId: 'u2', capability: 'crm.access', scope: '*', held: true },
          },
          projections: [],
        }),
        { status: 200 },
      );
    });

    await grantCrmCapability({ userId: 'u2', capability: 'crm.access', scope: '*' });
    expect(seenIds[2]).not.toBe(seenIds[0]);
  });

  it('preserves requestId on exhausted retryable failures and clears state on 403/forbidden', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'processing_budget', retryable: true }), { status: 503 }),
      ),
    );

    let thrown: unknown;
    try {
      await runCrmCommand(
        'capability.grant',
        { userId: 'u2', capability: 'crm.access', scope: '*' },
        CapabilityChangeOutputSchema,
        { maxTransientRetries: 1, retryDelayMs: 0 },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CrmTransportError);
    expect((thrown as CrmTransportError).retryable).toBe(true);
    expect((thrown as CrmTransportError).requestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);

    // CommandError('forbidden') triggers status refresh and clears prior access data
    crmStatusStore.set({
      status: 'ready',
      data: {
        contract: 'crm-s0-v2',
        enabled: true,
        access: true,
        owner: false,
        capabilities: [{ capability: 'crm.access', scope: '*' }],
      },
      offline: false,
      error: null,
      revision: 1,
    });
    mock.api.mockResolvedValueOnce({
      contract: 'crm-s0-v2',
      enabled: true,
      access: false,
      owner: false,
      capabilities: [],
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: 'forbidden', retryable: false }), { status: 200 }),
    );
    const forbidden = await runCrmCommand(
      'capability.grant',
      { userId: 'u2', capability: 'crm.access', scope: '*' },
      CapabilityChangeOutputSchema,
    );
    expect(forbidden.ok).toBe(false);
    await vi.waitFor(() => expect(crmStatusStore.get().data?.access).toBe(false));
  });

  it('maps SC-4, SC-5, and SC-6 errors into clear user-facing copy', async () => {
    const { ApiError } = await import('../src/core/api');
    expect(
      describeCommandError({
        ok: false,
        error: 'invalid_input',
        detail: { reason: 'not_admin' },
        retryable: false,
      }),
    ).toContain('Only admins');
    expect(
      describeCommandError({
        ok: false,
        error: 'invalid_input',
        detail: { reason: 'owner_implicit' },
        retryable: false,
      }),
    ).toContain('owner');
    expect(describeAccountError(new ApiError(403, 'owner_protected', { error: 'owner_protected' })).message).toBe(
      'The owner account can only be changed by the owner.',
    );
    expect(
      describeAccountError(new ApiError(409, 'account_or_authority_changed', { error: 'account_or_authority_changed' })),
    ).toEqual({
      message: 'Someone changed this account. The list has been refreshed.',
      shouldRefresh: true,
    });
  });
});
