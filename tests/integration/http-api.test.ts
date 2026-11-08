/**
 * HTTP API Integration Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHttpServer } from '../../src/http/server';
import type { AppConfig } from '../../src/types/http';

describe('HTTP API Integration Tests', () => {
  let server: any;
  const testConfig: AppConfig = {
    mode: 'http',
    http: {
      port: 3001,
      host: '127.0.0.1',
      apiKeys: ['test-key'],
      cors: {
        origins: '*',
        credentials: false
      },
      rateLimit: {
        max: 100,
        window: '1m'
      },
      logging: {
        level: 'error',
        pretty: false
      },
      session: {
        timeout: 3600000,
        cleanupInterval: 300000
      }
    }
  };

  beforeAll(async () => {
    // legacy（无注册表）模式：必须显式开启 adhoc，否则 createHttpServer 会 fail-closed 拒绝启动
    server = await createHttpServer(testConfig, {
      securityEnv: { allowAdhocConnections: true },
    });
    await server.listen({ port: testConfig.http!.port, host: testConfig.http!.host });
  });

  afterAll(async () => {
    await server.close();
  });

  describe('Health Endpoints', () => {
    it('should return health status', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/health'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('healthy');
    });

    it('should return service info', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/info'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('universal-db-mcp');
      expect(body.data.supportedDatabases).toBeInstanceOf(Array);
    });
  });

  describe('Authentication', () => {
    it('should reject requests without API key', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/connect',
        payload: {
          type: 'mysql',
          host: 'localhost',
          port: 3306
        }
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('should reject requests with invalid API key', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/connect',
        headers: {
          'X-API-Key': 'invalid-key'
        },
        payload: {
          type: 'mysql',
          host: 'localhost',
          port: 3306
        }
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('should reject client-supplied SQLite filePath (P0-7)', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/connect',
        headers: {
          'X-API-Key': 'test-key'
        },
        payload: {
          type: 'sqlite',
          filePath: ':memory:'
        }
      });

      // P0-7：SQLite 文件路径只能由服务端注册表/启动参数指定，客户端提交 → 400。
      // （鉴权已通过：返回 400 而不是 401/403）
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toContain('filePath');
    });
  });

  describe('CORS', () => {
    it('should handle CORS preflight with origin headers', async () => {
      // @fastify/cors v9 对无 Origin 的预检返回 400（测试过时而非服务端缺陷）。
      // 浏览器真实预检必带 origin + access-control-request-method，返回 204。
      const response = await server.inject({
        method: 'OPTIONS',
        url: '/api/health',
        headers: {
          origin: 'http://localhost',
          'access-control-request-method': 'POST'
        }
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBeDefined();
      expect(response.headers['access-control-allow-methods']).toBeDefined();
    });
  });
});
