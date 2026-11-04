/**
 * Query Routes
 * Query execution endpoints
 *
 * P1（评审裁决 §4-6/10）：catch 按 error.code 映射 —— validateQuery 拒绝包成 AclError('PERMISSION_DENIED')
 * → 403；其余保持既有 500 语义（换码 QUERY_FAILED / EXECUTE_FAILED 不变）。
 * 每次执行前把会话 source 绑定回审计上下文（§8.1「切源后不得沿用旧值」）。
 */

import type { FastifyInstance } from 'fastify';
import type { QueryRequest, ExecuteRequest, ApiResponse, HttpQueryResult } from '../../types/http.js';
import type { QueryResult } from '../../types/adapter.js';
import { ConnectionManager } from '../../core/connection-manager.js';
import { auditScope } from '../middleware/index.js';
import type { RouteRuntime } from './runtime.js';
import { getAuditContext } from '../../security/audit-context.js';
import { classifyError } from '../../security/errors.js';

export async function setupQueryRoutes(
  fastify: FastifyInstance,
  connectionManager: ConnectionManager,
  // P4b：查询失败/拒绝的审计已在 DatabaseService 记录点统一写，路由层不再需要 runtime；
  // 参数保留以与 setupRoutes 的调用形参对齐（_runtime 避免 noUnusedParameters）
  _runtime: RouteRuntime = {}
): Promise<void> {
  /**
   * POST /api/query
   * Execute a query (read operations)
   */
  fastify.post<{
    Body: QueryRequest;
    Reply: ApiResponse<HttpQueryResult>;
  }>('/api/query', {
    schema: {
      body: {
        type: 'object',
        required: ['sessionId', 'query'],
        properties: {
          sessionId: { type: 'string' },
          query: { type: 'string' },
          params: { type: 'array' },
        },
      },
    },
  }, async (request, reply) => {
    return auditScope(request, async () => {
      try {
        const { sessionId, query, params } = request.body;

        // 会话 source 回绑审计上下文（query 时读取会话，§8.1）
        const session = connectionManager.getSession(sessionId);
        const ctx = getAuditContext();
        if (ctx && session?.source) {
          ctx.source = session.source;
        }

        // Get database service
        const service = connectionManager.getService(sessionId);

        // Execute query
        const result = await service.executeQuery(query, params);

        // Convert rows to JSON string for Coze compatibility
        const httpResult: HttpQueryResult = {
          rows: JSON.stringify(result.rows),
          affectedRows: result.affectedRows,
          executionTime: result.executionTime,
          metadata: result.metadata,
        };

        return {
          success: true,
          data: httpResult,
          metadata: {
            executionTime: result.executionTime,
            timestamp: new Date().toISOString(),
            requestId: request.id,
          },
        };
      } catch (error) {
        const { statusCode, code, message } = classifyError(error, 'QUERY_FAILED');
        // 写权限拒绝的 denied 审计由 DatabaseService.executeQuery 记录点统一写（§8.2），此处不再重复
        // （避免同一次拒绝产生 connect/denied 多行；错误码映射保持 P1 不变：PERMISSION_DENIED → 403）
        reply.code(statusCode);
        return {
          success: false,
          error: {
            code,
            message,
          },
          metadata: {
            timestamp: new Date().toISOString(),
            requestId: request.id,
          },
        };
      }
    });
  });

  /**
   * POST /api/execute
   * Execute a write operation (INSERT, UPDATE, DELETE, etc.)
   */
  fastify.post<{
    Body: ExecuteRequest;
    Reply: ApiResponse<QueryResult>;
  }>('/api/execute', {
    schema: {
      body: {
        type: 'object',
        required: ['sessionId', 'query'],
        properties: {
          sessionId: { type: 'string' },
          query: { type: 'string' },
          params: { type: 'array' },
        },
      },
    },
  }, async (request, reply) => {
    return auditScope(request, async () => {
      try {
        const { sessionId, query, params } = request.body;

        // 会话 source 回绑审计上下文（query 时读取会话，§8.1）
        const session = connectionManager.getSession(sessionId);
        const ctx = getAuditContext();
        if (ctx && session?.source) {
          ctx.source = session.source;
        }

        // Get database service
        const service = connectionManager.getService(sessionId);

        // Execute query (validation happens in service)
        const result = await service.executeQuery(query, params);

        return {
          success: true,
          data: result,
          metadata: {
            executionTime: result.executionTime,
            timestamp: new Date().toISOString(),
            requestId: request.id,
          },
        };
      } catch (error) {
        const { statusCode, code, message } = classifyError(error, 'EXECUTE_FAILED');
        // 写权限拒绝的 denied 审计由 DatabaseService.executeQuery 记录点统一写（§8.2），此处不再重复
        // （避免同一次拒绝产生多行 denied；错误码映射保持 P1 不变：PERMISSION_DENIED → 403）
        reply.code(statusCode);
        return {
          success: false,
          error: {
            code,
            message,
          },
          metadata: {
            timestamp: new Date().toISOString(),
            requestId: request.id,
          },
        };
      }
    });
  });
}