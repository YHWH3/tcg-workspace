export const CRM_PROJECTION_PREFIX = '_crm_' as const;

export const isCrmProjectionKey = (key: string): boolean => key.startsWith(CRM_PROJECTION_PREFIX);

/** Constructed ONLY by worker/crm/commands.ts from a registered command's static key list. */
export interface ProjectionGrant {
  command: string;
  keys: ReadonlySet<string>;
}
