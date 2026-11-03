/*
 * Utilitaires de mise en forme et de dates, purs et déterministes.
 *
 * Unités décimales (1 Go = 1 000 000 000 octets), comme Android et les fabricants
 * de cartes : « 512 Go » sur l'étiquette s'affiche « 512 Go » (à peu près).
 * Pas d'Intl : le rendu ne dépend ni de la locale ni de la version d'ICU.
 *
 * Dates « AAAA-MM-JJ » : toujours en heure locale, car les dates du terrain (prise
 * de vue, nom des dossiers) sont locales.
 */

const UNITS = ['Ko', 'Mo', 'Go', 'To'] as const;

/** Nombre avec virgule décimale : 1.25 et 1 décimale donne « 1,3 ». Pas de « ,0 » final. */
export function formatDecimal(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  const trimmed = decimals > 0 ? fixed.replace(/\.?0+$/, '') : fixed;
  return trimmed.replace('.', ',');
}

/** « 0 octet », « 999 octets », « 1,2 Go », « 512 Go », « 1,5 To ». */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1000) {
    const n = Math.round(bytes);
    return `${n} ${n > 1 ? 'octets' : 'octet'}`;
  }
  let value = bytes / 1000;
  let index = 0;
  while (value >= 1000 && index < UNITS.length - 1) {
    value /= 1000;
    index += 1;
  }
  const unit = UNITS[index] ?? 'To';
  // Une décimale sous 100 (1,2 Go ; 15,3 Go), aucune au-delà (512 Go).
  const decimals = value < 100 ? 1 : 0;
  // 999,96 Go arrondi donnerait « 1000 Go » : on garde tel quel, c'est lisible.
  return `${formatDecimal(value, decimals)} ${unit}`;
}

/** « 45 s », « 3 min 05 s », « 1 h 02 min ». Arrondi à la seconde. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  if (minutes > 0) return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
  return `${seconds} s`;
}

/** Débit en octets par seconde, ou null si la durée est nulle ou invalide. */
export function bytesPerSecond(bytes: number, durationMs: number): number | null {
  if (!Number.isFinite(bytes) || !Number.isFinite(durationMs) || durationMs <= 0 || bytes < 0) return null;
  return (bytes * 1000) / durationMs;
}

/** « 85,3 Mo/s » (une décimale sous 100, aucune au-delà). */
export function formatRate(bytesPerSec: number | null): string {
  if (bytesPerSec === null || !Number.isFinite(bytesPerSec) || bytesPerSec < 0) return '-';
  const mo = bytesPerSec / 1_000_000;
  return `${formatDecimal(mo, mo < 100 ? 1 : 0)} Mo/s`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** AAAA-MM-JJ en heure locale. */
export function isoDate(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new RangeError('Date invalide');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Date du jour (locale) à partir de l'instant fourni : jamais de new Date() caché. */
export function todayIso(now: Date): string {
  return isoDate(now);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Vrai si la chaîne est une date AAAA-MM-JJ existante (2026-02-30 est refusée). */
export function isValidIsoDate(value: string): boolean {
  return isoDateToDayNumber(value) !== null;
}

/** Numéro de jour (jours depuis 1970-01-01), calculé en UTC : sans effet d'heure d'été. */
export function isoDateToDayNumber(value: string): number | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return Math.round(ms / 86_400_000);
}

/** Construit AAAA-MM-JJ à partir de composantes, ou null si la date n'existe pas. */
export function isoFromParts(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1 || year > 9999) return null;
  const iso = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
  return isValidIsoDate(iso) ? iso : null;
}

/** Nombre de jours de `from` à `to` (positif si `to` est après), null si une date est invalide. */
export function daysBetween(from: string, to: string): number | null {
  const a = isoDateToDayNumber(from);
  const b = isoDateToDayNumber(to);
  if (a === null || b === null) return null;
  return b - a;
}
