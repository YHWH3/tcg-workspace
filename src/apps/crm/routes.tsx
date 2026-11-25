import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import type { CrmStatus } from '../../../shared/crm/contracts';
import { canManageCrmAccess } from '../../core/crmStatus';
import { ActivitiesView } from './activities/ActivitiesView';
import { ApplicationsView } from './applications/ApplicationsView';
import { ConversationsView } from './conversations/ConversationsView';
import { CrmHome } from './Home';
import { PatronsView } from './members/PatronsView';
import { OrganisationsView } from './organisations/OrganisationsView';
import { PeopleView } from './people/PeopleView';
import { PipelineView } from './pipeline/PipelineView';
import { ProgrammesView } from './programmes/ProgrammesView';
import { AccessSettings } from './settings/AccessSettings';
import { AutomationsSettings } from './settings/AutomationsSettings';
import { FactsSettings } from './settings/FactsSettings';
import { ProgrammesSettings } from './settings/ProgrammesSettings';

export function CrmRoutes({ status }: { status: CrmStatus }) {
  const { pathname } = useLocation();
  const canManage = canManageCrmAccess(status);

  useEffect(() => {
    if (pathname.startsWith('/crm/settings/facts')) {
      document.title = 'Verified knowledge — TCG CRM';
    } else if (pathname.startsWith('/crm/settings/automations')) {
      document.title = 'Automation recipes — TCG CRM';
    } else if (pathname.startsWith('/crm/settings/programmes')) {
      document.title = 'Programme profiles — TCG CRM';
    } else if (pathname.startsWith('/crm/settings')) {
      document.title = 'Accounts & capabilities — TCG CRM';
    } else if (pathname.startsWith('/crm/people')) {
      document.title = 'People — TCG CRM';
    } else if (pathname.startsWith('/crm/organisations')) {
      document.title = 'Organisations — TCG CRM';
    } else if (pathname.startsWith('/crm/programmes')) {
      document.title = 'Programmes — TCG CRM';
    } else if (pathname.startsWith('/crm/applications')) {
      document.title = 'Applications — TCG CRM';
    } else if (pathname.startsWith('/crm/activities')) {
      document.title = 'Activities — TCG CRM';
    } else if (pathname.startsWith('/crm/conversations')) {
      document.title = 'Conversations — TCG CRM';
    } else if (pathname.startsWith('/crm/pipelines')) {
      document.title = 'Pipelines — TCG CRM';
    } else if (pathname.startsWith('/crm/patrons')) {
      document.title = 'Patrons — TCG CRM';
    } else {
      document.title = 'Home — TCG CRM';
    }
  }, [pathname]);

  return (
    <Routes>
      <Route index element={<CrmHome status={status} />} />
      <Route path="people" element={<PeopleView status={status} />} />
      <Route path="people/:personId" element={<PeopleView status={status} />} />
      <Route path="organisations" element={<OrganisationsView status={status} />} />
      <Route path="organisations/:orgId" element={<OrganisationsView status={status} />} />
      <Route path="programmes" element={<ProgrammesView status={status} />} />
      <Route path="programmes/:slug" element={<ProgrammesView status={status} />} />
      <Route path="applications" element={<ApplicationsView status={status} />} />
      <Route path="applications/:applicationId" element={<ApplicationsView status={status} />} />
      <Route path="activities" element={<ActivitiesView status={status} />} />
      <Route path="activities/:activityId" element={<ActivitiesView status={status} />} />
      <Route path="conversations" element={<ConversationsView status={status} />} />
      <Route path="conversations/:conversationId" element={<ConversationsView status={status} />} />
      <Route path="pipelines" element={<PipelineView status={status} />} />
      <Route path="pipelines/:opportunityId" element={<PipelineView status={status} />} />
      <Route path="patrons" element={<PatronsView status={status} />} />
      <Route path="settings" element={<Navigate to={canManage ? '/crm/settings/access' : '/crm/settings/programmes'} replace />} />
      <Route
        path="settings/access"
        element={<AccessSettings status={status} canManage={canManage} />}
      />
      <Route
        path="settings/programmes"
        element={<ProgrammesSettings status={status} />}
      />
      <Route
        path="settings/automations"
        element={<AutomationsSettings status={status} />}
      />
      <Route
        path="settings/facts"
        element={<FactsSettings status={status} />}
      />
      <Route path="*" element={<Navigate to="/crm" replace />} />
    </Routes>
  );
}
