# MIGRATION-3.0（从 2.x 升级指南）

> 适用范围：2.x → 3.0.0。配套文档：
> - 运维手册：[docs/guides/datasource-acl.md](./docs/guides/datasource-acl.md)
> - HTTP API：[docs/http-api/API_REFERENCE.md](./docs/http-api/API_REFERENCE.md)

## 1. 3.0 变在哪

一句话：**数据库连接参数从"客户端自报"改为"服务端注册表唯一权威"**。

| 维度 | 2.x | 3.0 |
|---|---|---|
| 连接参数来源 | 客户端（CLI 参数 / URL / Header / Body） | 服务端注册表文件 `sources[]` |
| key 语义 | `API_KEYS` 平权（能连任意库） | 每把 key 有 `allowedSources` 白名单（key→源） |
| 权限 | 客户端自报 `permissionMode`/`allowWrite` | 服务端计算 `min(源.maxPermission ?? safe, key.maxPermission ?? full)`，客户端自报一律忽略 |
| 审计 | 无结构化审计 | NDJSON（`AUDIT_LOG_PATH`），8 类事件 |
| 配置变更 | 改环境变量后重启 | `SIGHUP` 热加载（仅 HTTP 注册表模式；失败保留旧配置） |
| HTTP 原始参数通道 | 默认开 | **默认关**（fail-closed：无注册表且未开 adhoc 拒绝启动） |

## 2. 升级步骤

### 2.1 盘点现有调用方

列出所有连接本服务的平台/脚本：谁在连、连的什么库、用的什么权限。**每个调用方分配一把 key + 一个 `name`**（建议"平台名-用途"，如 `dify-prod`）。不要共用 key：共用会导致审计无法归因到具体调用方。

### 2.2 分配 API key（`apiKeys[]`）

在注册表头部定义 `apiKeys[]`。`key` 建议用 `${ENV:VAR}` 注入（如 `openssl rand -hex 32` 生成），`name` 唯一（审计主体），`allowedSources` 先按现状全量枚举。

### 2.3 把连接参数搬进 `sources[]`

把现存在启动命令 / 请求体里面的 `type`、`host`、`port`、`user`、`password`、`database` 逐库搬进 `sources[]`；口令一律改成 `${ENV:VAR}`，不要写明文。`maxPermission` 一律从 `safe` 起步（见 2.4 收窄）。

> `${ENV:VAR}` 引用的环境变量不存在时启动校验直接失败（不允许静默空串）。

### 2.4 权限收窄

- 生效权限 = `min(源.maxPermission ?? safe, key.maxPermission ?? full)`，两处都可设；
- 无写需求就设 `safe`；确有写需求的源单独评估（源级 + key 级双重收紧）；
- 注册表模式下客户端传来的 `permissionMode`/`allowWrite`/`X-DB-Permission-Mode` **一律忽略**；若自报权限宽于生效权限，仅审计 `permission_ignored`（不会提权生效）。

### 2.5 启动 3.0 并关闭 adhoc

- HTTP 模式：`DATASOURCE_CONFIG=/path/to/registry.json`；`ALLOW_ADHOC_CONNECTIONS` **保持不设**（默认 `false`）——HTTP 原始参数通道默认关闭；
- stdio：`--config <path>`（可加 `--source <name>` 启动即连；只给 `--config` 时无连接启动，等 `connect_datasource`）；
- 注册表 JSON 校验不过 → 拒绝启动，一次性列出全部错误（含 `$schemaVersion` 必须为 1、悬挂引用、非法权限值等）。

### 2.6 观察审计里的 `denied`

上线后观察 `AUDIT_LOG_PATH` 审计文件中的 `denied` 事件：

| 错误码 | 含义 | 处置 |
|---|---|---|
| `SOURCE_NOT_FOUND` | 源名拼错，或 `allowedSources` 没包含它 | 修源名 / 补白名单 |
| `ADHOC_DISABLED` | 客户端还在传原始参数（`type/host`） | 改 `source`，或临时开开关 |
| `ADHOC_TARGET_DENIED` | 临时 adhoc 目标不在 `adhocTargetAllowlist` | 加白名单或改用注册源 |
| `PERMISSION_DENIED` | 语句类型超出生效权限 | 收紧/评估 `maxPermission`；查 `permission_ignored` |

拒绝事件必须进告警（等保：审计 + 告警）。切源/权限类误配一般集中在切换后的头两天。

### 2.7 稳定后删除 `API_KEYS`

观察约 2 周无异常后：

- 删除 `API_KEYS` 环境变量与 2.x 遗留启动脚本（注册表模式下它本来就**被忽略**——鉴权改走注册表 `apiKeys[]`）；
- 若迁移期开了 adhoc，确认已 `allowAdhocConnections: false`；
- 删除 2.x 客户端侧的 `--type/--host/--password` 等参数与请求体里的连接字段。

## 3. 错误码对照表（2.x 旧行为 → 3.0 新行为）

| 场景 | 2.x | 3.0（HTTP 注册表模式） |
|---|---|---|
| `POST /api/connect` 传 `type/host/...`（无 `source`） | 直接连库 | `403 ADHOC_DISABLED`（+ 审计 `denied`） |
| 完全不带任何连接参数 | 400（缺少必填参数） | `400 INVALID_REQUEST` |
| `source` 不存在 / key 无权 | （无 source 概念） | `404 SOURCE_NOT_FOUND`（故意不区分，防枚举） |
| adhoc 目标不在白名单 | 放行 | `403 ADHOC_TARGET_DENIED` |
| 写操作超权限 | `500 QUERY_FAILED`（只读模式消息） | `403 PERMISSION_DENIED`（+ 审计 `denied`） |
| 连库失败 | `500 CONNECTION_FAILED` | `502 CONNECT_FAILED` |
| 缺 key / key 非法 | 401 / 403 | 不变（`401 UNAUTHORIZED` / `403 FORBIDDEN`） |
| 远程 MCP 工具集 | 10 个工具，含 `connect_database` | 注册表模式为 `connect_datasource` + `list_datasources`，**不含** `connect_database`（调用得到 unknown tool，不是"再试一次"） |
| MCP 工具 ACL 拒绝 | 普通错误文本（"执行失败: ..."） | `isError` + 文本固定 `[<CODE>] 中文说明`（如 `[SOURCE_NOT_FOUND] 源不存在或当前 API key 无权访问`） |
| Streamable HTTP 初始化被拒 | 不一定 | JSON-RPC `error.code = -32001`，具体码在 `error.data.code`，HTTP 状态码同 REST |
| HTTP 模式启动 | 无注册表也能起 | 无 `DATASOURCE_CONFIG` 且未显式 `ALLOW_ADHOC_CONNECTIONS=true` → 启动失败（exit 1） |
| `/api/info` | 硬编码 1.0.0 | 版本号改读 package.json |

## 4. 特权说明：legacy 通道的代价（务必读）

- stdio 的 `--type/--host/...` 与 `connect_database` 行为与 2.x **完全一致**（本地可信进程，无网络面）；
- **legacy-remote**（无注册表 + `ALLOW_ADHOC_CONNECTIONS=true`）是唯一仍允许客户端自报连接参数与权限模式的远程通道：`permissionMode`/`allowWrite` 与 2.x 一样**直接生效**——这是打开该开关的代价。`ADHOC_TARGET_ALLOWLIST` 可限定出站目标 `host:port`，但**无法**限制客户端声明的权限；
- **生产环境必须用注册表模式**。legacy-remote 只适合迁移期/可信内网临时使用，且迁移窗口应尽快收窄；
- 迁移不彻底（长期保留 adhoc 打开）意味着：任何拿到合法 key 的客户端仍可自报连接参数探内网（SSRF 面），与 3.0 "按源白名单 + 服务端权威权限" 的设计目标相悖。请按 §2.5/§2.6 流程尽快关闭。

## 5. stdio 兼容性声明

- 存量选项 `--type/--host/--port/--user/--password/--database/--file/--auth-source/--oracle-client-path/--danger-allow-write/--permission-mode/--permissions` **行为逐字不变**（含 `--type` 缺省时的无连接启动）；
- **新增选项**：
  - `--config <path>`：数据源注册表 JSON 路径（注册表模式，与 `--type` 二选一）；
  - `--source <name>`：注册表模式下启动即连接的源名（需与 `--config` 配合使用）；
- 约束：
  - `--type` 与 `--config` 同时给出 → 报错退出（ambiguous config）；
  - `--source` 无 `--config` → 报错退出；
  - 只给 `--config`：无连接启动，等 AI 调 `connect_datasource`；
  - `--config` + `--source`：启动即连（stdio 无 key，生效权限取源级 `maxPermission`）；
- **SIGHUP**：无 `--config` 的 stdio 进程收到 SIGHUP 按默认语义退出（2.x 行为）；热加载只在 **HTTP 注册表模式**注册。

## 6. 回滚

- 配置改错了：改回 `registry.json`（`git revert`）→ `kill -HUP` 即恢复旧配置（重载失败也会保留旧配置继续服务）；
- 删了不该删的 key/源：改回 → HUP；注意被吊销的会话已被主动关闭（`session_revoked`），客户端需重连；
- 环境变量（`*_PWD`、`AUDIT_LOG_PATH` 等）改错需**重启**——`SIGHUP` 只重新读取注册表 JSON，不重新加载进程环境；
- Windows 无 SIGHUP：改配置需重启服务。

## 7. 上线检查清单

- [ ] 所有调用方都有独立 key + `name`（无共用 key）
- [ ] 注册表 `$schemaVersion: 1`，启动校验通过（一次性列全部错误）
- [ ] 口令全部 `${ENV:VAR}`，无明文
- [ ] `ALLOW_ADHOC_CONNECTIONS` 未设置（默认 `false`）
- [ ] `AUDIT_LOG_PATH` 已配置（未配置会 WARN 并禁用审计），`denied` 已接告警
- [ ] `API_KEYS` 已删除，客户端侧原始连接参数已移除
- [ ] 每个源 `maxPermission` 已按最小权限收窄