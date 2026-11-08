/**
 * Redis 命令权限策略（P0-2）单元测试
 */

import { describe, it, expect } from 'vitest';
import { decideRedisCommand, extractRedisCommand } from '../../src/utils/redis-command-policy';
import { validateQuery } from '../../src/utils/safety';
import type { DbConfig, PermissionType } from '../../src/types/adapter';

function redis(permissionMode: DbConfig['permissionMode'] = 'safe', permissions?: PermissionType[]): DbConfig {
  return permissions
    ? { type: 'redis', permissionMode: 'custom', permissions }
    : { type: 'redis', permissionMode };
}

describe('extractRedisCommand', () => {
  it('取首 token 并转小写', () => {
    expect(extractRedisCommand('GET user:1')).toBe('get');
    expect(extractRedisCommand('  config set dir /tmp ')).toBe('config');
  });

  it('非法/空命令返回 null', () => {
    expect(extractRedisCommand('')).toBeNull();
    expect(extractRedisCommand('123')).toBeNull();
  });
});

describe('只读模式：仅允许纯读命令', () => {
  for (const cmd of ['GET user:1', 'MGET a b', 'SCAN 0', 'HGETALL h', 'INFO', 'DBSIZE', 'ZRANGE z 0 -1']) {
    it(`允许 ${cmd}`, () => {
      expect(decideRedisCommand(cmd, ['read']).allowed).toBe(true);
    });
  }

  for (const cmd of [
    'SET k v',
    'DEL k',
    'FLUSHALL',
    'FLUSHDB',
    'CONFIG SET dir /tmp',
    'CONFIG GET maxmemory',
    'EVAL "return 1" 0',
    'MODULE LOAD /tmp/x.so',
    'SLAVEOF 1.2.3.4 6379',
    'SHUTDOWN',
    'SAVE',
    'SCRIPT LOAD "return 1"',
    'KEYS_EXPENSIVE_OR_UNKNOWN',
  ]) {
    it(`拒绝 ${cmd}`, () => {
      expect(decideRedisCommand(cmd, ['read']).allowed).toBe(false);
    });
  }

  it('拒绝包含换行的命令（防一条字符串塞多条命令）', () => {
    expect(decideRedisCommand('GET a\nSET b c', ['read']).allowed).toBe(false);
  });
});

describe('非只读模式：按命令类别校验权限', () => {
  it('readwrite：SET 允许、DEL 拒绝、CONFIG 拒绝', () => {
    expect(decideRedisCommand('SET k v', ['read', 'insert', 'update']).allowed).toBe(true);
    expect(decideRedisCommand('DEL k', ['read', 'insert', 'update']).allowed).toBe(false);
    expect(decideRedisCommand('CONFIG SET dir /tmp', ['read', 'insert', 'update']).allowed).toBe(false);
  });

  it('insert-only 自定义权限：SET 允许、EXPIRE 拒绝', () => {
    expect(decideRedisCommand('SET k v', ['read', 'insert']).allowed).toBe(true);
    expect(decideRedisCommand('EXPIRE k 10', ['read', 'insert']).allowed).toBe(false);
  });

  it('full：EVAL / 未知命令允许', () => {
    const full: PermissionType[] = ['read', 'insert', 'update', 'delete', 'ddl'];
    expect(decideRedisCommand('EVAL "return 1" 0', full).allowed).toBe(true);
    expect(decideRedisCommand('SOME_MODULE_CMD x', full).allowed).toBe(true);
  });

  it('readwrite：未知命令默认拒绝', () => {
    expect(decideRedisCommand('SOME_MODULE_CMD x', ['read', 'insert', 'update']).allowed).toBe(false);
  });
});

describe('validateQuery 对 Redis 的接线', () => {
  it('safe 下 GET 允许', () => {
    expect(() => validateQuery('GET user:1', redis('safe'))).not.toThrow();
  });

  it('safe 下 FLUSHALL 被拒绝', () => {
    expect(() => validateQuery('FLUSHALL', redis('safe'))).toThrow(/操作被拒绝|不允许/);
  });

  it('full 下 CONFIG SET 允许', () => {
    expect(() => validateQuery('CONFIG SET maxmemory 100mb', redis('full'))).not.toThrow();
  });
});
