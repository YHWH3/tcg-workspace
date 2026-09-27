import { createStore, useStore } from './store';

export type Theme = 'light' | 'dark' | 'system';
const KEY = 'ws_theme';

function load(): Theme {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export const themeStore = createStore<Theme>(load());

function apply(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function setTheme(t: Theme) {
  localStorage.setItem(KEY, t);
  themeStore.set(t);
  apply(t);
}

export function initTheme() {
  apply(themeStore.get());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => apply(themeStore.get()));
}

export function useTheme(): [Theme, (t: Theme) => void] {
  return [useStore(themeStore), setTheme];
}
