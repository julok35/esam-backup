/*
 * Opérations mesurées sur les supports : choix d'un dossier, parcours, lecture,
 * écriture d'un motif, copie. La carte n'est lue qu'à travers un ReadableStorage
 * (ReadOnlySource) : aucune fonction de ce fichier ne peut écrire sur la carte.
 */
import { errorInfo, type ScannedFile } from './analysis';
import type { ScanResult } from './context';
import { isMeasureError, makeFailure, MeasureError, type FailurePhase, type WriteFailure } from './failure';
import { PhaseTimer, RateMeter, rechunk, sizeStats } from './measure';
import { patternChunks } from './pattern';
import { StreamingSha256 } from '../platform';
import { joinPath, type ChunkWriter, type ReadableStorage, type StorageBackend } from '../storage';

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
  /** Temps de close() : sur Android, recopie du fichier d'échange vers le SSD. */
  closeMs: number;
  sha256: string | null;
}

/** Adapte un FileSystemWritableFileStream brut (variantes d'ouverture) en ChunkWriter. */
class RawChunkWriter implements ChunkWriter {
  #offset = 0;
  #done = false;
  readonly #stream: FileSystemWritableFileStream;

  constructor(stream: FileSystemWritableFileStream) {
    this.#stream = stream;
  }

  get offset(): number {
    return this.#offset;
  }

  async write(chunk: Uint8Array): Promise<void> {
    await this.#stream.write(chunk as Uint8Array<ArrayBuffer>);
    this.#offset += chunk.byteLength;
  }

  async close(): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    await this.#stream.close();
  }

  async abort(): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    await this.#stream.abort().catch(() => undefined);
  }
}

/**
 * Écrit `total` octets de motif pseudo-aléatoire dans le ChunkWriter ouvert par
 * `open`, par morceaux de `chunkSize`, en calculant l'empreinte au passage. En cas
 * d'échec, lève une MeasureError qui dit la phase (ouverture, écriture, close),
 * les octets acceptés par write() et le temps passé dans chaque phase.
 */
export async function measurePatternWrite(
  open: () => Promise<ChunkWriter>,
  total: number,
  chunkSize: number,
  seed: number,
  hash: boolean,
  onProgress?: Progress,
): Promise<WriteMeasure> {
  const timer = new PhaseTimer();
  const hasher = hash ? await StreamingSha256.create() : null;
  const started = performance.now();
  let phase: FailurePhase = 'ouverture';
  let writer: ChunkWriter | null = null;
  let pendingBytes = 0;
  try {
    const opened = await timer.time('ouverture', open);
    writer = opened;
    const meter = new RateMeter();
    const chunks = patternChunks(total, chunkSize, seed);
    phase = 'écriture';
    for (;;) {
      const next = timer.timeSync('génération', () => chunks.next());
      if (next.done) break;
      const chunk = next.value;
      if (hasher) timer.timeSync('empreinte', () => hasher.update(chunk));
      pendingBytes = chunk.byteLength;
      await timer.time('écriture', () => opened.write(chunk));
      pendingBytes = 0;
      meter.update(opened.offset);
      onProgress?.(opened.offset, meter);
    }
    phase = 'close';
    await timer.time('close', () => opened.close());
    return {
      bytes: opened.offset,
      ms: performance.now() - started,
      openMs: timer.get('ouverture'),
      genMs: timer.get('génération'),
      hashMs: timer.get('empreinte'),
      writeMs: timer.get('écriture'),
      closeMs: timer.get('close'),
      sha256: hasher ? hasher.digest() : null,
    };
  } catch (error) {
    const failure = makeFailure(error, {
      phase,
      bytesWritten: writer?.offset ?? 0,
      pendingBytes,
      target: total,
      elapsedMs: performance.now() - started,
      phaseMs: Object.fromEntries(timer.entries()),
    });
    await writer?.abort().catch(() => undefined);
    throw new MeasureError(failure, error);
  }
}

/**
 * Écrit `total` octets de motif dans `path` (remplace le fichier s'il existe :
 * uniquement utilisé dans le dossier de test). Voir measurePatternWrite.
 */
export function measureWritePattern(
  dest: StorageBackend,
  path: string,
  total: number,
  chunkSize: number,
  seed: number,
  hash: boolean,
  onProgress?: Progress,
): Promise<WriteMeasure> {
  return measurePatternWrite(() => dest.openWriter(path, { ifExists: 'replace' }), total, chunkSize, seed, hash, onProgress);
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
 * précédent. Empreinte facultative, calculée en flux. En cas d'échec, lève une
 * MeasureError (phase ouverture, lecture de la carte, écriture ou close).
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
  let phase: FailurePhase = 'ouverture';
  let target = 0;
  let writer: ChunkWriter | null = null;
  let chunks: AsyncGenerator<Uint8Array> | null = null;
  let pending: Promise<void> | null = null;
  let pendingBytes = 0;
  let written = 0;
  try {
    const input = await timer.time('ouverture', () => source.openRead(sourcePath));
    target = input.size;
    const opened = await timer.time('ouverture', () => dest.openWriter(destPath, { ifExists: 'replace' }));
    writer = opened;
    const meter = new RateMeter();
    const reader = rechunk(streamChunks(input.stream), chunkSize, (n) => sizes.push(n));
    chunks = reader;
    for (;;) {
      phase = 'lecture';
      const next = await timer.time('lecture', () => reader.next());
      if (next.done) break;
      const chunk = next.value;
      if (hasher) timer.timeSync('empreinte', () => hasher.update(chunk));
      phase = 'écriture';
      if (pending) await timer.time('écriture', () => pending);
      const size = chunk.byteLength;
      pendingBytes = size;
      pending = opened.write(chunk).then(() => {
        written += size;
        pendingBytes = 0;
        meter.update(written);
        onProgress?.(written, meter);
      });
      // Évite un rejet « non géré » pendant la lecture du morceau suivant ; l'erreur
      // est relevée au prochain await de pending.
      pending.catch(() => undefined);
      if (!options.parallel) {
        await timer.time('écriture', () => pending);
        pending = null;
      }
    }
    phase = 'écriture';
    if (pending) await timer.time('écriture', () => pending);
    phase = 'close';
    await timer.time('close', () => opened.close());
    return {
      bytes: opened.offset,
      ms: performance.now() - started,
      openMs: timer.get('ouverture'),
      readMs: timer.get('lecture'),
      hashMs: timer.get('empreinte'),
      writeMs: timer.get('écriture'),
      closeMs: timer.get('close'),
      sha256: hasher ? hasher.digest() : null,
      native: sizeStats(sizes),
    };
  } catch (error) {
    const failure = makeFailure(error, {
      phase,
      bytesWritten: writer?.offset ?? written,
      pendingBytes,
      target,
      elapsedMs: performance.now() - started,
      phaseMs: Object.fromEntries(timer.entries()),
    });
    await pending?.catch(() => undefined);
    await writer?.abort().catch(() => undefined);
    await chunks?.return(undefined).catch(() => undefined);
    throw new MeasureError(failure, error);
  }
}

/** Variantes d'ouverture mesurées au palier de 16 Mo, toutes sur un fichier neuf. */
export type OpenVariant = 'neuf' | 'keep-vide' | 'exclusif';

export const OPEN_VARIANTS: { value: OpenVariant; file: string; label: string }[] = [
  { value: 'neuf', file: 'palier_16Mo_neuf.bin', label: 'createWritable({ keepExistingData: false }), fichier neuf' },
  { value: 'keep-vide', file: 'palier_16Mo_keep.bin', label: 'createWritable({ keepExistingData: true }), fichier neuf de 0 octet' },
  { value: 'exclusif', file: 'palier_16Mo_exclusif.bin', label: "createWritable({ mode: 'exclusive' }), fichier neuf" },
];

export interface VariantResult {
  variant: OpenVariant;
  /** Faux si l'option n'est pas lue par Chrome (variante exclusive seulement). */
  supported: boolean;
  measure: WriteMeasure | null;
  failure: WriteFailure | null;
  /** Observations : taille de départ, verrou exclusif respecté ou non. */
  notes: string[];
}

/**
 * Mesure une variante d'ouverture sur un fichier neuf de `dir` (dossier de test
 * du SSD). Pour « exclusif », on vérifie d'abord que Chrome lit l'option mode
 * (un dictionnaire WebIDL ignore les clés inconnues sans les lire), puis qu'une
 * seconde ouverture du même fichier est refusée pendant l'écriture.
 */
export async function measureOpenVariant(dir: FileSystemDirectoryHandle, variant: OpenVariant, name: string, total: number, chunkSize: number): Promise<VariantResult> {
  const notes: string[] = [];
  await dir.removeEntry(name).catch(() => undefined);
  const file = await dir.getFileHandle(name, { create: true });
  notes.push(`taille de départ ${(await file.getFile()).size} octets`);
  let options: FileSystemCreateWritableOptions;
  let modeRead = false;
  if (variant === 'exclusif') {
    options = {
      keepExistingData: false,
      get mode() {
        modeRead = true;
        return 'exclusive';
      },
    } as unknown as FileSystemCreateWritableOptions;
  } else {
    options = { keepExistingData: variant === 'keep-vide' };
  }
  const open = async (): Promise<ChunkWriter> => {
    const stream = await file.createWritable(options);
    if (variant === 'exclusif') {
      if (!modeRead) {
        await stream.abort().catch(() => undefined);
        throw new DOMException("option mode non lue par Chrome", 'NotSupportedError');
      }
      try {
        const second = await file.createWritable({ keepExistingData: false });
        await second.abort().catch(() => undefined);
        notes.push('seconde ouverture acceptée pendant l\'écriture : verrou exclusif sans effet');
      } catch (error) {
        notes.push(`seconde ouverture refusée (${errorInfo(error).name}) : verrou exclusif respecté`);
      }
    }
    return new RawChunkWriter(stream);
  };
  try {
    const measure = await measurePatternWrite(open, total, chunkSize, newSeed(), false);
    return { variant, supported: true, measure, failure: null, notes };
  } catch (error) {
    if (variant === 'exclusif' && !modeRead) return { variant, supported: false, measure: null, failure: null, notes: [...notes, 'option mode non lue : non prise en charge'] };
    const failure = isMeasureError(error) ? error.failure : makeFailure(error, { phase: 'ouverture', bytesWritten: 0, target: total, elapsedMs: 0 });
    return { variant, supported: true, measure: null, failure, notes };
  }
}

export interface ResumeOpenMeasure {
  size: number;
  /** Durée de createWritable({ keepExistingData: true }). */
  openMs: number;
  /** Durée de abort() (abandon sans rien écrire). */
  abortMs: number;
}

/**
 * Ouvre un fichier existant du dossier de test avec keepExistingData puis abandonne
 * sans rien écrire : la durée d'ouverture dit si Chrome recopie tout le fichier.
 */
export async function measureResumeOpen(dir: FileSystemDirectoryHandle, name: string): Promise<ResumeOpenMeasure> {
  const file = await dir.getFileHandle(name);
  const size = (await file.getFile()).size;
  const t0 = performance.now();
  const stream = await file.createWritable({ keepExistingData: true });
  const openMs = performance.now() - t0;
  const t1 = performance.now();
  await stream.abort().catch(() => undefined);
  return { size, openMs, abortMs: performance.now() - t1 };
}

/** Graine du motif : change à chaque essai pour ne jamais relire un ancien fichier par erreur. */
export function newSeed(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] ?? 1;
}
