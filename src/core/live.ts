import { createStore } from './store';
import { getToken } from './api';

export interface PresenceUser {
  userId: string;
  path: string;
}

interface LiveState {
  users: PresenceUser[];
  connected: boolean;
}

export const liveStore = createStore<LiveState>({ users: [], connected: false });

let ws: WebSocket | null = null;
let attempts = 0;
let currentPath = '/';
let heartbeat: ReturnType<typeof setInterval> | undefined;
let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let syncDebounce: ReturnType<typeof setTimeout> | undefined;
let started = false;
let listenersInstalled = false;

/** True while the live socket is connected (engine polls slower then). */
export function liveConnected(): boolean {
  return liveStore.get().connected;
}

function send(msg: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Called by the shell whenever the route changes. */
export function sendHere(path: string): void {
  currentPath = path;
  send({ t: 'here', path });
}

async function onChanged(): Promise<void> {
  // Poke debounce → instant sync when someone else writes.
  clearTimeout(syncDebounce);
  syncDebounce = setTimeout(async () => {
    const { syncNow } = await import('./sync/engine');
    void syncNow();
  }, 300);
}

function connect(): void {
  if (!started) return;
  const token = getToken();
  if (!token || ws) return;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`;
  const sock = new WebSocket(url, ['ws-auth', token]);
  ws = sock;

  sock.onopen = () => {
    if (ws !== sock) return;
    attempts = 0;
    liveStore.set((s) => ({ ...s, connected: true }));
    send({ t: 'here', path: currentPath });
    clearInterval(heartbeat);
    heartbeat = setInterval(() => send({ t: 'beat' }), 30000);
  };
  sock.onmessage = (e) => {
    if (ws !== sock) return;
    try {
      const m = JSON.parse(String(e.data)) as { t?: string; users?: PresenceUser[] };
      if (m.t === 'presence' && Array.isArray(m.users)) liveStore.set((s) => ({ ...s, users: m.users! }));
      else if (m.t === 'changed') {
        console.debug('[live] changed — instant-sync poke received');
        void onChanged();
        void import('../modules/inbox')
          .then((mod) => mod.fetchUnreadBadge())
          .then((n) => window.dispatchEvent(new CustomEvent('ws-inbox-unread', { detail: n })))
          .catch(() => {});
      }
    } catch {
      /* ignore malformed frames */
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    teardown();
    scheduleReconnect();
  };
  sock.onerror = () => sock.close();
}

function teardown(): void {
  clearInterval(heartbeat);
  if (ws) {
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* noop */
    }
  }
  ws = null;
  liveStore.set({ users: [], connected: false });
}

function scheduleReconnect(): void {
  clearTimeout(reconnectTimer);
  if (document.visibilityState === 'hidden') return;
  const wait = Math.min(15000, 500 * 2 ** attempts) + Math.random() * 500;
  attempts += 1;
  reconnectTimer = setTimeout(connect, wait);
}

export function startPresence(): void {
  if (started) return;
  started = true;
  connect();
  if (listenersInstalled) return;
  listenersInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (!started) return;
    if (document.visibilityState === 'hidden') {
      // Stop burning the socket while the tab is in the background.
      hiddenTimer = setTimeout(teardown, 60000);
    } else {
      clearTimeout(hiddenTimer);
      if (!ws) connect();
    }
  });
}

/** Stop old credentials and clear presence immediately on account/access lock. */
export function stopPresence(): void {
  started = false;
  clearTimeout(reconnectTimer); clearTimeout(hiddenTimer); clearTimeout(syncDebounce);
  teardown();
}
