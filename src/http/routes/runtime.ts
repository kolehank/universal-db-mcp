/**
 * 路由运行期上下文（由 createHttpServer 装配，注入各路由 setup 函数）
 * 避免路由直接依赖 server 内部构造过程，测试可整体替换。
 */

import type { DatasourceRegistry } from '../../security/datasource-registry.js';
import type { AuditLogger } from '../../security/audit-logger.js';
import type { SecurityEnvConfig } from '../../utils/config-loader.js';

export interface RouteRuntime {
  /** 注册表实例；null = legacy 模式 */
  registry?: DatasourceRegistry | null;
  /** 审计日志写入器；未配置 auditLogPath 时为禁用态 no-op */
  auditLogger?: AuditLogger;
  /** §3.1 安全相关环境变量（adhoc 开关/目标白名单/审计文件名/信任审计用户头） */
  securityEnv?: SecurityEnvConfig;
}