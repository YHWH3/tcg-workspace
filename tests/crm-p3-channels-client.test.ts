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
  configureChannelAccount,
  describeCommandError,
  fetchChannelsOverview,
  isIdentityChangedError,
  pollChannelAccountNow,
  resolveMessageReview,
} from '../src/apps/crm/api';
import { resetCrmStatusForTest } from '../src/core/crmStatus';

describe('CRM P3 channels & delivery review client API contract', () => {
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
      setItem: (k: string, v: string) => storageMap.set(k, v),
      removeItem: (k: string) => storageMap.delete(k),
    });
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn());
    resetCrmStatusForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches channels overview, discards stale response on account switch, and refuses offline commands', async () => {
    const sampleOverview = {
      accounts: [
        {
          id: 'ch_1',
          channel: 'email',
          provider: 'email_zoho',
          label: 'Contact Desk',
          externalId: 'contact@riverbank.example',
          mode: 'disabled',
          active: false,
          secretName: 'ZOHO_MAIL_CRED_JSON',
          secretBound: false,
          config: { dataCenter: 'in' },
          pollCursor: null,
          lastPollAt: null,
          healthState: 'disconnected',
          lastError: null,
          lastErrorAt: null,
          rev: 1,
          updatedAt: 1700000000000,
        },
      ],
      templates: [],
      deliveries: [],
      counts: { queued: 0, sending: 0, sent: 0, failed: 0, reviewRequired: 0, cancelled: 0 },
      simulatedMode: true,
      canManageChannels: true,
      partial: false,
    };

    mock.api.mockResolvedValueOnce(sampleOverview);
    const overview = await fetchChannelsOverview();
    expect(mock.api).toHaveBeenCalledWith('/api/crm/read/channels');
    expect(overview.accounts[0]?.mode).toBe('disabled');

    // Delayed response after account switch MUST discard
    let resolveDelayed!: (v: unknown) => void;
    mock.api.mockReturnValueOnce(new Promise((r) => { resolveDelayed = r; }));
    const inflight = fetchChannelsOverview();
    mock.uid = 'user-b';
    mock.token = 'token-b';
    storageMap.set('ws_uid', 'user-b');
    storageMap.set('ws_token', 'token-b');
    resolveDelayed(sampleOverview);
    await expect(inflight).rejects.toSatisfy((e) => isIdentityChangedError(e));

    // Offline command refusal
    vi.stubGlobal('navigator', { onLine: false });
    await expect(
      pollChannelAccountNow({ accountId: 'ch_1' }),
    ).rejects.toSatisfy((e) => e instanceof CrmTransportError && e.kind === 'offline');
  });

  it('reuses requestId across transient 503 retries on message.resolve_review and surfaces clear P3 error messages', async () => {
    const fetchMock = vi.mocked(fetch);
    const seenIds: string[] = [];
    fetchMock
      .mockImplementationOnce(async (_url, init) => {
        seenIds.push(JSON.parse(String(init?.body)).requestId);
        return new Response(JSON.stringify({ error: 'write_interrupted', retryable: true }), { status: 503 });
      })
      .mockImplementationOnce(async (_url, init) => {
        seenIds.push(JSON.parse(String(init?.body)).requestId);
        return new Response(
          JSON.stringify({
            ok: true,
            commandId: 'cmd_r1',
            result: { messageId: 'msg_1', status: 'sent', providerReceipt: 'rcpt_1' },
            projections: [],
          }),
          { status: 200 },
        );
      });

    const res = await resolveMessageReview(
      { messageId: 'msg_1', resolution: 'confirm_sent', providerReceipt: 'rcpt_1' },
      { retryDelayMs: 0 },
    );
    expect(res).toMatchObject({ ok: true, result: { status: 'sent' } });
    expect(seenIds).toHaveLength(2);
    expect(seenIds[0]).toBe(seenIds[1]);

    // Configure channel error message mapping
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: 'invalid_input',
          detail: { reason: 'zoho_config_incomplete_pending_O20' },
          retryable: false,
        }),
        { status: 200 },
      ),
    );
    const cfgErr = await configureChannelAccount({
      channel: 'email',
      provider: 'email_zoho',
      label: 'Zoho',
      externalId: 'contact@example.org',
      mode: 'production',
      active: true,
      config: {},
    });
    expect(describeCommandError(cfgErr)).toContain('O-20');
  });
});
