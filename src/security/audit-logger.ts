/**
 * 审计日志写入器（NDJSON，best-effort）—— 规格 §8.2
 *
 * 设计约束：
 * - 一行一个 JSON 对象（NDJSON），追加写（flag 'a'），文件不存在时自动创建。
 * - **绝对不能写 stdout**：stdio 模式下 stdout 用于 JSON-RPC 帧，任何审计输出都会污染协议帧。
 *   审计只允许写入 auditLogPath 文件（未配置则为禁用态，连文件都不产生），
 *   错误/WARN 只走 stderr 或注入的 logError。
 * - 写入失败绝不抛出、绝不阻断调用方：stderr/logError 打错误 + 内部失败计数 + 关闭坏 fd，
 *   下次 write() 重新尝试打开文件（容错）。审计是 best-effort，丢行可接受。
 * - 轮转交给外部（logrotate/journald），应用内不做轮转。
 * - keyFingerprint 由调用方提供（sha256(key) 前 12 位）；本模块不接收、不记录明文 key（评审裁决 7）。
 */

import { openSync, writeSync, closeSync } from 'node:fs';
import type { AuditContext } from './audit-context.js';

/** SQL 截断长度（字符），规格 §8.2 */
export const MAX_SQL_LENGTH = 2048;

/** 审计事件类型（规格 §8.2） */
export type AuditEvent =
  | 'query'
  | 'metadata'
  | 'connect'
  | 'disconnect'
  | 'denied'
  | 'permission_ignored'
  | 'session_revoked'
  | 'config_reload';

/** 单条审计记录（§8.2 字段；值为 undefined 的字段在序列化时省略，null 则原样保留） */
export interface AuditRecord {
  /** ISO 8601 时间戳；缺省由 logger 补全 */
  ts?: string;
  event: AuditEvent;
  /** 以下五字段由调用方从 AuditContext 带入；缺省 undefined 允许，序列化时省略 */
  requestId?: string;
  transport?: AuditContext['transport'];
  principal?: string;
  keyFingerprint?: string;
  source?: string;
  clientIp?: string;
  /** 仅 trustAuditUserHeader=true 时保留（logger 强制过滤，详见 write） */
  auditUser?: string;
  sql?: string;
  sqlBytes?: number;
  sqlTruncated?: boolean;
  status: string;
  /** 拒绝类事件（denied 等）的 errorCode 必填由调用方保证，logger 只透传 */
  errorCode?: string | null;
  rows?: number;
  durationMs?: number;
  /**
   * 以下字段为 P6 新增的可选扩展（对既有事件零影响——仅当调用方显式提供时才出现在序列化输出中）：
   * - session_revoked：reason（吊销原因，与 errorCode 同源，native 承载）+ sessionId（被吊销会话）；
   * - config_reload：configSha256（配置文件 sha256） + sourceCount/keyCount/closedSessions（统计）。
   * 自 3.0.1（审查修复）起 http-index 已直接用 native 字段落盘，不再用 rows/sql(JSON) 承载。
   */
  sessionId?: string;
  reason?: string;
  configSha256?: string;
  sourceCount?: number;
  keyCount?: number;
  closedSessions?: number;
}

export interface AuditLoggerOptions {
  /** NDJSON 审计文件路径；未设置 → 禁用态 + 启动 WARN，write() 全部变 no-op */
  auditLogPath?: string;
  /** 是否保留 auditUser 字段（对应 TRUST_AUDIT_USER_HEADER）；默认 false */
  trustAuditUserHeader?: boolean;
  /** 错误/WARN 出口；缺省走 stderr（console.error） */
  logError?: (msg: string) => void;
}

export interface SqlTruncationInfo {
  sql: string;
  /** 截断后字符串的 UTF-8 字节数（规格示例 sqlBytes 与 sql 原文对应） */
  sqlBytes: number;
  sqlTruncated: boolean;
}

export class AuditLogger {
  /** 审计文件路径；未设置时为 undefined（禁用态） */
  readonly auditLogPath: string | undefined;

  private readonly trustAuditUserHeader: boolean;
  private readonly logError?: (msg: string) => void;
  private readonly enabled: boolean;
  private fd: number | null = null;
  private failureCount = 0;

  constructor(options: AuditLoggerOptions = {}) {
    this.auditLogPath = options.auditLogPath;
    this.trustAuditUserHeader = options.trustAuditUserHeader === true;
    this.logError = options.logError;
    this.enabled = typeof options.auditLogPath === 'string' && options.auditLogPath.length > 0;
    if (!this.enabled) {
      // 启动 WARN：走 stderr / logError，不写 stdout
      this.report(
        '[audit] 警告: 未配置审计日志路径（auditLogPath / AUDIT_LOG_PATH），审计日志已禁用，write() 将被忽略'
      );
    }
  }

  /** 审计是否启用（未配置 auditLogPath 即为禁用态） */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 写入失败累计次数（排障 / 测试用） */
  get writeFailureCount(): number {
    return this.failureCount;
  }

  /**
   * SQL 截断：超过 2048 字符截断，返回截断结果与字节数。
   * sqlBytes = 截断后字符串的 UTF-8 字节数；sqlTruncated=true 表示发生了截断。
   */
  truncateSql(sql: string): SqlTruncationInfo {
    const truncated = sql.length > MAX_SQL_LENGTH ? sql.slice(0, MAX_SQL_LENGTH) : sql;
    return {
      sql: truncated,
      sqlBytes: Buffer.byteLength(truncated, 'utf8'),
      sqlTruncated: truncated.length < sql.length,
    };
  }

  /**
   * 追加一条审计记录（一行 JSON + '\n'）。
   * - ts 缺省补 ISO 时间；undefined 字段序列化时省略；
   * - auditUser 仅在 trustAuditUserHeader=true 时保留，否则强制删除；
   * - 读取/写入失败只降级（stderr/logError + 失败计数），**绝不抛出**。
   * 注意：调用方应先用 truncateSql() 截断 sql，并把结果字段放入 entry。
   */
  write(entry: AuditRecord): void {
    if (!this.enabled) {
      return;
    }
    this.appendLine(this.serialize(entry));
  }

  /**
   * 关闭审计日志文件（幂等，多次调用安全）。
   * 本实现为同步写，无待 flush 缓冲；close() 返回后文件内容即可被读取。
   */
  close(): void {
    this.closeFileQuietly();
  }

  private serialize(entry: AuditRecord): string {
    // 固定字段顺序（与 §8.2 示例一致）；undefined 由 JSON.stringify 自动省略，null 保留
    const record: Record<string, unknown> = {
      ts: entry.ts ?? new Date().toISOString(),
      event: entry.event,
      requestId: entry.requestId,
      transport: entry.transport,
      principal: entry.principal,
      keyFingerprint: entry.keyFingerprint,
      source: entry.source,
      clientIp: entry.clientIp,
      auditUser: this.trustAuditUserHeader ? entry.auditUser : undefined,
      sql: entry.sql,
      sqlBytes: entry.sqlBytes,
      sqlTruncated: entry.sqlTruncated,
      status: entry.status,
      errorCode: entry.errorCode,
      rows: entry.rows,
      durationMs: entry.durationMs,
      sessionId: entry.sessionId,
      reason: entry.reason,
      configSha256: entry.configSha256,
      sourceCount: entry.sourceCount,
      keyCount: entry.keyCount,
      closedSessions: entry.closedSessions,
    };
    return JSON.stringify(record);
  }

  private appendLine(line: string): void {
    const path = this.auditLogPath;
    if (path === undefined) {
      return; // 防御：write() 已按 enabled 提前返回
    }
    let fd = this.fd;
    if (fd === null) {
      try {
        fd = this.openFile(path);
        this.fd = fd;
      } catch (err) {
        this.failureCount += 1;
        this.report(`[audit] 错误: 打开审计日志文件失败（${path}）: ${messageOf(err)}`);
        return;
      }
    }
    try {
      this.writeLine(fd, line + '\n');
    } catch (err) {
      this.failureCount += 1;
      // 关闭坏 fd，下次 write() 重新尝试打开文件（容错）
      this.closeFileQuietly();
      this.report(`[audit] 错误: 写入审计日志失败: ${messageOf(err)}`);
    }
  }

  private closeFileQuietly(): void {
    if (this.fd === null) {
      return;
    }
    const fd = this.fd;
    this.fd = null;
    try {
      this.closeFile(fd);
    } catch {
      // 关闭失败不计数（best-effort），只打日志
    }
  }

  private report(msg: string): void {
    if (this.logError) {
      this.logError(msg);
    } else {
      console.error(msg); // stderr
    }
  }

  // ---- 以下三个 protected 方法仅为测试注入"会抛错的 writer"提供接缝，非公开 API ----

  /** 打开审计日志文件（append 模式）。父目录不存在或路径不可写会抛错 → 由 write() 降级处理。 */
  protected openFile(path: string): number {
    return openSync(path, 'a');
  }

  /** 追加一行到文件。 */
  protected writeLine(fd: number, line: string): void {
    writeSync(fd, line, null, 'utf8');
  }

  /** 关闭文件。 */
  protected closeFile(fd: number): void {
    closeSync(fd);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}