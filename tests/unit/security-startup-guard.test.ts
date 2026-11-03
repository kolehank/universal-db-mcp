/**
 * fail-closed 启动守卫（用例 1）与 loadSecurityEnv 单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shouldFailClosedHttpStart } from '../../src/http/http-index';
import { loadSecurityEnv } from '../../src/utils/config-loader';

describe('shouldFailClosedHttpStart（fail-closed 纯判定）', () => {
  it('无 DATASOURCE_CONFIG 且 ALLOW_ADHOC_CONNECTIONS 未设 → 拒绝启动', () => {
    expect(shouldFailClosedHttpStart(undefined, undefined)).toBe(true);
  });

  it('无 DATASOURCE_CONFIG 且 ALLOW_ADHOC_CONNECTIONS=false → 拒绝启动', () => {
    expect(shouldFailClosedHttpStart(undefined, false)).toBe(true);
  });

  it('无 DATASOURCE_CONFIG 但 ALLOW_ADHOC_CONNECTIONS=true → 放行（legacy 模式）', () => {
    expect(shouldFailClosedHttpStart(undefined, true)).toBe(false);
  });

  it('有 DATASOURCE_CONFIG → 放行（即使 adhoc 未开）', () => {
    expect(shouldFailClosedHttpStart('/etc/registry.json', undefined)).toBe(false);
    expect(shouldFailClosedHttpStart('/etc/registry.json', false)).toBe(false);
  });
});

describe('loadSecurityEnv（§3.1 环境变量解析）', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('全部未设置时返回空对象（undefined 默认）', () => {
    delete process.env.DATASOURCE_CONFIG;
    delete process.env.ALLOW_ADHOC_CONNECTIONS;
    delete process.env.ADHOC_TARGET_ALLOWLIST;
    delete process.env.AUDIT_LOG_PATH;
    delete process.env.TRUST_AUDIT_USER_HEADER;
    const config = loadSecurityEnv();
    expect(config.datasourceConfig).toBeUndefined();
    expect(config.allowAdhocConnections).toBeUndefined();
    expect(config.adhocTargetAllowlist).toBeUndefined();
    expect(config.auditLogPath).toBeUndefined();
    expect(config.trustAuditUserHeader).toBeUndefined();
  });

  it('解析全部五个变量', () => {
    process.env.DATASOURCE_CONFIG = 'C:\\configs\\registry.json';
    process.env.ALLOW_ADHOC_CONNECTIONS = 'true';
    process.env.ADHOC_TARGET_ALLOWLIST = '10.1.2.3:3306, db.internal:5432 ,';
    process.env.AUDIT_LOG_PATH = '/var/log/audit.ndjson';
    process.env.TRUST_AUDIT_USER_HEADER = 'true';
    const config = loadSecurityEnv();
    expect(config.datasourceConfig).toBe('C:\\configs\\registry.json');
    expect(config.allowAdhocConnections).toBe(true);
    expect(config.adhocTargetAllowlist).toEqual(['10.1.2.3:3306', 'db.internal:5432']);
    expect(config.auditLogPath).toBe('/var/log/audit.ndjson');
    expect(config.trustAuditUserHeader).toBe(true);
  });

  it('ALLOW_ADHOC_CONNECTIONS 仅接受 "true" → true，其余 → false', () => {
    process.env.ALLOW_ADHOC_CONNECTIONS = 'true';
    expect(loadSecurityEnv().allowAdhocConnections).toBe(true);
    process.env.ALLOW_ADHOC_CONNECTIONS = 'false';
    expect(loadSecurityEnv().allowAdhocConnections).toBe(false);
    process.env.ALLOW_ADHOC_CONNECTIONS = '1';
    expect(loadSecurityEnv().allowAdhocConnections).toBe(false);
  });

  it('TRUST_AUDIT_USER_HEADER 布尔解析', () => {
    process.env.TRUST_AUDIT_USER_HEADER = 'true';
    expect(loadSecurityEnv().trustAuditUserHeader).toBe(true);
    process.env.TRUST_AUDIT_USER_HEADER = 'false';
    expect(loadSecurityEnv().trustAuditUserHeader).toBe(false);
  });
});