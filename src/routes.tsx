import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, useLocation, type RouteObject } from 'react-router';
import { AiReview, AiUndo, AiWorkspace } from './core/AiWorkspace';
import { AssistantPage } from './core/assistant/AssistantPanel';
import { AccessBarrier } from './core/AccessBarrier';
import { authStore } from './core/auth';
import { AuthScreen } from './core/authscreen';
import { GuestJoin } from './core/GuestJoin';
import { stripNotionPrefix } from './core/notionPath';
import { SettingsPage } from './core/settings';
import { Shell } from './core/shell';
import { SpaceHome } from './core/SpaceHome';
import { useStore } from './core/store';
import { Spinner } from './core/ui';
import { modules } from './modules';
import { FormView } from './public/FormView';
import { PublicCanvas } from './public/PublicCanvas';
import { PublicView } from './public/PublicView';

const CrmShell = lazy(() => import('./apps/crm/CrmShell'));

function Loading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size={20} />
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useStore(authStore);
  if (status === 'loading') return <Loading />;
  if (status === 'unauthed') return <AuthScreen />;
  return <AccessBarrier>{children}</AccessBarrier>;
}

/** `/notion/...` (the website's redirect) → the same route at the app root. */
function NotionPrefix() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={{ pathname: stripNotionPrefix(pathname), search, hash }} replace />;
}

export const routes: RouteObject[] = [
  { path: 'join/:token', element: <GuestJoin /> },
  // Public share links live entirely outside the auth shell — no sync engine,
  // no login redirect.
  { path: 's/canvas/:token', element: <PublicCanvas /> },
  { path: 's/:token', element: <PublicView /> },
  { path: 's/:token/:pageId', element: <PublicView /> },
  { path: 'f/:token', element: <FormView /> },
  { path: 'notion', element: <NotionPrefix /> },
  { path: 'notion/*', element: <NotionPrefix /> },
  {
    element: (
      <RequireAuth>
        <Shell />
      </RequireAuth>
    ),
    children: [
      ...modules.flatMap((m) => m.routes),
      { path: 'ai', element: <AiWorkspace /> },
      { path: 'ai/chat', element: <AssistantPage /> },
      { path: 'ai/chat/:conversationId', element: <AssistantPage /> },
      { path: 'ai/review/:previewId', element: <AiReview /> },
      { path: 'ai/undo/:changesetId', element: <AiUndo /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'spaces/:spaceId', element: <SpaceHome /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
  {
    path: 'crm/*',
    element: (
      <RequireAuth>
        <Suspense fallback={<Loading />}>
          <CrmShell />
        </Suspense>
      </RequireAuth>
    ),
  },
];
