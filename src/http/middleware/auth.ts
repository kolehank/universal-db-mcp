/**
 * Authentication Middleware
 * API Key authentication for HTTP API
 *
 * P1（评审裁决 §4-1，修复 fail-open 后门）：
 * - 注册表模式（registry 已注入）：key 必须命中 registry.findKey()（API_KEYS 环境变量被忽略），
 *   解析 principal=key.name / keyFingerprint；**不再存在**「未配置 keys 即放行」分支。
 * - legacy 模式（无 registry）：仍按 config.http.apiKeys 校验；但**未配置任何 key 时拒绝所有请求**
 *   （P0-5 fail-closed，不再有开发模式放行）。
 * - health/info 白名单保持（/api/info 返回内容不含源名，见 health.ts）。
 * - P1-8：401/403 等鉴权失败写入 event=denied 审计（只记 keyFingerprint，不记明文 key）。
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
import type { AuditLogger } from '../../security/audit-logger.js';

export interface AuthMiddlewareOptions {
  /** 注册表实例；null/缺失 = legacy 模式（走 API_KEYS env 逻辑） */
  registry?: DatasourceRegistry | null;
  /** TRUST_AUDIT_USER_HEADER=true 时读取 X-Audit-User 头记入 ctx.auditUser（仅审计关联，不参与授权；默认 false 不读） */
  trustAuditUserHeader?: boolean;
  /** P1-8：鉴权失败审计写入器（缺省不写） */
  auditLogger?: AuditLogger;
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
      auditAuthFailure(options.auditLogger, request, 'UNAUTHORIZED');
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
      auditAuthFailure(options.auditLogger, request, 'FORBIDDEN', keyFingerprint(apiKey));
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
    return mountContext(request, apiKey, keyDef.name, keyFingerprint(apiKey),
      options.trustAuditUserHeader ? auditUserFromHeader(request) : undefined);
  }

  // ---- legacy 模式（无注册表）：按 API_KEYS 校验；未配置 key 时 fail-closed ----
  const validKeys = config.http?.apiKeys || [];

  // P0-5：未配置任何 API key → 拒绝所有请求（不再有开发模式放行后门）
  if (validKeys.length === 0) {
    auditAuthFailure(options.auditLogger, request, 'AUTH_NOT_CONFIGURED');
    reply.code(503).send({
      success: false,
      error: {
        code: 'AUTH_NOT_CONFIGURED',
        message: '服务端未配置 API Keys，已拒绝请求。请设置 API_KEYS 或配置 DATASOURCE_CONFIG 注册表。',
      },
      metadata: {
        timestamp: new Date().toISOString(),
        requestId: request.id,
      },
    });
    return undefined;
  }

  if (!apiKey) {
    auditAuthFailure(options.auditLogger, request, 'UNAUTHORIZED');
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
    auditAuthFailure(options.auditLogger, request, 'FORBIDDEN', keyFingerprint(apiKey));
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
  return mountContext(request, apiKey, 'legacy', keyFingerprint(apiKey),
    options.trustAuditUserHeader ? auditUserFromHeader(request) : undefined);
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

function auditUserFromHeader(request: FastifyRequest): string | undefined {
  const value = request.headers['x-audit-user'];
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function mountContext(
  request: FastifyRequest,
  apiKey: string,
  principal: string,
  fingerprint: string,
  auditUser?: string
): AuditContext {  (request as any).apiKey = apiKey;
  const ctx: AuditContext = {
    requestId: request.id,
    transport: 'rest',
    principal,
    keyFingerprint: fingerprint,
    // source 由路由后续确定（connect 时绑定；query 时读取会话）
    source: '',
    clientIp: request.ip,
  };
  if (auditUser) {
    ctx.auditUser = auditUser;
  }
  (request as { auditCtx?: AuditContext }).auditCtx = ctx;
  return ctx;
}

/**
 * P1-8：鉴权失败审计（best-effort）。
 * - 只记录 keyFingerprint（sha256 前 12 位），绝不记录明文 key；
 * - 此时尚未建立 AuditContext（请求未通过鉴权），因此直接构造最小记录。
 */
function auditAuthFailure(
  logger: AuditLogger | undefined,
  request: FastifyRequest,
  errorCode: string,
  fingerprint?: string
): void {
  if (!logger) {
    return;
  }
  logger.write({
    event: 'denied',
    requestId: request.id,
    transport: 'rest',
    principal: 'anonymous',
    keyFingerprint: fingerprint,
    clientIp: request.ip,
    status: 'denied',
    errorCode,
  });
}