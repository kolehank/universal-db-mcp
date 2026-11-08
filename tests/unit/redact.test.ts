/**
 * 日志 / 审计脱敏（P0-6、P1-10）单元测试
 */

import { describe, it, expect } from 'vitest';
import { redactUrl, redactSecretsInSql } from '../../src/utils/redact';
import { AuditLogger } from '../../src/security/audit-logger';

describe('redactUrl', () => {
  it('抹掉 query 中的口令与密钥参数', () => {
    const url = '/sse?type=mysql&host=h&password=p%40ss&token=abc&x-db-password=xyz';
    const redacted = redactUrl(url);
    expect(redacted).not.toContain('p%40ss');
    expect(redacted).not.toContain('abc');
    expect(redacted).not.toContain('xyz');
    expect(redacted).toContain('password=***');
    expect(redacted).toContain('type=mysql');
  });

  it('无 query 或普通参数保持不变', () => {
    expect(redactUrl('/api/health')).toBe('/api/health');
    expect(redactUrl('/api/tables?sessionId=abc')).toBe('/api/tables?sessionId=abc');
  });
});

describe('redactSecretsInSql', () => {
  it('脱敏 IDENTIFIED BY', () => {
    expect(redactSecretsInSql("ALTER USER u IDENTIFIED BY 'secret123'")).toBe(
      "ALTER USER u IDENTIFIED BY '***'"
    );
  });

  it('脱敏 password / token 赋值', () => {
    expect(redactSecretsInSql("SET password = 'abc'")).toBe("SET password = '***'");
    expect(redactSecretsInSql("UPDATE u SET token='xyz' WHERE id=1")).toBe(
      "UPDATE u SET token = '***' WHERE id=1"
    );
  });

  it('普通业务 SQL 保持可读', () => {
    expect(redactSecretsInSql("SELECT * FROM users WHERE name = 'alice'")).toBe(
      "SELECT * FROM users WHERE name = 'alice'"
    );
  });
});

describe('AuditLogger.prepareSql', () => {
  it('默认脱敏后再截断', () => {
    const logger = new AuditLogger({});
    const info = logger.prepareSql("ALTER USER u IDENTIFIED BY 'p@ss'");
    expect(info.sql).toBe("ALTER USER u IDENTIFIED BY '***'");
    expect(info.sqlTruncated).toBe(false);
  });

  it('redactSensitiveSql=false 时保留原文', () => {
    const logger = new AuditLogger({ redactSensitiveSql: false });
    const sql = "ALTER USER u IDENTIFIED BY 'p@ss'";
    expect(logger.prepareSql(sql).sql).toBe(sql);
  });

  it('truncateSql 仍返回原文（供需要原文的调用方）', () => {
    const logger = new AuditLogger({});
    const sql = "ALTER USER u IDENTIFIED BY 'p@ss'";
    expect(logger.truncateSql(sql).sql).toBe(sql);
  });
});
