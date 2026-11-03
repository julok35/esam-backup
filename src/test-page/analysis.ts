/*
 * Analyses sans DOM : statistiques d'un parcours de carte, empreinte de carte,
 * nature du nom de la poignée, conseils selon l'erreur, verdict des capacités.
 * Testées par vitest.
 */
import { formatBytes } from './format';

export interface ScannedFile {
  /** Chemin relatif à la racine choisie, segments séparés par "/". */
  path: string;
  name: string;
  size: number;
  lastModified: number;
}

/** Extension en minuscules sans le point ("mp4"), "(sans)" s'il n'y en a pas. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '(sans)';
  return name.slice(dot + 1).toLowerCase();
}

export interface ExtensionStat {
  ext: string;
  count: number;
  bytes: number;
}

/** Répartition par extension, triée par volume décroissant. */
export function extensionStats(files: readonly ScannedFile[]): ExtensionStat[] {
  const map = new Map<string, ExtensionStat>();
  for (const file of files) {
    const ext = extensionOf(file.name);
    const stat = map.get(ext) ?? { ext, count: 0, bytes: 0 };
    stat.count += 1;
    stat.bytes += file.size;
    map.set(ext, stat);
  }
  return [...map.values()].sort((a, b) => b.bytes - a.bytes || a.ext.localeCompare(b.ext));
}

/** Extensions attendues du DJI M30T (R-JPEG est un .JPG, repérable au suffixe _T). */
export const M30T_EXTENSIONS = ['mp4', 'jpg', 'srt', 'lrf'] as const;

/** Repère les photos thermiques R-JPEG du M30T (nom DJI_..._T.JPG). */
export function isLikelyRJpeg(name: string): boolean {
  return /_T\.jpe?g$/i.test(name);
}

export function largestFile(files: readonly ScannedFile[]): ScannedFile | null {
  let best: ScannedFile | null = null;
  for (const file of files) if (best === null || file.size > best.size) best = file;
  return best;
}

/** Les `count` fichiers les plus anciens (date de modification), à égalité par chemin. */
export function oldestFiles(files: readonly ScannedFile[], count = 10): ScannedFile[] {
  return [...files].sort((a, b) => a.lastModified - b.lastModified || a.path.localeCompare(b.path)).slice(0, count);
}

/**
 * Empreinte de carte (texte stable) : nom de la racine puis les fichiers les plus
 * anciens (nom, taille, date). Sert à reconnaître une carte sans rien écrire dessus.
 */
export function cardFingerprintText(rootName: string, files: readonly ScannedFile[], count = 10): string {
  const lines = oldestFiles(files, count).map((f) => `${f.name}|${f.size}|${f.lastModified}`);
  return [`racine=${rootName}`, ...lines].join('\n');
}

export type HandleNameKind = 'volume-label' | 'volume-uuid' | 'generic-folder' | 'other';

const KNOWN_VOLUME_LABELS = ['lexar', 'sandisk', 'dji', 'samsung', 'kingston', 'sony', 'gopro', 'no name', 'untitled', 'sdcard', 'sd card', 'esam'];
const GENERIC_FOLDERS = ['dcim', 'misc', 'download', 'downloads', 'documents', 'pictures', 'movies', 'music', 'android', '0', 'emulated', 'primary', 'sdcard0', 'camera', '100media', 'dji_001'];

/**
 * Nature du nom de la poignée :
 * - volume-uuid : identifiant de volume Android "1A2B-3C4D" (numéro de série FAT/exFAT) ;
 * - volume-label : nom de volume connu (Lexar, DJI, SanDisk...) ;
 * - generic-folder : nom de dossier courant (DCIM, Download...) qui ne dit rien de la carte ;
 * - other : autre nom, peut-être un nom de volume personnalisé.
 */
export function classifyHandleName(name: string): HandleNameKind {
  const n = name.trim().toLowerCase();
  if (/^[0-9a-f]{4}-[0-9a-f]{4}$/i.test(name.trim())) return 'volume-uuid';
  if (GENERIC_FOLDERS.includes(n) || /^\d{3}[a-z_]{5}$/i.test(name.trim())) return 'generic-folder';
  if (KNOWN_VOLUME_LABELS.some((label) => n.startsWith(label))) return 'volume-label';
  return 'other';
}

export function describeHandleName(name: string): string {
  switch (classifyHandleName(name)) {
    case 'volume-uuid':
      return `« ${name} » ressemble au numéro de série du volume (format Android 1A2B-3C4D) : utile pour reconnaître la carte, mais il change si on la reformate.`;
    case 'volume-label':
      return `« ${name} » ressemble à un nom de volume (marque ou nom donné à la carte) : utile mais pas unique, deux cartes Lexar peuvent porter le même nom.`;
    case 'generic-folder':
      return `« ${name} » est un nom de dossier générique (DCIM, Download...) : il ne permet pas de reconnaître la carte, il faudra l'empreinte des fichiers les plus anciens.`;
    default:
      return `« ${name} » n'est ni un nom de volume connu ni un dossier générique : à vérifier à la main (est-ce le nom donné à la carte ?).`;
  }
}

export interface ErrorInfo {
  /** Nom de l'exception (NotAllowedError...), ou "Error". */
  name: string;
  message: string;
  /** Phrase en français : quoi faire. */
  advice: string;
}

const ADVICE: Record<string, string> = {
  AbortError: 'Choix annulé ou opération interrompue. Appuyez à nouveau sur le bouton et choisissez un dossier.',
  NotAllowedError: "Accès refusé. Appuyez à nouveau sur le bouton et acceptez la demande d'accès de Chrome.",
  SecurityError: 'Chrome refuse ce dossier (dossier système ou racine protégée). Choisissez un sous-dossier, par exemple DCIM sur la carte.',
  NotFoundError: "Fichier ou dossier introuvable. Vérifiez que le support est bien branché, puis choisissez à nouveau le dossier.",
  TypeMismatchError: "Un fichier porte le nom d'un dossier attendu (ou l'inverse). Notez le message et passez au test suivant.",
  QuotaExceededError: "Plus de place sur le support. Libérez de l'espace ou choisissez une taille d'essai plus petite.",
  InvalidStateError: 'Le support ne répond plus (débranché ou mis en veille). Rebranchez-le, puis choisissez à nouveau le dossier.',
  NoModificationAllowedError: "Écriture impossible à cet endroit (support en lecture seule ou fichier verrouillé). Vérifiez le SSD et réessayez.",
  InvalidModificationError: 'Opération refusée par le système de fichiers. Notez le message et réessayez une fois.',
  NotReadableError: 'Lecture impossible : le support a peut-être été débranché pendant la lecture. Rebranchez-le et recommencez.',
  NotSupportedError: "Cette fonction n'existe pas sur ce téléphone. Notez-le, c'est un résultat utile.",
  TypeError: "Chrome n'accepte pas cet appel (fonction absente ou option inconnue). Notez le message, c'est un résultat utile.",
  DataCloneError: "Impossible d'enregistrer la poignée dans la mémoire du navigateur. Notez le message.",
  EncodingError: 'Nom de fichier refusé par le support. Notez le message.',
  TimeoutError: 'Le support a mis trop de temps à répondre. Rebranchez-le et recommencez.',
};

const DEFAULT_ADVICE = 'Erreur inattendue. Notez le message, puis recommencez le test une fois.';

/** Conseil en français pour un nom d'exception. */
export function adviceFor(name: string): string {
  return ADVICE[name] ?? DEFAULT_ADVICE;
}

/**
 * Extrait nom, message et conseil d'une erreur quelconque. Pour une StorageError
 * (src/storage), on remonte à l'exception du navigateur qu'elle enveloppe.
 */
export function errorInfo(error: unknown): ErrorInfo {
  let target: unknown = error;
  if (typeof error === 'object' && error !== null && 'name' in error && (error as { name: unknown }).name === 'StorageError') {
    const cause = (error as { cause?: unknown }).cause;
    if (typeof cause === 'object' && cause !== null && 'name' in cause) target = cause;
  }
  const name = typeof target === 'object' && target !== null && 'name' in target ? String((target as { name: unknown }).name) : 'Error';
  let message: string;
  if (typeof target === 'object' && target !== null && 'message' in target) message = String((target as { message: unknown }).message);
  else message = String(target);
  if (target !== error && typeof error === 'object' && error !== null && 'message' in error) {
    message = `${message} (${String((error as { message: unknown }).message)})`;
  }
  return { name, message, advice: adviceFor(name) };
}

/** Une ligne de détail pour le journal : "NotAllowedError: message". */
export function errorDetail(error: unknown): string {
  const info = errorInfo(error);
  return `${info.name}: ${info.message}`;
}

export type CapabilityLevel = 'critical' | 'important' | 'useful' | 'info';

export interface CapabilityItem {
  id: string;
  label: string;
  level: CapabilityLevel;
  /** true présent, false absent, null sans objet (information). */
  present: boolean | null;
  value?: string;
}

export interface CapabilityVerdict {
  /** showDirectoryPicker absent : l'architecture est à revoir. */
  blocking: boolean;
  missingImportant: string[];
  missingUseful: string[];
}

export function capabilityVerdict(items: readonly CapabilityItem[]): CapabilityVerdict {
  const missing = (level: CapabilityLevel) => items.filter((i) => i.level === level && i.present === false).map((i) => i.label);
  return {
    blocking: missing('critical').length > 0,
    missingImportant: missing('important'),
    missingUseful: missing('useful'),
  };
}

export const ARCHITECTURE_BANNER =
  "L'architecture est à revoir. Ce navigateur ne permet pas de choisir un dossier (showDirectoryPicker absent) : impossible de lire la carte ni d'écrire sur le SSD comme prévu. Arrêtez l'étape 0 et signalez-le. Les tests de repli restent possibles pour mesurer la lecture.";

export const ARCHITECTURE_FAILURE_BANNER =
  "L'architecture est à revoir. La lecture de la carte ou l'écriture sur le SSD a échoué (voir l'étape en rouge). Si l'échec se reproduit après avoir rebranché et rechoisi le dossier, arrêtez l'étape 0 et signalez-le avec l'export CSV.";

/** Résumé d'un parcours pour l'affichage brut. */
export function scanSummaryLines(files: readonly ScannedFile[], dirs: number): string[] {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  return [`${files.length} fichiers, ${dirs} dossiers, ${formatBytes(total)}`, ...extensionStats(files).map((s) => `.${s.ext} : ${s.count} fichier(s), ${formatBytes(s.bytes)}`)];
}
