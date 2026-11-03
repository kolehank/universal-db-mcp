/**
 * 审计拒绝类事件写入辅助（P1 REST ACL 接线用）
 *
 * 规格 §6：「任何 denied / permission_ignored 必须落审计，即使响应是 404」。
 * 本文件封装两条规则：
 * - 只在存在 AuditLogger 且当前请求处于 AuditContext 作用域（auditScope）内时才写；
 * - deny 场景可选 source 覆盖（SOURCE_NOT_FOUND 记请求的源名；adhoc 记 'adhoc'）。
 * 写失败由 AuditLogger 自行降级（绝不抛出、不阻断请求）。
 */

import { getAuditContext } from '../security/audit-context.js';
import type { AuditLogger } from '../security/audit-logger.js';

/** 记录一条 denied 审计（errorCode 必填；source 可覆盖上下文中的源名） */
export function auditDenied(logger: AuditLogger | undefined, errorCode: string, source?: string): void {
  if (!logger) {
    return;
  }
  const ctx = getAuditContext();
  if (!ctx) {
    return;
  }
  if (source !== undefined) {
    ctx.source = source;
  }
  logger.write({
    event: 'denied',
    requestId: ctx.requestId,
    transport: ctx.transport,
    principal: ctx.principal,
    keyFingerprint: ctx.keyFingerprint,
    source: ctx.source || undefined,
    clientIp: ctx.clientIp,
    status: 'denied',
    errorCode,
  });
}

/** 记录一条 permission_ignored 审计（客户端提交的权限声明宽于生效权限时，§4.1） */
export function auditPermissionIgnored(logger: AuditLogger | undefined, source: string): void {
  if (!logger) {
    return;
  }
  const ctx = getAuditContext();
  if (!ctx) {
    return;
  }
  logger.write({
    event: 'permission_ignored',
    requestId: ctx.requestId,
    transport: ctx.transport,
    principal: ctx.principal,
    keyFingerprint: ctx.keyFingerprint,
    source: source || ctx.source || undefined,
    clientIp: ctx.clientIp,
    status: 'ignored',
    errorCode: null,
  });
}