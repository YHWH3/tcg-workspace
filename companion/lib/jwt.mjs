// ID-token validation against a published JWKS using WebCrypto.
// Only RS256 with a matching `kid` is accepted (no `none`, no HS*).
import { webcrypto } from 'node:crypto';

export class IdTokenError extends Error {
  constructor(reason, message) { super(message ?? `ID token rejected: ${reason}`); this.reason = reason; }
}

const dec = (part) => {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { throw new IdTokenError('malformed'); }
};

/** Decode without verifying (only for reading non-security display fields after validation). */
export function decodeJwtPayload(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) throw new IdTokenError('malformed');
  return dec(parts[1]);
}

/**
 * @param {string} idToken
 * @param {{jwks:{keys:any[]}, issuer:string, audience:string, nonce?:string|null, now:number, skewSec?:number}} opts
 *   `nonce: null` skips the nonce check (refresh-issued ID tokens); `undefined` is treated as required-but-missing.
 * @returns {Promise<Record<string, any>>} validated claims
 */
export async function verifyIdToken(idToken, opts) {
  const parts = String(idToken ?? '').split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) throw new IdTokenError('malformed');
  const header = dec(parts[0]);
  const claims = dec(parts[1]);
  if (header.alg !== 'RS256') throw new IdTokenError('unsupported_alg', `ID token rejected: algorithm ${String(header.alg)} not accepted`);
  const keys = Array.isArray(opts.jwks?.keys) ? opts.jwks.keys : [];
  const jwk = keys.find((k) => k && k.kty === 'RSA' && k.kid === header.kid && (k.use === undefined || k.use === 'sig'));
  if (!header.kid || !jwk) throw new IdTokenError('unknown_kid');
  let key;
  try {
    const { kty, n, e } = jwk;
    key = await webcrypto.subtle.importKey('jwk', { kty, n, e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  } catch { throw new IdTokenError('bad_jwk'); }
  const ok = await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5', key,
    Buffer.from(parts[2], 'base64url'), Buffer.from(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new IdTokenError('bad_signature');

  if (claims.iss !== opts.issuer) throw new IdTokenError('wrong_issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.audience)) throw new IdTokenError('wrong_audience');
  if (aud.length > 1 && claims.azp !== opts.audience) throw new IdTokenError('wrong_azp');
  const nowSec = Math.floor(opts.now / 1000);
  const skew = opts.skewSec ?? 60;
  if (typeof claims.exp !== 'number' || claims.exp + skew <= nowSec) throw new IdTokenError('expired');
  if (typeof claims.iat === 'number' && claims.iat - skew > nowSec) throw new IdTokenError('issued_in_future');
  if (opts.nonce !== null && (typeof opts.nonce !== 'string' || claims.nonce !== opts.nonce)) throw new IdTokenError('nonce_mismatch');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new IdTokenError('missing_sub');
  return claims;
}
