/*
 * Journal des mesures : type d'une ligne, export CSV et résumé lisible
 * (fonctions pures, testées par vitest).
 *
 * CSV au format tableur français : séparateur ";", virgule décimale, encodage
 * UTF-8 avec BOM (Excel l'ouvre directement, Google Sheets aussi).
 */
import { formatBytes, formatDuration, formatRate } from './format';
import { analysisLines, architectureVerdict } from './verdict';

export { architectureVerdict, computeVerdict, CRITICAL_TESTS } from './verdict';

/** « À VÉRIFIER » : ni réussi ni échoué, il faut un geste (ex. confirmer l'accès). */
export type ResultKind = 'OK' | 'ECHEC' | 'NON DISPONIBLE' | 'INFO' | 'À VÉRIFIER';

export const RESULT_KINDS: readonly ResultKind[] = ['OK', 'ECHEC', 'NON DISPONIBLE', 'INFO', 'À VÉRIFIER'];

export interface JournalEntry {
  /** Horodatage ISO 8601. */
  ts: string;
  /** Numéro d'étape (0 à 5). */
  step: number;
  /** Nom court du test, ex. "lecture plus gros fichier". */
  test: string;
  /** Paramètre du test, ex. "morceau 16 Mo". */
  param: string;
  /** Taille traitée en octets, null si sans objet. */
  bytes: number | null;
  /** Durée en millisecondes, null si sans objet. */
  ms: number | null;
  /** Débit en Mo/s (1 Mo = 1 048 576 octets), null si sans objet. */
  rate: number | null;
  result: ResultKind;
  /** Détail libre : nom d'erreur, empreinte, mesures annexes. */
  detail: string;
}

export const CSV_COLUMNS = [
  'horodatage',
  'etape',
  'test',
  'parametre',
  'taille_octets',
  'duree_ms',
  'debit_Mo_s',
  'resultat',
  'detail',
] as const;

export const CSV_SEPARATOR = ';';
export const CSV_BOM = '﻿';

/** Échappe une cellule : guillemets si elle contient le séparateur, un guillemet ou un saut de ligne. */
export function csvCell(value: string): string {
  if (/[";\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Nombre avec virgule décimale, sans séparateur de milliers. */
export function csvNumber(value: number | null, decimals: number): string {
  if (value === null || !Number.isFinite(value)) return '';
  return value.toFixed(decimals).replace('.', ',');
}

export function csvLine(entry: JournalEntry): string {
  return [
    entry.ts,
    String(entry.step),
    entry.test,
    entry.param,
    entry.bytes === null ? '' : String(Math.round(entry.bytes)),
    csvNumber(entry.ms, 1),
    csvNumber(entry.rate, 2),
    entry.result,
    entry.detail,
  ]
    .map(csvCell)
    .join(CSV_SEPARATOR);
}

/** Fichier CSV complet (BOM, en-tête, une ligne par mesure, fins de ligne CRLF). */
export function toCsv(entries: readonly JournalEntry[]): string {
  const lines = [CSV_COLUMNS.join(CSV_SEPARATOR), ...entries.map(csvLine)];
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}

/** Nom du fichier exporté : esam-etape0-AAAA-MM-JJ-HHhMM.csv (heure locale). */
export function csvFileName(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `esam-etape0-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}h${p(date.getMinutes())}.csv`;
}

/** Vérifie qu'un objet relu (localStorage) a la forme d'une ligne de journal. */
export function isJournalEntry(value: unknown): value is JournalEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const numOrNull = (x: unknown) => x === null || typeof x === 'number';
  return (
    typeof v.ts === 'string' &&
    typeof v.step === 'number' &&
    typeof v.test === 'string' &&
    typeof v.param === 'string' &&
    numOrNull(v.bytes) &&
    numOrNull(v.ms) &&
    numOrNull(v.rate) &&
    typeof v.result === 'string' &&
    (RESULT_KINDS as readonly string[]).includes(v.result) &&
    typeof v.detail === 'string'
  );
}

/** Relit un journal sérialisé en JSON, en écartant les lignes abîmées. */
export function parseJournal(json: string | null): JournalEntry[] {
  if (!json) return [];
  try {
    const data: unknown = JSON.parse(json);
    return Array.isArray(data) ? data.filter(isJournalEntry) : [];
  } catch {
    return [];
  }
}

export const STEP_TITLES: Record<number, string> = {
  0: 'Capacités du navigateur',
  1: 'Lecture de la carte',
  2: 'Écriture sur le SSD',
  3: 'Débits',
  4: 'Identification de la carte',
  5: 'Persistance des poignées',
};

/** Ligne lisible d'une mesure, pour le résumé copié. */
export function describeEntry(entry: JournalEntry): string {
  const parts = [`${entry.result} ${entry.test}`];
  if (entry.param) parts.push(`(${entry.param})`);
  const figures: string[] = [];
  if (entry.bytes !== null) figures.push(formatBytes(entry.bytes));
  if (entry.ms !== null) figures.push(formatDuration(entry.ms));
  if (entry.rate !== null) figures.push(formatRate(entry.rate));
  if (figures.length > 0) parts.push(`: ${figures.join(', ')}`);
  if (entry.detail) parts.push(`[${entry.detail}]`);
  return parts.join(' ');
}

export interface SummaryContext {
  /** Date de génération du résumé. */
  now: Date;
  /** Appareil et navigateur, ex. "SM-S928B, Chrome 142". */
  device: string;
  build: string;
}

/**
 * Résumé texte lisible : en-tête, verdict d'architecture, puis pour chaque étape
 * la dernière mesure de chaque test (les précédentes restent dans le CSV).
 */
export function buildSummary(entries: readonly JournalEntry[], ctx: SummaryContext): string {
  const lines: string[] = [];
  lines.push('ESAM Sauvegarde - résultats de l\'étape 0');
  lines.push(`Date : ${ctx.now.toLocaleString('fr-FR')}`);
  lines.push(`Appareil : ${ctx.device}`);
  lines.push(`Version de la page : ${ctx.build}`);
  lines.push(`Mesures enregistrées : ${entries.length}`);
  lines.push('');
  lines.push(architectureVerdict(entries));
  lines.push('Analyse :');
  for (const line of analysisLines(entries)) lines.push(`  - ${line}`);
  for (const step of [0, 1, 2, 3, 4, 5]) {
    const latest = new Map<string, JournalEntry>();
    for (const entry of entries) if (entry.step === step) latest.set(`${entry.test}|${entry.param}`, entry);
    lines.push('');
    lines.push(`Étape ${step} - ${STEP_TITLES[step] ?? ''}`);
    if (latest.size === 0) {
      lines.push('  pas encore fait');
      continue;
    }
    for (const entry of latest.values()) lines.push(`  ${describeEntry(entry)}`);
  }
  return `${lines.join('\n')}\n`;
}
