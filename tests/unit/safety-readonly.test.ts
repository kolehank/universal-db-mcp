/**
 * 只读模式绕过防护（P0-1）单元测试
 *
 * 覆盖审查报告中确认可绕过的语句形态，以及正常查询不应被误杀。
 */

import { describe, it, expect } from 'vitest';
import { validateQuery, isReadOnlyConfig, stripSqlLiterals } from '../../src/utils/safety';
import type { DbConfig, PermissionType } from '../../src/types/adapter';

function cfg(
  type: DbConfig['type'] = 'mysql',
  permissionMode: DbConfig['permissionMode'] = 'safe',
  permissions?: PermissionType[]
): DbConfig {
  return permissions ? { type, permissionMode: 'custom', permissions } : { type, permissionMode };
}

describe('只读模式：审查报告中的绕过语句必须被拒绝', () => {
  const bypasses = [
    'SELECT 1; DROP TABLE users',
    'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x',
    'EXPLAIN ANALYZE DELETE FROM t',
    'SELECT * FROM t INTO OUTFILE "/tmp/x"',
    'SELECT * FROM t INTO DUMPFILE "/tmp/x"',
    'CALL proc_that_writes()',
    'MERGE INTO t USING s ON (1=1) WHEN MATCHED THEN DELETE',
    'SET default_transaction_read_only = off',
    'BEGIN UPDATE t SET x = 1; END;',
    'PRAGMA writable_schema = ON',
    'ATTACH DATABASE "/tmp/evil.db" AS evil',
    '/*!50000 DROP TABLE users*/',
    '-- note\nDROP TABLE users',
    'SELECT pg_read_file("/etc/passwd")',
    'SELECT load_file("/etc/passwd")',
    'SELECT * FROM users FOR UPDATE',
    'TRUNCATE TABLE users',
  ];

  for (const sql of bypasses) {
    it(`拒绝：${sql.replace(/\s+/g, ' ').slice(0, 60)}`, () => {
      expect(() => validateQuery(sql, cfg('mysql'))).toThrow(/操作被拒绝/);
    });
  }
});

describe('只读模式：正常查询不应被误杀', () => {
  const allowed = [
    'SELECT 1',
    'SELECT * FROM users WHERE name = \'DROP TABLE users\'',
    'SELECT * FROM "delete"',
    'SELECT replace(name, \'a\', \'b\') FROM users',
    'EXPLAIN SELECT * FROM users WHERE id = 1',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'SHOW TABLES',
    'DESCRIBE users',
    'PRAGMA table_info(users)',
    'PRAGMA main.table_info(users)',
    '-- leading comment\nSELECT 1',
    'SELECT 1 /* trailing comment */',
  ];

  for (const sql of allowed) {
    it(`允许：${sql.replace(/\s+/g, ' ').slice(0, 60)}`, () => {
      expect(() => validateQuery(sql, cfg('mysql'))).not.toThrow();
    });
  }

  it('SQLite 只读 PRAGMA 正常放行', () => {
    expect(() => validateQuery('PRAGMA table_info(users)', cfg('sqlite'))).not.toThrow();
  });

  it('SQLite full 权限下仍拒绝 ATTACH / DETACH（P0-7）', () => {
    expect(() =>
      validateQuery('ATTACH DATABASE "/tmp/evil.db" AS evil', cfg('sqlite', 'full'))
    ).toThrow(/ATTACH/);
    expect(() =>
      validateQuery('DETACH DATABASE evil', cfg('sqlite', 'full'))
    ).toThrow(/ATTACH|DETACH/);
  });

  it('SQLite full 权限下仍拒绝 VACUUM INTO（P0-7）', () => {
    expect(() =>
      validateQuery('VACUUM INTO "/tmp/dump.db"', cfg('sqlite', 'full'))
    ).toThrow(/VACUUM INTO/);
  });

  it('空语句被拒绝', () => {
    expect(() => validateQuery('   ', cfg('mysql'))).toThrow(/不能为空/);
  });
});

describe('非只读模式：多语句也不能绕过权限', () => {
  it('readwrite 下 SELECT; DELETE 被拒绝', () => {
    expect(() => validateQuery('SELECT 1; DELETE FROM users', cfg('mysql', 'readwrite'))).toThrow(
      /DELETE/
    );
  });

  it('readwrite 下 INSERT + UPDATE 允许', () => {
    expect(() => validateQuery('INSERT INTO t VALUES (1); UPDATE t SET x = 2', cfg('mysql', 'readwrite'))).not.toThrow();
  });

  it('readwrite 下 WITH ... DELETE 被拒绝', () => {
    expect(() =>
      validateQuery('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', cfg('postgres', 'readwrite'))
    ).toThrow(/DELETE/);
  });

  it('readwrite 下 EXPLAIN ANALYZE DELETE 被拒绝', () => {
    expect(() => validateQuery('EXPLAIN ANALYZE DELETE FROM t', cfg('postgres', 'readwrite'))).toThrow(
      /DELETE/
    );
  });

  it('readwrite 下 CALL 被拒绝（按 DDL 处理）', () => {
    expect(() => validateQuery('CALL proc_that_writes()', cfg('mysql', 'readwrite'))).toThrow(/CALL/);
  });

  it('full 允许 DDL 与多语句', () => {
    expect(() => validateQuery('DROP TABLE t; CREATE TABLE t (id int)', cfg('mysql', 'full'))).not.toThrow();
  });

  it('自定义权限：只允许 read+insert 时 UPDATE 被拒绝', () => {
    expect(() => validateQuery('UPDATE t SET x = 1', cfg('mysql', 'custom', ['read', 'insert']))).toThrow(
      /UPDATE/
    );
  });
});

describe('isReadOnlyConfig', () => {
  it('safe 为只读', () => {
    expect(isReadOnlyConfig({ type: 'mysql', permissionMode: 'safe' })).toBe(true);
  });

  it('readwrite / full 不是只读', () => {
    expect(isReadOnlyConfig({ type: 'mysql', permissionMode: 'readwrite' })).toBe(false);
    expect(isReadOnlyConfig({ type: 'mysql', permissionMode: 'full' })).toBe(false);
  });

  it('allowWrite=true（无其他参数）不是只读', () => {
    expect(isReadOnlyConfig({ type: 'sqlite', allowWrite: true })).toBe(false);
  });

  it('自定义权限只有 read 才是只读', () => {
    expect(isReadOnlyConfig({ type: 'mysql', permissionMode: 'custom', permissions: ['read'] })).toBe(true);
    expect(isReadOnlyConfig({ type: 'mysql', permissionMode: 'custom', permissions: ['read', 'insert'] })).toBe(false);
  });
});

describe('stripSqlLiterals', () => {
  it('抹掉字符串与引号标识符内容', () => {
    const stripped = stripSqlLiterals(`SELECT 'DROP TABLE x', "DELETE" FROM t`);
    expect(stripped).not.toMatch(/DROP TABLE/);
    expect(stripped).not.toMatch(/DELETE/);
    expect(stripped).toMatch(/SELECT/);
  });

  it('保留 MySQL 可执行注释内部内容', () => {
    const stripped = stripSqlLiterals('/*!50000 DROP TABLE users*/');
    expect(stripped.toUpperCase()).toMatch(/DROP/);
  });
});
