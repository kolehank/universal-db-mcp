/**
 * 3.0.1 安全加固集成测试：
 * - P0-5 createHttpServer fail-closed（无注册表时必须 API_KEYS + ALLOW_ADHOC_CONNECTIONS）
 * - P0-6 SSE URL 口令拒绝
 * - P1-8 鉴权失败审计
 * - P1-9 AUDIT_REQUIRED 启动强制
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../../src/http/server';
import { buildRegistryFromRaw } from '../../src/security/datasource-registry';
import { AuditLogger } from '../../src/security/audit-logger';
import type { AppConfig } from '../../src/types/http';

const FIXTURES = join(__dirname, '..', 'fixtures');

function config(apiKeys: string[] = []): AppConfig {
  return {
    mode: 'http',
    http: {
      port: 0,
      host: '127.0.0.1',
      apiKeys,
      cors: { origins: '*', credentials: false },
      rateLimit: { max: 1000, window: '1m' },
      logging: { level: 'error', pretty: false },
      session: { timeout: 3600000, cleanupInterval: 300000 },
    },
  };
}

function registry() {
  const raw = JSON.parse(readFileSync(join(FIXTURES, 'registry.json'), 'utf-8'));
  return buildRegistryFromRaw(raw, 'hardening-test');
}

describe('P0-5 启动 fail-closed', () => {
  it('无注册表且 API_KEYS 为空 → 拒绝创建服务', async () => {
    await expect(
      createHttpServer(config([]), { securityEnv: { allowAdhocConnections: true } })
    ).rejects.toThrow(/API_KEYS/);
  });

  it('无注册表且未开 ALLOW_ADHOC_CONNECTIONS → 拒绝创建服务', async () => {
    await expect(
      createHttpServer(config(['k']), { securityEnv: {} })
    ).rejects.toThrow(/ALLOW_ADHOC_CONNECTIONS/);
  });

  it('P1-9 AUDIT_REQUIRED=true 但无 AUDIT_LOG_PATH → 拒绝创建服务', async () => {
    await expect(
      createHttpServer(config(['k']), {
        securityEnv: { allowAdhocConnections: true, auditRequired: true },
      })
    ).rejects.toThrow(/AUDIT_LOG_PATH/);
  });
});

describe('P1-8 鉴权失败审计', () => {
  it('缺少 API key → 401 且写入 event=denied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hardening-'));
    const auditPath = join(dir, 'audit.ndjson');
    const server = await createHttpServer(config([]), {
      registry: registry(),
      auditLogger: new AuditLogger({ auditLogPath: auditPath }),
      securityEnv: {},
    });
    try {
      const res = await server.inject({ method: 'GET', url: '/api/tables?sessionId=x' });
      expect(res.statusCode).toBe(401);

      const lines = readFileSync(auditPath, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const denied = lines.filter((r) => r.event === 'denied');
      expect(denied).toHaveLength(1);
      expect(denied[0].errorCode).toBe('UNAUTHORIZED');
      expect(denied[0].keyFingerprint).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

describe('P0-6 SSE URL 不接受口令', () => {
  it('GET /sse?password=... → 400，且错误信息提示改用请求头/注册表', async () => {
    const key = 'test-key-full'; // fixtures/registry.json 中的 k-full
    const server = await createHttpServer(config([]), {
      registry: registry(),
      securityEnv: {},
    });
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/sse?type=mysql&host=127.0.0.1&port=3306&password=secret',
        headers: { 'X-API-Key': key },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toContain('X-DB-Password');
    } finally {
      await server.close();
    }
  });
});
