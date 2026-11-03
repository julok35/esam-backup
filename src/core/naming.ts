/*
 * Règles de nommage (section 6 du brief), sur le modèle du Drive existant :
 * `AAAA-MM-JJ Animal(aux) - Lieu`, par exemple `2026-10-18 Dolly et Max - Mont Granier`.
 *
 * Arborescence : ESAM/01 - Secours/<année>/<intervention>/<source>/
 * Index, statuts des cartes et journaux : ESAM/_systeme/
 *
 * Tout est pur : les noms existants et les dates sont passés en paramètre.
 */
import { CoreError } from './errors';
import { daysBetween, isoDate, isoFromParts, isValidIsoDate } from './format';

export const ROOT_FOLDER = 'ESAM';
export const RESCUE_FOLDER = '01 - Secours';
export const SYSTEM_FOLDER = '_systeme';

/** Longueur maximale d'un nom de dossier d'intervention (exFAT accepte 255, on reste lisible). */
export const MAX_INTERVENTION_NAME_LENGTH = 120;
/** Longueur maximale d'un nom de sous-dossier source. */
export const MAX_SOURCE_NAME_LENGTH = 60;
/** Remplace une partie manquante (animal ou lieu) quand l'autre a été saisie. */
export const MISSING_PART = 'à préciser';
export const TO_RENAME = 'à renommer';

const SEPARATOR = ' - ';

/*
 * Caractères interdits sur exFAT et gênants sur Drive ou Windows : \ / : * ? " < > |
 * ainsi que les caractères de contrôle. Remplacés par une espace, puis normalisés.
 */
const FORBIDDEN_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
/*
 * Tirets typographiques convertis en tiret classique : U+2010 à U+2015 (dont le
 * demi-cadratin U+2013 et le cadratin U+2014) et le signe moins U+2212. Écrits en
 * échappements : la règle du projet interdit ces caractères dans les sources.
 */
const DASHES = /[\u2010-\u2015\u2212]/g;

/**
 * Nettoie un texte libre pour en faire (une partie de) nom de dossier : forme
 * Unicode composée (NFC, les accents saisis sur iPhone arrivent décomposés),
 * tirets typographiques convertis, caractères interdits remplacés par une espace,
 * espaces (y compris insécables) réduites à une seule, espaces de début et de fin
 * supprimées, ainsi que les points et tirets en bordure.
 */
export function cleanText(input: string): string {
  return input
    .normalize('NFC')
    .replace(DASHES, '-')
    .replace(FORBIDDEN_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|[\s.-]+$/g, '');
}

/** Coupe à `max` caractères (sans couper un caractère en deux), puis retire la ponctuation finale. */
export function truncateName(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars
    .slice(0, Math.max(0, max))
    .join('')
    .replace(/[\s.-]+$/, '');
}

function assertIsoDate(date: string): void {
  if (!isValidIsoDate(date)) throw new CoreError('invalid-date', JSON.stringify(date));
}

export interface InterventionInput {
  /** Date AAAA-MM-JJ. */
  date: string;
  /** Animal ou animaux, saisie libre (« Dolly et Max »). */
  animals: string;
  /** Lieu, saisie libre (« Mont Granier »). */
  place: string;
}

/**
 * Nom normalisé `AAAA-MM-JJ Animal(aux) - Lieu`.
 *
 * - Retourne null si l'animal et le lieu sont tous deux vides : utiliser alors
 *   fallbackInterventionName.
 * - Si une seule des deux parties manque, elle est remplacée par « à préciser »
 *   (on ne perd pas ce qui a été saisi et le nom reste conforme).
 * - Un « - » entouré d'espaces dans la partie animaux deviendrait un faux
 *   séparateur : il est remplacé par « , ».
 * - Lève CoreError('invalid-date') si la date n'est pas une date AAAA-MM-JJ existante.
 */
export function normalizeInterventionName({ date, animals, place }: InterventionInput): string | null {
  assertIsoDate(date);
  let animalsPart = cleanText(animals).replace(/\s+-\s+/g, ', ');
  let placePart = cleanText(place);
  if (animalsPart === '' && placePart === '') return null;
  if (animalsPart === '') animalsPart = MISSING_PART;
  if (placePart === '') placePart = MISSING_PART;

  // Bornage : on raccourcit d'abord le lieu, puis les animaux, en gardant au moins 20 caractères chacun.
  const budget = MAX_INTERVENTION_NAME_LENGTH - date.length - 1 - SEPARATOR.length;
  const animalsLength = Array.from(animalsPart).length;
  const placeLength = Array.from(placePart).length;
  if (animalsLength + placeLength > budget) {
    const placeMax = Math.max(20, budget - animalsLength);
    placePart = truncateName(placePart, placeMax);
    animalsPart = truncateName(animalsPart, budget - Array.from(placePart).length);
  }
  return `${date} ${animalsPart}${SEPARATOR}${placePart}`;
}

/** `AAAA-MM-JJ Sauvegarde intervention N - à renommer`. */
export function fallbackInterventionName(date: string, n: number): string {
  assertIsoDate(date);
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`Numéro invalide : ${n}`);
  return `${date} Sauvegarde intervention ${n}${SEPARATOR}${TO_RENAME}`;
}

const FALLBACK_PATTERN = /^sauvegarde intervention (\d+)$/i;

/**
 * Prochain N pour un nom de repli de la journée : le plus grand N existant plus 1
 * (jamais de réutilisation d'un numéro, même si un trou existe). Tolère les noms
 * légèrement déformés (casse, espaces, date au format libre).
 */
export function nextFallbackNumber(existingNames: Iterable<string>, date: string): number {
  assertIsoDate(date);
  let max = 0;
  for (const name of existingNames) {
    const parsed = parseInterventionName(name);
    if (!parsed || parsed.date !== date) continue;
    const match = FALLBACK_PATTERN.exec(parsed.animals);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export interface ParsedInterventionName {
  /** Date AAAA-MM-JJ. */
  date: string;
  animals: string;
  /** Vide si le nom ne contient pas de lieu identifiable. */
  place: string;
  /** Nom normalisé proposé (identique au nom lu s'il était déjà conforme). */
  normalized: string;
  /** Vrai si le nom lu est exactement le nom normalisé. */
  isCanonical: boolean;
  /** Vrai pour un nom de repli « Sauvegarde intervention N - à renommer ». */
  isFallback: boolean;
}

/*
 * Dates reconnues en tête de nom : 2026-10-18, 2026.10.18, 2026_10_18, 20261018,
 * 18-10-2026, 18.10.2026, 18/10/2026 (ordre jour-mois français), éventuellement
 * suivies d'un point (« 2026-10-18. »).
 */
const YMD = /^(\d{4})[-._ ]?(\d{2})[-._ ]?(\d{2})(?!\d)/;
const DMY = /^(\d{1,2})[-._/](\d{1,2})[-._/](\d{4})(?!\d)/;

function readLeadingDate(text: string): { date: string; rest: string } | null {
  const ymd = YMD.exec(text);
  if (ymd) {
    const date = isoFromParts(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
    if (date) return { date, rest: text.slice(ymd[0].length) };
  }
  const dmy = DMY.exec(text);
  if (dmy) {
    const date = isoFromParts(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
    if (date) return { date, rest: text.slice(dmy[0].length) };
  }
  return null;
}

/** Sépare « Animaux - Lieu » : d'abord « - » entouré d'espaces, puis espace d'un seul côté, puis « - » nu. */
function splitAnimalsPlace(rest: string): { animals: string; place: string } {
  const patterns = [/\s-\s/, /\s-|-\s/, /-/];
  for (const pattern of patterns) {
    const match = pattern.exec(rest);
    if (match) {
      return { animals: rest.slice(0, match.index), place: rest.slice(match.index + match[0].length) };
    }
  }
  return { animals: rest, place: '' };
}

/**
 * Lit un nom de dossier d'intervention, y compris un dossier créé à la main sur le
 * Drive qui dévie de la convention. Retourne null si aucune date n'est lisible en
 * tête du nom ou s'il n'y a rien après la date.
 */
export function parseInterventionName(name: string): ParsedInterventionName | null {
  const text = name.normalize('NFC').replace(DASHES, '-').trim();
  const lead = readLeadingDate(text);
  if (!lead) return null;
  // Après la date : point éventuel, puis espaces, tirets ou soulignés de séparation.
  const rest = lead.rest.replace(/^\.?[\s_-]*/, '');
  if (cleanText(rest) === '') return null;
  const split = splitAnimalsPlace(rest);
  const animals = cleanText(split.animals);
  const place = cleanText(split.place);
  const isFallback = FALLBACK_PATTERN.test(animals) && place.toLowerCase() === TO_RENAME;
  let normalized: string;
  if (animals === '' || place === '') {
    const only = truncateName(animals || place, MAX_INTERVENTION_NAME_LENGTH - lead.date.length - 1);
    normalized = `${lead.date} ${only}`;
  } else if (isFallback) {
    normalized = fallbackInterventionName(lead.date, Number(FALLBACK_PATTERN.exec(animals)?.[1] ?? 1) || 1);
  } else {
    normalized = normalizeInterventionName({ date: lead.date, animals, place }) ?? `${lead.date} ${animals}`;
  }
  return { date: lead.date, animals, place, normalized, isCanonical: normalized === name, isFallback };
}

/** Une date de prise de vue : Date, millisecondes, ou absente. */
export type CaptureDateInput = Date | number | null | undefined;

/** Années plausibles : une horloge d'appareil non réglée donne souvent 1970, 2000 ou 2015. */
export const MIN_PLAUSIBLE_YEAR = 2016;

/**
 * Date AAAA-MM-JJ (locale) la plus fréquente parmi les dates de prise de vue.
 * Ignore les dates invalides, antérieures à MIN_PLAUSIBLE_YEAR ou postérieures à
 * `now` de plus d'un jour (horloge déréglée). Égalité : la plus récente.
 * Aucune date exploitable : la date du jour (`now`).
 */
export function mostFrequentCaptureDate(dates: Iterable<CaptureDateInput>, now: Date): string {
  const limit = now.getTime() + 86_400_000;
  const counts = new Map<string, number>();
  for (const value of dates) {
    if (value === null || value === undefined) continue;
    const date = value instanceof Date ? value : new Date(value);
    const time = date.getTime();
    if (Number.isNaN(time) || time > limit || date.getFullYear() < MIN_PLAUSIBLE_YEAR) continue;
    const key = isoDate(date);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && key > best)) {
      best = key;
      bestCount = count;
    }
  }
  return best ?? isoDate(now);
}

export interface NearbyIntervention {
  name: string;
  /** 0 pour la même date, 1 pour la veille, etc. */
  daysBefore: number;
  parsed: ParsedInterventionName;
}

/**
 * Dossiers existants de la même date ou des `daysBack` jours précédents, du plus
 * proche au plus lointain (puis par nom). Les noms illisibles sont ignorés.
 */
export function findNearbyInterventions(existingNames: Iterable<string>, date: string, daysBack = 3): NearbyIntervention[] {
  assertIsoDate(date);
  const found: NearbyIntervention[] = [];
  for (const name of existingNames) {
    const parsed = parseInterventionName(name);
    if (!parsed) continue;
    const diff = daysBetween(parsed.date, date);
    if (diff === null || diff < 0 || diff > daysBack) continue;
    found.push({ name, daysBefore: diff, parsed });
  }
  return found.sort((a, b) => a.daysBefore - b.daysBefore || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Sous-dossier source : saisie normalisée (« Drone M30T », « Kévin ») ou `ImportN - à renommer`. */
export function sourceFolderName(input: string, importNumber: number): string {
  const cleaned = truncateName(cleanText(input), MAX_SOURCE_NAME_LENGTH);
  if (cleaned !== '') return cleaned;
  if (!Number.isInteger(importNumber) || importNumber < 1) throw new RangeError(`Numéro invalide : ${importNumber}`);
  return `Import${importNumber}${SEPARATOR}${TO_RENAME}`;
}

/** Prochain N pour `ImportN - à renommer` dans un dossier d'intervention. */
export function nextImportNumber(existingSourceNames: Iterable<string>): number {
  let max = 0;
  for (const name of existingSourceNames) {
    const match = /^import\s*(\d+)\b/i.exec(cleanText(name));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** Dossier d'année : « 2026 » pour « 2026-10-18 » (ou pour une Date, en heure locale). */
export function yearFolder(date: string | Date): string {
  const iso = typeof date === 'string' ? date : isoDate(date);
  assertIsoDate(iso);
  return iso.slice(0, 4);
}

export interface InterventionPathInput {
  year: string;
  intervention: string;
  /** Sous-dossier source, facultatif (chemin du dossier d'intervention seul sinon). */
  source?: string;
}

/** Segments `ESAM/01 - Secours/<année>/<intervention>[/<source>]`. */
export function interventionPath({ year, intervention, source }: InterventionPathInput): string[] {
  const segments = [ROOT_FOLDER, RESCUE_FOLDER, year, intervention];
  if (source !== undefined) segments.push(source);
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || /[\\/]/.test(segment)) {
      throw new RangeError(`Segment de chemin invalide : ${JSON.stringify(segment)}`);
    }
  }
  return segments;
}

/** Segments `ESAM/_systeme[/<nom>]`. */
export function systemPath(name?: string): string[] {
  return name === undefined ? [ROOT_FOLDER, SYSTEM_FOLDER] : [ROOT_FOLDER, SYSTEM_FOLDER, name];
}

/** Extensions doubles traitées comme un tout (« archive.tar.gz » devient « archive_2.tar.gz »). */
export const DOUBLE_EXTENSIONS = ['tar.gz', 'tar.bz2', 'tar.xz', 'tar.zst'] as const;

/** Sépare base et extension : « DJI_0001.MP4 » donne [« DJI_0001 », « .MP4 »]. */
export function splitExtension(name: string): { base: string; extension: string } {
  const lower = name.toLowerCase();
  for (const double of DOUBLE_EXTENSIONS) {
    const suffix = `.${double}`;
    if (lower.endsWith(suffix) && lower.length > suffix.length) {
      return { base: name.slice(0, -suffix.length), extension: name.slice(-suffix.length) };
    }
  }
  const dot = name.lastIndexOf('.');
  // Pas d'extension pour « .fichier_cache » (point en tête) ni « nom. » (point final).
  if (dot <= 0 || dot === name.length - 1) return { base: name, extension: '' };
  return { base: name.slice(0, dot), extension: name.slice(dot) };
}

/** Clé de comparaison de noms : exFAT ne distingue ni la casse ni les formes Unicode. */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * Nom libre pour un fichier dont le nom est déjà pris dans le dossier cible :
 * « photo.jpg » devient « photo_2.jpg », puis « photo_3.jpg ». Comparaison
 * insensible à la casse (exFAT). Retourne le nom d'origine s'il est libre.
 * Ne réutilise jamais un nom existant.
 */
export function resolveFileNameCollision(name: string, existingNames: Iterable<string>): string {
  const taken = new Set<string>();
  for (const existing of existingNames) taken.add(nameKey(existing));
  if (!taken.has(nameKey(name))) return name;
  const { base, extension } = splitExtension(name);
  for (let i = 2; ; i += 1) {
    const candidate = `${base}_${i}${extension}`;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
}
