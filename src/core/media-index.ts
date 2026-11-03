/*
 * Index des empreintes (lot 2) : tout ce qui est stocké sur le SSD, une entrée par
 * fichier copié. Stocké dans ESAM/_systeme/ sous forme de JSON versionné.
 *
 * Ce module ne lit aucun fichier et ne hache rien : il décide. Le code d'import
 * (lots 1 et 2) fournit les listes de fichiers et les empreintes calculées pendant
 * la copie.
 */
import { CoreError } from './errors';
import { nameKey, resolveFileNameCollision } from './naming';

export const INDEX_VERSION = 1;
export const INDEX_FILE_NAME = 'index-empreintes.json';
/** Tolérance par défaut sur la date de modification : exFAT a une résolution de 2 s. */
export const DEFAULT_MTIME_TOLERANCE_MS = 2000;

export interface IndexEntry {
  /** SHA-256 en hexadécimal minuscule (64 caractères). */
  sha256: string;
  size: number;
  /** Nom d'origine sur la source (clé du pré-tri), même si le fichier a été suffixé à la copie. */
  name: string;
  /** Date de modification d'origine, en millisecondes. */
  mtime: number;
  /** Emplacement réel, relatif à la racine ESAM (ex. « 01 - Secours/2026/.../DJI_0001.JPG »). */
  path: string;
  /** Nom du sous-dossier source (« Drone M30T »). */
  source: string;
  /** Nom du dossier d'intervention. */
  intervention: string;
  /** Instant de la copie, ISO 8601. */
  importedAt: string;
  /** Empreinte de la carte d'origine, si connue. */
  cardId?: string;
}

export interface MediaIndex {
  version: typeof INDEX_VERSION;
  entries: readonly IndexEntry[];
}

const SHA256 = /^[0-9a-f]{64}$/;

export function createIndex(): MediaIndex {
  return { version: INDEX_VERSION, entries: [] };
}

function entryKey(entry: Pick<IndexEntry, 'sha256' | 'path'>): string {
  return `${entry.sha256}\u0000${nameKey(entry.path)}`;
}

/** Normalise et vérifie une entrée ; lève CoreError(code) avec le motif en détail. */
function checkEntry(raw: unknown, code: 'invalid-entry' | 'invalid-index', position?: number): IndexEntry {
  const where = position === undefined ? 'entrée' : `entrée ${position + 1}`;
  const fail = (reason: string): never => {
    throw new CoreError(code, `${where} : ${reason}`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('pas un objet');
  const e = raw as Record<string, unknown>;
  const sha = typeof e.sha256 === 'string' ? e.sha256.toLowerCase() : '';
  if (!SHA256.test(sha)) fail('empreinte invalide');
  if (typeof e.size !== 'number' || !Number.isSafeInteger(e.size) || e.size < 0) fail('taille invalide');
  if (typeof e.name !== 'string' || e.name === '') fail('nom manquant');
  if (typeof e.mtime !== 'number' || !Number.isFinite(e.mtime)) fail('date de modification invalide');
  if (typeof e.path !== 'string' || e.path === '') fail('emplacement manquant');
  if (typeof e.source !== 'string') fail('source manquante');
  if (typeof e.intervention !== 'string') fail('intervention manquante');
  if (typeof e.importedAt !== 'string' || Number.isNaN(Date.parse(e.importedAt))) fail("date d'import invalide");
  if (e.cardId !== undefined && typeof e.cardId !== 'string') fail('carte invalide');
  const entry: IndexEntry = {
    sha256: sha,
    size: e.size as number,
    name: e.name as string,
    mtime: e.mtime as number,
    path: e.path as string,
    source: e.source as string,
    intervention: e.intervention as string,
    importedAt: e.importedAt as string,
  };
  if (typeof e.cardId === 'string') entry.cardId = e.cardId;
  return entry;
}

/**
 * Ajoute une entrée et retourne un nouvel index (l'index reçu n'est pas modifié).
 * Ajouter deux fois la même empreinte au même emplacement ne change rien.
 */
export function addEntry(index: MediaIndex, entry: IndexEntry): MediaIndex {
  const checked = checkEntry(entry, 'invalid-entry');
  const key = entryKey(checked);
  if (index.entries.some((e) => entryKey(e) === key)) return index;
  return { version: INDEX_VERSION, entries: [...index.entries, checked] };
}

/** Toutes les entrées de ce contenu (le même contenu peut exister à plusieurs endroits). */
export function findBySha(index: MediaIndex, sha256: string): IndexEntry[] {
  const sha = sha256.toLowerCase();
  return index.entries.filter((e) => e.sha256 === sha);
}

export interface QuickKey {
  name: string;
  size: number;
  mtime: number;
}

function sameMtime(a: number, b: number, toleranceMs: number): boolean {
  return Math.abs(a - b) <= toleranceMs;
}

/**
 * Pré-tri rapide : entrées identiques sur le nom (exact), la taille et la date de
 * modification à `toleranceMs` près (2000 ms par défaut, résolution d'exFAT).
 */
export function findByQuickKey(index: MediaIndex, key: QuickKey, toleranceMs = DEFAULT_MTIME_TOLERANCE_MS): IndexEntry[] {
  return index.entries.filter((e) => e.name === key.name && e.size === key.size && sameMtime(e.mtime, key.mtime, toleranceMs));
}

/**
 * Sérialise l'index : JSON valide, une entrée par ligne (lisible et comparable
 * d'une version à l'autre).
 */
export function serializeIndex(index: MediaIndex): string {
  const lines = index.entries.map((e) => `  ${JSON.stringify(e)}`);
  return `{"version": ${INDEX_VERSION}, "entries": [\n${lines.join(',\n')}${lines.length ? '\n' : ''}]}\n`;
}

/**
 * Lit un index sérialisé, avec validation stricte de chaque entrée. Lève
 * CoreError('invalid-index') si le contenu est abîmé : `userMessage` dit quoi
 * faire, `message` précise l'entrée en cause.
 */
export function parseIndex(text: string): MediaIndex {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new CoreError('invalid-index', 'JSON illisible (fichier tronqué ?)');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new CoreError('invalid-index', 'pas un objet');
  const root = data as Record<string, unknown>;
  if (root.version !== INDEX_VERSION) throw new CoreError('invalid-index', `version inconnue : ${JSON.stringify(root.version)}`);
  if (!Array.isArray(root.entries)) throw new CoreError('invalid-index', 'liste des entrées absente');
  const entries = root.entries.map((raw, i) => checkEntry(raw, 'invalid-index', i));
  return { version: INDEX_VERSION, entries };
}

/**
 * Fusionne deux index (ex. index du SSD et index reconstruit) : union sans doublon
 * (même empreinte au même emplacement). En cas de conflit, l'entrée de `a` est
 * gardée. Idempotent : fusionner encore avec `b` ne change rien.
 */
export function mergeIndexes(a: MediaIndex, b: MediaIndex): MediaIndex {
  const seen = new Set<string>();
  const entries: IndexEntry[] = [];
  for (const entry of [...a.entries, ...b.entries]) {
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return { version: INDEX_VERSION, entries };
}

/** Fichier vu sur la carte (ou reçu d'un téléphone), avant toute lecture du contenu. */
export interface ImportCandidate {
  name: string;
  size: number;
  mtime: number;
  /** Chemin relatif à la racine de la carte (« DCIM/DJI_001/DJI_0001.JPG »). */
  relativePath: string;
}

export type PlanDecision = 'copy' | 'skip-quick' | 'hash-then-decide';

export type PlanReason =
  /** Inconnu de l'index : à copier (l'empreinte est calculée pendant la copie). */
  | 'new'
  /** Identique sur nom, taille et date à une entrée de l'index : écarté sans relecture. */
  | 'quick-match'
  /** Même nom et même taille mais date différente : hacher pour trancher. */
  | 'same-name-size'
  /** Mode « vérification complète » : tout est relu et haché. */
  | 'full-verification';

export interface PlannedFile {
  candidate: ImportCandidate;
  decision: PlanDecision;
  reason: PlanReason;
  /** Pour skip-quick : l'entrée correspondante (emplacement déjà sauvegardé). */
  match?: IndexEntry;
}

export interface DecisionTotals {
  count: number;
  bytes: number;
}

export interface ImportPlan {
  files: PlannedFile[];
  summary: Record<PlanDecision, DecisionTotals> & {
    total: DecisionTotals;
    /** Octets à lire sur la carte (copie et hachage). */
    bytesToRead: number;
  };
  /** Vrai si rien n'est à lire : « rien de nouveau » sans relire la carte. */
  nothingNew: boolean;
}

export interface PlanOptions {
  /** Mode « vérification complète » : relecture et hachage de tous les fichiers. */
  fullVerification?: boolean;
  mtimeToleranceMs?: number;
}

/**
 * Plan d'import : pour chaque fichier, copier, écarter (pré-tri) ou hacher pour
 * décider. Aucun fichier n'est lu ici. L'index est parcouru une seule fois
 * (table par nom et taille) : rapide même avec des dizaines de milliers d'entrées.
 */
export function planImport(index: MediaIndex, candidates: readonly ImportCandidate[], options: PlanOptions = {}): ImportPlan {
  const tolerance = options.mtimeToleranceMs ?? DEFAULT_MTIME_TOLERANCE_MS;
  const byNameSize = new Map<string, IndexEntry[]>();
  for (const entry of index.entries) {
    const key = `${entry.name}\u0000${entry.size}`;
    const list = byNameSize.get(key);
    if (list) list.push(entry);
    else byNameSize.set(key, [entry]);
  }

  const zero = (): DecisionTotals => ({ count: 0, bytes: 0 });
  const summary = { copy: zero(), 'skip-quick': zero(), 'hash-then-decide': zero(), total: zero(), bytesToRead: 0 };
  const files: PlannedFile[] = candidates.map((candidate) => {
    const sameNameSize = byNameSize.get(`${candidate.name}\u0000${candidate.size}`) ?? [];
    let planned: PlannedFile;
    if (options.fullVerification) {
      planned = { candidate, decision: 'hash-then-decide', reason: 'full-verification' };
    } else {
      const match = sameNameSize.find((e) => sameMtime(e.mtime, candidate.mtime, tolerance));
      if (match) planned = { candidate, decision: 'skip-quick', reason: 'quick-match', match };
      else if (sameNameSize.length > 0) planned = { candidate, decision: 'hash-then-decide', reason: 'same-name-size' };
      else planned = { candidate, decision: 'copy', reason: 'new' };
    }
    const totals = summary[planned.decision];
    totals.count += 1;
    totals.bytes += candidate.size;
    summary.total.count += 1;
    summary.total.bytes += candidate.size;
    if (planned.decision !== 'skip-quick') summary.bytesToRead += candidate.size;
    return planned;
  });
  return { files, summary, nothingNew: summary.copy.count === 0 && summary['hash-then-decide'].count === 0 };
}

export type HashDecision =
  /** Contenu déjà sauvegardé : pas de copie, signaler « déjà sauvegardé » avec l'emplacement. */
  | { decision: 'duplicate'; existing: IndexEntry; locations: IndexEntry[] }
  /** Même nom qu'un fichier du dossier cible, contenu différent : copier sous `targetName`. */
  | { decision: 'copy-as'; targetName: string }
  /** Nouveau contenu, nom libre : copier sous le nom d'origine. */
  | { decision: 'copy'; targetName: string };

/**
 * Décision une fois l'empreinte connue. `existingNamesInTarget` : noms déjà
 * présents (ou réservés pendant l'import en cours) dans le sous-dossier source cible.
 */
export function decideAfterHash(
  index: MediaIndex,
  candidate: Pick<ImportCandidate, 'name'>,
  sha256: string,
  existingNamesInTarget: Iterable<string>,
): HashDecision {
  const locations = findBySha(index, sha256);
  const first = locations[0];
  if (first) return { decision: 'duplicate', existing: first, locations };
  const targetName = resolveFileNameCollision(candidate.name, existingNamesInTarget);
  return targetName === candidate.name ? { decision: 'copy', targetName } : { decision: 'copy-as', targetName };
}

export interface SizedFile {
  path: string;
  size: number;
}

export interface ConsistencyReport {
  ok: boolean;
  expectedCount: number;
  actualCount: number;
  expectedBytes: number;
  actualBytes: number;
  /** Attendus mais absents de la copie. */
  missing: string[];
  /** Présents dans la copie mais non attendus. */
  unexpected: string[];
  sizeMismatches: { path: string; expected: number; actual: number }[];
}

/** Contrôle de cohérence de fin d'import : même liste de fichiers, mêmes tailles. */
export function verifyConsistency(expected: readonly SizedFile[], actual: readonly SizedFile[]): ConsistencyReport {
  const actualByPath = new Map(actual.map((f) => [f.path, f.size]));
  const expectedPaths = new Set(expected.map((f) => f.path));
  const missing: string[] = [];
  const sizeMismatches: ConsistencyReport['sizeMismatches'] = [];
  for (const file of expected) {
    const size = actualByPath.get(file.path);
    if (size === undefined) missing.push(file.path);
    else if (size !== file.size) sizeMismatches.push({ path: file.path, expected: file.size, actual: size });
  }
  const unexpected = actual.filter((f) => !expectedPaths.has(f.path)).map((f) => f.path);
  const sum = (files: readonly SizedFile[]): number => files.reduce((n, f) => n + f.size, 0);
  return {
    ok: missing.length === 0 && unexpected.length === 0 && sizeMismatches.length === 0 && expected.length === actual.length,
    expectedCount: expected.length,
    actualCount: actual.length,
    expectedBytes: sum(expected),
    actualBytes: sum(actual),
    missing,
    unexpected,
    sizeMismatches,
  };
}
