import { describe, expect, it } from 'vitest';
import { rebaseRecord } from '../src/core/sync/rebase';

describe('rebaseRecord', () => {
  it('returns server data when no pending changes', () => {
    const r = rebaseRecord({ data: { title: 'server' }, field_ts: { title: 100 } }, []);
    expect(r.data).toEqual({ title: 'server' });
    expect(r.field_ts).toEqual({ title: 100 });
  });

  it('pending local field survives pull when newer', () => {
    const server = { data: { title: 'server', status: 'todo' }, field_ts: { title: 100, status: 100 } };
    const r = rebaseRecord(server, [{ id: 'r1', patch: { title: 'local edit' }, ts: 200 }]);
    expect(r.data.title).toBe('local edit');
    expect(r.data.status).toBe('todo');
    expect(r.field_ts.title).toBe(200);
  });

  it('older pending field loses to newer server field', () => {
    const server = { data: { title: 'server' }, field_ts: { title: 300 } };
    const r = rebaseRecord(server, [{ id: 'r1', patch: { title: 'local' }, ts: 200 }]);
    expect(r.data.title).toBe('server');
    expect(r.field_ts.title).toBe(300);
  });

  it('applies pending fields for brand-new local records (server has none)', () => {
    const r = rebaseRecord({ data: {}, field_ts: {} }, [{ id: 'r1', patch: { title: 'draft', x: 1 }, ts: 50 }]);
    expect(r.data).toEqual({ title: 'draft', x: 1 });
    expect(r.field_ts).toEqual({ title: 50, x: 50 });
  });

  it('multiple pending entries apply in order', () => {
    const server = { data: { a: 's' }, field_ts: { a: 100 } };
    const r = rebaseRecord(server, [
      { id: 'r1', patch: { a: 'p1' }, ts: 150 },
      { id: 'r1', patch: { a: 'p2', b: 'x' }, ts: 250 },
    ]);
    expect(r.data).toEqual({ a: 'p2', b: 'x' });
    expect(r.field_ts).toEqual({ a: 250, b: 250 });
  });

  it('does not mutate the server object', () => {
    const server = { data: { a: 's' }, field_ts: { a: 100 } };
    rebaseRecord(server, [{ id: 'r1', patch: { a: 'p' }, ts: 150 }]);
    expect(server.data.a).toBe('s');
  });
});
