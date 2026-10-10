import { useEffect, useState } from 'react';
import { createStore, useStore } from './store';

/* Layout capability helpers (platform spec §4). One breakpoint vocabulary,
 * shared with index.css and expressed in rem so user font scaling changes
 * layout together with typography: compact <48rem, medium 48–74.99rem,
 * expanded ≥75rem. Keep this file in core/ (never import it from modules) —
 * importing it from shell would re-create a module↔core cycle.
 */

export type LayoutMode = 'compact' | 'medium' | 'expanded';

function layoutMode(): LayoutMode {
  if (typeof matchMedia === 'undefined') return 'expanded';
  if (matchMedia('(max-width: 47.99rem)').matches) return 'compact';
  if (matchMedia('(max-width: 74.99rem)').matches) return 'medium';
  return 'expanded';
}

export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(layoutMode);
  useEffect(() => {
    const mqs = [matchMedia('(max-width: 47.99rem)'), matchMedia('(max-width: 74.99rem)')];
    const fn = () => setMode(layoutMode());
    for (const mq of mqs) mq.addEventListener('change', fn);
    return () => {
      for (const mq of mqs) mq.removeEventListener('change', fn);
    };
  }, []);
  return mode;
}

export function useIsMobile(): boolean {
  return useLayoutMode() === 'compact';
}

/* ---------------- visual viewport (platform spec §5) ---------------- */

export interface VisualViewportState {
  /** Current visual height — drops when the software keyboard opens. */
  height: number;
  width: number;
  /** How far the visual viewport is scrolled down within the layout viewport. */
  offsetTop: number;
  scale: number;
  /** Software keyboard is probably covering part of the layout viewport. */
  keyboardOpen: boolean;
}

const initialViewport = (): VisualViewportState => {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  const height = vv?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 0);
  const width = vv?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 0);
  return { height, width, offsetTop: vv?.offsetTop ?? 0, scale: vv?.scale ?? 1, keyboardOpen: false };
};

export const viewportStore = createStore<VisualViewportState>(initialViewport());

export function useVisualViewport(): VisualViewportState {
  return useStore(viewportStore);
}

let installed = false;

/**
 * Track the visual viewport once per app load: publishes viewportStore and
 * the CSS vars `--vvh` (visible height) / `--vvo` (top offset) consumed by
 * overlays and the shell so content stays inside the keyboard-shrunk region
 * instead of relying on a fixed keyboard offset.
 *
 * Pinch zoom (scale > ~1) deliberately resets the vars to the full window —
 * a pinch is not a keyboard and must not disturb browser zoom.
 */
export function installViewportTracking(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const update = () => {
    const vv = window.visualViewport;
    if (!vv) return;
    const pinched = vv.scale > 1.05;
    // Heuristic: the keyboard only ever shrinks the viewport meaningfully.
    const keyboardOpen = !pinched && vv.height < window.innerHeight - 120;
    const height = pinched ? window.innerHeight : vv.height;
    const offsetTop = pinched ? 0 : vv.offsetTop;
    const root = document.documentElement.style;
    root.setProperty('--vvh', `${height}px`);
    root.setProperty('--vvo', `${offsetTop}px`);
    viewportStore.set({ height, width: vv.width, offsetTop, scale: vv.scale, keyboardOpen });
  };
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', update);
    window.visualViewport.addEventListener('scroll', update);
  }
  window.addEventListener('resize', update);
  update();
}
