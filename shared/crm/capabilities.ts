export const CRM_CHANNELS = ['email', 'whatsapp', 'instagram', 'facebook'] as const;
export type CrmChannel = typeof CRM_CHANNELS[number];

export const CRM_CAPABILITIES = [
  'crm.access',
  'crm.send:email',
  'crm.send:whatsapp',
  'crm.send:instagram',
  'crm.send:facebook',
  'crm.restricted.read',
  'crm.finance.read',
  'crm.finance.record',
  'crm.refund.approve',
  'crm.configure',
  'crm.merge',
  'crm.channels.manage',
  'crm.capabilities.manage',
] as const;
export type CrmCapability = typeof CRM_CAPABILITIES[number];

export const ALL_SCOPE = '*' as const;
/** Scope '*' = all programmes. crm-s0-v2 accepts only '*' (programme scopes arrive in S2). */
export type CrmScope = '*' | string;

/** Capabilities that will accept a programme scope once the programme registry exists (S2). */
export const PROGRAMME_SCOPED: ReadonlySet<CrmCapability> = new Set([
  'crm.restricted.read',
  'crm.configure',
]);

export function isCrmCapability(value: string): value is CrmCapability {
  return (CRM_CAPABILITIES as readonly string[]).includes(value);
}

export const CRM_CAPABILITY_LABELS: Record<
  CrmCapability,
  { label: string; description: string; sensitive: boolean }
> = {
  'crm.access': {
    label: 'Open the CRM',
    description: 'Use the CRM app and its relationship records.',
    sensitive: false,
  },
  'crm.send:email': {
    label: 'Send email',
    description: 'Send email from the shared mailbox.',
    sensitive: false,
  },
  'crm.send:whatsapp': {
    label: 'Send WhatsApp',
    description: 'Send WhatsApp messages.',
    sensitive: false,
  },
  'crm.send:instagram': {
    label: 'Send Instagram',
    description: 'Send Instagram messages.',
    sensitive: false,
  },
  'crm.send:facebook': {
    label: 'Send Facebook',
    description: 'Send Facebook Page messages.',
    sensitive: false,
  },
  'crm.restricted.read': {
    label: 'Read restricted notes',
    description: 'See screening, health, suitability and other restricted notes.',
    sensitive: true,
  },
  'crm.finance.read': {
    label: 'See money',
    description: 'See payments, balances and refunds.',
    sensitive: true,
  },
  'crm.finance.record': {
    label: 'Record payments',
    description: 'Record payments, reversals and issued refunds.',
    sensitive: true,
  },
  'crm.refund.approve': {
    label: 'Approve refunds',
    description: 'Approve refund requests made by others.',
    sensitive: true,
  },
  'crm.configure': {
    label: 'Configure',
    description: 'Change programmes, CRM views, fields, automations and templates.',
    sensitive: false,
  },
  'crm.merge': {
    label: 'Merge people',
    description: 'Merge and unmerge duplicate people.',
    sensitive: false,
  },
  'crm.channels.manage': {
    label: 'Connect channels',
    description: 'Connect and disconnect channel accounts.',
    sensitive: false,
  },
  'crm.capabilities.manage': {
    label: 'Manage capabilities',
    description: 'Grant and revoke CRM capabilities. Owner grants this, to admins only.',
    sensitive: true,
  },
};
