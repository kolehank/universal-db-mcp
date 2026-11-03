/**
 * 审计上下文（规格 §8.1）
 *
 * 用 Node 内置 AsyncLocalStorage 在请求 / 工具调用边界传递审计上下文：
 * - HTTP：auth 中间件 `runWithAuditContext(ctx, next)`；
 * - stdio：MCP 工具 handler 入口设置；
 * - 每次工具调用必须按会话**当前源**重新绑定 `source`（切源后不得沿用旧值）。
 *
 * `keyFingerprint` 为 `sha256(key)` 前 12 位（评审裁决 7：任何情况下不记录明文 key 进审计），
 * 由接线方计算后放入上下文；本模块只负责传递，不接触 key 明文。
 *
 * 模块级兜底审计（无上下文时的 fallback 写法）留到接线 phase 实现，本文件不含。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** 审计上下文（§8.1），字段含义见规格；auditUser 仅审计关联，绝不参与授权 */
export interface AuditContext {
  requestId: string;
  transport: 'stdio' | 'sse' | 'streamable' | 'rest';
  /** 审计主体：注册表模式为 apiKeys[].name；stdio 固定 'local'；legacy 固定 'legacy'（评审裁决 7） */
  principal: string;
  /** sha256(key) 前 12 位；禁止明文 key 入审计 */
  keyFingerprint: string;
  /** 源名；adhoc 固定 'adhoc' */
  source: string;
  clientIp: string;
  /** 仅 TRUST_AUDIT_USER_HEADER=true 时由调用方声明赋的值；只用于审计关联，不参与授权判断 */
  auditUser?: string;
}

const auditStorage = new AsyncLocalStorage<AuditContext>();

/**
 * 在 ctx 审计上下文内执行 fn（同步或异步均可，async 边界内 getAuditContext() 仍有效）。
 * 嵌套调用会临时覆盖外层上下文，退出内层后恢复外层；非并发共享，互不串扰。
 * @returns fn 的返回值（同步值或 Promise 原样透传）
 */
export function runWithAuditContext<T>(ctx: AuditContext, fn: () => T): T {
  return auditStorage.run(ctx, fn);
}

/** 取当前审计上下文；不在任何 runWithAuditContext 作用域内时返回 undefined */
export function getAuditContext(): AuditContext | undefined {
  return auditStorage.getStore();
}