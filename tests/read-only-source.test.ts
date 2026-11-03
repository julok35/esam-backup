import { describe, expect, it } from 'vitest';
import { ReadOnlySource, type ReadableStorage, type StorageBackend } from '../src/storage';
import { FakeDirectoryHandle, readAll } from './helpers/fake-fs';

// Toute méthode capable de modifier un support, sur StorageBackend ou sur l'API navigateur.
const WRITE_METHODS = [
  'ensureDirectory',
  'writeFile',
  'openWriter',
  'renameDirectory',
  'freeSpace',
  'createWritable',
  'removeEntry',
  'move',
  'remove',
  'write',
  'delete',
  'rename',
  'mkdir',
];

function allPropertyNames(obj: object): Set<string> {
  const names = new Set<string>();
  for (let o: object | null = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) {
    for (const name of Object.getOwnPropertyNames(o)) names.add(name);
  }
  return names;
}

function makeCard(): FakeDirectoryHandle {
  return FakeDirectoryHandle.from('DJI_M30T', {
    DCIM: {
      DJI_001: { 'DJI_0001.MP4': 'video', 'DJI_0001.SRT': 'srt' },
    },
    'MISC.TXT': 'misc',
  });
}

describe('ReadOnlySource', () => {
  it("n'expose aucune méthode d'écriture", () => {
    const source = new ReadOnlySource(makeCard().asHandle());
    const names = allPropertyNames(source);
    for (const method of WRITE_METHODS) expect(names.has(method), method).toBe(false);
  });

  it('ne laisse pas atteindre la poignée du dossier', () => {
    const card = makeCard();
    const source = new ReadOnlySource(card.asHandle());
    const values = Object.getOwnPropertyNames(source).map((name) => (source as unknown as Record<string, unknown>)[name]);
    expect(values).not.toContain(card);
    expect(Object.keys(source)).toEqual(['label']);
  });

  it("est gelée : impossible d'ajouter une méthode après coup", () => {
    const source = new ReadOnlySource(makeCard().asHandle());
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(ReadOnlySource.prototype)).toBe(true);
    expect(() => {
      (source as unknown as Record<string, unknown>).writeFile = () => undefined;
    }).toThrow(TypeError);
  });

  it("n'est pas utilisable là où un stockage inscriptible est attendu (vérifié par tsc)", () => {
    const source = new ReadOnlySource(makeCard().asHandle());
    const readable: ReadableStorage = source;
    // @ts-expect-error une source en lecture seule ne doit jamais passer pour un StorageBackend
    const writable: StorageBackend = source;
    expect(readable).toBe(writable);
  });

  it('lit la carte sans aucune opération de modification', async () => {
    const card = makeCard();
    const source = new ReadOnlySource(card.asHandle());

    expect(source.label).toBe('DJI_M30T');
    const root = await source.list('');
    expect(root.map((e) => `${e.kind}:${e.name}`).sort()).toEqual(['directory:DCIM', 'file:MISC.TXT']);

    const clips = await source.list('DCIM/DJI_001');
    expect(clips.find((e) => e.name === 'DJI_0001.MP4')).toMatchObject({ kind: 'file', size: 5 });

    const handle = await source.openRead('DCIM/DJI_001/DJI_0001.MP4');
    expect(handle.size).toBe(5);
    expect(await readAll(handle.stream)).toBe('video');
    expect(await readAll((await source.openRead('DCIM/DJI_001/DJI_0001.MP4', { start: 2 })).stream)).toBe('deo');

    expect(await source.exists('DCIM/DJI_001/DJI_0001.SRT')).toBe(true);
    expect(await source.exists('DCIM/absent.MP4')).toBe(false);
    expect(await source.exists('ABSENT/x')).toBe(false);
    expect(await source.stat('DCIM')).toMatchObject({ kind: 'directory' });

    await expect(source.openRead('DCIM/absent.MP4')).rejects.toMatchObject({ code: 'not-found' });
    await expect(source.list('../x')).rejects.toMatchObject({ code: 'invalid-path' });

    expect(card.log.mutations).toEqual([]);
  });

  it('reconnaît son propre dossier', async () => {
    const card = makeCard();
    const source = new ReadOnlySource(card.asHandle());
    expect(await source.isSameRoot(card.asHandle())).toBe(true);
    expect(await source.isSameRoot(makeCard().asHandle())).toBe(false);
  });
});
