/**
 * Connection Routes
 * Database connection and disconnection endpoints
 *
 * P1：REST /api/connect ACL（规格 §4.2/§5.4/§6，用例 3-9、16、17）+ 审计接线。
 * - body schema `required: []`（condition 必填无法用 Fastify schema 表达，§5.4），新增 `source`。
 *   **不要**加 additionalProperties:false（Ajv removeAdditional 陷阱，评审 G17）。
 * - 判定顺序：有 source → 忽略其余连接字段（含 password，用例 8）；无 source → §4.2 决策表。
 * - 错误码：INVALID_REQUEST 400 / ADHOC_DISABLED 403 / ADHOC_TARGET_DENIED 403 /
 *   SOURCE_NOT_FOUND 404 / CONNECT_FAILED 502（替换原恒 500）。
 * - 审计：任何 denied 必落审计（含 404）+ connect + permission_ignored + disconnect。
 */

import type { FastifyInstance } from 'fastify';
import type {
  ConnectRequest,
  ConnectResponse,
  DisconnectRequest,
  DisconnectResponse,
  ApiResponse,
  ResponseMetadata,
} from '../../types/http.js';
import type { DbConfig } from '../../types/adapter.js';
import { ConnectionManager } from '../../core/connection-manager.js';
import { auditScope } from '../middleware/index.js';
import type { RouteRuntime } from './runtime.js';
import { decideAccess, resolveEffectivePermission } from '../../security/datasource-registry.js';
import type { AccessDenyCode, DatasourceDef, PermissionLevel } from '../../security/datasource-registry.js';
import { auditDenied, auditPermissionIgnored } from '../audit.js';
import { getAuditContext } from '../../security/audit-context.js';
import { classifyError } from '../../security/errors.js';
import { resolvePermissions } from '../../utils/safety.js';
import type { PermissionType } from '../../types/adapter.js';

/** §6 错误码 HTTP 状态（CLI/REST 侧） */
const DENY_STATUS: Record<AccessDenyCode, number> = {
  INVALID_REQUEST: 400,
  ADHOC_DISABLED: 403,
  ADHOC_TARGET_DENIED: 403,
  SOURCE_NOT_FOUND: 404,
};

const DENY_MESSAGE: Record<AccessDenyCode, string> = {
  INVALID_REQUEST: '缺少连接参数：请提供 source，或 type/host/port 等连接参数',
  ADHOC_DISABLED: 'adhoc 连接已禁用：请使用 source 参数指定已注册数据源；若确需原始连接参数，需开启 allowAdhocConnections（或环境变量 ALLOW_ADHOC_CONNECTIONS=true）并将目标地址列入 adhocTargetAllowlist',
  ADHOC_TARGET_DENIED: 'adhoc 连接目标不在允许清单（adhocTargetAllowlist）中',
  SOURCE_NOT_FOUND: '源不存在或当前 API key 无权访问',
};

/** 判定「带 source」分支中客户端自报权限字段的「宽于 effective」检查（§4.1） */
function clientPermissionClaimsWider(
  body: ConnectRequest,
  effective: PermissionLevel
): boolean {
  const hasClaim =
    body.allowWrite !== undefined ||
    body.permissionMode !== undefined ||
    (body.permissions !== undefined && body.permissions.length > 0);
  if (!hasClaim) {
    return false;
  }
  const effectivePerms: PermissionType[] =
    effective === 'full'
      ? ['read', 'insert', 'update', 'delete', 'ddl']
      : effective === 'readwrite'
        ? ['read', 'insert', 'update']
        : ['read'];

  const claimed = new Set(
    resolvePermissions({
      type: 'sqlite',
      ...(body.allowWrite !== undefined ? { allowWrite: body.allowWrite } : {}),
      ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode as DbConfig['permissionMode'] } : {}),
      ...(body.permissions !== undefined ? { permissions: body.permissions as PermissionType[] } : {}),
    } as DbConfig)
  );
  // 「宽于 effective」= 客户端声明集合里有 effective 之外的权限（比服务端授权更宽 → 记 permission_ignored）
  return Array.from(claimed).some(p => !effectivePerms.includes(p));
}

/** 注册表源 → 服务端权威 DbConfig（§4.1：permissionMode 填 effective 预设名；忽略客户端连接字段） */
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

/**
 * legacy/adhoc 路径：客户端连接参数直通（§9 legacy-remote 语义：2.x 行为）。
 * P0-6/7：filePath（SQLite 本地文件）与 oracleClientPath（本地动态库）**不接受客户端输入**，
 * 只能由服务端注册表（DATASOURCE_CONFIG）或启动参数指定。
 */
function buildAdhocDbConfig(body: ConnectRequest): DbConfig {
  return {
    type: (body.type ?? '') as DbConfig['type'],
    ...(body.host !== undefined ? { host: body.host } : {}),
    ...(body.port !== undefined ? { port: body.port } : {}),
    ...(body.user !== undefined ? { user: body.user } : {}),
    ...(body.password !== undefined ? { password: body.password } : {}),
    ...(body.database !== undefined ? { database: body.database } : {}),
    ...(body.authSource !== undefined ? { authSource: body.authSource } : {}),
    ...(body.allowWrite !== undefined ? { allowWrite: body.allowWrite } : {}),
    ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode as DbConfig['permissionMode'] } : {}),
    ...(body.permissions !== undefined ? { permissions: body.permissions as PermissionType[] } : {}),
  };
}

/** 是否有任何 adhoc 连接参数（§4.2 决策表「未带 source，存在 adhoc 字段」判定） */
function hasAdhocParams(body: ConnectRequest): boolean {
  return (
    body.type !== undefined ||
    body.host !== undefined ||
    body.port !== undefined ||
    body.user !== undefined ||
    body.password !== undefined ||
    body.database !== undefined ||
    body.filePath !== undefined ||
    body.authSource !== undefined ||
    body.oracleClientPath !== undefined
  );
}

export async function setupConnectionRoutes(
  fastify: FastifyInstance,
  connectionManager: ConnectionManager,
  runtime: RouteRuntime = {}
): Promise<void> {
  /**
   * POST /api/connect
   * Connect to a database
   */
  fastify.post<{
    Body: ConnectRequest;
    Reply: ApiResponse<ConnectResponse>;
  }>('/api/connect', {
    schema: {
      body: {
        type: 'object',
        required: [],
        properties: {
          source: { type: 'string', description: '数据源注册表源名；存在时忽略其余连接字段' },
          type: { type: 'string' },
          host: { type: 'string' },
          port: { type: 'number' },
          user: { type: 'string' },
          password: { type: 'string' },
          database: { type: 'string' },
          filePath: { type: 'string' },
          authSource: { type: 'string' },
          allowWrite: { type: 'boolean', default: false },
          permissionMode: { type: 'string', enum: ['safe', 'readwrite', 'full', 'custom'] },
          permissions: { type: 'array', items: { type: 'string', enum: ['read', 'insert', 'update', 'delete', 'ddl'] } },
          oracleClientPath: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    return auditScope(request, async () => {
      try {
        const body = request.body;
        const errMeta = (): ResponseMetadata => ({
          timestamp: new Date().toISOString(),
          requestId: request.id,
        });

        const registry = runtime.registry ?? null;
        const securityEnv = runtime.securityEnv ?? {};
        const apiKey = (request as { apiKey?: string }).apiKey;
        const keyDef = registry && apiKey ? registry.findKey(apiKey) : undefined;

        // P0-7：本地文件/本地动态库路径只能来自注册表或启动参数，客户端提交一律拒绝
        if (!body.source && (body.filePath !== undefined || body.oracleClientPath !== undefined)) {
          auditDenied(runtime.auditLogger, 'INVALID_REQUEST', 'adhoc');
          reply.code(400);
          return {
            success: false,
            error: {
              code: 'INVALID_REQUEST',
              message:
                '客户端不允许指定 filePath / oracleClientPath。' +
                'SQLite 数据库文件和 Oracle Client 路径只能由服务端注册表（DATASOURCE_CONFIG）或启动参数配置。',
            },
            metadata: errMeta(),
          };
        }

        // adhoc 开关与目标白名单（§3.1：env ALLOW_ADHOC_CONNECTIONS 覆盖注册表字段；白名单文件优先，评审 §4-5）
        const adhocEnabled = registry
          ? (securityEnv.allowAdhocConnections ?? registry.allowAdhocConnections)
          : securityEnv.allowAdhocConnections === true;
        const adhocTargetAllowlist = registry
          ? registry.adhocTargetAllowlist
          : (securityEnv.adhocTargetAllowlist ?? []);
        const adhocTarget =
          body.host !== undefined && body.port !== undefined ? `${body.host}:${body.port}` : undefined;

        // §4.2 决策表
        const decision = decideAccess({
          source: body.source,
          key: keyDef ?? null,
          registryEnabled: registry !== null,
          adhocEnabled,
          adhocTargetAllowlist: [...adhocTargetAllowlist],
          hasAdhocParams: hasAdhocParams(body),
          adhocTarget,
        });

        if (decision.decision === 'deny') {
          // 任何 denied 必落审计（含 404 SOURCE_NOT_FOUND 场景，规格 §6）
          const denySource =
            decision.code === 'SOURCE_NOT_FOUND'
              ? body.source ?? ''
              : decision.code === 'INVALID_REQUEST'
                ? undefined
                : 'adhoc';
          auditDenied(runtime.auditLogger, decision.code, denySource);
          reply.code(DENY_STATUS[decision.code]);
          return {
            success: false,
            error: {
              code: decision.code,
              message: DENY_MESSAGE[decision.code],
            },
            metadata: errMeta(),
          };
        }

        // ---- 有 source（已通过 allowedSources 校验）----
        if (body.source) {
          const sourceName = body.source;
          const sourceDef = registry?.resolveSource(sourceName);
          // 防御：allowedSources 校验保证存在；登表校验规则 6 已防悬挂引用
          if (!sourceDef) {
            auditDenied(runtime.auditLogger, 'SOURCE_NOT_FOUND', sourceName);
            reply.code(404);
            return {
              success: false,
              error: { code: 'SOURCE_NOT_FOUND', message: DENY_MESSAGE.SOURCE_NOT_FOUND },
              metadata: errMeta(),
            };
          }
          const effective = resolveEffectivePermission(sourceDef, keyDef ?? null);
          const ctx = getAuditContext();
          if (ctx) {
            ctx.source = sourceName;
          }

          // §4.1：客户端自报权限宽于 effective → 审计 permission_ignored（password 等非权限字段不触发，用例 8）
          if (clientPermissionClaimsWider(body, effective)) {
            auditPermissionIgnored(runtime.auditLogger, sourceName);
          }

          const sessionId = await connectionManager.connect(buildSourceDbConfig(sourceDef, effective), {
            ctx,
            source: sourceName,
            principal: ctx?.principal,
            keyFingerprint: ctx?.keyFingerprint,
            effectivePermission: effective,
          });

          return {
            success: true,
            data: {
              sessionId,
              databaseType: sourceDef.type,
              connected: true,
            },
            metadata: errMeta(),
          };
        }

        // ---- 无 source：adhoc / legacy 放行 ----
        const ctx = getAuditContext();
        if (ctx) {
          ctx.source = 'adhoc';
        }
        const sessionId = await connectionManager.connect(buildAdhocDbConfig(body), {
          ctx,
          source: 'adhoc',
          principal: ctx?.principal,
          keyFingerprint: ctx?.keyFingerprint,
        });

        return {
          success: true,
          data: {
            sessionId,
            databaseType: body.type ?? 'adhoc',
            connected: true,
          },
          metadata: errMeta(),
        };
      } catch (error) {
        // 连接失败 → §6 CONNECT_FAILED 502（替换原恒 500）；AclError 按 code 映射
        const { statusCode, code, message } = classifyError(error, 'CONNECT_FAILED', 502);
        reply.code(statusCode);
        return {
          success: false,
          error: {
            code,
            message,
          },
          metadata: {
            timestamp: new Date().toISOString(),
            requestId: request.id,
          },
        };
      }
    });
  });

  /**
   * POST /api/disconnect
   * Disconnect from a database
   */
  fastify.post<{
    Body: DisconnectRequest;
    Reply: ApiResponse<DisconnectResponse>;
  }>('/api/disconnect', {
    schema: {
      body: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    return auditScope(request, async () => {
      try {
        const { sessionId } = request.body;

        // 会话归属校验（P0-4）：只有创建会话的 API key 才能断开它
        const ctx = getAuditContext();
        connectionManager.assertSessionAccess(sessionId, ctx?.keyFingerprint);

        // Disconnect from database（内含 event=disconnect 审计，用会话记录的 principal/source）
        await connectionManager.disconnect(sessionId);

        return {
          success: true,
          data: {
            disconnected: true,
          },
          metadata: {
            timestamp: new Date().toISOString(),
            requestId: request.id,
          },
        };
      } catch (error) {
        const { statusCode, code, message } = classifyError(error, 'DISCONNECTION_FAILED');
        if (code === 'SESSION_NOT_FOUND') {
          auditDenied(runtime.auditLogger, code);
        }
        reply.code(statusCode);
        return {
          success: false,
          error: {
            code,
            message,
          },
          metadata: {
            timestamp: new Date().toISOString(),
            requestId: request.id,
          },
        };
      }
    });
  });
}