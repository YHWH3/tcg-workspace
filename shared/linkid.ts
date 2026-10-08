/* Deterministic link ids (Phase 1 §3.4): the same (kind, fieldId, fromId, toId)
 * always produces the same id on client and worker, so concurrent relinking is
 * idempotent and dedupe falls out of LWW instead of extra checks. */

export interface LinkRow {
  id: string;
  fromType?: 'record' | 'page' | 'mooditem' | 'block';
  fromId?: string;
  toType?: 'record' | 'page' | 'mooditem' | 'file';
  toId?: string;
  kind?: 'relation' | 'blocks' | 'related';
  fieldId?: string | null;
  createdBy?: string;
  createdAt?: number;
  deleted?: boolean;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

/** 64-bit FNV-1a over UTF-16 code units → 16 lowercase hex chars. Pure + sync. */
export function fnv1a64hex(input: string): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * FNV_PRIME) & FNV_MASK;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * 'lk_' + fnv1a64hex(kind|fieldId|fromId|toId) + fnv1a64hex(that string
 * reversed) → 35 chars (≤ 64 id cap). Relation direction must already be
 * normalised to the primary field (phase-1 §2.6) before calling this.
 */
export function linkId(kind: string, fieldId: string | null | undefined, fromId: string, toId: string): string {
  const fwd = `${kind}|${fieldId ?? ''}|${fromId}|${toId}`;
  const rev = [...fwd].reverse().join('');
  return `lk_${fnv1a64hex(fwd)}${fnv1a64hex(rev)}`;
}
