# Octop 连接器注册指南（MCP 侧）

> 目标：octop（宿主进程）→ `127.0.0.1:3000` → universal-db-mcp → 只读库
> 原则：**一个连接器 = 一个源 = 一把 key**。源在连接器配置里写死，专家能否用由 octop 授权。

## 0. 前置检查

```bash
systemctl start universal-db-mcp
curl -s http://127.0.0.1:3000/api/health     # 期望 {"success":true,...}
journalctl -u universal-db-mcp -n 20 --no-pager   # 应无配置校验报错
```

## 1. 在 octop 注册 3 个连接器

### 1.1 Streamable HTTP（推荐，MCP 2025 规范）

| 连接器名 | URL | Headers |
|---|---|---|
| `财务分析` | `http://127.0.0.1:3000/mcp` | `X-API-Key: <KEY_OCTOP_FIN>`<br>`X-DB-Source: finance-ro` |
| `运维助手` | `http://127.0.0.1:3000/mcp` | `X-API-Key: <KEY_OCTOP_OPS>`<br>`X-DB-Source: ops-ro` |
| `人事查询` | `http://127.0.0.1:3000/mcp` | `X-API-Key: <KEY_OCTOP_HR>`<br>`X-DB-Source: hr-ro` |

### 1.2 SSE（若 octop 的 MCP 客户端只支持 SSE）

| 连接器名 | URL | Headers |
|---|---|---|
| `财务分析` | `http://127.0.0.1:3000/sse?source=finance-ro` | `X-API-Key: <KEY_OCTOP_FIN>` |
| `运维助手` | `http://127.0.0.1:3000/sse?source=ops-ro` | `X-API-Key: <KEY_OCTOP_OPS>` |
| `人事查询` | `http://127.0.0.1:3000/sse?source=hr-ro` | `X-API-Key: <KEY_OCTOP_HR>` |

> `source` 在 URL 里会进 octop 访问日志——它不是秘密（只是源名），可接受。
> **不要把 API key 放 URL**，必须走 Header。

## 2. 给专家授权

- octop 里对每个专家勾选其允许使用的连接器（如：财务分析专家 → `财务分析` + `人事查询`）；
- 连接器全局共享一把 key 没问题：octop 侧已控制"哪个专家能用哪个连接器"，MCP 侧 key 只对应"这个连接器允许连哪些源"。

## 3. 审计粒度与归因

- **MCP 审计**：`principal` = 连接器名（`octop/财务分析`），`keyFingerprint` = key 的 sha256 前 12 位；
- **专家级归因**：MCP 当前**不自动读取** `X-Audit-User` 请求头（`TRUST_AUDIT_USER_HEADER` 只决定审计记录是否允许承载 `auditUser` 字段，该字段需接入层注入审计上下文），专家 → 查询的关联在 octop 自己的日志里完成：
  - MCP 审计每行有 `ts`、`requestId`、`source`、SQL——与 octop 日志按时间窗口 + 源 + 语句特征关联；
  - 若将来必须自动化专家级审计，应在 octop 侧对专家调用做日志打点（那是 octop 的职责边界），不要改为 MCP 信任客户端身份头。
- 告警基线：`event=denied` 与 `permission_ignored` 出现即告警（有人在试探白名单/提权）。

## 4. 日常变更

| 动作 | 步骤 |
|---|---|
| 加源 / 加连接器 | 改 `registry.json`（git 提交）→ `kill -HUP $MAINPID` → octop 注册新连接器 |
| 给 key 加/减源 | 改 `allowedSources` → HUP → 已受影响会话会被主动关闭（`session_revoked`） |
| 吊销连接器 | 从 `registry.json` 删 key → HUP → 该 key 会话被关闭 |
| 轮换 API key | 新增 key 先加进注册表 → HUP → octop 切换 → 确认后删旧 key → HUP |
| 轮换数据库口令 | 改 `env` 里的 `*_PWD` → **重启**（非 HUP；已连接会话持旧连接池）→ 观察连接日志 |

确认重载生效：`journalctl -u universal-db-mcp` 应出现「SIGHUP 配置重载成功」；`config_reload` 审计只写审计文件——`grep config_reload /var/log/universal-db-mcp/audit.ndjson`（含文件 sha256）。

## 5. 日志轮转（审计留存 ≥6 个月）

```bash
# /etc/logrotate.d/universal-db-mcp
/var/log/universal-db-mcp/audit.ndjson {
    daily
    rotate 200
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

## 6. 一条红线

- `allowAdhocConnections` 保持 `false`：专家路径永远只走注册源。任何把原始 `type/host` 传进连接参数的尝试都会被拒（`ADHOC_DISABLED`）——这防止"专家被诱导后让 MCP 扫内网"。