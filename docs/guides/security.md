# 安全最佳实践

本文档介绍 Universal DB MCP 的安全配置和最佳实践。

## 安全模式

### 权限模式

Universal DB MCP 支持细粒度权限控制：

| 模式 | 允许的操作 | 说明 |
|------|-----------|------|
| `safe`（默认） | SELECT | 只读，最安全 |
| `readwrite` | SELECT, INSERT, UPDATE | 读写但不能删除 |
| `full` | 所有操作 | 完全控制（危险！） |
| `custom` | 自定义组合 | 通过 `--permissions` 指定 |

**权限类型：**
- `read` - SELECT 查询（始终包含）
- `insert` - INSERT, REPLACE
- `update` - UPDATE
- `delete` - DELETE, TRUNCATE
- `ddl` - CREATE, ALTER, DROP, RENAME

### 只读模式（默认）

默认情况下，工具运行在**只读模式**，会拒绝所有写入操作。这是最安全的配置，推荐在生产环境使用。

### 读写模式（不能删除）

适用于数据录入场景，允许插入和更新，但禁止删除：

```bash
--permission-mode readwrite
```

### 自定义权限

根据需求自由组合权限：

```bash
# 只允许读和插入
--permissions read,insert

# 允许读、插入、更新
--permissions read,insert,update
```

### 完全控制模式

如需执行所有操作，需要显式添加参数：

```bash
--permission-mode full
# 或（向后兼容）
--danger-allow-write
```

**警告**：启用完全控制模式后，AI 可以修改和删除你的数据库数据。请仅在开发环境使用。

### 不同传输方式的权限配置

> ⚠️ **重要提示**：不同传输方式的参数命名风格不同，请注意区分！

#### STDIO 模式（Claude Desktop 等）

使用命令行参数（连字符风格）：

```bash
# 预设模式
--permission-mode readwrite

# 自定义权限
--permissions read,insert,update
```

#### SSE 模式（Dify 等）

使用 URL Query 参数（驼峰风格）：

```
GET /sse?type=mysql&host=localhost&permissionMode=readwrite
GET /sse?type=mysql&host=localhost&permissions=read,insert,update
```

#### Streamable HTTP 模式

使用 HTTP Header（连字符风格）：

```
POST /mcp
Headers:
  X-DB-Type: mysql
  X-DB-Host: localhost
  X-DB-Permission-Mode: readwrite
  X-DB-Permissions: read,insert,update
```

#### REST API 模式

使用 JSON Body（驼峰风格）：

```json
POST /api/connect
{
  "type": "mysql",
  "host": "localhost",
  "permissionMode": "readwrite",
  "permissions": ["read", "insert", "update"]
}
```

#### 参数命名汇总

| 传输方式 | 参数位置 | 权限模式参数 | 自定义权限参数 |
|---------|---------|-------------|---------------|
| STDIO | 命令行 | `--permission-mode` | `--permissions` |
| SSE | URL Query | `permissionMode` | `permissions` |
| Streamable HTTP | HTTP Header | `X-DB-Permission-Mode` | `X-DB-Permissions` |
| REST API | JSON Body | `permissionMode` | `permissions` |

## 数据库账号安全

### 使用专用账号

为 MCP 创建专用的数据库账号，遵循最小权限原则。

#### MySQL

```sql
-- 创建只读用户
CREATE USER 'mcp_readonly'@'%' IDENTIFIED BY 'secure_password';
GRANT SELECT ON mydb.* TO 'mcp_readonly'@'%';
FLUSH PRIVILEGES;
```

#### PostgreSQL

```sql
-- 创建只读用户
CREATE USER mcp_readonly WITH PASSWORD 'secure_password';
GRANT CONNECT ON DATABASE mydb TO mcp_readonly;
GRANT USAGE ON SCHEMA public TO mcp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_readonly;

-- 如需访问其他 schema，需要额外授权
-- GRANT USAGE ON SCHEMA analytics TO mcp_readonly;
-- GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO mcp_readonly;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO mcp_readonly;
```

#### Oracle

```sql
-- 创建只读用户
CREATE USER mcp_readonly IDENTIFIED BY secure_password;
GRANT CREATE SESSION TO mcp_readonly;
GRANT SELECT ANY TABLE TO mcp_readonly;
```

### 密码安全

1. **使用强密码** - 至少 16 位，包含大小写字母、数字和特殊字符
2. **定期轮换** - 定期更换数据库密码
3. **不要硬编码** - 使用环境变量存储密码

## API Key 安全

### 生成强密钥

```bash
# 生成 32 字节的随机密钥
openssl rand -hex 32
```

### 配置多个密钥

支持配置多个 API Key，便于轮换和撤销：

```bash
API_KEYS=key1,key2,key3
```

### 密钥轮换

1. 添加新密钥到配置
2. 更新客户端使用新密钥
3. 移除旧密钥

## 网络安全

### 不要直接暴露数据库

数据库不应该直接暴露到公网。推荐架构：

```
用户 → Nginx (HTTPS) → MCP 服务 → 数据库
```

### 使用 VPN 或跳板机

访问生产数据库时：

1. **VPN** - 通过企业 VPN 连接
2. **SSH 隧道** - 通过跳板机建立隧道
3. **内网访问** - 在同一 VPC 内访问

### 防火墙配置

只允许必要的端口：

```bash
# UFW 示例
sudo ufw allow ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# 不要开放数据库端口到公网
```

## HTTPS 配置

生产环境必须使用 HTTPS：

1. 使用 Let's Encrypt 免费证书
2. 配置 Nginx 反向代理
3. 强制 HTTP 重定向到 HTTPS

详见 [HTTPS 配置指南](../deployment/https-domain.md)。

## 速率限制

配置速率限制防止滥用：

```bash
RATE_LIMIT_MAX=100      # 最大请求数
RATE_LIMIT_WINDOW=1m    # 时间窗口
```

## 日志和审计

### 启用日志

```bash
LOG_LEVEL=info
```

### 定期审计

1. 检查访问日志
2. 监控异常查询
3. 审计数据库操作

## 安全检查清单

### 部署前

- [ ] 使用只读数据库账号
- [ ] 配置强 API Key
- [ ] 启用 HTTPS
- [ ] 配置防火墙
- [ ] 设置速率限制

### 运行时

- [ ] 定期检查日志
- [ ] 监控异常访问
- [ ] 及时更新版本

### 定期维护

- [ ] 轮换 API Key
- [ ] 更新数据库密码
- [ ] 审计访问权限

## 常见安全问题

### SQL 注入

MCP 使用参数化查询，已内置 SQL 注入防护。但仍需注意：

1. 不要在查询中拼接用户输入
2. 使用参数化查询

### 敏感数据泄露

1. 不要在日志中记录敏感数据
2. 配置适当的访问权限
3. 使用数据脱敏

### 未授权访问

1. 始终配置 API Key
2. 使用 HTTPS
3. 限制网络访问

## 3.0.1 安全加固（政务云/等保场景建议）

### 数据库账号最小权限

代码层的只读/权限校验是纵深防御，**主防线仍是数据库账号本身**。注册表 `DATASOURCE_CONFIG` 中每个源应使用独立的只读账号或最小权限账号：

```sql
-- MySQL / MariaDB / TiDB / OceanBase / PolarDB / GoldenDB
CREATE USER 'mcp_ro'@'%' IDENTIFIED BY '<strong-password>';
GRANT SELECT, SHOW VIEW ON app_db.* TO 'mcp_ro'@'%';

-- PostgreSQL / KingbaseES / GaussDB / Vastbase / HighGo
CREATE ROLE mcp_ro LOGIN PASSWORD '<strong-password>';
GRANT CONNECT ON DATABASE app_db TO mcp_ro;
GRANT USAGE ON SCHEMA public TO mcp_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_ro;

-- Oracle / 达梦：仅授予 CREATE SESSION 与目标对象的 SELECT
GRANT CREATE SESSION TO mcp_ro;
GRANT SELECT ON app_schema.orders TO mcp_ro;

-- SQL Server：db_datareader 或显式 SELECT
ALTER ROLE db_datareader ADD MEMBER mcp_ro;
```

Redis 建议使用 ACL 限定只读命令：

```text
ACL SETUSER mcp_ro on ><strong-password> ~* +@read -@write -@dangerous
```

MongoDB 建议使用 `read` 内置角色；读写场景再按集合授予 `readWrite`，不要使用 `root`/`dbAdmin`。

只读会话还会在数据库侧强制只读（MySQL `SET SESSION TRANSACTION READ ONLY`、PostgreSQL `default_transaction_read_only=on`、SQLite `query_only`、ClickHouse `readonly=1` 等），账号权限与代码校验应同时收紧。

### 启动与鉴权（fail-closed）

- HTTP 模式必须配置 `DATASOURCE_CONFIG` 注册表；确需 legacy 模式时，必须同时设置 `API_KEYS` 和 `ALLOW_ADHOC_CONNECTIONS=true`。
- 未配置 API Key 时服务拒绝启动/拒绝请求，不再存在开发模式放行。
- 会话（REST sessionId / MCP sessionId）与创建它的 API Key 绑定，其他 Key 无法查询或断开。

### 凭据与本地文件

- 数据库口令不要放在 URL query 中；SSE 连接请使用 `X-DB-Password` 请求头或注册表源（URL 中的 `password` 会被拒绝）。
- 访问日志会自动脱敏 `password` / `token` / `api_key` 等 query 参数。
- SQLite `filePath`、Oracle `oracleClientPath` 只能由注册表或启动参数指定，客户端提交会被拒绝；SQLite 禁止 `ATTACH` / `DETACH`。

### 审计

```bash
AUDIT_LOG_PATH=/var/log/universal-db-mcp/audit.ndjson
AUDIT_REQUIRED=true          # 未配置审计路径则拒绝启动
AUDIT_REDACT_SQL=true        # 默认：口令类 SQL 字面量脱敏
```

- 审计文件以 `0600` 权限创建，建议配合 logrotate 或日志采集系统做异地留存。
- 鉴权失败（401/403）同样写入 `event=denied`；审计记录只包含 `keyFingerprint`，不含明文 API Key。
- 需要完整 SQL 原文用于取证时，可设置 `AUDIT_REDACT_SQL=false`，并确保审计文件访问权限受控。
