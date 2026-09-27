import { describe, expect, it } from 'vitest';
import { hashPassword, newSalt, randomToken, sha256Hex, verifyPassword } from '../worker/password';

describe('password hashing', () => {
  it('hash + verify roundtrip', async () => {
    const saltB64 = newSalt();
    const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
    const hash = await hashPassword('correct horse battery', salt);
    expect(await verifyPassword('correct horse battery', saltB64, hash)).toBe(true);
    expect(await verifyPassword('wrong password!', saltB64, hash)).toBe(false);
  });

  it('different salts produce different hashes', async () => {
    const s1 = newSalt();
    const s2 = newSalt();
    const h1 = await hashPassword('pw123456', Uint8Array.from(atob(s1), (c) => c.charCodeAt(0)));
    const h2 = await hashPassword('pw123456', Uint8Array.from(atob(s2), (c) => c.charCodeAt(0)));
    expect(h1).not.toBe(h2);
  });

  it('rejects malformed stored data', async () => {
    expect(await verifyPassword('x', '!!!', '!!!')).toBe(false);
  });
});

describe('tokens', () => {
  it('randomToken is 32 bytes base64url', () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
  });

  it('sha256Hex produces hex digest', async () => {
    const h = await sha256Hex('abc');
    expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
