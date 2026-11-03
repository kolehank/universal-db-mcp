#!/usr/bin/env node

/**
 * MCP 数据库万能连接器 - MCP 模式入口
 *
 * P3（规格 §5.1）：
 * - 新增可选 `--config <path>`（数据源注册表 JSON 路径）与 `--source <name>`（注册表源名）。
 * - 只给 `--config`：注册表模式，无初始连接（等 AI 调 connect_datasource）。
 * - `--config` + `--source`：启动即连该源（§4.1 权限算法：stdio 无 key → 取 sourceMax）。
 * - `--type` 与 `--config` 同时给出 → 报错退出（ambiguous config，用例 21）。
 * - `--source` 无 `--config` → 报错退出。
 * - 版本号改读 package.json（readPackageVersion，删硬编码 '1.0.0'）。
 * - 为可测性把「由 CLI options 构造 DatabaseMCPServer」抽成可导出的 buildMcpServerFromOptions
 *   （adapterFactory 可注入，仅测试用；生产缺省 createAdapter，行为零变更）。
 * - commander .action 只做解析与打印（含现有「配置信息」打印）+ 启动 + graceful shutdown，
 *   存量 --type/--host/--port/... 行为保持逐字不变。
 */

import { Command } from 'commander';
import { DatabaseMCPServer, buildSourceDbConfig } from './mcp-server.js';
import type { DbConfig, PermissionType, PermissionMode } from '../types/adapter.js';
import type { DbAdapter } from '../types/adapter.js';
import { createAdapter, normalizeDbType } from '../utils/adapter-factory.js';
import { resolvePermissions, formatPermissions } from '../utils/safety.js';
import { loadDatasourceRegistry, resolveEffectivePermission } from '../security/datasource-registry.js';
import { readPackageVersion } from '../utils/package-version.js';

/** CLI 选项（commander 解析结果，camelCase；与 commander 选项一一对应） */
export interface McpCliOptions {
  type?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  file?: string;
  authSource?: string;
  oracleClientPath?: string;
  dangerAllowWrite?: boolean;
  permissionMode?: string;
  permissions?: string;
  /** P3 §5.1：数据源注册表 JSON 路径（与 --type 二选一） */
  config?: string;
  /** P3 §5.1：启动即连接的数据源名（需与 --config 配合） */
  source?: string;
}

/** buildMcpServerFromOptions 可注入项（仅测试注入 adapterFactory；生产缺省 createAdapter，行为不变） */
export interface BuildMcpServerOptions extends McpCliOptions {
  adapterFactory?: (config: DbConfig) => DbAdapter;
}

/** buildMcpServerFromOptions 结果（供 .action 打印/启动，测试断言） */
export interface BuildMcpServerResult {
  server: DatabaseMCPServer;
  /** legacy（--type）模式：原「配置信息」打印所需数据 */
  legacy?: {
    config: DbConfig;
    permissions: PermissionType[];
    isSafeMode: boolean;
  };
  /** 注册表（--config）模式：初始源名 */
  registry?: {
    source?: string;
  };
}

/**
 * 由 CLI options 构造 DatabaseMCPServer（P3：抽成可导出函数以便测试注入 mock adapterFactory）。
 * - 只负责解析 + 接线（setAdapter），transport 启动（server.start()）由 .action 调用，保持原启动顺序。
 * - 参数错误在此抛出：--type+--config（用例 21）、--source 无 --config。
 * - legacy（--type）路径与 2.14.0 逐字一致：normalizeDbType → resolvePermissions → setAdapter。
 * - registry（--config）路径：stdio 本地可信，principal='local'、无 key（§4.1 取 sourceMax）；
 *   `--source` 时按注册表源构造配置并 setAdapter（start() 时即连接）。
 */
export async function buildMcpServerFromOptions(options: BuildMcpServerOptions): Promise<BuildMcpServerResult> {
  const adapterFactory = options.adapterFactory ?? createAdapter;

  // P3 §5.1：--type 与 --config 互斥（用例 21）
  if (options.type && options.config) {
    throw new Error('ambiguous config: use either --type or --config');
  }
  // P3 §5.1：--source 只能在注册表模式下使用
  if (options.source && !options.config) {
    throw new Error('--source 需要配合 --config <path>（数据源注册表 JSON 路径）使用');
  }

  if (options.config) {
    // === 注册表模式（--config，可选 --source） ===
    const registry = loadDatasourceRegistry(options.config);
    const source = options.source ?? undefined;

    if (source) {
      const def = registry.resolveSource(source);
      if (!def) {
        throw new Error(`数据源注册表中不存在源 "${source}"`);
      }
      // §4.1：stdio 无 key（key 不存在 → 取 sourceMax）
      const effective = resolveEffectivePermission(def, null);
      const config = buildSourceDbConfig(def, effective);

      const server = new DatabaseMCPServer(config, {
        registry,
        principal: 'local',
        source,
        effectivePermission: effective,
        adapterFactory,
      });
      server.setAdapter(adapterFactory(config));
      return { server, registry: { source } };
    }

    const server = new DatabaseMCPServer(undefined, {
      registry,
      principal: 'local',
      adapterFactory,
    });
    return { server, registry: {} };
  }

  if (options.type) {
    // === 有初始配置：和原来完全一样的逻辑 ===
    // Normalize database type
    const dbType = normalizeDbType(options.type);

    // Parse permissions from command line
    const parsedPermissions = options.permissions
      ? options.permissions.split(',').map((p: string) => p.trim()) as PermissionType[]
      : undefined;

    // Build configuration
    const config: DbConfig = {
      type: dbType as any,
      host: options.host,
      port: options.port,
      user: options.user,
      password: options.password,
      database: options.database,
      filePath: options.file,
      allowWrite: options.dangerAllowWrite,
      permissionMode: options.dangerAllowWrite ? 'full' : options.permissionMode as PermissionMode,
      permissions: parsedPermissions,
    };

    // Add MongoDB-specific config
    if (dbType === 'mongodb' && options.authSource) {
      (config as any).authSource = options.authSource;
    }

    // Add Oracle-specific config
    if (dbType === 'oracle' && options.oracleClientPath) {
      config.oracleClientPath = options.oracleClientPath;
    }

    // Resolve permissions（供 .action 打印「配置信息」）
    const permissions = resolvePermissions(config);
    const isSafeMode = permissions.length === 1 && permissions[0] === 'read';

    // Create server
    const server = new DatabaseMCPServer(config, { adapterFactory });

    // 使用 factory 创建适配器并接线（原：const adapter = createAdapter(config); server.setAdapter(adapter)）
    server.setAdapter(adapterFactory(config));

    return { server, legacy: { config, permissions, isSafeMode } };
  }

  // === 无初始配置：无连接模式启动 ===
  const server = new DatabaseMCPServer();
  return { server };
}

/**
 * Start MCP server
 */
export async function startMcpServer(): Promise<void> {
  const program = new Command();

  program
    .name('universal-db-mcp')
    .description('MCP 数据库万能连接器 - 让 Claude Desktop 直接连接你的数据库')
    .version(readPackageVersion())
    .option('--type <type>', '数据库类型 (mysql|postgres|redis|oracle|dm|sqlserver|mssql|mongodb|sqlite|kingbase|gaussdb|opengauss|oceanbase|tidb|clickhouse|polardb|vastbase|highgo|goldendb)。不指定则以无连接模式启动，可在对话中通过 connect_database 动态连接。')
    .option('--host <host>', '数据库主机地址')
    .option('--port <port>', '数据库端口', parseInt)
    .option('--user <user>', '用户名')
    .option('--password <password>', '密码')
    .option('--database <database>', '数据库名称')
    .option('--file <file>', 'SQLite 数据库文件路径')
    .option('--auth-source <authSource>', 'MongoDB 认证数据库（默认为 admin）')
    .option('--oracle-client-path <path>', 'Oracle Instant Client 路径（启用 Thick 模式以支持 11g）')
    .option('--danger-allow-write', '启用完全写入模式（危险！等价于 --permission-mode=full）', false)
    .option('--permission-mode <mode>', '权限模式: safe(只读) | readwrite(读写不删) | full(完全控制)', 'safe')
    .option('--permissions <list>', '自定义权限列表，逗号分隔: read,insert,update,delete,ddl')
    .option('--config <path>', '数据源注册表 JSON 文件路径（注册表模式，与 --type 二选一；连接参数由服务端权威提供）')
    .option('--source <name>', '注册表模式下启动即连接的数据源名（需与 --config 配合使用）')
    .action(async (options) => {
      try {
        // 提取 graceful shutdown 逻辑为复用函数
        function setupGracefulShutdown(server: DatabaseMCPServer): void {
          let shuttingDown = false;

          async function gracefulShutdown(reason: string): Promise<void> {
            if (shuttingDown) return;
            shuttingDown = true;

            console.error(`\n⏹️  正在关闭服务器 (${reason})...`);

            try {
              await Promise.race([
                server.stop(),
                new Promise<void>((resolve) => setTimeout(() => {
                  console.error('⚠️  关闭超时，强制退出');
                  resolve();
                }, 5000)),
              ]);
            } catch (err) {
              console.error('关闭过程中出错:', err instanceof Error ? err.message : String(err));
            } finally {
              process.exit(0);
            }
          }

          // 信号处理
          process.on('SIGINT', () => gracefulShutdown('SIGINT'));
          process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

          // stdin 关闭处理（核心修复）
          // 当 MCP 客户端（如 Codex CLI）关闭 stdin 管道时触发
          process.stdin.resume();
          process.stdin.on('end', () => gracefulShutdown('stdin-end'));
          process.stdin.on('close', () => gracefulShutdown('stdin-close'));
        }

        // P3：由 CLI options 构造（含注册表加载 / adapter 接线）；参数冲突在此抛出
        const result = await buildMcpServerFromOptions(options as BuildMcpServerOptions);
        const server = result.server;

        if (result.legacy) {
          // === 有初始配置：和原来完全一样的「配置信息」打印 ===
          const { config, permissions, isSafeMode } = result.legacy;

          console.error('🔧 配置信息:');
          console.error(`   数据库类型: ${config.type}`);
          if (config.type === 'sqlite') {
            console.error(`   数据库文件: ${config.filePath}`);
          } else {
            console.error(`   主机地址: ${config.host}:${config.port}`);
            console.error(`   数据库名: ${config.database || '(默认)'}`);
          }
          console.error(`   权限模式: ${isSafeMode ? '✅ 只读模式' : '⚠️  ' + formatPermissions(permissions)}`);
          console.error('');
        } else if (result.registry) {
          // === 注册表模式：新打印 ===
          if (result.registry.source) {
            console.error(`🔧 数据源: ${result.registry.source}（注册表模式，启动即连接）`);
          } else {
            console.error('📡 注册表模式：已加载数据源注册表，等待通过 connect_datasource 工具动态连接...');
          }
          console.error('');
        } else {
          // === 无初始配置：无连接模式启动（原打印不变） ===
          console.error('📡 无连接模式：未指定数据库类型，等待通过 connect_database 工具动态连接...');
          console.error('');
        }

        // 启动（registry+source / legacy 已有 adapter → start() 会先连接，即「启动即连」）
        await server.start();

        // graceful shutdown 注册必须在 start() 之后（与存量顺序一致）
        setupGracefulShutdown(server);
      } catch (error) {
        console.error('❌ 启动失败:', error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  program.parse();
}

// If running directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer();
}