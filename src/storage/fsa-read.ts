/*
 * Fonctions de lecture communes à FsaDirectoryBackend et ReadOnlySource.
 * Interne à src/storage : ne fait que des appels de lecture sur les poignées
 * (jamais { create: true }, jamais createWritable, removeEntry ou move).
 */
import { StorageError, toStorageError } from './errors';
import { splitParent, splitPath } from './path';
import type { OpenReadOptions, ReadHandle, StorageEntry } from './types';

export async function resolveDirectory(root: FileSystemDirectoryHandle, segments: readonly string[]): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const segment of segments) {
    try {
      current = await current.getDirectoryHandle(segment);
    } catch (error) {
      throw toStorageError(error, segments.join('/'));
    }
  }
  return current;
}

export async function resolveFile(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle> {
  const { parent, name } = splitParent(path);
  const dir = await resolveDirectory(root, parent);
  try {
    return await dir.getFileHandle(name);
  } catch (error) {
    throw toStorageError(error, path);
  }
}

export async function describeHandle(handle: FileSystemHandle): Promise<StorageEntry> {
  if (handle.kind === 'directory') {
    return { name: handle.name, kind: 'directory', size: null, lastModified: null };
  }
  const file = await (handle as FileSystemFileHandle).getFile();
  return { name: handle.name, kind: 'file', size: file.size, lastModified: file.lastModified };
}

export async function listDirectory(root: FileSystemDirectoryHandle, path: string): Promise<StorageEntry[]> {
  const dir = await resolveDirectory(root, splitPath(path));
  const entries: StorageEntry[] = [];
  try {
    for await (const handle of dir.values()) {
      entries.push(await describeHandle(handle));
    }
  } catch (error) {
    throw toStorageError(error, path);
  }
  return entries;
}

export async function statPath(root: FileSystemDirectoryHandle, path: string): Promise<StorageEntry | null> {
  const segments = splitPath(path);
  const name = segments.pop();
  if (name === undefined) return { name: root.name, kind: 'directory', size: null, lastModified: null };
  let parent: FileSystemDirectoryHandle;
  try {
    parent = await resolveDirectory(root, segments);
  } catch (error) {
    if (error instanceof StorageError && (error.code === 'not-found' || error.code === 'wrong-kind')) return null;
    throw error;
  }
  for (const getter of [() => parent.getFileHandle(name), () => parent.getDirectoryHandle(name)]) {
    try {
      return await describeHandle(await getter());
    } catch (error) {
      const mapped = toStorageError(error, path);
      if (mapped.code !== 'not-found' && mapped.code !== 'wrong-kind') throw mapped;
    }
  }
  return null;
}

export async function openFileForRead(root: FileSystemDirectoryHandle, path: string, options?: OpenReadOptions): Promise<ReadHandle> {
  const handle = await resolveFile(root, path);
  let file: File;
  try {
    file = await handle.getFile();
  } catch (error) {
    throw toStorageError(error, path);
  }
  const start = options?.start ?? 0;
  if (!Number.isInteger(start) || start < 0 || start > file.size) {
    throw new StorageError('invalid-path', `start=${start} hors du fichier (${file.size} octets)`);
  }
  const blob = start === 0 ? file : file.slice(start);
  return { stream: blob.stream() as ReadableStream<Uint8Array>, size: file.size, lastModified: file.lastModified };
}
