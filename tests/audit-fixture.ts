// Shared disposable-D1 fixture for the cross-phase audit regressions
// (tests/audit-*.test.ts). Real Miniflare D1 with every migration applied —
// the same technique as the Phase 4 actual-D1 suites, kept in one place so the
// audit files stay focused on the invariant each one establishes.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sha256Hex } from '../worker/password';
import type { Env } from '../worker/auth';

export interface AuditFixture {
  mf: Miniflare;
  db: D1Database;
  env: Env;
  ctx: ExecutionContext;
  token: (id: string) => string;
  auth: (id: string) => Record<string, string>;
  dispose: () => Promise<void>;
}

export const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

export async function openAuditFixture(users: { id: string; role?: 'admin' | 'member' }[] = [{ id: 'alice', role: 'admin' }, { id: 'bob' }, { id: 'carol' }], extraEnv: Partial<Env> = {}): Promise<AuditFixture> {
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'audit', modules: true,
    script: 'export default {fetch(){return new Response("audit fixture")}}',
    compatibilityDate: '2026-09-25', d1Databases: { DB: 'disposable-audit' },
  }] }));
  const db = (await mf.getD1Database('DB')) as D1Database;
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const file of readdirSync(folder).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(`${folder}/${file}`, 'utf8').replace(/--[^\n]*/g, '');
    const statements = sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? [];
    await db.batch(statements.map((statement) => db.prepare(statement.trim())));
  }
  const token = (id: string) => `audit-session-${id}`;
  for (const u of users) {
    await db.prepare('INSERT INTO users(id,username,name,role,prefs) VALUES(?,?,?,?,NULL)').bind(u.id, u.id, u.id, u.role ?? 'member').run();
    await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
      .bind(await sha256Hex(token(u.id)), u.id, Date.now() + 86_400_000 * 30, Date.now()).run();
  }
  return {
    mf, db, ctx,
    env: { DB: db, ...extraEnv } as Env,
    token,
    auth: (id) => ({ authorization: `Bearer ${token(id)}`, 'content-type': 'application/json' }),
    dispose: () => mf.dispose(),
  };
}
