# 数据源注册表 + 按源 ACL 改造 · 评审结论与规格外裁决

> 文档性质：实施前评审结论（交接方/执行者共用）。不修改规格 `datasource-acl.md` 与 `RESEARCH.md`；
> 本文件记录"规格 vs 代码现状"的核对结果，以及按任务书第 4 条（交付报告）需要备案的规格外选择。
> 评审日期：2026-11-03 ｜ 代码基线：2.14.0（dc338cd）｜ 由 reviewer 子代理独立复核。

---

## 1. 结论摘要

规格与任务书质量高、可执行；本机基线已核验：`npm run test:unit` 88 条全绿，集成测试恰好 2 条失败（与任务书 §12.2 完全一致：CORS 预检、无适配器断言过时）。实施准备工作就绪，可直接按 P0→P6 开工。

评审共发现 **6 个规格内可直接执行的点** 与 **9 个规格外选择（需备案裁决，见 §4）**。其中 3 个必须提醒执行者，因为规格字面没点名、不处理会返工或留安全后门：

1. **auth 中间件 fail-open 分支**（`src/http/middleware/auth.ts:61-64`："未配置 API keys 则放行"）。注册表模式下 `API_KEYS` 被忽略 → `config.http.apiKeys` 恒为空数组 → 该分支会让整个 HTTP 面**零鉴权**。必须在 P1 修复：注册表模式用 `apiKeys[].key` 判定，无有效 key 一律 401/403。
2. **第三个存量测试会红**：`tests/integration/http-api.test.ts:110-119`（"valid API key + sqlite :memory:"）在 fail-closed 后请求无 `source` → 403 `ADHOC_DISABLED`，不在任务书 §12.2 的两个修复清单内，P1 需一并更新该用例语义。
3. **版本号读 package.json 的编译坑**：`tsconfig.json` `rootDir: "./src"`，静态 `import pkg from '../package.json'` 报 TS6059。须用运行时 `fs.readFileSync(new URL('../package.json', import.meta.url))`（dist 与 package.json 同在发布根，`files` 清单含 package.json）。

其他关键提示：`src/core/connection-manager.ts` 的 `connect()` 签名变更安全（`connection-stability.test.ts` 53 例全部只测适配器，不依赖该函数）；`query.ts`/`schema.ts` 的 7 处 catch 恒 500 需要"错误分类机制"来产出 `PERMISSION_DENIED` 403，规格 §10 写"无逻辑改动"与该要求矛盾，裁决见 §4-6。

---

## 2. 规格与现状缺口的核验结果

| # | 核对项 | 现状证据 | 结论 |
|---|---|---|---|
| G1 | 版本号硬编码 3 处 | `src/mcp/mcp-server.ts:35`、`src/http/routes/health.ts:38`、`src/mcp/mcp-index.ts:22` 均 `'1.0.0'` | 属实，规格 §10 已列 |
| G2 | `apiKeys: string[]` 无身份载体 | `src/types/http.ts` `HttpConfig.apiKeys`；`auth.ts` 仅 `includes` 判断 | 属实，规格 §1 问题清单已列 |
| G3 | `connect_database` 无条件暴露、无 ACL | `mcp-server.ts` ListTools 固定 10 工具，`connect_database` 在 :224-295 任何会话可调 | 属实，规格 §1/§9 已列 |
| G4 | 错误码恒 500 | `connection.ts:65-68`、`query.ts:61/115`、`schema.ts` 7 处 catch 全 `code(500)` | 属实，规格 §6 已列 |
| G5 | 客户端提权路径 | SSE query / Streamable header / REST body 的 `permissionMode/allowWrite/X-DB-Permission-Mode` 直接进 `DbConfig` | 属实，规格 §1 已列 |
| G6 | 审计仅 pino 控制台、SQL 截断 100 字符 | `mcp-server.ts` 的 `console.error(query.substring(0,100))` | 属实，规格 §1 已列 |
| G7 | auth fail-open 后门 | `auth.ts:61-64` 未配置 keys 即放行；注册表模式下恒触发 | **规格 §3.1/§5 未点名，P1 必须处理（见 §4-1）** |
| G8 | 第三个存量测试 | `http-api.test.ts:110` 请求无 `source` 会在 fail-closed 后 403 | **规格 §12.2 未列，P1 顺带更新（见 §4-2）** |
| G9 | 版本号读取编译坑 | `tsconfig.json` `rootDir:"./src"` + `resolveJsonModule` | **规格 §10 未提示，须用运行时读取（见 §4-3）** |
| G10 | toolProfile 枚举 vs §9 表格 | 枚举 3 值（`legacy|registry-stdio|remote`）表格 4 行 | 规格内部措辞不一致，裁决见 §4-4 |
| G11 | `ADHOC_TARGET_ALLOWLIST` env | 规格 §3.1 无、手册 §3.1 有、用例 14d 必需 | 规格遗漏、手册已有，裁决见 §4-5 |
| G12 | fixtures 位置 | 仓库无 `fixtures/` 目录，规格 §11 提到但 §10 未列 | 放 `tests/fixtures/registry.json`，见 §4-6 |
| G13 | legacy 模式审计 principal | 规格 §8.1 只定义 registry 的 name 与 stdio 的 'local' | 裁决见 §4-7（防明文 key 入 NDJSON） |
| G14 | SIGHUP 用例 25-29 本机不可验 | Windows 无 SIGHUP 信号 | 靠 `reload()` 单测 + CI Linux 覆盖，处理方式确认 |
| G15 | CORS allowedHeaders 不含新头 | `server.ts:41` 仅 4 个头 | 补 `X-DB-*`/`X-Audit-User`，见 §4-8 |
| G16 | `query.ts/schema.ts` "无逻辑改动" vs 用例 7 | `validateQuery` 抛普通 `Error` 无错误码 | 需错误分类机制，见 §4-6 |
| G17 | REST /api/connect required 改 `[]` 后字段透传 | Fastify 默认 schema 未设 `additionalProperties:false` 时未知字段透传 | 已实证无坑；注意别顺手加 `additionalProperties:false` 忘加 `source` |
| G18 | `SUPPORTED_DB_TYPES` 与 `normalizeDbType` 别名感知不一致 | `mcp-sse.ts:47-51` 拒绝 `mssql/opengauss`，`adapter-factory.ts:47-55` 接受 | 注册表校验按规格用 `normalizeDbType`，legacy 通道保持现状（两套感知差异属存量行为，不扩大） |
| G19 | 会话元数据缺失 | REST `Session` 无 principal/source；MCP 三张 map 无元数据 | 需要轻量会话注册机制，见 §4-9 |
| G20 | `connection-manager.connect()` 签名变更风险 | `connection-stability.test.ts` 53 例不依赖 `connect()` | 安全，可直接改 |

---

## 3. 规格内直接执行的点（无歧义，不备案）

- §4.1 权限算法 `min(sourceMax ?? safe, keyMax ?? full)` 与 §4.2 决策表逐字实现。
- §3.3 校验规则 8 条全量实现、一次性列出全部错误后 `exit 1`。
- 错误码表 §6 与响应信封（REST/SSE 用 `{success,error,metadata}`；Streamable 用 JSON-RPC `-32001` + `data.code`；MCP 工具 `isError` + `[<CODE>] 中文`）。
- §5.1 stdio 零变更 + `--config/--source` 冲突报错语义。
- 审计字段格式 §8.2（含 SQL 截断 2048、`permission_ignored` 宽于判断、stdio 不写 stdout、写失败不阻断）。权限序 `safe < readwrite < full`。
- §7.1 SIGHUP 语义（仅 HTTP、原子替换、防重入、会话快照例外吊销）与 §7 会话语义表。
- `list_datasources` 只返回 name/type/description；`/api/info` 不暴露源名。
- 禁改文件清单与"不要动"清单照抄执行。

---

## 4. 规格外选择（备案裁决，实施后列入交付报告第 4 条）

| # | 主题 | 裁决 | 依据 |
|---|---|---|---|
| 1 | auth fail-open 分支 | 注册表模式：删除/绕过"无 key 即放行"分支，按 `apiKeys[].key` 判定 + 解析 `principal/keyFingerprint`；legacy 模式保持现有 `API_KEYS` env 判定。无有效 key 一律 401/403 | 规格 §1 目标"服务端权威"与 §3.1"API_KEYS 在注册表存在时被忽略"的组合推论；否则整个 ACL 形同虚设 |
| 2 | http-api.test.ts:110 | P1 一并更新：该用例改为带 `source` 的组织方式（fixtures），断言 200 或连接失败 502，不再是 403 语义混淆 | 测试随实现更新属 §12.2 同一精神 |
| 3 | 版本号读取 | 新增极小工具 `src/utils/package-version.ts`（`fs.readFileSync(new URL('../package.json', import.meta.url))` + JSON.parse），三处引用 | tsconfig rootDir 限制 + `files` 清单含 package.json（发布结构不变） |
| 4 | toolProfile 四态 | 实现为二维布尔 `(registryEnabled, isRemote)`，行为完全按 §9 表格 4 行；String 枚举仅作文档描述不作文法强制 | §9 表格是行为权威，枚举值表述不一致 |
| 5 | `ADHOC_TARGET_ALLOWLIST` env | 补实现：逗号分隔 `host:port`，仅 adhoc 生效，配置文件字段优先；legacy-remote 无配置时它是唯一来源 | 运维手册 §3.1 已有该变量定义；用例 14d 无它无法闭环；规格 §3.1 表格遗漏 |
| 6 | fixtures | 新建 `tests/fixtures/registry.json`（`ok-ro` safe、`ok-rw` readwrite、`k-full` 允许两源 `maxPermission: full`、`k-ro` 仅 `ok-ro`）；用例 9 的 `k-full.maxPermission=safe` 场景由该用例单独构造变体配置 | §11 前置说明引用 fixtures；§10 未列属笔误 |
| 7 | legacy principal | `principal='legacy'` + `keyFingerprint=sha256(key)前12位`，**绝不写明文 key 进 NDJSON** | 防密钥泄漏；规格 §8.1 未定义 legacy |
| 8 | CORS allowedHeaders | 追加 `X-DB-Source, X-DB-Type, X-DB-Host, X-DB-Port, X-DB-User, X-DB-Password, X-DB-Database, X-DB-FilePath, X-DB-Allow-Write, X-DB-Permission-Mode, X-DB-Permissions, X-DB-Oracle-Client-Path, X-Audit-User` | 浏览器端 Streamable HTTP 客户端预检必需；无安全副作用 |
| 9 | 会话注册机制 | 新增轻量会话注册（不建新文件，挂在 `ConnectionManager`/`mcp-sse.ts` 现有结构）：REST `Session` 增加 `principal/keyFingerprint/source` 字段；MCP 会话在 `DatabaseMCPServer` 增加 `sessionMeta` getter；`registry.reload()` 后由调用方（http-index）遍历两类会话执行 §7.1 例外吊销 | §7.1 需要跨会话类型扫描；规格未给统一注册表实现 |
| 10 | 权限错误分类 | 在 `database-service.ts`（不改 `safety.ts`）捕获 `validateQuery` 异常并重抛带 `code='PERMISSION_DENIED'` 的轻量错误类型（新文件 `src/security/errors.ts` 或复用现有结构）；`connection/query/schema` 路由按 code 映射 403/502 | 规格 §10"无逻辑改动"与 §6/用例 7 冲突，错误分类是该冲突的最小解 |

实施纪律：以上仅限 §4 表内；执行中若再遇规格未覆盖细节，**停下问交接方**，不自行发挥。

---

## 5. 团队分工与节奏（已与执行者确认）

分支 `feat/datasource-acl-3.0`（本地，不 push）。按 §13 P0→P6 串行 wave，每 wave 一个 worker，phase 结束即提交 `feat(acl): P<N> ...`；Wave 1 内 P0 与 P4a（审计模块）两个 worker 并行（文件零重叠，P4a 不提交、由协调者提交）。

| Wave | Phase | 内容 | 通过后验证 |
|---|---|---|---|
| W1 | P0 + P4a | 注册表模块（registry/决策/校验/ENV 展开）+ fixtures + 单测（registry ≥20、acl-decision ≥10）；审计模块（audit-context/audit-logger+单测，不接线） | `npm run test:unit` 绿；用例 1、2 |
| W2 | P1 | auth 主体解析（fail-closed）+ REST ACL + 错误码 + `denied` 审计接线 + 修第三个存量测试 | 用例 3–7、9 |
| W3 | P2 | SSE / Streamable + toolProfile 四态 + `permission_ignored`/`connect` 审计 | 用例 8、10–15、23 |
| W4 | P3 | stdio `--config/--source` + `connect_datasource`/`list_datasources` + `get_connection_status.source` + 版本号 | 用例 18–21 |
| W5 | P4b + P5 | 审计记录点全覆盖（query/metadata/connect/disconnect/denied）；SIGHUP 热加载 + 会话快照/吊销 + `config_reload`/`session_revoked` + `reload()` 单测 ≥8 | 用例 22、25–29 |
| W6 | P6 | 文档（README×2/API_REFERENCE/DIFY×2/CHATGPT×2/CHANGELOG/.env.example/MIGRATION-3.0.md）、CI test job + 删 lint、存量测试修复 ×2、version 3.0.0、手册与部署模板对齐回改 | 用例 24 + `npm test` 全绿 |

协调者每 wave 结束后跑 `npm run build` + `npx tsc --noEmit` + 相关测试验收，再放行下一 wave。最终由协调者完成 29 条用例验收矩阵与五段式交付报告。