// Fictional "Riverbank Commons" team and P1 CRM fixture for local demo & verification.
// Zero real people, emails, phone numbers, organisations, or production policies.

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
      'crm.merge',
    ],
    scopedGrants: [
      { capability: 'crm.restricted.read', scope: 'programme:common-lab', reason: 'Programme review lead' },
    ],
    reason: 'Commons operations lead',
  },
  {
    username: 'meera',
    name: 'Meera Krishnan',
    role: 'member',
    capabilities: ['crm.access', 'crm.send:whatsapp'],
    scopedGrants: [
      { capability: 'crm.configure', scope: 'programme:common-lab', reason: 'Programme coordinator for Common Lab' },
    ],
    reason: 'Commons participant coordinator',
  },
  {
    username: 'dev',
    name: 'Dev Nair',
    role: 'member',
    // Holds a specialised grant without crm.access to demonstrate inactive-grant warning.
    capabilities: ['crm.send:email'],
    scopedGrants: [],
    reason: 'Pending CRM onboarding',
  },
  {
    username: 'kiran',
    name: 'Kiran Rao',
    role: 'member',
    capabilities: [],
    scopedGrants: [],
    reason: '',
  },
];

export const COMMONS_PROGRAMMES = [
  { slug: 'tribal-habitat-workshop', name: 'Tribal Habitat Workshop', area: 'experiences_learning', forms: ['ws', 'events'] },
  { slug: 'common-lab', name: 'Common Lab', area: 'experiences_learning', forms: ['lab'] },
  { slug: 'dhaanyam-food-forest', name: 'Dhaanyam Food Forest', area: 'spaces_network', forms: ['space'] },
  { slug: 'parambu-habitat', name: 'Parambu Habitat', area: 'spaces_network', forms: [] },
  { slug: 'common-spaces-network', name: 'Common Spaces network', area: 'spaces_network', forms: ['space', 'community', 'collab'] },
  { slug: 'common-roots', name: 'Common Roots membership', area: 'community_support', forms: ['roots'] },
  { slug: 'patrons', name: 'Patrons', area: 'community_support', forms: ['patron'] },
  { slug: 'volunteering-internships', name: 'Volunteering and internships', area: 'community_support', forms: ['intern'] },
  { slug: 'partnerships-collaborations', name: 'Partnerships and collaborations', area: 'collaboration_work', forms: ['collab'] },
  { slug: 'architecture-consulting', name: 'Architecture and consulting', area: 'collaboration_work', forms: ['consulting', 'arch'] },
  { slug: 'common-ground-production', name: 'Common Ground Production', area: 'collaboration_work', forms: [] },
  { slug: 'fashion-flow', name: 'Fashion Flow', area: 'culture_making', forms: ['ff'] },
  { slug: 'common-culture', name: 'Common Culture', area: 'culture_making', forms: ['book'] },
  { slug: 'common-cupboard', name: 'Common Cupboard', area: 'culture_making', forms: [] },
];

export const COMMONS_PROGRAMME_RECORDS = COMMONS_PROGRAMMES.map((p, idx) => ({
  key: `prog_${p.slug}`,
  title: p.name,
  slug: p.slug,
  area: p.area,
  forms: p.forms,
  summary: `[Commons Sample Fixture] ${p.name} demonstration record (#${idx + 1}). Configure live criteria before production.`,
  status: 'active',
}));

export const COMMONS_ORGS = [
  { key: 'org_malabar', title: 'Malabar Weavers Co-op', type: 'collective', partnership: 'partner', location: 'Kochi', focus: ['agroecology', 'education'], website: 'https://malabar-weavers.example.org' },
  { key: 'org_periyar', title: 'Periyar Watershed Trust', type: 'institution', partnership: 'partner', location: 'Aluva', focus: ['water', 'research'], website: 'https://periyar-trust.example.org' },
  { key: 'org_palmyra', title: 'Palmyra Ecological Architecture', type: 'studio', partnership: 'member', location: 'Fort Kochi', focus: ['construction', 'energy'], website: 'https://palmyra-arch.example.org' },
  { key: 'org_kaveri', title: 'Kaveri Civic Design School', type: 'school', partnership: 'partner', location: 'Chennai', focus: ['education', 'research'], website: 'https://kaveri-design.example.org' },
  { key: 'org_monsoon', title: 'Monsoon Timber Supply', type: 'supplier', partnership: 'vendor', location: 'Thrissur', focus: ['construction'], website: 'https://monsoon-timber.example.org' },
  { key: 'org_deccan', title: 'Deccan Cultural Foundation', type: 'institution', partnership: 'funder', location: 'Bengaluru', focus: ['funding', 'media'], website: 'https://deccan-fund.example.org' },
  { key: 'org_wayanad', title: 'Wayanad Seed Commons', type: 'space_operator', partnership: 'community', location: 'Kalpetta', focus: ['agroecology', 'water'], website: 'https://wayanad-seeds.example.org' },
  { key: 'org_shoreline', title: 'Shoreline Cinema Collective', type: 'collective', partnership: 'partner', location: 'Ernakulam', focus: ['media', 'education'], website: 'https://shoreline-cinema.example.org' },
];

const FIRST_NAMES = [
  'Nandini', 'Rohan', 'Kavya', 'Siddharth', 'Lakshmi',
  'Tariq', 'Anjali', 'Vikram', 'Neha', 'Pranav',
  'Deepa', 'Harish', 'Zoya', 'Karthik', 'Shruti',
  'Gautam', 'Bhavna', 'Raghav', 'Nisha', 'Arjun',
  'Pallavi', 'Suresh', 'Malini', 'Vivek', 'Sonia',
  'Kabir', 'Ishita', 'Ramesh', 'Nandini', 'Rohan',
];

const LAST_NAMES = [
  'Menon', 'Dutta', 'Deshmukh', 'Bhat', 'Pillai',
  'Hussain', 'Subramanian', 'Joshi', 'Kulkarni', 'Varghese',
  'Chatterjee', 'Iyer', 'Farooqui', 'Kurian', 'Patel',
  'Banerjee', 'Kamat', 'Prakash', 'Thomas', 'Mehta',
  'Shenoy', 'Reddy', 'Sundaram', 'Kapoor', 'Hegde',
  'Sen', 'Basu', 'Menon', 'Menon', 'Dutta',
];

const CITIES = ['Kochi', 'Ernakulam', 'Aluva', 'Thrissur', 'Chennai', 'Bengaluru'];
const SOURCES = ['website', 'whatsapp', 'instagram', 'referral', 'event', 'manual'];

export const COMMONS_PEOPLE = FIRST_NAMES.map((first, i) => {
  const last = LAST_NAMES[i];
  // Indices 28 and 29 deliberately collide on email (with 0) and phone (with 1) to populate Duplicates review.
  const collisionEmail = i === 28 ? 'nandini.menon.0@commons-demo.example.org' : `${first.toLowerCase()}.${last.toLowerCase()}.${i}@commons-demo.example.org`;
  const collisionPhone = i === 29 ? '+919800000101' : `+919800000${String(100 + i).padStart(3, '0')}`;
  return {
    key: `person_${i}`,
    title: i === 28 ? 'Nandini Menon (Alt)' : i === 29 ? 'Rohan Dutta (Studio)' : `${first} ${last}`,
    email: collisionEmail,
    phone: collisionPhone,
    location: CITIES[i % CITIES.length],
    source: SOURCES[i % SOURCES.length],
    membership: [i % 4 === 0 ? 'member' : i % 3 === 0 ? 'partner' : 'participant'],
    skills: [i % 2 === 0 ? 'facilitation' : 'agroecology', i % 5 === 0 ? 'carpentry' : 'writing'],
    languages: i % 2 === 0 ? ['en', 'ml'] : ['en', 'hi'],
    interests: [i % 2 === 0 ? 'workshops' : 'community'],
    orgIndex: i % COMMONS_ORGS.length,
    role: i % 3 === 0 ? 'Co-organiser' : i % 3 === 1 ? 'Research fellow' : 'Community collaborator',
  };
});

export const COMMONS_SAMPLE_PROGRAMME_PROFILE = {
  version: 1,
  area: 'experiences_learning',
  engines: { applications: true, bookings: true, membership: null, opportunities: ['partnership'], patrons: false },
  forms: ['lab'],
  autoCreateApplications: false,
  applicationStages: [
    { id: 'received', label: 'Received', color: 'ochre', kind: 'active' },
    { id: 'in_review', label: 'In review', color: 'river', kind: 'active' },
    { id: 'needs_info', label: 'Needs info', color: 'clay', kind: 'active' },
    { id: 'conversation', label: 'Conversation', color: 'dusk', kind: 'active' },
    { id: 'accepted', label: 'Accepted', color: 'leaf', kind: 'decision' },
    { id: 'declined', label: 'Declined', color: 'ember', kind: 'decision' },
    { id: 'withdrawn', label: 'Withdrawn', color: 'stone', kind: 'done' },
    { id: 'converted', label: 'Converted', color: 'teal', kind: 'done' },
  ],
  reviewGate: { stageId: 'in_review', requiresApproval: true },
  bookingDefaults: {
    holdMinutes: 1440,
    requiresScreening: true,
    confirmBeforePayment: false,
    pricePolicyNote: '[Commons Sample Fixture] Pricing policy intentionally unconfigured — configure in Settings before live bookings.',
  },
  responseTargetDays: 5,
  restrictedFields: [],
  policies: {
    eligibilityCriteria: '[Commons Sample Fixture] Open to multidisciplinary practitioners exploring civic commons.',
    durationSummary: '[Commons Sample Fixture] 4 weeks seasonal residency window',
    feeSummary: null,
    benefitsSummary: '[Commons Sample Fixture] Studio table & peer critique access',
  },
};

export const COMMONS_OPPORTUNITIES = [
  {
    key: 'opp_partnership_1',
    title: 'Periyar Watershed Living Classroom Partnership',
    pipeline: 'partnership',
    status: 'proposal',
    type: 'institutional_partnership',
    amount: 350000,
    nextAction: 'Review joint studio allocation and hand off to Project delivery',
    personIndex: 1,
    orgIndex: 1,
    programmeSlug: 'partnerships-collaborations',
  },
  {
    key: 'opp_partnership_2',
    title: 'Kaveri Design Field Exchange',
    pipeline: 'partnership',
    status: 'conversation',
    type: 'academic_collaboration',
    amount: 120000,
    nextAction: 'Schedule faculty planning call',
    personIndex: 3,
    orgIndex: 3,
    programmeSlug: 'common-lab',
  },
  {
    key: 'opp_consulting_1',
    title: 'Aluva Eco-Library Bamboo Pavilion Advisory',
    pipeline: 'consulting',
    status: 'negotiation',
    type: 'institutional_partnership',
    amount: 480000,
    nextAction: 'Share timber moisture test checklist',
    personIndex: 2,
    orgIndex: 2,
    programmeSlug: 'architecture-consulting',
  },
  {
    key: 'opp_production_1',
    title: 'Shoreline Festival Loom Capsule Series',
    pipeline: 'production',
    status: 'active',
    type: 'sponsorship',
    amount: 210000,
    nextAction: 'Confirm weave sample delivery',
    personIndex: 7,
    orgIndex: 7,
    programmeSlug: 'common-ground-production',
  },
  {
    key: 'opp_funding_1',
    title: 'Deccan Folk Craft Documentation Grant',
    pipeline: 'funding',
    status: 'submitted',
    type: 'grant',
    amount: 600000,
    nextAction: 'Await trustee committee review',
    personIndex: 5,
    orgIndex: 5,
    programmeSlug: 'partnerships-collaborations',
  },
  {
    key: 'opp_supply_1',
    title: 'Monsoon Reclaimed Teak Shelf Batch',
    pipeline: 'supply',
    status: 'proposal',
    type: 'nonprofit_software',
    amount: 95000,
    nextAction: 'Approve sample finish for Common Cupboard',
    personIndex: 4,
    orgIndex: 4,
    programmeSlug: 'common-cupboard',
  },
];

export const COMMONS_PATRON_SUBMISSIONS = [
  {
    key: 'demo_patron_sub_1',
    title: 'Nandini Menon — Founding Patron',
    email: 'nandini.menon.0@commons-demo.example.org',
    tier: 'founding',
    stage: 'approved',
    edition: '08/100',
    event: 'patron.approved',
    received: '2026-10-18',
    paid: 'Settled (demo relay)',
    code: 'PAT-2026-008',
    personIndex: 0,
  },
  {
    key: 'demo_patron_sub_2',
    title: 'Tariq Hussain — Builder Patron',
    email: 'tariq.hussain.5@commons-demo.example.org',
    tier: 'builder',
    stage: 'paid',
    edition: '24/25',
    event: 'patron.paid',
    received: '2026-10-20',
    paid: 'Active pledge',
    code: 'PAT-2026-024',
    personIndex: 5,
  },
  {
    key: 'demo_patron_sub_3',
    title: 'Deepa Chatterjee — Partner Patron',
    email: 'deepa.chatterjee.10@commons-demo.example.org',
    tier: 'partner',
    stage: 'applied',
    edition: '—',
    event: 'patron.applied',
    received: '2026-10-23',
    paid: 'Pending website relay',
    code: 'PAT-2026-041',
    personIndex: 10,
  },
];

export const COMMONS_FACTS = [
  {
    title: '[Commons Sample Fixture] Common Lab shared studio hours',
    programmeSlug: 'common-lab',
    category: 'operations',
    statement: 'Sample Riverbank Commons fixture: shared studio tables are open Tuesday through Saturday 09:30–18:00 IST with prior induction.',
    sourceRef: 'demo:commons-handbook',
    stale: false,
  },
  {
    title: '[Commons Sample Fixture] Tribal Habitat materials allowance',
    programmeSlug: 'tribal-habitat-workshop',
    category: 'programme',
    statement: 'Sample Riverbank Commons fixture: local bamboo, lime plaster, and natural pigment starter kits are provided on site.',
    sourceRef: 'demo:workshop-notes',
    stale: false,
  },
  {
    title: '[Commons Sample Fixture] Legacy 2025 transit shuttle note (stale)',
    programmeSlug: 'common-spaces-network',
    category: 'logistics',
    statement: 'Sample outdated fixture note: weekday shuttle timings should be re-verified before quoting to participants.',
    sourceRef: 'demo:archive-2025',
    stale: true,
  },
];
