# 交接 Prompt：universal-db-mcp 数据源注册表 + 按源 ACL 改造（3.0.0）

> 本文件是给执行 agent 的**完整任务书**。交接方把它整体复制进消息即可；
> 也可以只用下方"精简版"，让执行 agent 先读本文件再动手。

---

## 你的角色与目标

你是本仓库（`universal-db-mcp`）的改造执行者。任务：把数据库连接从"客户端传参"改为"服务端注册表 + 按 key 白名单 + 服务端权威权限 + 结构化审计 + SIGHUP 热加载"，产出 3.0.0。

## 唯一权威（动手前必须完整读一遍，按此执行）

1. **`docs/plan/datasource-acl.md`** —— 规格。所有字段名、错误码、权限算法、会话语义、审计格式、SIGHUP 语义、验收用例以此为准。
2. `docs/guides/datasource-acl.md` 与 `deploy/octop/` —— 运维手册与部署模板（实施完成后必须与实际实现对齐，见验收 §6）。
3. `RESEARCH.md` —— 背景调研（可选阅读）。

规格没有覆盖的细节：**停下来问交接方，禁止自行发挥。**

## 环境事实（本机已核验，不要重复踩坑）

- 本机 Node v24.22.1、Windows。**`npm install` 裸跑会因 better-sqlite3 原生编译失败**（缺 VS Build Tools）。
  - 本机请用：`npm install --ignore-scripts --no-audit --no-fund`（我已验证：build、`tsc --noEmit`、88 个单元测试全部通过）。
  - 完整测试（含 SQLite/集成）在 CI 的 Node 20/22 Linux 上跑（better-sqlite3 有预编译二进制）。
- 现状基线：两个集成测试失败（`tests/integration/http-api.test.ts` 的 CORS 用例、`tests/integration/mcp-mode.test.ts` 的"无适配器必须抛错"用例），根因是测试与新版行为脱节，修法见规格 §12.2。
- CI（`.github/workflows/ci.yml`）目前只 build 不跑测试，`lint` job 是空占位。

## 工作步骤

1. 新建分支 `feat/datasource-acl-3.0`（不要直接改 main，不要 push）。
2. 按规格 §13 的 Phase P0→P6 顺序实施：
   - P0 注册表模块（`src/security/datasource-registry.ts`）+ 校验 + 单元测试
   - P1 auth 主体解析 + REST ACL + 错误码
   - P2 SSE / Streamable HTTP + MCP 工具按上下文裁剪（§9 toolProfile）
   - P3 stdio `--config/--source` + `connect_datasource`/`list_datasources`
   - P4 审计（AsyncLocalStorage + NDJSON + 记录点全覆盖）
   - P5 SIGHUP 热加载 + 会话快照/吊销
   - P6 文档、版本号、CI、存量测试修复
3. **每个 Phase 结束 `git commit` 一次**，message 前缀 `feat(acl): P<N> ...`（规格 §13）。
4. 变更文件清单：规格 §10（新增 9 个文件、修改 17 个文件，含"不要动"清单）。

## 验收（Definition of Done，全部满足才算完成）

1. 规格 §11 的 29 条验收用例全部通过（含新增的 SIGHUP 用例 25–29）。
2. `npm run build`、`npx tsc --noEmit`、`npm run test:unit`、`npm run test:integration` 全绿。
3. 新增测试：`tests/unit/datasource-registry.test.ts`（≥20 例）、`tests/unit/acl-decision.test.ts`（≥10 例）、`tests/unit/registry-reload.test.ts`（≥8 例）、`tests/integration/acl-http.test.ts`。
4. 所有测试离线可跑：**不依赖真实数据库**。"连接成功"类用例在测试里注入 mock adapter。
5. CI：新增 test job（Node 20/22），删除空 lint job。
6. `package.json` 版本 `3.0.0`；`CHANGELOG.md` 增加 3.0.0 breaking change 段；修掉三处硬编码 `1.0.0`（`src/mcp/mcp-server.ts:35`、`src/http/routes/health.ts:38`、`src/mcp/mcp-index.ts:22`）。
7. `docs/guides/datasource-acl.md` 和 `deploy/octop/` 与实际实现一致：若实现与手册有出入，**以实现为准并回改手册**，并在报告中列出所有出入点。
8. 文档改动仅限规格 §10 列出的文件（4 篇集成指南 EN+zh、API_REFERENCE、README×2、.env.example），**不得**批量刷其余 51 篇集成文档。

## 禁止事项（做了即返工）

- 不做跨源 join/联邦查询（§2.1）
- 不做 SSO/OIDC；不信任任何网关/客户端身份头参与授权（§2.2，`X-Audit-User` 仅审计）
- 不做按条目热更新、不做 HTTP/UI 管理接口（仅 SIGHUP 全量重载，§2.3/§7.1）
- 不做启动预连数据库（§2.4）
- 不引入真 SQL 解析器（§2.5）
- 不改 `src/adapters/**`、`src/utils/safety.ts`、`src/utils/data-masking.ts`、`src/utils/schema-enhancer.ts`、`src/test.ts`
- 不改 stdio 存量 CLI 行为（`--type/--host/...` 与 2.14.0 一致）
- 不新增 Web 界面
- 不修改 `docs/plan/datasource-acl.md` 与 `RESEARCH.md`（发现真实矛盾时，在最终报告中列出，待交接方裁决）

## 完成时交付报告（写回对话，不要只写"完成了"）

1. 每个 Phase 的 commit 列表（git log 输出）
2. 验收矩阵：§11 的 29 条逐条结果（来源：测试运行输出）
3. 实现与手册/部署模板的所有不一致点（§6 要求回改的哪些、怎么改的）
4. 你被迫做的任何规格外选择（哪怕很小）——附原因
5. 遗留风险与后续建议（≤5 条）

---

## 精简版（可直接复制给执行 agent）

```
你是 universal-db-mcp 仓库的改造执行者。
第一步：完整阅读 docs/plan/datasource-acl.md（规格）、docs/plan/datasource-acl-handoff.md（本任务书）、docs/guides/datasource-acl.md（运维手册）。
第二步：按任务书的 P0→P6 顺序实施，每 Phase 提交一次（feat(acl): P<N> ...），分支 feat/datasource-acl-3.0。
验收：任务书 §11 的 29 条用例、npm 全部测试绿、CI test job、package.json 3.0.0、手册与实现对齐。
硬约束：规格未覆盖的细节停下来问，不自行发挥；禁止事项清单见任务书，违反即返工。
完成时按任务书"交付报告"五段式汇报。
环境备忘：本机 npm install 用 --ignore-scripts --no-audit --no-fund（better-sqlite3 原生编译会失败，属预期）。
```