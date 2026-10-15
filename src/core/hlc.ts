import { isTrustedTimestamp } from '../../shared/clock';

const KEY = 'ws_hlc';

function load(): number {
  try {
    const stored = Number(localStorage.getItem(KEY) ?? '0') || 0;
    // A persisted clock beyond the drift bound was poisoned by an earlier
    // untrusted observation; adopting it would pin every write far in the
    // future (and at ~1e300, `last + 1 === last` stops the clock advancing).
    return isTrustedTimestamp(stored, Date.now()) ? stored : 0;
  } catch {
    return 0;
  }
}

function save(v: number) {
  try {
    localStorage.setItem(KEY, String(v));
  } catch {
    /* non-browser env */
  }
}

let last = load();

export const hlc = {
  next(): number {
    last = Math.max(Date.now(), last + 1);
    save(last);
    return last;
  },
  observe(ts: number) {
    // Timestamps from peers/pulls are untrusted input (see shared/clock.ts).
    if (!isTrustedTimestamp(ts, Date.now())) return;
    if (ts > last) {
      last = ts;
      save(last);
    }
  },
  now(): number {
    return last;
  },
};
