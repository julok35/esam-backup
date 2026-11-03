import { describe, expect, it } from 'vitest';
import { errorDetail, errorInfo } from '../../src/test-page/analysis';
import {
  describeFailure,
  failureDetail,
  makeFailure,
  MeasureError,
  parseDetailMs,
  parseDetailNumber,
  parseFailurePhase,
} from '../../src/test-page/failure';
import { MIB } from '../../src/test-page/format';
import { StorageError } from '../../src/storage/errors';

const dom = new DOMException('An attempt was made to write to a file', 'NoModificationAllowedError');

describe("description d'un échec", () => {
  const failure = makeFailure(new StorageError('unknown', 'essai.bin', dom), {
    phase: 'écriture',
    bytesWritten: 64 * MIB,
    pendingBytes: 8 * MIB,
    target: 128 * MIB,
    elapsedMs: 1234,
    phaseMs: { ouverture: 3, écriture: 1200 },
  });

  it("remonte à l'exception du navigateur", () => {
    expect(failure.errorName).toBe('NoModificationAllowedError');
    expect(failure.errorMessage).toContain('An attempt was made');
  });

  it('dit en clair la phase, les octets écrits et le temps', () => {
    expect(describeFailure(failure)).toBe('Échec pendant la phase écriture, après 64,0 Mo écrits en 1,2 s');
  });

  it('écrit un détail de journal relisible', () => {
    const detail = failureDetail(failure);
    expect(detail).toContain('phase=écriture');
    expect(detail).toContain(`écrits=${64 * MIB}`);
    expect(detail).toContain('ouverture 3 ms, écriture 1200 ms');
    expect(detail).toContain('NoModificationAllowedError: ');
    expect(parseFailurePhase(detail)).toBe('écriture');
    expect(parseDetailNumber(detail, 'cible')).toBe(128 * MIB);
    expect(parseDetailNumber(detail, 'écrits')).toBe(64 * MIB);
  });

  it('ignore une phase inconnue ou absente', () => {
    expect(parseFailurePhase('phase=bidon')).toBeNull();
    expect(parseFailurePhase('aucune')).toBeNull();
    expect(parseDetailNumber('rien', 'cible')).toBeNull();
  });

  it('relit la durée du close', () => {
    expect(parseDetailMs('cible=1, ouverture 3 ms, write 40 ms, close 512 ms, part du close 92 %', 'close')).toBe(512);
    expect(parseDetailMs('ouverture 3 ms', 'close')).toBeNull();
  });

  it("MeasureError garde l'échec et errorInfo remonte à la cause", () => {
    const error = new MeasureError(failure, dom);
    expect(error.failure.phase).toBe('écriture');
    expect(error.message).toContain('phase écriture');
    expect(errorInfo(error).name).toBe('NoModificationAllowedError');
    expect(errorDetail(error)).toMatch(/^NoModificationAllowedError: /);
  });
});
