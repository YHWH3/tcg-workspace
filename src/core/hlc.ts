const KEY = 'ws_hlc';

function load(): number {
  try {
    return Number(localStorage.getItem(KEY) ?? '0') || 0;
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
    if (ts > last) {
      last = ts;
      save(last);
    }
  },
  now(): number {
    return last;
  },
};
