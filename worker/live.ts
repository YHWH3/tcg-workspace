import { DurableObject } from 'cloudflare:workers';
import type { Env } from './auth';

interface Attachment {
  userId: string;
  path: string;
  lastSeen: number;
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
      server.serializeAttachment({ userId, path: '/', lastSeen: Date.now() } satisfies Attachment);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    try {
      const m = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)) as { t?: string; path?: string };
      if (m.t === 'here' && typeof m.path === 'string') {
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
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att || att.lastSeen < cutoff) {
        try {
          ws.close(1000, 'idle');
        } catch {
          /* already gone */
        }
      }
    }
    this.broadcastPresence();
    void this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
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
    this.broadcast({ t: 'presence', users: [...byUser].map(([userId, path]) => ({ userId, path })) });
  }
}
