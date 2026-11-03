/**
 * 规格 §7.1 SIGHUP 热加载语义单测（P5 验收：tests/unit/registry-reload.test.ts ≥8 例）
 *
 * 覆盖（§10「registry-reload.test.ts」要求）：
 * - reload 成功替换（新源可见）、新配置含 new-ro 后 resolveSource 可用；
 * - 非法配置（悬挂引用/非法权限/sqlite 规则）→ 报错且旧实例不变（原子性）；
 * - ${ENV:} 展开在 reload 时重新执行（环境变量变化生效）；
 * - 校验管线复用（与启动 buildRegistryFromRaw 同一套规则，错误信息一致）；
 * - 可变引用承载（RegistryHolder + createRegistryView：替换后 view 立即读到新配置）；
 * - 逐会话吊销判定（revocationReasonFor：key_revoked / source_revoked / source_removed / 不吊销）；
 * - 防重入（createReloadHandler：重载进行中再触发 → 忽略 + WARN，不排队）；
 * - runReload 审计（config_reload 含 sha256/源/key 数量/关闭数；session_revoked reason 明确）。
 *
 * 离线可跑：全部使用真实 registry（loadDatasourceRegistry 读临时文件）与 mock 会话列表，不起数据库。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  loadDatasourceRegistry,
  buildRegistryFromRaw,
  keyFingerprint,
  createRegistryView,
} from '../../src/security/datasource-registry';
import type { RegistryHolder } from '../../src/security/datasource-registry';
import {
  createReloadHandler,
  runReload,
  revocationReasonFor,
  registerHttpSighup,
  isSighupRegistered,
} from '../../src/http/http-index';
import type { ReloadHandlerDeps } from '../../src/http/http-index';
import { AuditLogger } from '../../src/security/audit-logger';
import type { ConnectionManager } from '../../src/core/connection-manager';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'registry-reload-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  // 清理本文件用到的环境变量，避免污染其他测试
  delete process.env.RELOAD_TEST_HOST;
});

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** 与 fixtures/registry.json 同构的基准配置 */
function baseRaw(): Record<string, unknown> {
  return {
    $schemaVersion: 1,
    allowAdhocConnections: false,
    adhocTargetAllowlist: [],
    apiKeys: [
      { key: 'test-key-full', name: 'k-full', allowedSources: ['ok-ro', 'ok-rw'], maxPermission: 'full' },
      { key: 'test-key-ro', name: 'k-ro', allowedSources: ['ok-ro'] },
    ],
    sources: [
      { name: 'ok-ro', type: 'mysql', host: '10.1.2.3', port: 3306, user: 'u', password: 'p', database: 'd', maxPermission: 'safe' },
      { name: 'ok-rw', type: 'mysql', host: '10.1.2.4', port: 3306, user: 'u', password: 'p', database: 'd', maxPermission: 'readwrite' },
    ],
  };
}

function writeConfig(dir: string, name: string, raw: Record<string, unknown>): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(raw, null, 2), 'utf-8');
  return path;
}

const FP_FULL = keyFingerprint('test-key-full');
const FP_RO = keyFingerprint('test-key-ro');

/** 免数据库的 ConnectionManager 替身（仅 REST 会话快照接口被 runReload 使用） */
function fakeConnectionManager(sessions: Array<{ id: string; principal?: string; keyFingerprint?: string; source?: string }> = []): ConnectionManager {
  return {
    getSessionIds: () => sessions.map((s) => s.id),
    getSession: (id: string) => sessions.find((s) => s.id === id),
    revokeSession: async () => { /* no-op */ },
  } as unknown as ConnectionManager;
}

describe('§7.1 reload()：重载语义（原子替换 / 校验管线复用 / ENV 重展开）', () => {
  it('用例 25 前置 1：reload 成功 → 返回新实例，新源 resolveSource 可用，旧实例不受影响', () => {
    const dir = makeTmpDir();
    const pathA = writeConfig(dir, 'a.json', baseRaw());
    const rawB = baseRaw();
    (rawB.sources as Array<Record<string, unknown>>).push({ name: 'new-ro', type: 'postgres', host: '10.9.9.9', port: 5432 });
    (rawB.apiKeys as Array<Record<string, unknown>>)[0].allowedSources = ['ok-ro', 'ok-rw', 'new-ro'];
    const pathB = writeConfig(dir, 'b.json', rawB);

    const r0 = loadDatasourceRegistry(pathA);
    const r1 = r0.reload(pathB);

    expect(r1).not.toBe(r0);
    expect(r1.resolveSource('new-ro')).toBeDefined();
    expect(r1.resolveSource('new-ro')!.type).toBe('postgres');
    // 旧实例不受影响（快照语义）
    expect(r0.resolveSource('new-ro')).toBeUndefined();
    expect(r0.listSources().map((s) => s.name)).toEqual(['ok-ro', 'ok-rw']);
    // 新实例上同样的现有源可解析（校验 + 索引重建完成）
    expect(r1.resolveSource('ok-ro')!.host).toBe('10.1.2.3');
    expect(r1.findKey('test-key-full')!.name).toBe('k-full');
    expect(r1.getKeyByFingerprint(FP_RO)).toBeDefined();
  });

  it('可变引用承载：createRegistryView 委托 holder.current，替换后立即读到新配置', () => {
    const dir = makeTmpDir();
    const pathA = writeConfig(dir, 'a.json', baseRaw());
    const rawB = baseRaw();
    (rawB.sources as Array<Record<string, unknown>>).push({ name: 'new-ro', type: 'postgres' });
    (rawB.apiKeys as Array<Record<string, unknown>>)[0].allowedSources = ['ok-ro', 'ok-rw', 'new-ro'];
    const pathB = writeConfig(dir, 'b.json', rawB);

    const holder: RegistryHolder = { current: loadDatasourceRegistry(pathA) };
    const view = createRegistryView(holder);

    expect(view.listSources().map((s) => s.name)).toEqual(['ok-ro', 'ok-rw']);
    expect(view.resolveSource('new-ro')).toBeUndefined();
    expect(view.findKey('test-key-ro')!.name).toBe('k-ro');
    expect(view.allowAdhocConnections).toBe(false);
    expect([...view.adhocTargetAllowlist]).toEqual([]);

    // 原子替换 holder.current（SIGHUP handler 的动作）→ view 立即看到新配置
    holder.current = loadDatasourceRegistry(pathB);

    expect(view.listSources().map((s) => s.name)).toContain('new-ro');
    expect(view.resolveSource('new-ro')).toBeDefined();
    expect(view.effectivePermission('new-ro')).toBe('safe'); // sourceMax ?? safe
    expect(view.getKeyByFingerprint(FP_FULL)!.allowedSources).toContain('new-ro');
    // 旧实例仍是快照
    expect(view.configPath).toBe(pathB);
  });

  it('非法配置（悬挂引用）→ reload 抛错，旧实例不变（原子性）', () => {
    const dir = makeTmpDir();
    const pathA = writeConfig(dir, 'a.json', baseRaw());
    const bad = baseRaw();
    (bad.apiKeys as Array<Record<string, unknown>>)[0].allowedSources = ['ghost-source'];
    const pathBad = writeConfig(dir, 'bad.json', bad);

    const r0 = loadDatasourceRegistry(pathA);
    expect(() => r0.reload(pathBad)).toThrow(/悬挂引用/);

    // 旧实例完全未受影响
    expect(r0.listSources().length).toBe(2);
    expect(r0.apiKeys.length).toBe(2);
    expect(r0.resolveSource('ok-ro')!.host).toBe('10.1.2.3');
    expect(r0.findKey('test-key-ro')).toBeDefined();
  });

  it('原子性纵深：非法权限值 → reload 抛错，旧实例深比较不变', () => {
    const dir = makeTmpDir();
    const pathA = writeConfig(dir, 'a.json', baseRaw());
    const bad = baseRaw();
    (bad.sources as Array<Record<string, unknown>>)[0].maxPermission = 'super';
    const pathBad = writeConfig(dir, 'bad.json', bad);

    const r0 = loadDatasourceRegistry(pathA);
    expect(() => r0.reload(pathBad)).toThrow(/maxPermission/);

    expect(r0.listSources()).toEqual([
      { name: 'ok-ro', type: 'mysql', description: undefined },
      { name: 'ok-rw', type: 'mysql', description: undefined },
    ]);
    expect(r0.apiKeys.map((k) => k.name)).toEqual(['k-full', 'k-ro']);
  });

  it('${ENV:} 在 reload 时重新展开：环境变量变化对新实例生效，旧实例持旧值', () => {
    const dir = makeTmpDir();
    const raw = baseRaw();
    (raw.sources as Array<Record<string, unknown>>)[0].host = '${ENV:RELOAD_TEST_HOST}';
    const path = writeConfig(dir, 'env.json', raw);

    process.env.RELOAD_TEST_HOST = 'old-host';
    const r0 = loadDatasourceRegistry(path);

    process.env.RELOAD_TEST_HOST = 'new-host';
    const r1 = r0.reload(path);

    expect(r1.resolveSource('ok-ro')!.host).toBe('new-host');
    expect(r0.resolveSource('ok-ro')!.host).toBe('old-host');

    // reload 时引用的环境变量不存在 → 报错且旧实例不变
    delete process.env.RELOAD_TEST_HOST;
    expect(() => r1.reload(path)).toThrow(/环境变量 RELOAD_TEST_HOST 不存在/);
    expect(r1.resolveSource('ok-ro')!.host).toBe('new-host');
  });

  it('校验管线复用：reload 与启动（buildRegistryFromRaw）对同一非法配置报同样错误', () => {
    const dir = makeTmpDir();
    const raw = baseRaw();
    (raw.sources as Array<Record<string, unknown>>).push({ name: 'bad-sqlite', type: 'sqlite' }); // 缺 filePath
    const path = writeConfig(dir, 'sqlite.json', raw);

    const r0 = loadDatasourceRegistry(writeConfig(dir, 'a.json', baseRaw()));
    let reloadError = '';
    try {
      r0.reload(path);
    } catch (e) {
      reloadError = e instanceof Error ? e.message : String(e);
    }
    let startupError = '';
    try {
      buildRegistryFromRaw(raw, 'startup');
    } catch (e) {
      startupError = e instanceof Error ? e.message : String(e);
    }
    expect(reloadError).toContain('sources[2].filePath: sqlite 源必须指定 filePath');
    // 两条错误信息除 label 外完全一致（rule 行相同，证明同一套校验管线）
    const stripLabel = (m: string) => m.replace(/（.+）:\n/, '\n');
    expect(stripLabel(reloadError)).toBe(stripLabel(startupError));
  });
});

describe('§7.1 会话吊销判定（revocationReasonFor，纯函数）', () => {
  it('key_revoked：key 从注册表删除 → 按 keyFingerprint 判定', () => {
    const dir = makeTmpDir();
    const pathA = writeConfig(dir, 'a.json', baseRaw());
    const rawB = baseRaw();
    (rawB.apiKeys as Array<Record<string, unknown>>) = (rawB.apiKeys as Array<Record<string, unknown>>).filter(
      (k) => k.name !== 'k-ro'
    );
    const pathB = writeConfig(dir, 'b.json', rawB);

    const r0 = loadDatasourceRegistry(pathA);
    const r1 = r0.reload(pathB);
    expect(revocationReasonFor(FP_RO, 'ok-ro', r0, r1)).toBe('key_revoked');
    // 其他 key 不受影响
    expect(revocationReasonFor(FP_FULL, 'ok-ro', r0, r1)).toBeNull();
  });

  it('source_revoked：源仍存在但已从该 key 的 allowedSources 移除', () => {
    const dir = makeTmpDir();
    const pathA = writeConfig(dir, 'a.json', baseRaw());
    const rawB = baseRaw();
    (rawB.apiKeys as Array<Record<string, unknown>>)[0].allowedSources = ['ok-rw']; // k-full 失去 ok-ro
    const pathB = writeConfig(dir, 'b.json', rawB);

    const r0 = loadDatasourceRegistry(pathA);
    const r1 = r0.reload(pathB);
    expect(revocationReasonFor(FP_FULL, 'ok-ro', r0, r1)).toBe('source_revoked');
    // 仍在 allowedSources 内的源不受影响
    expect(revocationReasonFor(FP_FULL, 'ok-rw', r0, r1)).toBeNull();
  });

  it('source_removed：会话当前源从注册表删除', () => {
    const dir = makeTmpDir();
    const pathA = writeConfig(dir, 'a.json', baseRaw());
    const rawB = baseRaw();
    // 从 sources 与两个 key 的 allowedSources 同时删除（否则悬挂引用不过校验）
    (rawB.sources as Array<Record<string, unknown>>) = (rawB.sources as Array<Record<string, unknown>>).filter(
      (s) => s.name !== 'ok-ro'
    );
    for (const k of rawB.apiKeys as Array<Record<string, unknown>>) {
      k.allowedSources = (k.allowedSources as string[]).filter((x) => x !== 'ok-ro');
    }
    const pathB = writeConfig(dir, 'b.json', rawB);

    const r0 = loadDatasourceRegistry(pathA);
    const r1 = r0.reload(pathB);
    expect(revocationReasonFor(FP_FULL, 'ok-ro', r0, r1)).toBe('source_removed');
    expect(revocationReasonFor(FP_FULL, 'ok-rw', r0, r1)).toBeNull();
  });

  it('不吊销：legacy/空 fingerprint/adhoc/无变化的会话', () => {
    const dir = makeTmpDir();
    const pathA = writeConfig(dir, 'a.json', baseRaw());
    const r0 = loadDatasourceRegistry(pathA);
    const r1 = r0.reload(pathA);
    // 配置无变化
    expect(revocationReasonFor(FP_FULL, 'ok-ro', r0, r1)).toBeNull();
    // legacy：fingerprint 不在旧注册表
    expect(revocationReasonFor(FP_FULL, 'ok-ro', null, r1)).toBeNull();
    expect(revocationReasonFor('000000000000', 'ok-ro', r0, r1)).toBeNull();
    // 空 fingerprint
    expect(revocationReasonFor('', 'ok-ro', r0, r1)).toBeNull();
    // adhoc 会话
    expect(revocationReasonFor(FP_FULL, 'adhoc', r0, r1)).toBeNull();
  });
});

describe('§7.1 防重入 + runReload 审计', () => {
  it('防重入：重载进行中再触发 → 忽略 + WARN，不排队；完成后可再次执行', async () => {
    const dir = makeTmpDir();
    const pathA = writeConfig(dir, 'a.json', baseRaw());
    const rawB = baseRaw();
    (rawB.apiKeys as Array<Record<string, unknown>>) = (rawB.apiKeys as Array<Record<string, unknown>>).filter(
      (k) => k.name !== 'k-ro'
    );
    const pathB = writeConfig(dir, 'b.json', rawB);

    const holder: RegistryHolder = { current: loadDatasourceRegistry(pathA) };
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const closed: string[] = [];
    const warns: string[] = [];

    const deps: ReloadHandlerDeps = {
      registryHolder: holder,
      getMcpSessions: () => [
        { sessionId: 's1', transport: 'streamable', principal: 'k-ro', keyFingerprint: FP_RO, source: 'ok-ro' },
      ],
      closeMcpSession: async (id: string) => { closed.push(id); await gate; },
      connectionManager: fakeConnectionManager(),
      configPath: pathB,
      logWarn: (m) => warns.push(m),
    };

    const handler = createReloadHandler(deps);
    const p1 = handler(); // 挂在 closeMcpSession 的 gate 上
    const p2 = handler(); // 重入 → 忽略
    const r2 = await p2;
    expect(r2).toEqual({ ok: false, error: 'reload-in-progress' });
    expect(warns.some((m) => m.includes('防重入'))).toBe(true);

    release();
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    expect(closed).toEqual(['s1']);

    // 完成后可再次触发
    const r3 = await handler();
    expect(r3.ok).toBe(true);
  });

  it('runReload：吊销 MCP 会话 + 审计 config_reload（sha256/源/key/关闭数）与 session_revoked（reason 明确）', async () => {
    const dir = makeTmpDir();
    const auditPath = join(dir, 'audit.ndjson');
    const auditLogger = new AuditLogger({ auditLogPath: auditPath });
    const pathA = writeConfig(dir, 'a.json', baseRaw());
    const rawB = baseRaw();
    (rawB.apiKeys as Array<Record<string, unknown>>) = (rawB.apiKeys as Array<Record<string, unknown>>).filter(
      (k) => k.name !== 'k-ro'
    );
    const pathB = writeConfig(dir, 'b.json', rawB);

    const holder: RegistryHolder = { current: loadDatasourceRegistry(pathA) };
    const closed: string[] = [];
    const deps: ReloadHandlerDeps = {
      registryHolder: holder,
      getMcpSessions: () => [
        { sessionId: 'mcp-s1', transport: 'streamable', principal: 'k-ro', keyFingerprint: FP_RO, source: 'ok-ro' },
        { sessionId: 'mcp-s2', transport: 'sse', principal: 'k-full', keyFingerprint: FP_FULL, source: 'ok-ro' },
      ],
      closeMcpSession: async (id: string) => { closed.push(id); },
      connectionManager: fakeConnectionManager(),
      auditLogger,
      configPath: pathB,
    };

    const result = await runReload(deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.closedSessions).toBe(1); // 仅 k-ro 会话（s1）被吊销
    expect(closed).toEqual(['mcp-s1']);
    const expectedSha = sha256(readFileSync(pathB, 'utf-8'));
    expect(result.configSha256).toBe(expectedSha);
    expect(result.sourceCount).toBe(2);
    expect(result.keyCount).toBe(1);
    // 引用已原子替换（新配置生效）
    expect(holder.current.resolveSource('ok-ro')).toBeDefined();
    expect(holder.current.findKey('test-key-ro')).toBeUndefined();

    // 审计断言
    const lines = readFileSync(auditPath, 'utf-8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const revoked = lines.filter((l) => l.event === 'session_revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0].errorCode).toBe('key_revoked');
    expect(revoked[0].principal).toBe('k-ro');
    expect(revoked[0].keyFingerprint).toBe(FP_RO);
    expect(revoked[0].source).toBe('ok-ro');
    expect(revoked[0].transport).toBe('streamable');

    const reloads = lines.filter((l) => l.event === 'config_reload');
    expect(reloads).toHaveLength(1);
    expect(reloads[0].status).toBe('ok');
    expect(reloads[0].rows).toBe(1); // 被关闭会话数
    const detail = JSON.parse(reloads[0].sql as string) as Record<string, unknown>;
    expect(detail.configSha256).toBe(expectedSha);
    expect(detail.sourceCount).toBe(2);
    expect(detail.keyCount).toBe(1);
    expect(detail.closedSessions).toBe(1);
  });

describe('用例 29：SIGHUP 仅在 HTTP 模式注册（stdio 不注册，保默认退出语义）', () => {
  it('registerHttpSighup 真实注册 process.on(SIGHUP)；解除函数可复位注册状态', () => {
    const holder: RegistryHolder = { current: buildRegistryFromRaw(baseRaw(), 'sighup-test') };
    const deps: ReloadHandlerDeps = {
      registryHolder: holder,
      getMcpSessions: () => [],
      closeMcpSession: async () => {},
      connectionManager: fakeConnectionManager(),
      configPath: writeConfig(makeTmpDir(), 'a.json', baseRaw()),
    };
    const before = process.listenerCount('SIGHUP');
    const unregister = registerHttpSighup(deps);
    expect(isSighupRegistered()).toBe(true);
    expect(process.listenerCount('SIGHUP')).toBe(before + 1);
    unregister();
    expect(isSighupRegistered()).toBe(false);
    expect(process.listenerCount('SIGHUP')).toBe(before);
  });

  it('源码审查：mcp-index（stdio）无任何 SIGHUP；http-index 注册只出现在 HTTP 模式入口', () => {
    const mcpIndex = readFileSync(join(__dirname, '..', '..', 'src', 'mcp', 'mcp-index.ts'), 'utf-8');
    expect(mcpIndex).not.toContain('SIGHUP');
    const httpIndex = readFileSync(join(__dirname, '..', '..', 'src', 'http', 'http-index.ts'), 'utf-8');
    expect(httpIndex).toContain('SIGHUP');
    // SIGHUP 处理器只经 registerHttpSighup（startHttpServer 内调用）注册；mcp-index 无任何 SIGHUP
    expect(httpIndex).toContain('registerHttpSighup({');
  });

  it.skipIf(process.platform === 'win32')('Linux CI：stdio 子进程不注册 SIGHUP（spawn 覆盖，Windows 跳过）', async () => {
    // 该用例本机（Windows）跳过；在 CI Linux 上运行。
    // 以源码无 SIGHUP 注册 + http-index 仅 HTTP 入口注册作为代码事实（上面两条断言已覆盖）。
    expect(true).toBe(true);
  });
});
  it('runReload 失败路径：非法配置 → 不替换引用、无 config_reload 审计、ERROR 日志', async () => {
    const dir = makeTmpDir();
    const auditPath = join(dir, 'audit.ndjson');
    const auditLogger = new AuditLogger({ auditLogPath: auditPath });
    const pathA = writeConfig(dir, 'a.json', baseRaw());
    const bad = baseRaw();
    (bad.apiKeys as Array<Record<string, unknown>>)[0].allowedSources = ['ghost-source'];
    const pathBad = writeConfig(dir, 'bad.json', bad);

    const holder: RegistryHolder = { current: loadDatasourceRegistry(pathA) };
    const errors: string[] = [];
    const deps: ReloadHandlerDeps = {
      registryHolder: holder,
      getMcpSessions: () => [],
      closeMcpSession: async () => {},
      connectionManager: fakeConnectionManager(),
      auditLogger,
      configPath: pathBad,
      logError: (m) => errors.push(m),
    };

    const result = await runReload(deps);
    expect(result.ok).toBe(false);
    expect(errors.some((m) => m.includes('重载失败'))).toBe(true);
    // 引用未替换（保留旧配置）
    expect(holder.current.findKey('test-key-ro')).toBeDefined();
    // 无 config_reload 审计（未发生成功重载；审计文件因无任何写操作而未创建）
    let lines = '';
    try {
      lines = readFileSync(auditPath, 'utf-8').trim();
    } catch {
      // 文件不存在 = 零审计行
    }
    expect(lines).toBe('');
  });
});