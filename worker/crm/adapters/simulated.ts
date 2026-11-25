import type { Env } from '../../auth';
import type { ConversationChannel } from '../../../shared/crm/conversations';

export function isLocalTestSimulatedMode(env: Pick<Env, 'WORKSPACE_ENV'>): boolean {
  return (env.WORKSPACE_ENV ?? '').trim() === 'local-test';
}

export type SimulatedDeliveryResult =
  | { ok: true; receiptId: string; deliveredAt: number }
  | { ok: false; error: 'provider_unavailable'; detail: string };

/**
 * Simulated channel delivery adapter for local development & UX testing only.
 * Strictly gated behind `WORKSPACE_ENV === 'local-test'`; performs zero external network I/O.
 */
export function deliverViaSimulatedAdapter(
  env: Pick<Env, 'WORKSPACE_ENV'>,
  opts: { channel: ConversationChannel; messageId: string; recipientEndpoint: string | null },
  now = Date.now(),
): SimulatedDeliveryResult {
  if (!isLocalTestSimulatedMode(env)) {
    return {
      ok: false,
      error: 'provider_unavailable',
      detail: 'Live external channels are disabled in P1; simulated delivery requires local-test.',
    };
  }
  return {
    ok: true,
    receiptId: `sim_${opts.channel}_${opts.messageId.slice(0, 12)}`,
    deliveredAt: now,
  };
}
