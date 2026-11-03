import { describe, expect, it } from 'vitest';
import { chromeMajorFromUserAgent, detectCapabilities } from '../../src/test-page/capabilities-detect';

const present = (items: ReturnType<typeof detectCapabilities>, id: string) => items.find((i) => i.id === id)?.present;

describe('détection des capacités', () => {
  it('trouve tout sur un Chrome Android complet (simulé)', () => {
    const fn = () => undefined;
    class FakeFile {}
    const scope = {
      showDirectoryPicker: fn,
      showOpenFilePicker: fn,
      isSecureContext: true,
      crossOriginIsolated: false,
      SharedArrayBuffer: fn,
      FileSystemHandle: { prototype: { queryPermission: fn, requestPermission: fn, move: fn } },
      FileSystemFileHandle: { prototype: { createWritable: fn, createSyncAccessHandle: fn } },
      indexedDB: {},
      WebAssembly: {},
      Notification: fn,
      RTCPeerConnection: fn,
      RTCDataChannel: fn,
      File: FakeFile,
      matchMedia: () => ({ matches: true }),
      navigator: {
        userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S928B) Chrome/142.0.0.0 Mobile Safari/537.36',
        storage: { persist: fn, estimate: fn },
        wakeLock: {},
        serviceWorker: {},
        vibrate: fn,
        canShare: (data: { files?: unknown[] }) => Array.isArray(data.files),
      },
    };
    const items = detectCapabilities(scope);
    expect(present(items, 'showDirectoryPicker')).toBe(true);
    expect(present(items, 'move')).toBe(true);
    expect(present(items, 'getUniqueId')).toBe(false);
    expect(present(items, 'shareFiles')).toBe(true);
    expect(present(items, 'SharedArrayBuffer')).toBe(false);
    expect(present(items, 'standalone')).toBe(true);
    expect(items.find((i) => i.id === 'userAgent')?.value).toContain('SM-S928B');
  });

  it('signale l\'absence de showDirectoryPicker comme indispensable', () => {
    const items = detectCapabilities({ navigator: {} });
    const picker = items.find((i) => i.id === 'showDirectoryPicker');
    expect(picker).toMatchObject({ level: 'critical', present: false });
    expect(present(items, 'shareFiles')).toBe(false);
    expect(present(items, 'standalone')).toBeNull();
  });

  it('résiste à un canShare qui lève une erreur', () => {
    const items = detectCapabilities({
      File: class {},
      navigator: {
        canShare: () => {
          throw new Error('non');
        },
      },
    });
    expect(present(items, 'shareFiles')).toBe(false);
  });

  it('lit la version majeure de Chrome', () => {
    expect(chromeMajorFromUserAgent('Mozilla/5.0 Chrome/142.0.7444.0 Mobile')).toBe(142);
    expect(chromeMajorFromUserAgent('Firefox/130')).toBeNull();
  });
});
