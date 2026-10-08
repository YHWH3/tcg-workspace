import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installViewportTracking } from './core/mobile';
import './index.css';

// Publishes --vvh/--vvo CSS vars + viewportStore (software keyboard resize).
installViewportTracking();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW registration failed:', e));
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
