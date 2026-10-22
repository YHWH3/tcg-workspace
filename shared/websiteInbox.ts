/* The Website inbox records database — the one definition both the client
 * seed (src/core/sync/engine.ts) and the signed ingest route
 * (worker/websiteIngest.ts) write, so field ids never drift. Columns are the
 * record Status. */

import type { FieldDef } from './fields';

export const WEBSITE_INBOX_ID = 'board-website-inbox';

export const WEBSITE_EVENTS = [
  'form.submitted',
  'patron.applied',
  'patron.approved',
  'patron.paid',
  'patron.minted',
  'patron.refund_needed',
] as const;
export type WebsiteEvent = (typeof WEBSITE_EVENTS)[number];

export const PATRON_TIERS = ['founding', 'builder', 'partner'] as const;

/** Custom field ids (values live on records as `p_<id>`). */
export const WI_FIELD = {
  source: 'wi_source',
  email: 'wi_email',
  page: 'wi_page',
  event: 'wi_event',
  tier: 'wi_tier',
  edition: 'wi_edition',
  application: 'wi_application',
} as const;

const EVENT_LABELS: Record<WebsiteEvent, string> = {
  'form.submitted': 'Form submitted',
  'patron.applied': 'Patron applied',
  'patron.approved': 'Patron approved',
  'patron.paid': 'Patron paid',
  'patron.minted': 'Patron minted',
  'patron.refund_needed': 'Refund needed',
};

export function websiteEventLabel(event: WebsiteEvent): string {
  return EVENT_LABELS[event];
}

const FIELDS: FieldDef[] = [
  { id: WI_FIELD.source, name: 'Source', type: 'text', showOnCard: true },
  { id: WI_FIELD.email, name: 'Email', type: 'text' },
  { id: WI_FIELD.page, name: 'Page', type: 'url' },
  {
    id: WI_FIELD.event,
    name: 'Event',
    type: 'select',
    showOnCard: true,
    options: WEBSITE_EVENTS.map((e) => ({ id: e, name: EVENT_LABELS[e], color: e === 'patron.refund_needed' ? '#e5484d' : '#8a8a8a' })),
  },
  {
    id: WI_FIELD.tier,
    name: 'Patron tier',
    type: 'select',
    options: PATRON_TIERS.map((t) => ({ id: t, name: t[0]!.toUpperCase() + t.slice(1), color: '#0091ff' })),
  },
  { id: WI_FIELD.edition, name: 'Edition', type: 'text' },
  { id: WI_FIELD.application, name: 'Application id', type: 'text' },
];

export const WEBSITE_INBOX_BOARD: Record<string, unknown> = {
  name: 'Website inbox',
  icon: '🌐',
  kind: 'records',
  recordNoun: 'submission',
  description: 'Form submissions and patron events from The Common Ground website.',
  showBuiltins: false,
  columns: [
    { id: 'new', name: 'New', color: '#e5a000' },
    { id: 'in_review', name: 'In review', color: '#0091ff' },
    { id: 'replied', name: 'Replied', color: '#8e4ec6' },
    { id: 'done', name: 'Done', color: '#30a46c' },
  ],
  fields: FIELDS,
  order: 'a2',
};
