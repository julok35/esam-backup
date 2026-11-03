import { describe, expect, it } from 'vitest';
import {
  assessCardHealth,
  canonicalFingerprintText,
  type CardAction,
  cardFingerprint,
  type CardFile,
  type CardRecord,
  CardTransitionError,
  createCardRecord,
  displayStatus,
  fnv1a64,
  type ImportStats,
  matchCard,
  MAX_HISTORY,
  median,
  recordImportStats,
  selectOldestFiles,
  transitionCard,
  utf8Bytes,
} from '../../src/core/card';
import { CoreError } from '../../src/core/errors';

const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);
const AT = '2026-10-18T16:00:00.000Z';

function files(count: number, prefix = 'DJI_'): CardFile[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}${String(i + 1).padStart(4, '0')}.JPG`,
    size: 4_000_000 + i,
    mtime: T0 + i * 60_000,
  }));
}

describe('FNV-1a 64 bits', () => {
  it('donne les valeurs de référence', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });

  it('encode en UTF-8', () => {
    expect(utf8Bytes('é')).toEqual([0xc3, 0xa9]);
    expect(utf8Bytes('€')).toEqual([0xe2, 0x82, 0xac]);
    expect(utf8Bytes('\u{1F415}')).toEqual([0xf0, 0x9f, 0x90, 0x95]);
    expect(fnv1a64('Kévin')).not.toBe(fnv1a64('Kevin'));
  });
});

describe('selectOldestFiles', () => {
  it('trie par date puis nom, sans modifier la liste reçue', () => {
    const list: CardFile[] = [
      { name: 'b.jpg', size: 1, mtime: 5 },
      { name: 'a.jpg', size: 1, mtime: 5 },
      { name: 'z.jpg', size: 1, mtime: 1 },
      { name: 'a.jpg', size: 0, mtime: 5 },
    ];
    const copy = structuredClone(list);
    expect(selectOldestFiles(list, 3).map((f) => `${f.name}:${f.size}`)).toEqual(['z.jpg:1', 'a.jpg:0', 'a.jpg:1']);
    expect(list).toEqual(copy);
    expect(selectOldestFiles(list, 0)).toEqual([]);
    expect(selectOldestFiles(files(25))).toHaveLength(10);
  });
});

describe('cardFingerprint', () => {
  it('stable quel que soit l’ordre de la liste', () => {
    const list = files(30);
    const a = cardFingerprint({ volumeName: 'DJI M30T', oldestFiles: list });
    const b = cardFingerprint({ volumeName: ' DJI M30T ', oldestFiles: [...list].reverse() });
    expect(a.id).toMatch(/^carte-[0-9a-f]{16}$/);
    expect(b.id).toBe(a.id);
    expect(a.oldestFiles).toHaveLength(10);
  });

  it('change avec le volume ou un fichier ancien, pas avec un fichier récent', () => {
    const list = files(30);
    const base = cardFingerprint({ volumeName: 'DJI M30T', oldestFiles: list });
    expect(cardFingerprint({ volumeName: 'SANDISK', oldestFiles: list }).id).not.toBe(base.id);
    const altered = list.map((f, i) => (i === 0 ? { ...f, size: f.size + 1 } : f));
    expect(cardFingerprint({ volumeName: 'DJI M30T', oldestFiles: altered }).id).not.toBe(base.id);
    const newer = [...list, { name: 'NOUVEAU.JPG', size: 1, mtime: T0 + 999_999_999 }];
    expect(cardFingerprint({ volumeName: 'DJI M30T', oldestFiles: newer }).id).toBe(base.id);
  });

  it('ignore les millisecondes de la date', () => {
    const list = files(3);
    const jitter = list.map((f) => ({ ...f, mtime: f.mtime + 400 }));
    expect(cardFingerprint({ volumeName: 'X', oldestFiles: jitter }).id).toBe(cardFingerprint({ volumeName: 'X', oldestFiles: list }).id);
  });

  it('sérialisation canonique lisible', () => {
    expect(canonicalFingerprintText('X', [{ name: 'a', size: 1, mtime: 2_500 }])).toBe('{"v":1,"volume":"X","files":[["a",1,2]]}');
  });
});

describe('matchCard', () => {
  const list = files(40);
  const known = [
    { fingerprint: cardFingerprint({ volumeName: 'DJI M30T', oldestFiles: list }), label: 'drone' },
    { fingerprint: cardFingerprint({ volumeName: 'GOPRO', oldestFiles: files(40, 'GOPR') }), label: 'gopro' },
  ];

  it('correspondance exacte', () => {
    const match = matchCard(known, cardFingerprint({ volumeName: 'DJI M30T', oldestFiles: [...list].reverse() }));
    expect(match).toMatchObject({ kind: 'exact', score: 1, commonFiles: 10 });
    expect(match?.card.label).toBe('drone');
  });

  it('carte dont on a supprimé 3 anciens fichiers : reconnue', () => {
    const match = matchCard(known, cardFingerprint({ volumeName: 'dji m30t', oldestFiles: list.slice(3) }));
    expect(match).toMatchObject({ kind: 'tolerant', commonFiles: 7 });
    expect(match?.score).toBeCloseTo(0.7);
    expect(match?.card.label).toBe('drone');
  });

  it('carte dont on a supprimé 4 anciens fichiers : non reconnue (seuil 7 sur 10)', () => {
    expect(matchCard(known, cardFingerprint({ volumeName: 'DJI M30T', oldestFiles: list.slice(4) }))).toBeNull();
    expect(matchCard(known, cardFingerprint({ volumeName: 'DJI M30T', oldestFiles: list.slice(4) }), { minCommon: 6 })?.commonFiles).toBe(6);
  });

  it('autre volume avec les mêmes fichiers : non reconnue en tolérant', () => {
    expect(matchCard(known, cardFingerprint({ volumeName: 'AUTRE', oldestFiles: list.slice(1) }))).toBeNull();
  });

  it('petite carte : seuil ramené à 70 % de ses fichiers', () => {
    // 5 fichiers connus : 4 doivent être retrouvés (70 % arrondi au-dessus).
    const small = [{ fingerprint: cardFingerprint({ volumeName: 'TEL', oldestFiles: files(5) }) }];
    expect(matchCard(small, cardFingerprint({ volumeName: 'TEL', oldestFiles: files(5).slice(1) }))?.kind).toBe('tolerant');
    expect(matchCard(small, cardFingerprint({ volumeName: 'TEL', oldestFiles: files(5).slice(2) }))).toBeNull();
  });

  it('carte vide ou liste inconnue', () => {
    expect(matchCard(known, cardFingerprint({ volumeName: 'DJI M30T', oldestFiles: [] }))).toBeNull();
    expect(matchCard([], cardFingerprint({ volumeName: 'DJI M30T', oldestFiles: list }))).toBeNull();
  });

  it('garde le meilleur score', () => {
    const twins = [
      { fingerprint: cardFingerprint({ volumeName: 'X', oldestFiles: list.slice(2, 12) }), label: 'moins bien' },
      { fingerprint: cardFingerprint({ volumeName: 'X', oldestFiles: list.slice(1, 11) }), label: 'meilleur' },
    ];
    expect(matchCard(twins, cardFingerprint({ volumeName: 'X', oldestFiles: list }))?.card.label).toBe('meilleur');
  });
});

describe('statuts des cartes', () => {
  const fp = cardFingerprint({ volumeName: 'DJI M30T', oldestFiles: files(12) });
  const saved = createCardRecord(fp, AT, 'Carte drone 1');
  const archived = transitionCard(saved, { type: 'mark-archived', at: '2026-10-20T10:00:00.000Z', confirmed: true });
  const free = transitionCard(archived, { type: 'mark-free', at: '2026-10-21T10:00:00.000Z' });

  function expectRefused(card: CardRecord, action: CardAction, code: string): void {
    let caught: unknown;
    try {
      transitionCard(card, action);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CardTransitionError);
    expect(caught).toBeInstanceOf(CoreError);
    expect((caught as CardTransitionError).code).toBe(code);
    expect((caught as CardTransitionError).from).toBe(card.status);
    expect((caught as CardTransitionError).userMessage.length).toBeGreaterThan(10);
  }

  it('parcours nominal : sauvegardée, archivée, libre', () => {
    expect(saved).toMatchObject({ id: fp.id, status: 'sauvegardee', label: 'Carte drone 1', pendingNewContent: false, history: [] });
    expect(archived).toMatchObject({ status: 'archivee', archivedConfirmedAt: '2026-10-20T10:00:00.000Z', statusChangedAt: '2026-10-20T10:00:00.000Z' });
    expect(free).toMatchObject({ status: 'libre', statusChangedAt: '2026-10-21T10:00:00.000Z' });
    expect(saved.status).toBe('sauvegardee');
  });

  it('archivage : confirmation obligatoire', () => {
    expectRefused(saved, { type: 'mark-archived', at: AT, confirmed: false }, 'confirmation-required');
  });

  it('libre : seulement depuis archivée', () => {
    expectRefused(saved, { type: 'mark-free', at: AT }, 'not-archived');
    expectRefused(free, { type: 'mark-free', at: AT }, 'already-free');
    expectRefused(free, { type: 'mark-archived', at: AT, confirmed: true }, 'already-free');
  });

  it('archiver deux fois ne change rien', () => {
    const again = transitionCard(archived, { type: 'mark-archived', at: '2026-12-01T00:00:00.000Z', confirmed: true });
    expect(again).toEqual(archived);
    expect(again).not.toBe(archived);
  });

  it('nouveau contenu sur une carte libre ou archivée : repasse à sauvegardée', () => {
    for (const card of [free, archived]) {
      const seen = transitionCard(card, { type: 'new-content-seen', at: '2026-11-01T08:00:00.000Z' });
      expect(seen).toMatchObject({ status: 'sauvegardee', pendingNewContent: true, statusChangedAt: '2026-11-01T08:00:00.000Z' });
      expect(displayStatus(seen)).toMatchObject({ advice: 'Ne pas formater', canFormat: false, label: 'Sauvegarde à terminer' });
      expectRefused(seen, { type: 'mark-archived', at: AT, confirmed: true }, 'pending-new-content');
      const done = transitionCard(seen, { type: 'import-ok', at: '2026-11-01T09:00:00.000Z', newFiles: 4 });
      expect(done).toMatchObject({ status: 'sauvegardee', pendingNewContent: false, lastImportAt: '2026-11-01T09:00:00.000Z' });
      expect(displayStatus(done).label).toBe('Sauvegardée');
    }
  });

  it('import sans rien de nouveau : statut inchangé', () => {
    const again = transitionCard(free, { type: 'import-ok', at: '2026-11-02T08:00:00.000Z', newFiles: 0 });
    expect(again.status).toBe('libre');
    expect(again.lastImportAt).toBe('2026-11-02T08:00:00.000Z');
    expect(again.statusChangedAt).toBe(free.statusChangedAt);
    const withNew = transitionCard(free, { type: 'import-ok', at: '2026-11-02T08:00:00.000Z', newFiles: 2 });
    expect(withNew.status).toBe('sauvegardee');
  });

  it('ne modifie jamais la fiche reçue', () => {
    const frozen = Object.freeze({ ...saved, history: Object.freeze([]) as unknown as ImportStats[] });
    transitionCard(frozen, { type: 'new-content-seen', at: AT });
    transitionCard(frozen, { type: 'mark-archived', at: AT, confirmed: true });
    expect(frozen.status).toBe('sauvegardee');
  });

  it('libellés en français', () => {
    expect(displayStatus(saved)).toMatchObject({ label: 'Sauvegardée', advice: 'Ne pas formater', canFormat: false });
    expect(displayStatus(archived)).toMatchObject({ label: 'Archivée', advice: 'Ne pas formater', canFormat: false });
    expect(displayStatus(free)).toMatchObject({ label: 'Libre', advice: 'Formatable', canFormat: true });
  });
});

describe('santé des cartes', () => {
  const fp = cardFingerprint({ volumeName: 'DJI M30T', oldestFiles: files(12) });
  const GB = 1_000_000_000;

  function withHistory(stats: Partial<ImportStats>[]): CardRecord {
    return stats.reduce<CardRecord>(
      (card, s, i) => recordImportStats(card, { at: `2026-10-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`, files: 100, bytes: 10 * GB, durationMs: 100_000, readErrors: 0, ...s }),
      createCardRecord(fp, AT),
    );
  }

  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it('recordImportStats ajoute sans modifier et borne l’historique', () => {
    const card = createCardRecord(fp, AT);
    const next = recordImportStats(card, { at: AT, files: 1, bytes: 1, durationMs: 1, readErrors: 0 });
    expect(card.history).toHaveLength(0);
    expect(next.history).toHaveLength(1);
    expect(withHistory(Array.from({ length: MAX_HISTORY + 5 }, () => ({}))).history).toHaveLength(MAX_HISTORY);
  });

  it('carte saine', () => {
    const health = assessCardHealth(withHistory([{}, {}, {}, {}, {}, {}]));
    expect(health).toMatchObject({ level: 'ok', reasons: [], importCount: 6, totalReadErrors: 0 });
    expect(health.historicalMedianRate).toBe(100_000_000);
    expect(health.recentMedianRate).toBe(100_000_000);
    expect(assessCardHealth(createCardRecord(fp, AT)).level).toBe('ok');
  });

  it('erreurs de lecture en hausse sur les trois derniers imports', () => {
    const health = assessCardHealth(withHistory([{}, { readErrors: 0 }, { readErrors: 2 }, { readErrors: 5 }]));
    expect(health.level).toBe('alerte');
    expect(health.reasons.map((r) => r.code)).toEqual(['read-errors-rising']);
    expect(health.totalReadErrors).toBe(7);
    expect(assessCardHealth(withHistory([{ readErrors: 1 }, { readErrors: 3 }, { readErrors: 3 }])).level).toBe('ok');
    expect(assessCardHealth(withHistory([{ readErrors: 1 }, { readErrors: 3 }])).level).toBe('ok');
  });

  it('chute de débit sous 60 % de la médiane historique', () => {
    const slow = { durationMs: 200_000 }; // 50 Mo/s contre 100 Mo/s
    const health = assessCardHealth(withHistory([{}, {}, {}, slow, slow, slow]));
    expect(health.reasons.map((r) => r.code)).toEqual(['rate-drop']);
    expect(health.recentMedianRate).toBe(50_000_000);
    // Un seul import lent sur trois : la médiane reste bonne.
    expect(assessCardHealth(withHistory([{}, {}, {}, slow, {}, {}])).level).toBe('ok');
    // Seuil paramétrable.
    expect(assessCardHealth(withHistory([{}, {}, {}, slow, slow, slow]), { rateRatio: 0.4 }).level).toBe('ok');
  });

  it('pas d’alerte de débit sans historique suffisant ou sur de petits imports', () => {
    const slow = { durationMs: 200_000 };
    expect(assessCardHealth(withHistory([{}, {}, slow, slow, slow])).level).toBe('ok');
    const tiny = { bytes: 1_000_000, durationMs: 1_000_000 };
    expect(assessCardHealth(withHistory([{}, {}, {}, tiny, tiny, tiny])).level).toBe('ok');
    expect(assessCardHealth(withHistory([{}, {}, {}, { durationMs: 0 }, slow, slow])).reasons.map((r) => r.code)).toEqual(['rate-drop']);
  });

  it('les deux alertes ensemble', () => {
    const health = assessCardHealth(
      withHistory([{}, {}, {}, { durationMs: 300_000, readErrors: 1 }, { durationMs: 300_000, readErrors: 2 }, { durationMs: 300_000, readErrors: 3 }]),
    );
    expect(health.reasons.map((r) => r.code)).toEqual(['read-errors-rising', 'rate-drop']);
  });
});
