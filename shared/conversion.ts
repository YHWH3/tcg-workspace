/* Record conversion planner (Phase 3 §4): pure plan for "convert this record
 * into a record of another database" — the worker's convert_record /
 * convert_idea_to_project tools apply the returned PlannedWrites.
 *
 * Semantics:
 * - Destination record: fresh id, `boardId` = dest board, `status` = dest
 *   board's first column (records dbs without stages get null), `convertedFrom`
 *   = source id (the dedupe marker the worker checks before planning).
 * - `p_*` props copy ONLY when the field id exists in BOTH boards' `fields`
 *   with the same `type` — every dropped prop produces a warning.
 * - A `linkKind` link op points dest → src (default 'related').
 * - `sourceStage` patches the SOURCE record's `status` (e.g. idea →
 *   'converted'), validated against the source board's columns.
 * - `templateId` rides the dest patch as provenance; instantiating template
 *   body content is the worker's job (no snapshot reaches this planner). */

import { linkId } from './linkid';
import { fieldsOf } from './fields';
import type { PlannedWrite } from './templates';

/** Loose stored row: a worker Rec ({id, data}), a StoredRecord ({data, field_ts}), or the flat record data itself. */
export type ConversionRow = { id?: unknown; data?: unknown } & Record<string, unknown>;

export interface ConversionInput {
  src: ConversionRow;
  srcBoard: ConversionRow;
  destBoard: ConversionRow;
  /** Provenance marker stamped on the dest record when the conversion uses a template. */
  templateId?: string;
  linkKind?: string;
  /** Source record is patched to this column id (validated against srcBoard columns). */
  sourceStage?: string;
  /** Override dest title (defaults to the source title). */
  title?: string;
  /** Optional actor stamped as createdBy. */
  actorId?: string | null;
}

export interface ConversionPlan {
  ops: PlannedWrite[];
  destId: string;
  warnings: string[];
}

export type ConversionResult = ConversionPlan | { error: string };

const isRow = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Unwrap a {id, data} / {data, field_ts} wrapper to the flat row, else return the row itself. */
function rowOf(r: ConversionRow | null | undefined): Record<string, unknown> | null {
  if (!isRow(r)) return null;
  const d = r.data;
  return isRow(d) ? d : r;
}

function idOf(r: ConversionRow | null | undefined, row: Record<string, unknown> | null): string {
  return String(r?.id ?? row?.id ?? '');
}

function columnsOf(board: Record<string, unknown>): { id: string }[] {
  const c = board.columns;
  return Array.isArray(c) ? (c as { id: string }[]).filter((x) => isRow(x) && typeof x.id === 'string') : [];
}

/** planConversion — see module docstring for semantics. */
export function planConversion(input: ConversionInput, deps: { id: () => string; now: number }): ConversionResult {
  const srcRow = rowOf(input.src);
  const srcBoard = rowOf(input.srcBoard);
  const destBoard = rowOf(input.destBoard);
  if (!srcRow) return { error: 'source record not found' };
  if (!srcBoard) return { error: 'source database not found' };
  if (!destBoard) return { error: 'destination database not found' };
  const srcId = idOf(input.src, srcRow);
  const destBoardId = idOf(input.destBoard, destBoard);
  if (!srcId) return { error: 'source record has no id' };
  if (!destBoardId) return { error: 'destination database has no id' };

  const srcFields = new Map(fieldsOf(srcBoard).map((f) => [f.id, f]));
  const destFields = new Map(fieldsOf(destBoard).map((f) => [f.id, f]));

  // Validate sourceStage against the source board's columns before planning.
  if (input.sourceStage !== undefined) {
    const cols = columnsOf(srcBoard);
    if (!cols.some((c) => c.id === input.sourceStage)) {
      return { error: `unknown stage '${input.sourceStage}' for source board` };
    }
  }

  const warnings: string[] = [];
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(srcRow)) {
    if (!k.startsWith('p_')) continue;
    const fid = k.slice(2);
    const sf = srcFields.get(fid);
    const df = destFields.get(fid);
    if (!sf) {
      warnings.push(`field '${fid}' dropped: not defined on source board`);
      continue;
    }
    if (!df) {
      warnings.push(`field '${fid}' (${sf.name}) dropped: no matching field on destination board`);
      continue;
    }
    if (sf.type !== df.type) {
      warnings.push(`field '${fid}' (${sf.name}) dropped: type mismatch (${sf.type} source vs ${df.type} destination)`);
      continue;
    }
    props[k] = isRow(v) || Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : v;
  }

  const destId = deps.id();
  const destStatus = columnsOf(destBoard)[0]?.id ?? null;
  const linkKind = input.linkKind ?? 'related';
  const ops: PlannedWrite[] = [
    {
      collection: 'tasks',
      id: destId,
      patch: {
        boardId: destBoardId,
        title: input.title ?? srcRow.title,
        description: srcRow.description,
        status: destStatus,
        convertedFrom: srcId,
        ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
        createdBy: input.actorId ?? null,
        createdAt: deps.now,
        ...props,
      },
    },
    {
      collection: 'links',
      id: linkId(linkKind, null, destId, srcId),
      patch: {
        fromType: 'record',
        fromId: destId,
        toType: 'record',
        toId: srcId,
        kind: linkKind,
        fieldId: null,
        createdBy: input.actorId ?? null,
        createdAt: deps.now,
      },
    },
  ];
  if (input.sourceStage !== undefined) {
    ops.push({ collection: 'tasks', id: srcId, patch: { status: input.sourceStage } });
  }
  return { ops, destId, warnings };
}
