import { DurableObject } from 'cloudflare:workers';
import type { Env } from './auth';

interface Attachment {
  userId: string;
  /** sha256 of the session token that authorized this socket (sessions.token_hash). */
  sid?: string;
  path: string;
  lastSeen: number;
  /** Phase 5 permissions were enabled when this socket was authorized: its route is never
   * recorded or shared, and it never receives anyone's route (a path names a record the
   * recipient may not be allowed to read). Pokes still flow. */
  scoped?: boolean;
}

const IDLE_MS = 75_000;
const SWEEP_MS = 60_000;

/**
 * Workspace-wide live room. Single instance, WebSocket hibernation:
 * connections are accepted via ctx.acceptWebSocket so the DO can sleep
 * while sockets stay open.
 */
export class LiveRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep a self-rescheduling sweep alarm for idle sockets.
    ctx.storage.getAlarm().then((a) => {
      if (!a) void ctx.storage.setAlarm(Date.now() + SWEEP_MS);
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const userId = req.headers.get('x-user-id') ?? '';
      if (!userId) return new Response('unauthorized', { status: 401 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ userId, sid: req.headers.get('x-session-hash') ?? undefined, path: '/', lastSeen: Date.now(), ...(req.headers.get('x-scoped') === '1' ? { scoped: true } : {}) } satisfies Attachment);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    try {
      const m = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)) as { t?: string; path?: string };
      if (m.t === 'here' && typeof m.path === 'string' && !att.scoped) {
        att.path = m.path.slice(0, 200);
      }
      att.lastSeen = Date.now();
      ws.serializeAttachment(att);
      if (m.t === 'here') this.broadcastPresence();
    } catch {
      /* malformed frame */
    }
  }

  webSocketClose(): void {
    this.broadcastPresence();
  }

  webSocketError(): void {
    this.broadcastPresence();
  }

  async alarm(): Promise<void> {
    const cutoff = Date.now() - IDLE_MS;
    const ended = await this.endedSessions();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      const revoked = !!att?.sid && ended.has(att.sid);
      if (!att || att.lastSeen < cutoff || revoked) {
        try {
          ws.close(revoked ? 4401 : 1000, revoked ? 'session ended' : 'idle');
        } catch {
          /* already gone */
        }
      }
    }
    this.broadcastPresence();
    void this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  /**
   * A socket must not outlive the session that authorized it: logout, password
   * change, admin removal and expiry all delete/expire the `sessions` row, and
   * none of those paths holds a reference to the open socket. One indexed
   * query per sweep finds every socket whose session is gone. "Live" is the
   * same definition HTTP auth uses (`userByToken`): the session row is
   * unexpired AND its user is not disabled, so disabling an account ends its
   * sockets even though its session rows remain. A database failure keeps
   * sockets open (fail-static): the next sweep retries.
   */
  private async endedSessions(): Promise<Set<string>> {
    const sids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.sid) sids.add(att.sid);
    }
    const ended = new Set<string>();
    if (!sids.size) return ended;
    try {
      const { results } = await this.env.DB
        .prepare(`SELECT s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.expires_at > ? AND u.disabled_at IS NULL AND s.token_hash IN (SELECT value FROM json_each(?))`)
        .bind(Date.now(), JSON.stringify([...sids]))
        .all<{ token_hash: string }>();
      const live = new Set(results.map((r) => r.token_hash));
      for (const sid of sids) if (!live.has(sid)) ended.add(sid);
    } catch {
      /* keep sockets; retry on the next sweep */
    }
    return ended;
  }

  /** RPC from the worker: a push wrote data — tell clients to pull now. */
  poke(): void {
    this.broadcast({ t: 'changed' });
  }

  private broadcast(msg: unknown): void {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(s);
      } catch {
        ws.close();
      }
    }
  }

  private broadcastPresence(): void {
    // Dedupe multiple tabs per user — latest path wins.
    const byUser = new Map<string, string>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.userId) byUser.set(att.userId, att.path);
    }
    const full = JSON.stringify({ t: 'presence', users: [...byUser].map(([userId, path]) => ({ userId, path })) });
    const pathless = JSON.stringify({ t: 'presence', users: [...byUser.keys()].map((userId) => ({ userId, path: '/' })) });
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      try { ws.send(att?.scoped ? pathless : full); } catch { ws.close(); }
    }
  }
}
