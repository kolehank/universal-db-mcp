/**
 * P3：stdio `--config/--source` 接线 + 版本号（规格 §11 用例 18–21）
 *
 * 进程内测试（不 spawn、不真连数据库）：
 * - 注入 mock adapterFactory，断言建连参数与工具集。
 * - MCP 工具行为通过 getServer() 上注册的协议 handler（tools/list、tools/call、initialize）直接调用
 *   （走真实 handler 栈，等价于客户端发起的 tools/list / tools/call 请求）。
 * - 「启动即连」= start() 在 adapter 存在时调用 connectDatabase()；为避免 stdio transport 挂住
 *   测试进程，用例 20 直接调用 server.connectDatabase()（与 start() 内部同路径）。
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { buildMcpServerFromOptions } from '../../src/mcp/mcp-index';
import type { BuildMcpServerOptions } from '../../src/mcp/mcp-index';
import type { DatabaseMCPServer } from '../../src/mcp/mcp-server';
import { readPackageVersion } from '../../src/utils/package-version';
import { setupHealthRoutes } from '../../src/http/routes/health';
import type { DbAdapter, DbConfig } from '../../src/types/adapter';

const FIXTURES = join(__dirname, '..', 'fixtures');
const REGISTRY_JSON = join(FIXTURES, 'registry.json');

// ---- mock adapter ----

interface MockAdapterState {
  /** adapterFactory 收到的所有配置（按创建顺序） */
  created: DbConfig[];
  connectCalls: number;
  disconnectCalls: number;
}

function createMockAdapter() {
  const state: MockAdapterState = { created: [], connectCalls: 0, disconnectCalls: 0 };
  const adapter: DbAdapter = {
    connect: async () => {
      state.connectCalls += 1;
    },
    disconnect: async () => {
      state.disconnectCalls += 1;
    },
    executeQuery: async (query) => ({ rows: [], metadata: { query } }),
    getSchema: async () => ({ databaseType: 'mysql', databaseName: 'test', tables: [] }),
    isWriteOperation: (query) => /^\s*(insert|update|delete|create|alter|drop|truncate|replace|merge)\b/i.test(query),
  };
  const factory = (config: DbConfig): DbAdapter => {
    state.created.push(config);
    return adapter;
  };
  return { state, factory };
}

// ---- 直调 MCP 协议 handler（真实 request handler 栈） ----

interface StoredHandlers {
  _requestHandlers: Map<string, (req: unknown, extra?: unknown) => Promise<Record<string, unknown>>>;
}

function handlersOf(server: DatabaseMCPServer): StoredHandlers {
  return server.getServer() as unknown as StoredHandlers;
}

async function listToolNames(server: DatabaseMCPServer): Promise<string[]> {
  const h = handlersOf(server)._requestHandlers.get('tools/list');
  expect(h).toBeDefined();
  const result = (await h!({ method: 'tools/list', params: {} })) as { tools: Array<{ name: string }> };
  return result.tools.map((t) => t.name);
}

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

async function callTool(server: DatabaseMCPServer, name: string, args?: Record<string, unknown>): Promise<ToolResult> {
  const h = handlersOf(server)._requestHandlers.get('tools/call');
  expect(h).toBeDefined();
  return (await h!({
    method: 'tools/call',
    params: { name, arguments: args ?? {} },
  })) as ToolResult;
}

function textOf(result: ToolResult): string {
  return result.content?.map((c) => c.text ?? '').join('\n') ?? '';
}

async function serverInfoOf(server: DatabaseMCPServer): Promise<{ name: string; version: string }> {
  const h = handlersOf(server)._requestHandlers.get('initialize');
  expect(h).toBeDefined();
  const result = (await h!({
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
  })) as { serverInfo: { name: string; version: string } };
  return result.serverInfo;
}

function build(opts: BuildMcpServerOptions) {
  return buildMcpServerFromOptions(opts);
}

describe('用例 18：legacy（--type）路径存量行为', () => {
  it('mock adapterFactory 收到与 CLI 一致的建连参数；profile=legacy-stdio；9 个存量工具', async () => {
    const { state, factory } = createMockAdapter();
    const result = await build({
      type: 'mysql',
      host: 'db.local',
      port: 3306,
      user: 'root',
      password: 'secret',
      database: 'appdb',
      permissionMode: 'safe',
      adapterFactory: factory,
    });

    expect(result.server.profile).toBe('legacy-stdio');
    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({
      type: 'mysql',
      host: 'db.local',
      port: 3306,
      user: 'root',
      password: 'secret',
      database: 'appdb',
      permissionMode: 'safe',
    });
    // legacy 返回打印数据（口读输出走 .action，这里断言其内容依据）
    expect(result.legacy).toBeDefined();
    expect(result.legacy?.config.type).toBe('mysql');
    expect(result.legacy?.isSafeMode).toBe(true);
    expect(result.legacy?.permissions).toEqual(['read']);

    const names = await listToolNames(result.server);
    expect(names).toHaveLength(9);
    expect(names).toEqual(expect.arrayContaining([
      'execute_query', 'get_schema', 'get_table_info', 'clear_cache',
      'get_enum_values', 'get_sample_data', 'connect_database',
      'disconnect_database', 'get_connection_status',
    ]));
    expect(names).not.toContain('connect_datasource');
    expect(names).not.toContain('list_datasources');
  });

  it('legacy 链接早期参数透传（sqlite/默 permissionMode/full 提权）', async () => {
    const { state, factory } = createMockAdapter();
    const sqlite = await build({ type: 'sqlite', file: '/tmp/x.db', permissionMode: 'safe', adapterFactory: factory });
    expect(state.created[0]).toMatchObject({ type: 'sqlite', filePath: '/tmp/x.db', permissionMode: 'safe' });
    expect(sqlite.legacy?.config.type).toBe('sqlite');

    const full = await build({ type: 'postgres', host: 'h', dangerAllowWrite: true, adapterFactory: factory });
    expect(state.created[1]).toMatchObject({ type: 'postgres', allowWrite: true, permissionMode: 'full' });
  });
});

describe('用例 19：--config 注册表模式（无初始连接）', () => {
  it('profile=registry-stdio；tools/list 含 connect_datasource/list_datasources 不含 connect_database；list_datasources 可调用', async () => {
    const { state, factory } = createMockAdapter();
    const result = await build({ config: REGISTRY_JSON, adapterFactory: factory });

    expect(result.server.profile).toBe('registry-stdio');
    expect(result.registry?.source).toBeUndefined();
    expect(result.server.getCurrentSource()).toBeNull();
    // 无 --source → 不创建适配器（等待 AI 调 connect_datasource）
    expect(state.created).toHaveLength(0);

    const names = await listToolNames(result.server);
    expect(names).toHaveLength(10);
    expect(names).toContain('connect_datasource');
    expect(names).toContain('list_datasources');
    expect(names).toContain('execute_query');
    expect(names).not.toContain('connect_database');

    // list_datasources 行为：仅 name/type/description
    const list = await callTool(result.server, 'list_datasources');
    const parsed = JSON.parse(textOf(list)) as { success: boolean; sources: Array<{ name: string }> };
    expect(parsed.success).toBe(true);
    expect(parsed.sources.map((s) => s.name)).toEqual(['ok-ro', 'ok-rw']);
  });

  it('connect_datasource 动态建连走注册表参数（adapter 收到源配置）', async () => {
    const { state, factory } = createMockAdapter();
    const result = await build({ config: REGISTRY_JSON, adapterFactory: factory });

    const res = await callTool(result.server, 'connect_datasource', { source: 'ok-ro' });
    expect(JSON.parse(textOf(res))).toMatchObject({ success: true, source: 'ok-ro' });
    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({
      type: 'mysql',
      host: '10.1.2.3',
      port: 3306,
      user: 'test-user',
      password: 'test-pass',
      database: 'testdb',
      permissionMode: 'safe',
    });
    expect(result.server.getCurrentSource()).toBe('ok-ro');
  });
});

describe('用例 20：--config + --source 启动即连', () => {
  it('ok-ro：建连参数来自注册表（permissionMode=sourceMax=safe）；get_connection_status 返回 source="ok-ro"', async () => {
    const { state, factory } = createMockAdapter();
    const result = await build({ config: REGISTRY_JSON, source: 'ok-ro', adapterFactory: factory });

    // 启动即连：adapter 已由注册表源构造并 setAdapter（start() 时 connectDatabase()；
    // 测试为避免 stdio transport 挂住进程，直接调用与 start() 内部同路径的 connectDatabase()）
    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({
      type: 'mysql',
      host: '10.1.2.3',
      port: 3306,
      user: 'test-user',
      password: 'test-pass',
      database: 'testdb',
      // §4.1：stdio 无 key（key 不存在）→ 取 sourceMax；ok-ro.maxPermission=safe
      permissionMode: 'safe',
    });
    expect(result.registry?.source).toBe('ok-ro');
    expect(result.server.profile).toBe('registry-stdio');
    expect(result.server.getCurrentSource()).toBe('ok-ro');
    expect(result.server.getEffectivePermission()).toBe('safe');

    await result.server.connectDatabase();
    expect(state.connectCalls).toBe(1);

    const status = await callTool(result.server, 'get_connection_status');
    const parsed = JSON.parse(textOf(status)) as { connected: boolean; source: string | null; permissionMode: string };
    expect(parsed.connected).toBe(true);
    expect(parsed.source).toBe('ok-ro');
    expect(parsed.permissionMode).toBe('safe');
  });

  it('ok-rw：§4.1 无 key 取 sourceMax=readwrite（非 safe 分支）', async () => {
    const { state, factory } = createMockAdapter();
    const result = await build({ config: REGISTRY_JSON, source: 'ok-rw', adapterFactory: factory });
    expect(state.created[0]).toMatchObject({ permissionMode: 'readwrite' });
    expect(result.server.getEffectivePermission()).toBe('readwrite');
  });

  it('源不存在于注册表 → 抛错', async () => {
    await expect(build({ config: REGISTRY_JSON, source: 'nope' })).rejects.toThrow(/不存在/);
  });
});

describe('用例 21：--type + --config 冲突 / --source 无 --config', () => {
  it('--type + --config → 报错信息含 "ambiguous config: use either --type or --config"（.action 捕获后 exit 1）', async () => {
    await expect(
      build({ type: 'mysql', host: 'h', config: REGISTRY_JSON })
    ).rejects.toThrow(/ambiguous config: use either --type or --config/);
  });

  it('--source 无 --config → 报错（message 含 --config）', async () => {
    await expect(build({ source: 'ok-ro' })).rejects.toThrow(/--config/);
  });
});

describe('版本号（P3：三处硬编码 1.0.0 消除，全部读 package.json）', () => {
  it("readPackageVersion() === package.json version，且非 '1.0.0'", () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version: string };
    expect(readPackageVersion()).toBe(pkg.version);
    expect(pkg.version).not.toBe('1.0.0');
  });

  it('MCP Server（mcp-server.ts）initialize 的 serverInfo.version 读 package.json', async () => {
    const { factory } = createMockAdapter();
    const result = await build({ config: REGISTRY_JSON, adapterFactory: factory });
    const info = await serverInfoOf(result.server);
    expect(info.name).toBe('universal-db-mcp');
    expect(info.version).toBe(readPackageVersion());
    expect(info.version).not.toBe('1.0.0');
  });

  it('GET /api/info（health.ts）version 读 package.json', async () => {
    const fastify = Fastify();
    try {
      await setupHealthRoutes(fastify);
      const res = await fastify.inject({ method: 'GET', url: '/api/info' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { data: { version: string } };
      expect(body.data.version).toBe(readPackageVersion());
      expect(body.data.version).not.toBe('1.0.0');
    } finally {
      await fastify.close();
    }
  });
});