import type { ProposeFactInput, SaveMessageDraftInput } from '../../shared/crm/conversations';
import type { Env } from '../auth';
import { createCommandRegistry, runCommand, type RunCommandOutcome } from './commands';
import { createS4ConversationCommandDefs } from './conversations';
import { createS4FactCommandDefs } from './facts';

export type CrmCommandPreviewPlan =
  | {
      kind: 'crm_command';
      command: 'message.save_draft';
      input: SaveMessageDraftInput;
      expected?: Record<string, number>;
      summary: {
        targetId: string;
        previewFields: Record<string, unknown>;
        warnings?: string[];
      };
    }
  | {
      kind: 'crm_command';
      command: 'fact.propose';
      input: ProposeFactInput;
      expected?: Record<string, number>;
      summary: {
        targetId: string;
        previewFields: Record<string, unknown>;
        warnings?: string[];
      };
    };

export const ALLOWED_MCP_CRM_PREVIEW_COMMANDS = new Set(['message.save_draft', 'fact.propose'] as const);

export function isCrmCommandPreviewPlan(raw: unknown): raw is CrmCommandPreviewPlan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const p = raw as { kind?: unknown; command?: unknown; input?: unknown; summary?: unknown };
  return (
    p.kind === 'crm_command' &&
    typeof p.command === 'string' &&
    ALLOWED_MCP_CRM_PREVIEW_COMMANDS.has(p.command as 'message.save_draft' | 'fact.propose') &&
    Boolean(p.input && typeof p.input === 'object' && !Array.isArray(p.input)) &&
    Boolean(p.summary && typeof p.summary === 'object' && !Array.isArray(p.summary))
  );
}

export async function executeApprovedCrmPreviewCommand(args: {
  env: Env;
  executionCtx: { waitUntil(p: Promise<unknown>): void };
  actorId: string;
  tokenHash: string;
  previewId: string;
  plan: CrmCommandPreviewPlan;
}): Promise<RunCommandOutcome> {
  if (!isCrmCommandPreviewPlan(args.plan)) {
    throw new Error('unsupported_crm_preview_command');
  }
  const registry = createCommandRegistry([
    ...createS4ConversationCommandDefs(),
    ...createS4FactCommandDefs(),
  ]);
  const requestId = `prv_${args.previewId.replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 64);
  return runCommand({
    env: args.env,
    executionCtx: args.executionCtx,
    actorId: args.actorId,
    tokenHash: args.tokenHash,
    via: 'mcp',
    name: args.plan.command,
    envelope: {
      requestId,
      input: args.plan.input as unknown as Record<string, unknown>,
      ...(args.plan.expected ? { expected: args.plan.expected } : {}),
    },
    registry,
  });
}
