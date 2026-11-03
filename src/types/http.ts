/**
 * HTTP API Type Definitions
 * Types specific to HTTP API mode
 */

import type { DbConfig } from './adapter.js';
import type { PermissionLevel } from '../security/datasource-registry.js';
import type { AuditContext } from '../security/audit-context.js';

/**
 * HTTP Server Configuration
 */
export interface HttpConfig {
  port: number;
  host: string;
  apiKeys: string[];
  cors: CorsConfig;
  rateLimit: RateLimitConfig;
  logging: LoggingConfig;
  session: SessionConfig;
}

/**
 * CORS Configuration
 */
export interface CorsConfig {
  origins: string | string[];
  credentials: boolean;
}

/**
 * Rate Limiting Configuration
 */
export interface RateLimitConfig {
  max: number;
  window: string;
}

/**
 * Logging Configuration
 */
export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  pretty: boolean;
}

/**
 * Session Configuration
 */
export interface SessionConfig {
  timeout: number;
  cleanupInterval: number;
}

/**
 * Application Configuration
 */
export interface AppConfig {
  mode: 'mcp' | 'http';
  database?: DbConfig;
  http?: HttpConfig;
}

/**
 * Connect Request（§5.4：source 存在时忽略其余连接字段，required 由 ['type'] 改为 []）
 */
export interface ConnectRequest {
  /** 注册表源名；存在时 body 其余连接字段被忽略 */
  source?: string;
  type?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  filePath?: string;
  authSource?: string;
  allowWrite?: boolean;
  /** 权限声明（服务端权威，宽于生效权限时仅审计 permission_ignored，不参与授权） */
  permissionMode?: string;
  permissions?: string[];
  /** Oracle Instant Client 路径（启用 Thick 模式以支持 11g） */
  oracleClientPath?: string;
}

/**
 * Connect Response
 */
export interface ConnectResponse {
  sessionId: string;
  databaseType: string;
  connected: boolean;
}

/**
 * Disconnect Request
 */
export interface DisconnectRequest {
  sessionId: string;
}

/**
 * Disconnect Response
 */
export interface DisconnectResponse {
  disconnected: boolean;
}

/**
 * Query Request
 */
export interface QueryRequest {
  sessionId: string;
  query: string;
  params?: unknown[];
}

/**
 * Execute Request (for write operations)
 */
export interface ExecuteRequest {
  sessionId: string;
  query: string;
  params?: unknown[];
}

/**
 * Tables Request
 */
export interface TablesRequest {
  sessionId: string;
}

/**
 * Tables Response
 */
export interface TablesResponse {
  tables: string[];
}

/**
 * Schema Request
 */
export interface SchemaRequest {
  sessionId: string;
  tableName?: string;
}

/**
 * API Error
 */
export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Response Metadata
 */
export interface ResponseMetadata {
  executionTime?: number;
  timestamp: string;
  requestId: string;
}

/**
 * Generic API Response
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  metadata?: ResponseMetadata;
}

/**
 * Health Response
 */
export interface HealthResponse {
  status: 'healthy' | 'unhealthy';
  uptime: number;
  timestamp: string;
}

/**
 * Info Response
 */
export interface InfoResponse {
  name: string;
  version: string;
  mode: string;
  supportedDatabases: string[];
}

/**
 * Session
 * 鉴权/ACL 元数据（评审裁决 §4-9）：连接时由 connection-manager 写入，供审计与切源校验使用。
 */
export interface Session {
  id: string;
  adapter: any;
  config: DbConfig;
  createdAt: Date;
  lastAccessedAt: Date;
  /** 审计主体：注册表模式为 apiKeys[].name；legacy 固定 'legacy' */
  principal?: string;
  /** sha256(key) 前 12 位，禁止明文 key */
  keyFingerprint?: string;
  /** 连接源名；adhoc 固定 'adhoc' */
  source?: string;
  /** §4.1 生效权限 min(sourceMax ?? safe, keyMax ?? full) */
  effectivePermission?: PermissionLevel;
}

/**
 * HTTP Query Result (rows as JSON string for Coze compatibility)
 */
export interface HttpQueryResult {
  /** 查询返回的行数据（JSON字符串格式） */
  rows: string;
  /** 受影响的行数（用于 INSERT/UPDATE/DELETE） */
  affectedRows?: number;
  /** 执行时间（毫秒） */
  executionTime?: number;
  /** 额外的元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * Fastify Request with API Key
 */
export interface AuthenticatedRequest {
  apiKey?: string;
  /** 鉴权通过后由 auth 中间件挂载的审计上下文（routes 经 auditScope 进入其作用域） */
  auditCtx?: AuditContext;
}
