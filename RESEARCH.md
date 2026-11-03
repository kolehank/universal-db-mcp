# universal-db-mcp 调研报告

> 调研日期：2026-11-02 ｜ 代码版本：v2.14.0（commit dc338cd）｜ 档位：完成度评估

## 1. 一句话结论

**能直接用。** 这是一个完成度高、工程规范、文档异常齐全的数据库 MCP 连接器：17 种数据库（含 8 个国产库）、4 种接入方式（MCP stdio / SSE / Streamable HTTP / REST API）、只读默认 + 细粒度权限、Schema 缓存、数据脱敏，全部有真实实现并通过了本地冒烟验证。但有三个前提要知道：项目自 2026-03-17 起已休眠约 7.5 个月（无新提交）；"只读保护"是关键词正则而非 SQL 解析器，属于防误操作的护栏而非安全边界；Windows + Node 24 上 `npm install` 会因 better-sqlite3 原生编译而失败（需 VS Build Tools 或 Node 20/22 LTS）。

## 2. 项目画像

- **定位**：让 Claude Desktop、Cursor、Dify 等 AI 平台通过自然语言直接查询数据库的 MCP 服务器，兼 REST API 网关。
- **核心特色**（与同类 MCP 数据库连接器的差异点）：
  1. **国产数据库覆盖最全**——达梦、人大金仓、华为 GaussDB、OceanBase、TiDB、PolarDB、Vastbase、瀚高、GoldenDB 一目了然，README 与 keywords 都明确主打中国市场。
  2. **双模式 + 四通道**——同一代码库同时是 MCP server（stdio）和 HTTP server（SSE/Streamable HTTP/REST），一套核心逻辑复用。
  3. **权限体系分层**——safe/readwrite/full/custom 四种模式，且四个传输通道各有对应参数（CLI / URL / Header / Body）。
  4. **v2.14 起支持对话中动态连库**——`connect_database` 工具让 AI 在会话里切换数据库，无需重启服务。
- **形态与技术栈**：Node.js ≥20 的 TypeScript CLI 服务（`npm install -g` 后作为 MCP server 或 HTTP server 运行）；源码 ~11.6k 行、42 个 TS 文件（`src/`），17 个适配器（`src/adapters/*.ts`）；依赖 mysql2 / pg / oracledb / mssql / mongodb / ioredis / better-sqlite3 / @clickhouse/client / dmdb；文档 164 个 markdown（含 55 个平台的 EN+zh-CN 集成指南）。
- **怎么用**：`npm install -g universal-db-mcp` → 在 Claude Desktop 配置 mcpServers（stdio 或零配置）→ 对话中直接问。HTTP 模式：`MODE=http API_KEYS=xxx npx universal-db-mcp` → `curl http://localhost:3000/api/health`。
- **活跃度**：GitHub 940 stars / 90 forks；npm 从 2026-01-22 创建到 2026-03-17 发布 2.14.0，**47 个版本集中在约 2 个月内**，之后无任何提交（git 与 npm 均已核实）；npm 下载约 470 次/月。结论：**爆发式起步后休眠**，社区仍在零星使用但项目已停更。

## 3. 架构与关键机制（简版数据流）

一条核心链路：**AI 客户端 → MCP/HTTP 层 → DatabaseService → 适配器 → 数据库驱动**。

- 入口分流：`src/index.ts:19-29` 按 `MODE` 选择 `http` 或 `mcp`。
- MCP 层：`src/mcp/mcp-server.ts` 用官方 `@modelcontextprotocol/sdk` 暴露 10 个工具（execute_query / get_schema / get_table_info / clear_cache / get_enum_values / get_sample_data / connect_database / disconnect_database / get_connection_status）；每个调用先过 `DatabaseService`。
- 核心服务：`src/core/database-service.ts:88-96` 执行前先 `validateQuery`（权限校验），再走 `adapter.executeQuery`；`getSchema` 带 5 分钟 TTL 缓存（`database-service.ts:102-142`）并附加隐式关系推断（`schema-enhancer.ts`）；`getSampleData` 结果经 `data-masking.ts` 脱敏。
- 适配器层：`src/utils/adapter-factory.ts:115-278` 按 17 种类型分发到具体适配器；适配器实现 `DbAdapter` 统一接口（`src/types/adapter.ts`），内部自带连接池 + 心跳 + 断线重试（如 `src/adapters/mysql.ts` 的 `withRetry`）。
- HTTP 层：`src/http/server.ts` Fastify 组装 CORS → 限流 → 鉴权（API Key）→ 路由；`src/core/connection-manager.ts` 管理多会话连接池，空闲 1 小时自动回收。

**扩展点**：官方留的缝就是协议本身——任何 MCP 客户端（stdio/SSE/Streamable HTTP）和任何 HTTP 客户端都能接；没有插件机制，二开入口是 `DbAdapter` 接口（加一种数据库 = 实现一个 adapter + 在工厂注册）。

## 4. 完成度核验

### 逐项核验表

| README 声称能力 | 状态 | 证据 | 说明 |
|---|---|---|---|
| 17 种数据库支持 | ✅ 完整 | `src/adapters/` 17 个实现文件；`adapter-factory.ts:123-277` 全部分发 | 实际是 5 类驱动协议：pg（PG/金仓/高斯/Vastbase/瀚高）、mysql2（MySQL/TiDB/OceanBase/PolarDB/GoldenDB）、oracledb、mssql、mongodb、ioredis、better-sqlite3、ClickHouse、dmdb。国产库靠协议兼容，符合事实 |
| 4 种接入方式（stdio/SSE/Streamable HTTP/REST） | ✅ 完整 | `mcp-server.ts:595`（stdio）；`http/routes/mcp-sse.ts:99,212,309,331`（SSE+Streamable HTTP）；`http/routes/` 下 connection/query/schema/health 路由（REST） | HTTP 冒烟实测通过 |
| 只读默认 + 细粒度权限 | ✅ 实现 | `src/utils/safety.ts:30-49`（权限解析）、`97-121`（校验拦截） | **实现是正则关键词扫描，见 §6 风险** |
| Schema 缓存（TTL 可配） | ✅ 完整 | `database-service.ts:102-142` | 5 分钟默认 TTL，命中率统计 |
| 批量查询优化（100x） | ⚠️ 部分 | 各适配器注释声明"批量查询避免 N+1"（如 `mysql.ts:3-5`） | **性能表"25x/33x/100x"无基准脚本/压测证据**，仅代码层面合理 |
| 多 Schema 自动发现 | ✅ 完整 | v2.12 修复；`getTableInfo` 三级匹配 `database-service.ts:175-205` | PostgreSQL/SQL Server/Oracle/达梦等 8 个适配器 |
| 数据脱敏 | ✅ 实现 | `src/utils/data-masking.ts`（7 类掩码规则 + 列名正则） | **按列名匹配，见 §6 风险** |
| 连接稳定性（池化/Keep-Alive/重试） | ✅ 实现 | `mysql.ts:43-71` 等，`connection-stability.test.ts` 53 个用例 | |
| 动态连接/切换数据库（v2.14） | ✅ 完整 | `mcp-server.ts:224-295`；MCP 冒烟实测 tools/list 返回 10 工具 | |
| 50+ 平台集成指南 | ✅ 完整 | `docs/integrations/` 共 110 个文件（55 平台 × EN+zh-CN） | 数量与声称一致 |
| 10 个 MCP 工具 | ✅ 完整 | `mcp-server.ts:52-215` 定义，MCP 冒烟实测返回 | |

### 未完成信号扫描

- `src/` 内 **0 个 TODO/FIXME/stub/mock**（grep 全目录无命中）。
- 测试：4 个单元测试文件 **88 个用例全部通过**（data-masking 20、connection-stability 53、config-loader 5、adapter-factory 10）；2 个集成测试文件 **8 个用例 6 过 2 挂**——两处失败均为**测试与新版行为脱节**，非生产代码缺陷：
  1. `tests/integration/http-api.test.ts:133` CORS 用例——测试发的 OPTIONS 请求不带 `Origin` 头，而 `@fastify/cors` v9 对无 Origin 预检直接回 400"Invalid Preflight Request"（实测：带 Origin 的真实浏览器预检返回 204 + 完整 CORS 头，正常）。
  2. `tests/integration/mcp-mode.test.ts:22` —— 测试仍断言"无适配器时 `start()` 必须抛错"，而 v2.14.0 把"无连接模式启动"做成了**正式特性**（`mcp-server.ts:586-592`）。
- **CI 缺口**：`.github/workflows/ci.yml` 只做 install + build + typecheck + `npm pack --dry-run`，**不跑任何测试**；lint job 是空占位。这解释了测试脱节为何没被发现。
- 版本号不一致：`src/mcp/mcp-server.ts:35`、`src/http/routes/health.ts:38`、`src/mcp/mcp-index.ts:22` 硬编码 `1.0.0`，而包版本是 2.14.0——MCP 客户端/`/api/info` 看到的 server 版本永远是 1.0.0。

### 运行环境核验（回答"能否直接拿来用"）

| 项 | 核验结果 |
|---|---|
| OS 绑定 | 跨平台（Windows/macOS/Linux），无平台独占代码 |
| Node 版本 | engines 要求 ≥20；**实测 Node 24.22.1 下 `npm install` 因 better-sqlite3 无预编译二进制、本机无 VS C++ Build Tools 而失败**；用 `--ignore-scripts` 安装后 build/typecheck/测试全部可跑。建议用户用 Node 20/22 LTS |
| 外部服务依赖 | 数据库本身是必需外部依赖（按需）；Oracle 需 Instant Client（`oracleClientPath` 参数）；达梦走 optionalDependencies 的 `dmdb`（装不上也不影响其他库） |
| 必需密钥 | 数据库账号密码必需（无默认）；HTTP 模式建议配 `API_KEYS`（不配则完全开放，仅限开发） |
| 安装链路 | `npm install -g` 在 Node 20/22 走预编译二进制应顺畅；本地源码构建已验证：`npm run build` ✅、`tsc --noEmit` ✅ |

## 5. 上手与落地路径（按投入从低到高）

| 方式 | 投入 | 能得到什么 | 前置条件 |
|---|---|---|---|
| ① 零改造直接用（推荐先试） | 低 | Claude Desktop/Cursor 里直接用自然语言查自己库；先只读跑通再决定是否开写 | Node 20/22；一个有只读账号的数据库；`npm install -g` 或 npx |
| ② HTTP 模式做数据服务 | 中 | REST API + SSE/Streamable HTTP 一套端口全开，接 Dify/n8n/Coze/自建前端（55 个集成指南照着配） | 服务器可访问目标库；配好 `API_KEYS` + `CORS_ORIGINS` + 限流（`.env.example` 有完整模板） |
| ③ fork 二开 | 高 | 加新库（实现 `DbAdapter` + 工厂注册一行）、增强 Text2SQL（schema-enhancer 已有关系推断地基）、修 CORS/版本号等已知小问题 | 需要自己维护（上游已休眠）；注意其权限校验是正则，接公网前必须加真解析/网关层 |

## 6. 风险与边界（常被误解的点）

1. **"只读模式"不是安全边界，是防误操作护栏。** `safety.ts` 的检测是"SQL 以关键词开头"的正则匹配（`safety.ts:54-74`），不是 SQL 解析器：它拦不住 `SELECT 1; DROP TABLE` 这类多语句注入（MySQL 适配器靠 `multipleStatements: false` 兜底，PG 的 pg 驱动默认也禁多语句，这是真正的防线）、也拦不住 `SELECT LOAD_FILE(...)`、`INTO OUTFILE` 这类藏在 SELECT 里的危险操作。**公网暴露必须用只读数据库账号/网关，README 的 best practice 正是如此，务必照做。**
2. **脱敏只覆盖英文列名。** `data-masking.ts:35-54` 的规则全是英文字段名正则（phone/email/id_card/bank_card…），中文列名（如 `手机号`）或非常规命名（`userPhone2`）不会命中；且脱敏只作用于 `get_sample_data`，`execute_query` 原样返回。库里有敏感数据时要注意。
3. **项目已休眠 7.5 个月。** 最后提交 2026-03-17；issues/PR 自然也没人处理。选型前先确认：没有需要上游修的 bug 再用。npm 下载量仍在（~470/月），说明有人用，但都是"用现状"。
4. **"17 种数据库"成色不一。** 国产库多为 pg/mysql 协议包装（如 `kingbase.ts` 用 pg 驱动、`oceanbase.ts` 用 mysql2），协议兼容是事实，但各库独有特性（分区语法、特殊运算符）得不到支持；达梦 `dmdb` 是 optional 依赖，装不上时达梦不可用。
5. **README 性能表无基准。** "25x/33x/100x" 是版本迭代声明的相对提升，仓库里没有压测脚本或基准数据可复现，只能当参考。
6. **HTTP 模式默认无鉴权。** `API_KEYS` 不配时所有端点开放（`auth.ts:33-35`），文档有警告但很容易忽略——公网部署第一件事就是配 key。

## 7. 值得学习的点

- **plan/done 文档纪律**：`docs/plan/` 与 `docs/done/` 一一对应（如 multi-schema-support），每个大功能先写方案再写复盘。怎么搬：给自己的功能开"方案→验收→复盘"双文档。
- **权限体系的分层 + 向后兼容**：`resolvePermissions`（`safety.ts:30-49`）把旧的 `allowWrite` 布尔值无缝映射到新模式，CLI 参数、URL、Header、Body 四通道统一语义。怎么搬：改配置格式时先做旧值的兼容解析层。
- **适配器接口抽象**：`DbAdapter`（`src/types/adapter.ts`）把 17 种数据库收敛成一套 connect/disconnect/executeQuery/getSchema 接口，上层逻辑（缓存、脱敏、权限）零感知数据库差异。怎么搬：多后端系统先定行为接口再写实现。

## 8. 后续可深挖的问题

1. Text2SQL 实际准确率如何？（本项目只提供工具与 schema，SQL 生成靠模型；schema-enhancer 的关系推断对准确率的实际增益未量化）
2. 各适配器 schema 批量查询的实现差异与性能对比（README 声称的 100x 是否站得住）。
3. 正则权限校验的可绕过性对抗测试（把 README 的 best practice 变成自动化测试）。
4. 若需继续用：是否值得 fork 后自行修掉 §4 的两个测试失败与版本号硬编码（都是小改）。