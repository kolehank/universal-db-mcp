/**
 * Authentication Middleware
 * API Key authentication for HTTP API
 *
 * P1（评审裁决 §4-1，修复 fail-open 后门）：
 * - 注册表模式（registry 已注入）：key 必须命中 registry.findKey()（API_KEYS 环境变量被忽略），
 *   解析 principal=key.name / keyFingerprint；**不再存在**「未配置 keys 即放行」分支。
 * - legacy 模式（无 registry）：保持 config.http.apiKeys.includes 既有行为（含无 keys 放行的开发模式）。
 * - health/info 白名单保持（/api/info 返回内容不含源名，见 health.ts）。
 *
 * Fastify 约束适配（规格 §8.1「auth 中间件 runWithAuditContext(ctx, next)」）：
 * Fastify 的 onRequest hook 是异步序列，run 作用域无法跨越 hook 边界包住 handler
 * （实测 `await als.run(ctx, ...)` 之后 store 已清空）。因此本中间件只负责**构造并挂载**
 * AuditContext 到 request（authenticated.auditCtx），由 `auditScope()` 在路由 handler
 * 入口 `runWithAuditContext(ctx, handler)` 包住整个请求处理 —— 效果等价于规格的中间件包裹。
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { AppConfig } from '../../types/http.js';
import type { AuditContext } from '../../security/audit-context.js';
import { runWithAuditContext } from '../../security/audit-context.js';
import { keyFingerprint } from '../../security/datasource-registry.js';
import type { DatasourceRegistry } from '../../security/datasource-registry.js';

export interface AuthMiddlewareOptions {
  /** 注册表实例；null/缺失 = legacy 模式（走 API_KEYS env 逻辑） */
  registry?: DatasourceRegistry | null;
}

/** 构造 + 校验 API key；通过则挂载审计上下文并返回它，否则直接发 401/403 并返回 undefined */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
  options: AuthMiddlewareOptions = {}
): Promise<AuditContext | undefined> {
  // Skip auth for health and info endpoints
  if (request.url === '/api/health' || request.url === '/api/info') {
    return undefined;
  }

  // Get API key from header (supports both X-API-Key and Authorization Bearer)
  const apiKey = extractApiKey(request);

  const registry = options.registry ?? null;

  if (registry !== null) {
    // 注册表模式：API_KEYS 被忽略（§3.1），必须命中注册表的 apiKeys[].key，无放行分支
    if (!apiKey) {
      reply.code(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'API key required. Provide X-API-Key header or Authorization: Bearer <key>',
        },
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: request.id,
        },
      });
      return undefined;
    }
    const keyDef = registry.findKey(apiKey);
    if (!keyDef) {
      reply.code(403).send({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Invalid API key',
        },
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: request.id,
        },
      });
      return undefined;
    }
    return mountContext(request, apiKey, keyDef.name, keyFingerprint(apiKey));
  }

  // ---- legacy 模式（无注册表）：保持现有行为 ----
  const validKeys = config.http?.apiKeys || [];

  // If no API keys configured, skip authentication (development mode)
  if (validKeys.length === 0) {
    return mountContext(request, apiKey ?? '', 'legacy', apiKey ? keyFingerprint(apiKey) : '');
  }

  if (!apiKey) {
    reply.code(401).send({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'API key required. Provide X-API-Key header or Authorization: Bearer <key>',
      },
      metadata: {
        timestamp: new Date().toISOString(),
        requestId: request.id,
      },
    });
    return undefined;
  }

  // Validate API key
  if (!validKeys.includes(apiKey)) {
    reply.code(403).send({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Invalid API key',
      },
      metadata: {
        timestamp: new Date().toISOString(),
        requestId: request.id,
      },
    });
    return undefined;
  }

  // Store API key in request for later use（legacy principal 固定 'legacy'，评审裁决 §4-7）
  return mountContext(request, apiKey, 'legacy', keyFingerprint(apiKey));
}

/**
 * 在鉴权挂载的 AuditContext 作用域内执行路由 handler。
 * runWithAuditContext 同步调用 fn，其内部全部异步操作（含 catch 后再取 getAuditContext）均持有 ctx。
 */
export async function auditScope<T>(request: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  const ctx = (request as { auditCtx?: AuditContext }).auditCtx;
  if (!ctx) {
    return fn();
  }
  return runWithAuditContext<Promise<T>>(ctx as AuditContext, () => fn());
}

function extractApiKey(request: FastifyRequest): string | null {
  const headerKey = request.headers['x-api-key'];
  const rawKey = Array.isArray(headerKey) ? headerKey[0] : headerKey;
  return (
    rawKey ||
    (request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.substring(7)
      : null)
  );
}

function mountContext(
  request: FastifyRequest,
  apiKey: string,
  principal: string,
  fingerprint: string
): AuditContext {
  (request as any).apiKey = apiKey;
  const ctx: AuditContext = {
    requestId: request.id,
    transport: 'rest',
    principal,
    keyFingerprint: fingerprint,
    // source 由路由后续确定（connect 时绑定；query 时读取会话）
    source: '',
    clientIp: request.ip,
  };
  (request as { auditCtx?: AuditContext }).auditCtx = ctx;
  return ctx;
}