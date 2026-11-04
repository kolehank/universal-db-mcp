# 多代理 Wave 实施的经验教训（超时分析）

> 来源：universal-db-mcp 3.0.0「数据源注册表 + 按源 ACL」改造（分支 `feat/datasource-acl-3.0`，2026-11-04）。
> 适用读者：后续用「协调者 + 多个子代理（worker）波浪式执行」方式改本仓库（或同类仓库）的团队。
> 配套文档：`docs/plan/datasource-acl-review.md`（该任务的评审结论与规格外裁决）。

---

## 1. 背景：我们使用的执行模式

- 一个协调者（主会话）+ 多个 worker 子代理；按规格 Phase 划分波浪（wave），每 wave 一个 worker，phase 结束提交一次 `feat(acl): P<N> ...`。
- Wave 1 允许两个文件零重叠的 worker 并行（P0 + P4 审计模块），其余波浪串行（同一工作目录，避免 git/文件冲突）。
- 每个 worker 的任务书包含：必读文档、环境备忘、交付物、禁改清单、验收命令、提交指令。

## 2. 超时事实（9 次 worker 中 2 次）

两次都撞上了协调者统一设置的 `timeoutSeconds=1800`（30 分钟硬上限），**不是任务失败或死循环**：

| 事件 | 实际状态 | 根因 |
|---|---|---|
| P1 worker（REST ACL） | 活已干完并已提交（`4494a41`），超时发生在「写五段式回报」阶段，收尾被截断 | 回报写作是隐性成本；deadline 花在正文上 |
| P2 主 worker（SSE/Streamable + toolProfile） | 任务体量过大：`mcp-sse.ts` + `mcp-server.ts` 约 1500 行 diff，还需接线 runtime/server、写集成测试；在编译修复中途被截断 | 单 turn 体量超预算：worker 完整循环（读规格→改码→build→tsc→test→修错）多轮，跨 8~15 个文件时 30 分钟不够 |

恢复方式（已验证有效）：P1 先查 `git status/log` 确认已提交，只补验证；P2 由协调者手工修 3 处编译错误（`RouteRuntime` 缺 `adapterFactory`、类型收窄），再补派一个只写集成测试的短 worker 完成提交。**没有盲目重派。**

## 3. 根因归纳

1. **单 turn 体量超预算**：P1/P2 恰是全部 phase 中最大的两个（跨 8~15 个文件）。每个 build/tsc/test/修错 循环是分钟级，多轮循环累计轻松超过 30 分钟。
2. **回报写作是隐性成本**：P1 工作已完成，纯粹被「写详细回报」截断。
3. **没有中途 checkpoint**：P2 若在 `mcp-server.ts` 改完时先提交一轮，损失会小得多。
4. **环境层面小问题**：并行波浪里重 build/test 互相抢 CPU 变慢；提交者身份混用（`P0 Worker` / `Cindy` 两个 git 身份）。

## 4. 可操作清单（下次执行直接照做）

| # | 措施 | 具体做法 |
|---|---|---|
| 1 | **切碎任务** | 单 worker 单 turn 的 diff 控制在 ~800 行内；大 phase 拆成「实现」与「测试 + 提交」两个 worker（或串行两轮）。P2 拆开后（主代码 / 测试收尾）两个 worker 都顺利按时完成 |
| 2 | **加时间预算** | 大 wave 的 `timeoutSeconds` 提到 3600–5400（工具上限 86400）；超长任务用 async 分离，事后 `get/wait` 收结果 |
| 3 | **提交纪律写进任务书** | 明确「完成验证后**立即 git commit，别等回报才提交**」，回报压到 20 行内。P5/P6 的 worker 都按要求做，全部准时完成，验证了这条最有效 |
| 4 | **超时先查状态再动手** | `git status/log` + `npm run build` + 测试确认 worker 实际做到哪，再决定补什么；不盲目重派（P1 若重派就是白干） |
| 5 | **派工前配好 git 身份** | 仓库级 `git config user.name/email` 先设置，避免提交历史身份混杂 |
| 6 | **并行纪律** | 重 build/test 的波浪不要双 worker 并行；并行只允许「文件零重叠 + 只写不提交」的组合 |

## 5. 标准 worker 任务书要素（模板）

```
【必读】规格/线索文档（给路径，让 worker 自己读，不许凭记忆）
【范围】本 wave 的交付物清单（精确到文件名）
【环境】node 路径 / 禁止 npm install / 验收命令（build + tsc --noEmit + 单测 + 集成）
【硬性约束】禁改文件清单（按波浪边界隔离，worker 只 import 别的 wave 的产物）
【提交】完成验证后立即 git commit（message 前缀固定），不 push；只 add 自己产出的文件
【回报格式】①文件清单 ②测试摘要 ③提交 hash ④规格外选择 ⑤发现的矛盾 —— 压到 20 行内
```

## 6. 超时/中断后的标准恢复流程

1. `git log --oneline -5` + `git status --short`：确认是否已提交、哪些文件动了。
2. 若已提交（如 P1）：直接跑验收命令，确认无回归即可。
3. 若半途中断（如 P2）：先 `npm run build`/`npx tsc --noEmit` 看编译错误，补完剩余接线；把「测试 + 提交」切成短任务派给第二个 worker。
4. 无论哪种情况，只接手未完成的最小剩余工作，不改已完成的逻辑。

---

*本文档为过程经验记录，不构成对 `docs/plan/datasource-acl.md`（规格）的修改。*