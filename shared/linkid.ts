/* Deterministic link ids — same (kind, fieldId, fromId, toId) → same id on client and worker. */

function fnv1a64hex(s: string): string {
  let h = 0xcbf29ce484222325n;
  const F = 0x100000001b3n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * F) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** 'lk_' + 16hex + 16hex = 35 chars. Relation direction must be normalised to the primary field BEFORE hashing. */
export function linkId(kind: string, fieldId: string, fromId: string, toId: string): string {
  const key = `${kind}|${fieldId}|${fromId}|${toId}`;
  const rev = `${kind}|${fieldId}|${toId}|${fromId}`;
  return `lk_${fnv1a64hex(key)}${fnv1a64hex(rev)}`;
}
