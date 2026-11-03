/*
 * Couche de stockage abstraite.
 *
 * Les chemins sont relatifs à la racine du stockage, segments séparés par "/"
 * (ex. "ESAM/01 - Secours/2026"). La chaîne vide désigne la racine.
 * Les segments "." et ".." sont refusés.
 *
 * Deux niveaux :
 * - ReadableStorage : lecture seule. C'est tout ce que reçoit le code qui lit une
 *   carte source (voir ReadOnlySource). Règle absolue : aucune écriture sur une carte.
 * - StorageBackend : lecture et écriture, pour la destination (SSD aujourd'hui,
 *   Google Drive plus tard).
 *
 * Futur DriveBackend (section 7 du brief, à ne pas écrire maintenant) : il devra
 * implémenter StorageBackend en entier. Correspondances prévues :
 * - list / stat / exists : files.list sur le dossier parent (résolution chemin vers id
 *   avec cache, Drive autorise des doublons de nom : refuser l'ambiguïté) ;
 * - openRead : files.get?alt=media avec en-tête Range pour l'offset ;
 * - ensureDirectory : création des dossiers manquants (mimeType dossier) ;
 * - writeFile / openWriter : envoi reprenable (uploadType=resumable), resumeAt
 *   correspondant à l'offset confirmé par Drive ;
 * - renameDirectory : files.update du champ name ;
 * - freeSpace : about.get (storageQuota), ou null si quota illimité ou inconnu.
 * Il pourra en plus exposer le sha256Checksum renvoyé par Drive pour la vérification.
 */

export type EntryKind = 'file' | 'directory';

export interface StorageEntry {
  name: string;
  kind: EntryKind;
  /** Taille en octets, null pour un dossier. */
  size: number | null;
  /** Date de modification en millisecondes depuis l'époque Unix, null pour un dossier. */
  lastModified: number | null;
}

export interface OpenReadOptions {
  /** Octet de départ (pour reprendre une lecture). 0 par défaut. */
  start?: number;
}

export interface ReadHandle {
  /** Flux des octets à partir de `start`. */
  stream: ReadableStream<Uint8Array>;
  /** Taille totale du fichier en octets (indépendante de `start`). */
  size: number;
  lastModified: number;
}

/** Lecture seule. Aucune méthode de ce contrat ne doit pouvoir modifier le support. */
export interface ReadableStorage {
  /** Nom lisible de la racine (nom du dossier choisi). */
  readonly label: string;
  list(path: string): Promise<StorageEntry[]>;
  stat(path: string): Promise<StorageEntry | null>;
  exists(path: string): Promise<boolean>;
  openRead(path: string, options?: OpenReadOptions): Promise<ReadHandle>;
}

export type IfExists = 'fail' | 'replace';

export interface WriteFileOptions {
  /** Comportement si le fichier existe déjà. 'fail' par défaut : jamais d'écrasement implicite. */
  ifExists?: IfExists;
  /** Appelé après chaque morceau écrit avec le total d'octets écrits. */
  onProgress?: (bytesWritten: number) => void;
  signal?: AbortSignal;
}

export interface OpenWriterOptions {
  /**
   * Reprise : conserve les `resumeAt` premiers octets du fichier existant et écrit
   * à la suite (le reste est tronqué). Le fichier doit exister et faire au moins
   * cette taille. Sans cette option, le fichier est créé (refus s'il existe, sauf
   * ifExists: 'replace').
   */
  resumeAt?: number;
  ifExists?: IfExists;
}

/** Écriture par morceaux, pour la copie avec reprise. */
export interface ChunkWriter {
  /** Position courante : nombre d'octets présents dans le fichier une fois validé. */
  readonly offset: number;
  write(chunk: Uint8Array): Promise<void>;
  /** Valide l'écriture. Tant que close() n'est pas appelé, rien n'est garanti sur le support. */
  close(): Promise<void>;
  /** Abandonne les écritures depuis l'ouverture. */
  abort(): Promise<void>;
}

/** Lecture et écriture, pour une destination (SSD, plus tard Drive). */
export interface StorageBackend extends ReadableStorage {
  /** Crée le dossier et ses parents manquants. Sans effet s'il existe. */
  ensureDirectory(path: string): Promise<void>;
  /** Crée le fichier à partir d'un flux et renvoie le nombre d'octets écrits. */
  writeFile(path: string, source: ReadableStream<Uint8Array>, options?: WriteFileOptions): Promise<number>;
  openWriter(path: string, options?: OpenWriterOptions): Promise<ChunkWriter>;
  /** Renomme un dossier dans son dossier parent. Refus si le nouveau nom existe. */
  renameDirectory(path: string, newName: string): Promise<void>;
  /** Espace libre en octets, ou null si le support ne permet pas de le connaître. */
  freeSpace(): Promise<number | null>;
}
