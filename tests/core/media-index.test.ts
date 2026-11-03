import { describe, expect, it } from 'vitest';
import { CoreError } from '../../src/core/errors';
import {
  addEntry,
  createIndex,
  decideAfterHash,
  findByQuickKey,
  findBySha,
  type ImportCandidate,
  type IndexEntry,
  type MediaIndex,
  mergeIndexes,
  parseIndex,
  planImport,
  serializeIndex,
  verifyConsistency,
} from '../../src/core/media-index';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const INTERVENTION = '2026-10-18 Dolly et Max - Mont Granier';
const T0 = Date.UTC(2026, 9, 18, 12, 3, 20);

function entry(overrides: Partial<IndexEntry> = {}): IndexEntry {
  return {
    sha256: SHA_A,
    size: 1_000,
    name: 'DJI_0001.JPG',
    mtime: T0,
    path: `01 - Secours/2026/${INTERVENTION}/Drone M30T/DJI_0001.JPG`,
    source: 'Drone M30T',
    intervention: INTERVENTION,
    importedAt: '2026-10-18T16:00:00.000Z',
    ...overrides,
  };
}

function candidate(overrides: Partial<ImportCandidate> = {}): ImportCandidate {
  return { name: 'DJI_0001.JPG', size: 1_000, mtime: T0, relativePath: 'DCIM/DJI_001/DJI_0001.JPG', ...overrides };
}

function indexOf(...entries: IndexEntry[]): MediaIndex {
  return entries.reduce(addEntry, createIndex());
}

describe('index : ajout et recherche', () => {
  it('createIndex est vide et versionné', () => {
    expect(createIndex()).toEqual({ version: 1, entries: [] });
  });

  it('addEntry ne modifie pas l’index reçu', () => {
    const empty = createIndex();
    const frozen = Object.freeze({ ...empty, entries: Object.freeze([...empty.entries]) });
    const next = addEntry(frozen, entry());
    expect(frozen.entries).toHaveLength(0);
    expect(next.entries).toHaveLength(1);
    expect(next).not.toBe(frozen);
  });

  it('addEntry est idempotent pour la même empreinte au même endroit', () => {
    const once = addEntry(createIndex(), entry());
    expect(addEntry(once, entry())).toBe(once);
    expect(addEntry(once, entry({ sha256: SHA_A.toUpperCase() }))).toBe(once);
    expect(addEntry(once, entry({ path: 'ailleurs/DJI_0001.JPG' })).entries).toHaveLength(2);
  });

  it('addEntry refuse une entrée invalide', () => {
    expect(() => addEntry(createIndex(), entry({ sha256: 'xyz' }))).toThrow(CoreError);
    expect(() => addEntry(createIndex(), entry({ size: -1 }))).toThrow(CoreError);
    expect(() => addEntry(createIndex(), entry({ name: '' }))).toThrow(CoreError);
    expect(() => addEntry(createIndex(), entry({ importedAt: 'hier' }))).toThrow(CoreError);
  });

  it('findBySha retourne tous les emplacements, insensible à la casse', () => {
    const index = indexOf(entry(), entry({ path: 'copie/DJI_0001.JPG' }), entry({ sha256: SHA_B, name: 'DJI_0002.JPG', path: 'x/DJI_0002.JPG' }));
    expect(findBySha(index, SHA_A.toUpperCase())).toHaveLength(2);
    expect(findBySha(index, SHA_C)).toEqual([]);
  });

  it('findByQuickKey tolère 2 s sur la date (exFAT)', () => {
    const index = indexOf(entry());
    expect(findByQuickKey(index, { name: 'DJI_0001.JPG', size: 1_000, mtime: T0 + 2_000 })).toHaveLength(1);
    expect(findByQuickKey(index, { name: 'DJI_0001.JPG', size: 1_000, mtime: T0 - 1_999 })).toHaveLength(1);
    expect(findByQuickKey(index, { name: 'DJI_0001.JPG', size: 1_000, mtime: T0 + 2_001 })).toHaveLength(0);
    expect(findByQuickKey(index, { name: 'DJI_0001.JPG', size: 1_000, mtime: T0 + 5_000 }, 10_000)).toHaveLength(1);
    expect(findByQuickKey(index, { name: 'DJI_0001.JPG', size: 1_001, mtime: T0 })).toHaveLength(0);
    expect(findByQuickKey(index, { name: 'dji_0001.jpg', size: 1_000, mtime: T0 })).toHaveLength(0);
  });
});

describe('index : sérialisation', () => {
  it('aller-retour sans perte, une entrée par ligne', () => {
    const index = indexOf(entry({ cardId: 'carte-0123456789abcdef' }), entry({ sha256: SHA_B, path: 'x/Kévin/IMG_1.HEIC', source: 'Kévin', name: 'IMG_1.HEIC' }));
    const text = serializeIndex(index);
    expect(text.split('\n')).toHaveLength(5);
    expect(parseIndex(text)).toEqual(index);
    expect(parseIndex(serializeIndex(createIndex()))).toEqual(createIndex());
    expect(parseIndex(`﻿${text}`)).toEqual(index);
  });

  it.each([
    ['vide', ''],
    ['tronqué', serializeIndex(indexOf(entry())).slice(0, 80)],
    ['tableau', '[]'],
    ['nul', 'null'],
    ['version inconnue', '{"version": 2, "entries": []}'],
    ['sans entrées', '{"version": 1}'],
    ['entrée nulle', '{"version": 1, "entries": [null]}'],
    ['empreinte courte', JSON.stringify({ version: 1, entries: [{ ...entry(), sha256: 'abc' }] })],
    ['taille texte', JSON.stringify({ version: 1, entries: [{ ...entry(), size: '1000' }] })],
    ['taille décimale', JSON.stringify({ version: 1, entries: [{ ...entry(), size: 1.5 }] })],
    ['mtime absent', JSON.stringify({ version: 1, entries: [{ ...entry(), mtime: undefined }] })],
    ['chemin vide', JSON.stringify({ version: 1, entries: [{ ...entry(), path: '' }] })],
    ['carte non texte', JSON.stringify({ version: 1, entries: [{ ...entry(), cardId: 12 }] })],
  ])('refuse un index corrompu (%s) avec un message en français', (_label, text) => {
    let caught: unknown;
    try {
      parseIndex(text);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CoreError);
    expect((caught as CoreError).code).toBe('invalid-index');
    expect((caught as CoreError).userMessage).toMatch(/abîmé.*vérification complète/);
  });

  it('précise l’entrée en cause dans le détail', () => {
    const text = JSON.stringify({ version: 1, entries: [entry(), { ...entry(), sha256: 'zz' }] });
    expect(() => parseIndex(text)).toThrow(/entrée 2 : empreinte invalide/);
  });

  it('normalise l’empreinte en minuscules à la lecture', () => {
    const text = JSON.stringify({ version: 1, entries: [{ ...entry(), sha256: SHA_A.toUpperCase() }] });
    expect(parseIndex(text).entries[0]?.sha256).toBe(SHA_A);
  });
});

describe('mergeIndexes', () => {
  const a = indexOf(entry(), entry({ sha256: SHA_B, name: 'b.jpg', path: 'x/b.jpg' }));
  const b = indexOf(entry({ importedAt: '2026-10-19T10:00:00.000Z' }), entry({ sha256: SHA_C, name: 'c.jpg', path: 'x/c.jpg' }));

  it('union sans doublon, priorité à a', () => {
    const merged = mergeIndexes(a, b);
    expect(merged.entries.map((e) => e.sha256)).toEqual([SHA_A, SHA_B, SHA_C]);
    expect(merged.entries[0]?.importedAt).toBe('2026-10-18T16:00:00.000Z');
  });

  it('idempotent', () => {
    const merged = mergeIndexes(a, b);
    expect(mergeIndexes(merged, b)).toEqual(merged);
    expect(mergeIndexes(merged, merged)).toEqual(merged);
    expect(mergeIndexes(a, a)).toEqual(a);
    expect(mergeIndexes(createIndex(), createIndex())).toEqual(createIndex());
  });
});

describe('planImport', () => {
  const index = indexOf(
    entry(),
    entry({ sha256: SHA_B, name: 'DJI_0002.MP4', size: 5_000_000, path: 'x/DJI_0002.MP4' }),
  );

  it('copie, écarte ou fait hacher selon le pré-tri', () => {
    const candidates = [
      candidate(),
      candidate({ name: 'DJI_0002.MP4', size: 5_000_000, mtime: T0 + 60_000, relativePath: 'DCIM/DJI_0002.MP4' }),
      candidate({ name: 'DJI_0003.JPG', size: 2_000, relativePath: 'DCIM/DJI_0003.JPG' }),
      candidate({ name: 'DJI_0001.JPG', size: 999, relativePath: 'DCIM/autre/DJI_0001.JPG' }),
    ];
    const plan = planImport(index, candidates);
    expect(plan.files.map((f) => [f.candidate.relativePath, f.decision, f.reason])).toEqual([
      ['DCIM/DJI_001/DJI_0001.JPG', 'skip-quick', 'quick-match'],
      ['DCIM/DJI_0002.MP4', 'hash-then-decide', 'same-name-size'],
      ['DCIM/DJI_0003.JPG', 'copy', 'new'],
      ['DCIM/autre/DJI_0001.JPG', 'copy', 'new'],
    ]);
    expect(plan.files[0]?.match?.path).toContain('Drone M30T/DJI_0001.JPG');
    expect(plan.summary).toEqual({
      copy: { count: 2, bytes: 2_999 },
      'skip-quick': { count: 1, bytes: 1_000 },
      'hash-then-decide': { count: 1, bytes: 5_000_000 },
      total: { count: 4, bytes: 5_003_999 },
      bytesToRead: 5_002_999,
    });
    expect(plan.nothingNew).toBe(false);
  });

  it('réimport d’une carte déjà sauvegardée : rien de nouveau, sans relecture', () => {
    const plan = planImport(index, [candidate({ mtime: T0 + 1_000 }), candidate({ name: 'DJI_0002.MP4', size: 5_000_000 })]);
    expect(plan.summary['skip-quick'].count).toBe(2);
    expect(plan.summary.bytesToRead).toBe(0);
    expect(plan.nothingNew).toBe(true);
  });

  it('vérification complète : tout est haché', () => {
    const plan = planImport(index, [candidate(), candidate({ name: 'neuf.jpg' })], { fullVerification: true });
    expect(plan.files.every((f) => f.decision === 'hash-then-decide' && f.reason === 'full-verification')).toBe(true);
    expect(plan.summary.bytesToRead).toBe(2_000);
  });

  it('tolérance de date paramétrable', () => {
    expect(planImport(index, [candidate({ mtime: T0 + 3_000 })]).files[0]?.decision).toBe('hash-then-decide');
    expect(planImport(index, [candidate({ mtime: T0 + 3_000 })], { mtimeToleranceMs: 5_000 }).files[0]?.decision).toBe('skip-quick');
  });

  it('carte vide et index vide', () => {
    expect(planImport(index, []).nothingNew).toBe(true);
    expect(planImport(createIndex(), [candidate()]).files[0]?.decision).toBe('copy');
  });

  it('reste rapide sur un gros index', () => {
    let big = createIndex();
    const entries: IndexEntry[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      entries.push(entry({ sha256: i.toString(16).padStart(64, '0'), name: `F${i}.JPG`, path: `x/F${i}.JPG`, mtime: T0 + i }));
    }
    big = { version: 1, entries };
    const candidates = Array.from({ length: 5_000 }, (_, i) => candidate({ name: `F${i * 4}.JPG`, mtime: T0 + i * 4, relativePath: `F${i}` }));
    const start = performance.now();
    const plan = planImport(big, candidates);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(plan.nothingNew).toBe(true);
  });
});

describe('decideAfterHash', () => {
  const index = indexOf(entry());

  it('contenu déjà sauvegardé : emplacement existant', () => {
    const decision = decideAfterHash(index, { name: 'renomme.jpg' }, SHA_A.toUpperCase(), []);
    expect(decision.decision).toBe('duplicate');
    if (decision.decision === 'duplicate') {
      expect(decision.existing.path).toContain('Drone M30T/DJI_0001.JPG');
      expect(decision.locations).toHaveLength(1);
    }
  });

  it('même nom, contenu différent : nom suffixé', () => {
    expect(decideAfterHash(index, { name: 'DJI_0001.JPG' }, SHA_B, ['DJI_0001.JPG', 'DJI_0001_2.JPG'])).toEqual({
      decision: 'copy-as',
      targetName: 'DJI_0001_3.JPG',
    });
  });

  it('nouveau contenu, nom libre : copie sous le nom d’origine', () => {
    expect(decideAfterHash(index, { name: 'DJI_0009.JPG' }, SHA_C, ['DJI_0001.JPG'])).toEqual({ decision: 'copy', targetName: 'DJI_0009.JPG' });
  });
});

describe('verifyConsistency', () => {
  const expected = [
    { path: 'a.jpg', size: 10 },
    { path: 'b.mp4', size: 20 },
  ];

  it('identique', () => {
    expect(verifyConsistency(expected, [...expected].reverse())).toEqual({
      ok: true,
      expectedCount: 2,
      actualCount: 2,
      expectedBytes: 30,
      actualBytes: 30,
      missing: [],
      unexpected: [],
      sizeMismatches: [],
    });
  });

  it('liste les écarts', () => {
    const report = verifyConsistency(expected, [
      { path: 'a.jpg', size: 9 },
      { path: 'c.srt', size: 1 },
    ]);
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(['b.mp4']);
    expect(report.unexpected).toEqual(['c.srt']);
    expect(report.sizeMismatches).toEqual([{ path: 'a.jpg', expected: 10, actual: 9 }]);
  });

  it('détecte un fichier en double dans la copie', () => {
    const report = verifyConsistency(expected, [...expected, { path: 'a.jpg', size: 10 }]);
    expect(report.ok).toBe(false);
    expect(report.actualCount).toBe(3);
  });
});
