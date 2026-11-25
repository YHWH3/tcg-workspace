import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import type { CrmStatus } from '../../../shared/crm/contracts';
import { canManageCrmAccess } from '../../core/crmStatus';
import { ApplicationsView } from './applications/ApplicationsView';
import { CrmHome } from './Home';
import { OrganisationsView } from './organisations/OrganisationsView';
import { PeopleView } from './people/PeopleView';
import { ProgrammesView } from './programmes/ProgrammesView';
import { AccessSettings } from './settings/AccessSettings';
import { ProgrammesSettings } from './settings/ProgrammesSettings';

export function CrmRoutes({ status }: { status: CrmStatus }) {
  const { pathname } = useLocation();
  const canManage = canManageCrmAccess(status);

  useEffect(() => {
    if (pathname.startsWith('/crm/settings/programmes')) {
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
      <Route path="settings" element={<Navigate to={canManage ? '/crm/settings/access' : '/crm/settings/programmes'} replace />} />
      <Route
        path="settings/access"
        element={<AccessSettings status={status} canManage={canManage} />}
      />
      <Route
        path="settings/programmes"
        element={<ProgrammesSettings status={status} />}
      />
      <Route path="*" element={<Navigate to="/crm" replace />} />
    </Routes>
  );
}
