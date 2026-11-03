/**
 * Connection Manager
 * Manages database connections and sessions
 * Supports both single-connection (MCP) and multi-session (HTTP) modes
 */

import { nanoid } from 'nanoid';
import type { DbAdapter, DbConfig } from '../types/adapter.js';
import type { Session } from '../types/http.js';
import { createAdapter } from '../utils/adapter-factory.js';
import { DatabaseService, SchemaCacheConfig } from './database-service.js';
import type { AuditContext } from '../security/audit-context.js';
import { getAuditContext } from '../security/audit-context.js';
import type { AuditLogger, AuditRecord } from '../security/audit-logger.js';
import type { PermissionLevel } from '../security/datasource-registry.js';

/**
 * 扩展的会话接口，包含 DatabaseService 实例
 */
interface ExtendedSession extends Session {
  /** DatabaseService 实例（带缓存） */
  service: DatabaseService;
}

/** 连接选项（§5.4 连接成功时写入审计与 Session 元数据） */
export interface ConnectOptions {
  /** 审计上下文（由路由经 auditScope 携带）；提供时才写 connect 审计 */
  ctx?: AuditContext;
  /** 连接源名；adhoc 固定 'adhoc' */
  source?: string;
  /** 审计主体：注册表模式下为 apiKeys[].name */
  principal?: string;
  /** sha256(key) 前 12 位 */
  keyFingerprint?: string;
  /** §4.1 生效权限 */
  effectivePermission?: PermissionLevel;
}

/** ConnectionManager 构造选项（评审裁决 §4 注入接缝） */
export interface ConnectionManagerOptions {
  /** 适配器工厂（测试注入 mock）；缺省用真实 createAdapter */
  adapterFactory?: (config: DbConfig) => DbAdapter;
  /** 审计日志写入器（P1 起写 connect/disconnect 事件） */
  auditLogger?: AuditLogger;
}

/**
 * Connection Manager Class
 */
export class ConnectionManager {
  private sessions: Map<string, ExtendedSession> = new Map();
  private cleanupInterval?: NodeJS.Timeout;
  private sessionTimeout: number;
  private defaultCacheConfig: Partial<SchemaCacheConfig>;
  private adapterFactory: (config: DbConfig) => DbAdapter;
  private auditLogger?: AuditLogger;

  constructor(
    sessionTimeout: number = 3600000,
    cleanupInterval: number = 300000,
    defaultCacheConfig?: Partial<SchemaCacheConfig>,
    options: ConnectionManagerOptions = {}
  ) {
    this.sessionTimeout = sessionTimeout;
    this.defaultCacheConfig = defaultCacheConfig || {};
    this.adapterFactory = options.adapterFactory || createAdapter;
    this.auditLogger = options.auditLogger;

    // Start cleanup interval
    if (cleanupInterval > 0) {
      this.cleanupInterval = setInterval(() => {
        this.cleanupExpiredSessions();
      }, cleanupInterval);
    }
  }

  /**
   * Create a new connection and return session ID
   * @param opts 注册表模式下的审计/会话元数据（P1：principal/source/effectivePermission）
   */
  async connect(config: DbConfig, opts: ConnectOptions = {}): Promise<string> {
    // Create adapter
    const adapter = this.adapterFactory(config);

    // Connect to database
    await adapter.connect();

    // Generate session ID
    const sessionId = nanoid();

    // Create DatabaseService with cache support
    const service = new DatabaseService(adapter, config, this.defaultCacheConfig, undefined, this.auditLogger);

    // Store session with service
    const session: ExtendedSession = {
      id: sessionId,
      adapter,
      config,
      service,
      createdAt: new Date(),
      lastAccessedAt: new Date(),
      ...(opts.source !== undefined ? { source: opts.source } : {}),
      ...(opts.principal !== undefined ? { principal: opts.principal } : {}),
      ...(opts.keyFingerprint !== undefined ? { keyFingerprint: opts.keyFingerprint } : {}),
      ...(opts.effectivePermission !== undefined ? { effectivePermission: opts.effectivePermission } : {}),
    };

    this.sessions.set(sessionId, session);

    // 审计 event=connect（§8.2；best-effort，写失败不阻断）
    this.auditConnect(opts);

    return sessionId;
  }

  /**
   * Disconnect a session
   */
  async disconnect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`会话 ${sessionId} 不存在`);
    }

    // Clear schema cache before disconnecting
    session.service.clearSchemaCache();

    // Disconnect adapter
    await session.adapter.disconnect();

    // Remove session
    this.sessions.delete(sessionId);

    // 审计 event=disconnect（§8.2；best-effort）
    this.auditDisconnect(session);
  }

  /**
   * Get session metadata (read-only view) for a session
   * 路由用于把会话的 source/principal 重新绑定到审计上下文（§8.1「切源后不得沿用旧值」）。
   */
  getSession(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    return session;
  }

  /**
   * §7.1 例外吊销（SIGHUP 重载后）：断开一个会话，但**不写 event=disconnect**
   * （吊销专由调用方写入 event=session_revoked，避免同一关闭双记，见 http-index runReload）。
   * - 会话不存在 → 静默返回（幂等）；
   * - 断开失败 → 抛出（调用方 best-effort 处理，不阻断其余会话吊销）。
   */
  async revokeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.service.clearSchemaCache();
    await session.adapter.disconnect();
    this.sessions.delete(sessionId);
  }

  /**
   * Get adapter for a session
   */
  getAdapter(sessionId: string): DbAdapter {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`会话 ${sessionId} 不存在或已过期`);
    }

    // Update last accessed time
    session.lastAccessedAt = new Date();

    return session.adapter;
  }

  /**
   * Get database service for a session
   * Returns the cached DatabaseService instance to preserve schema cache
   */
  getService(sessionId: string): DatabaseService {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`会话 ${sessionId} 不存在或已过期`);
    }

    // Update last accessed time
    session.lastAccessedAt = new Date();

    // Return the existing service instance (preserves cache)
    return session.service;
  }

  /**
   * Check if session exists
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get session count
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get all session IDs
   */
  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Clear schema cache for a specific session
   */
  clearSessionCache(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.service.clearSchemaCache();
    }
  }

  /**
   * Clear schema cache for all sessions
   */
  clearAllCaches(): void {
    for (const session of this.sessions.values()) {
      session.service.clearSchemaCache();
    }
    console.error(`🗑️ 已清除所有会话的 Schema 缓存 (共 ${this.sessions.size} 个会话)`);
  }

  /**
   * Cleanup expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();

    for (const [sessionId, session] of this.sessions.entries()) {
      const lastAccessed = session.lastAccessedAt.getTime();
      const elapsed = now - lastAccessed;

      if (elapsed > this.sessionTimeout) {
        // Clear cache and disconnect
        session.service.clearSchemaCache();
        session.adapter.disconnect().catch((err: Error) => {
          console.error(`清理会话 ${sessionId} 时出错:`, err);
        });

        this.sessions.delete(sessionId);
        console.log(`🧹 清理过期会话: ${sessionId}`);
        // §8.2：清理过期会话断开同样记 disconnect（best-effort，不阻断）
        this.auditDisconnect(session);
      }
    }
  }

  /**
   * Disconnect all sessions and stop cleanup
   */
  async disconnectAll(): Promise<void> {
    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Clear all caches and disconnect all sessions
    const disconnectPromises = Array.from(this.sessions.values()).map(session => {
      session.service.clearSchemaCache();
      return session.adapter.disconnect().catch((err: Error) => {
        console.error(`断开会话 ${session.id} 时出错:`, err);
      });
    });

    await Promise.all(disconnectPromises);

    // Clear sessions
    this.sessions.clear();
  }

  /** §8.2 event=connect（best-effort：logger 已承诺写失败不抛出） */
  private auditConnect(opts: ConnectOptions): void {
    if (!this.auditLogger || !opts.ctx) {
      return;
    }
    this.writeAudit({ ...this.ctxFields(opts.ctx), event: 'connect', status: 'ok' });
  }

  /** §8.2 event=disconnect（best-effort） */
  private auditDisconnect(session: ExtendedSession): void {
    if (!this.auditLogger) {
      return;
    }
    const ctx = getAuditContext();
    this.writeAudit({
      event: 'disconnect',
      requestId: ctx?.requestId,
      transport: ctx?.transport,
      principal: session.principal,
      keyFingerprint: session.keyFingerprint,
      source: session.source,
      clientIp: ctx?.clientIp,
      status: 'ok',
    });
  }

  private ctxFields(ctx: AuditContext): Partial<AuditRecord> {
    return {
      requestId: ctx.requestId,
      transport: ctx.transport,
      principal: ctx.principal,
      keyFingerprint: ctx.keyFingerprint,
      source: ctx.source || undefined,
      clientIp: ctx.clientIp,
    };
  }

  private writeAudit(entry: AuditRecord): void {
    this.auditLogger?.write(entry);
  }
}
