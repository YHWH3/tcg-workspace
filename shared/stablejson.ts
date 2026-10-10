/* Deterministic JSON: object keys sorted recursively so two semantically
 * equal argument objects hash identically (MCP requestId dedupe). */

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = sortValue((v as Record<string, unknown>)[k]);
      if (val !== undefined) out[k] = val;
    }
    return out;
  }
  return v === undefined ? null : v;
}

/** sha256 hex of stableJson(args without `requestId`). */
export async function argsHash(args: unknown): Promise<string> {
  const stripped = args && typeof args === 'object' && !Array.isArray(args) ? Object.fromEntries(Object.entries(args as Record<string, unknown>).filter(([k]) => k !== 'requestId')) : args;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(stripped)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
