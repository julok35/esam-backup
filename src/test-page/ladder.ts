/*
 * Écriture par paliers (fonctions pures, testées par vitest) : tailles
 * successives, décision de réessayer ou de s'arrêter, fichiers à supprimer,
 * part du close() et lecture de son évolution avec la taille.
 *
 * Sur Android, Chrome écrit d'abord dans un fichier d'échange de son cache
 * interne puis recopie le fichier vers le SSD au close() (ticket Chromium
 * 40101963) : un close() dont la durée suit la taille du fichier en est le signe.
 */
import type { WriteFailure } from './failure';
import { formatBytes, formatDuration, formatNumber, MIB, rateMiBps } from './format';

/** Tailles essayées, dans l'ordre : 1, 16, 64, 128, 256, 512 Mo puis 1 Go. */
export const LADDER_SIZES: readonly number[] = [1, 16, 64, 128, 256, 512, 1024].map((n) => n * MIB);

/** Palier sur lequel on mesure en plus les variantes d'ouverture. */
export const VARIANT_SIZE = 16 * MIB;

/** À partir de cette taille, un fichier sert à mesurer le coût d'une reprise. */
export const RESUME_PROBE_MIN = 256 * MIB;

/** Nom du fichier d'un palier : palier_16Mo.bin, palier_1024Mo.bin. */
export function ladderFileName(size: number): string {
  return `palier_${Math.round(size / MIB)}Mo.bin`;
}

export interface LadderAttempt {
  size: number;
  /** 1 pour le premier essai, 2 pour le second après un échec. */
  attempt: number;
  ok: boolean;
  /** Octets acceptés par write() (taille du fichier si réussi). */
  bytes: number;
  openMs: number;
  writeMs: number;
  closeMs: number;
  failure?: WriteFailure;
}

export type LadderAction = { kind: 'write'; size: number; attempt: number } | { kind: 'stop'; reason: 'done' | 'limit' | 'random' };

/**
 * Prochaine action : palier suivant après une réussite, second essai du même
 * palier après un premier échec, arrêt après le second essai (« limit » s'il
 * échoue encore, « random » s'il réussit) ou après le dernier palier (« done »).
 */
export function nextLadderAction(attempts: readonly LadderAttempt[], sizes: readonly number[] = LADDER_SIZES): LadderAction {
  const last = attempts[attempts.length - 1];
  if (!last) {
    const first = sizes[0];
    return first === undefined ? { kind: 'stop', reason: 'done' } : { kind: 'write', size: first, attempt: 1 };
  }
  if (last.attempt >= 2) return { kind: 'stop', reason: last.ok ? 'random' : 'limit' };
  if (!last.ok) return { kind: 'write', size: last.size, attempt: 2 };
  const next = sizes.find((s) => s > last.size);
  return next === undefined ? { kind: 'stop', reason: 'done' } : { kind: 'write', size: next, attempt: 1 };
}

/** Durée d'écriture comptée : ouverture, write et close. */
export function attemptTotalMs(a: Pick<LadderAttempt, 'openMs' | 'writeMs' | 'closeMs'>): number {
  return a.openMs + a.writeMs + a.closeMs;
}

/** Part du close() dans la durée d'écriture (0 à 1), null si la durée est nulle. */
export function closeShare(closeMs: number, totalMs: number): number | null {
  if (!(totalMs > 0) || closeMs < 0) return null;
  return Math.min(1, closeMs / totalMs);
}

export function formatShare(share: number | null): string {
  return share === null ? '?' : `${formatNumber(share * 100)} %`;
}

/**
 * Fichiers de palier à supprimer à la fin : tous sauf celui du dernier essai en
 * échec, laissé sur le SSD pour inspection.
 */
export function ladderFilesToDelete(attempts: readonly LadderAttempt[]): { remove: string[]; keep: string | null } {
  const last = attempts[attempts.length - 1];
  const keep = last && !last.ok ? ladderFileName(last.size) : null;
  const names = new Set(attempts.map((a) => ladderFileName(a.size)));
  if (keep) names.delete(keep);
  return { remove: [...names], keep };
}

export interface LadderSummary {
  /** Plus grande taille écrite avec succès, null si aucune. */
  largestOk: number | null;
  /** Plus petite taille en échec, null si aucune. */
  smallestFail: number | null;
  /** Échec du dernier essai à la plus petite taille en échec. */
  failure: WriteFailure | null;
  stop: LadderAction & { kind: 'stop' };
}

export function summarizeLadder(attempts: readonly LadderAttempt[], sizes: readonly number[] = LADDER_SIZES): LadderSummary {
  const ok = attempts.filter((a) => a.ok).map((a) => a.size);
  const failed = attempts.filter((a) => !a.ok);
  const smallestFail = failed.length > 0 ? Math.min(...failed.map((a) => a.size)) : null;
  const failure = [...failed].reverse().find((a) => a.size === smallestFail)?.failure ?? null;
  const action = nextLadderAction(attempts, sizes);
  return {
    largestOk: ok.length > 0 ? Math.max(...ok) : null,
    smallestFail,
    failure,
    stop: action.kind === 'stop' ? action : { kind: 'stop', reason: 'done' },
  };
}

export interface ClosePoint {
  size: number;
  closeMs: number;
  totalMs: number;
}

export type CloseTrendKind = 'proportional' | 'flat' | 'unclear' | 'unknown';

export interface CloseTrend {
  kind: CloseTrendKind;
  /** Part du close() la plus faible et la plus forte parmi les écritures réussies. */
  minShare: number | null;
  maxShare: number | null;
  /** Débit apparent du close() sur la plus grosse écriture (Mo/s), null si inconnu. */
  closeRate: number | null;
}

/** Taille minimale prise en compte : en dessous, le close() est dominé par des frais fixes. */
const TREND_MIN_SIZE = 16 * MIB;

/**
 * Le close() suit-il la taille ? On compare la plus petite et la plus grosse
 * écriture réussie de 16 Mo ou plus : si le close() grandit au moins de moitié
 * aussi vite que la taille (et dure plus de 100 ms), il est proportionnel ; s'il
 * grandit moins d'un quart aussi vite, il est à peu près constant.
 */
export function closeTrend(points: readonly ClosePoint[]): CloseTrend {
  const shares = points.map((p) => closeShare(p.closeMs, p.totalMs)).filter((s): s is number => s !== null);
  const minShare = shares.length > 0 ? Math.min(...shares) : null;
  const maxShare = shares.length > 0 ? Math.max(...shares) : null;
  const usable = points.filter((p) => p.size >= TREND_MIN_SIZE).sort((a, b) => a.size - b.size);
  const small = usable[0];
  const large = usable[usable.length - 1];
  if (!small || !large || large.size <= small.size) {
    return { kind: 'unknown', minShare, maxShare, closeRate: large ? rateMiBps(large.size, large.closeMs) : null };
  }
  const sizeRatio = large.size / small.size;
  const closeRatio = large.closeMs / Math.max(small.closeMs, 1);
  let kind: CloseTrendKind = 'unclear';
  if (closeRatio >= sizeRatio * 0.5 && large.closeMs >= 100) kind = 'proportional';
  else if (closeRatio <= sizeRatio * 0.25) kind = 'flat';
  return { kind, minShare, maxShare, closeRate: rateMiBps(large.size, large.closeMs) };
}

/** Phrase pour l'écran et le résumé sur l'évolution du close(). */
export function describeCloseTrend(trend: CloseTrend): string {
  const range = trend.minShare === null || trend.maxShare === null ? '' : ` (part du close() entre ${formatShare(trend.minShare)} et ${formatShare(trend.maxShare)})`;
  switch (trend.kind) {
    case 'proportional':
      return `Le close() dure à peu près en proportion de la taille${range} : Chrome écrit d'abord dans son cache interne puis recopie le fichier vers le SSD au close() (ticket Chromium 40101963). Le vrai débit vers le SSD est celui du close()${trend.closeRate === null ? '' : `, environ ${formatNumber(trend.closeRate, 1)} Mo/s`}.`;
    case 'flat':
      return `Le close() reste court quelle que soit la taille${range} : pas de recopie complète visible au close().`;
    case 'unclear':
      return `Le close() grandit avec la taille, mais pas en proportion nette${range} : à analyser avec le CSV.`;
    default:
      return `Pas assez d'écritures réussies de 16 Mo ou plus pour juger le close()${range}.`;
  }
}

/** Phrase de fin du test par paliers. */
export function describeLadder(summary: LadderSummary): string {
  const ok = summary.largestOk === null ? 'aucune écriture réussie' : `plus grande écriture réussie ${formatBytes(summary.largestOk)}`;
  if (summary.smallestFail === null) return `Tous les paliers sont passés (${ok}).`;
  const f = summary.failure;
  const where = f ? ` (phase ${f.phase}, après ${formatBytes(f.bytesWritten)} écrits en ${formatDuration(f.elapsedMs)}, ${f.errorName})` : '';
  const why =
    summary.stop.reason === 'random'
      ? 'Le second essai a réussi : échec aléatoire plutôt que limite de taille.'
      : 'Le second essai a aussi échoué : limite de taille probable.';
  const sentence = `${ok}, premier échec à ${formatBytes(summary.smallestFail)}${where}. ${why}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export type ResumeOpenKind = 'copy' | 'fast';

/**
 * Ouverture de createWritable({ keepExistingData: true }) sur un gros fichier :
 * si elle dure plus de 300 ms et plus de 10 fois l'ouverture de référence (petit
 * fichier), Chrome recopie probablement tout le fichier dans son cache.
 */
export function resumeOpenVerdict(size: number, openMs: number, referenceOpenMs: number | null): { kind: ResumeOpenKind; text: string } {
  const threshold = Math.max(300, (referenceOpenMs ?? 0) * 10);
  const rate = rateMiBps(size, openMs);
  if (openMs > threshold) {
    return {
      kind: 'copy',
      text: `Ouverture en ${formatDuration(openMs)} pour ${formatBytes(size)}${rate === null ? '' : ` (environ ${formatNumber(rate, 1)} Mo/s)`} : Chrome recopie probablement tout le fichier dans son cache avant de reprendre. Une reprise coûtera une relecture complète du fichier déjà écrit.`,
    };
  }
  return { kind: 'fast', text: `Ouverture en ${formatDuration(openMs)} pour ${formatBytes(size)} : pas de recopie complète visible, la reprise est peu coûteuse.` };
}
