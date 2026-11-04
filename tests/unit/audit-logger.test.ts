/**
 * AuditLogger 单元测试（P4a，接线 phase 之前）
 * 离线可跑：只用 node:os tmpdir 写临时文件，无任何真实数据库依赖。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger, type AuditLoggerOptions, type AuditRecord } from '../../src/security/audit-logger.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'audit-logger-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** 构造一条 §8.2 示例形态的完整记录 */
function baseEntry(): AuditRecord {
  return {
    event: 'query',
    requestId: 'req-1',
    transport: 'rest',
    principal: 'reporting-bot',
    keyFingerprint: 'ab12cd34ef56',
    source: 'finance-ro',
    clientIp: '10.0.0.9',
    sql: 'SELECT * FROM t',
    sqlBytes: 15,
    sqlTruncated: false,
    status: 'ok',
    errorCode: null,
    rows: 12,
    durationMs: 34,
  };
}

/** 写一条记录并落盘，返回文件内容与解析后的第一条记录 */
function writeOnce(
  options: AuditLoggerOptions = {},
  entry: AuditRecord = baseEntry()
): {
  content: string;
  parsed: Record<string, unknown>;
} {
  const file = join(makeTmpDir(), 'audit.ndjson');
  const logger = new AuditLogger({ auditLogPath: file, ...options });
  logger.write(entry);
  logger.close();
  const content = readFileSync(file, 'utf8');
  return { content, parsed: JSON.parse(content) as Record<string, unknown> };
}

describe('AuditLogger.truncateSql', () => {
  it('截断超过 2048 字符的 SQL，标记 sqlTruncated=true，保留前 2048 字符', () => {
    const logger = new AuditLogger();
    const sql = 'SELECT ' + 'a'.repeat(2090); // 总长 2100 字符
    const r = logger.truncateSql(sql);
    expect(r.sqlTruncated).toBe(true);
    expect(r.sql).toHaveLength(2048);
    expect(r.sql).toBe(sql.slice(0, 2048));
  });

  it('sqlBytes 为截断后字符串的 UTF-8 字节数（含中文多字节）', () => {
    const logger = new AuditLogger();
    const sql = "SELECT * FROM 用户表 WHERE 姓名 = '张三'";
    const r = logger.truncateSql(sql);
    expect(r.sqlTruncated).toBe(false);
    expect(r.sqlBytes).toBe(Buffer.byteLength(r.sql, 'utf8'));
    expect(r.sqlBytes).toBeGreaterThan(r.sql.length); // 中文按 UTF-8 3 字节计
  });

  it('截断包含中文时 sqlBytes 仍按截断后 UTF-8 字节计', () => {
    const logger = new AuditLogger();
    const sql = '中'.repeat(3000);
    const r = logger.truncateSql(sql);
    expect(r.sqlTruncated).toBe(true);
    expect(r.sql).toHaveLength(2048);
    expect(r.sqlBytes).toBe(2048 * 3);
  });

  it('短 SQL 不截断且返回原样', () => {
    const logger = new AuditLogger();
    expect(logger.truncateSql('SELECT 1')).toEqual({
      sql: 'SELECT 1',
      sqlBytes: 8,
      sqlTruncated: false,
    });
  });
});

describe('未配置 auditLogPath（禁用态）', () => {
  it('write() 为 no-op：不抛错、无失败计数、无副作用', () => {
    const onError = vi.fn();
    const logger = new AuditLogger({ logError: onError });
    expect(logger.isEnabled).toBe(false);
    expect(() => logger.write(baseEntry())).not.toThrow();
    expect(() => logger.write(baseEntry())).not.toThrow();
    expect(logger.writeFailureCount).toBe(0);
    expect(() => logger.close()).not.toThrow(); // close 幂等
  });

  it('构造时发启动 WARN（走 logError；缺省时走 stderr）', () => {
    const onError = vi.fn();
    const logger = new AuditLogger({ logError: onError });
    expect(logger.isEnabled).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(/审计|auditLogPath|AUDIT_LOG_PATH/);
  });
});

describe('auditUser 字段过滤（trustAuditUserHeader）', () => {
  it('trustAuditUserHeader=true 时保留 auditUser', () => {
    const { parsed } = writeOnce(
      { trustAuditUserHeader: true },
      { ...baseEntry(), auditUser: 'ops-x' }
    );
    expect(parsed.auditUser).toBe('ops-x');
  });

  it('trustAuditUserHeader=false（默认）时强制删除 auditUser', () => {
    const { parsed } = writeOnce({}, { ...baseEntry(), auditUser: 'ops-x' });
    expect('auditUser' in parsed).toBe(false);
  });
});

describe('NDJSON 输出格式', () => {
  it('每条记录一行合法 JSON，行尾带 \\n 换行', () => {
    const file = join(makeTmpDir(), 'audit.ndjson');
    const logger = new AuditLogger({ auditLogPath: file });
    for (let i = 1; i <= 3; i++) {
      logger.write({ ...baseEntry(), requestId: `req-${i}`, rows: i });
    }
    logger.close();
    const content = readFileSync(file, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    const lines = content.split('\n');
    expect(lines).toHaveLength(4); // 3 行数据 + 末尾空串
    const entries = lines.slice(0, 3).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entries[0].requestId).toBe('req-1');
    expect(entries[1].requestId).toBe('req-2');
    expect(entries[2].requestId).toBe('req-3');
  });

  it('ts 缺省时由 logger 补 ISO 时间戳', () => {
    const { parsed } = writeOnce({}, { ...baseEntry(), ts: undefined });
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('undefined 的可选字段在序列化时被省略', () => {
    const { parsed } = writeOnce({}, { ...baseEntry(), requestId: undefined, clientIp: undefined, rows: undefined });
    expect('requestId' in parsed).toBe(false);
    expect('clientIp' in parsed).toBe(false);
    expect('rows' in parsed).toBe(false);
    expect(parsed.event).toBe('query');
  });

  it('绝不写 stdout（stdio 模式会污染 JSON-RPC 帧）', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const file = join(makeTmpDir(), 'audit.ndjson');
      const logger = new AuditLogger({ auditLogPath: file });
      logger.write(baseEntry());
      logger.close();
    } finally {
      stdoutSpy.mockRestore();
    }
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});

describe('写入失败降级（绝不抛出、不阻断调用方）', () => {
  it('底层 writer 抛错：不抛错、失败计数递增、错误走 logError', () => {
    class ThrowingWriter extends AuditLogger {
      protected override writeLine(_fd: number, _line: string): void {
        throw new Error('injected writer failure');
      }
    }
    const onError = vi.fn();
    const logger = new ThrowingWriter({
      auditLogPath: join(makeTmpDir(), 'audit.ndjson'),
      logError: onError,
    });
    expect(() => logger.write(baseEntry())).not.toThrow();
    expect(() => logger.write(baseEntry())).not.toThrow();
    expect(logger.writeFailureCount).toBe(2);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0][0]).toMatch(/写入审计日志失败/);
    expect(() => logger.close()).not.toThrow();
  });

  it('目标路径不可写（父目录不存在）时同样降级', () => {
    const onError = vi.fn();
    const badPath = join(makeTmpDir(), 'no-such-dir', 'audit.ndjson'); // 父目录不存在 → open 失败
    const logger = new AuditLogger({ auditLogPath: badPath, logError: onError });
    expect(() => logger.write(baseEntry())).not.toThrow();
    expect(() => logger.write(baseEntry())).not.toThrow();
    expect(logger.writeFailureCount).toBeGreaterThan(0);
    expect(onError).toHaveBeenCalled();
    logger.close();
  });

  it('失败后再次写入会重新打开文件并成功落盘（容错）', () => {
    class FlakyWriter extends AuditLogger {
      private failOnce = true;
      protected override writeLine(fd: number, line: string): void {
        if (this.failOnce) {
          this.failOnce = false;
          throw new Error('injected one-time failure');
        }
        return super.writeLine(fd, line);
      }
    }
    const file = join(makeTmpDir(), 'audit.ndjson');
    const logger = new FlakyWriter({ auditLogPath: file });
    logger.write({ ...baseEntry(), requestId: 'req-lost' }); // 第一次写失败（丢行）
    logger.write({ ...baseEntry(), requestId: 'req-kept' }); // 第二次重开文件成功
    logger.close();
    expect(logger.writeFailureCount).toBe(1);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(parsed.requestId).toBe('req-kept');
  });
});

describe('errorCode 透传（必填由调用方保证，logger 只透传）', () => {
  it('denied 事件的 errorCode 原样写入，sql 可空', () => {
    const { parsed } = writeOnce(
      {},
      {
        ...baseEntry(),
        event: 'denied',
        status: 'denied',
        errorCode: 'ADHOC_DISABLED',
        sql: undefined,
        sqlBytes: undefined,
        sqlTruncated: undefined,
      }
    );
    expect(parsed.event).toBe('denied');
    expect(parsed.errorCode).toBe('ADHOC_DISABLED');
    expect('sql' in parsed).toBe(false);
  });

  it('正常事件 errorCode=null 也原样保留', () => {
    const { parsed } = writeOnce({}, baseEntry());
    expect(parsed.status).toBe('ok');
    expect(parsed.errorCode).toBe(null);
  });
});

describe('close() 与落盘', () => {
  it('close() 后数据已写入文件', () => {
    const { content, parsed } = writeOnce({}, { ...baseEntry(), requestId: 'req-final' });
    expect(content).toContain('req-final');
    expect(parsed.requestId).toBe('req-final');
  });

  it('close() 幂等，多次调用安全', () => {
    const file = join(makeTmpDir(), 'audit.ndjson');
    const logger = new AuditLogger({ auditLogPath: file });
    logger.write(baseEntry());
    logger.close();
    logger.close();
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(parsed.requestId).toBe('req-1');
  });
});