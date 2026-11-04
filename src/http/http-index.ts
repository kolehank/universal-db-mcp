/**
 * HTTP Server Entry Point
 * Starts the HTTP API server
 *
 * P5（规格 §7.1 SIGHUP 热加载 + 会话快照/吊销，用例 25-29）：
 * - createReloadHandler / runReload：可导出的纯函数式重载执行体（供集成测试直调，Windows 无 SIGHUP）。
 * - reload 语义：完整读取 + 与启动同一套 buildRegistryFromRaw 校验管线（${ENV:} 重新展开）；
 *   全部通过 → 原子替换 registryHolder.current → 逐会话吊销 → 审计 config_reload；
 *   任一错误 → 保留旧配置 + ERROR 日志 + 进程不退出（用例 27）。
 * - 防重入：重载进行中再收到 SIGHUP → 忽略 + WARN，不排队（防止连续 kill 风暴）。
 * - 会话吊销（§7.1 例外）：key 已删除 → key_revoked；源从 key 的 allowedSources 移除 →
 *   source_revoked；源从注册表删除 → source_removed。吊销不影响其他 key/源的会话（用例 26）。
 * - 仅 HTTP 模式注册 SIGHUP（只在本文件 startHttpServer 内）；stdio/mcp-index 不注册（用例 29）。
 * - 审计：config_reload（含配置文件 sha256、源/key 数量、被关闭会话数）、session_revoked（reason 明确）。
 */

import type { AppConfig } from '../types/http.js';
import { createHttpServer } from './server.js';
import { loadSecurityEnv } from '../utils/config-loader.js';
import { getMcpSessionSnapshot, cleanupSession } from './routes/mcp-sse.js';
import type { McpSessionMeta } from './routes/mcp-sse.js';
import type { ConnectionManager } from '../core/connection-manager.js';
import type { AuditLogger } from '../security/audit-logger.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatasourceRegistry, RegistryHolder } from '../security/datasource-registry.js';

/**
 * fail-closed 启动判定（用例 1）：
 * 无 DATASOURCE_CONFIG 且 ALLOW_ADHOC_CONNECTIONS 不为 'true' → 拒绝启动（退出码 1）。
 * 纯函数、无副作用，便于单元测试。
 */
export function shouldFailClosedHttpStart(
  datasourceConfigPath: string | undefined,
  allowAdhocConnections: boolean | undefined
): boolean {
  return !datasourceConfigPath && allowAdhocConnections !== true;
}

/** §7.1 例外吊销原因 */
export type SessionRevocationReason = 'key_revoked' | 'source_revoked' | 'source_removed';

/** session_revoked 审计所需的会话身份字段 */
export interface SessionRevocationItem {
  kind: 'mcp' | 'rest';
  sessionId: string;
  principal?: string;
  keyFingerprint: string;
  source: string | null;
  reason: SessionRevocationReason;
  transport?: 'sse' | 'streamable' | 'rest';
}

/** createReloadHandler / runReload 依赖注入（集成测试直调时自行组装） */
export interface ReloadHandlerDeps {
  /** 注册表可变引用承载；重载成功后原子替换 holder.current */
  registryHolder: RegistryHolder;
  /** 当前所有 MCP 会话快照（mcp-sse getMcpSessionSnapshot） */
  getMcpSessions: () => ReadonlyArray<McpSessionMeta>;
  /** 关闭单个 MCP 会话（mcp-sse cleanupSession；测试可注入假实现） */
  closeMcpSession: (sessionId: string) => Promise<void>;
  /** REST 会话管理器（roster 快照 + revokeSession） */
  connectionManager: ConnectionManager;
  /** 审计日志写入器（未注入则 config_reload/session_revoked 不落盘） */
  auditLogger?: AuditLogger;
  /** 注册表文件路径；缺省取 registryHolder.current.configPath（测试可显式注入） */
  configPath?: string;
  /** ERROR 出口；缺省 console.error（测试注入 spy 断言用例 27） */
  logError?: (msg: string) => void;
  /** WARN 出口；缺省 console.warn（测试断言防重入） */
  logWarn?: (msg: string) => void;
}

/** runReload 结果（成功含 config_reload 审计所需统计；失败含错误信息） */
export type ReloadResult =
  | { ok: true; configSha256: string; sourceCount: number; keyCount: number; closedSessions: number }
  | { ok: false; error: string };

/**
 * §7.1 防重入包装：
 * 重载进行中再次触发 → 忽略 + WARN，不排队（连续 kill 不造成重载风暴）。
 * 返回一个「可被 process.on('SIGHUP', ...) 或测试直调」的无参 async 函数。
 */
export function createReloadHandler(deps: ReloadHandlerDeps): () => Promise<ReloadResult> {
  const warn = deps.logWarn ?? ((msg: string) => console.warn(msg));
  let running = false;
  return async () => {
    if (running) {
      warn('⚠️ SIGHUP 配置重载正在进行，忽略本次请求（防重入，不排队）');
      return { ok: false, error: 'reload-in-progress' };
    }
    running = true;
    try {
      return await runReload(deps);
    } finally {
      running = false;
    }
  };
}

/**
 * §7.1 重载执行体（纯函数，可直调）：
 * 1. 完整读取 + 校验新配置（buildRegistryFromRaw 同一套校验、${ENV:} 重新展开）→ 失败：ERROR + 旧配置不变；
 * 2. 逐会话吊销判定（旧/新实例比对）；
 * 3. 原子替换 registryHolder.current（先替换再关闭，关闭期间新请求已用新配置）；
 * 4. 关闭被吊销会话 + 逐条审计 session_revoked（best-effort，单会话失败不阻断）；
 * 5. 审计 config_reload（配置文件 sha256、源/key 数量、被关闭会话数）。
 */
export async function runReload(deps: ReloadHandlerDeps): Promise<ReloadResult> {
  const logError = deps.logError ?? ((msg: string) => console.error(msg));
  const oldRegistry = deps.registryHolder.current;
  const configPath = deps.configPath ?? oldRegistry.configPath;

  // 1. 完整加载 + 校验：任一错误 → 保留旧配置、进程不退出（用例 27）
  let nextRegistry: DatasourceRegistry;
  try {
    nextRegistry = oldRegistry.reload(configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`❌ SIGHUP 配置重载失败，保留旧配置继续服务: ${message}`);
    return { ok: false, error: message };
  }

  // 2. 逐会话吊销判定（只在替换前计算；命中列表不受关闭顺序影响）
  const decisions: SessionRevocationItem[] = collectRevocations(deps, oldRegistry, nextRegistry);

  // 3. 原子替换引用（新会话立即使用新配置；旧实例/已建会话保持快照）
  deps.registryHolder.current = nextRegistry;

  // 4. 关闭被吊销会话 + 审计 session_revoked
  let closedSessions = 0;
  for (const item of decisions) {
    try {
      if (item.kind === 'mcp') {
        await deps.closeMcpSession(item.sessionId);
      } else {
        await deps.connectionManager.revokeSession(item.sessionId);
      }
      closedSessions += 1;
    } catch (error) {
      logError(`吊销会话 ${item.sessionId} 失败（best-effort 继续）: ${error instanceof Error ? error.message : String(error)}`);
    }
    deps.auditLogger?.write({
      event: 'session_revoked',
      status: 'revoked',
      errorCode: item.reason,
      sessionId: item.sessionId,
      reason: item.reason,
      principal: item.principal,
      keyFingerprint: item.keyFingerprint,
      source: item.source ?? undefined,
      transport: item.transport,
    });
  }

  // 5. 审计 config_reload（native 字段：configSha256 / sourceCount / keyCount / closedSessions）
  const configSha256 = sha256OfFile(configPath);
  const sourceCount = nextRegistry.sources.length;
  const keyCount = nextRegistry.apiKeys.length;
  deps.auditLogger?.write({
    event: 'config_reload',
    status: 'ok',
    principal: 'system',
    configSha256,
    sourceCount,
    keyCount,
    closedSessions,
  });

  console.error(`✅ SIGHUP 配置重载成功（${configPath}），关闭 ${closedSessions} 个被吊销会话`);
  return { ok: true, configSha256, sourceCount, keyCount, closedSessions };
}

/**
 * §7.1 例外吊销判定（纯函数，可单测）：
 * - keyFingerprint 为空 / 旧注册表无此 key（legacy/adhoc 会话）→ 不吊销；
 * - 新注册表按 fingerprint 找不到 key → key_revoked；
 * - 会话当前源不在新注册表 → source_removed；
 * - 会话当前源不在该 key 的 allowedSources → source_revoked；
 * - 其余 → 不吊销。
 */
export function revocationReasonFor(
  keyFingerprint: string,
  source: string | null,
  oldRegistry: DatasourceRegistry | null,
  nextRegistry: DatasourceRegistry | null
): SessionRevocationReason | null {
  if (!keyFingerprint || !oldRegistry || !nextRegistry) {
    return null;
  }
  const oldKey = oldRegistry.getKeyByFingerprint(keyFingerprint);
  if (!oldKey) {
    // 会话不属于旧注册表（如 legacy 会话的 fingerprint 从不在注册表中）→ 吊销不适用
    return null;
  }
  const nextKey = nextRegistry.getKeyByFingerprint(keyFingerprint);
  if (!nextKey) {
    return 'key_revoked';
  }
  if (!source || source === 'adhoc') {
    return null;
  }
  if (!nextRegistry.resolveSource(source)) {
    return 'source_removed';
  }
  if (!(nextKey.allowedSources ?? []).includes(source)) {
    return 'source_revoked';
  }
  return null;
}

/** 收集需要吊销的 MCP + REST 会话（MCP 由 snapshot 遍历；REST 由 ConnectionManager 会话快照遍历） */
function collectRevocations(
  deps: ReloadHandlerDeps,
  oldRegistry: DatasourceRegistry,
  nextRegistry: DatasourceRegistry
): SessionRevocationItem[] {
  const decisions: SessionRevocationItem[] = [];

  for (const session of deps.getMcpSessions()) {
    const reason = revocationReasonFor(session.keyFingerprint, session.source, oldRegistry, nextRegistry);
    if (reason !== null) {
      decisions.push({
        kind: 'mcp',
        sessionId: session.sessionId,
        principal: session.principal,
        keyFingerprint: session.keyFingerprint,
        source: session.source,
        reason,
        transport: session.transport,
      });
    }
  }

  for (const sessionId of deps.connectionManager.getSessionIds()) {
    const session = deps.connectionManager.getSession(sessionId);
    if (!session) {
      continue;
    }
    const reason = revocationReasonFor(
      session.keyFingerprint ?? '',
      session.source ?? null,
      oldRegistry,
      nextRegistry
    );
    if (reason !== null) {
      decisions.push({
        kind: 'rest',
        sessionId,
        principal: session.principal,
        keyFingerprint: session.keyFingerprint ?? '',
        source: session.source ?? null,
        reason,
        transport: 'rest',
      });
    }
  }

  return decisions;
}

/** 配置文件 sha256（hex 小写；读取失败返回空串，best-effort） */
function sha256OfFile(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path, 'utf-8')).digest('hex');
  } catch {
    return '';
  }
}

/** 模块级注册状态（供测试断言「仅 HTTP 模式注册」，用例 29） */
let sighupRegistered = false;

/** 是否已注册过 SIGHUP 处理器（仅 HTTP 模式经 startHttpServer 调 registerHttpSighup 置位） */
export function isSighupRegistered(): boolean {
  return sighupRegistered;
}

/**
 * §7.1：注册 SIGHUP 处理器（仅 HTTP 模式下由 startHttpServer 调用；stdio/mcp-index 不调用）。
 * 返回解除注册函数。Windows 下 Node 不派发 SIGHUP（注册无副作用），
 * 用例 25-28 在集成测试直调 runReload/createReloadHandler 覆盖；用例 29 以
 * “注册只发生在 HTTP 模式（本函数）+ mcp-index 无任何 SIGHUP” 的断言覆盖。
 */
export function registerHttpSighup(deps: ReloadHandlerDeps): () => void {
  const handler = createReloadHandler(deps);
  process.on('SIGHUP', handler);
  sighupRegistered = true;
  return () => {
    process.off('SIGHUP', handler);
    sighupRegistered = false;
  };
}

/** startHttpServer 附加装饰（createHttpServer 挂载在 fastify 实例上） */
interface HttpServerExtras {
  connectionManager: ConnectionManager;
  auditLogger?: AuditLogger;
  registryHolder?: RegistryHolder | null;
}

/**
 * Start HTTP server
 */
export async function startHttpServer(config: AppConfig): Promise<void> {
  // fail-closed（仅 HTTP 模式生效）：无注册表且未显式开启 adhoc → 拒绝启动
  const securityEnv = loadSecurityEnv();
  if (shouldFailClosedHttpStart(securityEnv.datasourceConfig, securityEnv.allowAdhocConnections)) {
    console.error(
      '❌ Failed to start HTTP server (fail-closed): DATASOURCE_CONFIG is not set ' +
        'and ALLOW_ADHOC_CONNECTIONS is not "true". Refusing to start without a datasource registry.'
    );
    process.exit(1);
  }

  try {
    // Create server
    const server = await createHttpServer(config);
    const extras = server as unknown as HttpServerExtras;

    // §7.1：仅 HTTP 模式注册 SIGHUP 热加载（注册表模式；legacy 无 registry 不注册）。
    // SIGHUP 只在本文件注册——mcp-index（stdio）不注册，保持“终端挂断即退出”的默认语义（用例 29）。
    if (extras.registryHolder) {
      registerHttpSighup({
        registryHolder: extras.registryHolder,
        getMcpSessions: getMcpSessionSnapshot,
        closeMcpSession: cleanupSession,
        connectionManager: extras.connectionManager,
        auditLogger: extras.auditLogger,
        configPath: extras.registryHolder.current.configPath,
      });
    } else {
      console.error('⚠️ 未配置数据源注册表（legacy 模式），不注册 SIGHUP 热加载');
    }

    // Get configuration
    const port = config.http?.port || 3000;
    const host = config.http?.host || '0.0.0.0';

    // Start listening
    await server.listen({ port, host });

    console.log('');
    console.log('🚀 HTTP API Server started successfully!');
    console.log('');
    console.log(`📍 Server URL: http://${host}:${port}`);
    console.log(`📊 Supported databases: 17 types`);
    console.log(`🛡️  Security: API Key authentication ${config.http?.apiKeys.length ? 'enabled' : 'disabled (WARNING!)'}`);
    console.log(`⚡ Rate limiting: ${config.http?.rateLimit.max} requests per ${config.http?.rateLimit.window}`);
    console.log('');
    console.log('📖 API Endpoints:');
    console.log('   GET  /api/health          - Health check');
    console.log('   GET  /api/info            - Service information');
    console.log('   POST /api/connect         - Connect to database');
    console.log('   POST /api/disconnect      - Disconnect from database');
    console.log('   POST /api/query           - Execute query');
    console.log('   POST /api/execute         - Execute write operation');
    console.log('   GET  /api/tables          - List tables');
    console.log('   GET  /api/schema          - Get database schema');
    console.log('   GET  /api/schema/:table   - Get table information');
    console.log('');

    // Graceful shutdown
    const signals = ['SIGINT', 'SIGTERM'];
    signals.forEach(signal => {
      process.on(signal, async () => {
        console.log(`\n⏹️  Received ${signal}, shutting down gracefully...`);
        await server.close();
        console.log('👋 Server closed');
        process.exit(0);
      });
    });

  } catch (error) {
    console.error('❌ Failed to start HTTP server:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}