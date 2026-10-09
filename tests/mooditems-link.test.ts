import { describe, expect, it } from 'vitest';
import { connectorRetiresLink } from '../shared/mooditems';

const conn = (id: string, linkId: string | null, linkOwned?: boolean, deleted = false) => ({ id, linkId, linkOwned, deleted });

describe('connectorRetiresLink (connector↔link lifecycle)', () => {
  it('retires a solely-owned mirror', () => {
    expect(connectorRetiresLink(conn('c1', 'L', true), [], 'c1')).toBe(true);
  });

  it('legacy connectors (no flag) are treated as owners', () => {
    expect(connectorRetiresLink(conn('c1', 'L'), [], 'c1')).toBe(true);
  });

  it('never retires an adopted (pre-existing/shared) link', () => {
    expect(connectorRetiresLink(conn('c1', 'L', false), [], 'c1')).toBe(false);
    expect(connectorRetiresLink(conn('c1', 'L', false), [conn('c2', 'L', false)], 'c1')).toBe(false);
  });

  it('keeps the link while another live connector shares it', () => {
    const siblings = [conn('c2', 'L', false), conn('c3', 'L2', true)];
    expect(connectorRetiresLink(conn('c1', 'L', true), siblings, 'c1')).toBe(false);
  });

  it('ignores already-deleted siblings when deciding sole ownership', () => {
    expect(connectorRetiresLink(conn('c1', 'L', true), [conn('c2', 'L', false, true)], 'c1')).toBe(true);
  });

  it('no-op without a linkId', () => {
    expect(connectorRetiresLink(conn('c1', null, true), [], 'c1')).toBe(false);
    expect(connectorRetiresLink({}, [], 'c1')).toBe(false);
  });
});
