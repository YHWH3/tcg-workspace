/** Operational metadata only. Submission bodies and publish capabilities never enter this shape. */
export const FORM_PROCESSING_STATES = ['pending', 'processing', 'retryable_failure', 'rejected', 'accepted'] as const;
export type FormProcessingState = typeof FORM_PROCESSING_STATES[number];
export type FormProcessingCounts = Record<FormProcessingState, number>;
export type FormErrorClass = 'validation' | 'configuration' | 'unavailable' | 'processing' | 'attempt_limit' | 'unknown';

/** Map only server-defined codes; arbitrary stored error details stay private. */
export function formProcessingErrorClass(code: string | null): FormErrorClass {
  switch (code) {
    case 'validation': return 'validation';
    case 'form_configuration': case 'form_configuration_changed': return 'configuration';
    case 'unavailable': case 'submission_rejected': return 'unavailable';
    case 'processing_budget': case 'temporary_failure': return 'processing';
    case 'attempt_limit': return 'attempt_limit';
    default: return 'unknown';
  }
}

export interface FormOperationsFailure {
  submissionId: string;
  state: 'retryable_failure' | 'rejected';
  createdAt: number;
  attempts: number;
  retryAt: number | null;
  recovery: 'automatic' | 'stopped' | 'blocked';
  errorClass: FormErrorClass;
}
export interface FormOperationsFollowup {
  submissionId: string;
  recordId: string;
  title: string;
  url: string;
  createdAt: number;
}
export interface FormOperation {
  id: string;
  title: string;
  databaseId: string;
  databaseName: string;
  enabled: boolean;
  counts: { last7Days: FormProcessingCounts; last30Days: FormProcessingCounts };
  failures: FormOperationsFailure[];
  followups: FormOperationsFollowup[];
}
export interface FormOperationsReport {
  asOf: number;
  followupDays: number;
  forms: FormOperation[];
  partial: { forms: boolean; failures: boolean; followups: boolean };
  website: {
    available: boolean;
    partial: boolean;
    records: { id: string; title: string; status: string; url: string; createdAt: number }[];
  };
}
