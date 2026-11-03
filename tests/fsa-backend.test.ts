import { describe, expect, it } from 'vitest';
import { FsaDirectoryBackend, StorageError } from '../src/storage';
import { FakeDirectoryHandle, readAll, streamOf } from './helpers/fake-fs';

function makeSsd(): { ssd: FakeDirectoryHandle; backend: FsaDirectoryBackend } {
  const ssd = FakeDirectoryHandle.from('SSD', { ESAM: { _systeme: {} } });
  return { ssd, backend: new FsaDirectoryBackend(ssd.asHandle()) };
}

describe('FsaDirectoryBackend', () => {
  it('crée les dossiers manquants et écrit un fichier depuis un flux', async () => {
    const { backend } = makeSsd();
    const path = 'ESAM/01 - Secours/2026/2026-10-18 Dolly - Mont Granier/Drone M30T/DJI_0001.MP4';
    const progress: number[] = [];
    const written = await backend.writeFile(path, streamOf('abc', 'def'), { onProgress: (n) => progress.push(n) });
    expect(written).toBe(6);
    expect(progress).toEqual([3, 6]);
    expect(await readAll((await backend.openRead(path)).stream)).toBe('abcdef');
    const listing = await backend.list('ESAM/01 - Secours/2026');
    expect(listing).toEqual([{ name: '2026-10-18 Dolly - Mont Granier', kind: 'directory', size: null, lastModified: null }]);
  });

  it("refuse d'écraser un fichier existant sauf demande explicite", async () => {
    const { backend } = makeSsd();
    await backend.writeFile('ESAM/a.txt', streamOf('un'));
    await expect(backend.writeFile('ESAM/a.txt', streamOf('deux'))).rejects.toMatchObject({ code: 'already-exists' });
    expect(await readAll((await backend.openRead('ESAM/a.txt')).stream)).toBe('un');
    await backend.writeFile('ESAM/a.txt', streamOf('deux'), { ifExists: 'replace' });
    expect(await readAll((await backend.openRead('ESAM/a.txt')).stream)).toBe('deux');
  });

  it('reprend une écriture à un offset donné', async () => {
    const { backend } = makeSsd();
    const first = await backend.openWriter('ESAM/gros.mp4');
    await first.write(new TextEncoder().encode('0123456789'));
    await first.close();

    const resumed = await backend.openWriter('ESAM/gros.mp4', { resumeAt: 4 });
    expect(resumed.offset).toBe(4);
    await resumed.write(new TextEncoder().encode('ABCD'));
    expect(resumed.offset).toBe(8);
    await resumed.close();
    expect(await readAll((await backend.openRead('ESAM/gros.mp4')).stream)).toBe('0123ABCD');

    await expect(backend.openWriter('ESAM/gros.mp4', { resumeAt: 50 })).rejects.toBeInstanceOf(StorageError);
    await expect(backend.openWriter('ESAM/absent.mp4', { resumeAt: 0 })).rejects.toMatchObject({ code: 'not-found' });
  });

  it("n'écrit rien si l'écriture est abandonnée", async () => {
    const { backend } = makeSsd();
    const writer = await backend.openWriter('ESAM/x.bin');
    await writer.write(new Uint8Array([1, 2, 3]));
    await writer.abort();
    expect((await backend.stat('ESAM/x.bin'))?.size).toBe(0);
  });

  it('renomme un dossier et refuse un nom déjà pris', async () => {
    const { backend } = makeSsd();
    await backend.ensureDirectory('ESAM/01 - Secours/2026/A');
    await backend.ensureDirectory('ESAM/01 - Secours/2026/B');
    await backend.renameDirectory('ESAM/01 - Secours/2026/A', 'C');
    expect(await backend.exists('ESAM/01 - Secours/2026/C')).toBe(true);
    expect(await backend.exists('ESAM/01 - Secours/2026/A')).toBe(false);
    await expect(backend.renameDirectory('ESAM/01 - Secours/2026/C', 'B')).rejects.toMatchObject({ code: 'already-exists' });
    await expect(backend.renameDirectory('ESAM/01 - Secours/2026/C', 'a/b')).rejects.toMatchObject({ code: 'invalid-path' });
  });

  it('signale clairement un renommage impossible sur ce navigateur', async () => {
    const { ssd, backend } = makeSsd();
    await backend.ensureDirectory('ESAM/A');
    const a = ssd.children.get('ESAM') as FakeDirectoryHandle;
    (a.children.get('A') as FakeDirectoryHandle).moveSupported = false;
    const error = await backend.renameDirectory('ESAM/A', 'B').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toBe('unsupported');
    expect((error as StorageError).userMessage).not.toMatch(/move|API|Error/);
  });

  it("renvoie null pour l'espace libre (aucune API web pour un SSD externe)", async () => {
    expect(await makeSsd().backend.freeSpace()).toBeNull();
  });
});
