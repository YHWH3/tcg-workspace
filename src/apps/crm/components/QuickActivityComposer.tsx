import { useState } from 'react';
import { CalendarPlus } from 'lucide-react';
import { authStore } from '../../../core/auth';
import { link } from '../../../core/links';
import { createRecord, recordTitle } from '../../../core/records';
import { useStore } from '../../../core/store';
import { todayISO } from '../../../core/utils';
import { useCrmDatabases } from '../hooks/useCrmDatabases';

export interface QuickActivityTarget {
  id: string;
  label?: string;
  linkField: 'f_people' | 'f_orgs' | 'f_applications' | 'f_opportunities' | 'f_events';
}

export function QuickActivityComposer({
  initialTarget,
  onCreated,
  onCancel,
}: {
  initialTarget?: QuickActivityTarget;
  onCreated?: (activityId: string) => void;
  onCancel?: () => void;
}) {
  const me = useStore(authStore).user;
  const { activitiesDb, peopleDb, orgsDb, applicationsDb, tasks } = useCrmDatabases();

  const [title, setTitle] = useState('');
  const [activityType, setActivityType] = useState<'call' | 'meeting' | 'visit' | 'note' | 'follow_up'>('follow_up');
  const [whenLocal, setWhenLocal] = useState(() => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
  });
  const [summary, setSummary] = useState('');
  const [personId, setPersonId] = useState(initialTarget?.linkField === 'f_people' ? initialTarget.id : '');
  const [orgId, setOrgId] = useState(initialTarget?.linkField === 'f_orgs' ? initialTarget.id : '');
  const [appId, setAppId] = useState(initialTarget?.linkField === 'f_applications' ? initialTarget.id : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!activitiesDb) {
    return (
      <p className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3 text-xs text-[var(--crm-text-muted)]">
        Install the TCG Operating Pack in Settings or People to log activities.
      </p>
    );
  }

  const people = tasks.filter((t) => !t.deleted && peopleDb && t.boardId === peopleDb.id);
  const orgs = tasks.filter((t) => !t.deleted && orgsDb && t.boardId === orgsDb.id);
  const apps = tasks.filter((t) => !t.deleted && applicationsDb && t.boardId === applicationsDb.id);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const cleanTitle = title.trim() || `${activityType.replace('_', ' ')} follow-up`;
    const parsedDate = whenLocal ? new Date(whenLocal) : new Date();
    const isoWhen = Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString();
    const dueDate = isoWhen.slice(0, 10) || todayISO();

    setBusy(true);
    setError(null);
    try {
      const actId = await createRecord(activitiesDb.id, {
        title: cleanTitle,
        status: 'planned',
        extra: {
          p_f_type: activityType,
          p_f_when: isoWhen,
          p_f_due: dueDate,
          ...(me?.id ? { p_f_owner: me.id } : {}),
          p_f_done: false,
          ...(summary.trim() ? { p_f_summary: summary.trim() } : {}),
        },
      });

      const targetLinks: [string, string][] = [];
      if (initialTarget && initialTarget.linkField !== 'f_people' && initialTarget.linkField !== 'f_orgs' && initialTarget.linkField !== 'f_applications') {
        targetLinks.push([initialTarget.linkField, initialTarget.id]);
      }
      if (personId) targetLinks.push(['f_people', personId]);
      if (orgId) targetLinks.push(['f_orgs', orgId]);
      if (appId) targetLinks.push(['f_applications', appId]);

      await Promise.all(
        targetLinks.map(([fieldId, targetId]) =>
          link({ type: 'record', id: actId }, { type: 'record', id: targetId }, 'relation', fieldId),
        ),
      );

      setTitle('');
      setSummary('');
      onCreated?.(actId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not log activity.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3 text-xs">
      {error && (
        <p role="alert" className="rounded border px-3 py-2 text-[var(--crm-err-text)]" style={{ backgroundColor: 'var(--crm-err-bg)', borderColor: 'var(--crm-err-border)' }}>
          {error}
        </p>
      )}
      <div>
        <label htmlFor="crm-act-title" className="mb-1 block font-medium text-[var(--crm-text-muted)]">
          Title
        </label>
        <input
          id="crm-act-title"
          type="text"
          className="crm-input"
          placeholder="e.g. Call Asha about studio residency schedule"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="crm-act-type" className="mb-1 block font-medium text-[var(--crm-text-muted)]">
            Activity type
          </label>
          <select
            id="crm-act-type"
            className="crm-select"
            value={activityType}
            onChange={(e) => setActivityType(e.target.value as typeof activityType)}
          >
            <option value="follow_up">Follow-up</option>
            <option value="call">Call</option>
            <option value="meeting">Meeting</option>
            <option value="visit">Visit</option>
            <option value="note">Note</option>
          </select>
        </div>

        <div>
          <label htmlFor="crm-act-when" className="mb-1 block font-medium text-[var(--crm-text-muted)]">
            When (ISO date/time)
          </label>
          <input
            id="crm-act-when"
            type="datetime-local"
            className="crm-input"
            value={whenLocal}
            onChange={(e) => setWhenLocal(e.target.value)}
          />
        </div>
      </div>

      <div>
        <label htmlFor="crm-act-summary" className="mb-1 block font-medium text-[var(--crm-text-muted)]">
          Summary / notes
        </label>
        <textarea
          id="crm-act-summary"
          rows={2}
          className="crm-input !py-2"
          placeholder="Next action or key details…"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label htmlFor="crm-act-person" className="mb-1 block font-medium text-[var(--crm-text-muted)]">
            Person
          </label>
          <select id="crm-act-person" className="crm-select !min-h-10 !text-xs" value={personId} onChange={(e) => setPersonId(e.target.value)}>
            <option value="">None</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {recordTitle(p)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="crm-act-org" className="mb-1 block font-medium text-[var(--crm-text-muted)]">
            Organisation
          </label>
          <select id="crm-act-org" className="crm-select !min-h-10 !text-xs" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            <option value="">None</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {recordTitle(o)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="crm-act-app" className="mb-1 block font-medium text-[var(--crm-text-muted)]">
            Application
          </label>
          <select id="crm-act-app" className="crm-select !min-h-10 !text-xs" value={appId} onChange={(e) => setAppId(e.target.value)}>
            <option value="">None</option>
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {recordTitle(a)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2 pt-1">
        {onCancel && (
          <button type="button" onClick={onCancel} className="crm-btn-secondary">
            Cancel
          </button>
        )}
        <button type="submit" disabled={busy} className="crm-btn-primary">
          <CalendarPlus size={14} aria-hidden="true" />
          <span>{busy ? 'Saving…' : 'Log activity'}</span>
        </button>
      </div>
    </form>
  );
}
