import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createHashingTransform, sha256OfStream, StreamingSha256 } from '../src/platform/hash';
import { streamOf } from './helpers/fake-fs';

const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function chunks(data: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.byteLength; i += size) out.push(data.subarray(i, i + size));
  return out;
}

describe('SHA-256 en flux', () => {
  it('donne les empreintes de référence', async () => {
    expect(await sha256OfStream(streamOf('abc'))).toBe(ABC);
    expect(await sha256OfStream(streamOf())).toBe(EMPTY);
  });

  it('donne la même empreinte quel que soit le découpage', async () => {
    const data = new Uint8Array(randomBytes(3 * 1024 * 1024 + 17));
    const expected = createHash('sha256').update(data).digest('hex');
    const progress: number[] = [];
    expect(await sha256OfStream(streamOf(...chunks(data, 65_536)), (n) => progress.push(n))).toBe(expected);
    expect(progress.at(-1)).toBe(data.byteLength);

    const incremental = await StreamingSha256.create();
    for (const c of chunks(data, 1_000_003)) incremental.update(c);
    expect(incremental.bytes).toBe(data.byteLength);
    expect(incremental.digest()).toBe(expected);
    expect(() => incremental.digest()).toThrow();
  });

  it('reprend un calcul interrompu', async () => {
    const data = new Uint8Array(randomBytes(200_000));
    const expected = createHash('sha256').update(data).digest('hex');
    const first = await StreamingSha256.create();
    first.update(data.subarray(0, 120_000));
    const state = first.saveState();
    const resumed = await StreamingSha256.restore(state, first.bytes);
    resumed.update(data.subarray(120_000));
    expect(resumed.bytes).toBe(data.byteLength);
    expect(resumed.digest()).toBe(expected);
  });

  it('calcule au passage pendant une copie', async () => {
    const hashing = await createHashingTransform();
    const received: number[] = [];
    await streamOf('a', 'bc').pipeThrough(hashing.transform).pipeTo(
      new WritableStream({
        write(chunk) {
          received.push(chunk.byteLength);
        },
      }),
    );
    expect(received).toEqual([1, 2]);
    expect(hashing.bytes()).toBe(3);
    expect(hashing.digest()).toBe(ABC);
  });
});
