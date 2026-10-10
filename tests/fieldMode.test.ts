/* P3-R2/R3 — staged capture ids + account-scoped field prefs (pure layer). */

import { describe, expect, it } from 'vitest';
import { captureBoardKey, captureId, capturePlanIds, cleanDraft, fieldContextKey } from '../src/modules/boards/fieldMode';

describe('capturePlanIds — deterministic staged-save ids', () => {
  it('same recordId → identical ids on every retry', () => {
    const a = capturePlanIds('cap_abc', { photos: 2, docs: 1, hasVoice: true, hasLink: true });
    const b = capturePlanIds('cap_abc', { photos: 2, docs: 1, hasVoice: true, hasLink: true });
    expect(a).toEqual(b);
    expect(a.photoIds).toHaveLength(2);
    expect(a.docIds).toHaveLength(1);
    expect(a.voiceId).toBe(a.linkFileId === a.voiceId ? 'impossible' : a.voiceId); // distinct roles
    expect(new Set([a.voiceId, a.linkFileId, ...a.photoIds, ...a.docIds]).size).toBe(5);
  });

  it('different recordIds never collide — no cross-capture dedupe', () => {
    const a = capturePlanIds('cap_one', { photos: 1, docs: 0, hasVoice: true, hasLink: false });
    const b = capturePlanIds('cap_two', { photos: 1, docs: 0, hasVoice: true, hasLink: false });
    expect(a.photoIds[0]).not.toBe(b.photoIds[0]);
    expect(a.voiceId).not.toBe(b.voiceId);
  });

  it('captureId is stable + prefixed for traceability', () => {
    expect(captureId('r1', 'p0')).toBe(captureId('r1', 'p0'));
    expect(captureId('r1', 'p0')).toMatch(/^cap_[0-9a-f]{16}$/);
    expect(captureId('r1', 'p0')).not.toBe(captureId('r1', 'p1'));
  });
});

describe('account-scoped field preference keys (P3-R3)', () => {
  it('keys carry the user id — two accounts share nothing', () => {
    expect(fieldContextKey('u_alice')).toBe('ws_field_ctx:u_alice');
    expect(fieldContextKey('u_bob')).toBe('ws_field_ctx:u_bob');
    expect(fieldContextKey('u_alice')).not.toBe(fieldContextKey('u_bob'));
    expect(captureBoardKey('u_alice')).toBe('ws_capture_board:u_alice');
    expect(captureBoardKey('u_alice')).not.toBe(captureBoardKey('u_bob'));
  });
});

describe('cleanDraft — staged-save fields survive round-trip', () => {
  it('recordId + stage persist; unknown stage dropped', () => {
    const d = cleanDraft({
      v: 1, kind: 'photo', ctx: { id: 'x', kind: 'record', title: 'Site' },
      recordId: 'cap_123', stage: 'files', caption: 'hi',
    })!;
    expect(d.recordId).toBe('cap_123');
    expect(d.stage).toBe('files');
    const bad = cleanDraft({ v: 1, kind: 'photo', ctx: null, stage: 'bogus' })!;
    expect(bad.stage).toBeUndefined();
  });
});
