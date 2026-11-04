# universal-db-mcp 3.0.0 改造 · 实施后审查报告

> 审查日期：2026-11-04 ｜ 审查对象：分支 `feat/datasource-acl-3.0`（HEAD 64e8e92）
> 审查方式：代码走读对照规格 + 全量测试实跑 + 真实进程外部冒烟
> 审查人：交接方（本文档由审查人独立完成，非执行者自评）

## 1. 结论：**通过（附条件）**

执行结果与规格 `datasource-acl.md` 高度一致，质量超出预期：

- 全量测试 **18 个文件 / 268 通过 / 1 跳过**（跳过项为 Windows 不支持的 SIGHUP stdio 用例，设计如此，Linux CI 会执行）；
- 构建、`tsc --noEmit` 全绿；`package.json` 3.0.0；三处硬编码版本号已修；
- 真实进程外部冒烟：401/403/404/ADHOC_DISABLED/SOURCE_NOT_FOUND/CONNECT_FAILED、`/api/info` 不泄露源名、审计 NDJSON 落盘（只含 key 指纹，无明文 key）全部与规格一致；
- 执行者自评报告（`docs/plan/datasource-acl-review.md`）中备案的 10 个规格外选择，**我在代码中逐条核验，9 个已正确落地、1 个为保留决策（合理）**；
- 规格 §10 "禁止改动"清单：`src/adapters/**`、`safety.ts`、`data-masking.ts`、`schema-enhancer.ts`、`src/test.ts` **零改动**。

**附条件**：分支尚未推远端，Linux CI（Node 20/22）尚未实际执行。合入 main 前先推分支跑一次 GitHub Actions，确认 SIGHUP 相关用例（用例 25–29）在 Linux 上真实通过，即可合入。

## 2. 交付核验总览

| 项 | 结果 | 证据 |
|---|---|---|
| 分支与提交纪律 | ✅ | `feat/datasource-acl-3.0`，12 个 `feat/acl/test(acl)` 提交，P0→P6 齐全；工作树干净 |
| 构建 / 类型检查 | ✅ | `npm run build` 0、`tsc --noEmit` 0 |
| 全量测试 | ✅ | 18 files / 268 passed / 1 skipped；增量 ~180 个用例 |
| 存量 2 个失败测试 | ✅ 已修 | `http-api.test.ts`（CORS 预检补 Origin）、`mcp-mode.test.ts`（改为断言无连接启动） |
| 第三个存量测试 | ✅ 已修 | `http-api.test.ts:110` 改为带 `source` 组织（执行者审查发现，超出规格清单） |
| CI | ✅ | 新增 test job（unit+integration），空 lint job 已删 |
| 版本号 | ✅ | 3.0.0；`readPackageVersion()` 统一读取，无硬编码 |
| 文档改动范围 | ✅ | 恰好规格 §10 清单：README×2、CHANGELOG、MIGRATION-3.0、API_REFERENCE、DIFY×2、CHATGPT×2、.env.example；其余集成文档未动 |
| 禁止改动清单 | ✅ | diff 为空 |

## 3. 规格关键项逐条核验（代码证据）

| § | 要求 | 实现证据 |
|---|---|---|
| §3.3 校验 | 8 条全量、一次性列错、exit 1 | `datasource-registry.ts:195-376`（validateSource/validateKey/expandAndValidate，错误全收集） |
| §3.3-1 | `${ENV:VAR}` 缺失 → 报错不允许空串 | `datasource-registry.ts:166-175` |
| §4.1 | `min(sourceMax ?? safe, keyMax ?? full)` | `datasource-registry.ts:87-94` |
| §4.2 | 决策表 7 行逐字实现 | `datasource-registry.ts:446-480` |
| §4.2 | 未知源 / key 无权不可区分（均 404） | `datasource-registry.ts:453-456`；冒烟实测确认 |
| §5.1 | stdio 存量 CLI 零变更 + `--config/--source` + 冲突报错 | `mcp-index.ts`（P3 提交）；`mcp-index.test.ts` 21 用例 |
| §5.4 | REST body `source`；错误码替换恒 500 | `connection.ts:37-47` 映射表 + classifyError |
| §6 | 错误码→HTTP 映射 | `security/errors.ts:12-19` |
| §7 | 会话语义：remote 可切源但限 allowedSources；REST 锁源 | `mcp-server.ts:579-586`（registry-remote 白名单校验）；REST 每 connect 新会话 |
| §7.1 | SIGHUP：仅 HTTP、原子替换、防重入、三原因吊销、write 失败不阻断 | `http-index.ts:84-160`（createReloadHandler/runReload/collectRevocations）；`acl-reload.test.ts` 519 行 |
| §7.1 | stdio 不注册 SIGHUP | `mcp-index.ts` 无 SIGHUP（grep 确认）；registry-reload.test.ts:430（Windows skip / Linux 覆盖） |
| §8 | AuditContext（ALS）+ 每次调用重绑 source | `security/audit-context.ts`；`mcp-server.ts:627-631`（切源重绑 ctx.source） |
| §8.2 | 记录点全覆盖（query/metadata/connect/disconnect/denied） | `database-service.ts:109-301`、`560-591`；`mcp-server.ts` connect/disconnect |
| §8.2 | 绝写 stdout；2048 截断；写失败不阻断 | `security/audit-logger.ts:6-8,19`；冒烟实测审计落盘 |
| §9 | toolProfile 四态裁剪 | `mcp-server.ts:46,228-306`（legacy / registry-stdio / registry-remote / legacy-remote 由二维布尔推导） |
| §9 | `connect_datasource` 只收 source（additionalProperties:false） | `mcp-server.ts:556-651`；test 14b/14c |
| §9 | `list_datasources` 远程只列 key 白名单内、无连接参数 | `mcp-server.ts:653-670` |
| §6 附录 | `X-Audit-User` 仅审计不参与授权 | `auth.ts:29,80-81,124-125`；`TRUST_AUDIT_USER_HEADER` 默认 false |
| 部署安全 | fail-open 后门已堵（注册表模式无 key 即 401/403） | `auth.ts:49-82`（无"未配置即放行"分支） |

## 4. 执行者 10 个"规格外选择"的裁决核验

| # | 裁决 | 核验结果 |
|---|---|---|
| 1 | auth fail-open 修复（注册表模式） | ✅ 实现，且是我规格的真实漏洞 |
| 2 | 第三个存量测试一并修 | ✅ |
| 3 | 版本号运行时读取 | ✅ `utils/package-version.ts` |
| 4 | toolProfile 二维布尔推导 | ✅ 行为与 §9 表 4 行一致 |
| 5 | `ADHOC_TARGET_ALLOWLIST` env 补实现 | ✅ `config-loader.ts:171-172` |
| 6 | fixtures 放 `tests/fixtures/` | ✅ |
| 7 | legacy principal='legacy' + 指纹，不落明文 key | ✅ 冒烟确认 |
| 8 | CORS allowedHeaders 补 X-DB-*/X-Audit-User | ✅ `server.ts:91-97` |
| 9 | 会话注册机制（sessionMeta + revokeSession + RegistryHolder 视图） | ✅ `connection-manager.ts:102-104,157`；`datasource-registry.ts:584-614` |
| 10 | 权限错误分类（不动 safety.ts） | ✅ `errors.ts` + `database-service.ts:96-115` 捕获重抛 |

## 5. 发现的瑕疵（均为 minor，不阻塞合入）

1. **文案不精确**：`ADHOC_DISABLED` 的 message 写"未配置数据源注册表且未开启 ALLOW_ADHOC_CONNECTIONS"（`connection.ts:45`），但最常见的触发场景是**有注册表但 allowAdhocConnections=false**——message 与场景不符，排障时会误导。建议改为"adhoc 连接已禁用（allowAdhocConnections=false）"。
2. **审计字段语义污染**：`config_reload` 的明细（sha256、源/key 数、关闭会话数）塞进了 `sql` 字段的 JSON（`http-index.ts:154-155` 注释自认）。能用，但后续建议加独立 `details` 字段。
3. **交付外文档入库**：`docs/plan/datasource-acl-review.md`、`docs/development/agent-wave-lessons.md` 超出 §10 清单被提交。无害且前者有价值，确认是否保留即可。
4. **commit author 标识**：提交者显示为 `Cindy` / `P0 Worker` 等多 agent 名称。若组织要求代码评审实名关联，需规范化——功能不受影响。
5. **legacy 无 key 放行保留**：按裁决 1，legacy 模式（无注册表、显式开 adhoc）下"未配置 API_KEYS 即放行"的开发模式**有意保留**（`auth.ts:88-90`）。这是已知决策，不是遗漏——但生产配置文档已写明"必须注册表模式"，运维手册 §5.4 亦强调。若测评机构抽查到该分支，需能解释。

## 6. 遗留风险与建议

1. **合入前动作**：推送分支到远端 → GitHub Actions（Node 20/22）全绿 → 合入 main。重点盯 SIGHUP 三用例（25–29）在 Linux 上的实际结果（本机 Windows 无法执行）。
2. **部署验证点不变**：octop 实测三项（容器网络模式、octop 本体形态、Streamable/SSE header 支持）在 3.0 部署时进行；deploy/octop 物料与实现已对齐（含新 env `ADHOC_TARGET_ALLOWLIST`）。
3. **审计告警**：部署后把 `event=denied` 与 `permission_ignored` 接告警（手册 §7.2）；这是本改造成本的直接体现，也是等保测评证据。
4. **专项复测建议**：合入后让执行者在 Linux 环境跑一次 `tests/integration/acl-reload.test.ts` 单独文件，输出留存备查。

## 7. 物料清单（审查相关）

- 规格：`docs/plan/datasource-acl.md`
- 执行者自评（含 10 项规格外裁决）：`docs/plan/datasource-acl-review.md`
- 本报告：`docs/plan/datasource-acl-audit.md`