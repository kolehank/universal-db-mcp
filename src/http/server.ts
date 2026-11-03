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
    });

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
    },
    requestIdHeader: 'x-request-id',
    trustProxy: true,
  });

  // Setup CORS
  await fastify.register(cors, {
    origin: config.http?.cors.origins || '*',
    credentials: config.http?.cors.credentials || false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-ID'],
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

  // Setup authentication middleware（P1：注册表模式 fail-closed 鉴权 + 挂载 AuditContext）
  // P5：auth 经 registryView 读到当前实例（重载后新 key 立即生效 / 已删 key 立即失效）
  fastify.addHook('onRequest', async (request, reply) => {
    await authMiddleware(request, reply, config, { registry: registryView });
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
