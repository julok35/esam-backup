/*
 * Formatage des tailles, durées et débits (fonctions pures, testées par vitest).
 *
 * Convention de la page de test : 1 Ko = 1024 octets, 1 Mo = 1024 Ko, 1 Go = 1024 Mo.
 * Les fabricants comptent en puissances de 1000 (205 Mo/s annoncés par Lexar font
 * environ 195,5 Mo/s ici). Le CSV garde les octets et les millisecondes bruts pour
 * permettre de recalculer dans l'autre convention.
 */

export const KIB = 1024;
export const MIB = 1024 * 1024;
export const GIB = 1024 * 1024 * 1024;

/** Nombre au format français (virgule décimale, espace insécable fine pour les milliers). */
export function formatNumber(value: number, decimals = 0): string {
  return value.toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).replace(/ | /g, ' ');
}

/** Taille lisible : "512 octets", "3,4 Ko", "1,0 Go". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < KIB) return `${formatNumber(bytes)} octet${bytes > 1 ? 's' : ''}`;
  if (bytes < MIB) return `${formatNumber(bytes / KIB, 1)} Ko`;
  if (bytes < GIB) return `${formatNumber(bytes / MIB, 1)} Mo`;
  return `${formatNumber(bytes / GIB, 2)} Go`;
}

/** Durée lisible : "850 ms", "12,3 s", "4 min 05 s", "1 h 02 min". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${formatNumber(seconds, 1)} s`;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  return `${m} min ${String(s).padStart(2, '0')} s`;
}

/** Débit en Mo/s (1 Mo = 1 048 576 octets), null si la durée est nulle ou invalide. */
export function rateMiBps(bytes: number, ms: number): number | null {
  if (!Number.isFinite(bytes) || !Number.isFinite(ms) || ms <= 0 || bytes < 0) return null;
  return bytes / MIB / (ms / 1000);
}

export function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return '?';
  return `${formatNumber(rate, rate < 10 ? 2 : 1)} Mo/s`;
}

/** Débit lisible directement à partir d'octets et de millisecondes. */
export function formatRateOf(bytes: number, ms: number): string {
  return formatRate(rateMiBps(bytes, ms));
}

/** Temps restant estimé, null si inconnu. */
export function etaMs(doneBytes: number, totalBytes: number, rate: number | null): number | null {
  if (totalBytes <= doneBytes) return 0;
  if (rate === null || rate <= 0) return null;
  return ((totalBytes - doneBytes) / MIB / rate) * 1000;
}

/** Pourcentage entier borné à [0, 100]. */
export function percent(done: number, total: number): number {
  if (total <= 0) return done > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.floor((done / total) * 100)));
}
