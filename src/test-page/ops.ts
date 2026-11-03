/*
 * Opérations mesurées sur les supports : choix d'un dossier, parcours, lecture,
 * écriture d'un motif, copie. La carte n'est lue qu'à travers un ReadableStorage
 * (ReadOnlySource) : aucune fonction de ce fichier ne peut écrire sur la carte.
 */
import type { ScannedFile } from './analysis';
import type { ScanResult } from './context';
import { PhaseTimer, RateMeter, rechunk, sizeStats } from './measure';
import { patternChunks } from './pattern';
import { StreamingSha256 } from '../platform';
import { joinPath, type ReadableStorage, type StorageBackend } from '../storage';

export type Progress = (done: number, meter: RateMeter) => void;

export interface PickResult {
  handle: FileSystemDirectoryHandle;
  /** Option startIn effectivement acceptée ("removable", ou "aucune"). */
  startIn: string;
}

/**
 * Ouvre le sélecteur de dossier. Essaie d'abord startIn: 'removable' (option non
 * standard, refusée par TypeError si Chrome ne la connaît pas), puis sans startIn.
 */
export async function pickDirectory(mode: FileSystemPermissionMode, id: string): Promise<PickResult> {
  const picker = window.showDirectoryPicker;
  if (typeof picker !== 'function') throw new DOMException('showDirectoryPicker absent', 'NotSupportedError');
  try {
    const options = { mode, id, startIn: 'removable' } as unknown as DirectoryPickerOptions;
    return { handle: await picker.call(window, options), startIn: 'removable' };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  return { handle: await picker.call(window, { mode, id }), startIn: 'aucune (removable refusé)' };
}

/** Parcourt un flux morceau par morceau (sans dépendre de l'itération asynchrone native). */
export async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Parcours récursif complet d'un stockage en lecture. Les dossiers illisibles sont notés, pas bloquants. */
export async function scanStorage(storage: ReadableStorage, onProgress?: (files: number, bytes: number) => void): Promise<ScanResult> {
  const started = performance.now();
  const files: ScannedFile[] = [];
  const errors: string[] = [];
  let dirs = 0;
  let totalBytes = 0;
  const top = await storage.list('');
  const queue: string[] = [];
  const visit = (path: string, entries: Awaited<ReturnType<ReadableStorage['list']>>) => {
    for (const entry of entries) {
      const child = joinPath(path, entry.name);
      if (entry.kind === 'directory') {
        dirs += 1;
        queue.push(child);
      } else {
        files.push({ path: child, name: entry.name, size: entry.size ?? 0, lastModified: entry.lastModified ?? 0 });
        totalBytes += entry.size ?? 0;
      }
    }
    onProgress?.(files.length, totalBytes);
  };
  visit('', top);
  while (queue.length > 0) {
    const path = queue.shift() as string;
    try {
      visit(path, await storage.list(path));
    } catch (error) {
      const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : 'Error';
      const cause = typeof error === 'object' && error !== null && 'cause' in error ? (error as { cause?: { name?: string } }).cause?.name : undefined;
      errors.push(`${path} : ${cause ?? name}`);
    }
  }
  return { rootName: storage.label, topLevelEntries: top.length, files, dirs, totalBytes, ms: performance.now() - started, errors };
}

export interface ReadMeasure {
  bytes: number;
  /** Durée totale (horloge murale). */
  ms: number;
  /** Temps passé à attendre les données du support. */
  readMs: number;
  hashMs: number;
  sha256: string | null;
  native: { count: number; min: number; max: number; mean: number };
}

/** Lit un flux en entier, avec ou sans empreinte, en mesurant chaque phase. */
export async function measureRead(stream: ReadableStream<Uint8Array>, hash: boolean, onProgress?: Progress): Promise<ReadMeasure> {
  const timer = new PhaseTimer();
  const meter = new RateMeter();
  const hasher = hash ? await StreamingSha256.create() : null;
  const sizes: number[] = [];
  const started = performance.now();
  let bytes = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await timer.time('lecture', () => reader.read());
      if (done) break;
      sizes.push(value.byteLength);
      if (hasher) timer.timeSync('empreinte', () => hasher.update(value));
      bytes += value.byteLength;
      meter.update(bytes);
      onProgress?.(bytes, meter);
    }
  } finally {
    reader.releaseLock();
  }
  return {
    bytes,
    ms: performance.now() - started,
    readMs: timer.get('lecture'),
    hashMs: timer.get('empreinte'),
    sha256: hasher ? hasher.digest() : null,
    native: sizeStats(sizes),
  };
}

export interface WriteMeasure {
  bytes: number;
  /** Durée totale (horloge murale), génération du motif comprise. */
  ms: number;
  openMs: number;
  genMs: number;
  hashMs: number;
  /** Temps passé dans write() (hors close). */
  writeMs: number;
  /** Temps de close() : validation du fichier temporaire .crswap. */
  closeMs: number;
  sha256: string | null;
}

/**
 * Écrit `total` octets de motif pseudo-aléatoire dans `path`, par morceaux de
 * `chunkSize`, en calculant l'empreinte au passage. Remplace le fichier s'il existe
 * (uniquement utilisé dans le dossier de test).
 */
export async function measureWritePattern(
  dest: StorageBackend,
  path: string,
  total: number,
  chunkSize: number,
  seed: number,
  hash: boolean,
  onProgress?: Progress,
): Promise<WriteMeasure> {
  const timer = new PhaseTimer();
  const hasher = hash ? await StreamingSha256.create() : null;
  const started = performance.now();
  const writer = await timer.time('ouverture', () => dest.openWriter(path, { ifExists: 'replace' }));
  const meter = new RateMeter();
  const chunks = patternChunks(total, chunkSize, seed);
  try {
    for (;;) {
      const next = timer.timeSync('génération', () => chunks.next());
      if (next.done) break;
      const chunk = next.value;
      if (hasher) timer.timeSync('empreinte', () => hasher.update(chunk));
      await timer.time('écriture', () => writer.write(chunk));
      meter.update(writer.offset);
      onProgress?.(writer.offset, meter);
    }
    await timer.time('close', () => writer.close());
  } catch (error) {
    await writer.abort();
    throw error;
  }
  return {
    bytes: writer.offset,
    ms: performance.now() - started,
    openMs: timer.get('ouverture'),
    genMs: timer.get('génération'),
    hashMs: timer.get('empreinte'),
    writeMs: timer.get('écriture'),
    closeMs: timer.get('close'),
    sha256: hasher ? hasher.digest() : null,
  };
}

export interface CopyMeasure {
  bytes: number;
  ms: number;
  openMs: number;
  /** Attente des données de la carte (redécoupage compris). */
  readMs: number;
  hashMs: number;
  /** Attente de l'écriture (en mode parallèle, seulement la part non recouverte). */
  writeMs: number;
  closeMs: number;
  sha256: string | null;
  native: { count: number; min: number; max: number; mean: number };
}

/**
 * Copie un fichier de la carte (lecture seule) vers le SSD, par morceaux de
 * `chunkSize`. En mode parallèle, le morceau suivant est lu pendant l'écriture du
 * précédent. Empreinte facultative, calculée en flux.
 */
export async function measureCopy(
  source: ReadableStorage,
  sourcePath: string,
  dest: StorageBackend,
  destPath: string,
  chunkSize: number,
  options: { hash: boolean; parallel: boolean },
  onProgress?: Progress,
): Promise<CopyMeasure> {
  const timer = new PhaseTimer();
  const hasher = options.hash ? await StreamingSha256.create() : null;
  const sizes: number[] = [];
  const started = performance.now();
  const input = await timer.time('ouverture', () => source.openRead(sourcePath));
  const writer = await timer.time('ouverture', () => dest.openWriter(destPath, { ifExists: 'replace' }));
  const meter = new RateMeter();
  const chunks = rechunk(streamChunks(input.stream), chunkSize, (n) => sizes.push(n));
  let pending: Promise<void> | null = null;
  let written = 0;
  try {
    for (;;) {
      const next = await timer.time('lecture', () => chunks.next());
      if (next.done) break;
      const chunk = next.value;
      if (hasher) timer.timeSync('empreinte', () => hasher.update(chunk));
      if (pending) await timer.time('écriture', () => pending);
      const size = chunk.byteLength;
      pending = writer.write(chunk).then(() => {
        written += size;
        meter.update(written);
        onProgress?.(written, meter);
      });
      if (!options.parallel) {
        await timer.time('écriture', () => pending);
        pending = null;
      }
    }
    if (pending) await timer.time('écriture', () => pending);
    await timer.time('close', () => writer.close());
  } catch (error) {
    await pending?.catch(() => undefined);
    await writer.abort();
    await chunks.return(undefined).catch(() => undefined);
    throw error;
  }
  return {
    bytes: writer.offset,
    ms: performance.now() - started,
    openMs: timer.get('ouverture'),
    readMs: timer.get('lecture'),
    hashMs: timer.get('empreinte'),
    writeMs: timer.get('écriture'),
    closeMs: timer.get('close'),
    sha256: hasher ? hasher.digest() : null,
    native: sizeStats(sizes),
  };
}

/** Graine du motif : change à chaque essai pour ne jamais relire un ancien fichier par erreur. */
export function newSeed(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] ?? 1;
}
