/*
 * Faux système de fichiers en mémoire imitant FileSystemDirectoryHandle et
 * FileSystemFileHandle, juste assez pour tester src/storage sous Node.
 * Chaque opération qui modifierait le support est consignée dans `mutations`.
 */

export interface FakeLog {
  mutations: string[];
}

function domError(name: string, message = name): DOMException {
  return new DOMException(message, name);
}

class FakeWritable {
  #buffer: Uint8Array;
  #position = 0;
  #closed = false;
  readonly #file: FakeFileHandle;

  constructor(file: FakeFileHandle, keepExistingData: boolean) {
    this.#file = file;
    this.#buffer = keepExistingData ? file.data.slice() : new Uint8Array(0);
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.#closed) throw domError('InvalidStateError');
    const end = this.#position + data.byteLength;
    if (end > this.#buffer.byteLength) {
      const grown = new Uint8Array(end);
      grown.set(this.#buffer);
      this.#buffer = grown;
    }
    this.#buffer.set(data, this.#position);
    this.#position = end;
  }

  async seek(position: number): Promise<void> {
    this.#position = position;
  }

  async truncate(size: number): Promise<void> {
    const next = new Uint8Array(size);
    next.set(this.#buffer.subarray(0, Math.min(size, this.#buffer.byteLength)));
    this.#buffer = next;
    if (this.#position > size) this.#position = size;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#file.data = this.#buffer;
    this.#file.lastModified = Date.now();
  }

  async abort(): Promise<void> {
    this.#closed = true;
  }
}

export class FakeFileHandle {
  readonly kind = 'file' as const;
  data: Uint8Array;
  lastModified: number;

  constructor(
    public name: string,
    data: Uint8Array | string,
    private readonly log: FakeLog,
    lastModified = 1_700_000_000_000,
  ) {
    this.data = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.lastModified = lastModified;
  }

  async getFile(): Promise<File> {
    return new File([this.data as Uint8Array<ArrayBuffer>], this.name, { lastModified: this.lastModified });
  }

  async createWritable(options?: { keepExistingData?: boolean }): Promise<FakeWritable> {
    this.log.mutations.push(`createWritable ${this.name}`);
    return new FakeWritable(this, options?.keepExistingData ?? false);
  }

  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }

  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this;
  }
}

export class FakeDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, FakeDirectoryHandle | FakeFileHandle>();
  parent: FakeDirectoryHandle | null = null;
  /** Mettre à false pour simuler un navigateur sans FileSystemHandle.move. */
  moveSupported = true;

  constructor(
    public name: string,
    readonly log: FakeLog = { mutations: [] },
  ) {}

  /** Construit une arborescence : { 'a.txt': 'contenu', DCIM: { 'b.mp4': '...' } }. */
  static from(name: string, tree: FakeTree, log: FakeLog = { mutations: [] }): FakeDirectoryHandle {
    const dir = new FakeDirectoryHandle(name, log);
    for (const [childName, value] of Object.entries(tree)) {
      if (typeof value === 'string' || value instanceof Uint8Array) {
        dir.children.set(childName, new FakeFileHandle(childName, value, log));
      } else {
        const sub = FakeDirectoryHandle.from(childName, value, log);
        sub.parent = dir;
        dir.children.set(childName, sub);
      }
    }
    return dir;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing instanceof FakeDirectoryHandle) return existing;
    if (existing) throw domError('TypeMismatchError');
    if (!options?.create) throw domError('NotFoundError');
    this.log.mutations.push(`mkdir ${name}`);
    const dir = new FakeDirectoryHandle(name, this.log);
    dir.parent = this;
    this.children.set(name, dir);
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    const existing = this.children.get(name);
    if (existing instanceof FakeFileHandle) return existing;
    if (existing) throw domError('TypeMismatchError');
    if (!options?.create) throw domError('NotFoundError');
    this.log.mutations.push(`create ${name}`);
    const file = new FakeFileHandle(name, new Uint8Array(0), this.log);
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name: string): Promise<void> {
    this.log.mutations.push(`remove ${name}`);
    if (!this.children.delete(name)) throw domError('NotFoundError');
  }

  get move(): ((newName: string) => Promise<void>) | undefined {
    if (!this.moveSupported) return undefined;
    return async (newName: string) => {
      this.log.mutations.push(`move ${this.name} ${newName}`);
      const parent = this.parent;
      if (!parent) throw domError('InvalidModificationError');
      if (parent.children.has(newName)) throw domError('InvalidModificationError');
      parent.children.delete(this.name);
      this.name = newName;
      parent.children.set(newName, this);
    };
  }

  async *values(): AsyncIterableIterator<FakeDirectoryHandle | FakeFileHandle> {
    for (const child of this.children.values()) yield child;
  }

  async *entries(): AsyncIterableIterator<[string, FakeDirectoryHandle | FakeFileHandle]> {
    for (const entry of this.children.entries()) yield entry;
  }

  async *keys(): AsyncIterableIterator<string> {
    for (const key of this.children.keys()) yield key;
  }

  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }

  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this;
  }

  /** Vue typée pour passer le faux au code de production. */
  asHandle(): FileSystemDirectoryHandle {
    return this as unknown as FileSystemDirectoryHandle;
  }
}

export interface FakeTree {
  [name: string]: string | Uint8Array | FakeTree;
}

export function streamOf(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream as ReadableStream<Uint8Array<ArrayBuffer>>).text();
}
