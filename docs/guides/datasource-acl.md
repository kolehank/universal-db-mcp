# 数据源注册表与访问控制 · 运维手册

> 适用版本：3.0.0+ ｜ 配套规格：`docs/plan/datasource-acl.md`
> 读者：部署运维、安全管理员、等保测评配合人员

---

## 1. 这份文档解决什么问题

3.0 起，数据库连接参数**不再由客户端传入**，而是集中写在服务端的一份注册表文件里；每个 API key 只能使用白名单内的数据源，权限模式由服务端决定，所有查询落审计。

没有 Web 管理界面是刻意的设计：注册表进 git，每次变更都有 diff、提交人、评审记录和回滚点，这比任何 UI 都更适合等保的"配置变更留痕"。

本文覆盖：配置怎么写、服务怎么暴露、配置怎么改、审计怎么接、出问题怎么查。

---

## 2. 概念模型

| 概念 | 含义 | 出现位置 |
|---|---|---|
| 数据源（source） | 一个数据库连接的完整定义：类型、地址、账号、口令、权限上限 | 顶层 `sources[]` |
| 主体（principal） | 一把 API key 对应的调用方身份，如 `reporting-bot` | `apiKeys[].name` |
| 源白名单 | 某把 key 被允许使用哪些**已注册源**（只写名字） | `apiKeys[].allowedSources` |
| 权限上限 | 源级 `maxPermission` 与 key 级 `maxPermission` 取小 | 两处均可设 |
| adhoc | 迁移期兼容通道：允许客户端传原始 host/port | `allowAdhocConnections` |
| adhoc 目标白名单 | adhoc 模式下服务端允许连到的**数据库地址**（出站） | `adhocTargetAllowlist` |

> **方向别搞混**：`adhocTargetAllowlist` 限制的是"服务端能替你连到哪"（出站），**不是**"哪些客户端 IP 能访问本服务"（入站）。入站控制在 §5。

---

## 3. 配置参考

### 3.1 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `MODE` | 是 | `mcp` | `http` 或 `mcp`（stdio） |
| `DATASOURCE_CONFIG` | HTTP 模式必填* | 无 | 注册表 JSON 绝对路径 |
| `ALLOW_ADHOC_CONNECTIONS` | 否 | `false` | 开启后允许客户端传原始连接参数；覆盖配置同名字段 |
| `ADHOC_TARGET_ALLOWLIST` | 否 | 空 | 逗号分隔的 `host:port`，仅 adhoc 模式生效；配置文件字段优先 |
| `AUDIT_LOG_PATH` | 生产必填 | 无 | 审计 NDJSON 文件；不设则审计关闭并 WARN |
| `TRUST_AUDIT_USER_HEADER` | 否 | `false` | `true` 时允许审计记录携带 `auditUser` 字段（仅审计关联，不参与授权）。注意：当前实现**不自动读取** `X-Audit-User` 请求头，该字段需由接入层/调用方注入审计上下文（见 §5.8） |
| `API_KEYS` | 仅 legacy | 空 | 逗号分隔；有 `DATASOURCE_CONFIG` 时忽略 |
| `HTTP_PORT` / `HTTP_HOST` | 否 | 3000 / 0.0.0.0 | **暴露面由这两个值决定**，见 §5 |
| `SESSION_TIMEOUT` | 否 | 3600000 | 会话空闲回收（毫秒） |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW` | 否 | 100 / 1m | 限流 |

\* 既无 `DATASOURCE_CONFIG` 又未开 `ALLOW_ADHOC_CONNECTIONS` → HTTP 模式**启动失败**（fail-closed）。

### 3.2 注册表文件

```json
{
  "$schemaVersion": 1,
  "allowAdhocConnections": false,
  "adhocTargetAllowlist": [],
  "apiKeys": [
    {
      "key": "${ENV:ACL_KEY_AGENT}",
      "name": "agent-platform",
      "allowedSources": ["finance-ro", "ops-ro"],
      "maxPermission": "safe"
    }
  ],
  "sources": [
    {
      "name": "finance-ro",
      "description": "财务库只读（生产副本）",
      "type": "mysql",
      "host": "${ENV:FINANCE_DB_HOST}",
      "port": 3306,
      "user": "${ENV:FINANCE_DB_USER}",
      "password": "${ENV:FINANCE_DB_PASSWORD}",
      "database": "finance",
      "maxPermission": "safe"
    },
    {
      "name": "ops-rw",
      "description": "运维库（仅允许写入，不给删）",
      "type": "postgres",
      "host": "10.1.2.4",
      "port": 5432,
      "user": "ops_app",
      "password": "${ENV:OPS_DB_PASSWORD}",
      "database": "ops",
      "maxPermission": "readwrite"
    }
  ]
}
```

### 3.3 字段表

**`sources[]`**

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 唯一，`^[a-z0-9][a-z0-9_-]{0,63}$`；客户端只认这个名字 |
| `type` | 是 | `mysql`/`postgres`/`redis`/`oracle`/`dm`/`sqlserver`/`mongodb`/`sqlite`/`kingbase`/`gaussdb`/`oceanbase`/`tidb`/`clickhouse`/`polardb`/`vastbase`/`highgo`/`goldendb` |
| `host` `port` | 是* | 非 SQLite 必填 |
| `user` `password` | 否 | 建议必填；口令用 `${ENV:VAR}` 引用，不写明文 |
| `database` | 否 | 默认库 |
| `filePath` | 是* | 仅 SQLite |
| `authSource` | 否 | 仅 MongoDB |
| `oracleClientPath` | 否 | 仅 Oracle Thick 模式 |
| `maxPermission` | 否 | `safe`（默认）/`readwrite`/`full`；源级上限 |
| `description` | 否 | 会出现在 `list_datasources`，不要写敏感信息 |

**`apiKeys[]`**

| 字段 | 必填 | 说明 |
|---|---|---|
| `key` | 是 | 唯一；用 `${ENV:VAR}` 注入 |
| `name` | 是 | 唯一，审计主体；建议"平台名-用途"，如 `dify-prod` |
| `allowedSources` | 是* | 源名数组；**缺省或空数组 = 不能访问任何源**（加载时归一化为 `[]`）；禁止 `*`；不允许悬挂引用 |
| `maxPermission` | 否 | 在源级上限基础上再压低 |

### 3.4 启动校验（任一失败即退出，一次列出全部错误）

- `$schemaVersion` 不是 1；
- `${ENV:VAR}` 引用的环境变量不存在；
- 源名/key/name 重复或格式非法；
- `allowedSources` 引用了不存在的源（悬挂引用）或出现 `*`；
- `type` 不在支持列表；
- `maxPermission` 非法值；
- SQLite 源缺 `filePath`，或同时写了 `host`/`port`；
- `adhocTargetAllowlist` 含非法条目（仅接受 `host:port` 精确匹配，不支持 CIDR/通配符/空端口）。

> `host`/`port`/`user`/`password` 等连接字段是否齐全在建连时校验；注册表启动校验只查上述结构规则。

### 3.5 权限算法（记住这一条）

```
生效权限 = min(源.maxPermission ?? safe, key.maxPermission ?? full)
```

注册表（`source`）模式下，客户端传来的 `permissionMode`/`allowWrite`/`X-DB-Permission-Mode` 等权限字段**一律忽略**（密码等非权限字段同样忽略，不触发审计）；若自报权限宽于生效权限，审计记 `permission_ignored`。adhoc/legacy 直通通道保持 2.x 行为（客户端自报权限直接生效）——这是该通道的既有代价，见 §10 与 MIGRATION-3.0.md §4。

---

## 4. 错误码

| 错误码 | HTTP | 含义 | 处理方向 |
|---|---|---|---|
| `INVALID_REQUEST` | 400 | 没带任何连接参数/参数非法 | 客户端问题 |
| `ADHOC_DISABLED` | 403 | 注册表模式下传了原始连接参数 | 改用 `source`，或临时开开关 |
| `ADHOC_TARGET_DENIED` | 403 | adhoc 目标不在 `adhocTargetAllowlist` | 加白名单或改用注册源 |
| `SOURCE_NOT_FOUND` | 404 | 源不存在 **或** 该 key 无权（故意不区分） | 查 `allowedSources` |
| `PERMISSION_DENIED` | 403 | 操作超出生效权限 | 查 `maxPermission` |
| `CONNECT_FAILED` | 502 | 服务端连库失败 | 查网络/账号/口令 |

> **协议面差异**：
> - REST（`/api/connect`）与 MCP SSE 初始化用 `{success,error:{code,message}}` 信封；
> - Streamable HTTP（`POST /mcp`）初始化被拒时返回 JSON-RPC 错误，`error.code = -32001`，具体错误码在 `error.data.code`（HTTP 状态码与上表一致）；
> - MCP 工具调用（如 `connect_datasource`）被拒时返回 `isError`，文本格式固定为 `[<CODE>] 中文说明`（例如 `[SOURCE_NOT_FOUND] 源不存在或当前 API key 无权访问`、`[PERMISSION_DENIED] 操作被拒绝：…`）。

---

## 5. 部署与网络暴露（"谁能调用我的 MCP"）

### 5.1 先回答三个问题

1. **agent 平台支持 stdio 方式启动 MCP 吗？**（支持 → 方案 A，最安全）
2. **MCP 与 agent 平台是否同机 / 同 Pod？**（是 → 方案 B）
3. **两者是否在同 VPC 的不同机器？**（是 → 方案 C）

### 5.2 方案 A：stdio，无监听端口（首选）

```
[Agent 平台] --(spawn 子进程, stdin/stdout)--> [universal-db-mcp] --内网--> [只读库]
```

- 没有监听端口 = 没有入站攻击面；不需要 API key 网络暴露；
- 凭据通过子进程环境变量注入，不出进程；
- 适用：Claude Desktop、Cursor、Codex、自建 Python/Node agent（MCP SDK 支持 stdio）；
- 限制：每个平台实例一个进程；Dify 这类只支持 HTTP 的平台用不了。

### 5.3 方案 B：同机 / 同 Pod 的 loopback

```
[Agent 平台] --127.0.0.1:3000--> [universal-db-mcp] --内网--> [DB]
```

- 设 `HTTP_HOST=127.0.0.1`，安全组**不开任何入站**；
- **Docker 注意**：不同容器有各自的 loopback，`bridge` 网络下互相访问不到 127.0.0.1。必须同 Pod（k8s sidecar）、`--network container:<agent容器>`、或 `--network host`；
- k8s：MCP 作为 sidecar，**不要建 Service**（或建 `ClusterIP: None` 且不用），避免被集群内其他服务发现。

### 5.4 方案 C：同 VPC 跨机（Dify 等 HTTP-only 平台的常规选择）

```
[Agent 10.0.1.10] --HTTPS(443)--> [nginx 10.0.2.20] --127.0.0.1:3000--> [universal-db-mcp] --内网--> [DB 10.0.3.x]
```

- MCP 只监听 `127.0.0.1:3000`，**不申请公网 IP、不挂公网 SLB/ELB**；
- nginx 同机部署，负责：TLS 终结、`allow 10.0.1.10; deny all;`、可选 mTLS、访问日志；
- 安全组：443 入站仅允许 agent 平台（最小到 /32 或安全组引用）；3000 不对外；
- API key 照常启用（网络限制 + key 双因子）；
- 密评要求国密时，TLS 终结换成支持 SM2/SM3/SM4 的网关（Tongsuo/Tengine），标准 nginx 不满足。

nginx 关键配置：

```nginx
server {
    listen 443 ssl;
    server_name db-mcp.internal;

    ssl_certificate     /etc/ssl/server.crt;
    ssl_certificate_key /etc/ssl/server.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    allow 10.0.1.10;
    deny  all;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # SSE 必须关闭缓冲
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

### 5.5 政务云硬性清单

- [ ] 不申请公网 IP、不挂公网 SLB/ELB、不做端口映射到 0.0.0.0
- [ ] 入站安全组只放 agent 平台（/32 或安全组引用），其余 deny
- [ ] 出站安全组只放目标数据库端口
- [ ] 数据库账号只读（`safe` 场景）；账号级 IP 白名单只允许 MCP 主机
- [ ] TLS 终结在网关；密评场景用国密网关
- [ ] agent 平台若在互联网侧（SaaS），禁止直连内网库——必须把平台部署进云内
- [ ] 审计日志落到独立分区/目录，留存 ≥6 个月

### 5.6 不要做的事

- 不要把 `3000` 直接 `-p 3000:3000` 映射到宿主机公网网卡；
- 不要用 URL query 传数据库密码（SSE legacy 通道已默认关闭，别为了"方便"再开）；
- 不要给 MCP 配可写账号却把 `maxPermission` 设成 `full`；
- 不要在没配 `trustProxy` 的情况下信任 `X-Forwarded-For` 做 IP 判断；
- 不要让多个 agent 平台共用一把 key（审计无法区分是谁）。

### 5.7 同机 + 调用方在 Docker 容器里（Octop 场景）

**关键事实**：容器与宿主机是两个网络命名空间，容器里的 `127.0.0.1` 是容器自己的。MCP 只绑 `127.0.0.1` 时，默认桥接网络下的容器**永远连不到它**（除非走 `--network host`）。

**5 分钟定位**：

```bash
docker inspect <专家容器> --format '{{.HostConfig.NetworkMode}}'
# 容器内实测：
docker exec <专家容器> curl -s http://172.17.0.1:3000/api/health
docker exec <专家容器> curl -s http://host.docker.internal:3000/api/health
```

| 网络模式 | 结论 | 配置 |
|---|---|---|
| `host` | 与宿主机共享网络栈，`127.0.0.1:3000` 直接可达 | MCP 保持绑 `127.0.0.1`，无额外开放 |
| 默认 bridge | 需 MCP 监听 `0.0.0.0`，容器经网关 IP 访问 | 见下方推荐配置 |
| 自定义网络 | 用该网络的网关 IP 或容器名（MCP 也容器化时） | 见"可选加固" |

**推荐配置（bridge 场景）**：

1. `HTTP_HOST=0.0.0.0`；
2. 宿主机防火墙只放容器网段（**政务云安全组管不了宿主机内的容器流量，必须用本机防火墙**）：

```bash
ufw allow from 172.17.0.0/16 to any port 3000 proto tcp   # docker 默认网段，按实际调整
ufw deny 3000/tcp                                          # 其余来源一律拒绝
```

> 说明：`ufw` 默认放行 lo，所以**宿主机上其他进程仍可通过 `127.0.0.1:3000` 访问**（agent 平台本体通常就是这么连的）。这只挡"外部/其他进程经网络进来的连接"，要精确到进程级（如只信 octop 进程）得用按 uid 的 nftables 出站链，收益低，不推荐。

3. 容器内用 `http://172.17.0.1:3000` 或 `http://host.docker.internal:3000`（后者需启动容器时加 `--add-host=host.docker.internal:host-gateway`，Docker Desktop 默认自带，Linux 引擎默认没有）；
4. API key 照常要求。

**可选加固**：单独建网络并固定专家容器 IP，防火墙精确到单 IP：

```bash
docker network create --subnet 172.28.0.0/16 octop-net
# 专家容器加入 octop-net 并指定静态 IP 172.28.0.2
ufw allow from 172.28.0.2 to any port 3000 proto tcp
```

**另一个更干净的选择**：把 MCP 也容器化，放进与专家相同的自定义网络，端口**不发布到宿主机**，专家直接用容器名 `http://universal-db-mcp:3000` 访问——没有任何宿主机端口暴露，也不依赖防火墙规则。代价是 MCP 改为容器部署。

### 5.8 典型场景：Octop + 容器内无网络专家

**拓扑前提（实测确认）**：

- octop 平台本体与 MCP 同机（宿主进程，或与管理网络打通的容器）；
- 专家容器默认 `network: none`（零出网），octop 自定义指令可开网络——**建议保持不开**；
- octop 支持注册 MCP（HTTP 与 stdio 均可），连接器配置可加 HTTP 头；连接器为全局资源，专家能否使用由 octop 侧按专家授权。

**为什么不给专家开网络**：`network: none` 下专家唯一的对外通道就是 octop 的 MCP 连接器 → universal-db-mcp → 受 ACL 约束的源。专家自身无法发起任意内网扫描/横向访问。开了网络，等于把这个保障交给每个专家的提示词安全；政务云对容器出网的审查也是额外成本。结论：**不开，除非某个专家有明确的外部 API 出网需求（那是独立的出网白名单评审，不走 MCP）**。

**推荐拓扑（HTTP + loopback）**：

```
[专家容器 network:none] --(仅 octop 调用)--> [octop 平台(宿主)] --127.0.0.1:3000--> [universal-db-mcp] --内网--> [只读库]
```

- 为什么选 HTTP 不用 stdio：HTTP 每请求可带 `X-API-Key`（鉴权 + 审计主体归因到连接器 key）；stdio 是单管道进程，无法按专家区分会话，且注册表模式下多个专家共用一个 stdio 连接会互相抢 `connect_datasource` 切换。
- MCP 绑 `127.0.0.1`，安全组无需开任何入站（前提：octop 本体在宿主或与本机 loopback 可达；否则按 §5.7 处理）。
- **连接器模型 = 一连接器一源一 key**：octop 的连接器是"全局配置 + 按专家授权"的单位，正好对应 MCP 的 key + allowedSources。每个 octop 连接器静态配置一个数据源（Streamable HTTP 用 `X-DB-Source` 头；SSE 用 `?source=`），需要多个源就注册多个连接器，各配一把 key。

**注册表样例（3 个业务源 → 3 个连接器 → 3 把 key）**：

```json
{
  "$schemaVersion": 1,
  "allowAdhocConnections": false,
  "apiKeys": [
    { "key": "${ENV:KEY_OCTOP_FIN}", "name": "octop/财务分析",
      "allowedSources": ["finance-ro"], "maxPermission": "safe" },
    { "key": "${ENV:KEY_OCTOP_OPS}", "name": "octop/运维助手",
      "allowedSources": ["ops-ro"], "maxPermission": "safe" },
    { "key": "${ENV:KEY_OCTOP_HR}", "name": "octop/人事查询",
      "allowedSources": ["hr-ro"], "maxPermission": "safe" }
  ],
  "sources": [
    { "name": "finance-ro", "type": "mysql", "host": "${ENV:FIN_HOST}",
      "port": 3306, "user": "${ENV:FIN_USER}", "password": "${ENV:FIN_PWD}",
      "database": "finance", "maxPermission": "safe" },
    { "name": "ops-ro", "type": "postgres", "host": "${ENV:OPS_HOST}",
      "port": 5432, "user": "${ENV:OPS_USER}", "password": "${ENV:OPS_PWD}",
      "database": "ops", "maxPermission": "safe" },
    { "name": "hr-ro", "type": "mysql", "host": "${ENV:HR_HOST}",
      "port": 3306, "user": "${ENV:HR_USER}", "password": "${ENV:HR_PWD}",
      "database": "hr", "maxPermission": "safe" }
  ]
}
```

**审计归因**：`TRUST_AUDIT_USER_HEADER=true` 只决定审计记录是否**允许承载** `auditUser` 字段（仅审计关联，不参与授权）；当前实现不自动读取 `X-Audit-User` 请求头，该字段需由接入层/调用方注入审计上下文。因此 octop 场景下 MCP 审计到连接器粒度（`octop/财务分析`），专家 → 查询的关联在 octop 侧日志里完成（按时间窗口 + 源 + 语句特征）——不要为了专家粒度去信任不可控来源的身份头。

**本场景硬规则**：
- `allowAdhocConnections` 恒为 `false`（专家路径永远只走注册源）；
- `maxPermission` 一律 `safe`，确有写需求的连接器单独放开并评估；
- 数据库账号照旧最小权限 + 只读优先（纵深防御，MCP 校验非安全边界）；
- 若 octop 平台本体也在容器里，按 §5.7 处理容器→宿主机可达性。

---

## 6. 变更管理（SIGHUP 热加载）

### 6.1 语义

| 项目 | 行为 |
|---|---|
| 触发 | `kill -HUP <pid>`，仅 HTTP 模式；stdio 模式不注册（发 HUP 即按默认退出） |
| 生效范围 | `sources`、`apiKeys`、`allowAdhocConnections`、`adhocTargetAllowlist` |
| 不生效 | 端口/监听地址、日志级别、会话超时、`AUDIT_LOG_PATH`（需重启） |
| 原子性 | 完整校验通过才替换；非法配置 → 保留旧配置 + ERROR 日志，进程不退出 |
| 已建会话 | 使用连接时的快照，不受重载影响 |
| 例外 | key 被删 / 源被移出该 key 白名单 / 源被删 → **主动关闭相关会话**并审计 `session_revoked` |
| 凭据轮换 | 已连接会话仍用旧口令；需排空或重启才完全生效 |
| 防重入 | 重载进行中再次收到 SIGHUP → 忽略 + WARN，不排队 |
| 审计 | 仅**成功**重载记 `config_reload`（含文件 sha256、源/key 数量、被关闭会话数）；校验失败只写 ERROR 日志（“SIGHUP 配置重载失败，保留旧配置继续服务”），不写审计 |

### 6.2 标准操作流程

```bash
# 1. 在 git 分支上改配置（评审、留痕）
vi /etc/universal-db-mcp/registry.json

# 2. 语法自检（可选）
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' /etc/universal-db-mcp/registry.json

# 3. 触发重载
kill -HUP "$(cat /run/universal-db-mcp.pid)"

# 4. 确认重载成功
#    - stderr/journalctl 应出现「SIGHUP 配置重载成功」（含被关闭的吊销会话数）；
#    - config_reload 审计只写审计文件（不写 stdout/journald），且仅成功重载才产生：
grep config_reload "$AUDIT_LOG_PATH"   # 如 /var/log/universal-db-mcp/audit.ndjson

# 5. 回滚：git revert 后再次 HUP
```

### 6.3 systemd 单元示例

```ini
[Unit]
Description=Universal DB MCP (HTTP)
After=network-online.target

[Service]
Type=simple
User=dbmcp
Group=dbmcp
WorkingDirectory=/opt/universal-db-mcp
EnvironmentFile=/etc/universal-db-mcp/env      # 600 权限
ExecStart=/usr/bin/node dist/index.js
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/log/universal-db-mcp

[Install]
WantedBy=multi-user.target
```

`/etc/universal-db-mcp/env` 权限必须 `600`，属主 `dbmcp`；注册表文件同样 `600`。

---

## 7. 审计

### 7.1 样例

```json
{"ts":"2026-11-03T10:00:00.000Z","event":"query","requestId":"req-17","transport":"rest",
 "principal":"agent-platform","keyFingerprint":"ab12cd34ef56","source":"finance-ro",
 "clientIp":"10.0.1.10","auditUser":"zhangsan","sql":"SELECT COUNT(*) FROM orders",
 "sqlBytes":28,"sqlTruncated":false,"status":"ok","errorCode":null,"rows":1,"durationMs":12}
```

事件类型：`query`、`metadata`、`connect`、`disconnect`、`denied`、`permission_ignored`、`session_revoked`、`config_reload`。

各事件关键字段（字段顺序固定如上例：`ts → event → requestId → transport → principal → keyFingerprint → source → clientIp → auditUser → sql → sqlBytes → sqlTruncated → status → errorCode → rows → durationMs`，其后为可选扩展字段 `sessionId → reason → configSha256 → sourceCount → keyCount → closedSessions`；值为 `undefined` 的字段序列化时省略，`null` 保留）：

| 事件 | 关键字段 |
|---|---|
| `query` | `sql`/`sqlBytes`/`sqlTruncated`/`status`（`ok`\|`error`）/`errorCode`/`rows`/`durationMs` |
| `metadata` | `status`/`durationMs`（schema 类工具/接口调用） |
| `connect` / `disconnect` | `source`、`status` |
| `denied` | `errorCode`（`INVALID_REQUEST`/`ADHOC_DISABLED`/`ADHOC_TARGET_DENIED`/`SOURCE_NOT_FOUND`/`PERMISSION_DENIED`）、`source`、`status=denied`（任何 ACL 拒绝必落，含 404） |
| `permission_ignored` | `source`、`status=ignored` |
| `session_revoked` | 吊销原因 `reason`（`key_revoked`/`source_revoked`/`source_removed`）、`sessionId`、`keyFingerprint`、`source`、`status=revoked` |
| `config_reload` | 文件 sha256 与源/key 数量、被关闭会话数（`configSha256`/`sourceCount`/`keyCount`/`closedSessions`）、`source`=配置文件路径、`principal=system` |

> `config_reload`/`session_revoked` 的明细字段（`reason`/`configSha256`/`sourceCount`/`keyCount`/`closedSessions`/`sessionId`）既是记录类型的可选顶层字段（仅显式提供时才随行输出），当前重载路径也仍经 `errorCode`（吊销原因）与 `sql`（`JSON` 明细）子字段承载——字段命名以实际输出为准。

### 7.2 采集与留存

```bash
# /etc/logrotate.d/universal-db-mcp
/var/log/universal-db-mcp/audit.ndjson {
    daily
    rotate 200          # ≥ 6 个月
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

- 对接 SIEM：Filebeat/Vector 采集 NDJSON，按 `principal`/`source`/`event` 建索引；
- **拒绝事件必须进告警**：`event=denied` 连续出现意味着有人在试探白名单；
- 应用内不做轮转，避免与 logrotate 冲突。

---

## 8. 等保 2.0 对照（技术措施部分）

| 控制点 | 本方案措施 | 证据材料 |
|---|---|---|
| 身份鉴别 | 每平台独立 API key + 唯一 `name` | 注册表 `apiKeys` |
| 访问控制（主体/客体） | `allowedSources` 白名单，默认拒绝 | 注册表 + `denied` 审计 |
| 访问控制（最小权限） | `maxPermission` 三重上限 | 代码 §4.1 + 注册表 |
| 访问控制（源地址） | 安全组/nginx allow（§5） | 安全组截图、nginx 配置 |
| 安全审计 | 每次查询/连接/拒绝 NDJSON | `AUDIT_LOG_PATH` |
| 审计留存 | logrotate `rotate 200`（≥6 个月） | logrotate 配置 |
| 通信保密性 | 网关 TLS（密评场景国密） | 证书、网关配置 |
| 会话管理 | 空闲超时回收 | `SESSION_TIMEOUT` |
| 入侵防范 | 限流 + adhoc 默认关闭 | `RATE_LIMIT_*`、注册表 |

> 本表只覆盖**技术措施**。等保测评还需要管理制度、人员安全、应急预案等材料，不能仅凭本方案通过测评。

---

## 9. 运维手册

### 9.1 密钥轮换

```bash
# 1. 生成新 key，先在注册表里新增（保留旧 key）
# 2. kill -HUP；通知平台切换
# 3. 平台确认切换完成后，删除旧 key
# 4. kill -HUP —— 仍使用旧 key 的会话会被主动关闭（session_revoked）
```

### 9.2 数据库口令轮换

同名源覆盖 `password` → `kill -HUP` → **新会话**用新口令；已连接会话仍持旧连接池（旧口令）。**注意**：`SIGHUP` 只重新读取注册表 JSON，**不会**重新加载进程环境——若口令以 `${ENV:VAR}` 引用，env 文件里的新口令需**重启**才生效。要立即生效：重启，或等 `SESSION_TIMEOUT` 自然回收。

### 9.3 排障

| 现象 | 先查什么 |
|---|---|
| 启动即退出 | 日志里的配置校验错误；`DATASOURCE_CONFIG` 路径与权限 |
| 401 | 请求未带 `X-API-Key` / `Authorization: Bearer` |
| 403 `ADHOC_DISABLED` | 客户端还在传 `type/host`；要么改 `source`，要么临时开开关 |
| 404 `SOURCE_NOT_FOUND` | 源名拼错，或该 key 的 `allowedSources` 没包含它 |
| 403 `PERMISSION_DENIED` | 语句类型超出 `maxPermission`；查审计里的 `permission_ignored` |
| 502 `CONNECT_FAILED` | 数据库网络/账号/口令；先手工用同参数连一次 |
| 重载没生效 | 看审计文件有没有 `config_reload` / stderr 有没有「SIGHUP 配置重载成功」；HUP 是否发到了 stdio 进程（stdio 收到 HUP 会退出） |
| 重载后旧会话还在 | 属预期（快照语义）；只有 key/源被删才会主动关闭 |

---

## 10. 从 2.x 迁移

1. 盘点现有调用方：每个平台/脚本各分配一个 key 和 `name`；
2. 把连接参数从启动命令/请求体里搬到 `sources[]`，口令改成 `${ENV:VAR}`；
3. 设 `allowedSources`：先按现状全量放开，再逐步收窄；
4. 启动 3.0，关闭 adhoc（`allowAdhocConnections: false`）；
5. 观察审计里的 `denied`，把漏配的源补上；
6. 稳定 2 周后删除 `API_KEYS` 环境变量与旧配置。

**兼容性**：stdio 的 `--type/--host/...` 保持 2.x 行为不变；HTTP 的原始参数通道默认关闭（需 `ALLOW_ADHOC_CONNECTIONS=true` 显式开启）。

> 完整升级步骤、错误码对照与 legacy 特权说明见 [MIGRATION-3.0.md](../../MIGRATION-3.0.md)。

---

## 11. FAQ

**Q：为什么不做 Web 管理界面？**
A：管理面是独立安全域，做 UI 等于新增一个能改凭据和 ACL 的高危入口，还要配套管理员认证、CSRF、操作审计、变更审批。配置文件进 git 已经天然满足"变更留痕 + 可回滚 + 可评审"。确有自助需求时，做成独立的管理服务写文件 + 触发 SIGHUP，数据面永远不暴露写接口。

**Q：`adhocTargetAllowlist` 是不是"哪些 IP 能访问我"？**
A：不是。它是出站目标白名单（服务端能连哪些数据库地址）。入站 IP 控制在安全组/nginx（§5）。

**Q：多个 agent 平台怎么配？**
A：每个平台一把 key、一个 `name`、一份 `allowedSources`。共用 key 会导致审计无法归因。

**Q：能不能一个 key 访问所有源？**
A：可以，但必须显式逐个列出；不支持 `*`，避免手滑全开。

**Q：能跨源 join 吗？**
A：不能，也不计划支持。一个会话同一时刻只连一个源；跨源分析请让 agent 平台分别调用，或在数仓侧完成。

**Q：Windows 上怎么热加载？**
A：不支持 SIGHUP，改配置需重启服务。

**Q：审计里的 SQL 会不会泄露敏感数据？**
A：会记录 SQL 原文（截断 2KB），其中的字面量可能含敏感值。高敏场景可只记 `sqlBytes` + 语句类型（需改代码），或在数据库侧用只读副本 + 脱敏视图。
