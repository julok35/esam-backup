import { describe, expect, it } from 'vitest';
import { makeFailure } from '../../src/test-page/failure';
import { MIB } from '../../src/test-page/format';
import {
  closeShare,
  closeTrend,
  describeCloseTrend,
  describeLadder,
  LADDER_SIZES,
  ladderFileName,
  ladderFilesToDelete,
  nextLadderAction,
  resumeOpenVerdict,
  summarizeLadder,
  type LadderAttempt,
} from '../../src/test-page/ladder';

function ok(sizeMiB: number, closeMs = 10, attempt = 1): LadderAttempt {
  return { size: sizeMiB * MIB, attempt, ok: true, bytes: sizeMiB * MIB, openMs: 5, writeMs: 100, closeMs };
}

function ko(sizeMiB: number, attempt = 1, writtenMiB = 64): LadderAttempt {
  const failure = makeFailure(new DOMException('non', 'NoModificationAllowedError'), {
    phase: 'écriture',
    bytesWritten: writtenMiB * MIB,
    target: sizeMiB * MIB,
    elapsedMs: 900,
  });
  return { size: sizeMiB * MIB, attempt, ok: false, bytes: writtenMiB * MIB, openMs: 5, writeMs: 800, closeMs: 0, failure };
}

describe('paliers', () => {
  it('va de 1 Mo à 1 Go', () => {
    expect(LADDER_SIZES.map((s) => s / MIB)).toEqual([1, 16, 64, 128, 256, 512, 1024]);
    expect(ladderFileName(16 * MIB)).toBe('palier_16Mo.bin');
    expect(ladderFileName(1024 * MIB)).toBe('palier_1024Mo.bin');
  });

  it('commence par 1 Mo et passe au palier suivant après une réussite', () => {
    expect(nextLadderAction([])).toEqual({ kind: 'write', size: MIB, attempt: 1 });
    expect(nextLadderAction([ok(1), ok(16)])).toEqual({ kind: 'write', size: 64 * MIB, attempt: 1 });
  });

  it('réessaie une fois le même palier après un échec, puis s\'arrête', () => {
    expect(nextLadderAction([ok(1), ok(16), ok(64), ko(128)])).toEqual({ kind: 'write', size: 128 * MIB, attempt: 2 });
    expect(nextLadderAction([ok(1), ok(16), ok(64), ko(128), ko(128, 2)])).toEqual({ kind: 'stop', reason: 'limit' });
    expect(nextLadderAction([ok(1), ko(16), ok(16, 10, 2)])).toEqual({ kind: 'stop', reason: 'random' });
  });

  it("s'arrête après le dernier palier", () => {
    expect(nextLadderAction(LADDER_SIZES.map((s) => ok(s / MIB)))).toEqual({ kind: 'stop', reason: 'done' });
  });

  it('supprime tout sauf le dernier palier en échec', () => {
    const run = [ok(1), ok(16), ok(64), ko(128), ko(128, 2)];
    expect(ladderFilesToDelete(run)).toEqual({ remove: ['palier_1Mo.bin', 'palier_16Mo.bin', 'palier_64Mo.bin'], keep: 'palier_128Mo.bin' });
    expect(ladderFilesToDelete([ok(1), ko(16), ok(16, 10, 2)]).keep).toBeNull();
  });

  it('résume la limite trouvée', () => {
    const summary = summarizeLadder([ok(1), ok(16), ok(64), ko(128), ko(128, 2)]);
    expect(summary.largestOk).toBe(64 * MIB);
    expect(summary.smallestFail).toBe(128 * MIB);
    expect(summary.failure?.phase).toBe('écriture');
    expect(summary.stop.reason).toBe('limit');
    const text = describeLadder(summary);
    expect(text.startsWith('Plus grande écriture réussie 64,0 Mo')).toBe(true);
    expect(text).toContain('premier échec à 128,0 Mo (phase écriture, après 64,0 Mo écrits');
    expect(text).toContain('limite de taille probable');
  });

  it('dit quand tout passe', () => {
    expect(describeLadder(summarizeLadder(LADDER_SIZES.map((s) => ok(s / MIB))))).toContain('Tous les paliers sont passés');
  });
});

describe('part du close()', () => {
  it('calcule la part', () => {
    expect(closeShare(25, 100)).toBe(0.25);
    expect(closeShare(1, 0)).toBeNull();
  });

  it('reconnaît un close() proportionnel à la taille (recopie du cache)', () => {
    const trend = closeTrend([
      { size: MIB, closeMs: 5, totalMs: 20 },
      { size: 16 * MIB, closeMs: 80, totalMs: 200 },
      { size: 64 * MIB, closeMs: 320, totalMs: 800 },
    ]);
    expect(trend.kind).toBe('proportional');
    expect(trend.closeRate).toBeCloseTo(200, 0);
    expect(describeCloseTrend(trend)).toContain('recopie le fichier vers le SSD');
  });

  it('reconnaît un close() constant', () => {
    expect(closeTrend([{ size: 16 * MIB, closeMs: 30, totalMs: 200 }, { size: 512 * MIB, closeMs: 40, totalMs: 4000 }]).kind).toBe('flat');
  });

  it('ne conclut pas sans deux écritures de 16 Mo ou plus', () => {
    expect(closeTrend([{ size: MIB, closeMs: 5, totalMs: 20 }]).kind).toBe('unknown');
    expect(closeTrend([]).kind).toBe('unknown');
  });
});

describe('reprise sur gros fichier', () => {
  it('repère une recopie complète à l\'ouverture', () => {
    expect(resumeOpenVerdict(512 * MIB, 3000, 30).kind).toBe('copy');
    expect(resumeOpenVerdict(512 * MIB, 3000, 30).text).toContain('recopie probablement tout le fichier');
  });

  it('reconnaît une ouverture rapide', () => {
    expect(resumeOpenVerdict(512 * MIB, 40, 30).kind).toBe('fast');
    expect(resumeOpenVerdict(512 * MIB, 250, null).kind).toBe('fast');
  });
});
