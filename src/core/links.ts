/**
 * Links: relation field values, blocked-by dependencies and free "related"
 * links. All stored in the `links` collection — never duplicated onto
 * records — so concurrent add/remove merges per-link under LWW.
 *
 * Deterministic ids come from shared/linkid.ts (same hash the worker uses):
 * client + worker producing the same tuple yield ONE row, and re-linking
 * flips `deleted` under LWW. Cycle/block checks from shared/deps.ts.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { authStore } from './auth';
import { db, type LocalRow } from './db';
import { mutate } from './sync/engine';
import { linkId, type LinkRow as SharedLinkRow } from '../../shared/linkid';
import { edgesOf, wouldCreateDependencyCycle, type DepEdge } from '../../shared/deps';

export { fnv1a64hex, linkId } from '../../shared/linkid';
export { dependenciesOf, dependentsOf, isBlocked, wouldCreateDependencyCycle, type DepEdge } from '../../shared/deps';
export type { LinkRow } from '../../shared/linkid';

export type LinkKind = 'relation' | 'blocks' | 'related';
export type LinkEndType = 'record' | 'page' | 'mooditem' | 'block' | 'file';

export interface LinkRef {
  type: LinkEndType;
  id: string;
}

/** Dexie row shape (LocalRow adds `_ts`). */
export interface DbLinkRow extends SharedLinkRow, LocalRow {}

/* ---------- queries ---------- */

export function useLinks(): DbLinkRow[] {
  return (useLiveQuery(() => db.collection('links').toArray(), [], []) ?? []) as DbLinkRow[];
}

/** Live 'blocks' edges for cycle/block checks. */
export function dependencyEdges(links: readonly { fromId?: unknown; toId?: unknown; kind?: unknown; deleted?: unknown }[]): DepEdge[] {
  return edgesOf(links);
}

/** Live relation targets for the PRIMARY direction of a field. */
export function relationTargets(links: readonly SharedLinkRow[], recordId: string, fieldId: string): string[] {
  return links
    .filter((l) => !l.deleted && l.kind === 'relation' && l.fieldId === fieldId && l.fromId === recordId)
    .map((l) => String(l.toId));
}

/** Live reverse values: links stored under a paired field pointing at this record. */
export function relationSources(links: readonly SharedLinkRow[], recordId: string, fieldId: string): string[] {
  return links
    .filter((l) => !l.deleted && l.kind === 'relation' && l.fieldId === fieldId && l.toId === recordId)
    .map((l) => String(l.fromId));
}

/** Records blocking `recordId` (incoming 'blocks' edges). */
export function blockedBy(links: readonly SharedLinkRow[], recordId: string): string[] {
  return links
    .filter((l) => !l.deleted && l.kind === 'blocks' && l.toId === recordId)
    .map((l) => String(l.fromId));
}

/** Records `recordId` blocks (outgoing 'blocks' edges). */
export function blocking(links: readonly SharedLinkRow[], recordId: string): string[] {
  return links
    .filter((l) => !l.deleted && l.kind === 'blocks' && l.fromId === recordId)
    .map((l) => String(l.toId));
}

/* ---------- writes ---------- */

export async function link(from: LinkRef, to: LinkRef, kind: LinkKind, fieldId?: string | null): Promise<string> {
  const id = linkId(kind, fieldId ?? '', from.id, to.id);
  const me = authStore.get().user;
  const existing = await db.collection('links').get(id);
  await mutate('links', id, {
    fromType: from.type,
    fromId: from.id,
    toType: to.type,
    toId: to.id,
    kind,
    fieldId: fieldId ?? null,
    deleted: false,
    ...(existing ? {} : { createdBy: me?.id ?? null, createdAt: Date.now() }),
  });
  return id;
}

export async function unlink(id: string): Promise<void> {
  await mutate('links', id, { deleted: true });
}

/** Unlink by ends instead of row id (row id is derived anyway). */
export async function unlinkEnds(fromId: string, toId: string, kind: LinkKind, fieldId?: string | null): Promise<void> {
  await mutate('links', linkId(kind, fieldId ?? '', fromId, toId), { deleted: true });
}

/**
 * `blockerId` must finish before `blockedId`: edge blocker→blocked.
 * Throws on cycle. Returns the link id.
 */
export async function addDependency(blockerId: string, blockedId: string): Promise<string> {
  const edges = edgesOf((await db.collection('links').toArray()) as unknown as DbLinkRow[]);
  if (wouldCreateDependencyCycle(edges, blockerId, blockedId)) {
    throw new Error('Dependency cycle: this record already depends, directly or indirectly, on the target.');
  }
  return link({ type: 'record', id: blockerId }, { type: 'record', id: blockedId }, 'blocks');
}

export async function removeDependency(blockerId: string, blockedId: string): Promise<void> {
  await unlinkEnds(blockerId, blockedId, 'blocks');
}

/* ---------- relation fields ---------- */

import type { FieldDef } from '../../shared/fields';
export type RelationFieldDef = FieldDef & { type: 'relation'; relation: NonNullable<FieldDef['relation']> };

export function isRelationField(f: FieldDef | undefined | null): f is RelationFieldDef {
  return !!f && f.type === 'relation' && !!f.relation && typeof f.relation.target === 'string';
}

/** Is this field the reverse side of a two-way relation? */
export function isReverseRelation(field: RelationFieldDef): boolean {
  const r = field.relation;
  return r.primary !== true && !!r.pairedFieldId;
}

/** The field id links are stored under for this field (primary direction). */
export function storedFieldId(field: RelationFieldDef): string {
  return isReverseRelation(field) ? field.relation.pairedFieldId! : field.id;
}

/**
 * Linked item ids for `recordId` through `field`, handling both directions:
 * primary/one-way fields read links {fieldId:F, fromId:rec}; reverse paired
 * fields read links {fieldId:paired, toId:rec}.
 */
export function relationValues(links: readonly SharedLinkRow[], recordId: string, field: RelationFieldDef): string[] {
  if (isReverseRelation(field)) return relationSources(links, recordId, field.relation.pairedFieldId!);
  return relationTargets(links, recordId, field.id);
}

/** Write a relation link for `field` on `recordId` → `target`, normalised to the primary direction. */
export async function linkRelation(recordId: string, field: RelationFieldDef, target: LinkRef): Promise<string> {
  const r = field.relation;
  if (isReverseRelation(field)) {
    return link(target, { type: 'record', id: recordId }, 'relation', r.pairedFieldId!);
  }
  return link({ type: 'record', id: recordId }, target, 'relation', field.id);
}

/** Remove the link between `recordId` and `targetId` under `field` (either direction). */
export async function unlinkRelation(recordId: string, field: RelationFieldDef, targetId: string): Promise<void> {
  const r = field.relation;
  if (isReverseRelation(field)) {
    await unlinkEnds(targetId, recordId, 'relation', r.pairedFieldId!);
  } else {
    await unlinkEnds(recordId, targetId, 'relation', field.id);
  }
}
