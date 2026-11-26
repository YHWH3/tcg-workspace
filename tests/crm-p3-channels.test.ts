import { describe, expect, it } from 'vitest';
import {
  ConfigureChannelAccountInputSchema,
  HUMAN_AGENT_WINDOW_MS,
  META_GRAPH_HOST,
  STANDARD_WINDOW_MS,
  ZOHO_ACCOUNTS_HOSTS,
  ZOHO_API_HOSTS,
  buildRfcReferences,
  canAdvanceMessageStatus,
  computeOutboxBackoffMs,
  evaluateChannelWindow,
  isOptOutMessageText,
  isProviderCompatibleWithChannel,
  isRetryableAdapterError,
  normalizeEmailSubject,
  normalizeMetaScopedId,
  normalizeRfcMessageId,
  parseRfcReferences,
} from '../shared/crm/channels';

describe('CRM P3 channels pure helpers & contracts', () => {
  it('enforces exact Zoho DC and Meta Graph host allowlists and channel-provider compatibility', () => {
    expect(ZOHO_API_HOSTS.in).toBe('mail.zoho.in');
    expect(ZOHO_API_HOSTS.com).toBe('mail.zoho.com');
    expect(ZOHO_ACCOUNTS_HOSTS.in).toBe('accounts.zoho.in');
    expect(META_GRAPH_HOST).toBe('graph.facebook.com');

    expect(isProviderCompatibleWithChannel('email_zoho', 'email')).toBe(true);
    expect(isProviderCompatibleWithChannel('email_zoho', 'whatsapp')).toBe(false);
    expect(isProviderCompatibleWithChannel('whatsapp_cloud', 'whatsapp')).toBe(true);
    expect(isProviderCompatibleWithChannel('instagram_meta', 'instagram')).toBe(true);
    expect(isProviderCompatibleWithChannel('facebook_meta', 'facebook')).toBe(true);
    expect(isProviderCompatibleWithChannel('simulated', 'whatsapp')).toBe(true);

    const parsed = ConfigureChannelAccountInputSchema.parse({
      channel: 'email',
      provider: 'email_zoho',
      label: 'Contact Desk',
      externalId: 'contact@riverbank.example',
    });
    expect(parsed.mode).toBe('disabled');
    expect(parsed.active).toBe(false);
  });

  it('evaluates 24h WhatsApp template rules and 7-day Meta HUMAN_AGENT human-only window rules', () => {
    const now = 1_700_000_000_000;

    // Email is always open
    expect(evaluateChannelWindow({ channel: 'email', windowExpiresAt: null, now })).toMatchObject({
      open: true,
      requiresTemplate: false,
      requiresHumanAgentTag: false,
    });

    // WhatsApp inside 24h window -> open, no template required
    expect(
      evaluateChannelWindow({ channel: 'whatsapp', windowExpiresAt: now + 60_000, now }),
    ).toMatchObject({ open: true, standardOpen: true, requiresTemplate: false });

    // WhatsApp outside 24h window -> closed, template required
    expect(
      evaluateChannelWindow({ channel: 'whatsapp', windowExpiresAt: now - 1000, now }),
    ).toMatchObject({ open: false, standardOpen: false, requiresTemplate: true });

    // Instagram between 24h and 7d: human UI with humanAgentApproved=true -> open with HUMAN_AGENT tag
    const haWindow = now + HUMAN_AGENT_WINDOW_MS - STANDARD_WINDOW_MS;
    expect(
      evaluateChannelWindow({
        channel: 'instagram',
        windowExpiresAt: now - 1000,
        humanAgentWindowExpiresAt: haWindow,
        humanAgentApproved: true,
        via: 'ui',
        now,
      }),
    ).toMatchObject({
      open: true,
      standardOpen: false,
      humanAgentEligible: true,
      requiresHumanAgentTag: true,
    });

    // Automation / MCP NEVER eligible for HUMAN_AGENT tag!
    expect(
      evaluateChannelWindow({
        channel: 'facebook',
        windowExpiresAt: now - 1000,
        humanAgentWindowExpiresAt: haWindow,
        humanAgentApproved: true,
        via: 'automation',
        now,
      }),
    ).toMatchObject({ open: false, humanAgentEligible: false, requiresHumanAgentTag: false });

    // Unapproved Meta account cannot use HUMAN_AGENT tag
    expect(
      evaluateChannelWindow({
        channel: 'instagram',
        windowExpiresAt: now - 1000,
        humanAgentWindowExpiresAt: haWindow,
        humanAgentApproved: false,
        via: 'ui',
        now,
      }),
    ).toMatchObject({ open: false, humanAgentEligible: false });
  });

  it('normalizes RFC 5322 Message-ID / References headers, opt-out keywords, and Meta scoped IDs', () => {
    expect(normalizeRfcMessageId('  abc123@mail.zoho.in  ')).toBe('<abc123@mail.zoho.in>');
    expect(normalizeRfcMessageId('<m1@example.org>')).toBe('<m1@example.org>');
    expect(normalizeRfcMessageId('invalid-no-at')).toBeNull();

    const refs = parseRfcReferences('<m1@a.org> <m2@b.org> <m1@a.org>');
    expect(refs).toEqual(['<m1@a.org>', '<m2@b.org>']);
    expect(buildRfcReferences(refs, 'm3@c.org')).toEqual(['<m1@a.org>', '<m2@b.org>', '<m3@c.org>']);
    expect(normalizeEmailSubject('Re: Fwd:  Pottery Workshop  ')).toBe('pottery workshop');

    expect(isOptOutMessageText('STOP')).toBe(true);
    expect(isOptOutMessageText('stop.')).toBe(true);
    expect(isOptOutMessageText('Unsubscribe!')).toBe(true);
    expect(isOptOutMessageText('Please do not message me')).toBe(false);
    expect(isOptOutMessageText('Do not contact me')).toBe(true);
    expect(isOptOutMessageText('Please stop by the studio at 5pm')).toBe(false);

    expect(normalizeMetaScopedId('instagram', '17841400123')).toBe('igsid:17841400123');
    expect(normalizeMetaScopedId('instagram', 'igsid:17841400123')).toBe('igsid:17841400123');
    expect(normalizeMetaScopedId('facebook', '9988776655')).toBe('psid:9988776655');
    expect(normalizeMetaScopedId('facebook', 'psid:9988776655')).toBe('psid:9988776655');
    expect(normalizeMetaScopedId('facebook', 'bad id with spaces')).toBeNull();
  });

  it('enforces monotonic delivery status progression and bounded exponential retry backoff', () => {
    expect(canAdvanceMessageStatus('sent', 'delivered')).toBe(true);
    expect(canAdvanceMessageStatus('delivered', 'read')).toBe(true);
    expect(canAdvanceMessageStatus('read', 'delivered')).toBe(false);
    expect(canAdvanceMessageStatus('delivered', 'sent')).toBe(false);
    expect(canAdvanceMessageStatus('read', 'failed')).toBe(false);

    expect(isRetryableAdapterError('transient')).toBe(true);
    expect(isRetryableAdapterError('rate_limited')).toBe(true);
    expect(isRetryableAdapterError('unknown')).toBe(false);
    expect(isRetryableAdapterError('auth')).toBe(false);
    expect(isRetryableAdapterError('window_closed')).toBe(false);

    expect(computeOutboxBackoffMs(1)).toBe(30_000);
    expect(computeOutboxBackoffMs(2)).toBe(120_000);
    expect(computeOutboxBackoffMs(3)).toBe(600_000);
    expect(computeOutboxBackoffMs(9)).toBe(600_000);
  });
});
