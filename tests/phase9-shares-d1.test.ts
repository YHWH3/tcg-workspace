import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { openAuditFixture, ctx as executionCtx, type AuditFixture } from './audit-fixture';
import { shares } from '../worker/shares';
import { publicApi } from '../worker/public';

let fx: AuditFixture;
beforeEach(async () => {
  fx = await openAuditFixture([{ id: 'alice', role: 'admin' }, { id: 'bob' }]);
  await fx.db.batch([
    fx.db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('page','pages','{\"title\":\"Shared\"}','{}',1,'space-core')"),
    fx.db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('block','blocks','{\"pageId\":\"page\",\"type\":\"p\",\"text\":\"Hello\",\"order\":\"a0\"}','{}',2,'space-core')"),
  ]);
});
afterEach(async () => { await fx.dispose(); });

const rest = async (router: Hono<any>, path: string, init: RequestInit = {}) => {
  const response = await router.request(`http://localhost${path}`, { ...init, headers: { ...fx.auth('alice'), ...(init.headers ?? {}) } }, fx.env, executionCtx);
  const text = await response.text();
  return { status: response.status, json: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; } })() };
};

describe('Phase 9.7 public share expiry and rotation', () => {
  it('accepts only the supported expiry choices and expires at the boundary', async () => {
    const invalid = await rest(shares, '/?x=1', { method: 'POST', body: JSON.stringify({ pageId: 'page', expiresInDays: 14 }) });
    expect(invalid.status).toBe(400);
    const created = await rest(shares, '/', { method: 'POST', body: JSON.stringify({ pageId: 'page', expiresInDays: 7 }) });
    expect(created.status).toBe(200);
    const token = String(created.json.token);
    expect((await publicApi.request(`http://localhost/${token}`, {}, fx.env, executionCtx)).status).toBe(200);
    await fx.db.prepare('UPDATE shares SET expires_at=? WHERE token=?').bind(Date.now() - 1, token).run();
    const expired = await publicApi.request(`http://localhost/${token}`, {}, fx.env, executionCtx);
    expect(expired.status).toBe(404);
    expect(await expired.json()).toEqual({ error: 'inactive' });
  });

  it('rotates a token in place and makes the old token inactive on every page route', async () => {
    const created = await rest(shares, '/', { method: 'POST', body: JSON.stringify({ pageId: 'page' }) });
    const oldToken = String(created.json.token);
    const rotated = await rest(shares, '/page/rotate', { method: 'POST' });
    expect(rotated.status).toBe(200);
    const newToken = String(rotated.json.token);
    expect(newToken).not.toBe(oldToken);
    expect((await publicApi.request(`http://localhost/${oldToken}`, {}, fx.env, executionCtx)).status).toBe(404);
    expect((await publicApi.request(`http://localhost/${oldToken}/pages/page`, {}, fx.env, executionCtx)).status).toBe(404);
    expect((await publicApi.request(`http://localhost/${oldToken}/files/missing`, {}, fx.env, executionCtx)).status).toBe(404);
    expect((await publicApi.request(`http://localhost/${newToken}`, {}, fx.env, executionCtx)).status).toBe(200);
    const row = await fx.db.prepare('SELECT rotated_at FROM shares WHERE page_id=?').bind('page').first<{ rotated_at: number | null }>();
    expect(row?.rotated_at).toEqual(expect.any(Number));
  });
});
