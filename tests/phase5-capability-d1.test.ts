// The capability fence is one specification written twice: shared/access.ts
// (pure) and worker/capability.ts (SQL). Every input combination goes through both.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SPACE_ROLES, isWorkspaceRole, type SpaceAccess, type SpaceRole } from '../shared/access';
import { capabilityFence, capabilityViolated, effectiveLevel, levelSql, minLevel, need, roleLevel } from '../worker/capability';
import { canComment, canEdit, canEditComment, canManageMembers, canRead } from '../shared/access';

let mf: Miniflare, db: D1Database;
type Principal = { id: string; workspace_role: string | null; role: string | null; disabled: boolean };
type SpaceCase = { id: string; defaultAccess: 'members' | 'private'; deleted: boolean; choice: { role: SpaceRole; access: 'allow' | 'deny' } | null };
const principals: Principal[] = [];
const spaces: SpaceCase[] = [];

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'phase5-capability', modules: true,
    script: 'export default {fetch(){return new Response("disposable capability fixture")}}', compatibilityDate: '2026-09-25', d1Databases: { DB: 'disposable-phase5-capability' } }] }));
  db = await mf.getD1Database('DB') as D1Database;
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of readdirSync(folder).filter(n => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(`${folder}/${name}`, 'utf8').replace(/--[^\n]*/g, '');
    await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? []).map(s => db.prepare(s.trim())));
  }
  for (const workspace_role of [null, 'owner', 'admin', 'member', 'guest']) for (const role of [null, 'admin', 'member']) for (const disabled of [false, true]) {
    principals.push({ id: `u${principals.length}`, workspace_role, role, disabled });
  }
  const choices: SpaceCase['choice'][] = [null, ...SPACE_ROLES.map(role => ({ role, access: 'allow' as const })), ...SPACE_ROLES.map(role => ({ role, access: 'deny' as const }))];
  for (const defaultAccess of ['members', 'private'] as const) for (const deleted of [false, true]) for (const choice of choices) {
    spaces.push({ id: `s${spaces.length}`, defaultAccess, deleted, choice });
  }
  const statements: D1PreparedStatement[] = [];
  for (const p of principals) statements.push(db.prepare('INSERT INTO users(id,username,name,role,workspace_role,disabled_at) VALUES(?,?,?,?,?,?)').bind(p.id, p.id, p.id, p.role, p.workspace_role, p.disabled ? 1 : null));
  for (const s of spaces) statements.push(db.prepare('INSERT INTO spaces(id,name,default_access,deleted_at,created_at) VALUES(?,?,?,?,1)').bind(s.id, s.id, s.defaultAccess, s.deleted ? 5 : null));
  for (const s of spaces) if (s.choice) for (const p of principals) statements.push(db.prepare('INSERT INTO space_members(space_id,user_id,role,access) VALUES(?,?,?,?)').bind(s.id, p.id, s.choice.role, s.choice.access));
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
});
afterAll(async () => { await mf?.dispose(); });

function accessOf(p: Principal, s: SpaceCase): SpaceAccess {
  const workspaceRole = p.workspace_role ?? p.role;
  return {
    principal: isWorkspaceRole(workspaceRole) ? { id: p.id, workspaceRole, disabledAt: p.disabled ? 1 : null } : null,
    space: { id: s.id, defaultAccess: s.defaultAccess, exportPolicy: 'disabled', deletedAt: s.deleted ? 5 : null },
    membership: s.choice ? { role: s.choice.role, access: s.choice.access } : null,
  };
}

describe('SQL capability level equals the pure specification', () => {
  it('agrees on every (workspace role × legacy role × disabled × default access × deleted × membership) combination', async () => {
    const rows = (await db.prepare(`SELECT u.id uid, s.id sid, ${levelSql('u.id', 's.id')} lvl FROM users u CROSS JOIN spaces s WHERE s.id <> 'space-core'`).all<{ uid: string; sid: string; lvl: number }>()).results;
    expect(rows).toHaveLength(principals.length * spaces.length);
    const byKey = new Map(rows.map(r => [`${r.uid}/${r.sid}`, r.lvl]));
    const mismatches: string[] = [];
    let readable = 0;
    for (const p of principals) for (const s of spaces) {
      const expected = effectiveLevel(accessOf(p, s)), actual = byKey.get(`${p.id}/${s.id}`);
      if (expected > 0) readable++;
      if (expected !== actual) mismatches.push(`${JSON.stringify(p)} ${JSON.stringify(s)} expected ${expected} got ${actual}`);
    }
    expect(mismatches).toEqual([]);
    // The enumeration must be non-trivial in both directions.
    expect(readable).toBeGreaterThan(100); expect(readable).toBeLessThan(principals.length * spaces.length);
  });

  it('treats a missing user or a missing space as no access', async () => {
    expect(await db.prepare(`SELECT ${levelSql('?', '?')} lvl`).bind('nobody', 's0').first('lvl')).toBe(0);
    expect(await db.prepare(`SELECT ${levelSql('?', '?')} lvl`).bind('u0', 'no-such-space').first('lvl')).toBe(0);
  });

  it('derives minimal levels from the same predicates the authorizer uses', () => {
    const member = { id: 'm', workspaceRole: 'member' as const, disabledAt: null }, guest = { id: 'g', workspaceRole: 'guest' as const, disabledAt: null };
    expect(minLevel(member, canRead)).toBe(1); expect(minLevel(member, canComment)).toBe(2); expect(minLevel(member, canEdit)).toBe(3);
    expect(minLevel(member, canManageMembers)).toBe(4);
    expect(minLevel(member, a => canEditComment(a, 'someone-else'))).toBe(4); expect(minLevel(member, a => canEditComment(a, 'm'))).toBe(2);
    // A guest can never be admin/owner, so an admin-only requirement is unsatisfiable.
    expect(minLevel(guest, canManageMembers)).toBe(6);
    expect(roleLevel('owner')).toBe(5);
  });
});

describe('capabilityFence fails exactly on the caller\'s own authority', () => {
  const principal = principals.find(p => p.workspace_role === 'member' && p.role === 'member' && !p.disabled)!;
  const plain = () => principals.find(p => p.workspace_role === 'member' && p.role === 'member' && !p.disabled)!;
  const pick = (defaultAccess: 'members' | 'private', choice: SpaceCase['choice'], deleted = false) => spaces.find(s => s.defaultAccess === defaultAccess && s.deleted === deleted && JSON.stringify(s.choice) === JSON.stringify(choice))!;
  const input = (needs: Map<string, number>, userId = plain().id, workspaceRole: 'member' = 'member', enabled = false) => ({ userId, needs, workspaceRole, enabled });
  void principal;

  it('passes when the level still covers the need and fails when it does not', async () => {
    const editor = pick('private', { role: 'editor', access: 'allow' }), viewer = pick('private', { role: 'viewer', access: 'allow' });
    const needs = new Map<string, number>(); need(needs, editor.id, 3);
    expect(await capabilityViolated(db, input(needs))).toBe(false);
    need(needs, viewer.id, 3);
    expect(await capabilityViolated(db, input(needs))).toBe(true);
    const readOnly = new Map<string, number>(); need(readOnly, viewer.id, 1);
    expect(await capabilityViolated(db, input(readOnly))).toBe(false);
    // need() raises, never lowers.
    need(readOnly, viewer.id, 3); need(readOnly, viewer.id, 1);
    expect(readOnly.get(viewer.id)).toBe(3);
  });

  it('fails for a denied, deleted or default-less private space and honors default access for members', async () => {
    for (const [space, violated] of [
      [pick('private', { role: 'editor', access: 'deny' }), true], [pick('members', { role: 'editor', access: 'deny' }), true],
      [pick('private', { role: 'editor', access: 'allow' }, true), true], [pick('private', null), true],
      [pick('members', null), false], [pick('members', { role: 'viewer', access: 'allow' }), true],
    ] as const) {
      const needs = new Map<string, number>(); need(needs, space.id, 3);
      expect(await capabilityViolated(db, input(needs)), JSON.stringify(space)).toBe(violated);
    }
  });

  it('is tripped by the activation flag, a disabled principal and a workspace-role change — and by nothing else', async () => {
    const editor = pick('private', { role: 'editor', access: 'allow' });
    const needs = new Map<string, number>(); need(needs, editor.id, 3);
    const subject = plain();
    expect(await capabilityViolated(db, input(needs))).toBe(false);
    expect(await capabilityViolated(db, input(needs, subject.id, 'member', true))).toBe(true);
    // Another user's membership, a session delete and an unrelated record write are invisible to it.
    await db.prepare("INSERT OR REPLACE INTO space_members(space_id,user_id,role,access) VALUES(?,?,'viewer','allow')").bind(editor.id, 'u0').run();
    await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind('t-capability', subject.id, Date.now() + 1000, Date.now()).run();
    await db.prepare("DELETE FROM sessions WHERE token_hash='t-capability'").run();
    await db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('cap-r','pages','{}','{}',999999,'space-core')").run();
    expect(await capabilityViolated(db, input(needs))).toBe(false);
    // The caller's own authority, however, is.
    await db.prepare('UPDATE users SET workspace_role=? WHERE id=?').bind('guest', subject.id).run();
    expect(await capabilityViolated(db, input(needs))).toBe(true);
    await db.prepare('UPDATE users SET workspace_role=? WHERE id=?').bind(subject.workspace_role, subject.id).run();
    await db.prepare('UPDATE users SET disabled_at=1 WHERE id=?').bind(subject.id).run();
    expect(await capabilityViolated(db, input(needs))).toBe(true);
    await db.prepare('UPDATE users SET disabled_at=NULL WHERE id=?').bind(subject.id).run();
    expect(await capabilityViolated(db, input(needs))).toBe(false);
  });

  it('aborts the surrounding batch atomically when it fails', async () => {
    const viewer = pick('private', { role: 'viewer', access: 'allow' });
    const needs = new Map<string, number>(); need(needs, viewer.id, 3);
    await expect(db.batch([capabilityFence(db, input(needs)), db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('cap-never','pages','{}','{}',999998,'space-core')")])).rejects.toThrow();
    expect(await db.prepare("SELECT COUNT(*) n FROM records WHERE id='cap-never'").first('n')).toBe(0);
  });
});
