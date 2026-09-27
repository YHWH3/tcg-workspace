import { useEffect } from 'react';
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router';
import { authStore, initAuth } from './core/auth';
import { AuthScreen } from './core/authscreen';
import { SettingsPage } from './core/settings';
import { Shell } from './core/shell';
import { Spinner } from './core/ui';
import { startSyncEngine } from './core/sync/engine';
import { initTheme } from './core/theme';
import { useStore } from './core/store';
import { modules } from './modules';
import { PublicView } from './public/PublicView';

function Loading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size={20} />
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status } = useStore(authStore);
  if (status === 'loading') return <Loading />;
  if (status === 'unauthed') return <AuthScreen />;
  return <>{children}</>;
}

const router = createBrowserRouter([
  // Public share links live entirely outside the auth shell — no sync engine,
  // no login redirect.
  { path: 's/:token', element: <PublicView /> },
  { path: 's/:token/:pageId', element: <PublicView /> },
  {
    element: (
      <RequireAuth>
        <Shell />
      </RequireAuth>
    ),
    children: [
      ...modules.flatMap((m) => m.routes),
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

let engineStarted = false;

export default function App() {
  useEffect(() => {
    initTheme();
    // Public share routes must never touch auth or the sync engine.
    if (location.pathname.startsWith('/s/')) return;
    void initAuth().then(() => {
      if (!engineStarted) {
        engineStarted = true;
        startSyncEngine();
      }
    });
  }, []);
  return <RouterProvider router={router} />;
}
