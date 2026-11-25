import { useEffect } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { initAuth } from './core/auth';
import { AccountSwitchGate, LegacyRecoveryGate } from './core/shell';
import { startSyncEngine } from './core/sync/engine';
import { initTheme } from './core/theme';
import { routes } from './routes';

const router = createBrowserRouter(routes);

let engineStarted = false;

export default function App() {
  useEffect(() => {
    initTheme();
    // Public share/form routes must never touch auth or the sync engine.
    if (location.pathname.startsWith('/s/') || location.pathname.startsWith('/f/')) return;
    void initAuth().then(() => {
      if (!engineStarted) {
        engineStarted = true;
        startSyncEngine();
      }
    });
  }, []);
  return (
    <>
      {/* Blocks every route when an account switch needs a decision (§12.3). */}
      <AccountSwitchGate />
      <LegacyRecoveryGate />
      <RouterProvider router={router} />
    </>
  );
}
