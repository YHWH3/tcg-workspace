import { describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { matchRoutes } from 'react-router';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
});
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

const { routes } = await import('../src/routes');

describe('CRM & Workspace routing (S0-PLAN §7.2)', () => {
  it('matches /crm and /crm/* to the lazy top-level CRM route outside Workspace Shell', () => {
    for (const path of ['/crm', '/crm/', '/crm/settings/access', '/crm/unknown']) {
      const matches = matchRoutes(routes, path);
      expect(matches, path).not.toBeNull();
      expect(matches!.length).toBe(1);
      expect(matches![0].route.path).toBe('crm/*');
    }
  });

  it('preserves existing Workspace and public routes', () => {
    for (const path of ['/', '/boards', '/settings', '/ai', '/spaces/space-core']) {
      const matches = matchRoutes(routes, path);
      expect(matches, path).not.toBeNull();
      expect(matches![0].route.path).toBeUndefined();
    }
    for (const path of ['/s/tok123', '/s/canvas/tok123', '/f/form123', '/join/inv123']) {
      const matches = matchRoutes(routes, path);
      expect(matches, path).not.toBeNull();
      expect(matches![0].route.path).not.toBe('crm/*');
    }
  });
});
