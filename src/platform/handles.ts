/*
 * Conservation des poignées de dossiers (FileSystemHandle) dans IndexedDB, pour ne
 * pas redemander le dossier du SSD ou de la carte à chaque ouverture de l'appli.
 *
 * Les permissions ne sont pas conservées : après relance, queryPermission renvoie
 * souvent 'prompt' et requestPermission exige un geste de l'utilisateur (appui sur
 * un bouton). Comportement après débranchement : à mesurer à l'étape 0.
 */

const DB_NAME = 'esam-backup';
const DB_VERSION = 1;
const STORE = 'handles';

export type AccessMode = 'read' | 'readwrite';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function saveHandle(key: string, handle: FileSystemHandle): Promise<void> {
  await withStore('readwrite', (store) => store.put(handle, key));
}

export async function loadHandle<T extends FileSystemHandle = FileSystemDirectoryHandle>(key: string): Promise<T | null> {
  const value = await withStore<unknown>('readonly', (store) => store.get(key));
  return (value as T | undefined) ?? null;
}

export async function deleteHandle(key: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(key));
}

export async function listHandleKeys(): Promise<string[]> {
  const keys = await withStore('readonly', (store) => store.getAllKeys());
  return keys.map(String);
}

/** État de la permission sans rien demander. */
export async function queryAccess(handle: FileSystemHandle, mode: AccessMode): Promise<PermissionState> {
  return handle.queryPermission({ mode });
}

/**
 * Vérifie la permission et la demande si besoin. À appeler depuis un geste de
 * l'utilisateur (clic), sinon le navigateur refuse la demande.
 */
export async function ensureAccess(handle: FileSystemHandle, mode: AccessMode): Promise<boolean> {
  if ((await handle.queryPermission({ mode })) === 'granted') return true;
  return (await handle.requestPermission({ mode })) === 'granted';
}

export type HandleState = 'ok' | 'permission-needed' | 'missing' | 'unavailable' | 'error';

export interface HandleCheck {
  state: HandleState;
  /** Message pour l'utilisateur, en français, sans jargon. */
  message: string;
  /** Nom de l'erreur navigateur, pour le diagnostic (page de test, journaux). */
  errorName?: string;
}

const CHECK_MESSAGES: Record<HandleState, string> = {
  ok: 'Dossier accessible.',
  'permission-needed': "Autorisez à nouveau l'accès à ce dossier.",
  missing: 'Dossier introuvable. Branchez le support puis choisissez à nouveau le dossier.',
  unavailable: 'Le support ne répond plus. Rebranchez-le puis choisissez à nouveau le dossier.',
  error: 'Dossier inutilisable. Choisissez à nouveau le dossier.',
};

function check(state: HandleState, errorName?: string): HandleCheck {
  return errorName === undefined ? { state, message: CHECK_MESSAGES[state] } : { state, message: CHECK_MESSAGES[state], errorName };
}

/**
 * Teste si une poignée conservée est encore utilisable : permission, puis lecture
 * réelle (première entrée du dossier, ou métadonnées du fichier).
 * Ne demande aucune permission : sans accord, renvoie 'permission-needed'.
 */
export async function checkHandle(handle: FileSystemHandle, mode: AccessMode = 'read'): Promise<HandleCheck> {
  try {
    const permission = await handle.queryPermission({ mode });
    if (permission !== 'granted') return check('permission-needed');
    if (handle.kind === 'directory') {
      const iterator = (handle as FileSystemDirectoryHandle).values();
      await iterator.next();
      await iterator.return?.();
    } else {
      await (handle as FileSystemFileHandle).getFile();
    }
    return check('ok');
  } catch (error) {
    const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : 'Error';
    switch (name) {
      case 'NotFoundError':
        return check('missing', name);
      case 'NotAllowedError':
      case 'SecurityError':
        return check('permission-needed', name);
      case 'InvalidStateError':
        return check('unavailable', name);
      default:
        return check('error', name);
    }
  }
}
