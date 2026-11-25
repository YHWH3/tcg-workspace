import { useNavigate, useParams } from 'react-router';
import { Building2, Database } from 'lucide-react';
import type { CrmStatus } from '../../../../shared/crm/contracts';
import { useDbRecords, type FieldKey } from '../../../core/records';
import { useStore } from '../../../core/store';
import { onlineStore } from '../../../core/sync/engine';
import { CrmGrid } from '../components/CrmGrid';
import { RecordPanel } from '../components/RecordPanel';
import { useCrmDatabases } from '../hooks/useCrmDatabases';

export function OrganisationsView({ status: _status }: { status: CrmStatus }) {
  const { orgId } = useParams();
  const navigate = useNavigate();
  const isOffline = !useStore(onlineStore);
  const { orgsDb, installingPack, installError, installCrmPack } = useCrmDatabases();
  const records = useDbRecords(orgsDb?.id).filter((r) => !r.parentId);
  const selectedRecord = orgId ? records.find((r) => r.id === orgId) : undefined;

  if (!orgsDb) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8">
        <section className="crm-panel p-6 space-y-3">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--crm-primary-soft)] text-[var(--crm-primary)]">
            <Building2 size={20} aria-hidden="true" />
          </div>
          <h1 className="text-lg font-semibold">Organisations database is not installed yet</h1>
          <p className="text-sm text-[var(--crm-text-muted)]">
            Initialise the TCG CRM databases to manage partner organisations, institutions, and affiliations.
          </p>
          {installError && (
            <p role="alert" className="text-xs text-[var(--crm-err-text)]">
              {installError}
            </p>
          )}
          <div>
            <button
              type="button"
              disabled={installingPack || isOffline}
              onClick={() => void installCrmPack()}
              className="crm-btn-primary"
            >
              <Database size={15} aria-hidden="true" />
              <span>{installingPack ? 'Initialising…' : 'Initialise TCG CRM databases'}</span>
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <header className="mb-4">
          <h1 className="text-xl font-semibold leading-tight">Organisations</h1>
          <p className="mt-0.5 text-xs text-[var(--crm-text-muted)]">
            Schools, collectives, space operators, studios, makers and partners.
          </p>
        </header>

        <CrmGrid
          board={orgsDb}
          records={records}
          selectedRecordId={selectedRecord?.id ?? null}
          onSelectRecord={(id) => navigate(`/crm/organisations/${id}`)}
          defaultGroupBy={'p_f_partnership' as FieldKey}
          emptyTitle="No organisations recorded yet"
          emptyBody="Add your first organisation to track partners, funders, venues and maker collectives."
        />
      </div>

      {selectedRecord && (
        <RecordPanel
          board={orgsDb}
          record={selectedRecord}
          entityKind="organisation"
          onClose={() => navigate('/crm/organisations')}
        />
      )}
    </div>
  );
}
