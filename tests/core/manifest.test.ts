import { describe, expect, it } from 'vitest';
import { CoreError } from '../../src/core/errors';
import { buildManifest, classifyFile, type EsamManifest, mergeManifest, parseManifest, serializeManifest } from '../../src/core/manifest';

const INTERVENTION = '2026-10-18 Dolly et Max - Mont Granier';
const SHA = (c: string): string => c.repeat(64);

describe('classifyFile', () => {
  it.each([
    ['DJI_20261018140321_0001_W.MP4', 'video'],
    ['DJI_20261018140321_0002_T.MP4', 'video'],
    ['clip.mov', 'video'],
    ['GX010001.MP4', 'video'],
    ['DJI_20261018140321_0001_W.JPG', 'photo'],
    ['DJI_20261018140321_0001_Z.JPG', 'photo'],
    ['IMG_1234.HEIC', 'photo'],
    ['photo.jpeg', 'photo'],
    ['DJI_20261018140321_0001_T.JPG', 'thermal'],
    ['dji_0001_t.jpg', 'thermal'],
    ['DJI_20261018140321_0001_W.SRT', 'subtitle'],
    ['DJI_20261018140321_0001_W.LRF', 'lowres'],
    ['GL010001.LRV', 'lowres'],
    ['SANT_T.DNG', 'photo'],
    ['notes.txt', 'other'],
    ['README', 'other'],
    ['.nomedia', 'other'],
  ])('%s : %s', (name, type) => {
    expect(classifyFile(name)).toBe(type);
  });
});

describe('buildManifest et mergeManifest', () => {
  const base = buildManifest({
    intervention: INTERVENTION,
    generatedAt: '2026-10-18T16:00:00.000Z',
    files: [
      { path: 'Drone M30T/DJI_0002_W.MP4', source: 'Drone M30T', sha256: SHA('B'), size: 2_000, captureDate: '2026-10-18T14:03:21+02:00' },
      { path: 'Drone M30T/DJI_0001_T.JPG', source: 'Drone M30T', sha256: SHA('a'), size: 1_000 },
      { path: 'Kévin/IMG_1.HEIC', source: 'Kévin', sha256: SHA('c'), size: 500 },
    ],
  });

  it('trie par chemin, déduit le type, empreinte en minuscules', () => {
    expect(base.version).toBe(1);
    expect(base.files.map((f) => [f.path, f.type])).toEqual([
      ['Drone M30T/DJI_0001_T.JPG', 'thermal'],
      ['Drone M30T/DJI_0002_W.MP4', 'video'],
      ['Kévin/IMG_1.HEIC', 'photo'],
    ]);
    expect(base.files[1]?.sha256).toBe(SHA('b'));
  });

  it('fusion sans doublon de chemin, complète les champs', () => {
    const merged = mergeManifest(
      base,
      [
        { path: 'Drone M30T/DJI_0002_W.MP4', source: 'Drone M30T', sha256: SHA('b'), size: 2_000, durationSec: 95.4 },
        { path: 'Drone M30T/DJI_0002_W.SRT', source: 'Drone M30T', sha256: SHA('d'), size: 30 },
      ],
      '2026-10-19T08:00:00.000Z',
    );
    expect(merged.files).toHaveLength(4);
    expect(merged.generatedAt).toBe('2026-10-19T08:00:00.000Z');
    expect(merged.files.find((f) => f.path.endsWith('_W.MP4'))).toMatchObject({ durationSec: 95.4, captureDate: '2026-10-18T14:03:21+02:00', type: 'video' });
    expect(base.files).toHaveLength(3);
    expect(base.files[1]).not.toHaveProperty('durationSec');
    expect(mergeManifest(merged, merged.files)).toEqual(merged);
  });

  it('un type explicite n’est pas écrasé par le type déduit', () => {
    const custom = mergeManifest(base, [{ path: 'Kévin/IMG_1.HEIC', source: 'Kévin', sha256: SHA('c'), size: 500, type: 'other' }]);
    const again = mergeManifest(custom, [{ path: 'Kévin/IMG_1.HEIC', source: 'Kévin', sha256: SHA('c'), size: 500 }]);
    expect(again.files.find((f) => f.source === 'Kévin')?.type).toBe('other');
  });

  it('doublon dans les fichiers fournis : une seule entrée', () => {
    const m = buildManifest({
      intervention: INTERVENTION,
      generatedAt: '2026-10-18T16:00:00.000Z',
      files: [
        { path: 'a.jpg', source: 's', sha256: SHA('a'), size: 1 },
        { path: 'a.jpg', source: 's', sha256: SHA('a'), size: 1, durationSec: 0 },
      ],
    });
    expect(m.files).toEqual([{ path: 'a.jpg', source: 's', sha256: SHA('a'), size: 1, durationSec: 0, type: 'photo' }]);
  });
});

describe('serializeManifest et parseManifest', () => {
  const manifest: EsamManifest = buildManifest({
    intervention: INTERVENTION,
    generatedAt: '2026-10-18T16:00:00.000Z',
    files: [{ path: 'Drone M30T/DJI_0001_W.MP4', source: 'Drone M30T', sha256: SHA('a'), size: 10, captureDate: '2026-10-18T12:03:21.000Z', durationSec: 12.5 }],
  });

  it('aller-retour', () => {
    const text = serializeManifest(manifest);
    expect(text.endsWith('}\n')).toBe(true);
    expect(parseManifest(text)).toEqual(manifest);
    expect(parseManifest(`﻿${text}`)).toEqual(manifest);
  });

  const valid = JSON.parse(serializeManifest(manifest)) as Record<string, unknown>;
  const file = (valid.files as Record<string, unknown>[])[0] as Record<string, unknown>;
  const withFile = (changes: Record<string, unknown>): string => JSON.stringify({ ...valid, files: [{ ...file, ...changes }] });

  it.each([
    ['JSON tronqué', serializeManifest(manifest).slice(0, 50)],
    ['tableau', '[]'],
    ['version', JSON.stringify({ ...valid, version: 3 })],
    ['intervention vide', JSON.stringify({ ...valid, intervention: '' })],
    ['date de génération', JSON.stringify({ ...valid, generatedAt: 'hier' })],
    ['fichiers absents', JSON.stringify({ ...valid, files: null })],
    ['fichier nul', JSON.stringify({ ...valid, files: [null] })],
    ['chemin vide', withFile({ path: '' })],
    ['empreinte', withFile({ sha256: '123' })],
    ['taille négative', withFile({ size: -4 })],
    ['type inconnu', withFile({ type: 'audio' })],
    ['date de prise de vue', withFile({ captureDate: 'demain' })],
    ['durée', withFile({ durationSec: 'longue' })],
    ['source', withFile({ source: 4 })],
    ['chemin en double', JSON.stringify({ ...valid, files: [file, file] })],
  ])('refuse un manifeste abîmé (%s)', (_label, text) => {
    let caught: unknown;
    try {
      parseManifest(text);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CoreError);
    expect((caught as CoreError).code).toBe('invalid-manifest');
    expect((caught as CoreError).userMessage).toContain('_esam.json');
  });
});
