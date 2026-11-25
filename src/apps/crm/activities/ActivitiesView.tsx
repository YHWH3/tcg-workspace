import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { CalendarClock, CheckCircle2, Database, ExternalLink, Plus } from 'lucide-react';
import type { CrmStatus } from '../../../../shared/crm/contracts';
import { recordTitle } from '../../../core/records';
import { mutate } from '../../../core/sync/engine';
import { AdaptiveDialog } from '../../../core/ui';
import { todayISO } from '../../../core/utils';
import type { TaskRow } from '../../../modules/boards/api';
import { QuickActivityComposer } from '../components/QuickActivityComposer';
import { RecordPanel } from '../components/RecordPanel';
import { StatusPill } from '../components/StatusPill';
import { useCrmDatabases } from '../hooks/useCrmDatabases';

type ActivityBucket = 'overdue' | 'today' | 'upcoming' | 'done';

function bucketForActivity(rec: TaskRow, today: string): ActivityBucket {
  if (rec.status === 'done' || rec.p_f_done === true) return 'done';
  const rawWhen =
    (typeof rec.p_f_when === 'string' && rec.p_f_when.slice(0, 10)) ||
    (typeof rec.p_f_due === 'string' && rec.p_f_due.slice(0, 10)) ||
    '';
  if (!rawWhen) return 'today';
  if (rawWhen < today) return 'overdue';
  if (rawWhen === today) return 'today';
  return 'upcoming';
}

export function ActivitiesView({ status }: { status: CrmStatus }) {
  const { activityId } = useParams();
  const navigate = useNavigate();
  const { activitiesDb, tasks, needsPackInstall, installingPack, installError, installCrmPack } = useCrmDatabases();
  const [composerOpen, setComposerOpen] = useState(false);

  const today = todayISO();
  const allActivities = useMemo(
    () => tasks.filter((t) => !t.deleted && activitiesDb && t.boardId === activitiesDb.id && !t.parentId),
    [tasks, activitiesDb],
  );

  const grouped = useMemo(() => {
    const groups: Record<ActivityBucket, TaskRow[]> = { overdue: [], today: [], upcoming: [], done: [] };
    for (const r of allActivities) {
      groups[bucketForActivity(r, today)].push(r);
    }
    return [
      { id: 'overdue' as const, label: 'Overdue', color: '#e5484d', rows: groups.overdue },
      { id: 'today' as const, label: 'Today', color: '#e5a000', rows: groups.today },
      { id: 'upcoming' as const, label: 'Upcoming', color: '#0091ff', rows: groups.upcoming },
      { id: 'done' as const, label: 'Done', color: '#30a46c', rows: groups.done },
    ];
  }, [allActivities, today]);

  const selectedRecord = activityId ? allActivities.find((r) => r.id === activityId) : undefined;

  const markDone = (rec: TaskRow) => {
    const nextDone = !(rec.status === 'done' || rec.p_f_done === true);
    void mutate('tasks', rec.id, {
      status: nextDone ? 'done' : 'planned',
      p_f_done: nextDone,
    });
  };

  const rescheduleOneDay = (rec: TaskRow) => {
    const baseStr =
      (typeof rec.p_f_when === 'string' && rec.p_f_when.slice(0, 10)) ||
      (typeof rec.p_f_due === 'string' && rec.p_f_due.slice(0, 10)) ||
      today;
    const baseDate = new Date(`${baseStr}T10:00:00Z`);
    if (Number.isNaN(baseDate.getTime())) return;
    baseDate.setUTCDate(baseDate.getUTCDate() + 1);
    const nextIso = baseDate.toISOString();
    void mutate('tasks', rec.id, {
      p_f_when: nextIso,
      p_f_due: nextIso.slice(0, 10),
    });
  };

  if (!activitiesDb) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8 sm:px-6">
        <section className="crm-panel space-y-3 p-6">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--crm-primary-soft)] text-[var(--crm-primary)]">
            <Database size={20} aria-hidden="true" />
          </div>
          <h1 className="text-lg font-semibold">Activities database not installed yet</h1>
          <p className="text-sm text-[var(--crm-text-muted)]">
            Install the TCG Operating Pack to log calls, meetings, notes, and follow-up reminders.
          </p>
          {installError && <p role="alert" className="text-xs text-[var(--crm-err-text)]">{installError}</p>}
          {needsPackInstall && (status.owner || status.capabilities.some((c) => c.capability === 'crm.configure')) && (
            <button type="button" onClick={() => void installCrmPack()} disabled={installingPack} className="crm-btn-primary">
              {installingPack ? 'Installing TCG pack…' : 'Install TCG pack'}
            </button>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4 sm:px-6 sm:py-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--crm-text-muted)]">Follow-ups</p>
            <h1 className="mt-0.5 text-xl font-semibold leading-tight">Activities</h1>
            <p className="mt-1 text-xs text-[var(--crm-text-muted)]">
              Track calls, meetings, visits, notes, and follow-up dates across People, Organisations, and Applications.
            </p>
          </div>
          <button type="button" onClick={() => setComposerOpen(true)} className="crm-btn-primary">
            <Plus size={15} aria-hidden="true" />
            <span>Log activity</span>
          </button>
        </header>

        <div className="space-y-4">
          {grouped.map((grp) => (
            <section key={grp.id} aria-labelledby={`act-grp-${grp.id}`} className="crm-panel overflow-hidden">
              <div className="flex items-center justify-between gap-2 border-b border-[var(--crm-border)] bg-[var(--crm-bg)] px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <StatusPill label={grp.label} color={grp.color} />
                  <h2 id={`act-grp-${grp.id}`} className="sr-only">
                    {grp.label}
                  </h2>
                </div>
                <span className="crm-tabular text-xs font-medium text-[var(--crm-text-muted)]">
                  {grp.rows.length} item{grp.rows.length === 1 ? '' : 's'}
                </span>
              </div>
              {grp.rows.length === 0 ? (
                <p className="px-4 py-3 text-xs text-[var(--crm-text-muted)]">Nothing in {grp.label.toLowerCase()}.</p>
              ) : (
                <ul className="divide-y divide-[var(--crm-border)]">
                  {grp.rows.map((rec) => {
                    const isDone = grp.id === 'done';
                    const whenDisplay =
                      typeof rec.p_f_when === 'string' && rec.p_f_when
                        ? rec.p_f_when.slice(0, 16).replace('T', ' ')
                        : typeof rec.p_f_due === 'string' && rec.p_f_due
                          ? rec.p_f_due
                          : 'Unscheduled';
                    return (
                      <li key={rec.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs">
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <button
                            type="button"
                            onClick={() => navigate(`/crm/activities/${rec.id}`)}
                            className="text-left text-sm font-semibold hover:underline"
                          >
                            {recordTitle(rec)}
                          </button>
                          <p className="text-[var(--crm-text-muted)]">
                            {typeof rec.p_f_type === 'string' ? rec.p_f_type.replace('_', ' ') : 'Activity'} · {whenDisplay}
                          </p>
                          {typeof rec.p_f_summary === 'string' && rec.p_f_summary && (
                            <p className="line-clamp-2 text-[var(--crm-text-muted)]">{rec.p_f_summary}</p>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => markDone(rec)}
                            className="crm-btn-secondary !min-h-11 !px-3 !py-1 !text-xs"
                          >
                            <CheckCircle2 size={14} aria-hidden="true" />
                            <span>{isDone ? 'Reopen' : 'Mark done'}</span>
                          </button>
                          {!isDone && (
                            <button
                              type="button"
                              onClick={() => rescheduleOneDay(rec)}
                              className="crm-btn-secondary !min-h-11 !px-3 !py-1 !text-xs"
                            >
                              <CalendarClock size={14} aria-hidden="true" />
                              <span>+1 day</span>
                            </button>
                          )}
                          <Link
                            to={`/boards/${activitiesDb.id}/tasks/${rec.id}`}
                            aria-label={`Open ${recordTitle(rec)} in Workspace`}
                            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--crm-text-muted)] hover:bg-[var(--crm-surface-2)] hover:text-[var(--crm-text)]"
                          >
                            <ExternalLink size={14} aria-hidden="true" />
                          </Link>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ))}
        </div>
      </div>

      {selectedRecord && (
        <RecordPanel
          board={activitiesDb}
          record={selectedRecord}
          entityKind="activity"
          onClose={() => navigate('/crm/activities')}
        />
      )}

      {composerOpen && (
        <AdaptiveDialog title="Log CRM activity" onClose={() => setComposerOpen(false)}>
          <div data-app="crm">
            <QuickActivityComposer
              onCreated={() => setComposerOpen(false)}
              onCancel={() => setComposerOpen(false)}
            />
          </div>
        </AdaptiveDialog>
      )}
    </div>
  );
}
