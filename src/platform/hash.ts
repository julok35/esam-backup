/*
 * SHA-256 en flux avec hash-wasm (WebCrypto ne sait pas hacher par morceaux).
 */
import { createSHA256, type IHasher } from 'hash-wasm';

/** Empreinte incrémentale : update(chunk) pendant la copie, digest() à la fin. */
export class StreamingSha256 {
  readonly #hasher: IHasher;
  #bytes: number;
  #finished = false;

  private constructor(hasher: IHasher, bytes: number) {
    this.#hasher = hasher;
    this.#bytes = bytes;
  }

  static async create(): Promise<StreamingSha256> {
    const hasher = await createSHA256();
    hasher.init();
    return new StreamingSha256(hasher, 0);
  }

  /** Reprend un calcul sauvegardé avec saveState() (reprise d'un import interrompu). */
  static async restore(state: Uint8Array, bytes: number): Promise<StreamingSha256> {
    const hasher = await createSHA256();
    hasher.load(state);
    return new StreamingSha256(hasher, bytes);
  }

  /** Nombre d'octets hachés depuis le début. */
  get bytes(): number {
    return this.#bytes;
  }

  update(chunk: Uint8Array): this {
    if (this.#finished) throw new Error('StreamingSha256: update après digest');
    this.#hasher.update(chunk);
    this.#bytes += chunk.byteLength;
    return this;
  }

  /** État interne à conserver pour reprendre plus tard. Contient des octets du fichier. */
  saveState(): Uint8Array {
    if (this.#finished) throw new Error('StreamingSha256: saveState après digest');
    return this.#hasher.save();
  }

  /** Empreinte finale en hexadécimal minuscule. Une seule fois par instance. */
  digest(): string {
    if (this.#finished) throw new Error('StreamingSha256: digest déjà appelé');
    this.#finished = true;
    return this.#hasher.digest('hex');
  }
}

/** Lit tout le flux et renvoie son empreinte hexadécimale. */
export async function sha256OfStream(stream: ReadableStream<Uint8Array>, onProgress?: (bytes: number) => void): Promise<string> {
  const hash = await StreamingSha256.create();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      onProgress?.(hash.bytes);
    }
  } finally {
    reader.releaseLock();
  }
  return hash.digest();
}

/**
 * Transformation qui laisse passer les octets et calcule l'empreinte au passage.
 * Usage : await source.pipeThrough(h.transform).pipeTo(destination), puis h.digest().
 * digest() ne doit être appelé qu'une fois le flux entièrement passé.
 */
export async function createHashingTransform(): Promise<{
  transform: TransformStream<Uint8Array, Uint8Array>;
  digest: () => string;
  bytes: () => number;
}> {
  const hash = await StreamingSha256.create();
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hash.update(chunk);
      controller.enqueue(chunk);
    },
  });
  return { transform, digest: () => hash.digest(), bytes: () => hash.bytes };
}
