#!/usr/bin/env node

/**
 * MCP 数据库万能连接器 - 主服务器
 * 通过 Model Context Protocol 让 Claude Desktop 连接数据库
 *
 * P2（规格 §9 toolProfile + §8.1 审计上下文重绑）：
 * - 构造参数扩展为 `new DatabaseMCPServer(config?, opts?)`：
 *   opts.registry / opts.isRemote / opts.key / opts.principal / opts.keyFingerprint /
 *   opts.auditLogger / opts.adapterFactory / opts.adhocTargetAllowlist / opts.source。
 * - toolProfile 四态（评审裁决 4：二维布尔 (registryEnabled, isRemote) 推导，行为按 §9 表格 4 行）：
 *   legacy-stdio（stdio 无 registry）        ：现有工具集 + connect_database（原始参数，行为同 2.14.0）
 *   legacy-remote（远程无 registry + adhoc） ：现有工具集 + connect_database 目标必须命中 adhocTargetAllowlist
 *   registry-stdio（stdio 有 registry）      ：查询类 + clear_cache + get_connection_status +
 *                                              connect_datasource + list_datasources + disconnect_database（不含 connect_database）
 *   registry-remote（远程有 registry）       ：同 registry-stdio，但 connect_datasource/list_datasources
 *                                              受该 key 的 allowedSources 约束
 * - 每次工具调用入口按会话「当前源」重绑审计上下文（§8.1：切源后不得沿用 initialize 值，用例 14a）。
 * - 审计接线（本 phase）：event=connect（connect_datasource 切源）、event=disconnect（disconnect_database）、
 *   event=denied（connect_datasource 无权/不存在、connect_database 目标不在白名单、写权限拒绝）。
 *   query/metadata 记录点留待 P4b（调用路径已按次重绑 source，P4b 直接写）。
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { randomUUID } from 'node:crypto';
import type { DbAdapter, DbConfig } from '../types/adapter.js';
import { DatabaseService, SchemaCacheConfig } from '../core/database-service.js';
import { createAdapter, normalizeDbType } from '../utils/adapter-factory.js';
import { readPackageVersion } from '../utils/package-version.js';
import { isAdhocAllowed, resolveEffectivePermission } from '../security/datasource-registry.js';
import type { ApiKeyDef, DatasourceDef, DatasourceRegistry, PermissionLevel } from '../security/datasource-registry.js';
import type { AuditContext } from '../security/audit-context.js';
import { getAuditContext, runWithAuditContext } from '../security/audit-context.js';
import type { AuditLogger, AuditRecord } from '../security/audit-logger.js';
import { auditDenied } from '../http/audit.js';
import { AclError } from '../security/errors.js';

/** 文档枚举（评审裁决 4：仅作文档描述，行为由 (registryEnabled, isRemote) 推导出四态） */
export type DatabaseMcpToolProfile = 'legacy' | 'registry-stdio' | 'remote';

/** 内部四态 */
type ResolvedToolProfile = 'legacy-stdio' | 'legacy-remote' | 'registry-stdio' | 'registry-remote';

/** DatabaseMCPServer 构造选项（P2） */
export interface DatabaseMCPServerOptions {
  /** 数据源注册表；提供 = registry 模式（四态中的 registry-stdio/registry-remote） */
  registry?: DatasourceRegistry | null;
  /** 远程会话（SSE/Streamable HTTP）为 true；stdio 缺省 false */
  isRemote?: boolean;
  /** 远程会话已解析的 API key（allowedSources 用于 connect_datasource/list_datasources 判定，maxPermission 参与 §4.1）；stdio 无 key */
  key?: ApiKeyDef | null;
  /** 审计主体：注册表模式 apiKeys[].name；stdio 固定 'local'；legacy 固定 'legacy' */
  principal?: string;
  /** sha256(key) 前 12 位（禁止明文 key 入审计） */
  keyFingerprint?: string;
  /** 审计日志写入器（未注入则相关审计事件不落盘） */
  auditLogger?: AuditLogger;
  /** 适配器工厂（测试注入 mock；缺省用真实 createAdapter） */
  adapterFactory?: (config: DbConfig) => DbAdapter;
  /** Schema 缓存配置（原第二参数语义；挪入 opts.cacheConfig） */
  cacheConfig?: Partial<SchemaCacheConfig>;
  /** legacy-remote 的 adhoc 目标白名单（host:port 精确匹配；空 = 不限制，legacy 行为） */
  adhocTargetAllowlist?: string[];
  /** 初始连接源名（远程会话由 mcp-sse 绑定；adhoc 固定 'adhoc'；stdio 初始连接由 P3 绑定） */
  source?: string | null;
  /** 初始生效权限（§4.1；registry 会话由 mcp-sse 绑定） */
  effectivePermission?: PermissionLevel;
}

/**
 * 注册表源 → 服务端权威 DbConfig（§4.1：permissionMode 填 effective 预设名；客户端其余连接字段一律不接收）
 * 导出供 stdio 入口（mcp-index buildMcpServerFromOptions --config+--source）复用同一套构造。
 */
export function buildSourceDbConfig(def: DatasourceDef, effective: PermissionLevel): DbConfig {
  return {
    type: def.type as DbConfig['type'],
    ...(def.host !== undefined ? { host: def.host } : {}),
    ...(def.port !== undefined ? { port: def.port } : {}),
    ...(def.user !== undefined ? { user: def.user } : {}),
    ...(def.password !== undefined ? { password: def.password } : {}),
    ...(def.database !== undefined ? { database: def.database } : {}),
    ...(def.filePath !== undefined ? { filePath: def.filePath } : {}),
    ...(def.authSource !== undefined ? { authSource: def.authSource } : {}),
    ...(def.oracleClientPath !== undefined ? { oracleClientPath: def.oracleClientPath } : {}),
    permissionMode: effective,
  };
}

/** isError 工具响应（§6：文本固定 `[<CODE>] 中文说明`） */
function toolError(code: string, message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: `[${code}] ${message}` }],
    isError: true,
  };
}

/**
 * 数据库 MCP 服务器类
 */
export class DatabaseMCPServer {
  private server: Server;
  private adapter: DbAdapter | null = null;
  private config: DbConfig | null;
  private databaseService: DatabaseService | null = null;
  private cacheConfig: Partial<SchemaCacheConfig>;
  private readonly opts: DatabaseMCPServerOptions;
  /** 会话当前源名（registry 模式下 connect_datasource 切源后随之变化；legacy 固定 'adhoc'；未连接 null） */
  private currentSource: string | null;
  /** 会话当前生效权限（§4.1；未连接/legacy 为 undefined） */
  private currentEffectivePermission: PermissionLevel | undefined;

  constructor(config?: DbConfig, options: DatabaseMCPServerOptions = {}) {
    this.config = config || null;
    this.cacheConfig = options.cacheConfig || {};
    this.opts = { ...options };
    this.currentSource = options.source ?? null;
    this.currentEffectivePermission = options.effectivePermission;
    this.server = new Server(
      {
        name: 'universal-db-mcp',
        version: readPackageVersion(),
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  /** 解析后的四态 toolProfile（评审裁决 4） */
  get profile(): ResolvedToolProfile {
    const registryEnabled = this.opts.registry != null;
    const isRemote = this.opts.isRemote === true;
    if (registryEnabled) {
      return isRemote ? 'registry-remote' : 'registry-stdio';
    }
    return isRemote ? 'legacy-remote' : 'legacy-stdio';
  }

  /** 会话当前源名（P5 会话吊销扫描 / mcp-sse 元数据同步用） */
  getCurrentSource(): string | null {
    return this.currentSource;
  }

  /** 会话当前生效权限（P5 / mcp-sse 元数据同步用） */
  getEffectivePermission(): PermissionLevel | undefined {
    return this.currentEffectivePermission;
  }

  /**
   * 会话元数据（评审裁决 9）：供连接方（mcp-sse / stdio）读取当前源与权限，
   * 供 P5 重载后按会话扫描吊销。
   */
  get sessionMeta(): { source?: string; effectivePermission?: PermissionLevel } {
    return {
      ...(this.currentSource !== null ? { source: this.currentSource } : {}),
      ...(this.currentEffectivePermission !== undefined ? { effectivePermission: this.currentEffectivePermission } : {}),
    };
  }

  /**
   * 当前工具调用的审计上下文：
   * - 远程（HTTP 经 mcp-sse 的 auditScope）：复用请求 ctx，并把 source 重绑为会话当前源（§8.1）；
   * - stdio：新建 ctx（principal='local'，source=会话当前源），不写 stdout 由审计日志器落盘。
   */
  private currentCallContext(): AuditContext {
    const existing = getAuditContext();
    if (existing) {
      existing.source = this.currentSource ?? '';
      return existing;
    }
    return {
      requestId: randomUUID(),
      transport: 'stdio',
      principal: this.opts.principal ?? 'local',
      keyFingerprint: this.opts.keyFingerprint ?? '',
      source: this.currentSource ?? '',
      clientIp: '',
    };
  }

  /** 以会话当前源重绑后的审计上下文包裹一次工具调用（§8.1） */
  private withCallContext(fn: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    return runWithAuditContext<Promise<Record<string, unknown>>>(this.currentCallContext(), fn);
  }

  private writeAudit(entry: Omit<AuditRecord, 'status'> & { status?: string }): void {
    const logger = this.opts.auditLogger;
    if (!logger) {
      return;
    }
    const ctx = getAuditContext();
    logger.write({
      requestId: ctx?.requestId,
      transport: ctx?.transport,
      principal: ctx?.principal ?? this.opts.principal,
      keyFingerprint: ctx?.keyFingerprint ?? this.opts.keyFingerprint,
      source: ctx?.source || this.currentSource || undefined,
      clientIp: ctx?.clientIp,
      status: 'ok',
      ...entry,
    });
  }

  private createAdapterFor(config: DbConfig): DbAdapter {
    return (this.opts.adapterFactory ?? createAdapter)(config);
  }

  /**
   * 设置 MCP 协议处理器
   */
  private setupHandlers(): void {
    // 列出可用工具（按 toolProfile 裁剪，§9）
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (this.profile === 'legacy-stdio' || this.profile === 'legacy-remote') {
        return { tools: this.legacyToolList() };
      }
      return { tools: this.registryToolList() };
    });

    // 处理工具调用
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return this.withCallContext(() => this.handleToolCall(request));
    });
  }

  /** legacy 存量工具集（2.14.0 全部 9 个，行为不变；legacy-remote 的 connect_database 附加白名单检查） */
  private legacyToolList(): Array<Record<string, unknown>> {
    return [
      executeQueryTool,
      getSchemaTool,
      getTableInfoTool,
      clearCacheTool,
      getEnumValuesTool,
      getSampleDataTool,
      connectDatabaseTool,
      disconnectDatabaseTool,
      getConnectionStatusTool,
    ];
  }

  /** registry 工具集：查询类 + clear_cache + get_connection_status + connect_datasource + list_datasources + disconnect_database（§9） */
  private registryToolList(): Array<Record<string, unknown>> {
    return [
      executeQueryTool,
      getSchemaTool,
      getTableInfoTool,
      clearCacheTool,
      getEnumValuesTool,
      getSampleDataTool,
      connectDatasourceTool,
      listDatasourcesTool,
      disconnectDatabaseTool,
      getConnectionStatusTool,
    ];
  }

  private async handleToolCall(request: {
    params: { name: string; arguments?: Record<string, unknown> };
  }): Promise<Record<string, unknown>> {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'connect_database': {
          // §9：registry 模式不暴露 connect_database（tools/list 里没有它），调用必须得到
          // unknown tool 语义而非「再试一次」——否则客户端可用原始连接参数完全绕过注册表 ACL。
          if (this.profile === 'registry-stdio' || this.profile === 'registry-remote') {
            throw new Error(`未知工具: ${name}`);
          }
          return await this.handleConnectDatabase(args);
        }
        case 'connect_datasource': {
          return await this.handleConnectDatasource(args);
        }
        case 'list_datasources': {
          return this.handleListDatasources();
        }
        case 'disconnect_database': {
          return await this.handleDisconnectDatabase();
        }
        case 'get_connection_status': {
          return this.handleGetConnectionStatus();
        }
        default:
          break;
      }

      // 以下 tool 需要数据库已连接
      if (!this.databaseService) {
        throw new Error('数据库未连接。请先使用 connect_datasource / connect_database 工具连接数据库。');
      }

      switch (name) {
        case 'execute_query': {
          const { query, params } = args as { query: string; params?: unknown[] };

          console.error(`📊 执行查询: ${query.substring(0, 100)}...`);

          // 写权限拒绝 → AclError(PERMISSION_DENIED)（safety.ts 未改，database-service 已包装）
          const result = await this.databaseService.executeQuery(query, params);

          // P4b：此处补 event=query 审计（sql/sqlBytes/sqlTruncated/rows/durationMs），source 已由 withCallContext 重绑
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'get_schema': {
          const { forceRefresh } = (args as { forceRefresh?: boolean }) || {};

          console.error('📋 获取数据库结构...');

          const schema = await this.databaseService.getSchema(forceRefresh);

          // P4b：此处补 event=metadata 审计（耗时）
          const cacheStats = this.databaseService.getCacheStats();
          const response = {
            ...schema,
            _cacheInfo: {
              cached: cacheStats.isCached,
              cachedAt: cacheStats.cachedAt?.toISOString(),
              hitRate: this.databaseService.getCacheHitRate() + '%',
            },
          };

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(response, null, 2),
              },
            ],
          };
        }

        case 'get_table_info': {
          const { tableName, forceRefresh } = args as { tableName: string; forceRefresh?: boolean };

          console.error(`📄 获取表信息: ${tableName}`);

          const table = await this.databaseService.getTableInfo(tableName, forceRefresh);

          // P4b：此处补 event=metadata 审计（耗时）
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(table, null, 2),
              },
            ],
          };
        }

        case 'clear_cache': {
          console.error('🗑️ 清除 Schema 缓存...');

          this.databaseService.clearSchemaCache();

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Schema 缓存已清除',
                }, null, 2),
              },
            ],
          };
        }

        case 'get_enum_values': {
          const { tableName, columnName, limit, includeCount } = args as {
            tableName: string;
            columnName: string;
            limit?: number;
            includeCount?: boolean;
          };

          console.error(`🔢 获取枚举值: ${tableName}.${columnName}`);

          const result = await this.databaseService.getEnumValues(
            tableName,
            columnName,
            limit,
            includeCount
          );

          // P4b：此处补 event=query 审计（耗时）
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'get_sample_data': {
          const { tableName, columns, limit } = args as {
            tableName: string;
            columns?: string[];
            limit?: number;
          };

          console.error(`📝 获取示例数据: ${tableName}`);

          const result = await this.databaseService.getSampleData(
            tableName,
            columns,
            limit
          );

          // P4b：此处补 event=query 审计（耗时）
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        default:
          throw new Error(`未知工具: ${name}`);
      }
    } catch (error) {
      // §6：ACL 拒绝类（AclError）→ [<CODE>] 中文说明 + isError + denied 审计；其余保持既有文本
      if (error instanceof AclError) {
        auditDenied(this.opts.auditLogger, error.code);
        const errorMessage = error.message;
        console.error(`❌ 错误: ${errorMessage}`);
        return toolError(error.code, errorMessage);
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ 错误: ${errorMessage}`);
      return {
        content: [
          {
            type: 'text',
            text: `执行失败: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }

  /** legacy 工具：connect_database（2.14.0 行为；legacy-remote 附加 adhoc 目标白名单检查，用例 14d） */
  private async handleConnectDatabase(args: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    const {
      type, host, port, user, password, database,
      filePath, allowWrite, permissionMode, authSource, oracleClientPath,
    } = (args ?? {}) as Record<string, any>;

    // 构建新配置（legacy 语义：客户端自报连接参数 + 权限模式直通）
    const newConfig: DbConfig = {
      type: normalizeDbType(type),
      host,
      port,
      user,
      password,
      database,
      filePath,
      allowWrite: allowWrite || false,
      permissionMode: permissionMode || 'safe',
    };

    // MongoDB 特殊配置
    if (newConfig.type === 'mongodb' && authSource) {
      (newConfig as any).authSource = authSource;
    }

    // Oracle 特殊配置
    if (newConfig.type === 'oracle' && oracleClientPath) {
      newConfig.oracleClientPath = oracleClientPath;
    }

    // legacy-remote：目标必须命中 adhocTargetAllowlist（若配置；配置为空 = 不限制，legacy 行为）
    if (this.profile === 'legacy-remote') {
      const allowlist = this.opts.adhocTargetAllowlist ?? [];
      if (allowlist.length > 0 && host !== undefined && host !== null && port !== undefined && port !== null) {
        const target = `${host}:${port}`;
        if (!isAdhocAllowed(target, allowlist)) {
          auditDenied(this.opts.auditLogger, 'ADHOC_TARGET_DENIED', 'adhoc');
          return toolError('ADHOC_TARGET_DENIED', 'adhoc 连接目标不在允许清单（adhocTargetAllowlist）中');
        }
      }
    }

    // 断开旧连接
    if (this.adapter) {
      console.error('🔄 断开旧数据库连接...');
      if (this.databaseService) {
        this.databaseService.clearSchemaCache();
      }
      await this.adapter.disconnect();
      this.adapter = null;
      this.databaseService = null;
    }

    // 建立新连接
    console.error(`🔌 正在连接 ${newConfig.type} 数据库...`);
    const newAdapter = this.createAdapterFor(newConfig);
    await newAdapter.connect();

    this.adapter = newAdapter;
    this.config = newConfig;
    this.databaseService = new DatabaseService(newAdapter, newConfig, this.cacheConfig);
    this.currentSource = 'adhoc';

    const connInfo = newConfig.type === 'sqlite'
      ? `SQLite: ${newConfig.filePath}`
      : `${newConfig.type}: ${newConfig.host}:${newConfig.port}/${newConfig.database || '(default)'}`;

    console.error(`✅ 数据库连接成功: ${connInfo}`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `已成功连接到 ${connInfo}`,
          connection: {
            type: newConfig.type,
            host: newConfig.host,
            port: newConfig.port,
            database: newConfig.database,
            permissionMode: newConfig.permissionMode || 'safe',
          },
        }, null, 2),
      }],
    };
  }

  /**
   * registry 工具：connect_datasource（§9）
   * - 入参只收 source（inputSchema additionalProperties:false）。
   * - 源不存在 → isError [SOURCE_NOT_FOUND] + 审计 denied；
   * - registry-remote 且 key 无权 → isError [SOURCE_NOT_FOUND]（与不存在不可区分，用例 14b）+ 审计 denied；
   * - 命中 → 新连接成功后才断开旧连接、清 schema 缓存、按 §4.1 重算权限（写入 config.permissionMode）、
   *   重绑会话当前源 / 审计源、审计 event=connect（用例 14a 切源后审计 source=B）。
   * - 切源失败（目标在允许内但连不上）→ 原连接保持可用（用例 14b 语义）。
   */
  private async handleConnectDatasource(args: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    const source = (args ?? {}).source;
    if (typeof source !== 'string' || source.length === 0) {
      return toolError('INVALID_REQUEST', '缺少 source 参数（connect_datasource 只接受数据源名）');
    }
    const registry = this.opts.registry;
    if (!registry) {
      auditDenied(this.opts.auditLogger, 'SOURCE_NOT_FOUND', source);
      return toolError('SOURCE_NOT_FOUND', '未配置数据源注册表');
    }
    const def = registry.resolveSource(source);
    if (!def) {
      auditDenied(this.opts.auditLogger, 'SOURCE_NOT_FOUND', source);
      return toolError('SOURCE_NOT_FOUND', '源不存在或当前 API key 无权访问');
    }
    // registry-remote：必须在 key 的 allowedSources 内（stdio 本地可信，不受限，§9）
    if (this.profile === 'registry-remote') {
      const allowed = this.opts.key?.allowedSources ?? [];
      if (!allowed.includes(source)) {
        auditDenied(this.opts.auditLogger, 'SOURCE_NOT_FOUND', source);
        return toolError('SOURCE_NOT_FOUND', '源不存在或当前 API key 无权访问');
      }
    }

    // §4.1 生效权限：min(sourceMax ?? safe, keyMax ?? full)
    const effective = resolveEffectivePermission(def, this.opts.key ?? null);
    const newConfig = buildSourceDbConfig(def, effective);

    // 先在新适配器上建立连接；成功才替换，失败保持旧连接（用例 14b 语义）
    const newAdapter = this.createAdapterFor(newConfig);
    try {
      await newAdapter.connect();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`❌ 切换到数据源 ${source} 失败: ${detail}`); 
      try {
        await newAdapter.disconnect();
      } catch {
        // best-effort 清理新适配器
      }
      return toolError('CONNECT_FAILED', `切换到数据源 ${source} 失败：${detail}`);
    }

    // 断开旧连接、清 schema 缓存
    if (this.databaseService) {
      this.databaseService.clearSchemaCache();
    }
    if (this.adapter) {
      const oldAdapter = this.adapter;
      this.adapter = null;
      try {
        await oldAdapter.disconnect();
      } catch (error) {
        console.error(`断开旧数据库连接失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.adapter = newAdapter;
    this.config = newConfig;
    this.databaseService = new DatabaseService(newAdapter, newConfig, this.cacheConfig);
    this.currentSource = source;
    this.currentEffectivePermission = effective;

    // 重绑审计源（会话元数据 + 当前调用 ctx）
    const ctx = getAuditContext();
    if (ctx) {
      ctx.source = source;
    }
    this.writeAudit({ event: 'connect', status: 'ok' });

    console.error(`✅ 数据源连接成功: ${source}`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `已连接到数据源 ${source}`,
          source,
          connection: {
            type: newConfig.type,
            database: newConfig.database ?? '',
            permissionMode: effective,
          },
        }, null, 2),
      }],
    };
  }

  /** registry 工具：list_datasources（stdio 全部源；remote 该 key allowedSources 内；仅 name/type/description，用例 14e） */
  private handleListDatasources(): Record<string, unknown> {
    const registry = this.opts.registry;
    if (!registry) {
      return toolError('SOURCE_NOT_FOUND', '未配置数据源注册表');
    }
    let sources = registry.listSources();
    if (this.profile === 'registry-remote') {
      const allowed = this.opts.key?.allowedSources ?? [];
      sources = sources.filter((s) => allowed.includes(s.name));
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: true, sources }, null, 2),
      }],
    };
  }

  /** disconnect_database（本 phase 保持行为；补 event=disconnect 审计） */
  private async handleDisconnectDatabase(): Promise<Record<string, unknown>> {
    if (!this.adapter) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, message: '当前没有活跃的数据库连接' }, null, 2),
        }],
      };
    }

    if (this.databaseService) {
      this.databaseService.clearSchemaCache();
    }
    await this.adapter.disconnect();

    this.writeAudit({ event: 'disconnect', status: 'ok' });

    const oldSource = this.currentSource;
    const oldType = this.config?.type;
    this.adapter = null;
    this.config = null;
    this.databaseService = null;
    this.currentSource = null;
    this.currentEffectivePermission = undefined;

    console.error('👋 数据库连接已断开');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `已断开 ${oldSource ?? oldType ?? ''} 数据库连接`,
        }, null, 2),
      }],
    };
  }

  /** get_connection_status：增加 source 字段（当前连接源；未连接 null），切源后随之变化（用例 20 字段本期即加） */
  private handleGetConnectionStatus(): Record<string, unknown> {
    if (!this.adapter || !this.config) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            connected: false,
            source: null,
            message: '当前未连接任何数据库。请使用 connect_datasource（注册表模式）或 connect_database（legacy 模式）连接。',
          }, null, 2),
        }],
      };
    }

    const status: Record<string, any> = {
      connected: true,
      source: this.currentSource || null,
      type: this.config.type,
      permissionMode: this.config.permissionMode || 'safe',
    };

    if (this.config.type === 'sqlite') {
      status.filePath = this.config.filePath;
    } else {
      status.host = this.config.host;
      status.port = this.config.port;
      status.database = this.config.database;
    }

    if (this.databaseService) {
      const cacheStats = this.databaseService.getCacheStats();
      status.schemaCache = {
        cached: cacheStats.isCached,
        hitRate: this.databaseService.getCacheHitRate() + '%',
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(status, null, 2),
      }],
    };
  }

  /**
   * 设置数据库适配器
   */
  setAdapter(adapter: DbAdapter): void {
    this.adapter = adapter;
    if (this.config) {
      this.databaseService = new DatabaseService(adapter, this.config, this.cacheConfig);
    }
  }

  /**
   * 获取 MCP Server 实例（用于 SSE/HTTP 传输）
   */
  getServer(): Server {
    return this.server;
  }

  /**
   * 连接数据库（不启动传输层）
   */
  async connectDatabase(): Promise<void> {
    if (!this.adapter) {
      throw new Error('必须先设置数据库适配器才能连接数据库');
    }

    // 连接数据库
    console.error('🔌 正在连接数据库...');
    await this.adapter.connect();
    console.error('✅ 数据库连接成功');

    // 显示安全模式状态
    if (this.config?.allowWrite) {
      console.error('⚠️  警告: 写入模式已启用，请谨慎操作！');
    } else {
      console.error('🛡️  安全模式: 只读模式（推荐）');
    }

    // 显示缓存配置
    console.error('📦 Schema 缓存已启用 (默认 TTL: 5 分钟)');
  }

  /**
   * 使用指定的传输层连接 MCP 服务器
   */
  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  /**
   * 启动服务器（使用 stdio 传输，用于 Claude Desktop）
   * 注意：v2.14 起「无 adapter 不抛错」（无连接启动为正式特性）——本方法在无 adapter 时以无连接模式启动。
   */
  async start(): Promise<void> {
    // 如果有初始配置和适配器，先连接；否则等待 AI 调用 connect_database / connect_datasource
    if (this.adapter) {
      await this.connectDatabase();
    } else {
      console.error('📡 MCP 服务器以无连接模式启动，等待通过 connect_database 工具连接数据库...');
    }

    // 启动 MCP 服务器（stdio 模式）
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error('🚀 MCP 服务器已启动，等待客户端连接...');
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    // 1. 关闭 MCP Server（释放 transport 层资源：stdin/stdout 监听器等）
    try {
      await this.server.close();
    } catch (err) {
      console.error('关闭 MCP Server 时出错:', err instanceof Error ? err.message : String(err));
    }

    // 2. 清理 Schema 缓存
    if (this.databaseService) {
      this.databaseService.clearSchemaCache();
    }

    // 3. 断开数据库连接
    if (this.adapter) {
      await this.adapter.disconnect();
      console.error('👋 数据库连接已关闭');
    }
  }
}

// ---- 工具定义（schema 文案与 2.14.0 完全一致；切 profile 只增删工具条目） ----

const executeQueryTool: Record<string, unknown> = {
  name: 'execute_query',
  description: '执行 SQL 查询或数据库命令。支持 SELECT、JOIN、聚合等查询操作。如果启用了写入模式，也可以执行 INSERT、UPDATE、DELETE 等操作。',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '要执行的 SQL 语句或数据库命令',
      },
      params: {
        type: 'array',
        description: '查询参数（可选，用于参数化查询防止 SQL 注入）',
        items: {
          type: 'string',
        },
      },
    },
    required: ['query'],
  },
};

const getSchemaTool: Record<string, unknown> = {
  name: 'get_schema',
  description: '获取数据库结构信息，包括所有 Schema 中用户可访问的表名、列名、数据类型、主键、索引等元数据。在执行查询前调用此工具可以帮助理解数据库结构。结果会被缓存以提高性能。',
  inputSchema: {
    type: 'object',
    properties: {
      forceRefresh: {
        type: 'boolean',
        description: '是否强制刷新缓存（可选，默认 false）。设为 true 可获取最新的数据库结构。',
      },
    },
  },
};

const getTableInfoTool: Record<string, unknown> = {
  name: 'get_table_info',
  description: '获取指定表的详细信息，包括列定义、索引、预估行数等。用于深入了解某个表的结构。',
  inputSchema: {
    type: 'object',
    properties: {
      tableName: {
        type: 'string',
        description: '表名。支持 schema.table_name 格式指定 Schema（如 analytics.users）。不指定 Schema 时查询默认 Schema。',
      },
      forceRefresh: {
        type: 'boolean',
        description: '是否强制刷新缓存（可选，默认 false）',
      },
    },
    required: ['tableName'],
  },
};

const clearCacheTool: Record<string, unknown> = {
  name: 'clear_cache',
  description: '清除 Schema 缓存。当数据库结构发生变化（如新增表、修改列）时，可以调用此工具清除缓存。',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const getEnumValuesTool: Record<string, unknown> = {
  name: 'get_enum_values',
  description: '获取指定列的所有唯一值。用于了解 status、type、category 等枚举类型列的所有可能值，帮助生成准确的 WHERE 条件。例如：获取 orders.status 列的所有状态值（pending, shipped, delivered 等）。',
  inputSchema: {
    type: 'object',
    properties: {
      tableName: {
        type: 'string',
        description: '表名。支持 schema.table_name 格式指定 Schema（如 analytics.users）。',
      },
      columnName: {
        type: 'string',
        description: '列名（通常是 status、type、category 等枚举类型的列）',
      },
      limit: {
        type: 'number',
        description: '最大返回数量（可选，默认 50，最大 100）。如果唯一值超过此数量，说明该列可能不是枚举类型。',
      },
      includeCount: {
        type: 'boolean',
        description: '是否包含每个值的出现次数（可选，默认 false）。设为 true 可了解数据分布。',
      },
    },
    required: ['tableName', 'columnName'],
  },
};

const getSampleDataTool: Record<string, unknown> = {
  name: 'get_sample_data',
  description: '获取表的示例数据（已自动脱敏）。用于了解数据格式，如日期格式（2024-01-01 vs 20240101）、ID格式（UUID vs 自增）、金额精度等。敏感数据（手机号、邮箱、身份证等）会自动脱敏保护隐私。',
  inputSchema: {
    type: 'object',
    properties: {
      tableName: {
        type: 'string',
        description: '表名。支持 schema.table_name 格式指定 Schema（如 analytics.users）。',
      },
      columns: {
        type: 'array',
        items: { type: 'string' },
        description: '要查看的列（可选，默认全部列）',
      },
      limit: {
        type: 'number',
        description: '返回行数（可选，默认 3，最大 10）',
      },
    },
    required: ['tableName'],
  },
};

const connectDatabaseTool: Record<string, unknown> = {
  name: 'connect_database',
  description: '连接到数据库。支持动态指定数据库类型和连接参数，无需重启服务。如果当前已有连接，会自动断开旧连接再建立新连接。支持的数据库类型：mysql, postgres, redis, oracle, dm, sqlserver, mongodb, sqlite, kingbase, gaussdb, oceanbase, tidb, clickhouse, polardb, vastbase, highgo, goldendb。',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: '数据库类型',
        enum: [
          'mysql', 'postgres', 'redis', 'oracle', 'dm', 'sqlserver',
          'mongodb', 'sqlite', 'kingbase', 'gaussdb', 'oceanbase',
          'tidb', 'clickhouse', 'polardb', 'vastbase', 'highgo', 'goldendb',
        ],
      },
      host: { type: 'string', description: '数据库主机地址' },
      port: { type: 'number', description: '数据库端口' },
      user: { type: 'string', description: '用户名' },
      password: { type: 'string', description: '密码' },
      database: { type: 'string', description: '数据库名称' },
      filePath: { type: 'string', description: 'SQLite 数据库文件路径' },
      allowWrite: { type: 'boolean', description: '是否允许写操作（默认 false）' },
      permissionMode: {
        type: 'string',
        description: '权限模式: safe(只读) | readwrite(读写不删) | full(完全控制)',
        enum: ['safe', 'readwrite', 'full'],
      },
      authSource: { type: 'string', description: 'MongoDB 认证数据库（默认 admin）' },
      oracleClientPath: { type: 'string', description: 'Oracle Instant Client 路径' },
    },
    required: ['type'],
  },
};

const disconnectDatabaseTool: Record<string, unknown> = {
  name: 'disconnect_database',
  description: '断开当前数据库连接。断开后需要重新调用 connect_database 才能执行查询。',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const getConnectionStatusTool: Record<string, unknown> = {
  name: 'get_connection_status',
  description: '获取当前数据库连接状态。返回是否已连接、数据库类型、地址、数据库名、权限模式等信息。',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

/** registry 模式连接工具：只收 source 名字（§9：地址/账号/密码/权限参数一律不接受） */
const connectDatasourceTool: Record<string, unknown> = {
  name: 'connect_datasource',
  description: '连接到数据源注册表中预配置的数据源（切换会话当前源）。只接受 source（源名），连接参数由服务端权威提供。',
  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: '数据源注册表源名（list_datasources 可查看可用源）',
      },
    },
    required: ['source'],
    additionalProperties: false,
  },
};

const listDatasourcesTool: Record<string, unknown> = {
  name: 'list_datasources',
  description: '列出当前 API key 可访问的数据源（名称/类型/描述；不含任何连接参数）。',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};