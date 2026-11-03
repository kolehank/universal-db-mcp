/**
 * 数据源注册表模块单元测试
 * 覆盖：ENV 展开、校验规则 §3.3（8 条）、一次性列出所有错误、§4.1 权限算法、fingerprint、白名单匹配。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRegistryFromRaw,
  keyFingerprint,
  isAdhocAllowed,
  loadDatasourceRegistry,
  minPermission,
  resolveEffectivePermission,
} from '../../src/security/datasource-registry';
import type { PermissionLevel } from '../../src/security/datasource-registry';

const FIXTURES = join(__dirname, '..', 'fixtures');

/** 合法配置模板（测试内按需展开修改） */
function validRaw(): Record<string, unknown> {
  return {
    $schemaVersion: 1,
    apiKeys: [{ key: 'key-a', name: 'key-a-name', allowedSources: ['db1'] }],
    sources: [
      { name: 'db1', type: 'mysql', host: '10.0.0.1', port: 3306, user: 'u', password: 'p', database: 'd' },
    ],
  };
}

/** 把字符串改写成单引号 JSON 键（便于内联构建测试配置） */
function rawWith(overrides: Partial<Record<string, unknown>>): Record<string, unknown> {
  return { ...validRaw(), ...overrides };
}

function loadValid(overrides?: Partial<Record<string, unknown>>) {
  return buildRegistryFromRaw(overrides ? rawWith(overrides) : validRaw(), 'test');
}

const originalEnv = process.env;
let tmpDir: string;

beforeEach(() => {
  process.env = { ...originalEnv };
  tmpDir = mkdtempSync(join(tmpdir(), 'udbmcp-reg-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  process.env = originalEnv;
});

function writeTempConfig(json: unknown): string {
  const file = join(tmpDir, `reg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(json, null, 2), 'utf-8');
  return file;
}

describe('loadDatasourceRegistry（文件加载 + ENV 展开）', () => {
  it('应成功加载合法 fixture（2 源 / 2 key）', () => {
    const reg = loadDatasourceRegistry(join(FIXTURES, 'registry.json'));
    expect(reg.sources).toHaveLength(2);
    expect(reg.apiKeys).toHaveLength(2);
    expect(reg.allowAdhocConnections).toBe(false);
    expect(reg.adhocTargetAllowlist).toEqual([]);
    expect(reg.sources.map(s => s.name)).toEqual(['ok-ro', 'ok-rw']);
    expect(reg.apiKeys.map(k => k.name)).toEqual(['k-full', 'k-ro']);
  });

  it('${ENV:VAR} 应展开为环境变量值', () => {
    process.env.UDBMCP_TEST_HOST = '10.9.8.7';
    const file = writeTempConfig(rawWith({ sources: [{ name: 'db1', type: 'mysql', host: '${ENV:UDBMCP_TEST_HOST}', port: 3306 }] }));
    const reg = loadDatasourceRegistry(file);
    expect(reg.resolveSource('db1')?.host).toBe('10.9.8.7');
  });

  it('${ENV:VAR} 可出现在任意字符串值中（含 key 字段与内嵌）', () => {
    process.env.UDBMCP_TEST_KEY = 'expanded-key';
    process.env.UDBMCP_TEST_SUFFIX = '-suffix';
    const file = writeTempConfig({
      $schemaVersion: 1,
      apiKeys: [{ key: '${ENV:UDBMCP_TEST_KEY}', name: 'n1', allowedSources: ['db1'] }],
      sources: [{ name: 'db1', type: 'mysql', host: 'db${ENV:UDBMCP_TEST_SUFFIX}', port: 3306 }],
    });
    const reg = loadDatasourceRegistry(file);
    expect(reg.findKey('expanded-key')).toBeDefined();
    expect(reg.resolveSource('db1')?.host).toBe('db-suffix');
  });

  it('引用的环境变量不存在 → 报错（不允许静默空串）', () => {
    const file = writeTempConfig(rawWith({ sources: [{ name: 'db1', type: 'mysql', host: '${ENV:UDBMCP_DEFINITELY_MISSING_VAR}', port: 3306 }] }));
    expect(() => loadDatasourceRegistry(file)).toThrow(/UDBMCP_DEFINITELY_MISSING_VAR/);
    expect(() => loadDatasourceRegistry(file)).toThrow(/\$\{ENV:UDBMCP_DEFINITELY_MISSING_VAR\}/);
  });

  it('文件不存在 → 报错且包含路径', () => {
    const missing = join(tmpDir, 'does-not-exist.json');
    expect(() => loadDatasourceRegistry(missing)).toThrow(/无法读取数据源注册表文件/);
    expect(() => loadDatasourceRegistry(missing)).toThrow(/does-not-exist\.json/);
  });

  it('文件内容不是合法 JSON → 报错', () => {
    const file = join(tmpDir, 'bad.json');
    writeFileSync(file, '{ not json', 'utf-8');
    expect(() => loadDatasourceRegistry(file)).toThrow(/无法读取数据源注册表文件/);
  });
});

describe('校验规则（§3.3）', () => {
  it('$schemaVersion 缺失 → 报错', () => {
    expect(() => loadValid({ $schemaVersion: undefined as unknown })).toThrow(/\$schemaVersion/);
  });

  it('$schemaVersion 非 1 → 报错', () => {
    expect(() => loadValid({ $schemaVersion: 2 })).toThrow(/\$schemaVersion/);
  });

  it('name 正则合法边界：a 开头/数字/下划线/连字符均可', () => {
    expect(() =>
      loadValid({ sources: [
        { name: 'a', type: 'mysql', host: 'h', port: 1 },
        { name: 'db1', type: 'mysql', host: 'h', port: 1 },
        { name: 'my_db_x', type: 'mysql', host: 'h', port: 1 },
        { name: 'my-db-y', type: 'mysql', host: 'h', port: 1 },
      ] })
    ).not.toThrow();
  });

  it('name 大写非法 → 报错', () => {
    expect(() => loadValid({ sources: [{ name: 'Db1', type: 'mysql', host: 'h', port: 1 }] })).toThrow(/不符合/);
  });

  it('name 以连字符开头非法 → 报错', () => {
    expect(() => loadValid({ sources: [{ name: '-db', type: 'mysql', host: 'h', port: 1 }] })).toThrow(/不符合/);
  });

  it('name 超过 64 字符非法 → 报错', () => {
    expect(() => loadValid({ sources: [{ name: `a${'b'.repeat(64)}`, type: 'mysql', host: 'h', port: 1 }] })).toThrow(/不符合/);
  });

  it('source name 重复 → 报错', () => {
    expect(() =>
      loadValid({ sources: [
        { name: 'db1', type: 'mysql', host: 'h', port: 1 },
        { name: 'db1', type: 'mysql', host: 'h2', port: 2 },
      ] })
    ).toThrow(/重复的源名/);
  });

  it('type 别名 mssql/opengauss 应被接受（normalizeDbType）', () => {
    expect(() => loadValid({ sources: [
      { name: 'db1', type: 'mssql', host: 'h', port: 1433 },
      { name: 'db2', type: 'opengauss', host: 'h2', port: 5432 },
    ] })).not.toThrow();
  });

  it('type 非法 → 报错', () => {
    expect(() => loadValid({ sources: [{ name: 'db1', type: 'not-a-db', host: 'h', port: 1 }] })).toThrow(/不支持的数据库类型/);
  });

  it('maxPermission 非法值 → 报错', () => {
    expect(() => loadValid({ sources: [{ name: 'db1', type: 'mysql', host: 'h', port: 1, maxPermission: 'super' }] })).toThrow(/maxPermission/);
  });

  it('maxPermission 缺省视为 safe（§4.1 sourceMax ?? safe）', () => {
    expect(resolveEffectivePermission({}, undefined)).toBe('safe');
    const reg = loadValid();
    expect(reg.sources[0].maxPermission).toBeUndefined();
    expect(resolveEffectivePermission(reg.resolveSource('db1'), undefined)).toBe('safe');
  });

  it('apiKeys[].key 重复 → 报错', () => {
    expect(() =>
      loadValid({ apiKeys: [
        { key: 'same', name: 'a', allowedSources: [] },
        { key: 'same', name: 'b', allowedSources: [] },
      ] })
    ).toThrow(/重复的 key/);
  });

  it('apiKeys[].key 为空 → 报错', () => {
    expect(() => loadValid({ apiKeys: [{ key: '', name: 'a', allowedSources: [] }] })).toThrow(/缺少非空 key/);
  });

  it('apiKeys[].name 重复 → 报错', () => {
    expect(() =>
      loadValid({ apiKeys: [
        { key: 'k1', name: 'dup', allowedSources: [] },
        { key: 'k2', name: 'dup', allowedSources: [] },
      ] })
    ).toThrow(/重复的 key 名/);
  });

  it('apiKeys[].name 为空 → 报错', () => {
    expect(() => loadValid({ apiKeys: [{ key: 'k1', name: '', allowedSources: [] }] })).toThrow(/缺少非空 name/);
  });

  it('allowedSources 悬挂引用 → 报错', () => {
    expect(() => loadValid({ apiKeys: [{ key: 'k1', name: 'a', allowedSources: ['ghost'] }] })).toThrow(/悬挂引用 "ghost"/);
  });

  it('allowedSources 禁止 "*" → 报错', () => {
    expect(() => loadValid({ apiKeys: [{ key: 'k1', name: 'a', allowedSources: ['*'] }] })).toThrow(/禁止通配符/);
  });

  it('allowedSources 空数组 = 不能访问任何源（合法加载）', () => {
    const reg = loadValid({ apiKeys: [{ key: 'k1', name: 'a', allowedSources: [] }] });
    expect(reg.apiKeys).toHaveLength(1);
  });

  it('allowedSources 缺省 = 不能访问任何源（合法加载）', () => {
    const reg = loadValid({ apiKeys: [{ key: 'k1', name: 'a' }] });
    expect(reg.apiKeys[0].allowedSources).toEqual([]);
  });

  it('adhocTargetAllowlist 接受 host:port（host 大小写均可）', () => {
    const reg = loadValid({ adhocTargetAllowlist: ['db.internal:5432', '10.1.2.3:3306'] });
    expect(reg.adhocTargetAllowlist).toEqual(['db.internal:5432', '10.1.2.3:3306']);
  });

  it('adhocTargetAllowlist 带空格 → 报错', () => {
    expect(() => loadValid({ adhocTargetAllowlist: ['10.1.2.3 :3306'] })).toThrow(/非法条目/);
    expect(() => loadValid({ adhocTargetAllowlist: ['db.internal: 5432'] })).toThrow(/非法条目/);
  });

  it('adhocTargetAllowlist 拒绝 CIDR 与通配符', () => {
    expect(() => loadValid({ adhocTargetAllowlist: ['10.0.0.0/8'] })).toThrow(/非法条目/);
    expect(() => loadValid({ adhocTargetAllowlist: ['*:3306'] })).toThrow(/非法条目/);
  });

  it('adhocTargetAllowlist 缺端口 → 报错', () => {
    expect(() => loadValid({ adhocTargetAllowlist: ['10.1.2.3'] })).toThrow(/非法条目/);
  });

  it('adhocTargetAllowlist 端口非法（非数字/越界）→ 报错', () => {
    expect(() => loadValid({ adhocTargetAllowlist: ['10.1.2.3:abc'] })).toThrow(/非法条目/);
    expect(() => loadValid({ adhocTargetAllowlist: ['10.1.2.3:70000'] })).toThrow(/非法条目/);
  });

  it('sqlite 源必须 filePath → 报错', () => {
    expect(() => loadValid({ sources: [{ name: 's1', type: 'sqlite' }] })).toThrow(/filePath/);
  });

  it('sqlite 源不得有 host/port → 报错', () => {
    expect(() => loadValid({ sources: [{ name: 's1', type: 'sqlite', filePath: '/tmp/a.db', host: 'h' }] })).toThrow(/host/);
    expect(() => loadValid({ sources: [{ name: 's1', type: 'sqlite', filePath: '/tmp/a.db', port: 1 }] })).toThrow(/port/);
  });

  it('sqlite 源合法（filePath + 无 host/port）→ 加载成功', () => {
    const reg = loadValid({
      sources: [{ name: 's1', type: 'sqlite', filePath: '/tmp/a.db' }],
      apiKeys: [{ key: 'k1', name: 'a', allowedSources: ['s1'] }],
    });
    expect(reg.resolveSource('s1')?.filePath).toBe('/tmp/a.db');
  });

  it('allowAdhocConnections 非布尔 → 报错', () => {
    expect(() => loadValid({ allowAdhocConnections: 'yes' })).toThrow(/布尔/);
  });
});

describe('一次性列出所有错误（收集全部后一起抛出）', () => {
  it('invalid fixture：多条错误逐行列出在同一个 message 中', () => {
    let message = '';
    try {
      loadDatasourceRegistry(join(FIXTURES, 'registry-invalid.json'));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('校验失败');
    // 至少断言 3 类不同的错误同时出现
    for (const fragment of ['重复的源名', '悬挂引用', '重复的 key']) {
      expect(message).toContain(fragment);
    }
    expect(message).toContain('禁止通配符');
    expect(message).toContain('不符合');
    expect(message).toContain('不支持的数据库类型');
    expect(message).toContain('非法条目');
    // 逐行列出：换行数量 >= 6
    expect(message.split('\n').length).toBeGreaterThanOrEqual(7);
  });

  it('单个错误也通过同一路径抛出且只含该行', () => {
    expect(() => loadValid({ sources: [{ name: 'Db1', type: 'mysql', host: 'h', port: 1 }] })).toThrow('Db1');
  });
});

describe('resolveEffectivePermission（§4.1 min 全组合）', () => {
  const combos: Array<[PermissionLevel, PermissionLevel, PermissionLevel]> = [
    ['safe', 'safe', 'safe'],
    ['safe', 'readwrite', 'safe'],
    ['safe', 'full', 'safe'],
    ['readwrite', 'safe', 'safe'],
    ['readwrite', 'readwrite', 'readwrite'],
    ['readwrite', 'full', 'readwrite'],
    ['full', 'safe', 'safe'],
    ['full', 'readwrite', 'readwrite'],
    ['full', 'full', 'full'],
  ];

  it('sourceMax × keyMax 全 9 组合均为 min', () => {
    for (const [s, k, expected] of combos) {
      expect(resolveEffectivePermission({ maxPermission: s }, { maxPermission: k }), `min(${s},${k})`).toBe(expected);
      expect(minPermission(s, k), `minPermission(${s},${k})`).toBe(expected);
    }
  });

  it('key 缺省 → 取 keyMax=full，即等于 sourceMax', () => {
    expect(resolveEffectivePermission({ maxPermission: 'safe' })).toBe('safe');
    expect(resolveEffectivePermission({ maxPermission: 'readwrite' })).toBe('readwrite');
    expect(resolveEffectivePermission({ maxPermission: 'full' })).toBe('full');
  });

  it('source 缺省 → 取 sourceMax=safe', () => {
    expect(resolveEffectivePermission(undefined, { maxPermission: 'full' })).toBe('safe');
    expect(resolveEffectivePermission(undefined, undefined)).toBe('safe');
  });
});

describe('keyFingerprint / isAdhocAllowed', () => {
  it('keyFingerprint 为 sha256 前 12 位 hex（小写）', () => {
    const fp = keyFingerprint('test-key-full');
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    expect(fp).toHaveLength(12);
  });

  it('keyFingerprint 确定且不同 key 不同', () => {
    expect(keyFingerprint('abc')).toBe(keyFingerprint('abc'));
    expect(keyFingerprint('abc')).not.toBe(keyFingerprint('abd'));
    expect(keyFingerprint('test-key-full')).toBe('ffb4ab2864c0');
  });

  it('isAdhocAllowed 精确匹配；host 大小写不敏感', () => {
    const allowlist = ['10.1.2.3:3306', 'db.Internal:5432'];
    expect(isAdhocAllowed('10.1.2.3:3306', allowlist)).toBe(true);
    expect(isAdhocAllowed('DB.INTERNAL:5432', allowlist)).toBe(true);
    expect(isAdhocAllowed('db.internal:5432', allowlist)).toBe(true);
    expect(isAdhocAllowed('10.1.2.3:3307', allowlist)).toBe(false);
    expect(isAdhocAllowed('10.1.2.4:3306', allowlist)).toBe(false);
    expect(isAdhocAllowed('10.1.2.3', allowlist)).toBe(false);
    expect(isAdhocAllowed('10.1.2.3:3306', [])).toBe(false);
    expect(isAdhocAllowed('10.1.2.3:3306', undefined)).toBe(false);
  });
});

describe('DatasourceRegistry 只读访问器与受控查找', () => {
  it('sources/apiKeys 为只读数组', () => {
    const reg = loadValid();
    expect(Array.isArray(reg.sources)).toBe(true);
    expect(Array.isArray(reg.apiKeys)).toBe(true);
  });

  it('listSources 仅含 name/type/description，不含 host/port/user/password', () => {
    const reg = loadDatasourceRegistry(join(FIXTURES, 'registry.json'));
    const listed = reg.listSources();
    for (const item of listed) {
      for (const secretKey of ['host', 'port', 'user', 'password']) {
        expect(Object.keys(item)).not.toContain(secretKey);
      }
      expect(JSON.stringify(item)).not.toMatch(/10\.1\.2\.\d|test-pass|test-user/);
    }
    expect(listed.map(s => s.name)).toEqual(['ok-ro', 'ok-rw']);
    expect(listed[0].description).toBe('只读测试源');
  });

  it('resolveSource 返回含明文连接参数的完整定义', () => {
    const reg = loadDatasourceRegistry(join(FIXTURES, 'registry.json'));
    const source = reg.resolveSource('ok-ro');
    expect(source?.host).toBe('10.1.2.3');
    expect(source?.port).toBe(3306);
    expect(source?.user).toBe('test-user');
    expect(source?.password).toBe('test-pass');
    expect(reg.resolveSource('nope')).toBeUndefined();
  });

  it('findKey / getKeyByFingerprint 反查', () => {
    const reg = loadDatasourceRegistry(join(FIXTURES, 'registry.json'));
    const key = reg.findKey('test-key-ro');
    expect(key?.name).toBe('k-ro');
    expect(key?.allowedSources).toEqual(['ok-ro']);
    expect(reg.findKey('wrong-key')).toBeUndefined();
    const fp = keyFingerprint('test-key-ro');
    expect(reg.getKeyByFingerprint(fp)?.name).toBe('k-ro');
    expect(reg.getKeyByFingerprint('000000000000')).toBeUndefined();
  });

  it('effectivePermission 实例方法按 §4.1 计算', () => {
    const reg = loadDatasourceRegistry(join(FIXTURES, 'registry.json'));
    // ok-ro safe；k-full full → safe；k-ro 缺省(full) → safe
    expect(reg.effectivePermission('ok-ro', reg.findKey('test-key-full'))).toBe('safe');
    expect(reg.effectivePermission('ok-ro', reg.findKey('test-key-ro'))).toBe('safe');
    // ok-rw readwrite；k-full full → readwrite
    expect(reg.effectivePermission('ok-rw', reg.findKey('test-key-full'))).toBe('readwrite');
    // stdio 无 key → 取 sourceMax
    expect(reg.effectivePermission('ok-rw', undefined)).toBe('readwrite');
  });
});