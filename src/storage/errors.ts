export type StorageErrorCode =
  | 'not-found'
  | 'already-exists'
  | 'wrong-kind'
  | 'permission'
  | 'unavailable'
  | 'no-space'
  | 'unsupported'
  | 'invalid-path'
  | 'aborted'
  | 'unknown';

/** Messages pour l'utilisateur : dire quoi faire, sans jargon. */
const USER_MESSAGES: Record<StorageErrorCode, string> = {
  'not-found': "Fichier ou dossier introuvable. Vérifiez que le bon support est branché.",
  'already-exists': 'Un élément porte déjà ce nom. Choisissez un autre nom.',
  'wrong-kind': "L'élément attendu n'est pas du bon type (fichier ou dossier).",
  permission: "L'accès a été refusé. Autorisez l'accès au dossier puis réessayez.",
  unavailable: 'Le support ne répond plus. Rebranchez-le puis choisissez à nouveau le dossier.',
  'no-space': "Plus assez de place sur le support. Libérez de l'espace puis réessayez.",
  unsupported: "Cette opération n'est pas possible sur ce téléphone.",
  'invalid-path': 'Nom de fichier ou de dossier non valable.',
  aborted: 'Opération annulée.',
  unknown: 'Une erreur inattendue est survenue. Réessayez.',
};

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly userMessage: string;
  override readonly cause: unknown;

  constructor(code: StorageErrorCode, detail?: string, cause?: unknown) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'StorageError';
    this.code = code;
    this.userMessage = USER_MESSAGES[code];
    this.cause = cause;
  }
}

/** Traduit une erreur du navigateur (DOMException de File System Access) en StorageError. */
export function toStorageError(error: unknown, detail?: string): StorageError {
  if (error instanceof StorageError) return error;
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  switch (name) {
    case 'NotFoundError':
      return new StorageError('not-found', detail, error);
    case 'TypeMismatchError':
      return new StorageError('wrong-kind', detail, error);
    case 'NotAllowedError':
    case 'SecurityError':
    case 'NoModificationAllowedError':
      return new StorageError('permission', detail, error);
    case 'InvalidStateError':
      return new StorageError('unavailable', detail, error);
    case 'QuotaExceededError':
      return new StorageError('no-space', detail, error);
    case 'InvalidModificationError':
      return new StorageError('already-exists', detail, error);
    case 'AbortError':
      return new StorageError('aborted', detail, error);
    case 'NotSupportedError':
      return new StorageError('unsupported', detail, error);
    default:
      return new StorageError('unknown', detail, error);
  }
}
