/*
 * FsaDirectoryBackend : stockage en lecture et écriture sur un dossier choisi avec
 * showDirectoryPicker (le SSD). Ne jamais l'utiliser pour une carte source : voir
 * ReadOnlySource.
 *
 * Points d'attention Chrome (à confirmer à l'étape 0) :
 * - createWritable() écrit dans un fichier temporaire (.crswap) et ne remplace le
 *   fichier qu'à close(). Une coupure avant close() perd tout ce qui a été écrit
 *   depuis l'ouverture. Pour la reprise, fermer régulièrement le ChunkWriter.
 * - createWritable({ keepExistingData: true }) recopie le contenu existant dans le
 *   fichier temporaire : coût proportionnel à la taille déjà écrite.
 * - Il n'existe pas d'API web pour l'espace libre d'un support externe :
 *   freeSpace() renvoie null.
 */
import { StorageError, toStorageError } from './errors';
import { listDirectory, openFileForRead, resolveDirectory, statPath } from './fsa-read';
import { assertValidName, splitParent, splitPath } from './path';
import type {
  ChunkWriter,
  OpenReadOptions,
  OpenWriterOptions,
  ReadHandle,
  StorageBackend,
  StorageEntry,
  WriteFileOptions,
} from './types';

async function ensureDirectoryHandle(root: FileSystemDirectoryHandle, segments: readonly string[]): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const segment of segments) {
    try {
      current = await current.getDirectoryHandle(segment, { create: true });
    } catch (error) {
      throw toStorageError(error, segments.join('/'));
    }
  }
  return current;
}

async function fileExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (error) {
    const mapped = toStorageError(error);
    if (mapped.code === 'not-found') return false;
    if (mapped.code === 'wrong-kind') throw new StorageError('already-exists', `${name} est un dossier`, error);
    throw mapped;
  }
}

class FsaChunkWriter implements ChunkWriter {
  #offset: number;
  readonly #stream: FileSystemWritableFileStream;
  #done = false;

  constructor(stream: FileSystemWritableFileStream, offset: number) {
    this.#stream = stream;
    this.#offset = offset;
  }

  get offset(): number {
    return this.#offset;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#done) throw new StorageError('unknown', 'écriture après fermeture');
    try {
      await this.#stream.write(chunk as Uint8Array<ArrayBuffer>);
    } catch (error) {
      throw toStorageError(error);
    }
    this.#offset += chunk.byteLength;
  }

  async close(): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    try {
      await this.#stream.close();
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async abort(): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    try {
      await this.#stream.abort();
    } catch {
      // Rien à faire : l'écriture est de toute façon abandonnée.
    }
  }
}

export class FsaDirectoryBackend implements StorageBackend {
  readonly #root: FileSystemDirectoryHandle;
  readonly label: string;

  constructor(root: FileSystemDirectoryHandle) {
    this.#root = root;
    this.label = root.name;
  }

  /** Poignée du dossier racine, pour la conserver dans IndexedDB (voir platform/handles). */
  get rootHandle(): FileSystemDirectoryHandle {
    return this.#root;
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

  async ensureDirectory(path: string): Promise<void> {
    await ensureDirectoryHandle(this.#root, splitPath(path));
  }

  async writeFile(path: string, source: ReadableStream<Uint8Array>, options: WriteFileOptions = {}): Promise<number> {
    const writer = await this.openWriter(path, { ifExists: options.ifExists ?? 'fail' });
    const reader = source.getReader();
    try {
      for (;;) {
        if (options.signal?.aborted) throw new StorageError('aborted', path);
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
        options.onProgress?.(writer.offset);
      }
      await writer.close();
      return writer.offset;
    } catch (error) {
      await writer.abort();
      await reader.cancel().catch(() => undefined);
      throw toStorageError(error, path);
    } finally {
      reader.releaseLock();
    }
  }

  async openWriter(path: string, options: OpenWriterOptions = {}): Promise<ChunkWriter> {
    const { parent, name } = splitParent(path);
    const dir = await ensureDirectoryHandle(this.#root, parent);
    const exists = await fileExists(dir, name);
    const resumeAt = options.resumeAt;

    if (resumeAt !== undefined) {
      if (!Number.isInteger(resumeAt) || resumeAt < 0) throw new StorageError('invalid-path', `resumeAt=${resumeAt}`);
      if (!exists) throw new StorageError('not-found', `reprise impossible, ${path} absent`);
      try {
        const handle = await dir.getFileHandle(name);
        const size = (await handle.getFile()).size;
        if (size < resumeAt) throw new StorageError('invalid-path', `reprise à ${resumeAt} mais le fichier fait ${size} octets`);
        const stream = await handle.createWritable({ keepExistingData: true });
        await stream.truncate(resumeAt);
        await stream.seek(resumeAt);
        return new FsaChunkWriter(stream, resumeAt);
      } catch (error) {
        throw toStorageError(error, path);
      }
    }

    if (exists && (options.ifExists ?? 'fail') === 'fail') {
      throw new StorageError('already-exists', path);
    }
    try {
      const handle = await dir.getFileHandle(name, { create: true });
      const stream = await handle.createWritable({ keepExistingData: false });
      return new FsaChunkWriter(stream, 0);
    } catch (error) {
      throw toStorageError(error, path);
    }
  }

  async renameDirectory(path: string, newName: string): Promise<void> {
    assertValidName(newName);
    const { parent, name } = splitParent(path);
    const parentDir = await resolveDirectory(this.#root, parent);
    if (name === newName) return;
    if ((await statPath(this.#root, [...parent, newName].join('/'))) !== null) {
      throw new StorageError('already-exists', newName);
    }
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await parentDir.getDirectoryHandle(name);
    } catch (error) {
      throw toStorageError(error, path);
    }
    if (typeof dir.move !== 'function') {
      // Pas de repli par copie puis suppression : trop long et risqué pour des Go de vidéos.
      throw new StorageError('unsupported', 'FileSystemHandle.move absent');
    }
    try {
      await dir.move(newName);
    } catch (error) {
      throw toStorageError(error, path);
    }
  }

  async freeSpace(): Promise<number | null> {
    // navigator.storage.estimate() mesure le stockage interne du navigateur, pas le SSD.
    return null;
  }
}
