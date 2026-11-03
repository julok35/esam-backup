import { describe, expect, it } from 'vitest';
import { MIB } from '../../src/test-page/format';
import { PhaseTimer, RateMeter, rechunk, sizeStats } from '../../src/test-page/measure';

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

async function* from(parts: number[][]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield new Uint8Array(p);
}

async function collect(gen: AsyncIterable<Uint8Array>): Promise<number[][]> {
  const out: number[][] = [];
  for await (const c of gen) out.push([...c]);
  return out;
}

describe('PhaseTimer', () => {
  it('cumule le temps par phase', async () => {
    const clock = fakeClock();
    const timer = new PhaseTimer(clock.now);
    await timer.time('lecture', async () => clock.advance(10));
    await timer.time('lecture', async () => clock.advance(5));
    timer.timeSync('empreinte', () => clock.advance(3));
    expect(timer.get('lecture')).toBe(15);
    expect(timer.get('empreinte')).toBe(3);
    expect(timer.get('absente')).toBe(0);
  });

  it('compte le temps même en cas d\'erreur', async () => {
    const clock = fakeClock();
    const timer = new PhaseTimer(clock.now);
    await expect(
      timer.time('écriture', async () => {
        clock.advance(7);
        throw new Error('panne');
      }),
    ).rejects.toThrow('panne');
    expect(timer.get('écriture')).toBe(7);
  });
});

describe('RateMeter', () => {
  it('donne le débit moyen et instantané', () => {
    const clock = fakeClock();
    const meter = new RateMeter(2000, clock.now);
    clock.advance(1000);
    meter.update(100 * MIB);
    expect(meter.average()).toBe(100);
    expect(meter.instant()).toBe(100);
    // Ralentissement : 10 Mo/s pendant 3 s.
    for (let i = 1; i <= 3; i++) {
      clock.advance(1000);
      meter.update(100 * MIB + i * 10 * MIB);
    }
    expect(meter.instant()).toBeCloseTo(10, 5);
    expect(meter.average()).toBeCloseTo(130 / 4, 5);
  });

  it('renvoie null sans mesure', () => {
    const meter = new RateMeter(2000, fakeClock().now);
    expect(meter.instant()).toBeNull();
    expect(meter.average()).toBeNull();
  });
});

describe('rechunk', () => {
  it('regroupe en morceaux de taille fixe, le dernier plus court', async () => {
    const sizes: number[] = [];
    const out = await collect(rechunk(from([[1, 2, 3], [4], [5, 6, 7, 8, 9]]), 4, (n) => sizes.push(n)));
    expect(out).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9],
    ]);
    expect(sizes).toEqual([3, 1, 5]);
  });

  it('produit des tableaux indépendants', async () => {
    const out: Uint8Array[] = [];
    for await (const c of rechunk(from([[1, 2, 3, 4, 5, 6, 7, 8]]), 4)) out.push(c);
    expect(out[0]?.buffer).not.toBe(out[1]?.buffer);
  });

  it('ne produit rien pour un flux vide', async () => {
    expect(await collect(rechunk(from([]), 4))).toEqual([]);
  });

  it('refuse une taille invalide', async () => {
    await expect(collect(rechunk(from([[1]]), 0))).rejects.toThrow(RangeError);
  });
});

describe('sizeStats', () => {
  it('calcule min, max et moyenne', () => {
    expect(sizeStats([2, 4, 6])).toEqual({ count: 3, min: 2, max: 6, mean: 4 });
    expect(sizeStats([])).toEqual({ count: 0, min: 0, max: 0, mean: 0 });
  });
});
