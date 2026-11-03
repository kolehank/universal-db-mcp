/**
 * 规格 §11 用例 25-28（P5 验收：SIGHUP 热加载 + 会话快照/吊销）
 *
 * Windows 无 SIGHUP 信号（G14），按评审意见：reload handler 直调覆盖。
 * - 真实 createHttpServer + mock 适配器 + server.inject；注册表从临时文件加载，
 *   runReload / createReloadHandler 直调（等价于收到 SIGHUP 后 handler 执行体）。
 * - 审计：AUDIT_LOG_PATH 指向临时文件，每次 reload 后读 NDJSON 行断言 config_reload / session_revoked。
 * - 用例 29（stdio 不注册 SIGHUP）在 tests/unit/registry-reload.test.ts 用源码审查 + 注册状态断言覆盖。
 *
 * 已建会话快照语义：REST Session / MCP sessionMeta 在连接时写入连接解析结果，
 * reload 只替换 registryHolder.current（新会话经 createRegistryView 用新配置），旧会话持旧快照。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createHttpServer } from '../../src/http/server';
import { loadDatasourceRegistry } from '../../src/security/datasource-registry';
import type { RegistryHolder } from '../../src/security/datasource-registry';
import { AuditLogger } from '../../src/security/audit-logger';
import {
  getMcpSessionSnapshot,
  cleanupSession,
} from '../../src/http/routes/mcp-sse';
import {
  createReloadHandler,
} from '../../src/http/http-index';
import type { ReloadHandlerDeps, ReloadResult } from '../../src/http/http-index';
import type { DbAdapter, DbConfig, QueryResult, SchemaInfo } from '../../src/types/adapter';
import type { AppConfig } from '../../src/types/http';

function baseConfig(): AppConfig {
  return {
    mode: 'http',
    http: {
      port: 0,
      host: '127.0.0.1',
      apiKeys: [],
      cors: { origins: '*', credentials: false },
      rateLimit: { max: 1000, window: '1m' },
      logging: { level: 'error', pretty: false },
      session: { timeout: 3600000, cleanupInterval: 300000 },
    },
  };
}

class MockAdapter implements DbAdapter {
  private opts: { failConnect?: boolean };

  constructor(opts: { failConnect?: boolean } = {}) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.opts.failConnect) {
      throw new Error('mock connection refused');
    }
  }

  async disconnect(): Promise<void> {
    /* no-op */
  }

  async executeQuery(query: string, params?: unknown[]): Promise<QueryResult> {
    return { rows: [], affectedRows: 0, executionTime: 1, metadata: { query } };
  }

  async getSchema(): Promise<SchemaInfo> {
    return { databaseType: 'mysql', databaseName: 'mock', tables: [] };
  }

  isWriteOperation(query: string): boolean {
    return /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|RENAME)\b/i.test(query);
  }
}

function okAdapterFactory(): (config: DbConfig) => DbAdapter {
  return () => new MockAdapter();
}

/** 与 fixtures/registry.json 一致（ok-ro/ok-rw，k-full/k-ro） */
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

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acl-reload-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  // MCP 会话注册表（mcp-sse 模块级三 map）跨 server 共享：清空残留，保证用例间隔离
  // （用例 26/28 的 snapshot/吊销计数均为模块级，不清理会收到前序用例的残留会话）
  for (const meta of getMcpSessionSnapshot()) {
    try {
      await cleanupSession(meta.sessionId);
    } catch {
      /* best-effort */
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface ReloadHarness {
  server: any;
  auditPath: string;
  cfgPath: string;
  /** 覆写配置文件后直调 reload handler（等价于收到 SIGHUP） */
  reload: (raw: Record<string, unknown>) => Promise<ReloadResult>;
  /** ERROR 出口捕获（用例 27 断言） */
  errors: string[];
  holder: RegistryHolder;
}

async function makeReloadServer(originalRaw: Record<string, unknown>): Promise<ReloadHarness> {
  const dir = makeTmpDir();
  const cfgPath = join(dir, 'registry.json');
  writeFileSync(cfgPath, JSON.stringify(originalRaw, null, 2), 'utf-8');
  const auditPath = join(dir, 'audit.ndjson');
  const registry = loadDatasourceRegistry(cfgPath);
  const auditLogger = new AuditLogger({ auditLogPath: auditPath });
  const server = await createHttpServer(baseConfig(), {
    registry,
    adapterFactory: okAdapterFactory(),
    auditLogger,
    securityEnv: {},
  });
  const holder = (server as any).registryHolder as RegistryHolder;
  const errors: string[] = [];
  const deps: ReloadHandlerDeps = {
    registryHolder: holder,
    getMcpSessions: getMcpSessionSnapshot,
    closeMcpSession: cleanupSession,
    connectionManager: (server as any).connectionManager,
    auditLogger,
    configPath: cfgPath,
    logError: (m) => errors.push(m),
  };
  const handler = createReloadHandler(deps);
  return {
    server,
    auditPath,
    cfgPath,
    holder,
    errors,
    reload: async (raw: Record<string, unknown>) => {
      writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf-8');
      return handler();
    },
  };
}

interface AuditLine {
  event: string;
  errorCode?: string | null;
  principal?: string;
  source?: string;
  transport?: string;
  rows?: number;
  sql?: string;
  status?: string;
  [key: string]: unknown;
}

function readAudit(auditPath: string): AuditLine[] {
  try {
    const content = readFileSync(auditPath, 'utf-8');
    return content
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as AuditLine);
  } catch {
    return [];
  }
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

// ---------------------------------------------------------------------------
// REST 辅助
// ---------------------------------------------------------------------------

function restConnect(key: string, body: Record<string, unknown>): Record<string, unknown> {
  return { method: 'POST', url: '/api/connect', headers: { 'X-API-Key': key }, payload: body };
}

async function establishRestSession(
  server: any,
  key: string,
  source: string
): Promise<string> {
  const res = await server.inject(restConnect(key, { source }));
  expect(res.statusCode).toBe(200);
  return (JSON.parse(res.body) as any).data.sessionId as string;
}

async function restQuery(server: any, key: string, sessionId: string, query = 'SELECT 1'): Promise<any> {
  return server.inject({
    method: 'POST',
    url: '/api/query',
    headers: { 'X-API-Key': key },
    payload: { sessionId, query },
  });
}

// ---------------------------------------------------------------------------
// MCP（Streamable HTTP）辅助（与 acl-mcp.test.ts 相同协议的握手）
// ---------------------------------------------------------------------------

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'acl-reload-test', version: '1.0.0' },
  },
};

const MCP_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

type JsonRpcMessage = { id?: number; result?: any; error?: any; [key: string]: unknown };

function parseSseJson(body: string): JsonRpcMessage[] {
  const out: JsonRpcMessage[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload.length > 0) {
        out.push(JSON.parse(payload) as JsonRpcMessage);
      }
    }
  }
  return out;
}

async function initializeRemote(
  server: any,
  key: string,
  extraHeaders: Record<string, string> = {}
): Promise<{ res: any; messages: JsonRpcMessage[] }> {
  const res = await server.inject({
    method: 'POST',
    url: '/mcp',
    headers: { ...MCP_HEADERS, 'X-API-Key': key, ...extraHeaders },
    payload: INITIALIZE,
  });
  return { res, messages: parseSseJson(res.body) };
}

async function establishMcpSession(
  server: any,
  key: string,
  sourceHeader: string
): Promise<string> {
  const { res } = await initializeRemote(server, key, { 'X-DB-Source': sourceHeader });
  expect(res.statusCode).toBe(200);
  const sessionId = res.headers['mcp-session-id'] as string;
  expect(typeof sessionId).toBe('string');
  return sessionId;
}

async function mcpRequest(
  server: any,
  sessionId: string,
  key: string,
  message: JsonRpcMessage
): Promise<{ res: any; messages: JsonRpcMessage[] }> {
  const res = await server.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      ...MCP_HEADERS,
      'X-API-Key': key,
      'mcp-session-id': sessionId,
      'mcp-protocol-version': '2024-11-05',
    },
    payload: message,
  });
  return { res, messages: parseSseJson(res.body) };
}

// ---------------------------------------------------------------------------
// 用例 25-28
// ---------------------------------------------------------------------------

describe('P5 SIGHUP 热加载（用例 25-28，reload handler 直调）', () => {
  it('用例 25：配置新增源 new-ro → 新会话 connect 成功；重载前已建会话不受影响（凭据轮换快照）', async () => {
    const { server, auditPath, cfgPath, reload } = await makeReloadServer(baseRaw());
    try {
      // 重载前：new-ro 不存在 → 404（预检）
      const before = await server.inject(restConnect('test-key-full', { source: 'new-ro' }));
      expect(before.statusCode).toBe(404);

      // 重载前已建会话（快照：连接参数 + 权限固化）
      const oldSession = await establishRestSession(server, 'test-key-full', 'ok-ro');

      // 重载：新增 new-ro
      const rawB = baseRaw();
      (rawB.sources as Array<Record<string, unknown>>).push({ name: 'new-ro', type: 'postgres', host: '10.9.9.9', port: 5432, database: 'ndb' });
      (rawB.apiKeys as Array<Record<string, unknown>>)[0].allowedSources = ['ok-ro', 'ok-rw', 'new-ro'];
      const result = await reload(rawB);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.closedSessions).toBe(0); // 无吊销

      // 新 REST 会话可用 new-ro（auth/routes 经 view 已读到新配置）
      const newSession = await establishRestSession(server, 'test-key-full', 'new-ro');
      const q = await restQuery(server, 'test-key-full', newSession);
      expect(q.statusCode).toBe(200);

      // 新 MCP 会话也可用 new-ro（mcp-sse 经 view 实时读注册表）
      const newMcpSession = await establishMcpSession(server, 'test-key-full', 'new-ro');
      const list = await mcpRequest(server, newMcpSession, 'test-key-full', {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
      });
      expect(list.res.statusCode).toBe(200);

      // 重载前已建会话不受影响（凭据轮换语义：旧会话持旧配置快照仍可查询）
      const oldQ = await restQuery(server, 'test-key-full', oldSession);
      expect(oldQ.statusCode).toBe(200);

      // config_reload 审计：sha256 + 源/key 数量 + 被关闭会话数 0
      const cfgContent = readFileSync(cfgPath, 'utf-8');
      const reloads = readAudit(auditPath).filter((l) => l.event === 'config_reload');
      expect(reloads).toHaveLength(1);
      expect(reloads[0].status).toBe('ok');
      expect(reloads[0].rows).toBe(0);
      const detail = JSON.parse(reloads[0].sql as string) as Record<string, unknown>;
      expect(detail.configSha256).toBe(sha256Of(cfgContent));
      expect(detail.sourceCount).toBe(3);
      expect(detail.keyCount).toBe(2);
      expect(detail.closedSessions).toBe(0);
      // 无任何 session_revoked（用例 26 反向）
      expect(readAudit(auditPath).filter((l) => l.event === 'session_revoked')).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('用例 26：删 key k-ro → 仅 k-ro MCP 会话被关闭 + session_revoked(key_revoked)；k-full 会话存活', async () => {
    const { server, auditPath, reload } = await makeReloadServer(baseRaw());
    try {
      const sessionA = await establishMcpSession(server, 'test-key-ro', 'ok-ro');   // k-ro
      const sessionB = await establishMcpSession(server, 'test-key-full', 'ok-ro'); // k-full
      expect(getMcpSessionSnapshot().map((s) => s.sessionId).sort()).toEqual([sessionA, sessionB].sort());

      // 重载：删除 k-ro
      const rawB = baseRaw();
      (rawB.apiKeys as Array<Record<string, unknown>>) = (rawB.apiKeys as Array<Record<string, unknown>>).filter(
        (k) => k.name !== 'k-ro'
      );
      const result = await reload(rawB);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.closedSessions).toBe(1);

      // 仅 k-ro 会话被关闭（快照移除 + 传输层失效）
      const remaining = getMcpSessionSnapshot();
      expect(remaining.map((s) => s.sessionId)).not.toContain(sessionA);
      expect(remaining.map((s) => s.sessionId)).toContain(sessionB);
      const deadRes = await mcpRequest(server, sessionA, 'test-key-full', {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
      });
      expect(deadRes.res.statusCode).toBe(400); // 会话已关闭（传输层已移除；用仍有效的 k-full 证明是会话级关闭）
      // k-full 会话仍可用
      const alive = await mcpRequest(server, sessionB, 'test-key-full', {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
      });
      expect(alive.res.statusCode).toBe(200);

      // 审计：session_revoked key_revoked（principal=k-ro）；config_reload 一次
      const lines = readAudit(auditPath);
      const revoked = lines.filter((l) => l.event === 'session_revoked');
      expect(revoked).toHaveLength(1);
      expect(revoked[0].errorCode).toBe('key_revoked');
      expect(revoked[0].principal).toBe('k-ro');
      expect(revoked[0].source).toBe('ok-ro');
      expect(lines.filter((l) => l.event === 'config_reload')).toHaveLength(1);

      // 已删 key 立即失效：REST connect → 403（注册表查不到该 key）
      const forbidden = await server.inject(restConnect('test-key-ro', { source: 'ok-ro' }));
      expect(forbidden.statusCode).toBe(403);
      expect(JSON.parse(forbidden.body).error.code).toBe('FORBIDDEN');
      // 其他 key 正常
      const ok = await server.inject(restConnect('test-key-full', { source: 'ok-ro' }));
      expect(ok.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('用例 27：非法配置（悬挂引用）reload → 进程继续、旧配置生效、ERROR 日志、旧会话可用', async () => {
    const { server, auditPath, reload, errors } = await makeReloadServer(baseRaw());
    try {
      const oldSession = await establishRestSession(server, 'test-key-full', 'ok-ro');
      const oldMcpSession = await establishMcpSession(server, 'test-key-full', 'ok-ro');

      // 非法配置：allowedSources 悬挂引用（§3.3 规则 6）
      const bad = baseRaw();
      (bad.apiKeys as Array<Record<string, unknown>>)[0].allowedSources = ['ghost-source'];
      const result = await reload(bad);
      expect(result.ok).toBe(false);
      expect(errors.some((m) => m.includes('重载失败') && m.includes('悬挂引用'))).toBe(true);

      // 进程不退出、旧配置生效：旧源仍可连接
      const still = await server.inject(restConnect('test-key-full', { source: 'ok-ro' }));
      expect(still.statusCode).toBe(200);
      // 旧会话仍可用
      const oldQ = await restQuery(server, 'test-key-full', oldSession);
      expect(oldQ.statusCode).toBe(200);
      const alive = await mcpRequest(server, oldMcpSession, 'test-key-full', {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
      });
      expect(alive.res.statusCode).toBe(200);

      // 未发生成功重载：无 config_reload / session_revoked 审计
      const lines = readAudit(auditPath);
      expect(lines.filter((l) => l.event === 'config_reload')).toHaveLength(0);
      expect(lines.filter((l) => l.event === 'session_revoked')).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('用例 28：删源 ok-ro → 使用该源的 MCP 会话关闭（source_removed）；新 connect 404；其他源会话不受影响', async () => {
    const { server, auditPath, reload } = await makeReloadServer(baseRaw());
    try {
      const sessionA = await establishMcpSession(server, 'test-key-full', 'ok-ro');
      const sessionB = await establishMcpSession(server, 'test-key-full', 'ok-rw');

      // 重载：从 sources 及两个 key 的 allowedSources 删除 ok-ro（否则悬挂引用不过校验）
      const rawB = baseRaw();
      (rawB.sources as Array<Record<string, unknown>>) = (rawB.sources as Array<Record<string, unknown>>).filter(
        (s) => s.name !== 'ok-ro'
      );
      for (const k of rawB.apiKeys as Array<Record<string, unknown>>) {
        k.allowedSources = (k.allowedSources as string[]).filter((x) => x !== 'ok-ro');
      }
      const result = await reload(rawB);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.closedSessions).toBe(1);

      // 使用 ok-ro 的会话被关闭；ok-rw 会话存活
      const remaining = getMcpSessionSnapshot();
      expect(remaining.map((s) => s.sessionId)).not.toContain(sessionA);
      expect(remaining.map((s) => s.sessionId)).toContain(sessionB);
      const deadRes = await mcpRequest(server, sessionA, 'test-key-full', {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
      });
      expect(deadRes.res.statusCode).toBe(400);
      const aliveRes = await mcpRequest(server, sessionB, 'test-key-full', {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
      });
      expect(aliveRes.res.statusCode).toBe(200);

      // 审计：session_revoked source_removed（source=ok-ro）
      const revoked = readAudit(auditPath).filter((l) => l.event === 'session_revoked');
      expect(revoked).toHaveLength(1);
      expect(revoked[0].errorCode).toBe('source_removed');
      expect(revoked[0].source).toBe('ok-ro');
      expect(revoked[0].principal).toBe('k-full');

      // 新 connect ok-ro → 404；ok-rw → 200（吊销不影响其他源）
      const gone = await server.inject(restConnect('test-key-full', { source: 'ok-ro' }));
      expect(gone.statusCode).toBe(404);
      expect(JSON.parse(gone.body).error.code).toBe('SOURCE_NOT_FOUND');
      const ok = await server.inject(restConnect('test-key-full', { source: 'ok-rw' }));
      expect(ok.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('用例 28 补充：吊销不误伤——会话当前源未被删（ok-rw 会话接收不到 source_revoked）', async () => {
    const { server, reload } = await makeReloadServer(baseRaw());
    try {
      const session = await establishMcpSession(server, 'test-key-ro', 'ok-ro');
      // 仅缩小 k-full 的 allowedSources（k-ro 不受影响）
      const rawB = baseRaw();
      (rawB.apiKeys as Array<Record<string, unknown>>) = (rawB.apiKeys as Array<Record<string, unknown>>).map((k) =>
        k.name === 'k-full' ? { ...k, allowedSources: ['ok-ro'] } : k
      );
      const result = await reload(rawB);
      expect(result.ok).toBe(true);
      expect(getMcpSessionSnapshot().map((s) => s.sessionId)).toContain(session); // 未被吊销
      expect(result).toMatchObject({ ok: true, closedSessions: 0 });
    } finally {
      await server.close();
    }
  });
});