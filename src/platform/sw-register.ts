/*
 * Enregistrement du service worker (public/sw.js). Le paramètre ?v= change à
 * chaque build : le navigateur installe alors la nouvelle version.
 * Rien en développement, pour ne pas servir de fichiers en cache pendant qu'on code.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return null;
  const base = import.meta.env.BASE_URL;
  try {
    return await navigator.serviceWorker.register(`${base}sw.js?v=${encodeURIComponent(__BUILD_ID__)}`, {
      scope: base,
      updateViaCache: 'none',
    });
  } catch {
    return null;
  }
}
