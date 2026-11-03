import { describe, expect, it } from 'vitest';
import { makeFailure, failureDetail } from '../../src/test-page/failure';
import { GIB, MIB } from '../../src/test-page/format';
import type { JournalEntry } from '../../src/test-page/journal-format';
import { analysisLines, closePoints, computeVerdict, CRITICAL_TESTS, writeOutcomes } from '../../src/test-page/verdict';

function entry(partial: Partial<JournalEntry>): JournalEntry {
  return { ts: '2026-11-03T10:00:00.000Z', step: 2, test: 'essai', param: '', bytes: null, ms: null, rate: null, result: 'OK', detail: '', ...partial };
}

const cardOk = entry({ step: 1, test: CRITICAL_TESTS.cardRead.test });

function ladderOk(sizeMiB: number, closeMs: number, totalMs: number): JournalEntry {
  return entry({
    test: CRITICAL_TESTS.ssdLadder.test,
    param: `palier ${sizeMiB} Mo, essai 1`,
    bytes: sizeMiB * MIB,
    ms: totalMs,
    detail: `cible=${sizeMiB * MIB}, ouverture 3 ms, write ${totalMs - closeMs - 3} ms, close ${closeMs} ms`,
  });
}

function ladderKo(sizeMiB: number, attempt: number): JournalEntry {
  const failure = makeFailure(new DOMException('non', 'NoModificationAllowedError'), { phase: 'écriture', bytesWritten: 64 * MIB, target: sizeMiB * MIB, elapsedMs: 900 });
  return entry({ test: CRITICAL_TESTS.ssdLadder.test, param: `palier ${sizeMiB} Mo, essai ${attempt}`, bytes: 64 * MIB, ms: 900, result: 'ECHEC', detail: failureDetail(failure) });
}

/** Journal réel du S24 Ultra du 03/11 (format d'avant : bytes = taille visée, pas de cible=). */
const s24 = [
  entry({ step: 1, test: 'choix dossier carte', detail: 'nom=media' }),
  entry({ test: CRITICAL_TESTS.ssdWrite.test, param: '1,00 Go, morceaux 8,0 Mo', bytes: GIB, result: 'ECHEC', detail: 'NoModificationAllowedError: An attempt was made' }),
  entry({ test: 'renommage dossier (move)', result: 'NON DISPONIBLE' }),
  entry({ test: CRITICAL_TESTS.ssdResume.test, param: 'essai_1024Mo.bin', bytes: 0, ms: 40, detail: 'ouverture 7 ms, close 33 ms pour ajouter 1 Mo à 0 octets, taille finale 1048576' }),
  entry({ step: 5, test: 'état au chargement Carte', result: 'ECHEC', detail: 'état=permission-needed' }),
];

describe('écritures lues dans le journal', () => {
  it('relit la taille visée, la phase et le close', () => {
    const outcomes = writeOutcomes([ladderOk(16, 80, 200), ladderKo(128, 1)]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({ target: 16 * MIB, ok: true, closeMs: 80, totalMs: 200 });
    expect(outcomes[1]).toMatchObject({ target: 128 * MIB, ok: false, phase: 'écriture', bytes: 64 * MIB });
  });

  it('comprend les anciens journaux (reprise = 1 Mo, sinon la taille)', () => {
    const outcomes = writeOutcomes(s24);
    expect(outcomes.map((o) => [o.target, o.ok])).toEqual([
      [GIB, false],
      [MIB, true],
    ]);
  });

  it('garde la dernière mesure par taille', () => {
    expect(writeOutcomes([ladderKo(128, 1), { ...ladderOk(128, 300, 900) }])).toHaveLength(1);
    expect(writeOutcomes([ladderKo(128, 1), ladderOk(128, 300, 900)])[0]?.ok).toBe(true);
  });
});

describe('verdict', () => {
  it('écriture limitée (orange) sur le journal du S24 Ultra', () => {
    const v = computeVerdict([cardOk, ...s24]);
    expect(v.kind).toBe('limited');
    expect(v.text).toContain('écriture limitée en taille : à analyser');
    expect(v.text).toContain('plus grande écriture réussie 1,0 Mo');
    expect(v.text).toContain('plus petite en échec 1,00 Go');
  });

  it('limitée avec la phase quand les paliers s\'arrêtent', () => {
    const v = computeVerdict([cardOk, ladderOk(1, 2, 10), ladderOk(16, 80, 200), ladderOk(64, 320, 800), ladderKo(128, 1), ladderKo(128, 2)]);
    expect(v).toMatchObject({ kind: 'limited', largestOk: 64 * MIB, smallestFail: 128 * MIB, failurePhase: 'écriture' });
    expect(v.text).toContain('phase écriture');
  });

  it('à revoir si aucune écriture ne réussit', () => {
    expect(computeVerdict([cardOk, ladderKo(1, 1), ladderKo(1, 2)]).kind).toBe('rework');
  });

  it('à revoir si la carte ne se lit pas, même avec des écritures réussies', () => {
    expect(computeVerdict([entry({ step: 1, test: CRITICAL_TESTS.cardRead.test, result: 'ECHEC' }), ladderOk(16, 80, 200)]).kind).toBe('rework');
  });

  it("la persistance « à vérifier » n'est pas un échec", () => {
    const v = computeVerdict([
      cardOk,
      entry({ test: CRITICAL_TESTS.ssdWrite.test }),
      entry({ test: CRITICAL_TESTS.ssdVerify.test }),
      entry({ step: 5, test: 'état au chargement Carte', result: 'À VÉRIFIER' }),
      entry({ step: 5, test: 'état au chargement SSD', result: 'À VÉRIFIER' }),
    ]);
    expect(v.kind).toBe('validated');
  });

  it('irrégulière si une taille réussie dépasse une taille en échec', () => {
    const v = computeVerdict([cardOk, ladderKo(16, 1), ladderOk(64, 300, 800)]);
    expect(v.kind).toBe('limited');
    expect(v.text).toContain('irrégulière');
  });
});

describe("lignes d'analyse", () => {
  it('décrit tailles, phase, close et persistance', () => {
    const entries = [
      cardOk,
      ladderOk(1, 2, 10),
      ladderOk(16, 80, 200),
      ladderOk(64, 320, 800),
      ladderKo(128, 1),
      ladderKo(128, 2),
      entry({ step: 5, test: 'état au chargement Carte', result: 'À VÉRIFIER' }),
      entry({ step: 5, test: 'vérification Carte', result: 'OK' }),
    ];
    const lines = analysisLines(entries);
    expect(lines[0]).toBe('Écriture sur le SSD : plus grande écriture réussie 64,0 Mo ; plus petite en échec 128,0 Mo (phase écriture, après 64,0 Mo écrits).');
    expect(lines[1]).toContain('Le close() dure à peu près en proportion de la taille');
    expect(lines[2]).toContain('Persistance : au chargement Carte À VÉRIFIER');
    expect(lines[2]).toContain('après « Vérifier maintenant » Carte OK');
    expect(closePoints(entries)).toHaveLength(3);
  });

  it('reste lisible sans mesure', () => {
    expect(analysisLines([])).toEqual(['Écriture sur le SSD : pas encore mesurée.', 'Persistance : pas encore testée.']);
  });
});
