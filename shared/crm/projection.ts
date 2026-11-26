export const CRM_PROJECTION_PREFIX = '_crm_' as const;

export type CrmProjectionKey<K extends string = string> = `${typeof CRM_PROJECTION_PREFIX}${K}`;

export function crmProjectionKey<K extends string>(suffix: K): CrmProjectionKey<K> {
  return `${CRM_PROJECTION_PREFIX}${suffix}`;
}

export const CRM_PROJECTION = {
  primaryEmail: crmProjectionKey('primary_email'),
  primaryPhone: crmProjectionKey('primary_phone'),
  endpointCount: crmProjectionKey('endpoint_count'),
  consentSummary: crmProjectionKey('consent_summary'),
  workArea: crmProjectionKey('work_area'),
  profileStatus: crmProjectionKey('profile_status'),
  programmeSlug: crmProjectionKey('programme_slug'),
  sourceSubmissionId: crmProjectionKey('source_submission_id'),
  submissionEmail: crmProjectionKey('submission_email'),
  convertedRecordId: crmProjectionKey('converted_record_id'),
  convertedKind: crmProjectionKey('converted_kind'),
  lastContactAt: crmProjectionKey('last_contact_at'),
  openConversations: crmProjectionKey('open_conversations'),
  lastOutboundAt: crmProjectionKey('last_outbound_at'),
  projectId: crmProjectionKey('project_id'),
  mergedInto: crmProjectionKey('merged_into'),
} as const;

export const isCrmProjectionKey = (key: string): boolean => key.startsWith(CRM_PROJECTION_PREFIX);

/** Constructed ONLY by worker/crm/commands.ts from a registered command's static key list. */
export interface ProjectionGrant {
  command: string;
  keys: ReadonlySet<string>;
}
