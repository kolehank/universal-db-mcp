/**
 * MCP SSE Routes
 * 提供 MCP over SSE/Streamable HTTP 传输支持
 * 使 Dify 等平台可以通过 MCP 协议直接调用
 *
 * P2（规格 §5.2/§5.3/§6/§7/§8.1/§9 + 评审裁决 4/9）：
 * - SSE `GET /sse`：query 解析加 `source`；有 source 时忽略其余连接参数；无 source → §4.2 决策表；
 *   放行时保留现有 type/host/port... 逻辑（legacy）。
 * - Streamable HTTP `POST /mcp` initialize：读 `X-DB-Source`，优先于 `X-DB-*`（有 source 忽略全部连接头）；
 *   无 X-DB-Source → §4.2 决策；`X-DB-Permission-Mode`/`X-DB-Permissions`/`X-DB-Allow-Write` 不参与
 *   权限计算，仅当其值宽于 effective 时审计 permission_ignored（用例 10）。
 * - 后续带 mcp-session-id 的请求不重新解析连接参数（现状已如此，保持）。
 * - 会话创建时把 principal/source/effectivePermission/keyFingerprint 绑定到会话元数据（裁决 9），
 *   导出 getMcpSessionSnapshot()（遍历所有 MCP 会话及其 principal/source/keyFingerprint，供 P5 吊销扫描）。
 * - 错误响应：/sse 用 REST 风格 {success,error:{code,message},metadata}（请求级 4xx）；
 *   Streamable HTTP 用 JSON-RPC error code -32001 + data.code（§6）。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { DatabaseMCPServer } from '../../mcp/mcp-server.js';
import type { DbAdapter, DbConfig, PermissionMode, PermissionType } from '../../types/adapter.js';
import { createAdapter } from '../../utils/adapter-factory.js';
import { auditDenied, auditPermissionIgnored } from '../audit.js';
import { auditScope } from '../middleware/index.js';
import { getAuditContext } from '../../security/audit-context.js';
import { decideAccess, keyFingerprint, resolveEffectivePermission } from '../../security/datasource-registry.js';
import type { AccessDenyCode, ApiKeyDef, DatasourceDef, DatasourceRegistry, PermissionLevel } from '../../security/datasource-registry.js';
import { resolvePermissions } from '../../utils/safety.js';
import type { RouteRuntime } from './runtime.js';

// 支持的数据库类型
type DbType = DbConfig['type'];
const SUPPORTED_DB_TYPES: DbType[] = [
  'mysql', 'postgres', 'redis', 'oracle', 'dm', 'sqlserver', 'mongodb', 'sqlite',
  'kingbase', 'gaussdb', 'oceanbase', 'tidb', 'clickhouse', 'polardb', 'vastbase', 'highgo', 'goldendb'
];

// 存储活跃的 SSE 传输实例（按 sessionId）
const sseTransports: Map<string, SSEServerTransport> = new Map();

// 存储活跃的 Streamable HTTP 传输实例（按 sessionId）
const streamableTransports: Map<string, StreamableHTTPServerTransport> = new Map();

// 存储 MCP 服务器实例（按 sessionId）
const mcpServers: Map<string, DatabaseMCPServer> = new Map();

/** §6 错误码 → HTTP 状态码（与 REST connection.ts 同表） */
const DENY_STATUS: Record<AccessDenyCode, number> = {
  INVALID_REQUEST: 400,
  ADHOC_DISABLED: 403,
  ADHOC_TARGET_DENIED: 403,
  SOURCE_NOT_FOUND: 404,
};

const DENY_MESSAGE: Record<AccessDenyCode, string> = {
  INVALID_REQUEST: '缺少连接参数：请提供 source，或 type/host/port 等连接参数',
  ADHOC_DISABLED: 'adhoc 连接已禁用：请使用 X-DB-Source（或 SSE 的 source）指定已注册数据源；若确需原始连接参数，需开启 allowAdhocConnections（或环境变量 ALLOW_ADHOC_CONNECTIONS=true）并将目标地址列入 adhocTargetAllowlist',
  ADHOC_TARGET_DENIED: 'adhoc 连接目标不在允许清单（adhocTargetAllowlist）中',
  SOURCE_NOT_FOUND: '源不存在或当前 API key 无权访问',
};

/** 会话元数据（评审裁决 9）：P5 吊销扫描遍历 principal/source/keyFingerprint */
export interface McpSessionMeta {
  sessionId: string;
  transport: 'sse' | 'streamable';
  /** 审计主体：注册表模式 apiKeys[].name；legacy 固定 'legacy' */
  principal: string;
  /** sha256(key) 前 12 位 */
  keyFingerprint: string;
  /** 当前源名；adhoc 固定 'adhoc'；未连接 null */
  source: string | null;
  /** §4.1 生效权限（注册表会话有值；legacy undefined） */
  effectivePermission?: PermissionLevel;
}

const mcpSessionMeta: Map<string, McpSessionMeta> = new Map();

/**
 * 遍历所有 MCP 会话及其 principal/source/keyFingerprint（P5 SIGHUP 重载后吊销扫描用）。
 * 返回副本，不暴露内部引用。
 */
export function getMcpSessionSnapshot(): ReadonlyArray<McpSessionMeta> {
  return Array.from(mcpSessionMeta.values()).map((m) => ({ ...m }));
}

/**
 * 验证数据库类型
 */
function isValidDbType(type: string | undefined): type is DbType {
  return typeof type === 'string' && SUPPORTED_DB_TYPES.includes(type as DbType);
}

/** adhoc 连接参数是否存在于 query（§4.2「存在 adhoc 字段」判定；权限字段不参与，与 REST 一致） */
function queryHasAdhocParams(query: Record<string, unknown>): boolean {
  return ['type', 'host', 'port', 'user', 'password', 'database', 'filePath', 'oracleClientPath'].some(
    (k) => query[k] !== undefined && query[k] !== null && query[k] !== ''
  );
}

/**
 * 从请求中解析数据库配置（legacy/adhoc 路径）
 */
function parseDbConfigFromQuery(query: Record<string, unknown>): DbConfig | null {
  const type = query.type as string;
  if (!type || !isValidDbType(type)) return null;

  // 解析 permissions 数组
  const permissionsStr = query.permissions as string;
  const permissions = permissionsStr
    ? permissionsStr.split(',').map(p => p.trim()) as PermissionType[]
    : undefined;

  return {
    type,
    host: query.host as string,
    port: query.port ? parseInt(query.port as string, 10) : undefined,
    user: query.user as string,
    password: query.password as string,
    database: query.database as string,
    filePath: query.filePath as string,
    allowWrite: query.allowWrite === 'true',
    permissionMode: query.permissionMode as PermissionMode,
    permissions,
    oracleClientPath: query.oracleClientPath as string,
  };
}

/** streamable headers 是否存在 adhoc 连接参数（§4.2；权限头不参与判定） */
function streamableHeadersHaveAdhocParams(headers: Record<string, unknown>): boolean {
  return ['x-db-type', 'x-db-host', 'x-db-port', 'x-db-user', 'x-db-password', 'x-db-database', 'x-db-filepath', 'x-db-oracle-client-path'].some(
    (k) => headers[k] !== undefined && headers[k] !== null && headers[k] !== ''
  );
}

/** streamable headers → legacy DbConfig（adhoc 直通，§9 legacy-remote 语义） */
function buildAdhocDbConfigFromHeaders(headers: Record<string, unknown>): DbConfig {
  const permissionsHeader = headers['x-db-permissions'] as string;
  return {
    type: headers['x-db-type'] as DbConfig['type'],
    host: headers['x-db-host'] as string,
    port: headers['x-db-port'] ? parseInt(headers['x-db-port'] as string, 10) : undefined,
    user: headers['x-db-user'] as string,
    password: headers['x-db-password'] as string,
    database: headers['x-db-database'] as string,
    filePath: headers['x-db-filepath'] as string,
    allowWrite: headers['x-db-allow-write'] === 'true',
    permissionMode: headers['x-db-permission-mode'] as PermissionMode,
    permissions: permissionsHeader ? permissionsHeader.split(',').map(p => p.trim()) as PermissionType[] : undefined,
    oracleClientPath: headers['x-db-oracle-client-path'] as string,
  };
}

/** 注册表源 → 服务端权威 DbConfig（§4.1：permissionMode 填 effective 预设名；客户端连接字段一律忽略） */
function buildSourceDbConfig(def: DatasourceDef, effective: PermissionLevel): DbConfig {
  return {
    type: def.type as DbConfig['type'],
    ...(def.host !== undefined ? { host: def.host } : {}),
    ...(def.port !== undefined ? { port: def.port } : {}),
    ...(def.user !== undefined ? { user: def.user } : {}),
    ...(def.password !== undefined ? { password: def.password } : {}),
    ...(def.database !== undefined ? { database: def.database } : {}),
    ...(def.filePath !== undefined ? { filePath: def.filePath } : {}),
    ...(def.authSource !== undefined ? { authSource: def.authSource } : {}),
    ...(def.oracleClientPath !== undefined ? { oracleClientPath: def.oracleClientPath } : {}),
    permissionMode: effective,
  };
}

/** effective 对应的预设权限集合（§4.1） */
function effectivePermissionSet(effective: PermissionLevel): PermissionType[] {
  return effective === 'full'
    ? ['read', 'insert', 'update', 'delete', 'ddl']
    : effective === 'readwrite'
      ? ['read', 'insert', 'update']
      : ['read'];
}

/** 客户端权限声明（query 侧）是否宽于 effective（§4.1：宽则审计 permission_ignored） */
function queryPermissionClaimsWider(query: Record<string, unknown>, effective: PermissionLevel): boolean {
  const hasClaim =
    query.allowWrite !== undefined ||
    query.permissionMode !== undefined ||
    (typeof query.permissions === 'string' && query.permissions.length > 0) ||
    (Array.isArray(query.permissions) && query.permissions.length > 0);
  if (!hasClaim) {
    return false;
  }
  const claimed = new Set(
    resolvePermissions({
      type: 'sqlite',
      ...(query.allowWrite !== undefined ? { allowWrite: query.allowWrite === 'true' } : {}),
      ...(query.permissionMode !== undefined ? { permissionMode: query.permissionMode as PermissionMode } : {}),
      ...((typeof query.permissions === 'string' && query.permissions.length > 0)
        ? { permissions: (query.permissions as string).split(',').map((p) => p.trim()) as PermissionType[] }
        : Array.isArray(query.permissions) && query.permissions.length > 0
          ? { permissions: query.permissions as PermissionType[] }
          : {}),
    } as DbConfig)
  );
  return Array.from(claimed).some((p) => !effectivePermissionSet(effective).includes(p));
}

/** 客户端权限声明（streamable headers 侧）是否宽于 effective（用例 10） */
function streamableHeaderPermissionClaimsWider(headers: Record<string, unknown>, effective: PermissionLevel): boolean {
  const permissionsHeader = headers['x-db-permissions'] as string;
  const hasClaim =
    headers['x-db-allow-write'] !== undefined ||
    headers['x-db-permission-mode'] !== undefined ||
    (typeof permissionsHeader === 'string' && permissionsHeader.length > 0);
  if (!hasClaim) {
    return false;
  }
  const claimed = new Set(
    resolvePermissions({
      type: 'sqlite',
      ...(headers['x-db-allow-write'] !== undefined ? { allowWrite: headers['x-db-allow-write'] === 'true' } : {}),
      ...(headers['x-db-permission-mode'] !== undefined
        ? { permissionMode: headers['x-db-permission-mode'] as PermissionMode }
        : {}),
      ...(typeof permissionsHeader === 'string' && permissionsHeader.length > 0
        ? { permissions: permissionsHeader.split(',').map((p) => p.trim()) as PermissionType[] }
        : {}),
    } as DbConfig)
  );
  return Array.from(claimed).some((p) => !effectivePermissionSet(effective).includes(p));
}

/** adhoc 开关 / 目标白名单（§3.1：env ALLOW_ADHOC_CONNECTIONS 覆盖注册表；白名单文件优先） */
function resolveAdhocPolicy(
  registry: DatasourceRegistry | null,
  securityEnv: RouteRuntime['securityEnv'] | undefined
): { adhocEnabled: boolean; adhocTargetAllowlist: string[] } {
  const env = securityEnv ?? {};
  const adhocEnabled = registry
    ? (env.allowAdhocConnections ?? registry.allowAdhocConnections)
    : env.allowAdhocConnections === true;
  const adhocTargetAllowlist = registry
    ? [...registry.adhocTargetAllowlist]
    : (env.adhocTargetAllowlist ?? []);
  return { adhocEnabled, adhocTargetAllowlist };
}

/** 会话建立审计（event=connect；best-effort） */
function auditMcpConnect(logger: RouteRuntime['auditLogger'], source: string | null): void {
  if (!logger) {
    return;
  }
  const ctx = getAuditContext();
  if (!ctx) {
    return;
  }
  logger.write({
    event: 'connect',
    requestId: ctx.requestId,
    transport: ctx.transport,
    principal: ctx.principal,
    keyFingerprint: ctx.keyFingerprint,
    source: source ?? undefined,
    clientIp: ctx.clientIp,
    auditUser: ctx.auditUser, // 仅 TRUST_AUDIT_USER_HEADER=true 时由 auth 注入；logger 在 false 时丢弃
    status: 'ok',
  });
}

/** 记录会话元数据并初始化三张 map */
function registerMcpSession(
  sessionId: string,
  transportType: 'sse' | 'streamable',
  meta: { principal: string; keyFingerprint: string; source: string | null; effectivePermission?: PermissionLevel }
): void {
  mcpSessionMeta.set(sessionId, {
    sessionId,
    transport: transportType,
    principal: meta.principal,
    keyFingerprint: meta.keyFingerprint,
    source: meta.source,
    ...(meta.effectivePermission !== undefined ? { effectivePermission: meta.effectivePermission } : {}),
  });
}

/** 切源后同步会话元数据的 source/effectivePermission（从 mcpServer 当前状态读取） */
function syncMcpSessionFromServer(sessionId: string, mcpServer: DatabaseMCPServer): void {
  const meta = mcpSessionMeta.get(sessionId);
  if (!meta) {
    return;
  }
  meta.source = mcpServer.getCurrentSource();
  const effectivePermission = mcpServer.getEffectivePermission();
  if (effectivePermission !== undefined) {
    meta.effectivePermission = effectivePermission;
  } else {
    delete meta.effectivePermission;
  }
}

/** 创建远程 MCP 服务器（registry 或 legacy，均经注入的 adapterFactory 建连） */
async function createRemoteMcpServer(options: {
  config: DbConfig;
  registry: DatasourceRegistry | null;
  key: ApiKeyDef | null;
  source: string | null;
  principal: string;
  keyFingerprint: string;
  effectivePermission?: PermissionLevel;
  auditLogger?: RouteRuntime['auditLogger'];
  adapterFactory?: (config: DbConfig) => DbAdapter;
  adhocTargetAllowlist: string[];
}): Promise<DatabaseMCPServer> {
  const mcpServer = new DatabaseMCPServer(options.config, {
    registry: options.registry,
    isRemote: true,
    key: options.key,
    principal: options.principal,
    keyFingerprint: options.keyFingerprint,
    source: options.source,
    effectivePermission: options.effectivePermission,
    auditLogger: options.auditLogger,
    adapterFactory: options.adapterFactory,
    adhocTargetAllowlist: options.adhocTargetAllowlist,
  });
  const adapter = (options.adapterFactory ?? createAdapter)(options.config);
  mcpServer.setAdapter(adapter);
  await mcpServer.connectDatabase();
  return mcpServer;
}

/**
 * 清理会话资源（P5：导出供 http-index SIGHUP 重载后的逐会话吊销调用）
 */
export async function cleanupSession(sessionId: string): Promise<void> {
  const mcpServer = mcpServers.get(sessionId);
  if (mcpServer) {
    await mcpServer.stop();
    mcpServers.delete(sessionId);
  }
  sseTransports.delete(sessionId);
  streamableTransports.delete(sessionId);
  mcpSessionMeta.delete(sessionId);
}

/**
 * 设置 MCP SSE 路由
 */
export async function setupMcpSseRoutes(
  fastify: FastifyInstance,
  runtime: RouteRuntime = {}
): Promise<void> {
  const registry = runtime.registry ?? null;
  const securityEnv = runtime.securityEnv ?? {};
  const auditLogger = runtime.auditLogger;

  /**
   * SSE 端点 - 用于建立 SSE 连接（传统 SSE 模式）
   * GET /sse?source=ok-ro 或 GET /sse?type=mysql&host=...（adhoc/legacy）
   *
   * P2（§5.2）：有 source 忽略其余连接参数；无 source → §4.2 决策（注册表模式 403 ADHOC_DISABLED 等）。
   * 错误响应用 REST 信封 {success,error,metadata}（请求级 4xx）。
   */
  fastify.get('/sse', async (request: FastifyRequest, reply: FastifyReply) => {
    return auditScope(request, async () => {
      const ctx = getAuditContext();
      if (ctx) {
        ctx.transport = 'sse';
      }
      const query = request.query as Record<string, unknown>;
      const source =
        typeof query.source === 'string' && query.source.trim().length > 0 ? query.source.trim() : undefined;

      const { adhocEnabled, adhocTargetAllowlist } = resolveAdhocPolicy(registry, securityEnv);
      const apiKey = (request as { apiKey?: string }).apiKey;
      const keyDef = registry && apiKey ? registry.findKey(apiKey) : undefined;
      const adhocTarget =
        query.host !== undefined && query.port !== undefined ? `${query.host}:${query.port}` : undefined;

      const decision = decideAccess({
        source,
        key: keyDef ?? null,
        registryEnabled: registry !== null,
        adhocEnabled,
        adhocTargetAllowlist,
        hasAdhocParams: queryHasAdhocParams(query),
        adhocTarget,
      });

      if (decision.decision === 'deny') {
        // 任何 denied 必落审计（含 404，§6）
        const denySource =
          decision.code === 'SOURCE_NOT_FOUND'
            ? source ?? ''
            : decision.code === 'INVALID_REQUEST'
              ? undefined
              : 'adhoc';
        auditDenied(auditLogger, decision.code, denySource);
        reply.code(DENY_STATUS[decision.code]);
        return {
          success: false,
          error: {
            code: decision.code,
            message: DENY_MESSAGE[decision.code],
          },
          metadata: {
            timestamp: new Date().toISOString(),
            requestId: request.id,
          },
        };
      }

      // ---- 有 source（已通过 allowedSources 校验）----
      let config: DbConfig;
      let sourceName: string | null;
      let effectivePermission: PermissionLevel | undefined;
      if (source) {
        const sourceDef = registry?.resolveSource(source);
        if (!sourceDef) {
          auditDenied(auditLogger, 'SOURCE_NOT_FOUND', source);
          reply.code(404);
          return {
            success: false,
            error: { code: 'SOURCE_NOT_FOUND', message: DENY_MESSAGE.SOURCE_NOT_FOUND },
            metadata: { timestamp: new Date().toISOString(), requestId: request.id },
          };
        }
        effectivePermission = resolveEffectivePermission(sourceDef, keyDef ?? null);
        // §4.1：客户端自报权限宽于 effective → 审计 permission_ignored
        if (queryPermissionClaimsWider(query, effectivePermission)) {
          auditPermissionIgnored(auditLogger, source);
        }
        config = buildSourceDbConfig(sourceDef, effectivePermission);
        sourceName = source;
        if (ctx) {
          ctx.source = source;
        }
      } else {
        // 无 source 且 adhoc 放行：现有 legacy 逻辑保留
        const parsedConfig = parseDbConfigFromQuery(query);
        if (!parsedConfig) {
          reply.code(400);
          return {
            success: false,
            error: {
              code: 'INVALID_REQUEST',
              message: 'Missing required database configuration. Please provide at least "type" parameter.',
            },
            metadata: { timestamp: new Date().toISOString(), requestId: request.id },
          };
        }
        config = parsedConfig;
        sourceName = 'adhoc';
        if (ctx) {
          ctx.source = 'adhoc';
        }
      }

      const principal = ctx?.principal ?? (keyDef?.name ?? 'legacy');
      const fingerprint = ctx?.keyFingerprint ?? (apiKey ? keyFingerprint(apiKey) : '');

      try {
        const mcpServer = await createRemoteMcpServer({
          config,
          registry,
          key: keyDef ?? null,
          source: sourceName,
          principal,
          keyFingerprint: fingerprint,
          effectivePermission,
          auditLogger,
          adapterFactory: runtime.adapterFactory,
          adhocTargetAllowlist,
        });
        auditMcpConnect(auditLogger, sourceName);

        // 之后的响应由底层 SSE transport 接管
        reply.hijack();
        const res = reply.raw;

        // 创建 SSE 传输
        const transport = new SSEServerTransport('/sse/message', res);
        const sessionId = transport.sessionId;

        // 存储实例
        sseTransports.set(sessionId, transport);
        mcpServers.set(sessionId, mcpServer);
        registerMcpSession(sessionId, 'sse', {
          principal,
          keyFingerprint: fingerprint,
          source: sourceName,
          effectivePermission,
        });

        // 设置关闭处理
        transport.onclose = async () => {
          console.error(`SSE session ${sessionId} closed`);
          await cleanupSession(sessionId);
        };

        // 连接 MCP 服务器到传输层（connect 会自动调用 transport.start()）
        await mcpServer.getServer().connect(transport);

        console.error(`🔗 SSE session started: ${sessionId}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`❌ SSE connection error: ${errorMessage}`);
        if (!reply.raw.headersSent) {
          reply.code(502);
          return {
            success: false,
            error: {
              code: 'CONNECT_FAILED',
              message: errorMessage,
            },
            metadata: { timestamp: new Date().toISOString(), requestId: request.id },
          };
        }
        reply.raw.destroy();
      }
      return;
    });
  });

  /**
   * SSE 消息端点 - 接收客户端发送的消息（传统 SSE 模式）
   * POST /sse/message?sessionId=xxx
   */
  fastify.post('/sse/message', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const sessionId = query.sessionId as string;

    if (!sessionId) {
      return reply.code(400).send({
        success: false,
        error: {
          code: 'MISSING_SESSION_ID',
          message: 'Session ID is required',
        },
      });
    }

    const transport = sseTransports.get(sessionId);
    if (!transport) {
      return reply.code(404).send({
        success: false,
        error: {
          code: 'SESSION_NOT_FOUND',
          message: 'Session not found or expired',
        },
      });
    }

    // 该 HTTP 请求的审计上下文：transport=sse，source=会话当前源（§8.1 切源后不得沿用 initialize 值）
    return auditScope(request, async () => {
      const ctx = getAuditContext();
      if (ctx) {
        ctx.transport = 'sse';
        const mcpServer = mcpServers.get(sessionId);
        if (mcpServer) {
          ctx.source = mcpServer.getCurrentSource() ?? '';
        }
      }
      try {
        // 获取原始的 Node.js request/response 对象
        const req = request.raw;
        const res = reply.raw;

        await transport.handlePostMessage(req, res, request.body);
        const mcpServer = mcpServers.get(sessionId);
        if (mcpServer) {
          syncMcpSessionFromServer(sessionId, mcpServer);
        }
        return;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`❌ SSE message error: ${errorMessage}`);
        reply.code(500);
        return {
          success: false,
          error: {
            code: 'MESSAGE_ERROR',
            message: errorMessage,
          },
        };
      }
    });
  });

  /**
   * Streamable HTTP 端点 - MCP 2025 新规范
   * POST /mcp
   *
   * P2（§5.3）：initialize 读 X-DB-Source（优先于 X-DB-*，忽略其余连接头）；无 X-DB-Source → §4.2 决策；
   * X-DB-Permission-* 不参与权限计算（宽于 effective 仅审计 permission_ignored，用例 10）。
   * 错误响应：JSON-RPC error code -32001 + data.code（§6）。
   */
  fastify.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    return auditScope(request, async () => {
      const ctx = getAuditContext();
      if (ctx) {
        ctx.transport = 'streamable';
      }
      const headers = request.headers;
      const body = request.body;

      try {
        // 检查是否有现有会话
        const sessionId = headers['mcp-session-id'] as string;
        let transport: StreamableHTTPServerTransport;

        if (sessionId && streamableTransports.has(sessionId)) {
          // 复用现有传输（不重新解析连接参数，§5.3）
          transport = streamableTransports.get(sessionId)!;
          const mcpServer = mcpServers.get(sessionId);
          if (ctx && mcpServer) {
            ctx.source = mcpServer.getCurrentSource() ?? '';
          }
          reply.hijack();
          await transport.handleRequest(request.raw, reply.raw, body);
          if (mcpServer) {
            syncMcpSessionFromServer(sessionId, mcpServer);
          }
          return;
        }

        if (sessionId || !isInitializeRequest(body)) {
          // 带未知 sessionId / 非 initialize 且无会话 → 400（现状语义）
          reply.code(400);
          return aclJsonRpcError('INVALID_REQUEST', 'Bad Request: No valid session ID provided');
        }

        // ---- 新的初始化请求：§4.2 决策表 ----
        const apiKey = (request as { apiKey?: string }).apiKey;
        const keyDef = registry && apiKey ? registry.findKey(apiKey) : undefined;
        const { adhocEnabled, adhocTargetAllowlist } = resolveAdhocPolicy(registry, securityEnv);
        const sourceHeader =
          typeof headers['x-db-source'] === 'string' && headers['x-db-source'].trim().length > 0
            ? headers['x-db-source'].trim()
            : undefined;
        const hostHeader = headers['x-db-host'] as string;
        const portHeader = headers['x-db-port'] as string;
        const adhocTarget =
          hostHeader !== undefined && portHeader !== undefined ? `${hostHeader}:${portHeader}` : undefined;

        const decision = decideAccess({
          source: sourceHeader,
          key: keyDef ?? null,
          registryEnabled: registry !== null,
          adhocEnabled,
          adhocTargetAllowlist,
          hasAdhocParams: streamableHeadersHaveAdhocParams(headers as Record<string, unknown>),
          adhocTarget,
        });

        if (decision.decision === 'deny') {
          // 任何 denied 必落审计（含 404，§6）
          const denySource =
            decision.code === 'SOURCE_NOT_FOUND'
              ? sourceHeader ?? ''
              : decision.code === 'INVALID_REQUEST'
                ? undefined
                : 'adhoc';
          auditDenied(auditLogger, decision.code, denySource);
          reply.code(DENY_STATUS[decision.code]);
          return aclJsonRpcError(decision.code, DENY_MESSAGE[decision.code]);
        }

        let config: DbConfig;
        let sourceName: string | null;
        let effectivePermission: PermissionLevel | undefined;
        if (sourceHeader) {
          // X-DB-Source 优先：忽略 X-DB-Type 等全部连接头（§5.3）
          const sourceDef = registry?.resolveSource(sourceHeader);
          if (!sourceDef) {
            auditDenied(auditLogger, 'SOURCE_NOT_FOUND', sourceHeader);
            reply.code(404);
            return aclJsonRpcError('SOURCE_NOT_FOUND', DENY_MESSAGE.SOURCE_NOT_FOUND);
          }
          effectivePermission = resolveEffectivePermission(sourceDef, keyDef ?? null);
          // 用例 10：X-DB-Permission-* 不参与权限计算，仅当宽于 effective 时审计 permission_ignored
          if (streamableHeaderPermissionClaimsWider(headers as Record<string, unknown>, effectivePermission)) {
            auditPermissionIgnored(auditLogger, sourceHeader);
          }
          config = buildSourceDbConfig(sourceDef, effectivePermission);
          sourceName = sourceHeader;
          if (ctx) {
            ctx.source = sourceHeader;
          }
        } else {
          // adhoc/legacy 放行（§5.3：X-DB-Performance-* 不参与权限计算，直通 legacy 行为）
          if (!isValidDbType(headers['x-db-type'] as string | undefined)) {
            reply.code(400);
            return aclJsonRpcError(
              'INVALID_REQUEST',
              'Missing or invalid database configuration. Please provide a valid X-DB-Source or X-DB-Type header.'
            );
          }
          config = buildAdhocDbConfigFromHeaders(headers as Record<string, unknown>);
          sourceName = 'adhoc';
          if (ctx) {
            ctx.source = 'adhoc';
          }
        }

        const principal = ctx?.principal ?? (keyDef?.name ?? 'legacy');
        const fingerprint = ctx?.keyFingerprint ?? (apiKey ? keyFingerprint(apiKey) : '');

        let mcpServer: DatabaseMCPServer;
        try {
          // 创建 MCP 服务器（连接失败 → CONNECT_FAILED 502，不是 403）
          mcpServer = await createRemoteMcpServer({
            config,
            registry,
            key: keyDef ?? null,
            source: sourceName,
            principal,
            keyFingerprint: fingerprint,
            effectivePermission,
            auditLogger,
            adapterFactory: runtime.adapterFactory,
            adhocTargetAllowlist,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`❌ MCP connect error: ${errorMessage}`);
          reply.code(502);
          return aclJsonRpcError('CONNECT_FAILED', `数据库连接失败: ${errorMessage}`);
        }
        auditMcpConnect(auditLogger, sourceName);

        // 创建 Streamable HTTP 传输
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            console.error(`🔗 MCP session initialized: ${newSessionId}`);
            streamableTransports.set(newSessionId, transport);
            mcpServers.set(newSessionId, mcpServer);
            registerMcpSession(newSessionId, 'streamable', {
              principal,
              keyFingerprint: fingerprint,
              source: sourceName,
              effectivePermission,
            });
          },
        });

        // 连接 MCP 服务器到传输层（使用 getServer() 避免重复调用 start）
        await mcpServer.getServer().connect(transport);

        // 响应由 transport 直接写入 reply.raw
        reply.hijack();
        await transport.handleRequest(request.raw, reply.raw, body);
        return;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`❌ MCP request error: ${errorMessage}`);
        if (!reply.raw.headersSent) {
          reply.code(500);
          return aclJsonRpcError('INTERNAL_ERROR', errorMessage);
        }
        // hijack 后传输层异常：中断流，避免悬挂
        if (!reply.sent) {
          reply.raw.destroy();
        }
        return;
      }
    });
  });

  /**
   * Streamable HTTP GET 端点 - 用于 SSE 流
   * GET /mcp
   */
  fastify.get('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = request.headers['mcp-session-id'] as string;

    if (!sessionId || !streamableTransports.has(sessionId)) {
      return reply.code(400).send({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      });
    }

    const transport = streamableTransports.get(sessionId)!;
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw);
  });

  /**
   * 删除会话端点
   * DELETE /mcp?sessionId=xxx
   */
  fastify.delete('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const sessionId = query.sessionId as string || request.headers['mcp-session-id'] as string;

    if (!sessionId) {
      return reply.code(400).send({
        success: false,
        error: {
          code: 'MISSING_SESSION_ID',
          message: 'Session ID is required',
        },
      });
    }

    await cleanupSession(sessionId);

    return reply.send({
      success: true,
      message: 'Session closed',
    });
  });

  console.error('📡 MCP SSE/Streamable HTTP routes registered');
}

/** streamable initialize 的 JSON-RPC 错误（§6：code -32001 + data.code） */
function aclJsonRpcError(code: string, message: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    error: {
      code: -32001,
      message,
      data: { code },
    },
    id: null,
  };
}