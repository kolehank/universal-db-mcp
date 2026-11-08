/**
 * HTTP Server Setup
 * Fastify server configuration with middleware and routes
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from '../types/http.js';
import type { DbAdapter, DbConfig } from '../types/adapter.js';
import { ConnectionManager } from '../core/connection-manager.js';
import { authMiddleware, setupErrorHandler } from './middleware/index.js';
import { setupRoutes } from './routes/index.js';
import { loadDatasourceRegistry, createRegistryView } from '../security/datasource-registry.js';
import type { DatasourceRegistry, RegistryHolder } from '../security/datasource-registry.js';
import { AuditLogger } from '../security/audit-logger.js';
import { loadSecurityEnv } from '../utils/config-loader.js';
import type { SecurityEnvConfig } from '../utils/config-loader.js';
import { redactUrl } from '../utils/redact.js';

/**
 * createHttpServer 注入选项（仅测试用；生产不传，走环境变量）
 * - registry：测试注入注册表实例；缺省时按 DATASOURCE_CONFIG 从文件加载（失败即启动失败，fail-closed）。
 * - adapterFactory：测试注入 mock 适配器工厂（评审裁决 §4-6/9 的合理实现）。
 * - auditLogger / securityEnv：测试注入；缺省从 loadSecurityEnv() 构造。
 */
export interface CreateHttpServerOptions {
  registry?: DatasourceRegistry | null;
  adapterFactory?: (config: DbConfig) => DbAdapter;
  auditLogger?: AuditLogger;
  securityEnv?: SecurityEnvConfig;
}

/**
 * Create and configure HTTP server
 * @param options 仅测试用注入点；生产从环境变量自动构造注册表与审计日志器。
 */
export async function createHttpServer(config: AppConfig, options: CreateHttpServerOptions = {}) {
  const securityEnv = options.securityEnv ?? loadSecurityEnv();

  // 注册表：测试注入优先；生产从 DATASOURCE_CONFIG 加载。
  // §3.1 fail-closed：路径不存在 / 加载失败 → 抛错（错误信息含原因）→ 由 startHttpServer 捕获后 exit 1。
  let registry: DatasourceRegistry | null = null;
  if (options.registry !== undefined) {
    registry = options.registry;
  } else if (securityEnv.datasourceConfig) {
    registry = loadDatasourceRegistry(securityEnv.datasourceConfig);
  }

  // P5 评审裁决 9：注册表引用可被原子替换。
  // - holder：SIGHUP 重载成功后 `holder.current = 新实例`（http-index 持有并替换）；
  // - registryView：委托当前实例的实时视图，注入 auth/routes/mcp-sse（它们在 setup 时捕获引用），
  //   新请求经视图读到的始终是 holder.current——新会话用新配置、旧会话持旧实例快照。
  let registryHolder: RegistryHolder | null = null;
  let registryView: DatasourceRegistry | null = null;
  if (registry !== null) {
    registryHolder = { current: registry };
    registryView = createRegistryView(registryHolder);
  }

  // 审计日志器：未配置 AUDIT_LOG_PATH 时进入禁用态（启动 WARN），不影响任何流程（§3.1/§8.2）
  const auditLogger =
    options.auditLogger ??
    new AuditLogger({
      auditLogPath: securityEnv.auditLogPath,
      trustAuditUserHeader: securityEnv.trustAuditUserHeader,
      redactSensitiveSql: securityEnv.auditRedactSql,
    });

  // P0-5 fail-closed（所有入口统一，含 serverless：它们直接调用 createHttpServer）：
  // 1) 未配置注册表时，必须至少配置 API_KEYS，否则无人能通过鉴权；
  // 2) 未配置注册表（legacy/adhoc 模式）时，必须显式开启 ALLOW_ADHOC_CONNECTIONS，
  //    否则客户端可任意指定连接目标。
  const legacyApiKeys = config.http?.apiKeys ?? [];
  if (registry === null) {
    if (legacyApiKeys.length === 0) {
      throw new Error(
        '拒绝启动 HTTP 服务（fail-closed）：未配置数据源注册表（DATASOURCE_CONFIG），且 API_KEYS 为空。' +
          '请配置 DATASOURCE_CONFIG，或至少设置 API_KEYS。'
      );
    }
    if (securityEnv.allowAdhocConnections !== true) {
      throw new Error(
        '拒绝启动 HTTP 服务（fail-closed）：未配置数据源注册表（DATASOURCE_CONFIG），' +
          '且未显式开启 ALLOW_ADHOC_CONNECTIONS=true。'
      );
    }
  }

  // P1-9：显式要求审计时，未配置审计路径直接拒绝启动（生产/等保场景）
  if (securityEnv.auditRequired === true && !auditLogger.isEnabled) {
    throw new Error(
      '拒绝启动 HTTP 服务（fail-closed）：AUDIT_REQUIRED=true 但未配置 AUDIT_LOG_PATH。'
    );
  }

  // Create Fastify instance
  const fastify = Fastify({
    logger: {
      level: config.http?.logging.level || 'info',
      transport: config.http?.logging.pretty
        ? {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
      // P0-6：访问日志中的 URL query 做脱敏（口令/密钥参数 → ***）
      serializers: {
        req(request: { method?: string; url?: string; remoteAddress?: string; remotePort?: number }) {
          return {
            method: request.method,
            url: request.url ? redactUrl(request.url) : request.url,
            remoteAddress: request.remoteAddress,
            remotePort: request.remotePort,
          };
        },
      },
    },
    requestIdHeader: 'x-request-id',
    trustProxy: true,
  });

  // Setup CORS
  await fastify.register(cors, {
    origin: config.http?.cors.origins || '*',
    credentials: config.http?.cors.credentials || false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type', 'Authorization', 'X-API-Key', 'X-Request-ID',
      // 3.0：Streamable HTTP / SSE 的数据库源与审计归因头（评审裁决 §4-8）：
      'X-DB-Source', 'X-DB-Type', 'X-DB-Host', 'X-DB-Port', 'X-DB-User', 'X-DB-Password',
      'X-DB-Database', 'X-DB-FilePath', 'X-DB-Allow-Write', 'X-DB-Permission-Mode',
      'X-DB-Permissions', 'X-DB-Oracle-Client-Path', 'X-Audit-User',
    ],
  });

  // Setup rate limiting
  await fastify.register(rateLimit, {
    max: config.http?.rateLimit.max || 100,
    timeWindow: config.http?.rateLimit.window || '1m',
    keyGenerator: (request) => {
      // Use API key if available, otherwise use IP
      return (request as any).apiKey || request.ip;
    },
    errorResponseBuilder: (request) => ({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests, please try again later',
      },
      metadata: {
        timestamp: new Date().toISOString(),
        requestId: request.id,
      },
    }),
  });

  // Setup authentication middleware（P1：注册表模式 fail-closed 鉴权 + 挂载 AuditContext；
  // P5：auth 经 registryView 读到当前实例（重载后新 key 立即生效 / 已删 key 立即失效）；
  // P6 收尾：TRUST_AUDIT_USER_HEADER=true 时读 X-Audit-User 头（仅审计关联，不参与授权））
  fastify.addHook('onRequest', async (request, reply) => {
    await authMiddleware(request, reply, config, {
      registry: registryView,
      trustAuditUserHeader: securityEnv.trustAuditUserHeader,
      auditLogger,
    });
  });

  // Create connection manager（注入 mock adapter factory / 审计日志器）
  const connectionManager = new ConnectionManager(
    config.http?.session.timeout || 3600000,
    config.http?.session.cleanupInterval || 300000,
    undefined,
    { adapterFactory: options.adapterFactory, auditLogger }
  );

  // Store connection manager in fastify instance for access in routes
  fastify.decorate('connectionManager', connectionManager);

  // P5：暴露注册表 holder 与审计日志器（http-index SIGHUP reload handler 使用）。
  // legacy 模式（registry 为 null）不装饰 holder → 不注册 SIGHUP（§7.1 仅注册表模式热更新）。
  if (registryHolder !== null) {
    fastify.decorate('registryHolder', registryHolder);
  }
  fastify.decorate('auditLogger', auditLogger);

  // Setup routes（注入 registryView / 审计日志器 / 安全环境变量 / 适配器工厂）
  await setupRoutes(fastify, connectionManager, {
    registry: registryView,
    auditLogger,
    securityEnv,
    adapterFactory: options.adapterFactory,
  });

  // Setup error handler
  setupErrorHandler(fastify);

  // Graceful shutdown handler
  fastify.addHook('onClose', async () => {
    await connectionManager.disconnectAll();
  });

  return fastify;
}
