export const CRM_PROJECTION_PREFIX = '_crm_' as const;

export type CrmProjectionKey<K extends string = string> = `${typeof CRM_PROJECTION_PREFIX}${K}`;

export function crmProjectionKey<K extends string>(suffix: K): CrmProjectionKey<K> {
  return `${CRM_PROJECTION_PREFIX}${suffix}`;
}

export const isCrmProjectionKey = (key: string): boolean => key.startsWith(CRM_PROJECTION_PREFIX);

/** Constructed ONLY by worker/crm/commands.ts from a registered command's static key list. */
export interface ProjectionGrant {
  command: string;
  keys: ReadonlySet<string>;
}
