import { StorageError } from './errors';

const FORBIDDEN_SEGMENTS = new Set(['.', '..']);

/** Vérifie un nom isolé (fichier ou dossier) : non vide, sans séparateur, ni "." ni "..". */
export function assertValidName(name: string): void {
  if (name.length === 0 || FORBIDDEN_SEGMENTS.has(name) || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new StorageError('invalid-path', JSON.stringify(name));
  }
}

/** Découpe un chemin relatif en segments. "" ou "/" donne la racine (tableau vide). */
export function splitPath(path: string): string[] {
  const segments = path.split('/').filter((s) => s.length > 0);
  for (const segment of segments) assertValidName(segment);
  return segments;
}

/** Sépare le dernier segment (nom) de son dossier parent. Refuse la racine. */
export function splitParent(path: string): { parent: string[]; name: string } {
  const segments = splitPath(path);
  const name = segments.pop();
  if (name === undefined) throw new StorageError('invalid-path', 'racine');
  return { parent: segments, name };
}

export function joinPath(...parts: string[]): string {
  return parts
    .flatMap((p) => p.split('/'))
    .filter((s) => s.length > 0)
    .join('/');
}
