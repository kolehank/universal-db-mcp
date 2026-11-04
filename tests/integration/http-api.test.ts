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
    server = await createHttpServer(testConfig);
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

    it('should accept requests with valid API key (registry-less mode: adhoc denied without source)', async () => {
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

      // P1 fail-closed：无 DATASOURCE_CONFIG 且未开 ALLOW_ADHOC_CONNECTIONS 时，无 source 的
      // adhoc 连接请求 → 403 ADHOC_DISABLED（不再 [200,500]）。
      // 鉴权通过（带 source）的 200 场景由 acl-http.test.ts 覆盖。
      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('ADHOC_DISABLED');
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
