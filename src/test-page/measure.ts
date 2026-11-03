/*
 * Outils de mesure sans DOM : chronométrage par phase, débit instantané,
 * redécoupage d'un flux en morceaux de taille fixe. Testés par vitest.
 */
import { rateMiBps } from './format';

export type Clock = () => number;

const defaultClock: Clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Cumule le temps passé dans chaque phase (lecture, empreinte, écriture, close...). */
export class PhaseTimer {
  readonly #totals = new Map<string, number>();
  readonly #clock: Clock;

  constructor(clock: Clock = defaultClock) {
    this.#clock = clock;
  }

  /** Chronomètre une opération (synchrone ou non) et l'ajoute à la phase. */
  async time<T>(phase: string, run: () => T | Promise<T>): Promise<T> {
    const start = this.#clock();
    try {
      return await run();
    } finally {
      this.add(phase, this.#clock() - start);
    }
  }

  timeSync<T>(phase: string, run: () => T): T {
    const start = this.#clock();
    try {
      return run();
    } finally {
      this.add(phase, this.#clock() - start);
    }
  }

  add(phase: string, ms: number): void {
    this.#totals.set(phase, (this.#totals.get(phase) ?? 0) + ms);
  }

  get(phase: string): number {
    return this.#totals.get(phase) ?? 0;
  }

  entries(): [string, number][] {
    return [...this.#totals.entries()];
  }
}

/**
 * Débit instantané sur une fenêtre glissante (2 s par défaut) et débit moyen
 * depuis le début.
 */
export class RateMeter {
  readonly #windowMs: number;
  readonly #clock: Clock;
  readonly #start: number;
  readonly #samples: { t: number; bytes: number }[] = [];
  #bytes = 0;

  constructor(windowMs = 2000, clock: Clock = defaultClock) {
    this.#windowMs = windowMs;
    this.#clock = clock;
    this.#start = clock();
    this.#samples.push({ t: this.#start, bytes: 0 });
  }

  get bytes(): number {
    return this.#bytes;
  }

  get elapsedMs(): number {
    return this.#clock() - this.#start;
  }

  /** Enregistre le total d'octets traités à l'instant présent. */
  update(totalBytes: number): void {
    const t = this.#clock();
    this.#bytes = totalBytes;
    this.#samples.push({ t, bytes: totalBytes });
    // On garde un échantillon juste avant la fenêtre comme point de départ.
    while (this.#samples.length > 2 && (this.#samples[1]?.t ?? t) <= t - this.#windowMs) this.#samples.shift();
  }

  /** Débit sur la fenêtre glissante, en Mo/s. */
  instant(): number | null {
    const first = this.#samples[0];
    const last = this.#samples[this.#samples.length - 1];
    if (!first || !last || last === first) return null;
    return rateMiBps(last.bytes - first.bytes, last.t - first.t);
  }

  /** Débit moyen depuis la création, en Mo/s. */
  average(): number | null {
    return rateMiBps(this.#bytes, this.elapsedMs);
  }
}

/**
 * Regroupe les morceaux d'un flux (dont la taille est choisie par le navigateur)
 * en morceaux de `size` octets, le dernier pouvant être plus court. Chaque morceau
 * produit est un tableau neuf. `onRead` reçoit la taille de chaque morceau natif
 * (pour connaître la taille réellement lue par le navigateur).
 */
export async function* rechunk(
  source: AsyncIterable<Uint8Array>,
  size: number,
  onRead?: (nativeChunkBytes: number) => void,
): AsyncGenerator<Uint8Array> {
  if (!Number.isInteger(size) || size <= 0) throw new RangeError(`morceau invalide : ${size}`);
  let buffer = new Uint8Array(size);
  let filled = 0;
  for await (const piece of source) {
    onRead?.(piece.byteLength);
    let offset = 0;
    while (offset < piece.byteLength) {
      const take = Math.min(size - filled, piece.byteLength - offset);
      buffer.set(piece.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === size) {
        yield buffer;
        buffer = new Uint8Array(size);
        filled = 0;
      }
    }
  }
  if (filled > 0) yield buffer.slice(0, filled);
}

/** Statistiques simples sur une série de tailles (morceaux lus par exemple). */
export function sizeStats(values: readonly number[]): { count: number; min: number; max: number; mean: number } {
  if (values.length === 0) return { count: 0, min: 0, max: 0, mean: 0 };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { count: values.length, min, max, mean: sum / values.length };
}
