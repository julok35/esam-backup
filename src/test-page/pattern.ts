/*
 * Motif pseudo-aléatoire déterministe pour les fichiers d'essai écrits sur le SSD
 * (fonctions pures). Généré morceau par morceau : on n'alloue jamais tout le fichier.
 *
 * Chaque morceau dépend de la graine et de son numéro (xorshift32), donc le contenu
 * d'un morceau peut être recalculé sans connaître les précédents. Les données ne
 * sont pas compressibles ni répétitives, pour que la mesure reflète le vrai support.
 */

/** Mélange deux entiers 32 bits en une graine non nulle (dérivé de murmur3 fmix32). */
export function chunkSeed(seed: number, chunkIndex: number): number {
  let x = (seed ^ Math.imul(chunkIndex + 1, 0x9e3779b1)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x === 0 ? 0x6d2b79f5 : x;
}

/**
 * Remplit `target` avec le motif du morceau `chunkIndex`. La taille de `target`
 * peut être quelconque (le dernier morceau d'un fichier est souvent plus court).
 */
export function fillPattern(target: Uint8Array, seed: number, chunkIndex: number): Uint8Array {
  let x = chunkSeed(seed, chunkIndex);
  const words = target.byteLength >>> 2;
  const aligned = target.byteOffset % 4 === 0;
  if (aligned && words > 0) {
    const view = new Uint32Array(target.buffer, target.byteOffset, words);
    for (let i = 0; i < words; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      view[i] = x >>> 0;
    }
  } else {
    for (let i = 0; i < words; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      const o = i * 4;
      target[o] = x & 0xff;
      target[o + 1] = (x >>> 8) & 0xff;
      target[o + 2] = (x >>> 16) & 0xff;
      target[o + 3] = (x >>> 24) & 0xff;
    }
  }
  for (let o = words * 4; o < target.byteLength; o++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    target[o] = x & 0xff;
  }
  return target;
}

/** Tailles successives des morceaux pour écrire `total` octets par morceaux de `chunkSize`. */
export function planChunks(total: number, chunkSize: number): number[] {
  if (!Number.isInteger(total) || total < 0) throw new RangeError(`taille invalide : ${total}`);
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new RangeError(`morceau invalide : ${chunkSize}`);
  const sizes: number[] = [];
  for (let done = 0; done < total; done += chunkSize) sizes.push(Math.min(chunkSize, total - done));
  return sizes;
}

/** Morceaux du motif, un par un. Chaque morceau est un tableau neuf (sûr pour une écriture asynchrone). */
export function* patternChunks(total: number, chunkSize: number, seed: number): Generator<Uint8Array> {
  const sizes = planChunks(total, chunkSize);
  for (let i = 0; i < sizes.length; i++) {
    yield fillPattern(new Uint8Array(sizes[i] ?? 0), seed, i);
  }
}
