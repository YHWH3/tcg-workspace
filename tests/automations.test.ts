import { describe, expect, it } from 'vitest';
import {
  automationDbId,
  conditionsMatch,
  matchesScope,
  matchesTrigger,
  renderTemplate,
  runEventKey,
  validateAutomation,
  type AutomationConfig,
} from '../shared/automations';
import type { SemanticEvent } from '../shared/events';
import { addDays, todayUtc } from '../shared/recurrence';
import { toBundled, type AuthorTemplate } from '../shared/bundled';
import { planTemplateInstantiation } from '../shared/templates';
import rawPack from '../templates/tcg-pack.json';

const ev = (partial: Partial<SemanticEvent>): SemanticEvent => ({ kind: 'record.created', recordId: 'r1', collection: 'tasks', ...partial });

const board = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Tasks',
  columns: [
    { id: 'todo', name: 'To do' },
    { id: 'done', name: 'Done' },
  ],
  fields: [
    { id: 'f_owner', name: 'Owner', type: 'person' },
    { id: 'f_deadline', name: 'Deadline', type: 'date' },
    { id: 'f_note', name: 'Note', type: 'text' },
  ],
  ...over,
});

describe('matchesTrigger', () => {
  it('record.created fires on creates only', () => {
    expect(matchesTrigger({ kind: 'record.created' }, ev({}))).toBe(true);
    expect(matchesTrigger({ kind: 'record.created' }, ev({ kind: 'record.field_changed', fieldKey: 'title' }))).toBe(false);
  });

  it('stage_changed respects the `to` column filter', () => {
    const e = ev({ kind: 'record.stage_changed', from: 'todo', to: 'done' });
    expect(matchesTrigger({ kind: 'stage_changed', to: 'done' }, e)).toBe(true);
    expect(matchesTrigger({ kind: 'stage_changed', to: 'review' }, e)).toBe(false);
    expect(matchesTrigger({ kind: 'stage_changed' }, e)).toBe(true);
  });

  it('field_changed respects the fieldId filter', () => {
    const e = ev({ kind: 'record.field_changed', fieldKey: 'p_f_note' });
    expect(matchesTrigger({ kind: 'field_changed', fieldId: 'p_f_note' }, e)).toBe(true);
    expect(matchesTrigger({ kind: 'field_changed', fieldId: 'p_f_deadline' }, e)).toBe(false);
    expect(matchesTrigger({ kind: 'field_changed' }, e)).toBe(true);
  });

  it('date_offset fires only for the explicit Cron date-offset event at today - days', () => {
    const today = todayUtc();
    const hit = addDays(today, 14); // days = -14 → want today+14
    const e = ev({ kind: 'record.field_changed', from: 'cron:date_offset', fieldKey: 'p_f_deadline', to: hit });
    expect(matchesTrigger({ kind: 'date_offset', dateKey: 'p_f_deadline', days: -14 }, e, { today })).toBe(true);
    // Wrong date → no fire.
    const other = ev({ kind: 'record.field_changed', from: 'cron:date_offset', fieldKey: 'p_f_deadline', to: '2020-01-01' });
    expect(matchesTrigger({ kind: 'date_offset', dateKey: 'p_f_deadline', days: -14 }, other, { today })).toBe(false);
    // Different field key → no fire.
    const wrongField = ev({ kind: 'record.field_changed', from: 'cron:date_offset', fieldKey: 'p_f_note', to: hit });
    expect(matchesTrigger({ kind: 'date_offset', dateKey: 'p_f_deadline', days: -14 }, wrongField, { today })).toBe(false);
    expect(matchesTrigger({ kind: 'date_offset', dateKey: 'p_f_deadline', days: -14 }, { ...e, from: undefined }, { today })).toBe(false);
    expect(matchesTrigger({ kind: 'date_offset', dateKey: 'p_f_deadline', days: -14 }, { ...e, from: '2026-01-01' }, { today })).toBe(false);
  });

  it('form.submitted matches by formId', () => {
    const e = ev({ kind: 'form.submitted', formId: 'form_a' });
    expect(matchesTrigger({ kind: 'form.submitted', formId: 'form_a' }, e)).toBe(true);
    expect(matchesTrigger({ kind: 'form.submitted', formId: 'form_b' }, e)).toBe(false);
    expect(matchesTrigger({ kind: 'form.submitted' }, e)).toBe(true);
    expect(matchesTrigger({ kind: 'form.submitted' }, ev({}))).toBe(false);
  });
});

describe('matchesScope + automationDbId', () => {
  const auto = (cfg: Partial<AutomationConfig>): AutomationConfig => ({ databaseId: 'db1', enabled: true, ...cfg });

  it('scopes db triggers to the event boardId', () => {
    const a = auto({ trigger: { kind: 'record.created' } });
    expect(matchesScope(a, ev({ boardId: 'db1' }))).toBe(true);
    expect(matchesScope(a, ev({ boardId: 'db2' }))).toBe(false);
  });

  it('disabled or deleted configs never scope', () => {
    expect(matchesScope(auto({ enabled: false }), ev({ boardId: 'db1' }))).toBe(false);
    expect(matchesScope(auto({ deleted: true }), ev({ boardId: 'db1' }))).toBe(false);
  });

  it('form.submitted events only scope form triggers', () => {
    expect(matchesScope(auto({ trigger: { kind: 'form.submitted' } }), ev({ kind: 'form.submitted', boardId: 'db1' }))).toBe(true);
    expect(matchesScope(auto({ trigger: { kind: 'form.submitted' } }), ev({ kind: 'form.submitted', boardId: 'db2' }))).toBe(false);
    expect(matchesScope(auto({ trigger: { kind: 'form.submitted' } }), ev({ kind: 'form.submitted' }))).toBe(false);
    expect(matchesScope({ trigger: { kind: 'form.submitted' } }, ev({ kind: 'form.submitted' }))).toBe(true);
    expect(matchesScope(auto({ trigger: { kind: 'record.created' } }), ev({ kind: 'form.submitted' }))).toBe(false);
  });

  it('trigger.databaseId overrides the row scope', () => {
    const a = auto({ databaseId: 'db1', trigger: { kind: 'record.created', databaseId: 'db2' } });
    expect(automationDbId(a)).toBe('db2');
    expect(matchesScope(a, ev({ boardId: 'db2' }))).toBe(true);
    expect(matchesScope(a, ev({ boardId: 'db1' }))).toBe(false);
  });
});

describe('renderTemplate', () => {
  const ctx = {
    record: { id: 'r1', title: 'Water pump', p_f_note: 'hello' },
    fields: board().fields as never,
    today: '2026-01-02',
  };
  it('renders record builtins, named fields and today', () => {
    expect(renderTemplate('Fix — {{record.title}}', ctx)).toBe('Fix — Water pump');
    expect(renderTemplate('{{field:Note}}!', ctx)).toBe('hello!');
    expect(renderTemplate('due {{today}}', ctx)).toBe('due 2026-01-02');
    expect(renderTemplate('{{field:note}}', ctx)).toBe('hello'); // case-insensitive
  });
  it('keeps unknown placeholders literal; missing values empty', () => {
    expect(renderTemplate('{{bogus}}', ctx)).toBe('{{bogus}}');
    expect(renderTemplate('{{field:Missing}}', ctx)).toBe('');
    expect(renderTemplate('{{record.nope}}', ctx)).toBe('');
  });
});

describe('conditionsMatch', () => {
  const rec = { id: 'r1', title: 'Pump', status: 'done', p_f_membership: ['member', 'volunteer'] };
  it('ANDs filters on the after snapshot', () => {
    expect(conditionsMatch([{ key: 'status', op: 'is', value: 'done' }], rec)).toBe(true);
    expect(conditionsMatch([{ key: 'status', op: 'is', value: 'todo' }], rec)).toBe(false);
    expect(conditionsMatch(undefined, rec)).toBe(true);
    expect(
      conditionsMatch(
        [
          { key: 'status', op: 'is', value: 'done' },
          { key: 'p_f_membership', op: 'contains', value: 'member' },
        ],
        rec,
      ),
    ).toBe(true);
  });
});

describe('runEventKey', () => {
  const e = ev({ kind: 'record.stage_changed', to: 'done' });
  it('is stable for the same (outbox, automation, event) and varies by each part', () => {
    expect(runEventKey('a1', e, 'ob1')).toBe(runEventKey('a1', e, 'ob1'));
    expect(runEventKey('a1', e, 'ob1')).not.toBe(runEventKey('a1', e, 'ob2'));
    expect(runEventKey('a1', e, 'ob1')).not.toBe(runEventKey('a2', e, 'ob1'));
    expect(runEventKey('a1', e, 'ob1')).not.toBe(runEventKey('a1', ev({ kind: 'record.created' }), 'ob1'));
    expect(runEventKey('a1', e, 'ob1')).toMatch(/^ar_[0-9a-f]+$/);
  });
});

describe('validateAutomation', () => {
  const ctx = { boardsById: new Map([['db1', board()], ['db2', board({ name: 'People', columns: [] })]]), memberIds: new Set(['u1']), templateIds: new Set(['t1']), formIds: new Set(['form_a']) };

  it('accepts a well-formed automation', () => {
    const errors = validateAutomation(
      {
        databaseId: 'db1',
        name: 'Done → notify',
        trigger: { kind: 'stage_changed', to: 'done' },
        conditions: [{ key: 'title', op: 'not_empty' }],
        actions: [{ type: 'notify', userField: 'f_owner', message: 'hi' }],
      },
      ctx,
    );
    expect(errors).toEqual([]);
  });

  it('flags unknown database / stage / recipients', () => {
    const errors = validateAutomation(
      {
        databaseId: 'dbX',
        name: 'x',
        trigger: { kind: 'stage_changed', to: 'nope' },
        actions: [{ type: 'notify', userIds: ['ghost'], message: 'hi' }],
      },
      ctx,
    );
    expect(errors.join(' | ')).toMatch(/database dbX not found/);
    expect(errors.join(' | ')).toMatch(/user ghost is not a member/);
  });

  it('flags bad stage id against the board columns', () => {
    const errors = validateAutomation({ databaseId: 'db1', name: 'x', trigger: { kind: 'stage_changed', to: 'bogus' }, actions: [{ type: 'set_field', fieldKey: 'status', value: 'done' }] }, ctx);
    expect(errors.join(' | ')).toMatch(/stage bogus is not a column/);
  });

  it('flags date_offset on a non-date field', () => {
    const errors = validateAutomation({ databaseId: 'db1', name: 'x', trigger: { kind: 'date_offset', dateKey: 'p_f_note', days: -1 }, actions: [{ type: 'notify', userField: 'f_owner', message: 'm' }] }, ctx);
    expect(errors.join(' | ')).toMatch(/not a date field/);
  });

  it('flags missing template / form / action basics', () => {
    const errors = validateAutomation(
      {
        databaseId: 'db1',
        name: 'x',
        trigger: { kind: 'form.submitted', formId: 'formZ' },
        actions: [
          { type: 'create_from_template', templateId: 'gone' },
          { type: 'request_approval' },
          { type: 'add_subrecords', titles: [] },
        ],
      },
      ctx,
    );
    expect(errors.join(' | ')).toMatch(/form formZ not found/);
    expect(errors.join(' | ')).toMatch(/template gone not found/);
    expect(errors.join(' | ')).toMatch(/an approver is required/);
    expect(errors.join(' | ')).toMatch(/at least one title/);
  });

  it('requires at least one action and a valid trigger', () => {
    expect(validateAutomation({ databaseId: 'db1', name: 'x', trigger: { kind: 'record.created' }, actions: [] }, ctx).join(' ')).toMatch(/at least one action/);
    expect(validateAutomation({ databaseId: 'db1', name: 'x' }, ctx).join(' ')).toMatch(/trigger is required/);
  });
});

describe('tcg-pack automations + forms (install pipeline)', () => {
  const bundle = toBundled('tcg-pack', rawPack as unknown as AuthorTemplate);

  it('author format → snapshot carries 5 automations + 6 forms', () => {
    expect(Object.keys(bundle.snapshot.automations ?? {})).toHaveLength(5);
    expect(Object.keys(bundle.snapshot.forms ?? {})).toHaveLength(6);
  });

  it('pack install remaps authored ids inside automation/form configs', () => {
    let n = 0;
    const plan = planTemplateInstantiation(
      bundle.snapshot,
      { templateId: bundle.root, templateKey: 'tcg-pack', packInstall: true, stableIds: true, actorId: 'u' },
      { id: () => `x${(n++).toString(36)}`, now: Date.now() },
    );
    expect(plan).not.toBeNull();
    const autoWrites = plan!.writes.filter((w) => w.collection === 'automations');
    const formWrites = plan!.writes.filter((w) => w.collection === 'forms');
    expect(autoWrites).toHaveLength(5);
    expect(formWrites).toHaveLength(6);
    // Stable ids → inst_<hash> rows.
    for (const w of [...autoWrites, ...formWrites]) expect(w.id).toMatch(/^inst_[0-9a-f]+$/);
    // No authored db_/pg_/r_ ids survive inside the configs.
    for (const w of [...autoWrites, ...formWrites]) {
      expect(JSON.stringify(w.patch)).not.toMatch(/"db_[a-z0-9_]+"|"pg_[a-z0-9_]+"|"r_[a-z0-9_]+"/);
    }
    // The project-review automation's target db resolves to the installed Tasks board.
    const tasksBoardWrite = plan!.writes.find((w) => w.collection === 'boards' && w.patch.templateDbKey === 'tasks');
    expect(tasksBoardWrite).toBeTruthy();
    const reviewAuto = autoWrites.find((w) => JSON.stringify(w.patch).includes('Project completed'));
    expect(JSON.stringify(reviewAuto!.patch)).toContain(tasksBoardWrite!.id);
  });

  it('starter automation configs validate against the pack boards', () => {
    const boardsById = new Map<string, Record<string, unknown>>();
    for (const [id, b] of Object.entries(bundle.snapshot.boards)) boardsById.set(id, b);
    for (const [id, cfg] of Object.entries(bundle.snapshot.automations ?? {})) {
      const errors = validateAutomation(cfg as AutomationConfig, { boardsById, formIds: Object.keys(bundle.snapshot.forms ?? {}) });
      expect(errors, `${id}: ${errors.join('; ')}`).toEqual([]);
    }
  });
});
