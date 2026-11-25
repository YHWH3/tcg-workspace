import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  ArrowRight,
  Database,
  ExternalLink,
  FolderKanban,
  LayoutGrid,
  Table2,
} from 'lucide-react';
import { CRM_PIPELINES, type CrmPipelineId } from '../../../../shared/crm/pipelines';
import { CRM_PROJECTION } from '../../../../shared/crm/projection';
import type { CrmStatus } from '../../../../shared/crm/contracts';
import { recordTitle, stagesOf } from '../../../core/records';
import { useStore } from '../../../core/store';
import { mutate, onlineStore, syncNow } from '../../../core/sync/engine';
import { columnIdFor, type TaskRow } from '../../../modules/boards/api';
import {
  describeCommandError,
  generateCrmRequestId,
  handoffOpportunityToProject,
} from '../api';
import { CrmGrid, type CrmProjectionColumn } from '../components/CrmGrid';
import { RecordPanel } from '../components/RecordPanel';
import { StatusPill } from '../components/StatusPill';
import { useCrmDatabases } from '../hooks/useCrmDatabases';

const OPP_PROJECTION_COLS: CrmProjectionColumn[] = [
  { key: CRM_PROJECTION.projectId, label: 'Project handoff', format: 'text' },
];

export function PipelineView({ status }: { status: CrmStatus }) {
  const { opportunityId } = useParams();
  const navigate = useNavigate();
  const isOffline = !useStore(onlineStore);
  const {
    opportunitiesDb,
    projectsDb,
    tasks,
    needsPackInstall,
    installingPack,
    installError,
    installCrmPack,
  } = useCrmDatabases();

  const [pipelineFilter, setPipelineFilter] = useState<CrmPipelineId | 'all'>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'board'>('grid');
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const opportunities = useMemo(
    () =>
      tasks.filter(
        (t) =>
          !t.deleted &&
          opportunitiesDb &&
          t.boardId === opportunitiesDb.id &&
          !t.parentId &&
          (pipelineFilter === 'all' || t.p_f_pipeline === pipelineFilter),
      ),
    [tasks, opportunitiesDb, pipelineFilter],
  );

  const selectedRecord = opportunityId ? opportunities.find((r) => r.id === opportunityId) : undefined;
  const cols = opportunitiesDb ? stagesOf(opportunitiesDb) : [];

  const handleHandoff = async (opp: TaskRow) => {
    if (!projectsDb || isOffline || handoffBusy) return;
    setHandoffBusy(true);
    setHandoffError(null);
    try {
      const res = await handoffOpportunityToProject(
        { opportunityId: opp.id, projectsBoardId: projectsDb.id },
        { requestId: generateCrmRequestId() },
      );
      if (!res.ok) setHandoffError(describeCommandError(res));
      else await syncNow();
    } catch (err) {
      setHandoffError(describeCommandError(err));
    } finally {
      setHandoffBusy(false);
    }
  };

  if (!opportunitiesDb) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8 sm:px-6">
        <section className="crm-panel space-y-3 p-6">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--crm-primary-soft)] text-[var(--crm-primary)]">
            <Database size={20} aria-hidden="true" />
          </div>
          <h1 className="text-lg font-semibold">Pipelines database not installed yet</h1>
          <p className="text-sm text-[var(--crm-text-muted)]">
            Install the TCG Operating Pack to track Partnerships, Consulting, Production, Funding, and Supply opportunities.
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
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-3 py-4 sm:px-6 sm:py-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--crm-text-muted)]">Opportunities</p>
            <h1 className="mt-0.5 text-xl font-semibold leading-tight">Pipelines</h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div role="tablist" aria-label="Pipeline view layout" className="flex items-center gap-1 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-surface)] p-1">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'grid'}
                onClick={() => setViewMode('grid')}
                className={`inline-flex min-h-9 items-center gap-1.5 rounded px-2.5 py-1 text-xs font-semibold ${
                  viewMode === 'grid'
                    ? 'bg-[var(--crm-primary)] text-[var(--crm-primary-contrast)]'
                    : 'text-[var(--crm-text-muted)]'
                }`}
              >
                <Table2 size={13} aria-hidden="true" />
                <span>Grid</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'board'}
                onClick={() => setViewMode('board')}
                className={`inline-flex min-h-9 items-center gap-1.5 rounded px-2.5 py-1 text-xs font-semibold ${
                  viewMode === 'board'
                    ? 'bg-[var(--crm-primary)] text-[var(--crm-primary-contrast)]'
                    : 'text-[var(--crm-text-muted)]'
                }`}
              >
                <LayoutGrid size={13} aria-hidden="true" />
                <span>Board</span>
              </button>
            </div>
          </div>
        </header>

        <div role="tablist" aria-label="Pipeline selector" className="flex flex-wrap gap-1.5">
          <button
            type="button"
            role="tab"
            aria-selected={pipelineFilter === 'all'}
            onClick={() => setPipelineFilter('all')}
            className={`min-h-10 rounded-full px-3 py-1.5 text-xs font-semibold ${
              pipelineFilter === 'all'
                ? 'bg-[var(--crm-primary)] text-[var(--crm-primary-contrast)]'
                : 'border border-[var(--crm-border)] bg-[var(--crm-surface)] text-[var(--crm-text-muted)]'
            }`}
          >
            All pipelines
          </button>
          {CRM_PIPELINES.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={pipelineFilter === p.id}
              onClick={() => setPipelineFilter(p.id)}
              className={`min-h-10 rounded-full px-3 py-1.5 text-xs font-semibold ${
                pipelineFilter === p.id
                  ? 'bg-[var(--crm-primary)] text-[var(--crm-primary-contrast)]'
                  : 'border border-[var(--crm-border)] bg-[var(--crm-surface)] text-[var(--crm-text-muted)]'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {handoffError && (
          <div role="alert" className="rounded-lg border px-3 py-2 text-xs" style={{ backgroundColor: 'var(--crm-err-bg)', color: 'var(--crm-err-text)', borderColor: 'var(--crm-err-border)' }}>
            {handoffError}
          </div>
        )}

        {viewMode === 'grid' ? (
          <CrmGrid
            board={opportunitiesDb}
            records={opportunities}
            projectionColumns={OPP_PROJECTION_COLS}
            selectedRecordId={selectedRecord?.id ?? null}
            onSelectRecord={(id) => navigate(`/crm/pipelines/${id}`)}
            defaultGroupBy="status"
            emptyTitle="No opportunities in this pipeline yet"
            emptyBody="Use + Add below or convert an application to begin tracking partnerships, grants, consulting, production, or supply deals."
          />
        ) : (
          <div
            role="region"
            aria-label="Pipeline stages"
            tabIndex={0}
            className="min-h-0 flex-1 overflow-x-auto pb-2"
          >
            <div className="flex gap-3 min-w-max">
              {cols.map((stage) => {
                const cards = opportunities.filter((r) => columnIdFor(r, opportunitiesDb) === stage.id);
                return (
                  <section
                    key={stage.id}
                    aria-label={`Stage ${stage.name}`}
                    className="crm-panel flex w-72 shrink-0 flex-col overflow-hidden"
                  >
                    <header className="flex items-center justify-between gap-2 border-b border-[var(--crm-border)] bg-[var(--crm-bg)] px-3 py-2">
                      <StatusPill label={stage.name} color={stage.color} />
                      <span className="crm-tabular text-xs font-medium text-[var(--crm-text-muted)]">
                        {cards.length}
                      </span>
                    </header>
                    <div className="space-y-2 p-2.5 text-xs">
                      {cards.length === 0 ? (
                        <p className="py-3 text-center text-[var(--crm-text-muted)]">Empty</p>
                      ) : (
                        cards.map((card) => {
                          const handedProjectId =
                            typeof card[CRM_PROJECTION.projectId] === 'string'
                              ? String(card[CRM_PROJECTION.projectId])
                              : null;
                          return (
                            <article key={card.id} className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-surface)] p-2.5 space-y-2">
                              <button
                                type="button"
                                onClick={() => navigate(`/crm/pipelines/${card.id}`)}
                                className="text-left text-sm font-semibold hover:underline"
                              >
                                {recordTitle(card)}
                              </button>
                              {typeof card.p_f_next_action === 'string' && card.p_f_next_action && (
                                <p className="text-[11px] text-[var(--crm-text-muted)]">
                                  Next: {card.p_f_next_action}
                                </p>
                              )}
                              <div>
                                <label htmlFor={`stage-move-${card.id}`} className="sr-only">
                                  Move {recordTitle(card)} stage
                                </label>
                                <select
                                  id={`stage-move-${card.id}`}
                                  className="crm-select !min-h-11 !text-xs"
                                  value={columnIdFor(card, opportunitiesDb)}
                                  onChange={(e) => void mutate('tasks', card.id, { status: e.target.value })}
                                >
                                  {cols.map((opt) => (
                                    <option key={opt.id} value={opt.id}>
                                      Move to: {opt.name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              {handedProjectId && projectsDb && (
                                <Link
                                  to={`/boards/${projectsDb.id}/tasks/${handedProjectId}`}
                                  className="inline-flex items-center gap-1 font-medium text-[var(--crm-primary)] hover:underline"
                                >
                                  <ExternalLink size={11} aria-hidden="true" />
                                  <span>Linked Project</span>
                                </Link>
                              )}
                            </article>
                          );
                        })
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {selectedRecord && (
        <RecordPanel
          board={opportunitiesDb}
          record={selectedRecord}
          entityKind="opportunity"
          onClose={() => navigate('/crm/pipelines')}
          headerActions={
            selectedRecord[CRM_PROJECTION.projectId] && projectsDb ? (
              <Link
                to={`/boards/${projectsDb.id}/tasks/${String(selectedRecord[CRM_PROJECTION.projectId])}`}
                className="crm-btn-secondary !min-h-9 !px-2.5 !py-1 !text-xs"
              >
                <FolderKanban size={13} aria-hidden="true" />
                <span>Project</span>
              </Link>
            ) : (
              <button
                type="button"
                disabled={isOffline || handoffBusy || !projectsDb}
                onClick={() => void handleHandoff(selectedRecord)}
                className="crm-btn-primary !min-h-9 !px-2.5 !py-1 !text-xs"
              >
                <ArrowRight size={13} aria-hidden="true" />
                <span>{handoffBusy ? 'Creating…' : 'Hand off'}</span>
              </button>
            )
          }
        />
      )}
    </div>
  );
}
