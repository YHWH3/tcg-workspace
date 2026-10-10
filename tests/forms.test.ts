import { describe, expect, it } from 'vitest';
import {
  duplicateMarker,
  findPersonMatch,
  mintToken,
  normalizeEmail,
  normalizePersonName,
  notesFieldOf,
  parseFormConfig,
  peopleEmailKey,
  planSubmissionChanges,
  publicFormSchema,
  submissionRecordId,
  validateFormConfig,
  validateSubmissionValues,
  type FormConfig,
} from '../worker/forms';
import { linkId } from '../shared/linkid';
import type { FieldDef } from '../shared/fields';

/* Forms platform (Phase 4 §6): config parse/validate, public-schema
 * filtering (member-only keys must never leak), submission coercion,
 * receipt idempotency primitives, people matching, write planning. */

const emailField: FieldDef = { id: 'fEmail', name: 'Email', type: 'url' };
const notesField: FieldDef = { id: 'fNotes', name: 'Notes', type: 'text' };
const sizeField: FieldDef = {
  id: 'fSize',
  name: 'T-shirt size',
  type: 'select',
  options: [
    { id: 's', name: 'S', color: '' },
    { id: 'm', name: 'M', color: '' },
  ],
};
const personField: FieldDef = { id: 'fOwner', name: 'Owner', type: 'person' };
const relField: FieldDef = { id: 'fRel', name: 'Project', type: 'relation', relation: { target: 'dbProjects' } };

const board = {
  columns: [
    { id: 'new', name: 'New', color: '#0091ff' },
    { id: 'done', name: 'Done', color: '#30a46c' },
  ],
  fields: [emailField, notesField, sizeField, personField, relField],
};

const form: FormConfig = {
  databaseId: 'dbPeople',
  title: 'Volunteer signup',
  description: 'Join the crew',
  fields: [
    { fieldKey: 'title', label: 'Full name', required: true, order: 0 },
    { fieldKey: 'p_fEmail', label: 'Email', required: true, order: 1 },
    { fieldKey: 'p_fSize', label: 'T-shirt size', order: 2 },
    { fieldKey: 'dueDate', label: 'Available from', order: 3 },
  ],
  successMessage: 'You are in!',
  enabled: true,
  notifyUserIds: ['u1'],
  createRelations: [{ fieldId: 'fRel', toId: 'proj1' }],
  peopleMatch: { emailField: 'fEmail' },
  branding: { intro: 'We reply within a week.' },
};

describe('parseFormConfig', () => {
  it('parses a valid config and sorts fields by order', () => {
    const cfg = parseFormConfig({ ...form, fields: [...form.fields].reverse() });
    expect(cfg).not.toBeNull();
    expect(cfg!.fields.map((f) => f.fieldKey)).toEqual(['title', 'p_fEmail', 'p_fSize', 'dueDate']);
  });
  it('rejects missing databaseId / title / empty fields', () => {
    expect(parseFormConfig({ ...form, databaseId: '' })).toBeNull();
    expect(parseFormConfig({ ...form, title: '' })).toBeNull();
    expect(parseFormConfig({ ...form, fields: [] })).toBeNull();
    expect(parseFormConfig({ ...form, fields: [{ fieldKey: 'title' }] })).toBeNull(); // no label
    expect(parseFormConfig(null as never)).toBeNull();
  });
  it('defaults successMessage and tolerates absent optional sections', () => {
    const cfg = parseFormConfig({ databaseId: 'd', title: 'T', fields: [{ fieldKey: 'title', label: 'L' }] });
    expect(cfg!.successMessage).toBeTruthy();
    expect(cfg!.enabled).toBe(false);
    expect(cfg!.notifyUserIds).toEqual([]);
  });
  it('rejects malformed peopleMatch / createRelations', () => {
    expect(parseFormConfig({ ...form, peopleMatch: {} })).toBeNull();
    expect(parseFormConfig({ ...form, createRelations: [{ fieldId: 'x' }] })).toBeNull();
  });
});

describe('publicFormSchema — member-only config never leaks', () => {
  it('strips notifyUserIds, createRelations, peopleMatch and keeps the public field shape', () => {
    const schema = publicFormSchema(form, board, 'test') as Record<string, unknown>;
    expect(schema).not.toHaveProperty('notifyUserIds');
    expect(schema).not.toHaveProperty('createRelations');
    expect(schema).not.toHaveProperty('peopleMatch');
    expect(schema).not.toHaveProperty('databaseId');
    expect(schema.turnstileSiteKey).toBe('test');
    expect(schema.intro).toBe('We reply within a week.');
    const fields = schema.fields as { key: string; type: string; options?: unknown[] }[];
    expect(fields.map((f) => f.key)).toEqual(['title', 'p_fEmail', 'p_fSize', 'dueDate']);
    expect(fields[1].type).toBe('email'); // url def named "Email" renders as email
    expect(fields[2].type).toBe('select');
    expect(fields[2].options).toHaveLength(2);
    expect(fields[3].type).toBe('date');
  });
  it('drops fields whose key is no longer exposable (removed/person/relation)', () => {
    const f = { ...form, fields: [...form.fields, { fieldKey: 'p_fOwner', label: 'Owner' }, { fieldKey: 'p_gone', label: 'Gone' }] };
    const schema = publicFormSchema(f, board, 'test') as { fields: { key: string }[] };
    expect(schema.fields.map((x) => x.key)).not.toContain('p_fOwner');
    expect(schema.fields.map((x) => x.key)).not.toContain('p_gone');
  });
});

describe('validateFormConfig', () => {
  it('accepts the base form', () => {
    expect(validateFormConfig(form, board)).toEqual([]);
  });
  it('flags duplicate + non-exposable fieldKeys', () => {
    const f = { ...form, fields: [...form.fields, { fieldKey: 'title', label: 'Dup' }, { fieldKey: 'assignee', label: 'A' }, { fieldKey: 'p_fOwner', label: 'O' }] };
    const errs = validateFormConfig(f, board);
    expect(errs.some((e) => e.includes('duplicate'))).toBe(true);
    expect(errs.some((e) => e.includes('assignee'))).toBe(true);
    expect(errs.some((e) => e.includes('p_fOwner'))).toBe(true);
  });
  it('flags createRelations on non-relation fields and bad peopleMatch fields', () => {
    expect(validateFormConfig({ ...form, createRelations: [{ fieldId: 'fSize', toId: 'x' }] }, board).length).toBe(1);
    expect(validateFormConfig({ ...form, peopleMatch: { emailField: 'fSize' } }, board).length).toBe(1); // select, not text/url
    expect(validateFormConfig({ ...form, peopleMatch: { emailField: 'missing' } }, board).length).toBe(1);
  });
});

describe('validateSubmissionValues', () => {
  it('coerces valid values (email normalized, select by name OR id, builtins mapped)', () => {
    const r = validateSubmissionValues(form, board, {
      title: '  Ada Lovelace ',
      p_fEmail: ' ADA@X.COM ',
      p_fSize: 'm', // by id
      dueDate: '2026-12-01',
      extraJunk: 'ignored',
    });
    expect(r.ok).toBe(true);
    expect(r.coerced.title).toBe('Ada Lovelace');
    expect(r.coerced.p_fEmail).toBe('ada@x.com');
    expect(r.coerced.p_fSize).toBe('m');
    expect(r.coerced.dueDate).toBe('2026-12-01');
    expect(r.ignored).toEqual(['extraJunk']);
  });
  it('select accepts option names case-insensitively', () => {
    const r = validateSubmissionValues(form, board, { title: 'T', p_fEmail: 'a@b.co', p_fSize: 'M' });
    expect(r.ok).toBe(true);
    expect(r.coerced.p_fSize).toBe('m');
  });
  it('enforces required and flags invalid values', () => {
    const r = validateSubmissionValues(form, board, { p_fEmail: 'not-an-email', p_fSize: 'XXL', dueDate: 'soon' });
    expect(r.ok).toBe(false);
    expect(r.errors.title).toBe('required');
    expect(r.errors.p_fEmail).toBe('invalid');
    expect(r.errors.p_fSize).toBe('invalid');
    expect(r.errors.dueDate).toBe('invalid');
  });
  it('missing optional fields produce no keys at all', () => {
    const r = validateSubmissionValues(form, board, { title: 'T', p_fEmail: 'a@b.co' });
    expect(r.ok).toBe(true);
    expect(r.coerced).not.toHaveProperty('p_fSize');
    expect(r.coerced).not.toHaveProperty('dueDate');
  });
});

describe('receipt idempotency primitives', () => {
  it('submissionRecordId is deterministic per (formId, submissionId)', () => {
    expect(submissionRecordId('f1', 'abc')).toBe(submissionRecordId('f1', 'abc'));
    expect(submissionRecordId('f1', 'abc')).not.toBe(submissionRecordId('f1', 'abd'));
    expect(submissionRecordId('f2', 'abc')).not.toBe(submissionRecordId('f1', 'abc'));
    expect(submissionRecordId('f1', 'abc')).toMatch(/^sub_[0-9a-f]{16}$/);
  });
  it('mintToken produces tok_ + 22 base62 chars', () => {
    const t = mintToken();
    expect(t).toMatch(/^tok_[A-Za-z0-9]{22}$/);
    expect(mintToken()).not.toBe(t);
  });
});

describe('people matching', () => {
  const rows = [
    { id: 'p1', title: 'Ada Lovelace', data: { p_fEmail: 'ada@x.com' } },
    { id: 'p2', title: 'Bob  Smith', data: { p_fEmail: 'bob@x.com' } },
  ];
  it('email match wins (normalized lower+trim)', () => {
    expect(findPersonMatch('p_fEmail', ' ADA@x.COM ', 'Someone Else', rows)).toEqual({ kind: 'email', personId: 'p1', personTitle: 'Ada Lovelace' });
  });
  it('name-similar only when email misses — whitespace-collapsed, case-insensitive', () => {
    const m = findPersonMatch('p_fEmail', '', 'bob smith', rows);
    expect(m).toEqual({ kind: 'name-similar', personId: 'p2', personTitle: 'Bob  Smith' });
  });
  it('no match → none', () => {
    expect(findPersonMatch('p_fEmail', 'x@y.z', 'Nobody', rows)).toEqual({ kind: 'none' });
  });
  it('email field key normalisation', () => {
    expect(peopleEmailKey('fEmail')).toBe('p_fEmail');
    expect(peopleEmailKey('p_fEmail')).toBe('p_fEmail');
    expect(normalizeEmail(' A@B.C ')).toBe('a@b.c');
    expect(normalizePersonName('  A  B ')).toBe('a b');
  });
  it('duplicate marker text is honest and dated', () => {
    const m = duplicateMarker('Ada Lovelace', Date.UTC(2026, 9, 10));
    expect(m).toContain('Possible duplicate');
    expect(m).toContain('Ada Lovelace');
    expect(m).toContain('2026-10-10');
  });
  it('notes field lookup finds notes-ish text fields', () => {
    expect(notesFieldOf(board)?.id).toBe('fNotes');
    expect(notesFieldOf({ fields: [] })).toBeUndefined();
  });
});

describe('planSubmissionChanges', () => {
  const base = {
    form,
    formId: 'form1',
    boardData: board,
    coerced: { title: 'Ada', p_fEmail: 'ada@x.com', p_fSize: 'm' },
    submissionId: 's1',
    lastOrder: 'a0' as string | undefined,
    personMatch: { kind: 'none' } as const,
    pendingFileIds: [] as string[],
    at: 1000,
  };

  it('builds the record with coerced props + defaulted status/order', () => {
    const ops = planSubmissionChanges(base);
    const rec = ops.find((o) => o.collection === 'tasks')!;
    expect(rec.id).toBe(submissionRecordId('form1', 's1'));
    expect(rec.patch.boardId).toBe('dbPeople');
    expect(rec.patch.title).toBe('Ada');
    expect(rec.patch.status).toBe('new'); // first column
    expect(rec.patch.p_fEmail).toBe('ada@x.com');
    expect(rec.patch.p_fSize).toBe('m');
    expect(rec.patch.createdBy).toBeNull();
    expect(typeof rec.patch.order).toBe('string');
  });

  it('createRelations emits a primary-direction relation link', () => {
    const ops = planSubmissionChanges(base);
    const link = ops.find((o) => o.collection === 'links' && o.patch.kind === 'relation')!;
    const recId = submissionRecordId('form1', 's1');
    expect(link.id).toBe(linkId('relation', 'fRel', recId, 'proj1'));
    expect(link.patch).toMatchObject({ fieldId: 'fRel', fromId: recId, toId: 'proj1', kind: 'relation', deleted: false });
  });

  it('email match → related link to the person; name-similar → notes marker on the record', () => {
    const emailOps = planSubmissionChanges({ ...base, personMatch: { kind: 'email', personId: 'p1', personTitle: 'Ada' } });
    const rel = emailOps.find((o) => o.collection === 'links' && o.patch.kind === 'related')!;
    expect(rel.id).toBe(linkId('related', '', submissionRecordId('form1', 's1'), 'p1'));

    const simOps = planSubmissionChanges({ ...base, personMatch: { kind: 'name-similar', personId: 'p2', personTitle: 'Bob' } });
    const rec = simOps.find((o) => o.collection === 'tasks')!;
    expect(String(rec.patch.p_fNotes)).toContain('Possible duplicate');
    expect(String(rec.patch.p_fNotes)).toContain('Bob');
  });

  it('reparents only the given pending files; fileLink → kind:link file record', () => {
    const ops = planSubmissionChanges({ ...base, pendingFileIds: ['f_a'], fileLink: 'https://drive.google.com/x' });
    const reparent = ops.find((o) => o.id === 'f_a')!;
    expect(reparent.collection).toBe('files');
    expect(reparent.patch).toMatchObject({ parentType: 'task', parentId: submissionRecordId('form1', 's1') });
    const linkFile = ops.find((o) => o.collection === 'files' && o.patch.kind === 'link')!;
    expect(linkFile.patch.url).toBe('https://drive.google.com/x');
    expect(linkFile.patch.parentId).toBe(submissionRecordId('form1', 's1'));
  });
});
