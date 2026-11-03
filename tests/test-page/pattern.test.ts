import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chunkSeed, fillPattern, patternChunks, planChunks } from '../../src/test-page/pattern';

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

describe('motif pseudo-aléatoire', () => {
  it('est déterministe pour une graine et un numéro de morceau', () => {
    const a = fillPattern(new Uint8Array(4096), 42, 3);
    const b = fillPattern(new Uint8Array(4096), 42, 3);
    expect(a).toEqual(b);
  });

  it('change avec la graine et le numéro de morceau', () => {
    const a = fillPattern(new Uint8Array(64), 42, 0);
    expect(fillPattern(new Uint8Array(64), 43, 0)).not.toEqual(a);
    expect(fillPattern(new Uint8Array(64), 42, 1)).not.toEqual(a);
  });

  it('ne produit jamais une graine nulle', () => {
    for (let i = 0; i < 1000; i++) expect(chunkSeed(i, i)).not.toBe(0);
  });

  it('gère les tailles non multiples de 4 et les vues non alignées', () => {
    const aligned = fillPattern(new Uint8Array(10), 7, 0);
    const backing = new Uint8Array(11);
    const unaligned = fillPattern(backing.subarray(1), 7, 0);
    expect(unaligned).toEqual(aligned);
  });

  it('n\'est pas répétitif (octets variés)', () => {
    const data = fillPattern(new Uint8Array(1 << 16), 1, 0);
    const seen = new Set(data);
    expect(seen.size).toBe(256);
  });

  it('découpe un total en morceaux', () => {
    expect(planChunks(10, 4)).toEqual([4, 4, 2]);
    expect(planChunks(8, 4)).toEqual([4, 4]);
    expect(planChunks(0, 4)).toEqual([]);
    expect(() => planChunks(10, 0)).toThrow(RangeError);
  });

  it('donne le même contenu que le motif morceau par morceau, empreinte stable', () => {
    const parts = [...patternChunks(10_000, 4096, 99)];
    expect(parts.map((p) => p.byteLength)).toEqual([4096, 4096, 1808]);
    expect(parts[1]).toEqual(fillPattern(new Uint8Array(4096), 99, 1));
    const h1 = createHash('sha256').update(concat(parts)).digest('hex');
    const h2 = createHash('sha256').update(concat([...patternChunks(10_000, 4096, 99)])).digest('hex');
    expect(h1).toBe(h2);
  });
});
