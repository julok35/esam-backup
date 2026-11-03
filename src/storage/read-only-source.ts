/*
 * ReadOnlySource : matérialise la règle absolue « aucune écriture sur une carte source ».
 *
 * - N'implémente que ReadableStorage : aucune méthode d'écriture n'existe sur l'objet.
 * - La poignée du dossier est gardée dans un champ privé (#root) : impossible de la
 *   récupérer pour écrire avec.
 * - L'objet est gelé : on ne peut pas lui greffer de méthode après coup.
 * - Les lectures passent par fsa-read.ts, qui n'utilise jamais { create: true },
 *   createWritable, removeEntry ni move.
 *
 * Le code d'import doit recevoir une ReadOnlySource pour la carte, jamais un
 * FsaDirectoryBackend. Pour la carte, demander la permission en mode 'read' seulement.
 */
import { listDirectory, openFileForRead, statPath } from './fsa-read';
import type { OpenReadOptions, ReadableStorage, ReadHandle, StorageEntry } from './types';

export class ReadOnlySource implements ReadableStorage {
  readonly #root: FileSystemDirectoryHandle;
  readonly label: string;

  constructor(root: FileSystemDirectoryHandle) {
    this.#root = root;
    this.label = root.name;
    Object.freeze(this);
  }

  list(path: string): Promise<StorageEntry[]> {
    return listDirectory(this.#root, path);
  }

  stat(path: string): Promise<StorageEntry | null> {
    return statPath(this.#root, path);
  }

  async exists(path: string): Promise<boolean> {
    return (await statPath(this.#root, path)) !== null;
  }

  openRead(path: string, options?: OpenReadOptions): Promise<ReadHandle> {
    return openFileForRead(this.#root, path, options);
  }

  /** Vrai si `other` désigne le même dossier que cette source (pour reconnaître une carte déjà choisie). */
  isSameRoot(other: FileSystemHandle): Promise<boolean> {
    return this.#root.isSameEntry(other);
  }
}

Object.freeze(ReadOnlySource.prototype);
