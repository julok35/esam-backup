/*
 * Identification et statut des cartes (lot 2), sans rien écrire sur la carte.
 *
 * Empreinte de carte : nom du volume (nom du dossier choisi) et les N fichiers les
 * plus anciens (nom, taille, date à la seconde), sérialisés de façon canonique puis
 * hachés en FNV-1a 64 bits. Ce n'est pas une empreinte d'intégrité (les médias,
 * eux, sont vérifiés en SHA-256) : seulement un identifiant stable et rapide.
 *
 * Statuts : sauvegardée, puis archivée (confirmation manuelle), puis libre
 * (formatable). Tant qu'une carte n'est pas libre : « Ne pas formater ».
 */
import { CoreError } from './errors';
import { bytesPerSecond } from './format';

export interface CardFile {
  name: string;
  size: number;
  /** Date de modification en millisecondes. */
  mtime: number;
}

export interface CardFingerprint {
  /** Identifiant : « carte-<16 caractères hexadécimaux> ». */
  id: string;
  volumeName: string;
  oldestFiles: CardFile[];
}

export const DEFAULT_OLDEST_COUNT = 10;
export const FINGERPRINT_VERSION = 1;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Les `n` fichiers les plus anciens, triés par date puis nom puis taille (ordre total, déterministe). */
export function selectOldestFiles(files: readonly CardFile[], n = DEFAULT_OLDEST_COUNT): CardFile[] {
  return [...files]
    .sort((a, b) => a.mtime - b.mtime || compareStrings(a.name, b.name) || a.size - b.size)
    .slice(0, Math.max(0, n))
    .map((f) => ({ name: f.name, size: f.size, mtime: f.mtime }));
}

/** Encodage UTF-8 sans TextEncoder (module pur). */
export function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return bytes;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a 64 bits du texte encodé en UTF-8, en 16 caractères hexadécimaux. */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of utf8Bytes(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

function normalizeVolumeName(name: string): string {
  return name.normalize('NFC').trim();
}

/** Clé d'un fichier pour la comparaison : nom, taille, date à la seconde. */
function fileKey(file: CardFile): string {
  return `${file.name}\u0000${file.size}\u0000${Math.floor(file.mtime / 1000)}`;
}

/** Sérialisation canonique (stable, indépendante de l'ordre des fichiers fournis). */
export function canonicalFingerprintText(volumeName: string, oldestFiles: readonly CardFile[]): string {
  const files = selectOldestFiles(oldestFiles, oldestFiles.length).map((f) => [f.name, f.size, Math.floor(f.mtime / 1000)]);
  return JSON.stringify({ v: FINGERPRINT_VERSION, volume: normalizeVolumeName(volumeName), files });
}

/**
 * Empreinte d'une carte. `oldestFiles` peut être la liste complète des fichiers :
 * seuls les `count` plus anciens sont retenus.
 */
export function cardFingerprint(input: { volumeName: string; oldestFiles: readonly CardFile[] }, count = DEFAULT_OLDEST_COUNT): CardFingerprint {
  const oldestFiles = selectOldestFiles(input.oldestFiles, count);
  const volumeName = normalizeVolumeName(input.volumeName);
  return { id: `carte-${fnv1a64(canonicalFingerprintText(volumeName, oldestFiles))}`, volumeName, oldestFiles };
}

export interface CardMatch<T extends { fingerprint: CardFingerprint }> {
  card: T;
  kind: 'exact' | 'tolerant';
  /** 1 pour une correspondance exacte, sinon la part des anciens fichiers retrouvés. */
  score: number;
  commonFiles: number;
}

export interface MatchOptions {
  /** Nombre de fichiers anciens communs exigé (7 sur 10 par défaut). */
  minCommon?: number;
}

/**
 * Retrouve une carte connue. D'abord l'égalité exacte des empreintes, puis une
 * correspondance tolérante : même nom de volume (sans tenir compte de la casse) et
 * au moins 7 des anciens fichiers identiques (une carte dont on a supprimé
 * quelques fichiers reste reconnue). Pour une carte connue de moins de 10 fichiers,
 * le seuil est ramené à 70 % de ses fichiers. Carte vide : aucune correspondance.
 */
export function matchCard<T extends { fingerprint: CardFingerprint }>(
  knownCards: readonly T[],
  candidate: CardFingerprint,
  options: MatchOptions = {},
): CardMatch<T> | null {
  if (candidate.oldestFiles.length === 0) return null;
  const exact = knownCards.find((c) => c.fingerprint.id === candidate.id);
  if (exact) return { card: exact, kind: 'exact', score: 1, commonFiles: candidate.oldestFiles.length };

  const minCommon = options.minCommon ?? 7;
  const volume = candidate.volumeName.toLowerCase();
  const candidateKeys = new Set(candidate.oldestFiles.map(fileKey));
  let best: CardMatch<T> | null = null;
  for (const card of knownCards) {
    const known = card.fingerprint;
    if (known.volumeName.toLowerCase() !== volume || known.oldestFiles.length === 0) continue;
    const common = known.oldestFiles.filter((f) => candidateKeys.has(fileKey(f))).length;
    const required = Math.max(1, Math.min(minCommon, Math.ceil(0.7 * known.oldestFiles.length)));
    if (common < required) continue;
    const score = common / Math.max(known.oldestFiles.length, candidate.oldestFiles.length);
    if (!best || score > best.score) best = { card, kind: 'tolerant', score, commonFiles: common };
  }
  return best;
}

export type CardStatus = 'sauvegardee' | 'archivee' | 'libre';

export interface ImportStats {
  /** Instant de fin de l'import, ISO 8601. */
  at: string;
  files: number;
  bytes: number;
  durationMs: number;
  readErrors: number;
}

export interface CardRecord {
  /** Identifiant stable : l'id de la première empreinte (reste le même si l'empreinte évolue). */
  id: string;
  fingerprint: CardFingerprint;
  /** Nom donné par l'utilisateur, facultatif (« Carte drone 1 »). */
  label?: string;
  status: CardStatus;
  statusChangedAt: string;
  /** Vrai si de nouveaux fichiers ont été vus et pas encore sauvegardés. */
  pendingNewContent: boolean;
  lastImportAt?: string;
  archivedConfirmedAt?: string;
  /** Historique des imports, du plus ancien au plus récent. */
  history: ImportStats[];
}

/** Nombre d'imports conservés dans l'historique de santé. */
export const MAX_HISTORY = 50;

/** Nouvelle fiche de carte, créée à la fin du premier import réussi. */
export function createCardRecord(fingerprint: CardFingerprint, at: string, label?: string): CardRecord {
  const record: CardRecord = {
    id: fingerprint.id,
    fingerprint,
    status: 'sauvegardee',
    statusChangedAt: at,
    pendingNewContent: false,
    lastImportAt: at,
    history: [],
  };
  if (label !== undefined) record.label = label;
  return record;
}

export type CardAction =
  /** Import terminé sans erreur bloquante. `newFiles` : fichiers effectivement copiés. */
  | { type: 'import-ok'; at: string; newFiles: number }
  /** Passage manuel à « archivée » : exige la confirmation explicite. */
  | { type: 'mark-archived'; at: string; confirmed: boolean }
  /** Passage à « libre » (formatable) : seulement depuis « archivée ». */
  | { type: 'mark-free'; at: string }
  /** De nouveaux fichiers sont apparus sur la carte (vus à l'analyse, avant copie). */
  | { type: 'new-content-seen'; at: string };

export type CardTransitionErrorCode = 'confirmation-required' | 'not-archived' | 'already-free' | 'pending-new-content';

/** Transition interdite : `code` pour le programme, `userMessage` pour l'écran. */
export class CardTransitionError extends CoreError {
  readonly from: CardStatus;
  readonly action: CardAction['type'];

  constructor(code: CardTransitionErrorCode, from: CardStatus, action: CardAction['type']) {
    super(code, `${action} depuis ${from}`);
    this.name = 'CardTransitionError';
    this.from = from;
    this.action = action;
  }
}

function withStatus(card: CardRecord, status: CardStatus, at: string): CardRecord {
  return status === card.status ? { ...card } : { ...card, status, statusChangedAt: at };
}

/**
 * Machine à états des cartes. Retourne une nouvelle fiche, ou lève
 * CardTransitionError pour une transition interdite :
 * - import-ok : toujours permis ; repasse à « sauvegardée » si des fichiers ont été
 *   copiés ou si du nouveau contenu était en attente, sinon statut inchangé ;
 * - new-content-seen : toujours permis ; une carte archivée ou libre repasse
 *   aussitôt à « sauvegardée » (donc « Ne pas formater ») en attendant l'import ;
 * - mark-archived : exige confirmed: true, refusé depuis « libre » et si du
 *   nouveau contenu attend d'être sauvegardé ; sans effet si déjà archivée ;
 * - mark-free : seulement depuis « archivée » ; refusé si déjà libre.
 */
export function transitionCard(card: CardRecord, action: CardAction): CardRecord {
  switch (action.type) {
    case 'import-ok': {
      const changed = action.newFiles > 0 || card.pendingNewContent;
      const next = changed ? withStatus(card, 'sauvegardee', action.at) : { ...card };
      return { ...next, pendingNewContent: false, lastImportAt: action.at };
    }
    case 'new-content-seen':
      return { ...withStatus(card, 'sauvegardee', action.at), pendingNewContent: true };
    case 'mark-archived':
      if (!action.confirmed) throw new CardTransitionError('confirmation-required', card.status, action.type);
      if (card.status === 'libre') throw new CardTransitionError('already-free', card.status, action.type);
      if (card.pendingNewContent) throw new CardTransitionError('pending-new-content', card.status, action.type);
      if (card.status === 'archivee') return { ...card };
      return { ...withStatus(card, 'archivee', action.at), archivedConfirmedAt: action.at };
    case 'mark-free':
      if (card.status === 'libre') throw new CardTransitionError('already-free', card.status, action.type);
      if (card.status !== 'archivee') throw new CardTransitionError('not-archived', card.status, action.type);
      return withStatus(card, 'libre', action.at);
  }
}

export interface StatusDisplay {
  label: string;
  /** « Ne pas formater » ou « Formatable ». */
  advice: 'Ne pas formater' | 'Formatable';
  canFormat: boolean;
  /** Phrase d'explication courte. */
  detail: string;
}

/** Libellés pour l'écran. Seul le statut « libre » autorise le formatage. */
export function displayStatus(card: Pick<CardRecord, 'status' | 'pendingNewContent'>): StatusDisplay {
  if (card.pendingNewContent) {
    return {
      label: 'Sauvegarde à terminer',
      advice: 'Ne pas formater',
      canFormat: false,
      detail: 'De nouveaux fichiers sont sur la carte : lancez la sauvegarde.',
    };
  }
  switch (card.status) {
    case 'sauvegardee':
      return {
        label: 'Sauvegardée',
        advice: 'Ne pas formater',
        canFormat: false,
        detail: 'Copiée sur le SSD seulement. Gardez la carte tant que les médias ne sont pas copiés ailleurs.',
      };
    case 'archivee':
      return {
        label: 'Archivée',
        advice: 'Ne pas formater',
        canFormat: false,
        detail: 'Copiée sur le SSD et ailleurs. Marquez-la libre quand vous voulez la réutiliser.',
      };
    case 'libre':
      return { label: 'Libre', advice: 'Formatable', canFormat: true, detail: 'La carte peut être formatée dans l\'appareil.' };
  }
}

/** Ajoute les statistiques d'un import à l'historique (les MAX_HISTORY derniers sont gardés). */
export function recordImportStats(card: CardRecord, stats: ImportStats): CardRecord {
  const history = [...card.history, { ...stats }].slice(-MAX_HISTORY);
  return { ...card, history };
}

export interface HealthThresholds {
  /** Nombre d'imports récents examinés (3). */
  window?: number;
  /** Alerte si le débit médian récent est sous ce ratio de la médiane historique (0,6). */
  rateRatio?: number;
  /** Imports plus petits que ce volume ignorés pour le débit (mesure peu fiable). 100 Mo par défaut. */
  minBytesForRate?: number;
  /** Nombre minimal d'imports antérieurs pour établir la médiane historique (3). */
  minHistory?: number;
}

export type HealthReasonCode = 'read-errors-rising' | 'rate-drop';

export interface HealthAssessment {
  level: 'ok' | 'alerte';
  reasons: { code: HealthReasonCode; message: string }[];
  importCount: number;
  totalReadErrors: number;
  /** Débit médian des imports antérieurs à la fenêtre récente, octets par seconde. */
  historicalMedianRate: number | null;
  /** Débit médian de la fenêtre récente, octets par seconde. */
  recentMedianRate: number | null;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] as number;
  return sorted.length % 2 === 1 ? hi : ((sorted[mid - 1] as number) + hi) / 2;
}

/**
 * Santé d'une carte, à partir de son historique d'imports :
 * - alerte si les erreurs de lecture augmentent strictement sur les `window`
 *   derniers imports (ex. 0, 2, 5) ;
 * - alerte si le débit médian des `window` derniers imports est inférieur à
 *   `rateRatio` fois la médiane des imports précédents.
 */
export function assessCardHealth(card: Pick<CardRecord, 'history'>, thresholds: HealthThresholds = {}): HealthAssessment {
  const window = thresholds.window ?? 3;
  const rateRatio = thresholds.rateRatio ?? 0.6;
  const minBytes = thresholds.minBytesForRate ?? 100_000_000;
  const minHistory = thresholds.minHistory ?? 3;
  const history = card.history;
  const reasons: HealthAssessment['reasons'] = [];

  const recent = history.slice(-window);
  if (recent.length === window && window >= 2) {
    const rising = recent.every((s, i) => i === 0 || s.readErrors > (recent[i - 1] as ImportStats).readErrors);
    if (rising) {
      reasons.push({
        code: 'read-errors-rising',
        message: 'Les erreurs de lecture augmentent à chaque import : copiez vite les médias et remplacez cette carte.',
      });
    }
  }

  const rateOf = (s: ImportStats): number | null => (s.bytes >= minBytes ? bytesPerSecond(s.bytes, s.durationMs) : null);
  const rates = (list: readonly ImportStats[]): number[] => list.map(rateOf).filter((r): r is number => r !== null);
  const recentRates = rates(recent);
  const olderRates = rates(history.slice(0, Math.max(0, history.length - window)));
  const recentMedianRate = median(recentRates);
  const historicalMedianRate = median(olderRates);
  if (
    recentMedianRate !== null &&
    historicalMedianRate !== null &&
    olderRates.length >= minHistory &&
    recentRates.length >= Math.min(window, 2) &&
    recentMedianRate < rateRatio * historicalMedianRate
  ) {
    reasons.push({
      code: 'rate-drop',
      message: 'La carte est devenue nettement plus lente : elle s\'use peut-être. Prévoyez de la remplacer.',
    });
  }

  return {
    level: reasons.length > 0 ? 'alerte' : 'ok',
    reasons,
    importCount: history.length,
    totalReadErrors: history.reduce((n, s) => n + s.readErrors, 0),
    historicalMedianRate,
    recentMedianRate,
  };
}
