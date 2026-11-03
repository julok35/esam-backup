import { describe, expect, it } from 'vitest';
import { joinPath, splitParent, splitPath, toStorageError } from '../src/storage';

describe('chemins', () => {
  it('découpe et recolle', () => {
    expect(splitPath('')).toEqual([]);
    expect(splitPath('/ESAM//01 - Secours/')).toEqual(['ESAM', '01 - Secours']);
    expect(splitParent('ESAM/_systeme/index.json')).toEqual({ parent: ['ESAM', '_systeme'], name: 'index.json' });
    expect(joinPath('ESAM/', '/01 - Secours', '2026')).toBe('ESAM/01 - Secours/2026');
  });

  it('refuse les segments dangereux', () => {
    expect(() => splitPath('ESAM/../x')).toThrow();
    expect(() => splitPath('./x')).toThrow();
    expect(() => splitParent('')).toThrow();
  });
});

describe('erreurs', () => {
  it('traduit les erreurs du navigateur en messages sans jargon', () => {
    const cases: [string, string][] = [
      ['NotFoundError', 'not-found'],
      ['NotAllowedError', 'permission'],
      ['InvalidStateError', 'unavailable'],
      ['QuotaExceededError', 'no-space'],
      ['TypeMismatchError', 'wrong-kind'],
      ['Bizarre', 'unknown'],
    ];
    for (const [name, code] of cases) {
      const error = toStorageError(new DOMException('x', name));
      expect(error.code).toBe(code);
      expect(error.userMessage).not.toMatch(/Error|DOM|API/);
    }
  });
});
