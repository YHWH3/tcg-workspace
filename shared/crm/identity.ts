import { z } from 'zod';
import { CRM_CURSOR_ID_PATTERN } from './contracts';

export const CRM_ENDPOINT_KINDS = ['email', 'phone', 'whatsapp', 'instagram', 'facebook'] as const;
export type CrmEndpointKind = (typeof CRM_ENDPOINT_KINDS)[number];
export const CrmEndpointKindSchema = z.enum(CRM_ENDPOINT_KINDS);

export const CRM_CONSENT_CHANNELS = ['email', 'whatsapp', 'instagram', 'facebook', 'any'] as const;
export type CrmConsentChannel = (typeof CRM_CONSENT_CHANNELS)[number];
export const CrmConsentChannelSchema = z.enum(CRM_CONSENT_CHANNELS);

export const CRM_CONSENT_SCOPES = ['transactional', 'updates', 'documentation', 'publication'] as const;
export type CrmConsentScope = (typeof CRM_CONSENT_SCOPES)[number];
export const CrmConsentScopeSchema = z.enum(CRM_CONSENT_SCOPES);

export const CRM_CONSENT_STATES = ['granted', 'withdrawn'] as const;
export type CrmConsentState = (typeof CRM_CONSENT_STATES)[number];

export const MAX_BACKFILL_BATCH = 50;
export const DUPLICATES_PAGE_LIMIT = 50;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9._]{0,62}[a-z0-9])?$/;

export function normalizeEmail(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned || cleaned.length > 254) return null;
  if (!EMAIL_RE.test(cleaned)) return null;
  return cleaned;
}

/**
 * Normalize phone numbers / WhatsApp numbers to E.164 format (`+` followed by 8..15 digits).
 * Accepts explicit international `+<digits>` or `00<digits>`. Ten-digit Indian local mobile
 * numbers `[6-9]\d{9}` (or `0[6-9]\d{9}`) normalize to `+91...`.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let compact = trimmed.replace(/[\s().-]+/g, '');
  if (compact.startsWith('00')) {
    compact = `+${compact.slice(2)}`;
  }
  if (compact.startsWith('+')) {
    const digits = compact.slice(1);
    if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
    return `+${digits}`;
  }
  if (/^0[6-9]\d{9}$/.test(compact)) {
    return `+91${compact.slice(1)}`;
  }
  if (/^[6-9]\d{9}$/.test(compact)) {
    return `+91${compact}`;
  }
  if (/^91[6-9]\d{9}$/.test(compact)) {
    return `+${compact}`;
  }
  return null;
}

export function normalizeHandle(raw: string): string | null {
  const cleaned = raw.trim().replace(/^@+/, '').toLowerCase();
  if (!cleaned || cleaned.length > 64) return null;
  if (!HANDLE_RE.test(cleaned)) return null;
  return cleaned;
}

export function normalizeEndpoint(kind: CrmEndpointKind, raw: string): string | null {
  switch (kind) {
    case 'email':
      return normalizeEmail(raw);
    case 'phone':
    case 'whatsapp':
      return normalizePhone(raw);
    case 'instagram':
    case 'facebook':
      return normalizeHandle(raw);
  }
}

export function canonicalPersonPair(idA: string, idB: string): [string, string] {
  return idA < idB ? [idA, idB] : [idB, idA];
}

export interface DuplicateCandidateSignal {
  personAId: string;
  personBId: string;
  reason: string;
  confidence: 'high' | 'medium';
}

export function computeNameCollisionPairs(
  people: readonly { id: string; title?: string | null; email?: string | null; phone?: string | null }[],
): DuplicateCandidateSignal[] {
  const byEmail = new Map<string, string[]>();
  const byPhone = new Map<string, string[]>();
  const byName = new Map<string, string[]>();

  for (const p of people) {
    const email = p.email ? normalizeEmail(p.email) : null;
    if (email) {
      const list = byEmail.get(email) ?? [];
      list.push(p.id);
      byEmail.set(email, list);
    }
    const phone = p.phone ? normalizePhone(p.phone) : null;
    if (phone) {
      const list = byPhone.get(phone) ?? [];
      list.push(p.id);
      byPhone.set(phone, list);
    }
    const nameKey = (p.title ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (nameKey && nameKey !== 'untitled' && nameKey.includes(' ')) {
      const list = byName.get(nameKey) ?? [];
      list.push(p.id);
      byName.set(nameKey, list);
    }
  }

  const pairMap = new Map<string, DuplicateCandidateSignal>();
  const addPairs = (ids: string[], reason: string, confidence: 'high' | 'medium') => {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = canonicalPersonPair(ids[i]!, ids[j]!);
        const key = `${a}\0${b}`;
        const existing = pairMap.get(key);
        if (!existing || (existing.confidence === 'medium' && confidence === 'high')) {
          pairMap.set(key, { personAId: a, personBId: b, reason, confidence });
        }
      }
    }
  };

  for (const [email, ids] of byEmail) {
    if (ids.length > 1) addPairs(ids, `Matching email: ${email}`, 'high');
  }
  for (const [phone, ids] of byPhone) {
    if (ids.length > 1) addPairs(ids, `Matching phone: ${phone}`, 'high');
  }
  for (const [name, ids] of byName) {
    if (ids.length > 1 && ids.length <= 6) addPairs(ids, `Identical full name: ${name}`, 'medium');
  }
  return [...pairMap.values()];
}

/* ---------- Command & Read Wire Schemas ---------- */

export const AddEndpointInputSchema = z.object({
  personId: z.string().min(1).max(128),
  kind: CrmEndpointKindSchema,
  value: z.string().min(1).max(320),
  source: z.string().min(1).max(120).optional(),
  makePrimary: z.boolean().optional(),
  verified: z.boolean().optional(),
}).strict();
export type AddEndpointInput = z.infer<typeof AddEndpointInputSchema>;

export const RetireEndpointInputSchema = z.object({
  endpointId: z.string().min(1).max(64),
  reason: z.string().max(240).optional(),
}).strict();
export type RetireEndpointInput = z.infer<typeof RetireEndpointInputSchema>;

export const SetPrimaryEndpointInputSchema = z.object({
  endpointId: z.string().min(1).max(64),
}).strict();
export type SetPrimaryEndpointInput = z.infer<typeof SetPrimaryEndpointInputSchema>;

export const RecordConsentInputSchema = z.object({
  personId: z.string().min(1).max(128),
  channel: CrmConsentChannelSchema,
  scope: CrmConsentScopeSchema,
  status: z.enum(CRM_CONSENT_STATES),
  source: z.string().min(1).max(120),
  evidenceRef: z.string().max(300).optional(),
}).strict();
export type RecordConsentInput = z.infer<typeof RecordConsentInputSchema>;

export const DismissDuplicateInputSchema = z.object({
  candidateId: z.string().min(1).max(64),
  note: z.string().max(500).optional(),
}).strict();
export type DismissDuplicateInput = z.infer<typeof DismissDuplicateInputSchema>;

export const BackfillEndpointsInputSchema = z.object({
  personIds: z.array(z.string().min(1).max(128)).max(MAX_BACKFILL_BATCH).optional(),
  limit: z.number().int().min(1).max(MAX_BACKFILL_BATCH).optional(),
  after: z.string().max(128).optional(),
  dryRun: z.boolean().optional(),
}).strict();
export type BackfillEndpointsInput = z.infer<typeof BackfillEndpointsInputSchema>;

export const CrmEndpointDtoSchema = z.object({
  id: z.string(),
  personId: z.string(),
  kind: CrmEndpointKindSchema,
  valueRaw: z.string(),
  valueNorm: z.string(),
  isPrimary: z.boolean(),
  verifiedAt: z.number().int().nullable(),
  retiredAt: z.number().int().nullable(),
  source: z.string(),
  createdBy: z.string(),
  createdAt: z.number().int(),
}).strict();
export type CrmEndpointDto = z.infer<typeof CrmEndpointDtoSchema>;

export const CrmConsentDtoSchema = z.object({
  id: z.string(),
  personId: z.string(),
  channel: CrmConsentChannelSchema,
  scope: CrmConsentScopeSchema,
  status: z.enum(CRM_CONSENT_STATES),
  source: z.string(),
  evidenceRef: z.string().nullable(),
  recordedBy: z.string(),
  recordedAt: z.number().int(),
}).strict();
export type CrmConsentDto = z.infer<typeof CrmConsentDtoSchema>;

export const DuplicateCandidateDtoSchema = z.object({
  id: z.string(),
  personAId: z.string(),
  personBId: z.string(),
  personATitle: z.string().nullable(),
  personBTitle: z.string().nullable(),
  reason: z.string(),
  confidence: z.enum(['high', 'medium']),
  state: z.enum(['open', 'dismissed', 'merged']),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
}).strict();
export type DuplicateCandidateDto = z.infer<typeof DuplicateCandidateDtoSchema>;

export const PersonDetailResponseSchema = z.object({
  personId: z.string(),
  rev: z.number().int().nonnegative(),
  endpoints: z.array(CrmEndpointDtoSchema),
  latestConsents: z.array(CrmConsentDtoSchema),
  consentHistory: z.array(CrmConsentDtoSchema),
  duplicateCandidates: z.array(DuplicateCandidateDtoSchema),
}).strict();
export type PersonDetailResponse = z.infer<typeof PersonDetailResponseSchema>;

export const DuplicatesPageResponseSchema = z.object({
  items: z.array(DuplicateCandidateDtoSchema),
  next: z.string().regex(CRM_CURSOR_ID_PATTERN).or(z.string().max(256)).nullable(),
  partial: z.boolean(),
}).strict();
export type DuplicatesPageResponse = z.infer<typeof DuplicatesPageResponseSchema>;
