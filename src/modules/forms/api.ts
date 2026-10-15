import { api } from '../../core/api';

export interface FormFieldSpec {
  fieldKey: string;
  label: string;
  required?: boolean;
  help?: string;
  order?: number;
}

export interface FormRelSpec {
  fieldId: string;
  toId: string;
}

export interface FormConfig {
  databaseId: string;
  title: string;
  description?: string;
  fields: FormFieldSpec[];
  successMessage: string;
  enabled: boolean;
  notifyUserIds: string[];
  createRelations?: FormRelSpec[];
  peopleMatch?: { emailField: string };
  branding?: { intro?: string };
}

export interface FormToken {
  token: string;
  createdAt: number;
  revokedAt: number | null;
}

export function saveForm(id: string | undefined, cfg: FormConfig): Promise<{ id: string }> {
  return api('/api/forms', { method: 'POST', body: { ...(id ? { id } : {}), ...cfg } });
}

export function getForm(id: string): Promise<{ form: FormConfig; tokens: FormToken[] }> {
  return api(`/api/forms/${id}`);
}

export function mintToken(id: string): Promise<{ token: string }> {
  return api(`/api/forms/${id}/tokens`, { method: 'POST' });
}

export function revokeToken(token: string): Promise<{ ok: boolean }> {
  return api(`/api/forms/tokens/${token}`, { method: 'DELETE' });
}
