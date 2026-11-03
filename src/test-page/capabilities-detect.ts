/*
 * Détection des capacités du navigateur (étape 0). Fonction sans effet de bord qui
 * reçoit l'objet global en paramètre : testable sous Node avec un faux objet.
 */
import type { CapabilityItem } from './analysis';

type Scope = Record<string, unknown>;

function get(scope: unknown, path: readonly string[]): unknown {
  let current: unknown = scope;
  for (const key of path) {
    if (current === null || current === undefined) return undefined;
    try {
      current = (current as Record<string, unknown>)[key];
    } catch {
      return undefined;
    }
  }
  return current;
}

function isFunction(scope: unknown, path: readonly string[]): boolean {
  return typeof get(scope, path) === 'function';
}

function exists(scope: unknown, path: readonly string[]): boolean {
  const value = get(scope, path);
  return value !== undefined && value !== null;
}

/** Partage de fichiers possible (Web Share niveau 2) : canShare({ files }) vrai. */
function canShareFiles(scope: Scope): boolean {
  const nav = get(scope, ['navigator']) as { canShare?: (data: unknown) => boolean } | undefined;
  const FileCtor = get(scope, ['File']) as (new (bits: string[], name: string, options?: { type: string }) => unknown) | undefined;
  if (!nav || typeof nav.canShare !== 'function' || typeof FileCtor !== 'function') return false;
  try {
    return nav.canShare({ files: [new FileCtor(['x'], 'essai.csv', { type: 'text/csv' })] }) === true;
  } catch {
    return false;
  }
}

function standalone(scope: Scope): boolean | null {
  const matchMedia = get(scope, ['matchMedia']);
  if (typeof matchMedia !== 'function') return null;
  try {
    return Boolean((matchMedia as (q: string) => { matches: boolean }).call(scope, '(display-mode: standalone)').matches);
  } catch {
    return null;
  }
}

/** Liste des capacités, du plus important au moins important. */
export function detectCapabilities(scope: Scope): CapabilityItem[] {
  const fsh = ['FileSystemHandle', 'prototype'];
  const ffh = ['FileSystemFileHandle', 'prototype'];
  const items: CapabilityItem[] = [
    { id: 'showDirectoryPicker', label: 'Choix de dossier (showDirectoryPicker)', level: 'critical', present: isFunction(scope, ['showDirectoryPicker']) },
    { id: 'secureContext', label: 'Page sécurisée (https)', level: 'important', present: get(scope, ['isSecureContext']) === true },
    { id: 'queryPermission', label: 'Lire l\'état d\'une autorisation (queryPermission)', level: 'important', present: isFunction(scope, [...fsh, 'queryPermission']) },
    { id: 'requestPermission', label: 'Redemander une autorisation (requestPermission)', level: 'important', present: isFunction(scope, [...fsh, 'requestPermission']) },
    { id: 'createWritable', label: 'Écrire un fichier (createWritable)', level: 'important', present: isFunction(scope, [...ffh, 'createWritable']) },
    { id: 'indexedDB', label: 'Mémoire des poignées (IndexedDB)', level: 'important', present: exists(scope, ['indexedDB']) },
    { id: 'WebAssembly', label: 'WebAssembly (empreinte SHA-256)', level: 'important', present: exists(scope, ['WebAssembly']) },
    { id: 'move', label: 'Renommer un dossier (move)', level: 'useful', present: isFunction(scope, [...fsh, 'move']) },
    { id: 'getUniqueId', label: 'Identifiant de poignée (getUniqueId)', level: 'useful', present: isFunction(scope, [...fsh, 'getUniqueId']) },
    { id: 'showOpenFilePicker', label: 'Choix de fichiers (showOpenFilePicker)', level: 'useful', present: isFunction(scope, ['showOpenFilePicker']) },
    { id: 'createSyncAccessHandle', label: 'Accès rapide au stockage interne (OPFS, createSyncAccessHandle)', level: 'useful', present: isFunction(scope, [...ffh, 'createSyncAccessHandle']) },
    { id: 'storagePersist', label: 'Stockage persistant (navigator.storage.persist)', level: 'useful', present: isFunction(scope, ['navigator', 'storage', 'persist']) },
    { id: 'storageEstimate', label: 'Estimation du stockage interne (navigator.storage.estimate)', level: 'useful', present: isFunction(scope, ['navigator', 'storage', 'estimate']) },
    { id: 'wakeLock', label: 'Écran maintenu allumé (Wake Lock)', level: 'useful', present: exists(scope, ['navigator', 'wakeLock']) },
    { id: 'Notification', label: 'Notifications', level: 'useful', present: isFunction(scope, ['Notification']) },
    { id: 'serviceWorker', label: 'Service worker (hors réseau)', level: 'useful', present: exists(scope, ['navigator', 'serviceWorker']) },
    { id: 'vibrate', label: 'Vibration', level: 'useful', present: isFunction(scope, ['navigator', 'vibrate']) },
    { id: 'shareFiles', label: 'Partage de fichiers (Web Share avec fichiers)', level: 'useful', present: canShareFiles(scope) },
    { id: 'RTCPeerConnection', label: 'WebRTC (RTCPeerConnection)', level: 'useful', present: isFunction(scope, ['RTCPeerConnection']) },
    { id: 'RTCDataChannel', label: 'Canal de données WebRTC (RTCDataChannel)', level: 'useful', present: isFunction(scope, ['RTCDataChannel']) },
    {
      id: 'SharedArrayBuffer',
      label: 'Mémoire partagée (SharedArrayBuffer, isolation cross-origin)',
      level: 'info',
      present: isFunction(scope, ['SharedArrayBuffer']) && get(scope, ['crossOriginIsolated']) === true,
      value: `crossOriginIsolated=${String(get(scope, ['crossOriginIsolated']) ?? 'absent')}`,
    },
  ];
  const mode = standalone(scope);
  items.push({ id: 'standalone', label: 'Ouverte comme appli installée (display-mode standalone)', level: 'info', present: mode, value: mode === null ? 'inconnu' : mode ? 'oui' : 'non, dans un onglet' });
  items.push({ id: 'userAgent', label: 'Navigateur (userAgent)', level: 'info', present: null, value: String(get(scope, ['navigator', 'userAgent']) ?? 'inconnu') });
  return items;
}

/** Version de Chrome lue dans le userAgent ("Chrome/142.0.0.0"), null si absente. */
export function chromeMajorFromUserAgent(ua: string): number | null {
  const match = /Chrome\/(\d+)/.exec(ua);
  return match ? Number(match[1]) : null;
}
