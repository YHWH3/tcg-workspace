import { useSyncExternalStore } from 'react';

export interface Store<T> {
  get(): T;
  set(v: T | ((prev: T) => T)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(v) {
      const next = typeof v === 'function' ? (v as (p: T) => T)(value) : v;
      if (Object.is(next, value)) return;
      value = next;
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function useStoreSlice<T, S>(store: Store<T>, select: (v: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => select(store.get()), () => select(store.get()));
}
