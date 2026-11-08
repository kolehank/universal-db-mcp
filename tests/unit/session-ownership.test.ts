/**
 * 会话归属校验（P0-4）单元测试
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ConnectionManager } from '../../src/core/connection-manager';
import { AclError } from '../../src/security/errors';
import type { DbAdapter } from '../../src/types/adapter';

function fakeAdapter(): DbAdapter {
  return {
    connect: async () => undefined,
    disconnect: async () => undefined,
    executeQuery: async () => ({ rows: [], executionTime: 0 }),
    getSchema: async () => ({ databaseType: 'mysql', databaseName: 'd', tables: [], version: '8' }),
    isWriteOperation: () => false,
  } as unknown as DbAdapter;
}

describe('ConnectionManager.assertSessionAccess', () => {
  let manager: ConnectionManager | undefined;

  afterEach(async () => {
    await manager?.disconnectAll();
    manager = undefined;
  });

  it('同一 keyFingerprint 可以访问会话', async () => {
    manager = new ConnectionManager(3600_000, 0, undefined, { adapterFactory: fakeAdapter });
    const id = await manager.connect(
      { type: 'mysql', host: 'h', port: 1 },
      { keyFingerprint: 'fp-a' }
    );
    expect(manager.assertSessionAccess(id, 'fp-a').id).toBe(id);
  });

  it('其他 keyFingerprint 访问 / 断开会话 → SESSION_NOT_FOUND', async () => {
    manager = new ConnectionManager(3600_000, 0, undefined, { adapterFactory: fakeAdapter });
    const id = await manager.connect(
      { type: 'mysql', host: 'h', port: 1 },
      { keyFingerprint: 'fp-a' }
    );

    expect(() => manager!.assertSessionAccess(id, 'fp-b')).toThrow(AclError);
    try {
      manager.assertSessionAccess(id, 'fp-b');
    } catch (error) {
      expect((error as AclError).code).toBe('SESSION_NOT_FOUND');
    }
  });

  it('不存在的会话 → SESSION_NOT_FOUND', () => {
    manager = new ConnectionManager(3600_000, 0, undefined, { adapterFactory: fakeAdapter });
    expect(() => manager!.assertSessionAccess('nope', '')).toThrow(/会话不存在/);
  });

  it('legacy 无 key 模式：空 fingerprint 可访问，带 key 的请求不可访问', async () => {
    manager = new ConnectionManager(3600_000, 0, undefined, { adapterFactory: fakeAdapter });
    const id = await manager.connect(
      { type: 'mysql', host: 'h', port: 1 },
      { keyFingerprint: '' }
    );
    expect(manager.assertSessionAccess(id, '').id).toBe(id);
    expect(manager.assertSessionAccess(id, undefined).id).toBe(id);
    expect(() => manager!.assertSessionAccess(id, 'fp-a')).toThrow(AclError);
  });
});
