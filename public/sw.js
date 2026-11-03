/*
 * Service worker ESAM Sauvegarde, écrit à la main (pas de plugin).
 *
 * - Installation : précache de la coquille (pages, fichiers du build listés dans
 *   precache.json, généré par vite.config.ts, et fichiers de public/).
 * - Navigation : réseau d'abord, repli sur le cache hors réseau.
 * - Fichiers hashés (assets/) : cache d'abord.
 * - Autres fichiers du site : réseau d'abord, repli sur le cache.
 * La version vient du paramètre ?v= de l'URL d'enregistrement (identifiant du build) :
 * chaque build donne un nouveau cache, les anciens sont supprimés à l'activation.
 */

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const PREFIX = 'esam-backup-';
const CACHE = `${PREFIX}${VERSION}`;
const SCOPE = self.registration.scope; // se termine par "/", ex. https://julok35.github.io/esam-backup/
const ASSETS = new URL('assets/', SCOPE).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      let files = [];
      try {
        const response = await fetch(new URL('precache.json', SCOPE), { cache: 'no-store' });
        if (response.ok) files = await response.json();
      } catch {
        // Hors réseau pendant l'installation : la coquille minimale suffit.
      }
      const urls = ['./', ...files].map((path) => new URL(path, SCOPE).href);
      await cache.addAll([...new Set(urls)]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = (await cache.match(request, { ignoreSearch: true })) || (fallbackUrl && (await cache.match(fallbackUrl)));
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

function navigationFallback(url) {
  // Pages du multipage : "test/" a sa propre page en cache, sinon l'accueil.
  let path = url.pathname;
  if (!path.endsWith('/')) path = /\.[a-z0-9]+$/i.test(path) ? path.replace(/[^/]*$/, '') : `${path}/`;
  const candidate = new URL(path, url.origin).href;
  return candidate.startsWith(SCOPE) && candidate !== SCOPE ? candidate : SCOPE;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !request.url.startsWith(SCOPE)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      networkFirst(request, navigationFallback(url)).catch(async () => (await caches.match(SCOPE)) || Response.error()),
    );
  } else if (request.url.startsWith(ASSETS)) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(networkFirst(request));
  }
});

// Notification de fin de traitement : un appui ramène l'appli au premier plan.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((client) => client.url.startsWith(SCOPE));
      if (existing) return existing.focus();
      return self.clients.openWindow(SCOPE);
    })(),
  );
});
