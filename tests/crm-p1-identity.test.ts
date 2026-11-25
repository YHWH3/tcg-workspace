import { describe, expect, it } from 'vitest';
import {
  canonicalPersonPair,
  computeNameCollisionPairs,
  normalizeEmail,
  normalizeEndpoint,
  normalizeHandle,
  normalizePhone,
} from '../shared/crm/identity';
import {
  CRM_PROGRAMMES,
  CRM_WORK_AREAS,
  isRegisteredProgrammeSlug,
  parseProgrammeScope,
  programmeForWebsiteForm,
} from '../shared/crm/programmes';

describe('S1 identity normalisation and duplicate scoring', () => {
  it('normalises emails, E.164 & 10-digit Indian phones, and handles cleanly', () => {
    expect(normalizeEmail('  Asha.Menon+tag@Example.ORG ')).toBe('asha.menon+tag@example.org');
    expect(normalizeEmail('not-an-email')).toBeNull();

    expect(normalizePhone('98470 12345')).toBe('+919847012345');
    expect(normalizePhone('098470-12345')).toBe('+919847012345');
    expect(normalizePhone('+44 7700 900077')).toBe('+447700900077');
    expect(normalizePhone('00919847012345')).toBe('+919847012345');
    expect(normalizePhone('12345')).toBeNull();

    expect(normalizeHandle(' @Riverbank.Maker ')).toBe('riverbank.maker');
    expect(normalizeHandle('bad handle!')).toBeNull();

    expect(normalizeEndpoint('whatsapp', '9847012345')).toBe('+919847012345');
    expect(normalizeEndpoint('instagram', '@tcg.living')).toBe('tcg.living');
  });

  it('orders canonical duplicate pairs deterministically and detects email/phone/name collisions', () => {
    expect(canonicalPersonPair('p_z', 'p_a')).toEqual(['p_a', 'p_z']);
    const signals = computeNameCollisionPairs([
      { id: 'p_2', title: 'Asha Menon', email: 'ASHA@example.org', phone: '9847012345' },
      { id: 'p_1', title: 'Asha  Menon', email: 'asha@example.org', phone: null },
      { id: 'p_3', title: 'Ravi Kumar', email: 'ravi@example.org', phone: '+91 98470 12345' },
      { id: 'p_4', title: 'Unique Person', email: 'unique@example.org', phone: '+91 99999 00000' },
    ]);
    expect(signals).toHaveLength(2);
    expect(signals.find((s) => s.personAId === 'p_1' && s.personBId === 'p_2')).toMatchObject({
      confidence: 'high',
      reason: 'Matching email: asha@example.org',
    });
    expect(signals.find((s) => s.personAId === 'p_2' && s.personBId === 'p_3')).toMatchObject({
      confidence: 'high',
      reason: 'Matching phone: +919847012345',
    });
  });

  it('registers all 14 TCG programmes across 5 work areas with policy-neutral defaults', () => {
    expect(CRM_WORK_AREAS).toHaveLength(5);
    expect(CRM_PROGRAMMES).toHaveLength(14);
    for (const p of CRM_PROGRAMMES) {
      expect(isRegisteredProgrammeSlug(p.slug)).toBe(true);
      expect(parseProgrammeScope(`programme:${p.slug}`)).toEqual({ ok: true, slug: p.slug });
      expect(p.defaultProfile.responseTargetDays).toBeNull();
      expect(p.defaultProfile.bookingDefaults.holdMinutes).toBeNull();
      expect(p.defaultProfile.policies.feeSummary).toBeNull();
      expect(p.defaultProfile.policies.eligibilityCriteria).toBeNull();
    }
    expect(parseProgrammeScope('programme:nonexistent')).toEqual({ ok: false });
    expect(programmeForWebsiteForm('vol-events')?.slug).toBe('volunteering-internships');
    expect(programmeForWebsiteForm('ws')?.slug).toBe('tribal-habitat-workshop');
  });
});
