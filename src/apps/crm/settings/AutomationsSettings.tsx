import { Link } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, CheckCircle2, ExternalLink, Lock, Sparkles } from 'lucide-react';
import { CRM_AUTOMATION_RECIPES, type CrmAutomationRecipeMeta } from '../../../../shared/crm/automationRecipes';
import type { CrmStatus } from '../../../../shared/crm/contracts';
import { authStore } from '../../../core/auth';
import { canManageCrmAccess } from '../../../core/crmStatus';
import { db, type LocalRow } from '../../../core/db';
import { useStore } from '../../../core/store';
import { mutate } from '../../../core/sync/engine';
import { useCrmDatabases } from '../hooks/useCrmDatabases';

export function AutomationsSettings({ status }: { status: CrmStatus }) {
  const me = useStore(authStore).user;
  const canManage = canManageCrmAccess(status);
  const canConfigureGlobal = status.owner || status.capabilities.some((c) => c.capability === 'crm.configure' && c.scope === '*');
  const { applicationsDb, activitiesDb } = useCrmDatabases();

  const existingAutos = useLiveQuery(
    () => db.collection('automations').toArray() as Promise<LocalRow[]>,
    [],
    [] as LocalRow[],
  );

  if (!canConfigureGlobal) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-10 sm:px-6">
        <section className="crm-panel p-6">
          <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--crm-surface-2)]">
            <Lock size={20} aria-hidden="true" />
          </div>
          <h1 className="text-lg font-semibold">You don't have access to this</h1>
          <p className="mt-2 text-sm text-[var(--crm-text-muted)]">
            Workspace-wide Configure (`crm.configure` at All) permission is required to manage CRM automation recipes.
          </p>
          <div className="mt-5">
            <Link to="/crm" className="crm-btn-primary">
              <ArrowLeft size={15} aria-hidden="true" />
              <span>Back to CRM Home</span>
            </Link>
          </div>
        </section>
      </div>
    );
  }

  const findRow = (recipe: CrmAutomationRecipeMeta) =>
    existingAutos.find((r) => !r.deleted && (r.id === recipe.stableRecordId || r.name === recipe.name));

  const installOrToggle = async (recipe: CrmAutomationRecipeMeta) => {
    const existing = findRow(recipe);
    if (existing) {
      await mutate('automations', existing.id, { enabled: !existing.enabled });
      return;
    }
    const config = recipe.build({
      applicationsBoardId: applicationsDb?.id,
      activitiesBoardId: activitiesDb?.id,
      defaultOwnerId: me?.id,
    });
    if (!config) return;
    await mutate('automations', recipe.stableRecordId, {
      ...config,
      deleted: false,
      createdBy: me?.id ?? null,
      createdAt: Date.now(),
    });
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-3 py-5 sm:px-6 sm:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-[var(--crm-text-muted)]">Settings</p>
          <h1 className="mt-0.5 text-xl font-semibold leading-tight">Automation recipes</h1>
          <p className="mt-1 text-xs text-[var(--crm-text-muted)]">
            These recipes write standard Workspace automations into `automations` and run through Workspace’s single automation engine.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <Link to="/crm/settings/access" className="crm-btn-secondary">
              Accounts & capabilities
            </Link>
          )}
          <Link to="/crm/settings/programmes" className="crm-btn-secondary">
            Programme profiles
          </Link>
          <Link to="/automations" className="crm-btn-secondary">
            <ExternalLink size={14} aria-hidden="true" />
            <span>Workspace Automations</span>
          </Link>
        </div>
      </header>

      <ul className="space-y-3">
        {CRM_AUTOMATION_RECIPES.map((recipe) => {
          const row = findRow(recipe);
          const ready = recipe.build({
            applicationsBoardId: applicationsDb?.id,
            activitiesBoardId: activitiesDb?.id,
          }) !== null;
          const active = Boolean(row?.enabled);

          return (
            <li key={recipe.id} className="crm-panel flex flex-wrap items-center justify-between gap-4 p-4">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Sparkles size={15} aria-hidden="true" className="text-[var(--crm-primary)]" />
                  <h2 className="text-sm font-semibold">{recipe.name}</h2>
                  {row && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                      style={{
                        backgroundColor: active ? 'var(--crm-ok-bg)' : 'var(--crm-surface-2)',
                        color: active ? 'var(--crm-ok-text)' : 'var(--crm-text-muted)',
                      }}
                    >
                      <CheckCircle2 size={11} aria-hidden="true" />
                      <span>{active ? 'Enabled' : 'Paused'}</span>
                    </span>
                  )}
                </div>
                <p className="text-xs text-[var(--crm-text-muted)]">{recipe.description}</p>
                {!ready && !row && (
                  <p className="text-[11px] text-[var(--crm-warn-text)]">
                    Requires TCG Operating Pack databases ({recipe.requiresBoards.join(', ')}).
                  </p>
                )}
              </div>

              <button
                type="button"
                disabled={!row && !ready}
                onClick={() => void installOrToggle(recipe)}
                className={active ? 'crm-btn-secondary' : 'crm-btn-primary'}
              >
                {row ? (active ? 'Pause' : 'Enable') : 'Install recipe'}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
