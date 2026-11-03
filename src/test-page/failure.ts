/*
 * Description d'un échec d'écriture (fonctions pures, testées par vitest) :
 * à quelle phase, après combien d'octets, en combien de temps, avec quelle
 * exception. Sert au journal (detail lisible et relisible) et à l'écran.
 */
import { errorInfo } from './analysis';
import { formatBytes, formatDuration } from './format';

/** Phase d'une écriture mesurée. "lecture" : lecture de la carte pendant une copie. */
export type FailurePhase = 'ouverture' | 'lecture' | 'écriture' | 'close' | 'relecture';

export const FAILURE_PHASES: readonly FailurePhase[] = ['ouverture', 'lecture', 'écriture', 'close', 'relecture'];

export interface WriteFailure {
  phase: FailurePhase;
  /** Octets acceptés par write() avant l'échec (writer.offset). */
  bytesWritten: number;
  /** Taille du morceau en cours d'écriture au moment de l'échec, 0 si aucun. */
  pendingBytes: number;
  /** Taille visée. */
  target: number;
  /** Temps écoulé depuis le début de l'opération jusqu'à l'échec. */
  elapsedMs: number;
  /** Temps cumulé par phase jusqu'à l'échec (ouverture, écriture, close...). */
  phaseMs: Record<string, number>;
  errorName: string;
  errorMessage: string;
}

/**
 * Erreur d'une mesure : porte la description de l'échec et, en cause, l'exception
 * d'origine (DOMException ou StorageError). errorInfo (analysis.ts) remonte à la cause.
 */
export class MeasureError extends Error {
  readonly failure: WriteFailure;

  constructor(failure: WriteFailure, cause: unknown) {
    super(describeFailure(failure), { cause });
    this.name = 'MeasureError';
    this.failure = failure;
  }
}

export function isMeasureError(error: unknown): error is MeasureError {
  return error instanceof MeasureError;
}

/** Construit la description d'un échec à partir de l'exception et des compteurs. */
export function makeFailure(
  error: unknown,
  data: { phase: FailurePhase; bytesWritten: number; pendingBytes?: number; target: number; elapsedMs: number; phaseMs?: Record<string, number> },
): WriteFailure {
  const info = errorInfo(error);
  return {
    phase: data.phase,
    bytesWritten: data.bytesWritten,
    pendingBytes: data.pendingBytes ?? 0,
    target: data.target,
    elapsedMs: data.elapsedMs,
    phaseMs: { ...(data.phaseMs ?? {}) },
    errorName: info.name,
    errorMessage: info.message,
  };
}

/** Phrase pour l'écran : « Échec pendant la phase écriture, après 64,0 Mo écrits en 1,2 s ». */
export function describeFailure(f: WriteFailure): string {
  return `Échec pendant la phase ${f.phase}, après ${formatBytes(f.bytesWritten)} écrits en ${formatDuration(f.elapsedMs)}`;
}

/** Durées par phase, ex. "ouverture 3 ms, écriture 120 ms, close 0 ms". */
export function phaseTimesText(phaseMs: Record<string, number>): string {
  const parts = Object.entries(phaseMs).map(([phase, ms]) => `${phase} ${Math.round(ms)} ms`);
  return parts.length > 0 ? parts.join(', ') : 'aucune';
}

/**
 * Détail pour le journal, relisible par parseDetailNumber / parseFailurePhase :
 * "phase=écriture, écrits=67108864, cible=134217728, morceau en cours=8388608,
 * écoulé=1234 ms, temps par phase : ..., NoModificationAllowedError: message".
 */
export function failureDetail(f: WriteFailure): string {
  return [
    `phase=${f.phase}`,
    `écrits=${f.bytesWritten}`,
    `cible=${f.target}`,
    `morceau en cours=${f.pendingBytes}`,
    `écoulé=${Math.round(f.elapsedMs)} ms`,
    `temps par phase : ${phaseTimesText(f.phaseMs)}`,
    `${f.errorName}: ${f.errorMessage}`,
  ].join(', ');
}

/** Relit la phase d'échec notée dans un détail de journal, null si absente. */
export function parseFailurePhase(detail: string): FailurePhase | null {
  const match = /(?:^|[\s,])phase=([^,\s]+)/.exec(detail);
  const phase = match?.[1];
  return phase !== undefined && (FAILURE_PHASES as readonly string[]).includes(phase) ? (phase as FailurePhase) : null;
}

/** Relit un nombre "clé=123" dans un détail de journal, null si absent. */
export function parseDetailNumber(detail: string, key: string): number | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[\\s,])${escaped}=(\\d+(?:\\.\\d+)?)`).exec(detail);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Relit une durée "close 123 ms" (format des détails d'écriture), null si absente. */
export function parseDetailMs(detail: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[\\s,])${escaped} (\\d+(?:\\.\\d+)?) ms`).exec(detail);
  return match?.[1] === undefined ? null : Number(match[1]);
}
