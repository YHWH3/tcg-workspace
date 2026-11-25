import { WEBSITE_INBOX_ID } from '../websiteInbox';
import type { AutomationConfig } from '../automations';

export interface CrmAutomationRecipeMeta {
  id: string;
  stableRecordId: string;
  name: string;
  description: string;
  requiresBoards: ('applications' | 'activities')[];
  build: (ids: {
    applicationsBoardId?: string;
    activitiesBoardId?: string;
    defaultOwnerId?: string;
  }) => AutomationConfig | null;
}

/**
 * Pure builders producing Workspace `AutomationConfig` rows (`automations` collection).
 * Executed exclusively by Workspace's existing automation engine (`worker/automations.ts`).
 */
export const CRM_AUTOMATION_RECIPES: readonly CrmAutomationRecipeMeta[] = [
  {
    id: 'crm_enquiry_followup',
    stableRecordId: 'auto_crm_enquiry_followup',
    name: 'Website enquiry -> follow-up activity',
    description: 'Creates a planned Follow-up activity whenever a new submission lands in Website inbox.',
    requiresBoards: ['activities'],
    build: ({ activitiesBoardId }) => {
      if (!activitiesBoardId) return null;
      return {
        databaseId: WEBSITE_INBOX_ID,
        name: 'Website enquiry -> follow-up activity',
        enabled: true,
        trigger: { kind: 'record.created', databaseId: WEBSITE_INBOX_ID },
        conditions: [],
        actions: [
          {
            type: 'create_record',
            databaseId: activitiesBoardId,
            title: 'Follow up: {{title}}',
            fields: {
              status: 'planned',
              p_f_type: 'follow_up',
            },
            link: { fieldId: null },
          },
        ],
      };
    },
  },
  {
    id: 'crm_application_approval',
    stableRecordId: 'auto_crm_application_approval',
    name: 'Application stage -> approval request',
    description: 'Requests a Workspace approval from the assigned Reviewer when an application enters In review.',
    requiresBoards: ['applications'],
    build: ({ applicationsBoardId }) => {
      if (!applicationsBoardId) return null;
      return {
        databaseId: applicationsBoardId,
        name: 'Application stage -> approval request',
        enabled: true,
        trigger: {
          kind: 'stage_changed',
          to: 'in_review',
          databaseId: applicationsBoardId,
        },
        conditions: [],
        actions: [
          {
            type: 'request_approval',
            approverField: 'f_reviewer',
            note: 'CRM programme review gate for {{title}}',
          },
        ],
      };
    },
  },
  {
    id: 'crm_followup_reminder',
    stableRecordId: 'auto_crm_followup_reminder',
    name: 'Follow-up due reminder',
    description: 'Notifies the activity Owner on the Due date when an activity has not been marked Done.',
    requiresBoards: ['activities'],
    build: ({ activitiesBoardId }) => {
      if (!activitiesBoardId) return null;
      return {
        databaseId: activitiesBoardId,
        name: 'Follow-up due reminder',
        enabled: true,
        trigger: {
          kind: 'date_offset',
          dateKey: 'p_f_due',
          days: 0,
          databaseId: activitiesBoardId,
        },
        conditions: [{ key: 'p_f_done', op: 'unchecked' }],
        actions: [
          {
            type: 'notify',
            userField: 'f_owner',
            message: 'Follow-up due today: {{title}}',
          },
        ],
      };
    },
  },
] as const;
