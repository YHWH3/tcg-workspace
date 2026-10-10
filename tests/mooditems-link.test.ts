import { describe, expect, it } from 'vitest';
import { connectorLinkPlan } from '../shared/mooditems';

const conn = (id: string, linkOwned?: boolean, deleted = false) => ({ id, linkOwned, deleted });
const L = 'links|blocks||a|b';

describe('connectorLinkPlan — global connector↔link lifecycle', () => {
  it('no linkId → no-op', () => {
    expect(connectorLinkPlan({ linkId: null }, [], 'c1')).toEqual({ retireLink: false, transferTo: null });
  });

  it('owner delete with live referrers (any board) → survives + transfers ownership to first live referrer', () => {
    const plan = connectorLinkPlan({ linkId: L, linkOwned: true }, [conn('b2', false), conn('a1', false), conn('b1', true, true)], 'owner');
    expect(plan).toEqual({ retireLink: false, transferTo: 'a1' }); // argmin by id
  });

  it('adopter delete with live referrers → survives, no transfer', () => {
    expect(connectorLinkPlan({ linkId: L, linkOwned: false }, [conn('o', true)], 'c1')).toEqual({ retireLink: false, transferTo: null });
  });

  it('sole live owner → retires', () => {
    expect(connectorLinkPlan({ linkId: L, linkOwned: true }, [], 'c1')).toEqual({ retireLink: true, transferTo: null });
  });

  it('sole live adopter + tombstoned owner → retires (connector-minted row)', () => {
    // owner deleted earlier (transferred or not), this adopter is last — row
    // was connector-minted, so it must not become a permanent orphan.
    const plan = connectorLinkPlan({ linkId: L, linkOwned: false }, [conn('deadOwner', true, true)], 'c1');
    expect(plan).toEqual({ retireLink: true, transferTo: null });
  });

  it('sole live referrer but NOBODY ever owned → keeps (user-created dependency)', () => {
    // R2b: a connector illustrating a pre-existing user dependency can never
    // take that dependency down — including via an unmarked legacy row.
    expect(connectorLinkPlan({ linkId: L, linkOwned: false }, [], 'c1')).toEqual({ retireLink: false, transferTo: null });
    expect(connectorLinkPlan({ linkId: L }, [], 'legacy')).toEqual({ retireLink: false, transferTo: null });
    expect(connectorLinkPlan({ linkId: L }, [conn('dead', undefined, true)], 'legacy')).toEqual({ retireLink: false, transferTo: null });
  });

  it('ownership chain: transferred owner then deleted → last holder retires', () => {
    // Order 2 from R2c: owner dies first (transfers to adopter), then the
    // now-owning adopter dies → sole + owned → retires. No orphan either order.
    const adopterNowOwner = { linkId: L, linkOwned: true };
    expect(connectorLinkPlan(adopterNowOwner, [conn('deadOwner', true, true), conn('deadOther', false, true)], 'adopter')).toEqual({
      retireLink: true,
      transferTo: null,
    });
  });

  it('deleted referrers do not count as live (same-batch batch semantics)', () => {
    // two connectors on one link, both being deleted — the second sees the
    // first as tombstoned; owner flag still counts → retire.
    const plan = connectorLinkPlan({ linkId: L, linkOwned: false }, [conn('other', true, true)], 'c1');
    expect(plan.retireLink).toBe(true);
  });
});
