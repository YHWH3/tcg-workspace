import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import type { CrmStatus } from '../../../shared/crm/contracts';
import { canManageCrmAccess } from '../../core/crmStatus';
import { CrmHome } from './Home';
import { OrganisationsView } from './organisations/OrganisationsView';
import { PeopleView } from './people/PeopleView';
import { AccessSettings } from './settings/AccessSettings';

export function CrmRoutes({ status }: { status: CrmStatus }) {
  const { pathname } = useLocation();
  const canManage = canManageCrmAccess(status);

  useEffect(() => {
    if (pathname.startsWith('/crm/settings')) {
      document.title = 'Accounts & capabilities — TCG CRM';
    } else if (pathname.startsWith('/crm/people')) {
      document.title = 'People — TCG CRM';
    } else if (pathname.startsWith('/crm/organisations')) {
      document.title = 'Organisations — TCG CRM';
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
      <Route path="settings" element={<Navigate to="/crm/settings/access" replace />} />
      <Route
        path="settings/access"
        element={<AccessSettings status={status} canManage={canManage} />}
      />
      <Route path="*" element={<Navigate to="/crm" replace />} />
    </Routes>
  );
}
