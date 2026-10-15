// Phase 4 adds 'automations' + 'forms' as member-editable CONFIG collections.
// Server-controlled state (notifications, approvals, runs, tokens,
// submissions, date_index, reminder_sent, event_outbox, rate_limits) lives in
// dedicated D1 tables and is NEVER in this list — generic sync cannot carry it.
export const COLLECTIONS = ['pages', 'blocks', 'tasks', 'comments', 'activity', 'boards', 'files', 'moodboards', 'mooditems', 'views', 'links', 'automations', 'forms'] as const;

export type Collection = (typeof COLLECTIONS)[number];

export function isCollection(value: string): value is Collection {
  return (COLLECTIONS as readonly string[]).includes(value);
}
