import { describe, expect, it } from 'vitest';
import { checkHandle } from '../src/platform/handles';

function fakeDir(options: { permission?: PermissionState; error?: string }): FileSystemHandle {
  return {
    kind: 'directory',
    name: 'SSD',
    queryPermission: async () => options.permission ?? 'granted',
    values: () => ({
      next: async () => {
        if (options.error) throw new DOMException('x', options.error);
        return { done: true, value: undefined };
      },
      return: async () => ({ done: true, value: undefined }),
    }),
  } as unknown as FileSystemHandle;
}

describe('checkHandle', () => {
  it('distingue les cas utiles', async () => {
    expect((await checkHandle(fakeDir({}))).state).toBe('ok');
    expect((await checkHandle(fakeDir({ permission: 'prompt' }))).state).toBe('permission-needed');
    expect(await checkHandle(fakeDir({ error: 'NotFoundError' }))).toMatchObject({ state: 'missing', errorName: 'NotFoundError' });
    expect((await checkHandle(fakeDir({ error: 'NotAllowedError' }))).state).toBe('permission-needed');
    expect((await checkHandle(fakeDir({ error: 'InvalidStateError' }))).state).toBe('unavailable');
    expect((await checkHandle(fakeDir({ error: 'Autre' }))).state).toBe('error');
  });

  it('donne des messages en français sans jargon', async () => {
    const result = await checkHandle(fakeDir({ error: 'NotFoundError' }));
    expect(result.message).not.toMatch(/Error|handle|poignée/i);
  });
});
