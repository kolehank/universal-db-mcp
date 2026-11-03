/**
 * 规格 §11 用例表的 MCP 会话语义子集（P2 验收：用例 8、10-15、23）
 *
 * 覆盖通道：
 * - Streamable HTTP（POST /mcp，registry 模式 / legacy-remote 模式）——用例 10、11、14、14a、14b、14c、14d、14e、15
 * - SSE（GET /sse）——用例 12、13
 * - 用例 23（/api/info 不暴露源名）
 *
 * 离线可跑：createHttpServer + server.inject + mock 适配器，不起真实数据库。
 * 审计断言：AUDIT_LOG_PATH 指向 os.tmpdir() 临时文件（同步写，inject 返回后即可读）。
 *
 * 前置（fixtures/registry.json）：
 *   源 ok-ro（maxPermission=safe）、ok-rw（maxPermission=readwrite）；
 *   key k-full（key=test-key-full，允许 ok-ro/ok-rw，maxPermission=full）、
 *   key k-ro（key=test-key-ro，仅允许 ok-ro，无 maxPermission → full）。
 *
 * 注意事项（实测于 SDK @modelcontextprotocol/sdk@1.0.4）：
 * - POST /mcp 的响应默认是 SSE 流（enableJsonResponse=false）：正文为
 *   `event: message\ndata: <jsonrpc>\n\n`，会话 id 在响应头 mcp-session-id。
 * - 后续 tools/list、tools/call 必须带 mcp-session-id 头（+ mcp-protocol-version 头）。
 * - initialize 需 Accept 同时含 application/json 与 text/event-stream，Content-Type: application/json。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import { createHttpServer } from '../../src/http/server';
import { buildRegistryFromRaw } from '../../src/security/datasource-registry';
import { AuditLogger } from '../../src/security/audit-logger';
import { getMcpSessionSnapshot } from '../../src/http/routes/mcp-sse';
import type { DbAdapter, DbConfig, QueryResult, SchemaInfo } from '../../src/types/adapter';
import type { AppConfig } from '../../src/types/http';

const FIXTURES = join(__dirname, '..', 'fixtures');

/** 认证失败会走到 stderr 的 logger 级别压到 error，避免测试输出噪音 */
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

/** 可配置失败行为的 mock 适配器（DbAdapter 接口） */
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

/** 默认成功工厂：注入 MockAdapter（connect 成功） */
function okAdapterFactory(): (config: DbConfig) => DbAdapter {
  return () => new MockAdapter();
}

function defaultRegistryRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, 'registry.json'), 'utf-8')) as Record<string, unknown>;
}

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acl-mcp-'));
  tmpDirs.push(dir);
  return dir;
}

interface Harness {
  server: any;
  auditPath: string;
}

/** registry 模式 server（AUDIT_LOG_PATH 临时文件 + mock adapter） */
async function makeServer(
  registryRaw: unknown,
  adapterFactory: (config: DbConfig) => DbAdapter
): Promise<Harness> {
  const dir = makeTmpDir();
  const auditPath = join(dir, 'audit.ndjson');
  const registry = buildRegistryFromRaw(registryRaw, 'acl-mcp-test');
  const auditLogger = new AuditLogger({ auditLogPath: auditPath });
  const server = await createHttpServer(baseConfig(), {
    registry,
    adapterFactory,
    auditLogger,
    securityEnv: {},
  });
  return { server, auditPath };
}

/** legacy-remote（无 registry）模式 server：adhoc 开关 + 出站目标白名单 */
async function makeLegacyServer(
  adapterFactory: (config: DbConfig) => DbAdapter,
  securityEnv: Record<string, unknown>
): Promise<Harness> {
  const dir = makeTmpDir();
  const auditPath = join(dir, 'audit.ndjson');
  const auditLogger = new AuditLogger({ auditLogPath: auditPath });
  const server = await createHttpServer(baseConfig(), {
    adapterFactory,
    auditLogger,
    securityEnv,
  });
  return { server, auditPath };
}

interface AuditLine {
  event: string;
  errorCode?: string | null;
  principal?: string;
  source?: string;
  transport?: string;
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

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MCP 握手辅助（协议版本 2024-11-05；POST /mcp 响应为 SSE 流，解析 data: 行）
// ---------------------------------------------------------------------------

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'acl-mcp-test', version: '1.0.0' },
  },
};

const MCP_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

type JsonRpcMessage = { id?: number; result?: any; error?: any; [key: string]: unknown };

/** 解析 POST /mcp 的 SSE 响应正文，返回所有 data: 负载 */
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

/** initialize：POST /mcp（无 mcp-session-id），返回响应与解析后的初始化消息 */
async function initializeRemote(server: any, key: string, extraHeaders: Record<string, string> = {}) {
  const res = await server.inject({
    method: 'POST',
    url: '/mcp',
    headers: { ...MCP_HEADERS, 'X-API-Key': key, ...extraHeaders },
    payload: INITIALIZE,
  });
  const messages = parseSseJson(res.body);
  return { res, messages };
}

/** 会话后续请求：tools/list / tools/call（带 mcp-session-id） */
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

/** 建立会话并返回 sessionId（失败则抛出含响应细节的断言） */
async function establishSession(server: any, key: string, extraHeaders: Record<string, string> = {}): Promise<string> {
  const { res, messages } = await initializeRemote(server, key, extraHeaders);
  expect(res.statusCode).toBe(200);
  const sessionId = res.headers['mcp-session-id'] as string;
  expect(typeof sessionId).toBe('string');
  expect(sessionId.length).toBeGreaterThan(0);
  const initMsg = messages.find((m) => m.id === 1);
  expect(initMsg?.result?.protocolVersion).toBe('2024-11-05');
  return sessionId;
}

/** 单条工具调用的响应消息 */
async function callTool(
  server: any,
  sessionId: string,
  key: string,
  id: number,
  name: string,
  args: Record<string, unknown>
): Promise<{ res: any; msg: JsonRpcMessage | undefined }> {
  const { res, messages } = await mcpRequest(server, sessionId, key, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  expect(res.statusCode).toBe(200);
  return { res, msg: messages.find((m) => m.id === id) };
}

/** 工具响应的文本内容（content[0].text） */
function toolText(msg: JsonRpcMessage | undefined): string {
  const content = (msg?.result?.content ?? []) as Array<{ type?: string; text?: string }>;
  return (content[0]?.text ?? '') as string;
}

// ---------------------------------------------------------------------------
// A. Streamable HTTP（registry 模式）
// ---------------------------------------------------------------------------

describe('P2 MCP Streamable HTTP（用例 8、10、11、14、14a、14b、14c、14e、15）', () => {
  it('用例 11：initialize 带 X-DB-Type/Host/Port 无 X-DB-Source → 403 + JSON-RPC -32001 + data.code=ADHOC_DISABLED + 审计 denied', async () => {
    const { server, auditPath } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const { res } = await initializeRemote(server, 'test-key-full', {
        'X-DB-Type': 'mysql',
        'X-DB-Host': '10.1.2.3',
        'X-DB-Port': '3306',
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.error.code).toBe(-32001);
      expect(body.error.data.code).toBe('ADHOC_DISABLED');
      expect(res.headers['mcp-session-id']).toBeUndefined();

      const lines = readAudit(auditPath);
      expect(lines).toHaveLength(1);
      expect(lines[0].event).toBe('denied');
      expect(lines[0].errorCode).toBe('ADHOC_DISABLED');
      expect(lines[0].principal).toBe('k-full');
    } finally {
      await server.close();
    }
  });

  it('用例 10：X-DB-Permission-Mode: full 提权无效 → 审计 permission_ignored；INSERT 被拒 [PERMISSION_DENIED]', async () => {
    const { server, auditPath } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const sessionId = await establishSession(server, 'test-key-full', {
        'X-DB-Source': 'ok-ro',
        'X-DB-Permission-Mode': 'full',
      });

      const { msg } = await callTool(server, sessionId, 'test-key-full', 2, 'execute_query', {
        query: 'INSERT INTO t VALUES (1)',
      });
      expect(msg?.result?.isError).toBe(true);
      const text = toolText(msg);
      expect(text).toContain('[PERMISSION_DENIED]');

      const lines = readAudit(auditPath);
      const ignored = lines.filter((l) => l.event === 'permission_ignored');
      expect(ignored).toHaveLength(1);
      expect(ignored[0].source).toBe('ok-ro');
      expect(ignored[0].principal).toBe('k-full');
      expect(ignored[0].transport).toBe('streamable');
      // 会话建立 + 客户端提权未生效：effective=safe（ok-ro 源上限），INSERT 被拒
      expect(msg?.result?.content?.[0]?.text as string).toContain('当前权限');
    } finally {
      await server.close();
    }
  });

  it('用例 14：tools/list 含 connect_datasource / list_datasources，不含 connect_database', async () => {
    const { server } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const sessionId = await establishSession(server, 'test-key-full', { 'X-DB-Source': 'ok-ro' });
      const { messages } = await mcpRequest(server, sessionId, 'test-key-full', {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });
      const listMsg = messages.find((m) => m.id === 2);
      const tools = (listMsg?.result?.tools ?? []) as Array<{ name: string }>;
      const names = tools.map((t) => t.name);
      expect(names).toContain('connect_datasource');
      expect(names).toContain('list_datasources');
      expect(names).not.toContain('connect_database');
      expect(names).toContain('execute_query');
      expect(names).toContain('disconnect_database');
    } finally {
      await server.close();
    }
  });

  it('用例 14c：registry 模式调用 connect_database → unknown tool（SDK 层 -32603 错误；tools/list 中不存在）', async () => {
    const { server } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const sessionId = await establishSession(server, 'test-key-full', { 'X-DB-Source': 'ok-ro' });

      // 先确证 tools/list 中没有 connect_database（列表短，不依赖顺序）
      const { messages: listMessages } = await mcpRequest(server, sessionId, 'test-key-full', {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });
      const names = ((listMessages.find((m) => m.id === 2)?.result?.tools ?? []) as Array<{ name: string }>).map(
        (t) => t.name
      );
      expect(names).not.toContain('connect_database');

      const { messages } = await mcpRequest(server, sessionId, 'test-key-full', {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'connect_database', arguments: { type: 'mysql', host: '10.1.2.3', port: 3306 } },
      });
      const msg = messages.find((m) => m.id === 3);
      // §9：unknown tool 语义（isError + 文本标记），而不是「再试一次」的错误提示
      expect(msg?.result?.isError).toBe(true);
      const errorText = toolText(msg);
      expect(errorText).toContain('未知工具');
      expect(errorText).toContain('connect_database');
      // 且绝不产生真实数据库连接/切源（会话元数据源不变，仍为 ok-ro）
      const meta = getMcpSessionSnapshot().find((s) => s.sessionId === sessionId);
      expect(meta?.source).toBe('ok-ro');
    } finally {
      await server.close();
    }
  });

  it('用例 14a：k-full 由 ok-ro 切到 ok-rw → 成功；会话元数据 source=ok-rw；审计 connect source=ok-rw', async () => {
    const { server, auditPath } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const sessionId = await establishSession(server, 'test-key-full', { 'X-DB-Source': 'ok-ro' });

      const { msg: switchMsg } = await callTool(server, sessionId, 'test-key-full', 2, 'connect_datasource', {
        source: 'ok-rw',
      });
      expect(switchMsg?.result?.isError ?? false).toBe(false);
      expect(toolText(switchMsg)).toContain('ok-rw');
      expect(toolText(switchMsg)).toContain('readwrite'); // §4.1 effective=min(readwrite, full)

      // 会话元数据已同步为 ok-rw（P4b 写 query 审计时 source 从该值重绑）
      const snapshots = getMcpSessionSnapshot();
      const meta = snapshots.find((s) => s.sessionId === sessionId);
      expect(meta?.source).toBe('ok-rw');
      expect(meta?.effectivePermission).toBe('readwrite');

      // 切源后查询正常（原 ok-ro 连接被替换为 ok-rw）
      const { msg: q } = await callTool(server, sessionId, 'test-key-full', 3, 'execute_query', {
        query: 'SELECT * FROM t',
      });
      expect(q?.result?.isError ?? false).toBe(false);
      expect(toolText(q)).toContain('"rows"');

      const lines = readAudit(auditPath);
      const connects = lines.filter((l) => l.event === 'connect');
      const switchConnect = connects.find((l) => l.source === 'ok-rw');
      expect(switchConnect).toBeDefined();
      expect(switchConnect!.principal).toBe('k-full');
    } finally {
      await server.close();
    }
  });

  it('用例 14b：k-ro 切到无权源 ok-rw → isError [SOURCE_NOT_FOUND] + 审计 denied；原 ok-ro 连接保持可用', async () => {
    const { server, auditPath } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const sessionId = await establishSession(server, 'test-key-ro', { 'X-DB-Source': 'ok-ro' });

      const { msg: switchMsg } = await callTool(server, sessionId, 'test-key-ro', 2, 'connect_datasource', {
        source: 'ok-rw',
      });
      expect(switchMsg?.result?.isError).toBe(true);
      expect(toolText(switchMsg)).toContain('[SOURCE_NOT_FOUND]');

      // 审计 denied（source=ok-rw，与「源不存在」不可区分但仍必落审计）
      const lines = readAudit(auditPath);
      const denied = lines.filter((l) => l.event === 'denied');
      expect(denied).toHaveLength(1);
      expect(denied[0].errorCode).toBe('SOURCE_NOT_FOUND');
      expect(denied[0].source).toBe('ok-rw');
      expect(denied[0].principal).toBe('k-ro');

      // 原连接 ok-ro 仍可用
      const { msg: q } = await callTool(server, sessionId, 'test-key-ro', 3, 'execute_query', {
        query: 'SELECT * FROM t',
      });
      expect(q?.result?.isError ?? false).toBe(false);

      // 会话元数据仍为 ok-ro（切源失败不改变当前源）
      const meta = getMcpSessionSnapshot().find((s) => s.sessionId === sessionId);
      expect(meta?.source).toBe('ok-ro');
    } finally {
      await server.close();
    }
  });

  it('用例 14e：list_datasources 仅返回 ok-ro/ok-rw 的 name/type/description，无 host/port/user/password', async () => {
    const { server } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const sessionId = await establishSession(server, 'test-key-full', { 'X-DB-Source': 'ok-ro' });

      const { msg } = await callTool(server, sessionId, 'test-key-full', 2, 'list_datasources', {});
      expect(msg?.result?.isError ?? false).toBe(false);
      const parsed = JSON.parse(toolText(msg)) as { success: boolean; sources: Array<Record<string, unknown>> };
      expect(parsed.success).toBe(true);
      const sources = parsed.sources;
      expect(sources.map((s) => s.name).sort()).toEqual(['ok-ro', 'ok-rw']);
      for (const s of sources) {
        expect(s.type).toBe('mysql');
        expect(s.description).toBeDefined();
        for (const secretKey of ['host', 'port', 'user', 'password']) {
          expect(Object.prototype.hasOwnProperty.call(s, secretKey)).toBe(false);
        }
      }
    } finally {
      await server.close();
    }
  });

  it('用例 15：execute_query SELECT 正常；审计 connect 行 principal=k-full / source=ok-ro；会话元数据携带审计主体字段', async () => {
    const { server, auditPath } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const sessionId = await establishSession(server, 'test-key-full', { 'X-DB-Source': 'ok-ro' });

      const { msg } = await callTool(server, sessionId, 'test-key-full', 2, 'execute_query', {
        query: 'SELECT * FROM users',
      });
      expect(msg?.result?.isError ?? false).toBe(false);
      expect(toolText(msg)).toContain('"rows"');

      // P2 可断言部分：会话建立审计行的主体与源
      const lines = readAudit(auditPath);
      const connect = lines.find((l) => l.event === 'connect');
      expect(connect).toBeDefined();
      expect(connect!.principal).toBe('k-full');
      expect(connect!.source).toBe('ok-ro');
      expect(connect!.transport).toBe('streamable');

      // 会话元数据（P4b 的 query 审计行将携带这些字段：principal 为 apiKeys[].name）
      const meta = getMcpSessionSnapshot().find((s) => s.sessionId === sessionId);
      expect(meta).toBeDefined();
      expect(meta!.principal).toBe('k-full');
      expect(meta!.keyFingerprint).toMatch(/^[0-9a-f]{12}$/);
      expect(meta!.source).toBe('ok-ro');
      expect(meta!.effectivePermission).toBe('safe');
    } finally {
      await server.close();
    }
  });

  it('用例 10/15 变体：未配置审计日志（无 AUDIT_LOG_PATH）不破坏流程', async () => {
    const registry = buildRegistryFromRaw(defaultRegistryRaw(), 'acl-mcp-noaudit');
    const server = await createHttpServer(baseConfig(), {
      registry,
      adapterFactory: okAdapterFactory(),
    }); // 不注入 auditLogger → 禁用态（best-effort no-op）
    try {
      const sessionId = await establishSession(server, 'test-key-full', { 'X-DB-Source': 'ok-ro' });
      const { msg } = await callTool(server, sessionId, 'test-key-full', 2, 'execute_query', {
        query: 'SELECT 1',
      });
      expect(msg?.result?.isError ?? false).toBe(false);
      // 写路径照常被拒（拒绝逻辑不依赖审计）
      const { msg: writeMsg } = await callTool(server, sessionId, 'test-key-full', 3, 'execute_query', {
        query: 'INSERT INTO t VALUES (1)',
      });
      expect(writeMsg?.result?.isError).toBe(true);
      expect(toolText(writeMsg)).toContain('[PERMISSION_DENIED]');
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// B. SSE（GET /sse）
// ---------------------------------------------------------------------------

describe('P2 MCP SSE（用例 12、13）', () => {
  it('用例 12：GET /sse?type=mysql&host=...（无 source，registry 模式）→ 403 ADHOC_DISABLED + 审计 denied', async () => {
    const { server, auditPath } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/sse?type=mysql&host=10.1.2.3&port=3306',
        headers: { 'X-API-Key': 'test-key-full' },
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('ADHOC_DISABLED');
      expect(res.headers['content-type']).toContain('application/json');

      const lines = readAudit(auditPath);
      expect(lines).toHaveLength(1);
      expect(lines[0].event).toBe('denied');
      expect(lines[0].errorCode).toBe('ADHOC_DISABLED');
    } finally {
      await server.close();
    }
  });

  it('用例 13：GET /sse?source=ok-ro（正确 key 头）→ 200 且 content-type=text/event-stream，SSE 建立', async () => {
    const { server, auditPath } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      await server.listen({ port: 0, host: '127.0.0.1' });
      const addr = server.server.address() as { port: number };
      const { statusCode, contentType, connectAudit } = await new Promise<{
        statusCode: number;
        contentType: string;
        connectAudit: AuditLine[];
      }>((resolve, reject) => {
        const req = http.get(
          {
            host: '127.0.0.1',
            port: addr.port,
            path: '/sse?source=ok-ro',
            headers: { 'X-API-Key': 'test-key-full', Accept: 'text/event-stream' },
          },
          (res) => {
            resolve({
              statusCode: res.statusCode ?? 0,
              contentType: (res.headers['content-type'] as string) ?? '',
              connectAudit: readAudit(auditPath), // 响应头已写，审计（同步写）已完成
            });
            res.destroy(); // 立即断开，不等 SSE 流结束
          }
        );
        req.on('error', reject);
      });

      expect(statusCode).toBe(200);
      expect(contentType).toContain('text/event-stream');

      // 会话建立审计：source=ok-ro、principal=k-full、transport=sse
      const connect = connectAudit.find((l) => l.event === 'connect');
      expect(connect).toBeDefined();
      expect(connect!.source).toBe('ok-ro');
      expect(connect!.principal).toBe('k-full');
      expect(connect!.transport).toBe('sse');

      // 给会话清理（transport close → cleanupSession）留时间，避免影响 server.close()
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// C. legacy-remote（无 registry + ALLOW_ADHOC_CONNECTIONS）
// ---------------------------------------------------------------------------

describe('P2 legacy-remote（用例 14d）', () => {
  it('用例 14d：initialize 无 X-DB-Source（adhoc 目标命中白名单）→ 会话建立；connect_database 到白名单外 → [ADHOC_TARGET_DENIED]', async () => {
    const { server, auditPath } = await makeLegacyServer(okAdapterFactory(), {
      allowAdhocConnections: true,
      adhocTargetAllowlist: ['10.1.2.3:3306'],
    });
    try {
      // legacy 模式无鉴权（config.http.apiKeys 为空），principal 固定 'legacy'
      const sessionId = await establishSession(server, '', {
        'X-DB-Type': 'mysql',
        'X-DB-Host': '10.1.2.3',
        'X-DB-Port': '3306',
        'X-DB-User': 'u',
        'X-DB-Database': 'd',
      });

      const { msg } = await callTool(server, sessionId, '', 2, 'connect_database', {
        type: 'mysql',
        host: '10.9.9.9',
        port: 3306,
        user: 'u',
        database: 'd',
      });
      expect(msg?.result?.isError).toBe(true);
      expect(toolText(msg)).toContain('[ADHOC_TARGET_DENIED]');

      const denied = readAudit(auditPath).filter((l) => l.event === 'denied');
      expect(denied).toHaveLength(1);
      expect(denied[0].errorCode).toBe('ADHOC_TARGET_DENIED');
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// D. 用例 23
// ---------------------------------------------------------------------------

describe('P2 /api/info（用例 23）', () => {
  it('用例 23：GET /api/info（无鉴权白名单）响应不含任何源名', async () => {
    const { server } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const res = await server.inject({ method: 'GET', url: '/api/info' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.name).toBe('universal-db-mcp');
      expect(res.body).not.toContain('ok-ro');
      expect(res.body).not.toContain('ok-rw');
    } finally {
      await server.close();
    }
  });
});