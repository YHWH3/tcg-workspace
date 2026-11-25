// Fictional "Commons" team fixture for CRM S0 preview and smoke verification.
// Zero real people, emails, phone numbers, or production identifiers.

export const COMMONS_OWNER = {
  username: 'pia',
  name: 'Pia Sol',
};

export const COMMONS_MEMBERS = [
  {
    username: 'arun',
    name: 'Arun Varma',
    role: 'admin',
    capabilities: [
      'crm.access',
      'crm.send:email',
      'crm.configure',
      'crm.capabilities.manage',
    ],
    reason: 'Commons operations lead',
  },
  {
    username: 'meera',
    name: 'Meera Krishnan',
    role: 'member',
    capabilities: ['crm.access', 'crm.send:whatsapp'],
    reason: 'Commons participant coordinator',
  },
  {
    username: 'dev',
    name: 'Dev Nair',
    role: 'member',
    // Holds a specialised grant without crm.access to demonstrate inactive-grant warning.
    capabilities: ['crm.send:email'],
    reason: 'Pending CRM onboarding',
  },
  {
    username: 'kiran',
    name: 'Kiran Rao',
    role: 'member',
    capabilities: [],
    reason: '',
  },
];
