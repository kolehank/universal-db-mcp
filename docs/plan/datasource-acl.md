# 数据源注册表 + 按源 ACL 改造规格（交接文档）

> 版本：v1 ｜ 目标版本：3.0.0 ｜ 前置调研：`RESEARCH.md`
>
> **给执行者**：本文是唯一权威。凡本文未规定的实现选择，一律停下问人，不要自行发挥。
> 验收只看 §11 的用例表 + §12 的 CI 绿，不看口头描述。

---

## 1. 背景与目标

现状问题（已核实）：

| 问题 | 证据 |
|---|---|
| 客户端自报数据库地址，服务端不校验 | `src/http/routes/mcp-sse.ts:42-65`（SSE query）、`:242-254`（Streamable HTTP header）、`src/http/routes/connection.ts:24-47`（REST body） |
| 客户端自报权限模式，可自行提权 | `x-db-permission-mode` / `permissionMode` 直接进入 `DbConfig` |
| 任意合法 key 可连任意内网 host:port（SSRF 面） | 同上，无目标白名单 |
| `apiKeys: string[]` 无身份载体，无法做 ACL | `src/types/http.ts:15` |
| 远程会话暴露 `connect_database`，可绕开一切会话级限制 | `src/mcp/mcp-server.ts:224-295` |
| 无结构化审计 | 仅 pino 控制台日志，SQL 截断 100 字符（`mcp-server.ts:386`） |

目标：**服务端预注册数据源 + key→源白名单 + 服务端权威权限 + 结构化审计**；旧"客户端传凭据"通道默认关闭、可用开关显式开启。

---

## 2. 非目标（违反即返工）

1. **跨源 join / 联邦查询**：不做。理由：项目自始为单连接设计（`mcp-server.ts:24` 单 adapter、`database-service.ts:56-57` 单 config、`connection-manager.ts:63-70` 每会话单 adapter）；SQL 方言辅助按单库写死（`database-service.ts:501-559`）；无查询优化器；与本次 ACL/审计模型冲突。跨源需求由客户端多连 MCP server 或数据仓库解决。
2. **SSO/OIDC**：不做，身份由前置网关承担；**不信任任何网关身份头**（`X-Auth-User` 等），本期一律忽略。
3. **热更新注册表**：仅支持 HTTP 模式的 SIGHUP 全量重载（§7.1）；不支持按条目增量更新，不支持 HTTP/UI 管理接口。stdio 模式改配置需重连。
4. **启动时预连数据库**：只校验配置格式，不建立任何数据库连接。
5. **真 SQL 解析器**：权限校验仍是正则（`src/utils/safety.ts`），纵深防御靠只读数据库账号，写入部署文档。
6. **国密 TLS / 证书管理**：由外置代理承担。
7. **任何前端/UI**。
8. **不改 stdio 模式的存量 CLI 行为**（`--type/--host/...` 必须继续可用，见 §5.1）。

---

## 3. 配置规范（权威定义）

### 3.1 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATASOURCE_CONFIG` | HTTP 模式必填* | 注册表 JSON 绝对路径。*若未设置且 `ALLOW_ADHOC_CONNECTIONS=true`，走 legacy 模式并打印 WARN；两者都没有 → **启动失败**（fail-closed） |
| `ALLOW_ADHOC_CONNECTIONS` | 否 | `true` 时允许客户端传连接参数；默认 `false`。设置后覆盖配置文件同名字段 |
| `AUDIT_LOG_PATH` | 生产必填 | 审计 NDJSON 文件路径；未设置则审计关闭 + 启动 WARN |
| `TRUST_AUDIT_USER_HEADER` | 否 | `true` 时把 `X-Audit-User` 记入审计 `auditUser`；**仅用于审计关联，不参与任何授权判断**；默认 `false` |
| `API_KEYS` | 仅 legacy | 逗号分隔；`DATASOURCE_CONFIG` 存在时被忽略（不报错，打 WARN） |

### 3.2 注册表文件（JSON，`$schemaVersion: 1`）

```json
{
  "$schemaVersion": 1,
  "allowAdhocConnections": false,
  "adhocTargetAllowlist": ["10.1.2.3:3306", "db.internal:5432"],
  "apiKeys": [
    {
      "key": "${ENV:ACL_KEY_REPORTING}",
      "name": "reporting-bot",
      "allowedSources": ["finance-ro", "ops-ro"],
      "maxPermission": "safe"
    }
  ],
  "sources": [
    {
      "name": "finance-ro",
      "description": "财务库只读",
      "type": "mysql",
      "host": "${ENV:FINANCE_DB_HOST}",
      "port": 3306,
      "user": "${ENV:FINANCE_DB_USER}",
      "password": "${ENV:FINANCE_DB_PASSWORD}",
      "database": "finance",
      "maxPermission": "safe"
    }
  ]
}
```

> **注意区分两个字段**：顶层 `sources` 是**数据源定义**（含连接参数）；`apiKeys[].allowedSources` 只是**名字引用**，指向顶层定义里的 `name`，不重复任何连接信息。名字特意取得不同，避免混淆。
>
> **注意方向**：`adhocTargetAllowlist` 约束的是服务端**主动发起连接的数据库地址**（出站白名单），**不是**"哪些客户端 IP 可以访问本服务的 `/mcp` 端点"（入站白名单）。入站访问控制由 nginx / 防火墙 / 安全组承担，不在本应用内实现。

### 3.3 校验规则（启动即校验，失败 `exit 1`，**一次性列出所有错误**）

1. `${ENV:VAR}` 展开，支持出现在任意字符串值中；**引用的环境变量不存在 → 报错**（不允许静默空串）。
2. `source.name` 唯一，正则 `^[a-z0-9][a-z0-9_-]{0,63}$`。
3. `source.type` 必须通过 `normalizeDbType()`（`src/utils/adapter-factory.ts:50`）。
4. `maxPermission ∈ {safe, readwrite, full}`；**缺省视为 `safe`**。
5. `apiKeys[].key` 唯一且非空；`apiKeys[].name` 唯一、非空（审计主体）。
6. `apiKeys[].allowedSources` 每项必须已存在于顶层 `sources` 的 `name`（悬挂引用 → 报错）；**禁止 `*`**；数组为空或缺省 = 该 key 不能访问任何注册源。
7. `adhocTargetAllowlist` 仅接受 `host:port` 精确匹配（host 大小写不敏感），不支持 CIDR/通配符。
8. `type: sqlite` 的源必须有 `filePath` 且不得有 `host/port`。

### 3.4 TypeScript 类型（放 `src/types/http.ts` 或新模块，二者择一，不得重复定义）

```ts
type PermissionLevel = 'safe' | 'readwrite' | 'full';

interface DatasourceDef {
  name: string;
  description?: string;
  type: string; host?: string; port?: number;
  user?: string; password?: string; database?: string;
  filePath?: string; authSource?: string; oracleClientPath?: string;
  maxPermission?: PermissionLevel; // 默认 safe
}

interface ApiKeyDef {
  key: string; name: string;
  allowedSources: string[];        // 引用顶层 sources[].name，仅名字，不含连接信息
  maxPermission?: PermissionLevel; // 只能把 source 上限再压低
}

interface DatasourceRegistryConfig {
  $schemaVersion: 1;
  allowAdhocConnections?: boolean;
  adhocTargetAllowlist?: string[];
  apiKeys: ApiKeyDef[];
  sources: DatasourceDef[];
}
```

---

## 4. 权限模型（服务端权威）

### 4.1 生效权限算法（必须逐字实现）

```
sourceMax = SOURCE.maxPermission ?? 'safe'
keyMax    = KEY.maxPermission    ?? 'full'
effective = min(sourceMax, keyMax)     // 序：safe < readwrite < full
```

- 权限集合：`safe={read}`、`readwrite={read,insert,update}`、`full={全部}`。
- **客户端传入的 `permissionMode/permissions/allowWrite/X-DB-Permission-Mode/X-DB-Permissions` 一律忽略**；若其值宽于 `effective`，额外记一条 `event=permission_ignored` 审计。
- 写入权限仍生效于 `src/utils/safety.ts:97` 的 `validateQuery`，`DbConfig.permissionMode` 填 `effective` 对应的预设名。

### 4.2 决策表

| 场景 | 结果 |
|---|---|
| 请求带合法 `source`，key 的 `allowedSources`包含它 | 放行 |
| 请求带 `source`，key 的 `allowedSources`不包含 | **404** `SOURCE_NOT_FOUND`（与"源不存在"不可区分）+ 审计 `denied` |
| 请求带未知 `source` | 404 `SOURCE_NOT_FOUND` |
| 未带 `source`，存在 adhoc 字段，`allowAdhocConnections=false` | 403 `ADHOC_DISABLED` |
| 未带 `source`，adhoc 开启，目标不在 `adhocTargetAllowlist` | 403 `ADHOC_TARGET_DENIED` |
| 未带 `source`，adhoc 开启且（白名单为空 或 命中） | 放行（legacy 行为） |
| 未带任何连接参数 | 400 `INVALID_REQUEST` |

> 注：legacy 模式（无注册表、显式开 adhoc）下 `adhocTargetAllowlist` 为空 = 不限制，启动时打 WARN。

---

## 5. 各通道改造点

### 5.1 stdio（`src/mcp/mcp-index.ts`）—— 存量行为零变更

- 现有 `--type/--host/--port/--user/--password/--database/--file/...` **保持原语义**，不校验 ACL。
- 新增可选 `--config <path>` 与 `--source <name>`：
  - 只给 `--config`：注册表模式，无初始连接，等 AI 调 `connect_datasource`。
  - `--config` + `--source`：启动即连该源（用 §4.1 算法，key 不存在 → 取 `sourceMax`）。
  - 同时给 `--type` 与 `--config`：**报错退出**（`ambiguous config: use either --type or --config`）。
- 版本号改读 `package.json`（删掉硬编码 `1.0.0`，`mcp-index.ts:22`）。

### 5.2 SSE（`src/http/routes/mcp-sse.ts:99-155`）

- `parseDbConfigFromQuery` 增加 `source` 参数解析；**有 `source` 时忽略其余连接参数**。
- 无 `source` → 走 §4.2 决策（默认 403 `ADHOC_DISABLED`）。
- 无 `source` 且 adhoc 放行时，现有 `type/host/port/...` 逻辑保留。
- 会话创建时把 `principal`、`source`、`effectivePermission` 写入会话上下文（见 §8.1）。
- 会话建立后可通过 `connect_datasource` 在**该 key 的 `allowedSources`内**切源（§9）：切源时重判 ACL、清 schema 缓存、重绑审计源。

### 5.3 Streamable HTTP（`src/http/routes/mcp-sse.ts:212-303`）

- initialize 请求读取 `X-DB-Source`；**优先于** `X-DB-*`。
- 无 `X-DB-Source` → §4.2 决策（默认 400/403）。
- `X-DB-Permission-Mode` 等头不再参与权限计算（仅触发 `permission_ignored` 审计）。
- 后续带 `mcp-session-id` 的请求不重新解析连接参数（现状已如此，`mcp-sse.ts:221-226`，保持不变）。
- 会话建立后可通过 `connect_datasource` 在**该 key 的 `allowedSources`内**切源（§9），规则与 5.2 相同。

### 5.4 REST（`src/http/routes/connection.ts`）

- `POST /api/connect` body 新增 `source?: string`；schema 的 `required` 从 `['type']` 改为 `[]`，在 handler 内按 §4.2 判定（Fastify schema 无法表达条件必填，不要用 `anyOf` 硬凑）。
- `source` 存在 → 忽略 body 内其他连接字段。
- 错误码按 §6 表返回，`reply.code` 必须正确（现状恒 500，`connection.ts:68`，本次一并修）。

---

## 6. 错误码与响应格式

| code | HTTP | 出现位置 |
|---|---|---|
| `INVALID_REQUEST` | 400 | 无任何连接参数 |
| `ADHOC_DISABLED` | 403 | 注册表模式下传了 adhoc 参数 |
| `ADHOC_TARGET_DENIED` | 403 | adhoc 目标不在白名单 |
| `SOURCE_NOT_FOUND` | 404 | 未知源 或 key 无权（两者不可区分） |
| `PERMISSION_DENIED` | 403 | `validateQuery` 抛出的写权限拒绝，包装成此码 |
| `CONNECT_FAILED` | 502 | 数据库连接失败（替换现有 500） |

- REST/SSE：沿用 `{ success, error:{code,message}, metadata }` 信封（`src/types/http.ts:163-168`）。
- Streamable HTTP：JSON-RPC error，`code: -32001`，`data.code` 填上表 code。
- MCP 工具错误：`isError: true`，文本格式固定 `[<CODE>] <中文说明>`。
- **审计与响应的关系**：任何 `denied`/`permission_ignored` 必须落审计，即使响应是 404。

---

## 7. 会话语义

| 通道 | 会话与源的关系 | 换源方式 |
|---|---|---|
| stdio + config | 一会话可切源 | `connect_datasource`（本地可信，registry 内任意源） |
| SSE / Streamable HTTP + config | 一会话可切源，**只能在 key 的 `allowedSources`内** | `connect_datasource`；每次切换重判 ACL、清 schema 缓存、重绑审计源 |
| SSE / Streamable HTTP + legacy | 一会话可切源 | `connect_database`（原始参数，受 adhoc 开关与主机白名单约束） |
| REST | 会话锁死 `/api/connect` 的源 | `POST /api/disconnect` 后重新 connect |

为什么允许远程会话用工具切源：工具入参只有 `source` 名字，没有地址/密码/权限，ACL 在切换时用会话已确定的 principal 判定，不存在"重新解析连接参数"的歧义。注册表模式下，连接参数（地址/凭据）永远不经过客户端——客户端只传源名，服务端查表。这是"改判断"与"删工具"的分界线：能被可靠校验的输入才配留下。

---

### 7.1 SIGHUP 热加载（会话快照语义）

- **触发**：`kill -HUP <pid>`。**仅 HTTP 模式生效**；stdio 模式不注册该信号（SIGHUP 在 stdio 下保留"终端挂断即退出"的默认语义，避免产生孤儿进程）。Windows 不支持 SIGHUP，改配置需重启。
- **重载范围**：`sources`、`apiKeys`、`allowAdhocConnections`、`adhocTargetAllowlist`。
  **不重载**：监听端口/地址、日志级别、会话超时、`AUDIT_LOG_PATH`（进程级参数，需重启）。
- **原子性**：先完整加载 + 校验（与启动同一套规则），**全部通过才替换**；任一错误 → 保留旧配置 + ERROR 日志 + 继续服务，进程不退出。
- **会话快照**：已建立会话持有连接时的快照（连接参数 + 生效权限），重载本身不影响它们；新会话使用新配置。
- **例外（安全相关，必须主动处理）**：重载后逐会话检查，命中则关闭该会话并审计 `event=session_revoked`：
  - key 已删除（按 `keyFingerprint` 找不到）→ `reason=key_revoked`
  - 会话当前源已从该 key 的 `allowedSources` 移除 → `reason=source_revoked`
  - 会话当前源已从注册表删除 → `reason=source_removed`
- **凭据轮换**：同名源覆盖口令后，已连接会话仍持有旧连接池（旧口令）。要让新口令立即生效，需让会话重连或排空；文档必须写明这一点。
- **防重入**：重载进行中再次收到 SIGHUP → 忽略并打 WARN（不排队，避免连续 kill 造成风暴）。
- **审计**：每次重载记 `event=config_reload`，含配置文件 sha256、源/key 数量、被关闭会话数。
- **实现位置**：`src/security/datasource-registry.ts` 暴露 `reload()`（返回新实例，由调用方原子替换引用）；`src/http/http-index.ts` 注册 `process.on('SIGHUP', ...)`。

## 8. 审计（最小集）

### 8.1 上下文传递

用 Node 内置 `AsyncLocalStorage<AuditContext>`（新文件 `src/security/audit-context.ts`）：

```ts
interface AuditContext {
  requestId: string; transport: 'stdio'|'sse'|'streamable'|'rest';
  principal: string;        // apiKeys[].name，stdio 固定 'local'
  keyFingerprint: string;   // sha256(key) 前 12 位，禁止记录明文 key
  source: string;           // 源名；adhoc 固定 'adhoc'
  clientIp: string;
  auditUser?: string;       // 仅 TRUST_AUDIT_USER_HEADER=true 时取 X-Audit-User；调用方声明，仅审计关联
}
```

- HTTP：auth 中间件里 `auditContext.run(ctx, next)`（`src/http/middleware/auth.ts`）。
- stdio：MCP 工具 handler 入口设置（`mcp-server.ts` 的 `CallToolRequestSchema` 分支）。
- **每次工具调用都必须按会话当前源重新绑定 `source`**（切源后不得沿用 initialize 时的值）；否则切换后的操作会被审计记到旧的源上。

### 8.2 记录点与格式

记录点（必须覆盖）：`DatabaseService.executeQuery`、`getEnumValues`、`getSampleData`；`getSchema`、`getTableInfo` 记 `event=metadata`（可只记耗时）；`ConnectionManager.connect/disconnect`；`mcp-server` 的 `connect_datasource/disconnect_database`；所有 ACL 拒绝。

每行一个 JSON（NDJSON），字段固定：

```json
{"ts":"2026-11-03T10:00:00.000Z","event":"query","requestId":"req-1","transport":"rest",
 "principal":"reporting-bot","keyFingerprint":"ab12cd34ef56","source":"finance-ro",
 "clientIp":"10.0.0.9","sql":"SELECT ...","sqlBytes":123,"sqlTruncated":false,
 "status":"ok","errorCode":null,"rows":12,"durationMs":34}
```

规则：
- `sql` 截断 2048 字符，截断时 `sqlTruncated: true`。
- 拒绝事件 `event=denied`，`errorCode` 必填，`sql` 可空。
- **stdio 模式下绝对不能写 stdout**（会污染 JSON-RPC 帧）；审计只写 `AUDIT_LOG_PATH` 文件或 stderr。
- 写失败：打 stderr + 计数，**不阻断请求**。
- 轮转交给外部（logrotate/journald），应用内不做轮转。
- `auditUser` 字段仅在 `TRUST_AUDIT_USER_HEADER=true` 时出现；它是调用方声明值，**只用于审计关联，绝不参与授权**。

---

## 9. MCP 工具按上下文裁剪（关键安全修复）

`DatabaseMCPServer` 增加 `toolProfile: 'legacy' | 'registry-stdio' | 'remote'`，`ListToolsRequestSchema` 按 profile 返回：

| profile | 暴露工具 | 连接工具的契约 |
|---|---|---|
| `legacy-stdio`（stdio 无 config） | 现有 10 个，不变 | `connect_database`（原始参数，行为与 2.14.0 完全一致，本地可信进程） |
| `registry`（stdio 或远程，有 config） | 查询类 6 个 + `clear_cache` + `get_connection_status` + **`connect_datasource`** + **`list_datasources`** + `disconnect_database` | **只收 `source` 名字**；`additionalProperties: false`；地址/账号/密码/权限参数一律不接受 |
| `legacy-remote`（无 config + `ALLOW_ADHOC_CONNECTIONS=true`） | 现有 10 个 | `connect_database` 原始参数，但目标必须命中 `adhocTargetAllowlist`（若配置），未命中返回 `[ADHOC_TARGET_DENIED]` |

- 注册表模式**不暴露 `connect_database`**（调用方得到 unknown tool，而不是"再试一次"的错误提示，避免模型反复重试）。
- `list_datasources` 返回：stdio 为全部源；远程为该 key 的 `allowedSources`内的源。均只含 `name/type/description`，**不含 host/port/user/password**。
- `get_connection_status` 增加 `source` 字段（当前连接源）；切源后必须随之变化。
- 远程 `connect_datasource` 每次调用按序执行：查 key 的 `allowedSources` → 未命中返回 `isError` + `[SOURCE_NOT_FOUND]` 并审计 `denied` → 命中则断开旧连接、清 schema 缓存、按 §4.1 重算权限、重绑审计源、审计 `event=connect`。
- `connect_datasource` 的 `source` 在 stdio 模式下不受 key 的 `allowedSources`限制（本地可信），但仍必须在注册表内，否则 `[SOURCE_NOT_FOUND]`。
- `legacy-remote` 下客户端仍可自报 `permissionMode/allowWrite`（与 2.x 同），这是开关的代价；生产必须用注册表模式，写进 `MIGRATION-3.0.md`。

---

## 10. 变更文件清单

### 新增

| 文件 | 内容 |
|---|---|
| `src/security/datasource-registry.ts` | 类型、加载、`${ENV:}` 展开、校验、`resolveSource(name)`、`resolvePermission()`、`isAdhocAllowed(target)` |
| `src/security/audit-context.ts` | `AsyncLocalStorage` + `getAuditContext()` |
| `src/security/audit-logger.ts` | NDJSON 写入（`AUDIT_LOG_PATH`）、截断、失败降级 |
| `tests/unit/datasource-registry.test.ts` | 加载/展开/校验/权限算法，≥20 例 |
| `tests/unit/acl-decision.test.ts` | §4.2 决策表逐行覆盖，≥10 例 |
| `tests/unit/registry-reload.test.ts` | §7.1 重载语义：原子替换、非法配置不生效、会话吊销判定，≥8 例 |
| `tests/integration/acl-http.test.ts` | §11 用例表的 HTTP 子集（起真实 server + inject） |
| `docs/guides/datasource-acl.md` | 配置说明 + 等保对照；必须写清"出站目标白名单（`adhocTargetAllowlist`）≠ 入站 IP 白名单"，后者由 nginx/安全组承担并给出示例 |
| `MIGRATION-3.0.md` | 从 2.x 升级步骤 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/types/http.ts` | 新增 §3.4 类型；`ConnectRequest` 加 `source?` |
| `src/utils/config-loader.ts` | 读 §3.1 环境变量；无 config 且未开 adhoc → `process.exit(1)`（仅 HTTP 模式） |
| `src/http/server.ts` | 构造 registry，注入中间件与路由 |
| `src/http/http-index.ts` | 注册 `SIGHUP` → `registry.reload()`（仅 HTTP 模式；防重入；失败保留旧配置） |
| `src/http/middleware/auth.ts` | key→principal 解析（registry 模式查表）；注入 AuditContext |
| `src/http/routes/mcp-sse.ts` | §5.2/§5.3 |
| `src/http/routes/connection.ts` | §5.4 + 错误码修正 |
| `src/http/routes/query.ts` `schema.ts` | 无逻辑改动，确认错误码透传 |
| `src/mcp/mcp-server.ts` | toolProfile（registry/legacy × stdio/remote）、`connect_datasource`、`list_datasources`、会话当前源状态、权限算法、审计按次重绑、版本号 |
| `src/mcp/mcp-index.ts` | `--config`/`--source`、冲突校验、版本号 |
| `src/http/routes/health.ts` | 版本号读 `package.json`；`/api/info` **不得**暴露源名 |
| `src/core/connection-manager.ts` | `connect(def, ctx)` 接受注册表解析结果；审计 connect/disconnect |
| `src/core/database-service.ts` | 审计记录点（§8.2）；不改权限校验逻辑 |
| `package.json` | `version: "3.0.0"` |
| `.env.example` | 新增 §3.1 三个变量 |
| `.github/workflows/ci.yml` | 新增 test job（见 §12） |
| `README.md` `README.zh-CN.md` | 安全章节加 ACL 小节 + 指向 `MIGRATION-3.0.md` |
| `docs/http-api/API_REFERENCE.md` | `/api/connect` 增加 `source`；错误码表 |
| `docs/integrations/DIFY.md` `DIFY.zh-CN.md` `CHATGPT.md` `CHATGPT.zh-CN.md` | 改为 `X-DB-Source` 示例 |
| `CHANGELOG.md` | 3.0.0 breaking change 段 |

**不要动**：`src/adapters/**`、`src/utils/safety.ts`、`src/utils/data-masking.ts`、`src/utils/schema-enhancer.ts`、`src/test.ts`、其余 51 个集成文档。

---

## 11. 验收用例表（可执行，逐条勾）

启动前准备：`fixtures/registry.json` 含 2 个源（`ok-ro` 合法、`ok-rw` 可写）、2 个 key（`k-full` 允许两源、`k-ro` 只允许 `ok-ro`）。

| # | 前置 | 请求 | 期望 |
|---|---|---|---|
| 1 | 无 `DATASOURCE_CONFIG`、无 `ALLOW_ADHOC_CONNECTIONS` | 启动 HTTP | 进程退出码 1，stderr 含 `DATASOURCE_CONFIG` |
| 2 | 正常 config | `MODE=http` 启动 | 成功；**不**尝试连接任何数据库 |
| 3 | 正常 config | `POST /api/connect {type:"mysql",host:...}`（无 source） | 403 `ADHOC_DISABLED` + 审计 `denied` |
| 4 | 正常 config | `POST /api/connect {source:"ok-ro"}`，key=`k-ro` | 200，返回 sessionId |
| 5 | 正常 config | `POST /api/connect {source:"ok-rw"}`，key=`k-ro` | 404 `SOURCE_NOT_FOUND`（不是 403）+ 审计 `denied` |
| 6 | 正常 config | `POST /api/connect {source:"nope"}` | 404 `SOURCE_NOT_FOUND` |
| 7 | 正常 config | `POST /api/query {sessionId, query:"DELETE FROM t"}`，源 `ok-ro` | 403 `PERMISSION_DENIED` + 审计 `denied` |
| 8 | 正常 config | `POST /api/connect {source:"ok-ro", password:"x"}` | 200，但密码被忽略（用注册表凭据）；审计 `permission_ignored` 不出现（密码不算权限） |
| 9 | config 中 `ok-rw.maxPermission=readwrite`，key `k-full.maxPermission=safe` | 连 `ok-rw` 后执行 `INSERT` | 403 `PERMISSION_DENIED`（取 min） |
| 10 | 正常 config | `POST /mcp` initialize 带 `X-DB-Source: ok-ro` + `X-DB-Permission-Mode: full` | 会话建立；后续 `INSERT` 被拒（客户端提权无效）+ 审计 `permission_ignored` |
| 11 | 正常 config | `POST /mcp` initialize 带 `X-DB-Type/mysql` 无 `X-DB-Source` | 403 `ADHOC_DISABLED` |
| 12 | 正常 config | `GET /sse?type=mysql&host=...` | 403 `ADHOC_DISABLED` |
| 13 | 正常 config | `GET /sse?source=ok-ro` | 200 SSE 建立 |
| 14 | 远程 MCP 会话建立后 | `tools/list` | 含 `connect_datasource`/`list_datasources`；**不含** `connect_database` |
| 14a | key 的 `allowedSources`含 A、B；initialize 用 A | `connect_datasource {source:"B"}` 后查询 | 成功；后续审计 `source=B`（不是 A） |
| 14b | key 的 `allowedSources`只含 A；initialize 用 A | `connect_datasource {source:"B"}` | `isError`，文本含 `[SOURCE_NOT_FOUND]` + 审计 `denied`；原连接 A 仍可用 |
| 14c | registry 模式（stdio 或远程） | 调用 `connect_database` | unknown tool（不在 `tools/list` 中） |
| 14d | legacy-remote，`adhocTargetAllowlist:["10.1.2.3:3306"]` | `connect_database {host:"10.9.9.9",port:3306,...}` | `isError`，文本含 `[ADHOC_TARGET_DENIED]` |
| 14e | key 的 `allowedSources`含 A、B | `list_datasources` | 仅返回 A、B 的 name/type/description，无 host/port/user/password |
| 14f | stdio 有 config | `connect_datasource {source:"不存在"}` | `isError`，文本含 `[SOURCE_NOT_FOUND]` |
| 15 | 远程 MCP 会话 | 调用 `execute_query` | 正常；审计 `source=ok-ro`、`principal=key 名` |
| 16 | `ALLOW_ADHOC_CONNECTIONS=true` + `adhocTargetAllowlist:["10.1.2.3:3306"]` | `POST /api/connect {type:"mysql",host:"10.9.9.9",port:3306}` | 403 `ADHOC_TARGET_DENIED` |
| 17 | 同上 | `POST /api/connect {type:"mysql",host:"10.1.2.3",port:3306,...}` | 放行（连接失败时 502，不是 403） |
| 18 | stdio 无 config | `--type mysql --host ...` | 与 2.14.0 行为一致（工具 10 个、可连接） |
| 19 | stdio 有 config | `--config fixtures/registry.json` + `tools/list` | 含 `connect_datasource`/`list_datasources`，不含 `connect_database` |
| 20 | stdio 有 config | `--config ... --source ok-ro` | 启动即连；`get_connection_status` 返回 `source:"ok-ro"` |
| 21 | stdio 有 config | `--config ... --type mysql` | 退出码 1，报 `ambiguous` |
| 22 | 正常 config + `AUDIT_LOG_PATH=/tmp/a.ndjson` | 上述任一查询 | 文件出现一行 NDJSON，含 §8.2 全部字段 |
| 23 | 正常 config | `GET /api/info`（无鉴权） | 响应**不含**任何源名 |
| 24 | 任何模式 | `npm run build` / `npx tsc --noEmit` / `npm test` | 全绿 |
| 25 | 运行中，配置新增源 `new-ro` | `kill -HUP <pid>` 后新会话 `connect {source:"new-ro"}` | 成功；重载前已建会话不受影响 |
| 26 | 运行中，删掉 key `k-ro` | `kill -HUP <pid>` | 该 key 已建 MCP 会话被关闭 + 审计 `session_revoked`（`key_revoked`）；其他 key 会话不受影响 |
| 27 | 运行中，配置改成悬挂引用（非法） | `kill -HUP <pid>` | 进程不退出，继续用旧配置；日志 ERROR；旧会话仍可用 |
| 28 | 运行中，把源 `ok-ro` 从注册表删除 | `kill -HUP <pid>` | 使用该源的会话被关闭（`source_removed`）；新 connect 返回 404 |
| 29 | stdio 有 config | 向进程发 SIGHUP | 进程按默认语义退出（不执行重载） |

---

## 12. CI 与存量测试

1. `.github/workflows/ci.yml` 新增 `test` job（Node 20/22）：`npm ci` → `npm run build` → `npm run test:unit` → `npm run test:integration`。原 `lint` 空 job 删除。
2. **修掉两个存量失败测试**（`npm test` 必须全绿，否则新测试无法判定）：
   - `tests/integration/http-api.test.ts:130-138`：预检请求补 `origin` + `access-control-request-method` 头，断言 204 与 `access-control-allow-methods`（`@fastify/cors` v9 对无 Origin 预检回 400，是测试过时，不是服务端缺陷）。
   - `tests/integration/mcp-mode.test.ts:22-32`：删除"无适配器必须抛错"断言（v2.14.0 起无连接启动是正式特性，`mcp-server.ts:586-592`），改为断言 `start()` 正常返回且 `get_connection_status` 报未连接。
3. 新增测试必须能离线跑（不起真实数据库）；集成测试用 `server.inject()`。

---

## 13. 实施顺序（每 Phase 独立可验收）

| Phase | 内容 | 通过后验证 |
|---|---|---|
| P0 | §3 注册表模块 + 校验 + 单测 | `npm run test:unit` 通过；用例 1、2 |
| P1 | auth 主体解析 + REST ACL + 错误码 | 用例 3–7、9 |
| P2 | SSE / Streamable + toolProfile=remote | 用例 8、10–15、23 |
| P3 | stdio `--config/--source` + 新工具 | 用例 18–21 |
| P4 | 审计 | 用例 22 |
| P5 | SIGHUP 热加载 + 会话快照/吊销 | 用例 25–29 |
| P6 | 文档、版本号、CI、存量测试修复 | 用例 24 + `npm test` 全绿 |

**每 Phase 结束必须 `git commit` 一次**，commit message 前缀 `feat(acl): P<N> ...`，便于出问题单独回滚。

---

## 14. 现有代码锚点（供执行者定位，行号以当前 HEAD 为准）

- 通道入口解析：`src/http/routes/mcp-sse.ts:42-65`、`:242-254`；`src/http/routes/connection.ts:24-47`
- 鉴权：`src/http/middleware/auth.ts:12-70`（health/info 白名单在 `:18`）
- 权限校验：`src/utils/safety.ts:30-121`
- 工具定义：`src/mcp/mcp-server.ts:52-215`；`connect_database` 实现 `:224-295`
- 服务层缓存与查询：`src/core/database-service.ts:88-142`、`:326-458`
- 会话管理：`src/core/connection-manager.ts:49-129`
- 版本号硬编码：`src/mcp/mcp-server.ts:35`、`src/http/routes/health.ts:38`、`src/mcp/mcp-index.ts:22`
