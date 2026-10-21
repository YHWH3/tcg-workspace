/// <reference lib="webworker" />
/**
 * Custom service worker (vite-plugin-pwa injectManifest):
 * - precaches the app shell (same as the previous generateSW setup)
 * - navigation fallback to index.html (SPA)
 * - /api/* is never cached (NetworkOnly)
 * - POST /share-target stores shared files in IndexedDB → redirects to /capture?shared=1
 */
import { putShared } from './core/sharedInbox';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: { url: string; revision: string | null }[] };

const entries = self.__WB_MANIFEST ?? [];
// A revisioned URL in a shared cache is insufficient: ignoreSearch can select
// the FIRST old index.html revision after an upgrade. Isolate each build.
const CACHE_PREFIX = 'ws-precache-';
const shellRevision = entries.find((e) => e.url.replace(/^\//, '') === 'index.html')?.revision ?? 'unversioned';
const PRECACHE = `${CACHE_PREFIX}v4-${shellRevision}`;
const precacheUrls = entries.map((e) => e.url);
// Workbox can include the same icon through both its glob and manifest list.
// Cache.addAll rejects duplicate request keys, so deduplicate exact URLs first.
const precacheReqs = [...new Map(entries.map((e) => {
  const request = new Request(e.revision ? `${e.url}?__rev=${e.revision}` : e.url);
  return [request.url, request] as const;
})).values()];

self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const existed = (await caches.keys()).includes(PRECACHE);
      const cache = await caches.open(PRECACHE);
      try {
        // A new shell is usable offline only when ALL required build assets
        // are cached. Cache.addAll is atomic; an interrupted install must leave
        // the previous worker active rather than activate an incomplete build.
        await cache.addAll(precacheReqs);
      } catch (error) {
        // A script-only update can reuse an existing shell revision. Never
        // delete a cache that the still-active worker may be using.
        if (!existed) await caches.delete(PRECACHE);
        throw error;
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        // One previous build supports lazy chunks requested by already-open
        // tabs. Bound retention and leave unrelated origin caches untouched.
        const previous = keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== PRECACHE).at(-1);
        return Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== PRECACHE && k !== previous).map((k) => caches.delete(k)));
      })
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Web Share Target: park shared files in IndexedDB, then open the capture sheet.
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(
      (async () => {
        try {
          const form = await event.request.formData();
          const items = form
            .getAll('media')
            .filter((v): v is File => v instanceof File && v.size > 0)
            .map((f) => ({ id: crypto.randomUUID(), file: f as Blob, name: f.name, mime: f.type, addedAt: Date.now() }));
          if (items.length) await putShared(items);
        } catch {
          /* fall through to capture */
        }
        return Response.redirect('/capture?shared=1', 303);
      })(),
    );
    return;
  }

  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return; // NetworkOnly

  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(event.request);
        } catch {
          const cache = await caches.open(PRECACHE);
          const hit = await cache.match('index.html', { ignoreSearch: true });
          if (!hit) return Response.error();
          // /index.html 307-redirects to '/', so the precached response carries
          // `redirected: true` — navigations reject those from respondWith.
          // Re-wrap into a clean response.
          return new Response(await hit.blob(), {
            status: hit.status,
            statusText: hit.statusText,
            headers: hit.headers,
          });
        }
      })(),
    );
    return;
  }

  // Cache-first for precached assets; plain network for anything else.
  if (precacheUrls.includes(url.pathname) || precacheUrls.includes(url.pathname.slice(1)) || url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(PRECACHE).then(async (cache) => {
        const hit = await cache.match(event.request, { ignoreSearch: true });
        if (hit) return hit;
        // Only immutable build assets may fall back to the prior build. Never
        // use an old shell, API response or authenticated record projection.
        if (url.pathname.startsWith('/assets/')) {
          const keys = (await caches.keys()).filter((k) => k.startsWith(CACHE_PREFIX) && k !== PRECACHE).reverse();
          for (const key of keys) {
            const previous = await (await caches.open(key)).match(event.request, { ignoreSearch: true });
            if (previous) return previous;
          }
        }
        return fetch(event.request);
      }),
    );
  }
});

export {};
