import {
  ProposeFactInputSchema,
  RetireFactInputSchema,
  VerifyFactInputSchema,
  isFactStale,
  type CrmFactDto,
  type FactsListResponse,
  type ProposeFactInput,
  type RetireFactInput,
  type VerifyFactInput,
} from '../../shared/crm/conversations';
import { isRegisteredProgrammeSlug, programmeScopeForSlug } from '../../shared/crm/programmes';
import type { Env } from '../auth';
import { pokeLive } from '../sync';
import type { AnyCommandDefinition, CommandDefinition } from './commands';
import { crmActorFence, loadCrmReadContext } from './read';
import { canAccessCrmApi, evaluateCapability } from './rules';

export interface FactRow {
  id: string;
  scope: string;
  programme_slug: string | null;
  category: string;
  title: string;
  statement: string;
  source_ref: string | null;
  status: 'draft' | 'verified' | 'retired';
  review_by: number | null;
  verified_by: string | null;
  verified_at: number | null;
  retired_by: string | null;
  retired_at: number | null;
  rev: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export function mapFactRow(row: FactRow, now = Date.now()): CrmFactDto {
  return {
    id: row.id,
    scope: row.scope,
    programmeSlug: row.programme_slug,
    category: row.category,
    title: row.title,
    statement: row.statement,
    sourceRef: row.source_ref,
    status: row.status,
    reviewBy: row.review_by,
    isStale: isFactStale({ status: row.status, reviewBy: row.review_by }, now),
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    rev: row.rev,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function factRevFence(db: D1Database, factId: string, expectedRev: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM crm_facts WHERE id = ? AND rev = ?
       ) THEN 1 ELSE json_extract('{', '$') END`,
    )
    .bind(factId, expectedRev);
}

function proposeFactCommand(): CommandDefinition<ProposeFactInput, { fact: CrmFactDto }> {
  return {
    name: 'fact.propose',
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = ProposeFactInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: 'invalid_input', detail: { reason: 'invalid_fact_input' } };
      }
      if (parsed.data.programmeSlug && !isRegisteredProgrammeSlug(parsed.data.programmeSlug)) {
        return { ok: false, error: 'invalid_input', detail: { reason: 'unknown_programme_slug' } };
      }
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const id = `fact_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const scope = input.programmeSlug ? programmeScopeForSlug(input.programmeSlug) : 'global';
      const row: FactRow = {
        id,
        scope,
        programme_slug: input.programmeSlug ?? null,
        category: input.category,
        title: input.title,
        statement: input.statement,
        source_ref: input.sourceRef ?? null,
        status: 'draft',
        review_by: input.reviewBy ?? null,
        verified_by: null,
        verified_at: null,
        retired_by: null,
        retired_at: null,
        rev: 1,
        created_by: actor.id,
        created_at: now,
        updated_at: now,
      };
      const stmt = env.DB
        .prepare(
          `INSERT INTO crm_facts
             (id, scope, programme_slug, category, title, statement, source_ref, status, review_by, verified_by, verified_at, retired_by, retired_at, rev, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, NULL, NULL, NULL, NULL, 1, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.scope,
          row.programme_slug,
          row.category,
          row.title,
          row.statement,
          row.source_ref,
          row.review_by,
          row.created_by,
          row.created_at,
          row.updated_at,
        );
      return {
        kind: 'commit',
        result: { fact: mapFactRow(row, now) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        rows: [stmt],
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

function verifyFactCommand(): CommandDefinition<VerifyFactInput, { fact: CrmFactDto }> {
  return {
    name: 'fact.verify',
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = VerifyFactInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: 'invalid_input', detail: { reason: 'invalid_fact_input' } };
      }
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const row = await env.DB
        .prepare(`SELECT * FROM crm_facts WHERE id = ?`)
        .bind(input.factId)
        .first<FactRow>();
      if (!row) return { kind: 'refuse', error: 'not_found' };
      const capScope = row.programme_slug ? programmeScopeForSlug(row.programme_slug) : '*';
      if (!evaluateCapability(actor, 'crm.configure', capScope)) {
        return { kind: 'refuse', error: 'forbidden' };
      }
      if (input.expectedRev !== undefined && row.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      const nextReviewBy = input.reviewBy !== undefined ? input.reviewBy : row.review_by;
      const updated: FactRow = {
        ...row,
        status: 'verified',
        review_by: nextReviewBy,
        verified_by: actor.id,
        verified_at: now,
        rev: row.rev + 1,
        updated_at: now,
      };
      const stmt = env.DB
        .prepare(
          `UPDATE crm_facts
           SET status = 'verified', review_by = ?, verified_by = ?, verified_at = ?, rev = rev + 1, updated_at = ?
           WHERE id = ?`,
        )
        .bind(nextReviewBy, actor.id, now, now, row.id);
      return {
        kind: 'commit',
        result: { fact: mapFactRow(updated, now) },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash, 'crm.configure', capScope),
          factRevFence(env.DB, row.id, row.rev),
        ],
        rows: [stmt],
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

function retireFactCommand(): CommandDefinition<RetireFactInput, { fact: CrmFactDto }> {
  return {
    name: 'fact.retire',
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = RetireFactInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: 'invalid_input', detail: { reason: 'invalid_fact_input' } };
      }
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const row = await env.DB
        .prepare(`SELECT * FROM crm_facts WHERE id = ?`)
        .bind(input.factId)
        .first<FactRow>();
      if (!row) return { kind: 'refuse', error: 'not_found' };
      const capScope = row.programme_slug ? programmeScopeForSlug(row.programme_slug) : '*';
      if (!evaluateCapability(actor, 'crm.configure', capScope)) {
        return { kind: 'refuse', error: 'forbidden' };
      }
      if (input.expectedRev !== undefined && row.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      const updated: FactRow = {
        ...row,
        status: 'retired',
        retired_by: actor.id,
        retired_at: now,
        rev: row.rev + 1,
        updated_at: now,
      };
      const stmt = env.DB
        .prepare(
          `UPDATE crm_facts
           SET status = 'retired', retired_by = ?, retired_at = ?, rev = rev + 1, updated_at = ?
           WHERE id = ?`,
        )
        .bind(actor.id, now, now, row.id);
      return {
        kind: 'commit',
        result: { fact: mapFactRow(updated, now) },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash, 'crm.configure', capScope),
          factRevFence(env.DB, row.id, row.rev),
        ],
        rows: [stmt],
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

export function createS4FactCommandDefs(): AnyCommandDefinition[] {
  return [proposeFactCommand(), verifyFactCommand(), retireFactCommand()];
}

const FACTS_CAP = 200;

export async function readFacts(
  env: Env,
  actorId: string,
  tokenHash: string,
  opts: { programmeSlug?: string | null; status?: string | null; includeStale?: boolean } = {},
): Promise<
  | { status: 200; body: FactsListResponse }
  | { status: 401 | 403 | 404; body: { error: 'unauthenticated' | 'forbidden' | 'not_found' } }
> {
  const auth = await loadCrmReadContext(env, actorId, tokenHash);
  if (!auth.ok) return { status: auth.status, body: auth.body };

  const statusFilter =
    opts.status === 'draft' || opts.status === 'verified' || opts.status === 'retired'
      ? opts.status
      : null;
  const progFilter = opts.programmeSlug?.trim() || null;

  const { results } = await env.DB
    .prepare(
      `SELECT * FROM crm_facts
       WHERE (?1 IS NULL OR status = ?1)
         AND (?2 IS NULL OR programme_slug = ?2 OR programme_slug IS NULL)
       ORDER BY updated_at DESC, id DESC
       LIMIT ?3`,
    )
    .bind(statusFilter, progFilter, FACTS_CAP + 1)
    .all<FactRow>();

  const now = Date.now();
  const partial = results.length > FACTS_CAP;
  const mapped = results
    .slice(0, FACTS_CAP)
    .map((r) => mapFactRow(r, now))
    .filter((f) => opts.includeStale !== false || !f.isStale);

  return { status: 200, body: { facts: mapped, partial } };
}
