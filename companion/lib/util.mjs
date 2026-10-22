// Small Node-built-in helpers: randomness/PKCE, redaction, atomic 0600 files,
// cross-process lock files and host-allowlisted fetch wrappers.
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeSync, statSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** @param {Buffer|Uint8Array} buf */
export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const randomToken = (bytes = 32) => b64url(randomBytes(bytes));

/** PKCE S256 pair: base64url SHA-256 of the verifier, no padding. */
export function pkcePair() {
  const verifier = randomToken(48);
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Remove anything token-like from a string before it is printed or logged.
 * Covers JWTs, bearer values, token-ish query/form/JSON fields and
 * authorize URLs carrying id_token_hint.
 * @param {unknown} value
 */
export function redact(value) {
  let s = typeof value === 'string' ? value : value instanceof Error ? `${value.name}: ${value.message}` : JSON.stringify(value);
  if (s === undefined) return '';
  s = s.replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]');
  s = s.replace(/(Bearer\s+)[^\s"',]+/gi, '$1[REDACTED]');
  s = s.replace(/((?:id_token_hint|id_token|access_token|refresh_token|code|code_verifier|token)=)[^&\s"']+/g, '$1[REDACTED]');
  s = s.replace(/("(?:id_token|access_token|refresh_token|code_verifier|token)"\s*:\s*")[^"]*"/g, '$1[REDACTED]"');
  return s;
}

/** Create (or tighten) a directory to owner-only 0700. */
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask and ignored for pre-existing dirs.
  chmodSync(dir, 0o700);
}

/**
 * Atomic owner-only write: create a fresh temp file with O_EXCL and 0600,
 * fsync, then rename over the destination.
 */
export function writeFileAtomic(path, data, mode = 0o600) {
  ensurePrivateDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomToken(6)}.tmp`;
  const fd = openSync(tmp, 'wx', mode);
  try {
    writeSync(fd, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return fallback;
    throw new Error(`Could not read ${path}: ${e.message}`);
  }
}

export function removeFile(path) {
  try { unlinkSync(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

export const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Cross-process mutual exclusion via a lock file created with O_EXCL ('wx').
 * The holder writes its creation time (from the injected clock); a lock older
 * than `staleMs` is considered abandoned (crashed process) and removed.
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @param {{now?: () => number, staleMs?: number, timeoutMs?: number, pollMs?: number, wait?: (ms:number)=>Promise<void>}} [opts]
 * @returns {Promise<T>}
 */
export async function withFileLock(lockPath, fn, opts = {}) {
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 25;
  const wait = opts.wait ?? realSleep;
  ensurePrivateDir(dirname(lockPath));
  const started = Date.now();
  const token = randomToken(9);
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, token, created_at: now() })); } finally { closeSync(fd); }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let createdAt = NaN;
      try { createdAt = JSON.parse(readFileSync(lockPath, 'utf8')).created_at; } catch {
        try { createdAt = statSync(lockPath).mtimeMs; } catch { continue; }
      }
      if (!Number.isFinite(createdAt) || now() - createdAt > staleMs) {
        // Stale (or unreadable after a crash): remove and retry the O_EXCL create.
        removeFile(lockPath);
        continue;
      }
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for lock ${lockPath}`);
      await wait(pollMs);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      const held = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (held.token === token) removeFile(lockPath);
    } catch { /* already gone */ }
  }
}

/**
 * Wrap a fetch implementation so it can only reach an explicit allowlist of
 * origins and never follows redirects (a redirect would carry credentials to
 * an unvetted location). This makes "ChatGPT tokens only go to OpenAI" and
 * "Workspace tokens only go to the Workspace origin" structural.
 * @param {typeof fetch} fetchImpl
 * @param {string[]} allowedOrigins e.g. ['https://auth.openai.com']
 * @param {string} label
 * @returns {typeof fetch}
 */
export function guardedFetch(fetchImpl, allowedOrigins, label) {
  const allowed = new Set(allowedOrigins);
  return async (url, init = {}) => {
    const u = new URL(String(url));
    if (!allowed.has(u.origin)) {
      throw new Error(`${label}: refusing request to non-allowlisted origin ${u.origin}`);
    }
    const res = await fetchImpl(u.href, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`${label}: refusing to follow redirect (HTTP ${res.status}) from ${u.origin}${u.pathname}`);
    }
    return res;
  };
}

/** Form-encode a flat object, skipping undefined values. */
export function formBody(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) p.set(k, String(v));
  return p;
}

/** Read a response body as JSON if possible, else return {text}. */
export async function readBody(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { text }; }
}
