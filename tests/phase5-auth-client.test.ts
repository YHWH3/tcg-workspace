import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ api: vi.fn(), maintenance: vi.fn() }));
vi.mock('../src/core/api', async original => ({ ...await original<typeof import('../src/core/api')>(), api: fixture.api }));
vi.mock('../src/core/legacyMigration', () => ({ migrateLegacyStore: fixture.maintenance }));
vi.mock('../src/core/maintenance', () => ({ clearMaint: fixture.maintenance }));
let auth: typeof import('../src/core/auth');
const user = { id: 'account-A', username: 'alice', name: 'Alice', role: 'member', color: '' };
beforeEach(async () => {
  vi.resetModules(); fixture.api.mockReset(); fixture.maintenance.mockReset();
  const values = new Map([['ws_uid', user.id], ['ws_token', 'fixture-token-A'], ['ws_user', JSON.stringify(user)]]);
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  auth = await import('../src/core/auth');
});
afterEach(() => { vi.unstubAllGlobals(); });
function replace() { localStorage.setItem('ws_uid', 'account-B'); localStorage.setItem('ws_token', 'fixture-token-B'); localStorage.setItem('ws_user', JSON.stringify({ ...user, id: 'account-B', name: 'Bob' })); }

it('does not overwrite replacement identity with a late successful startup response', async () => {
  fixture.api.mockImplementation(async () => { replace(); return { user }; });
  await auth.initAuth();
  expect(JSON.parse(localStorage.getItem('ws_user')!).id).toBe('account-B');
  expect(fixture.maintenance).not.toHaveBeenCalled();
});
it('does not log out a replacement account on a late startup 401', async () => {
  const { ApiError } = await import('../src/core/api');
  fixture.api.mockImplementation(async () => { replace(); throw new ApiError(401, 'expired'); });
  await auth.initAuth();
  expect(localStorage.getItem('ws_token')).toBe('fixture-token-B'); expect(localStorage.getItem('ws_user')).not.toBeNull();
});
it('does not clear a replacement account after an old signout completes', async () => {
  fixture.api.mockImplementation(async () => { replace(); return { ok: true }; });
  await auth.signOut(); expect(localStorage.getItem('ws_token')).toBe('fixture-token-B');
});
it('does not overwrite replacement identity after an old profile update completes', async () => {
  fixture.api.mockImplementation(async () => { replace(); return { user: { ...user, name: 'New Alice' } }; });
  await expect(auth.updateMe({ name: 'New Alice' })).rejects.toThrow('session_changed');
  expect(JSON.parse(localStorage.getItem('ws_user')!).id).toBe('account-B');
});
