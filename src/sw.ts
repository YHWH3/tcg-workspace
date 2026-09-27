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

const PRECACHE = 'ws-precache-v3';
const entries = self.__WB_MANIFEST ?? [];
const precacheUrls = entries.map((e) => e.url);
const precacheReqs = entries.map((e) => new Request(e.revision ? `${e.url}?__rev=${e.revision}` : e.url));

self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(PRECACHE);
        // addAll one-by-one so a single bad asset can't kill the whole install.
        for (const req of precacheReqs) {
          try {
            await cache.add(req);
          } catch (e) {
            console.error('SW precache failed:', req.url, e);
          }
        }
      } finally {
        await self.skipWaiting();
      }
    })(),
  );
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== PRECACHE).map((k) => caches.delete(k))))
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
  if (precacheUrls.includes(url.pathname) || precacheUrls.includes(url.pathname.slice(1))) {
    event.respondWith(
      caches.open(PRECACHE).then(async (cache) => {
        const hit = await cache.match(event.request, { ignoreSearch: true });
        return hit ?? fetch(event.request);
      }),
    );
  }
});

export {};
