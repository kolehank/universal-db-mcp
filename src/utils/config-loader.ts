/**
 * Configuration Loader
 * Unified configuration loading from multiple sources with priority:
 * CLI args > Environment variables > Config file > Defaults
 */

import { config as dotenvConfig } from 'dotenv';
import type { AppConfig, HttpConfig } from '../types/http.js';

// Load environment variables from .env file
dotenvConfig();

/**
 * Default HTTP configuration
 */
const DEFAULT_HTTP_CONFIG: HttpConfig = {
  port: 3000,
  host: '0.0.0.0',
  apiKeys: [],
  cors: {
    origins: '*',
    credentials: false,
  },
  rateLimit: {
    max: 100,
    window: '1m',
  },
  logging: {
    level: 'info',
    pretty: false,
  },
  session: {
    timeout: 3600000, // 1 hour
    cleanupInterval: 300000, // 5 minutes
  },
};

/**
 * Load configuration from environment variables
 */
export function loadFromEnv(): Partial<AppConfig> {
  const config: Partial<AppConfig> = {};

  // Mode
  if (process.env.MODE) {
    config.mode = process.env.MODE as 'mcp' | 'http';
  }

  // HTTP configuration
  if (process.env.HTTP_PORT || process.env.HTTP_HOST || process.env.API_KEYS) {
    config.http = {
      ...DEFAULT_HTTP_CONFIG,
      port: process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT, 10) : DEFAULT_HTTP_CONFIG.port,
      host: process.env.HTTP_HOST || DEFAULT_HTTP_CONFIG.host,
      apiKeys: process.env.API_KEYS ? process.env.API_KEYS.split(',').map(k => k.trim()) : [],
      cors: {
        origins: process.env.CORS_ORIGINS || DEFAULT_HTTP_CONFIG.cors.origins,
        credentials: process.env.CORS_CREDENTIALS === 'true',
      },
      rateLimit: {
        max: process.env.RATE_LIMIT_MAX ? parseInt(process.env.RATE_LIMIT_MAX, 10) : DEFAULT_HTTP_CONFIG.rateLimit.max,
        window: process.env.RATE_LIMIT_WINDOW || DEFAULT_HTTP_CONFIG.rateLimit.window,
      },
      logging: {
        level: (process.env.LOG_LEVEL as any) || DEFAULT_HTTP_CONFIG.logging.level,
        pretty: process.env.LOG_PRETTY === 'true',
      },
      session: {
        timeout: process.env.SESSION_TIMEOUT ? parseInt(process.env.SESSION_TIMEOUT, 10) : DEFAULT_HTTP_CONFIG.session.timeout,
        cleanupInterval: process.env.SESSION_CLEANUP_INTERVAL ? parseInt(process.env.SESSION_CLEANUP_INTERVAL, 10) : DEFAULT_HTTP_CONFIG.session.cleanupInterval,
      },
    };
  }

  // Database configuration (for single-connection mode)
  if (process.env.DB_TYPE) {
    config.database = {
      type: process.env.DB_TYPE as any,
      host: process.env.DB_HOST,
      port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      filePath: process.env.DB_FILE_PATH,
      allowWrite: process.env.DB_ALLOW_WRITE === 'true',
    };
  }

  return config;
}

/**
 * Merge multiple configuration objects with priority
 */
export function mergeConfigs(...configs: Partial<AppConfig>[]): AppConfig {
  const merged: AppConfig = {
    mode: 'mcp', // Default mode
  };

  for (const config of configs) {
    if (config.mode) {
      merged.mode = config.mode;
    }
    if (config.database) {
      merged.database = { ...merged.database, ...config.database };
    }
    if (config.http) {
      merged.http = { ...merged.http, ...config.http };
    }
  }

  // Ensure HTTP config exists if in HTTP mode
  if (merged.mode === 'http' && !merged.http) {
    merged.http = DEFAULT_HTTP_CONFIG;
  }

  return merged;
}

/**
 * Load complete configuration
 */
export function loadConfig(): AppConfig {
  // Load from environment variables
  const envConfig = loadFromEnv();

  // Merge with defaults
  const config = mergeConfigs(
    {
      mode: 'mcp',
      http: DEFAULT_HTTP_CONFIG,
    },
    envConfig
  );

  return config;
}

/**
 * Security 相关环境变量（规格 datasource-acl.md §3.1）
 * 本 Phase 只负责解析备用；接线在后续 Phase 完成。
 */
export interface SecurityEnvConfig {
  /** 注册表 JSON 绝对路径（HTTP 模式必填*，见 §3.1） */
  datasourceConfig?: string;
  /** ALLOW_ADHOC_CONNECTIONS：'true' 时允许客户端传连接参数 */
  allowAdhocConnections?: boolean;
  /** ADHOC_TARGET_ALLOWLIST：逗号分隔 host:port（评审裁决 §4-5） */
  adhocTargetAllowlist?: string[];
  /** AUDIT_LOG_PATH：审计 NDJSON 文件路径 */
  auditLogPath?: string;
  /** TRUST_AUDIT_USER_HEADER：true 时把 X-Audit-User 记入审计（仅审计关联，不参与授权） */
  trustAuditUserHeader?: boolean;
  /** AUDIT_REQUIRED：true 时未配置 AUDIT_LOG_PATH 直接拒绝启动（P1-9） */
  auditRequired?: boolean;
  /** AUDIT_REDACT_SQL：true 时审计前对口令类字面量脱敏（默认 true；P1-10） */
  auditRedactSql?: boolean;
}

/**
 * 解析 §3.1 安全相关环境变量。未设置的项保持 undefined 默认。
 * loadConfig/loadFromEnv 的既有字段与返回值行为不受影响。
 */
export function loadSecurityEnv(): SecurityEnvConfig {
  const config: SecurityEnvConfig = {};

  if (process.env.DATASOURCE_CONFIG) {
    config.datasourceConfig = process.env.DATASOURCE_CONFIG;
  }

  if (process.env.ALLOW_ADHOC_CONNECTIONS !== undefined) {
    config.allowAdhocConnections = process.env.ALLOW_ADHOC_CONNECTIONS === 'true';
  }

  if (process.env.ADHOC_TARGET_ALLOWLIST !== undefined) {
    config.adhocTargetAllowlist = process.env.ADHOC_TARGET_ALLOWLIST
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  if (process.env.AUDIT_LOG_PATH) {
    config.auditLogPath = process.env.AUDIT_LOG_PATH;
  }

  if (process.env.TRUST_AUDIT_USER_HEADER !== undefined) {
    config.trustAuditUserHeader = process.env.TRUST_AUDIT_USER_HEADER === 'true';
  }

  if (process.env.AUDIT_REQUIRED !== undefined) {
    config.auditRequired = process.env.AUDIT_REQUIRED === 'true';
  }

  // 默认脱敏；只有显式 AUDIT_REDACT_SQL=false 才关闭
  config.auditRedactSql = process.env.AUDIT_REDACT_SQL !== 'false';

  return config;
}

/**
 * Validate configuration
 */
export function validateConfig(config: AppConfig): void {
  if (config.mode === 'http') {
    if (!config.http) {
      throw new Error('HTTP 模式需要 HTTP 配置');
    }
    if (config.http.apiKeys.length === 0) {
      console.warn('⚠️  警告: 未配置 API Keys，建议设置 API_KEYS 环境变量');
    }
  }
}
