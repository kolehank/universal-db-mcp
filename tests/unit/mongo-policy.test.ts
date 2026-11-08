/**
 * MongoDB 操作权限策略（P0-3）单元测试
 */

import { describe, it, expect } from 'vitest';
import {
  decideMongoOperation,
  decideMongoQuery,
  parseMongoQuery,
} from '../../src/utils/mongo-command-policy';
import { validateQuery } from '../../src/utils/safety';
import type { DbConfig, PermissionType } from '../../src/types/adapter';

const READ: PermissionType[] = ['read'];
const READWRITE: PermissionType[] = ['read', 'insert', 'update'];
const FULL: PermissionType[] = ['read', 'insert', 'update', 'delete', 'ddl'];

function mongo(permissions: PermissionType[]): DbConfig {
  return { type: 'mongodb', permissionMode: 'custom', permissions };
}

describe('parseMongoQuery', () => {
  it('解析 JSON 格式', () => {
    const parsed = parseMongoQuery(
      '{"collection":"users","operation":"find","query":{"age":{"$gt":18}}}'
    );
    expect(parsed.collection).toBe('users');
    expect(parsed.operation).toBe('find');
  });

  it('解析 db.collection.operation() 格式', () => {
    const parsed = parseMongoQuery('db.users.findOne({"id":1})');
    expect(parsed.collection).toBe('users');
    expect(parsed.operation).toBe('findOne');
  });

  it('非法格式抛错', () => {
    expect(() => parseMongoQuery('not a mongo query')).toThrow(/不支持的查询格式/);
    expect(() => parseMongoQuery('{"operation":"find"}')).toThrow(/collection/);
  });
});

describe('只读模式：仅允许读操作', () => {
  for (const query of [
    '{"collection":"users","operation":"find","query":{}}',
    '{"collection":"users","operation":"count","query":{}}',
    '{"collection":"users","operation":"distinct","options":{"field":"status"}}',
    '{"collection":"users","operation":"aggregate","pipeline":[{"$match":{}}]}',
    'db.users.find({})',
  ]) {
    it(`允许 ${query.slice(0, 50)}`, () => {
      expect(decideMongoQuery(query, READ).allowed).toBe(true);
    });
  }

  for (const query of [
    '{"collection":"users","operation":"insert","query":{"name":"a"}}',
    '{"collection":"users","operation":"update","query":{},"update":{"$set":{"a":1}}}',
    '{"collection":"users","operation":"delete","query":{}}',
    '{"collection":"users","operation":"drop"}',
    '{"collection":"users","operation":"aggregate","pipeline":[{"$out":"backup"}]}',
    '{"collection":"users","operation":"aggregate","pipeline":[{"$merge":"backup"}]}',
    '{"collection":"users","operation":"find","query":{"$where":"sleep(10000)"}}',
    '{"collection":"users","operation":"aggregate","pipeline":[{"$function":{"body":"return 1"}}]}',
  ]) {
    it(`拒绝 ${query.slice(0, 60)}`, () => {
      const decision = decideMongoQuery(query, READ);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/操作被拒绝/);
    });
  }
});

describe('readwrite 模式：允许插入/更新，不允许删除/DDL', () => {
  it('insert / update 允许', () => {
    expect(
      decideMongoQuery('{"collection":"users","operation":"insert","query":{"a":1}}', READWRITE).allowed
    ).toBe(true);
    expect(
      decideMongoQuery(
        '{"collection":"users","operation":"update","query":{},"update":{"$set":{"a":1}}}',
        READWRITE
      ).allowed
    ).toBe(true);
  });

  it('delete / $out 拒绝；$merge 允许', () => {
    expect(decideMongoQuery('{"collection":"users","operation":"delete","query":{}}', READWRITE).allowed).toBe(false);
    expect(
      decideMongoQuery(
        '{"collection":"users","operation":"aggregate","pipeline":[{"$out":"backup"}]}',
        READWRITE
      ).allowed
    ).toBe(false);
    expect(
      decideMongoQuery(
        '{"collection":"users","operation":"aggregate","pipeline":[{"$merge":"backup"}]}',
        READWRITE
      ).allowed
    ).toBe(true);
  });

  it('$where 需要 full（ddl）', () => {
    expect(
      decideMongoQuery('{"collection":"users","operation":"find","query":{"$where":"1"}}', READWRITE).allowed
    ).toBe(false);
  });
});

describe('full 模式', () => {
  it('允许删除与服务端脚本（js 执行由 full 承担）', () => {
    expect(decideMongoQuery('{"collection":"users","operation":"delete","query":{}}', FULL).allowed).toBe(true);
    expect(
      decideMongoQuery('{"collection":"users","operation":"find","query":{"$where":"1"}}', FULL).allowed
    ).toBe(true);
  });

  it('未知操作仍要求 ddl（适配器最终会报不支持）', () => {
    const decision = decideMongoOperation(
      { collection: 'users', operation: 'unknownOp' },
      FULL
    );
    expect(decision.requiredPermission).toBe('ddl');
  });
});

describe('validateQuery 对 MongoDB 的接线', () => {
  it('safe 下 find 放行', () => {
    expect(() =>
      validateQuery('{"collection":"users","operation":"find","query":{}}', mongo(['read']))
    ).not.toThrow();
  });

  it('safe 下 insert 拒绝', () => {
    expect(() =>
      validateQuery('{"collection":"users","operation":"insert","query":{"a":1}}', mongo(['read']))
    ).toThrow(/操作被拒绝/);
  });

  it('非法 JSON 拒绝（不再静默放行）', () => {
    expect(() => validateQuery('{bad json', mongo(['read']))).toThrow(/操作被拒绝/);
  });
});
