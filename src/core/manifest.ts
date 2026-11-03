/*
 * Manifeste `_esam.json` déposé dans chaque dossier d'intervention (lot 7), lu par
 * l'outil de dérushage (julok35/esam-derushage) : liste des fichiers, source,
 * empreinte, date de prise de vue, durée, type.
 *
 * Chemins relatifs au dossier d'intervention (« Drone M30T/DJI_0001.JPG »).
 */
import { CoreError } from './errors';

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILE_NAME = '_esam.json';

export type MediaType = 'video' | 'photo' | 'thermal' | 'subtitle' | 'lowres' | 'other';

export interface ManifestFile {
  path: string;
  source: string;
  sha256: string;
  size: number;
  /** Date de prise de vue, ISO 8601. */
  captureDate?: string;
  durationSec?: number;
  type: MediaType;
}

export interface EsamManifest {
  version: typeof MANIFEST_VERSION;
  intervention: string;
  generatedAt: string;
  files: ManifestFile[];
}

const VIDEO = new Set(['mp4', 'mov', 'm4v', 'avi', 'mkv', 'mts', 'm2ts', '3gp', 'insv', '360']);
const PHOTO = new Set(['jpg', 'jpeg', 'heic', 'heif', 'png', 'webp', 'dng', 'raw', 'arw', 'cr2', 'cr3', 'nef', 'orf', 'rw2', 'gpr', 'insp']);
const LOWRES = new Set(['lrf', 'lrv']);
const SUBTITLE = new Set(['srt']);
const TYPES: readonly MediaType[] = ['video', 'photo', 'thermal', 'subtitle', 'lowres', 'other'];

/**
 * Type d'un fichier d'après son nom :
 * - vidéo : MP4, MOV et autres conteneurs courants ;
 * - photo : JPG, HEIC, PNG, formats bruts ;
 * - thermique : photo dont le nom se termine par `_T` (R-JPEG du M30T :
 *   DJI_20261018140321_0001_T.JPG) ; la vidéo thermique `_T.MP4` reste « vidéo » ;
 * - sous-titre : SRT (télémétrie DJI) ;
 * - basse résolution : LRF (DJI), LRV (GoPro) ;
 * - autre : tout le reste.
 */
export function classifyFile(name: string): MediaType {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'other';
  const base = name.slice(0, dot);
  const extension = name.slice(dot + 1).toLowerCase();
  if (VIDEO.has(extension)) return 'video';
  if (PHOTO.has(extension)) return /_T$/i.test(base) && (extension === 'jpg' || extension === 'jpeg') ? 'thermal' : 'photo';
  if (SUBTITLE.has(extension)) return 'subtitle';
  if (LOWRES.has(extension)) return 'lowres';
  return 'other';
}

export type ManifestFileInput = Omit<ManifestFile, 'type'> & { type?: MediaType };

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function complete(file: ManifestFileInput): ManifestFile {
  return { ...file, sha256: file.sha256.toLowerCase(), type: file.type ?? classifyFile(file.path.split('/').pop() ?? file.path) };
}

/**
 * Construit un manifeste trié par chemin. Si un chemin apparaît deux fois, la
 * dernière occurrence l'emporte (fusion des champs renseignés).
 */
export function buildManifest(input: { intervention: string; generatedAt: string; files: readonly ManifestFileInput[] }): EsamManifest {
  return mergeManifest({ version: MANIFEST_VERSION, intervention: input.intervention, generatedAt: input.generatedAt, files: [] }, input.files, input.generatedAt);
}

/**
 * Ajoute des fichiers à un manifeste existant, sans doublon de chemin : pour un
 * chemin déjà présent, les champs renseignés de l'ajout remplacent les anciens
 * (une durée calculée plus tard complète l'entrée). Retourne un nouveau manifeste.
 */
export function mergeManifest(existing: EsamManifest, additions: readonly ManifestFileInput[], generatedAt: string = existing.generatedAt): EsamManifest {
  const byPath = new Map<string, ManifestFile>(existing.files.map((f) => [f.path, { ...f }]));
  for (const addition of additions) {
    const completed = complete(addition);
    const previous = byPath.get(completed.path);
    if (!previous) {
      byPath.set(completed.path, completed);
      continue;
    }
    const merged: ManifestFile = { ...previous };
    for (const [key, value] of Object.entries(completed) as [keyof ManifestFile, ManifestFile[keyof ManifestFile]][]) {
      if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
    }
    // Un type déduit du nom ne remplace pas un type donné explicitement auparavant.
    if (addition.type === undefined) merged.type = previous.type;
    byPath.set(completed.path, merged);
  }
  const files = [...byPath.values()].sort((a, b) => compareStrings(a.path, b.path));
  return { version: MANIFEST_VERSION, intervention: existing.intervention, generatedAt, files };
}

/** JSON indenté, lisible à l'oeil, terminé par un saut de ligne. */
export function serializeManifest(manifest: EsamManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Lit et valide un `_esam.json`. Lève CoreError('invalid-manifest') s'il est abîmé. */
export function parseManifest(text: string): EsamManifest {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new CoreError('invalid-manifest', 'JSON illisible (fichier tronqué ?)');
  }
  const fail = (reason: string): never => {
    throw new CoreError('invalid-manifest', reason);
  };
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return fail('pas un objet');
  const root = data as Record<string, unknown>;
  if (root.version !== MANIFEST_VERSION) fail(`version inconnue : ${JSON.stringify(root.version)}`);
  if (typeof root.intervention !== 'string' || root.intervention === '') fail('intervention manquante');
  if (typeof root.generatedAt !== 'string' || Number.isNaN(Date.parse(root.generatedAt))) fail('date de génération invalide');
  if (!Array.isArray(root.files)) return fail('liste des fichiers absente');
  const seen = new Set<string>();
  const files = root.files.map((raw: unknown, i: number): ManifestFile => {
    const where = `fichier ${i + 1}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail(`${where} : pas un objet`);
    const f = raw as Record<string, unknown>;
    if (typeof f.path !== 'string' || f.path === '') fail(`${where} : chemin manquant`);
    if (seen.has(f.path as string)) fail(`${where} : chemin en double`);
    seen.add(f.path as string);
    if (typeof f.source !== 'string') fail(`${where} : source manquante`);
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(f.sha256)) fail(`${where} : empreinte invalide`);
    if (typeof f.size !== 'number' || !Number.isSafeInteger(f.size) || f.size < 0) fail(`${where} : taille invalide`);
    if (typeof f.type !== 'string' || !TYPES.includes(f.type as MediaType)) fail(`${where} : type inconnu`);
    if (f.captureDate !== undefined && (typeof f.captureDate !== 'string' || Number.isNaN(Date.parse(f.captureDate)))) {
      fail(`${where} : date de prise de vue invalide`);
    }
    if (f.durationSec !== undefined && (typeof f.durationSec !== 'number' || !Number.isFinite(f.durationSec) || f.durationSec < 0)) {
      fail(`${where} : durée invalide`);
    }
    const file: ManifestFile = {
      path: f.path as string,
      source: f.source as string,
      sha256: (f.sha256 as string).toLowerCase(),
      size: f.size as number,
      type: f.type as MediaType,
    };
    if (f.captureDate !== undefined) file.captureDate = f.captureDate as string;
    if (f.durationSec !== undefined) file.durationSec = f.durationSec as number;
    return file;
  });
  return { version: MANIFEST_VERSION, intervention: root.intervention as string, generatedAt: root.generatedAt as string, files };
}
