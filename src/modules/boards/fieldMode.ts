/* Field mode (Phase 3 §1.3 / §6): capture kinds, the `ws_field_ctx` context
 * shape, `board.captureTargets`/`board.fieldActions` routing, the durable
 * capture-draft shape and form→record mapping.
 *
 * Pure helpers only — no Dexie/React imports and no shared/ edits. Draft
 * persistence lives in Capture.tsx on top of the drafts meta envelope. */

import type { BoardRow } from './api';
import { INBOX_BOARD_ID } from './model';
import { coerceFieldValue, fieldsOf, type FieldType } from './model';

/* ---------- kinds ---------- */

/** Quick-action kinds a capture can be. The first four route via captureTargets. */
export type CaptureKind = 'observation' | 'expense' | 'task' | 'note' | 'photo' | 'voice' | 'text';
/** Kinds routable through `board.captureTargets`. */
export type RoutedKind = 'observation' | 'expense' | 'task' | 'note';

export const ROUTED_KINDS: readonly RoutedKind[] = ['observation', 'expense', 'task', 'note'];
/** Chip order + the default set when a context db defines no fieldActions. */
export const BASE_CAPTURE_KINDS: readonly CaptureKind[] = ['photo', 'voice', 'text', 'note', 'task', 'observation', 'expense'];

export const CAPTURE_KIND_LABELS: Record<CaptureKind, string> = {
  photo: 'Photo',
  voice: 'Voice',
  text: 'Text',
  note: 'Note',
  task: 'Task',
  observation: 'Observation',
  expense: 'Expense',
};

export function isRoutedKind(kind: CaptureKind): kind is RoutedKind {
  return (ROUTED_KINDS as readonly string[]).includes(kind);
}

/* ---------- field context (ws_field_ctx, account-scoped) ---------- */

/** The record/page a field capture is taken "at"; stored in localStorage per
 * account (P3-R3: a shared browser profile must never leak one user's context
 * or destination to the next signed-in user). */
export interface FieldContext {
  id: string;
  kind: 'page' | 'record';
  title: string;
  databaseId?: string;
}

export const FIELD_CTX_KEY = 'ws_field_ctx';
export const CAPTURE_BOARD_KEY = 'ws_capture_board';

/** localStorage keys are account-scoped: `ws_field_ctx:<uid>`. */
export function fieldContextKey(userId: string): string {
  return `${FIELD_CTX_KEY}:${userId}`;
}
export function captureBoardKey(userId: string): string {
  return `${CAPTURE_BOARD_KEY}:${userId}`;
}

/** Drop the pre-scoping global keys (one-time migration hygiene). */
export function clearLegacyFieldPrefs(): void {
  try {
    localStorage.removeItem(FIELD_CTX_KEY);
    localStorage.removeItem(CAPTURE_BOARD_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function cleanFieldContext(raw: unknown): FieldContext | null {
  const c = raw as Partial<FieldContext> | null | undefined;
  if (!c || typeof c !== 'object') return null;
  if (typeof c.id !== 'string' || !c.id) return null;
  if (c.kind !== 'page' && c.kind !== 'record') return null;
  return {
    id: c.id,
    kind: c.kind,
    title: typeof c.title === 'string' ? c.title : '',
    databaseId: typeof c.databaseId === 'string' && c.databaseId ? c.databaseId : undefined,
  };
}

export function loadFieldContext(userId: string | undefined): FieldContext | null {
  try {
    clearLegacyFieldPrefs();
    if (!userId) return null;
    const raw = localStorage.getItem(fieldContextKey(userId));
    if (!raw) return null;
    return cleanFieldContext(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveFieldContext(userId: string | undefined, ctx: FieldContext | null): void {
  try {
    clearLegacyFieldPrefs();
    if (!userId) return;
    if (ctx) localStorage.setItem(fieldContextKey(userId), JSON.stringify(ctx));
    else localStorage.removeItem(fieldContextKey(userId));
  } catch {
    /* storage unavailable */
  }
}

/* ---------- captureTargets / fieldActions on boards ---------- */

export interface CaptureTarget {
  kind: RoutedKind;
  databaseId: string;
}

type BoardCfg = { captureTargets?: unknown; fieldActions?: unknown; deleted?: unknown } | null | undefined;

export function captureTargetsOf(board: BoardCfg): CaptureTarget[] {
  const raw = board?.captureTargets;
  if (!Array.isArray(raw)) return [];
  const out: CaptureTarget[] = [];
  for (const t of raw as { kind?: unknown; databaseId?: unknown }[]) {
    if (typeof t?.kind === 'string' && (ROUTED_KINDS as readonly string[]).includes(t.kind) && typeof t?.databaseId === 'string' && t.databaseId) {
      out.push({ kind: t.kind as RoutedKind, databaseId: t.databaseId });
    }
  }
  return out;
}

/** Explicit quick-action set configured on the db, or null when absent. */
export function fieldActionsOf(board: BoardCfg): CaptureKind[] | null {
  const raw = board?.fieldActions;
  if (!Array.isArray(raw)) return null;
  return raw.filter((k): k is CaptureKind => typeof k === 'string' && (BASE_CAPTURE_KINDS as readonly string[]).includes(k));
}

/** Chips for a context db: exactly its fieldActions when set, else base kinds ∪ captureTargets kinds. */
export function actionsForContext(ctxBoard: BoardCfg): CaptureKind[] {
  const explicit = fieldActionsOf(ctxBoard);
  if (explicit) return explicit;
  const set = new Set<CaptureKind>(BASE_CAPTURE_KINDS);
  for (const t of captureTargetsOf(ctxBoard)) set.add(t.kind);
  return [...set];
}

/* ---------- destination resolution ---------- */

export interface ResolvedDestination {
  /** Resolved target database; undefined when an explicit choice is required. */
  databaseId?: string;
  /** User MUST pick a destination — never silently file elsewhere. */
  needsChoice: boolean;
  via?: 'target' | 'inbox' | 'default';
}

/**
 * Resolve where a capture kind lands.
 * - Routed kinds consult the context db's captureTargets; a missing/deleted
 *   target still requires an explicit choice.
 * - observation/expense with no configured target → needsChoice (required).
 * - task/note with no configured target → Inbox.
 * - photo/voice/text → `fallbackId` when alive, else Inbox.
 */
export function resolveDestination(
  kind: CaptureKind,
  ctxBoard: BoardCfg,
  boards: readonly { id: string; deleted?: unknown }[],
  fallbackId?: string | null,
): ResolvedDestination {
  const alive = (id: string | null | undefined) => !!id && boards.some((b) => b.id === id && !b.deleted);
  const inbox = alive(INBOX_BOARD_ID) ? INBOX_BOARD_ID : undefined;
  if (isRoutedKind(kind)) {
    const target = captureTargetsOf(ctxBoard).find((t) => t.kind === kind)?.databaseId;
    if (target) {
      return alive(target) ? { databaseId: target, needsChoice: false, via: 'target' } : { needsChoice: true };
    }
    if (kind === 'observation' || kind === 'expense') return { needsChoice: true };
    return inbox ? { databaseId: inbox, needsChoice: false, via: 'inbox' } : { needsChoice: true };
  }
  if (fallbackId && alive(fallbackId)) return { databaseId: fallbackId, needsChoice: false, via: 'default' };
  return inbox ? { databaseId: inbox, needsChoice: false, via: 'inbox' } : { needsChoice: true };
}

/* ---------- capture form + durable draft ---------- */

export interface CaptureForm {
  title?: string;
  text?: string;
  caption?: string;
  date?: string;
  measurement?: string;
  unit?: string;
  amount?: string;
  category?: string;
  due?: string;
  driveUrl?: string;
}

/** Persisted under draft:<user>:capture:pending — survives reload/orientation. */
export interface CaptureDraft extends CaptureForm {
  v: 1;
  kind: CaptureKind;
  ctx: FieldContext | null;
  /** Only persisted when the user picked a destination explicitly. */
  destId?: string;
  destTouched?: boolean;
  /** Media can't live in the meta envelope — presence is noted for restore UX. */
  photoCount?: number;
  hasVoice?: boolean;
  /** P3-R2 staged save: the destination record id, minted once and reused on
   * every retry so a mid-save failure never creates a duplicate record. */
  recordId?: string;
  /** Save progress for truthful partial state reporting. */
  stage?: 'record' | 'files' | 'links' | 'done';
}

/* ---------- staged capture save (P3-R2) ----------
 * Stable ids derived from the draft's recordId make every sub-operation of
 * save() idempotent: retry after a mid-save failure re-issues the same upserts
 * instead of creating a second record or duplicate attachments. */
export function captureId(recordId: string, role: string): string {
  return `cap_${fnvHex(`${recordId}:${role}`)}`;
}

function fnvHex(input: string): string {
  // 64-bit FNV-1a — same constant/shape as shared/linkid.ts, kept local so
  // fieldMode stays dependency-free (no shared/ imports).
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

export interface CapturePlanIds {
  recordId: string;
  photoIds: string[];
  docIds: string[];
  voiceId: string;
  linkFileId: string;
}

/** All ids a capture save touches, derived deterministically from recordId.
 * Stable across retries and reloads — regenerate with the same inputs. */
export function capturePlanIds(recordId: string, counts: { photos: number; docs: number; hasVoice: boolean; hasLink: boolean }): CapturePlanIds {
  return {
    recordId,
    photoIds: Array.from({ length: counts.photos }, (_, i) => captureId(recordId, `p${i}`)),
    docIds: Array.from({ length: counts.docs }, (_, i) => captureId(recordId, `d${i}`)),
    voiceId: captureId(recordId, 'v'),
    linkFileId: captureId(recordId, 'l'),
  };
}

const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Validate an arbitrary stored value into a CaptureDraft (restore path). */
export function cleanDraft(raw: unknown): CaptureDraft | undefined {
  const d = raw as Partial<CaptureDraft> | null | undefined;
  if (!d || typeof d !== 'object') return undefined;
  const kind: CaptureKind =
    typeof d.kind === 'string' && (BASE_CAPTURE_KINDS as readonly string[]).includes(d.kind) ? (d.kind as CaptureKind) : 'text';
  const stage = d.stage === 'record' || d.stage === 'files' || d.stage === 'links' || d.stage === 'done' ? d.stage : undefined;
  return {
    v: 1,
    kind,
    ctx: cleanFieldContext(d.ctx),
    destId: asStr(d.destId),
    destTouched: d.destTouched === true,
    title: asStr(d.title),
    text: asStr(d.text),
    caption: asStr(d.caption),
    date: asStr(d.date),
    measurement: asStr(d.measurement),
    unit: asStr(d.unit),
    amount: asStr(d.amount),
    category: asStr(d.category),
    due: asStr(d.due),
    driveUrl: asStr(d.driveUrl),
    photoCount: typeof d.photoCount === 'number' && d.photoCount > 0 ? Math.floor(d.photoCount) : undefined,
    hasVoice: d.hasVoice === true ? true : undefined,
    recordId: asStr(d.recordId),
    stage,
  };
}

/** Anything worth recovering? Context alone doesn't make a draft. */
export function draftHasContent(d: CaptureDraft): boolean {
  return !!(
    d.title?.trim() ||
    d.text?.trim() ||
    d.caption?.trim() ||
    d.measurement?.trim() ||
    d.unit?.trim() ||
    d.amount?.trim() ||
    d.category?.trim() ||
    d.due?.trim() ||
    d.driveUrl?.trim() ||
    (d.photoCount ?? 0) > 0 ||
    d.hasVoice
  );
}

/* ---------- form → record mapping ---------- */

/** Which form slots each routed kind writes. */
const KIND_SLOTS: Record<RoutedKind, (keyof CaptureForm)[]> = {
  observation: ['date', 'measurement', 'unit', 'text', 'driveUrl'],
  expense: ['amount', 'date', 'category', 'driveUrl'],
  note: ['text', 'driveUrl'],
  task: ['due', 'driveUrl'],
};

const SLOT_DEFS: Record<string, { label: string; names: string[]; types: FieldType[] }> = {
  date: { label: 'Date', names: ['date', 'day', 'when'], types: ['date', 'text'] },
  measurement: { label: 'Measurement', names: ['measurement', 'value', 'reading', 'amount'], types: ['number', 'text'] },
  unit: { label: 'Unit', names: ['unit', 'units'], types: ['text', 'select'] },
  text: { label: 'Notes', names: ['observation', 'notes', 'note', 'details', 'description', 'text'], types: ['text'] },
  amount: { label: 'Amount', names: ['amount', 'cost', 'total', 'price', 'value'], types: ['number', 'text'] },
  category: { label: 'Category', names: ['category', 'type', 'kind'], types: ['select', 'text'] },
  due: { label: 'Due', names: ['due', 'due date', 'deadline'], types: ['date', 'text'] },
  driveUrl: { label: 'Link', names: ['url', 'link', 'drive', 'receipt', 'reference'], types: ['url', 'text'] },
};

/**
 * Map form values onto the destination db's custom fields by (normalized)
 * field name + compatible type — the TCG pack is data, so e.g. an observation
 * lands on Field Log's `Measurement`/`Unit`/`Observation` fields by name.
 * Unmatched values come back as `Label: value` leftover lines for the body.
 */
export function propsForForm(
  board: BoardRow | undefined | null,
  kind: RoutedKind,
  form: CaptureForm,
): { props: Record<string, unknown>; leftovers: string[] } {
  const props: Record<string, unknown> = {};
  const leftovers: string[] = [];
  const fields = fieldsOf(board);
  const used = new Set<string>();
  const norm = (s: string) => s.trim().toLowerCase();
  for (const slot of KIND_SLOTS[kind]) {
    const raw = form[slot]?.trim();
    if (!raw) continue;
    const def = SLOT_DEFS[slot];
    const field = fields.find((f) => !used.has(f.id) && def.types.includes(f.type) && def.names.includes(norm(f.name)));
    if (field) {
      const v = coerceFieldValue(field, raw);
      if (v !== undefined) {
        props[`p_${field.id}`] = v;
        used.add(field.id);
        continue;
      }
    }
    leftovers.push(`${def.label}: ${raw}`);
  }
  return { props, leftovers };
}

const firstLine = (s?: string) => (s ?? '').trim().split('\n')[0]?.trim() ?? '';

/** Record title per kind — mirrors the legacy `Kind · <stamp>` fallback. */
export function titleFor(kind: CaptureKind, form: CaptureForm, stamp: string): string {
  switch (kind) {
    case 'task':
      return firstLine(form.title) || `Task · ${stamp}`;
    case 'observation': {
      const t = firstLine(form.text);
      if (t) return t;
      const m = form.measurement?.trim();
      const u = form.unit?.trim();
      return `Observation${m ? ` ${m}${u ? ` ${u}` : ''}` : ''} · ${form.date?.trim() || stamp}`;
    }
    case 'expense': {
      const c = form.category?.trim() || 'Expense';
      const a = form.amount?.trim();
      return `${c} · ${a || stamp}`;
    }
    case 'note':
      return firstLine(form.text) || `Note · ${stamp}`;
    case 'photo':
      return firstLine(form.caption) || `Photo · ${stamp}`;
    case 'voice':
      return firstLine(form.caption) || `Voice memo · ${stamp}`;
    case 'text':
      return firstLine(form.caption) || `Note · ${stamp}`;
  }
}

/** Record description/body: kind text plus any unmapped `Label: value` lines. */
export function bodyForKind(kind: CaptureKind, form: CaptureForm, leftovers: string[]): string {
  const parts: string[] = [];
  if (kind === 'observation' && form.text?.trim()) parts.push(form.text.trim());
  if (kind === 'note' && form.text) {
    const rest = form.text.split('\n').slice(1).join('\n').trim();
    if (rest) parts.push(rest);
  }
  if (kind === 'photo' || kind === 'voice' || kind === 'text') {
    const rest = (form.caption ?? '').split('\n').slice(1).join('\n').trim();
    if (rest) parts.push(rest);
  }
  if (leftovers.length) parts.push(leftovers.join('\n'));
  return parts.join('\n\n').trim();
}
