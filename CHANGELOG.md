# 更新日志

本文档记录 Universal DB MCP 的版本更新历史。

## [3.0.0] - 2026-11-04

### 破坏性变更

- **客户端不再传连接参数** - 3.0 起使用「数据源注册表 + 按源 ACL」模型：连接必须使用注册表 source（`connect_datasource` / `X-DB-Source`），客户端传地址/账号/密码/权限参数一律不接受（注册表模式），凭据与服务端配置在 `DATASOURCE_CONFIG` 注册表文件中
- **HTTP 原始参数通道默认关闭** - 无 `DATASOURCE_CONFIG` 且未设置 `ALLOW_ADHOC_CONNECTIONS=true` 时，HTTP/SSE/Streamable 的原始连接参数请求返回 `403 ADHOC_DISABLED`（fail-closed）；`ADHOC_TARGET_ALLOWLIST` 可限定 adhoc 出站目标
- **鉴权改为注册表 apiKeys** - API Key 由注册表文件 `apiKeys[].key` 定义并携带 `allowedSources` / `maxPermission` / 名称；`API_KEYS` 环境变量在注册表存在时被忽略（打 WARN）
- **`connect_database` 工具在注册表模式不再暴露** - registry-stdio / registry-remote 的 `tools/list` 不含 `connect_database`（未知工具），仅 legacy / legacy-remote 模式保留
- **错误码体系** - 结构化错误码：`SOURCE_NOT_FOUND`（404）、`PERMISSION_DENIED`（403）、`CONNECT_FAILED`（502）、`ADHOC_DISABLED` / `ADHOC_TARGET_DENIED`（403）等，替代过去的恒 500
- **无 config 的 HTTP 启动 fail-closed** - 无 `DATASOURCE_CONFIG` 且未开 `ALLOW_ADHOC_CONNECTIONS` 时 HTTP 模式启动失败（退出码 1，stderr 提示 `DATASOURCE_CONFIG`）
- **审计默认关闭** - 必须配置 `AUDIT_LOG_PATH` 才会落盘 NDJSON 审计日志，否则审计禁用并打印启动 WARN；`TRUST_AUDIT_USER_HEADER` 控制是否信任 `X-Audit-User` 头（仅审计关联，不参与授权）

#### 迁移

从 2.x 升级请参考 `MIGRATION-3.0.md`。

### 新增

- 数据源注册表（`DATASOURCE_CONFIG`）与按源 ACL（key 的 `allowedSources`、`maxPermission` 取源/key 两者的 min）
- 新 MCP 工具：`connect_datasource`、`list_datasources`（仅返回 name/type/description，不暴露连接凭据）
- SIGHUP 热加载：配置变更动态生效 + 会话吊销（`key_revoked` / `source_removed` / `source_revoked`）
- NDJSON 审计日志（`AUDIT_LOG_PATH`，SQL 截断 2048，失败降级不阻断）

## [2.14.0] - 2026

### 新增
- **MCP stdio 模式动态数据库连接** - 支持在对话中动态连接/切换数据库，无需写死配置
  - **新增 3 个 MCP Tool**：
    - `connect_database`：动态连接数据库，支持全部 17 种数据库类型，已有连接时自动断开旧连接
    - `disconnect_database`：断开当前数据库连接
    - `get_connection_status`：查看当前连接状态（类型、地址、权限模式、缓存状态）
  - **`--type` 参数改为可选**：不指定则以无连接模式启动，等待 AI 通过 `connect_database` 动态连接
  - **零配置启动**：`claude_desktop_config.json` 中只需 `"args": ["universal-db-mcp"]`，对话中告诉 AI 数据库信息即可
  - **向后兼容**：传了 `--type` 参数的用户行为完全不变
  - **影响范围**：仅 MCP stdio 模式，HTTP/SSE/Streamable HTTP 模式不受影响
  - **改动文件**：`src/mcp/mcp-server.ts`、`src/mcp/mcp-index.ts`

#### 用户使用指南

**方式 A：零配置启动（新增能力）**

在 `claude_desktop_config.json` 中无需指定数据库参数：

```json
{
  "mcpServers": {
    "universal-db": {
      "command": "npx",
      "args": ["universal-db-mcp"]
    }
  }
}
```

然后在对话中直接告诉 AI 数据库信息：
- "帮我连接 192.168.1.100 的 MySQL，用户名 root，密码 123456，数据库 order_db"
- "切换到 10.0.0.5 的 PostgreSQL，端口 5432，数据库 analytics"
- "断开当前数据库连接"
- "当前连的是哪个库？"

AI 会自动调用 `connect_database`、`disconnect_database`、`get_connection_status` 工具。

**方式 B：带默认连接启动（向后兼容，行为不变）**

```json
{
  "mcpServers": {
    "universal-db": {
      "command": "npx",
      "args": [
        "universal-db-mcp",
        "--type", "mysql",
        "--host", "localhost",
        "--port", "3306",
        "--user", "root",
        "--password", "your_password",
        "--database", "your_database"
      ]
    }
  }
}
```

启动时自动连接指定数据库，对话中仍可通过 `connect_database` 切换到其他数据库。

## [2.13.0] - 2026

### 修复

- **stdio 进程优雅退出** - 修复 stdio MCP server 在客户端（如 Codex CLI）关闭会话后进程挂起的问题
  - **问题表现**：Codex CLI 执行 `/exit` 后终端提示符不返回，必须手动 `Ctrl+C`
  - **根因**：未监听 `process.stdin` 的 `end`/`close` 事件；`stop()` 方法未调用 `server.close()` 释放 transport 资源
  - **修复方案**：
    - `mcp-server.ts`：`stop()` 中新增 `server.close()` 调用，释放 stdin/stdout 监听器
    - `mcp-index.ts`：新增统一 `gracefulShutdown()` 函数，监听 `SIGINT`/`SIGTERM`/`stdin end`/`stdin close`
    - 防重入保护（`shuttingDown` 标志）+ 5 秒超时兜底
  - **影响范围**：stdio 模式直接修复；SSE/Streamable HTTP 模式间接受益（`cleanupSession()` 调用的 `stop()` 现在正确关闭 MCP Server）

## [2.12.0] - 2026

### 修复
- **多 Schema 支持** - 修复 8 个适配器只能获取默认 Schema 下的表信息的问题
  - **影响的适配器**：PostgreSQL、GaussDB、KingbaseES、Vastbase、HighGo、SQL Server、Oracle、达梦
  - **问题表现**：`get_schema`、`get_table_info`、`get_enum_values`、`get_sample_data` 只返回默认 Schema（如 PostgreSQL 的 `public`、SQL Server 的 `dbo`、Oracle/达梦的当前用户）下的表
  - **修复方案**：
    - 适配器 SQL 查询改为排除系统 Schema，自动发现所有用户 Schema
    - 非默认 Schema 的表名使用 `schema.table_name` 格式（如 `analytics.events`）
    - 默认 Schema 的表名保持不变，向后兼容
    - `get_table_info` 等工具支持 `schema.table_name` 格式精确指定表
  - **核心服务层**：`DatabaseService.getTableInfo()` 新增 3 级表名匹配（精确匹配 → Schema 拆分匹配 → 基础名唯一匹配）
  - **标识符引用**：`quoteIdentifier()` 支持自动拆分 `schema.table` 格式并分别引用

#### 用户视角的变化

**如果只使用默认 Schema（public/dbo/当前用户），使用体验完全不变。** 以下变化仅体现在拥有多 Schema 的数据库上。

**之前**：假设 PostgreSQL 数据库中有 `public.users`、`public.orders`、`analytics.events`、`analytics.page_views` 四张表，调用 `get_schema` 只能看到 `users` 和 `orders`，`analytics` 下的表完全不可见。

**现在**：调用 `get_schema` 可以看到全部四张表：`users`、`orders`、`analytics.events`、`analytics.page_views`。

| 变化点 | 之前 | 现在 |
|--------|------|------|
| `get_schema` 返回的表 | 只有默认 Schema 的表 | 所有用户 Schema 的表 |
| 非默认 Schema 表的命名 | 不可见 | `schema.table_name` 格式（如 `analytics.events`） |
| 默认 Schema 表的命名 | `users` | `users`（不变） |
| 查询非默认 Schema 的表 | 不支持 | 使用 `schema.table_name` 格式即可（如 `analytics.events`） |

**新增能力**：
- "查看 `analytics.events` 表的结构" → `get_table_info("analytics.events")`
- "查看 `analytics.events` 表 `event_type` 列有哪些值" → `get_enum_values("analytics.events", "event_type")`
- "查看 `analytics.events` 表的示例数据" → `get_sample_data("analytics.events")`

**无需任何配置变更**：不需要修改启动参数、配置文件或学习新工具，升级后自动生效。

## [2.11.0] - 2026

### 改进
- **连接稳定性增强** - 全面升级数据库连接管理，彻底解决 `Can't add new command when connection is in closed state` 错误
  - **连接池化** - 12 个网络数据库适配器从单连接升级为连接池
    - MySQL 系列（MySQL、TiDB、OceanBase、PolarDB、GoldenDB）：使用 `mysql2` 连接池，配置 `enableKeepAlive` + `connectionLimit: 3`
    - PostgreSQL 系列（PostgreSQL、KingbaseES、GaussDB、Vastbase、HighGo）：使用 `pg.Pool`，配置 `keepAlive` + `max: 3`
    - Oracle：使用 `oracledb.createPool()`，配置 `poolPingInterval: 30`
  - **心跳保活** - 达梦适配器使用定时心跳（30 秒间隔）保持连接活跃
  - **断线自动重试** - 所有网络数据库适配器新增 `withRetry` 机制，连接断开后自动重试一次
  - **TCP Keep-Alive** - 所有连接池启用 TCP Keep-Alive，防止连接被服务端或中间件超时关闭
- 不需要修改的适配器（已有内置机制）：SQL Server（连接池）、Redis（自动重连）、MongoDB（内置连接池）、SQLite（本地文件）、ClickHouse（HTTP 协议）

## [2.10.0] - 2026

### 新增
- **细粒度权限控制** - 支持自定义操作权限组合，不再只有"只读"和"完全写入"两种模式
  - **权限模式** - 新增 `--permission-mode` 参数
    - `safe`（默认）：只读模式，仅允许 SELECT
    - `readwrite`：读写模式，允许 SELECT/INSERT/UPDATE，禁止 DELETE 和 DDL
    - `full`：完全控制，等价于原来的 `--danger-allow-write`
    - `custom`：自定义模式，配合 `--permissions` 使用
  - **自定义权限** - 新增 `--permissions` 参数，支持逗号分隔的权限列表
    - `read`：SELECT 查询（始终包含）
    - `insert`：INSERT, REPLACE
    - `update`：UPDATE
    - `delete`：DELETE, TRUNCATE
    - `ddl`：CREATE, ALTER, DROP, RENAME
  - **向后兼容** - `--danger-allow-write` 仍然有效，等价于 `--permission-mode=full`
  - **HTTP API 支持** - REST API 和 MCP SSE/Streamable HTTP 端点同样支持新权限参数

### 改进
- 更新 `DbConfig` 类型，新增 `permissionMode` 和 `permissions` 字段
- 重构 `safety.ts`，支持细粒度权限检查
- 更新命令行帮助信息，添加新参数说明
- 更新 README 文档（中英文），添加权限模式说明

### 文档
- **完善权限配置文档** - 添加不同传输方式的权限参数命名说明
  - STDIO 模式（Claude Desktop）：使用连字符命名 `--permission-mode`、`--permissions`
  - SSE 模式（Dify 等）：使用驼峰命名 `permissionMode`、`permissions`（URL Query）
  - Streamable HTTP 模式：使用连字符命名 `X-DB-Permission-Mode`、`X-DB-Permissions`（HTTP Header）
  - REST API 模式：使用驼峰命名 `permissionMode`、`permissions`（JSON Body）
- 更新以下文档：
  - `docs/getting-started/configuration.md` - 添加传输方式权限配置汇总表
  - `docs/guides/security.md` - 添加各传输方式的权限配置示例
  - `docs/http-api/API_REFERENCE.md` / `API_REFERENCE.zh-CN.md` - 添加权限参数说明
  - `docs/integrations/DIFY.md` / `DIFY.zh-CN.md` - 添加 SSE 和 Streamable HTTP 权限参数
  - `docs/integrations/CLAUDE-DESKTOP.md` / `CLAUDE-DESKTOP.zh-CN.md` - 添加参数命名提示
  - `docs/integrations/COZE.md` / `COZE.zh-CN.md` - 添加 REST API 权限参数
  - `README.md` / `README.zh-CN.md` - 添加传输方式权限配置汇总表

## [2.9.0] - 2026

### 新增
- **按需增强工具** - 新增两个 MCP 工具，帮助 LLM 更好地理解数据内容
  - **`get_enum_values`** - 获取指定列的所有唯一值
    - 适用于枚举类型列、状态列等有限值集合
    - 支持 limit 参数控制返回数量
    - 返回值包含 `isComplete` 标识是否返回了全部值
  - **`get_sample_data`** - 获取表的示例数据
    - 自动数据脱敏，保护敏感信息（手机号、邮箱、身份证、银行卡等）
    - 支持按列名模式匹配和按值格式自动检测两种脱敏方式
    - 可通过 `masking` 参数控制是否启用脱敏
- **数据脱敏工具** - 新增 `DataMasker` 工具类（`src/utils/data-masking.ts`）
  - 支持 7 种脱敏类型：phone、email、idcard、bankcard、password、partial、full
  - 支持自定义脱敏规则
  - 自动检测敏感数据格式
- **REST API 端点** - 新增两个 HTTP API 端点
  - `GET /api/enum-values` - 获取枚举值
  - `GET /api/sample-data` - 获取示例数据

### 改进
- 新增 `EnumValuesResult` 和 `SampleDataResult` 类型定义
- 更新 API 参考文档（中英文），添加新端点说明
- 新增 20 个数据脱敏单元测试

## [2.8.0] - 2026

### 新增
- **Schema 核心增强** - 提升 LLM 对数据库结构的理解，提高 Text2SQL 准确性
  - **表注释支持** - Schema 信息现在包含表级别注释（`comment` 字段）
    - 支持的数据库：MySQL、PostgreSQL、Oracle、SQL Server、TiDB、达梦、KingbaseES、GaussDB、OceanBase、PolarDB、Vastbase、HighGo、GoldenDB、ClickHouse（14个）
    - 不支持：Redis、MongoDB（NoSQL）、SQLite（无原生表注释）
  - **隐式关系推断** - 基于列命名规则自动推断表间关系
    - 支持模式：`xxx_id` → `xxxs.id`、`xxxId` → `xxxs.id`（驼峰）、`xxx_code` → `xxxs.code`、`xxx_no` → `xxxs.xxx_no`
    - 推断规则：不覆盖显式外键、验证目标表存在、验证目标列存在
    - 置信度评分：0.7-0.95，LLM 可根据置信度判断关系可靠性
  - **关系类型细化** - 通过检查唯一约束区分 `one-to-one` 和 `many-to-one`
  - **关系来源标注** - `source` 字段区分 `foreign_key`（显式外键）和 `inferred`（推断关系）

### 改进
- 新增 `SchemaEnhancer` 工具类（`src/utils/schema-enhancer.ts`）
- 更新 `RelationshipInfo` 类型，添加 `source` 和 `confidence` 字段
- 更新 `TableInfo` 类型，添加 `comment` 字段
- 更新 14 个数据库适配器，添加表注释查询支持

## [2.7.0] - 2026

### 新增
- **外键关系支持** - Schema 信息现在包含外键和表关系数据，帮助 LLM 更好地理解数据库结构
  - `foreignKeys` - 表级别外键约束信息，包含约束名、列、引用表、引用列、ON DELETE/UPDATE 规则
  - `relationships` - 全局关系视图，展示所有表之间的关联关系
  - 支持的数据库：MySQL、PostgreSQL、Oracle、SQL Server、SQLite、达梦、KingbaseES、GaussDB、OceanBase、TiDB、PolarDB、Vastbase、HighGo、GoldenDB
  - NoSQL 数据库（Redis、MongoDB、ClickHouse）不支持传统外键，返回结果中不包含这些字段

### 改进
- 更新 API 参考文档（中英文），添加外键和关系字段的示例
- 更新数据库功能支持表，添加"外键关系"功能行

## [2.6.0] - 2026

### 新增
- **MCP SSE/Streamable HTTP 传输支持** - 在 HTTP 模式下新增 MCP 协议端点
  - `/sse` - SSE 传输端点（传统方式），支持通过 URL 参数配置数据库连接
  - `/sse/message` - SSE 消息接收端点
  - `/mcp` (POST) - Streamable HTTP 端点（MCP 2025 规范，推荐），支持通过请求头配置数据库连接
  - `/mcp` (GET) - Streamable HTTP 的 SSE 流端点
  - `/mcp` (DELETE) - 关闭会话端点
- Dify 等平台现在可以直接通过 MCP 协议连接，无需使用自定义 API 工具
- 灵活架构：2 种启动模式（stdio/http），4 种接入方式（MCP stdio、MCP SSE、MCP Streamable HTTP、REST API）
- **统一 API Key 认证** - MCP SSE/Streamable HTTP 端点现在也支持 API Key 认证，与 REST API 保持一致

### 改进
- 更新架构文档，清晰区分启动模式和接入方式
- 更新 Dify 集成指南，添加 MCP 协议集成方式（SSE 和 Streamable HTTP）
- 更新 API 参考文档，添加 MCP 协议端点说明

### 安全
- 所有 HTTP 端点（包括 MCP SSE/Streamable HTTP）现在统一使用 API Key 认证
- 如果未配置 `API_KEYS` 环境变量，则跳过认证（开发模式）

## [2.5.0] - 2026

### 新增
- Oracle 11g 及以前老版本支持（通过 Thick 模式）

## [2.3.8] - 2026

### 修复
- Oracle、达梦执行 SQL 去掉分号

## [2.3.7] - 2026

### 修复
- 达梦 get_schema 问题修复

## [2.3.6] - 2026

### 修复
- 达梦 get_schema 问题修复

## [2.3.5] - 2026

### 修复
- 达梦 get_schema 问题修复

## [2.3.4] - 2026

### 修复
- 达梦 get_schema 问题修复

## [2.3.3] - 2026

### 修复
- 达梦 get_schema 问题，达梦不使用批量查询优化功能

## [2.3.2] - 2026

### 修复
- 达梦 get_schema 返回 table 为空问题处理

## [2.3.1] - 2026

### 修复
- 达梦适配器修复列名规范化、空值检查、类型安全

## [2.3.0] - 2026

### 性能优化
- 为 Oracle、达梦增加批量查询优化功能

## [2.2.0] - 2026

### 性能优化
- 批量查询优化，大幅提升 Schema 获取性能
- 支持的数据库：MySQL、PostgreSQL、SQL Server、Oracle、达梦等 13 个适配器

### 性能提升
| 表数量 | 优化前 | 优化后 | 提升 |
|--------|--------|--------|------|
| 50 张表 | ~5 秒 | ~200 毫秒 | 25x |
| 100 张表 | ~10 秒 | ~300 毫秒 | 33x |
| 500 张表 | ~50 秒 | ~500 毫秒 | 100x |

## [2.1.0] - 2026

### 新增
- Schema 缓存机制
- 缓存 TTL 配置
- 强制刷新功能
- 缓存统计信息

## [2.0.0] - 2026

### 新增
- HTTP API 模式
- 双模式架构（MCP + HTTP）
- API Key 认证
- 速率限制
- CORS 配置
- Docker 部署支持
- Serverless 部署配置（阿里云、腾讯云、AWS、Vercel）
- PaaS 部署配置（Railway、Render、Fly.io）

### 文档
- HTTP API 参考文档
- 部署指南
- 集成指南（Coze、n8n、Dify）

## [1.0.0] - 2026

### 新增
- 支持 17 种数据库
  - MySQL、PostgreSQL、Redis、Oracle、SQL Server
  - MongoDB、SQLite、达梦、KingbaseES、GaussDB
  - OceanBase、TiDB、ClickHouse、PolarDB
  - Vastbase、HighGo、GoldenDB
- MCP 协议支持
- 只读安全模式
- Claude Desktop 集成

---

## 版本号说明

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)：

- **主版本号**：不兼容的 API 修改
- **次版本号**：向下兼容的功能性新增
- **修订号**：向下兼容的问题修正
