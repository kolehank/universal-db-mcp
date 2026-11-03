/**
 * Schema Routes
 * Database schema and table information endpoints
 *
 * P1（评审裁决 §4-6/10）：7 处 catch 按 error.code 映射 —— PERMISSION_DENIED → 403 + 审计 denied，
 * 其余保持既有 500 语义（各 fallback 换码不变）。
 */

import type { FastifyInstance } from 'fastify';
import type { TablesResponse, ApiResponse } from '../../types/http.js';
import type { SchemaInfo, TableInfo, EnumValuesResult, SampleDataResult } from '../../types/adapter.js';
import { ConnectionManager } from '../../core/connection-manager.js';
import type { SchemaCacheStats } from '../../core/database-service.js';
import { auditScope } from '../middleware/index.js';
import type { RouteRuntime } from './runtime.js';
import { getAuditContext } from '../../security/audit-context.js';
import { auditDenied } from '../audit.js';
import { classifyError } from '../../security/errors.js';

/**
 * Schema 响应（包含缓存信息）
 */
interface SchemaWithCacheInfo extends SchemaInfo {
  _cacheInfo?: {
    cached: boolean;
    cachedAt?: string;
    hitRate: string;
  };
}

/**
 * 缓存状态响应
 */
interface CacheStatusResponse {
  sessionId: string;
  cache: SchemaCacheStats;
  hitRate: string;
}

export async function setupSchemaRoutes(
  fastify: FastifyInstance,
  connectionManager: ConnectionManager,
  runtime: RouteRuntime = {}
): Promise<void> {
  /**
   * GET /api/tables
   * List all tables in the database
   */
  fastify.get<{
    Querystring: { sessionId: string; forceRefresh?: string };
    Reply: ApiResponse<TablesResponse>;
  }>('/api/tables', {
    schema: {
      querystring: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string' },
          forceRefresh: { type: 'string', description: '是否强制刷新缓存 (true/false)' },
        },
      },
    },
  }, async (request, reply) => {
    return auditScope<ApiResponse<TablesResponse>>(request, async () => {
      try {
        const { sessionId, forceRefresh } = request.query;
        const shouldRefresh = forceRefresh === 'true';

        rebindSessionSource(connectionManager, sessionId);

        // Get database service
        const service = connectionManager.getService(sessionId);

        // List tables
        const tables = await service.listTables(shouldRefresh);

        return {
          success: true,
          data: { tables },
          metadata: {
            timestamp: new Date().toISOString(),
            requestId: request.id,
          },
        };
      } catch (error) {
        return sendSchemaError(reply, error, runtime, 'LIST_TABLES_FAILED', 'Failed to list tables', request.id);
      }
    });
  });

  /**
   * GET /api/schema
   * Get complete database schema
   */
  fastify.get<{
    Querystring: { sessionId: string; forceRefresh?: string };
    Reply: ApiResponse<SchemaWithCacheInfo>;
  }>('/api/schema', {
    schema: {
      querystring: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string' },
          forceRefresh: { type: 'string', description: '是否强制刷新缓存 (true/false)' },
        },
      },
    },
  }, async (request, reply) => {
    return auditScope<ApiResponse<SchemaWithCacheInfo>>(request, async () => {
      try {
        const { sessionId, forceRefresh } = request.query;
        const shouldRefresh = forceRefresh === 'true';

        rebindSessionSource(connectionManager, sessionId);

        // Get database service
        const service = connectionManager.getService(sessionId);

        // Get schema
        const schema = await service.getSchema(shouldRefresh);

        // Add cache info
        const cacheStats = service.getCacheStats();
        const response: SchemaWithCacheInfo = {
          ...schema,
          _cacheInfo: {
            cached: cacheStats.isCached,
            cachedAt: cacheStats.cachedAt?.toISOString(),
            hitRate: service.getCacheHitRate() + '%',
          },
        };

        return {
          success: true,
          data: response,
          metadata: {
            timestamp: new Date().toISOString(),
            requestId: request.id,
          },
        };
      } catch (error) {
        return sendSchemaError(reply, error, runtime, 'GET_SCHEMA_FAILED', 'Failed to get schema', request.id);
      }
    });
  });

  /**
   * GET /api/schema/:table
   * Get information about a specific table
   */
  fastify.get<{
    Params: { table: string };
    Querystring: { sessionId: string; forceRefresh?: string };
    Reply: ApiResponse<TableInfo>;
  }>('/api/schema/:table', {
    schema: {
      params: {
        type: 'object',
        properties: {
          table: { type: 'string' },
        },
      },
      querystring: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string' },
          forceRefresh: { type: 'string', description: '是否强制刷新缓存 (true/false)' },
        },
      },
    },
  }, async (request, reply) => {
    return auditScope<ApiResponse<TableInfo>>(request, async () => {
      try {
        const { table } = request.params;
        const { sessionId, forceRefresh } = request.query;
        const shouldRefresh = forceRefresh === 'true';

        rebindSessionSource(connectionManager, sessionId);

        // Get database service
        const service = connectionManager.getService(sessionId);

        // Get table info
        const tableInfo = await service.getTableInfo(table, shouldRefresh);

        return {
          success: true,
          data: tableInfo,
          metadata: {
            timestamp: new Date().toISOString(),
            requestId: request.id,
          },
        };
      } catch (error) {
        return sendSchemaError(reply, error, runtime, 'GET_TABLE_INFO_FAILED', 'Failed to get table information', request.id);
      }
    });
  });

  /**
   * DELETE /api/cache
   * Clear schema cache for a session
   */
  fastify.delete<{
    Querystring: { sessionId: string };
    Reply: ApiResponse<{ cleared: boolean; message: string }>;
  }>('/api/cache', {
    schema: {
      querystring: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    return auditScope<ApiResponse<{ cleared: boolean; message: string }>>(request, async () => {
      try {
        const { sessionId } = request.query;

        rebindSessionSource(connectionManager, sessionId);

        // Get database service and clear cache
        const service = connectionManager.getService(sessionId);
        service.clearSchemaCache();

        return {
          success: true,
          data: {
            cleared: true,
            message: 'Schema 缓存已清除',
          },
          metadata: {
            timestamp: new Date().toISOString(),
            requestId: request.id,
          },
        };
      } catch (error) {
        return sendSchemaError(reply, error, runtime, 'CLEAR_CACHE_FAILED', 'Failed to clear cache', request.id);
      }
    });
  });

  /**
   * GET /api/cache/status
   * Get cache status for a session
   */
  fastify.get<{
    Querystring: { sessionId: string };
    Reply: ApiResponse<CacheStatusResponse>;
  }>('/api/cache/status', {
    schema: {
      querystring: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    return auditScope<ApiResponse<CacheStatusResponse>>(request, async () => {
      try {
        const { sessionId } = request.query;

        rebindSessionSource(connectionManager, sessionId);

        // Get database service
        const service = connectionManager.getService(sessionId);
        const cacheStats = service.getCacheStats();

        return {
          success: true,
          data: {
            sessionId,
            cache: cacheStats,
            hitRate: service.getCacheHitRate() + '%',
          },
          metadata: {
            timestamp: new Date().toISOString(),
            requestId: request.id,
          },
        };
      } catch (error) {
        return sendSchemaError(reply, error, runtime, 'GET_CACHE_STATUS_FAILED', 'Failed to get cache status', request.id);
      }
    });
  });

  /**
   * GET /api/enum-values
   * Get all unique values for a column (for enum-type columns)
   */
  fastify.get<{
    Querystring: {
      sessionId: string;
      tableName: string;
      columnName: string;
      limit?: string;
      includeCount?: string;
    };
    Reply: ApiResponse<EnumValuesResult>;
  }>('/api/enum-values', {
    schema: {
      querystring: {
        type: 'object',
        required: ['sessionId', 'tableName', 'columnName'],
        properties: {
          sessionId: { type: 'string' },
          tableName: { type: 'string', description: '表名。支持 schema.table_name 格式指定 Schema（如 analytics.users）。' },
          columnName: { type: 'string', description: '列名' },
          limit: { type: 'string', description: '最大返回数量（默认 50，最大 100）' },
          includeCount: { type: 'string', description: '是否包含每个值的出现次数 (true/false)' },
        },
      },
    },
  }, async (request, reply) => {
    return auditScope<ApiResponse<EnumValuesResult>>(request, async () => {
      try {
        const { sessionId, tableName, columnName, limit, includeCount } = request.query;
        const limitNum = limit ? parseInt(limit, 10) : undefined;
        const shouldIncludeCount = includeCount === 'true';

        rebindSessionSource(connectionManager, sessionId);

        // Get database service
        const service = connectionManager.getService(sessionId);

        // Get enum values
        const result = await service.getEnumValues(
          tableName,
          columnName,
          limitNum,
          shouldIncludeCount
        );

        return {
          success: true,
          data: result,
          metadata: {
            timestamp: new Date().toISOString(),
            requestId: request.id,
          },
        };
      } catch (error) {
        return sendSchemaError(reply, error, runtime, 'GET_ENUM_VALUES_FAILED', 'Failed to get enum values', request.id);
      }
    });
  });

  /**
   * GET /api/sample-data
   * Get sample data from a table (with automatic data masking)
   */
  fastify.get<{
    Querystring: {
      sessionId: string;
      tableName: string;
      columns?: string;
      limit?: string;
    };
    Reply: ApiResponse<SampleDataResult>;
  }>('/api/sample-data', {
    schema: {
      querystring: {
        type: 'object',
        required: ['sessionId', 'tableName'],
        properties: {
          sessionId: { type: 'string' },
          tableName: { type: 'string', description: '表名。支持 schema.table_name 格式指定 Schema（如 analytics.users）。' },
          columns: { type: 'string', description: '要查看的列（逗号分隔，可选）' },
          limit: { type: 'string', description: '返回行数（默认 3，最大 10）' },
        },
      },
    },
  }, async (request, reply) => {
    return auditScope<ApiResponse<SampleDataResult>>(request, async () => {
      try {
        const { sessionId, tableName, columns, limit } = request.query;
        const limitNum = limit ? parseInt(limit, 10) : undefined;
        const columnList = columns ? columns.split(',').map(c => c.trim()) : undefined;

        rebindSessionSource(connectionManager, sessionId);

        // Get database service
        const service = connectionManager.getService(sessionId);

        // Get sample data
        const result = await service.getSampleData(
          tableName,
          columnList,
          limitNum
        );

        return {
          success: true,
          data: result,
          metadata: {
            timestamp: new Date().toISOString(),
            requestId: request.id,
          },
        };
      } catch (error) {
        return sendSchemaError(reply, error, runtime, 'GET_SAMPLE_DATA_FAILED', 'Failed to get sample data', request.id);
      }
    });
  });
}

/** 会话 source 回绑审计上下文（§8.1「切源后不得沿用旧值」） */
function rebindSessionSource(connectionManager: ConnectionManager, sessionId: string): void {
  const session = connectionManager.getSession(sessionId);
  const ctx = getAuditContext();
  if (ctx && session?.source) {
    ctx.source = session.source;
  }
}

/** 统一错误响应：PERMISSION_DENIED → 403 + 审计；其余回落到各 fallback 码（500） */
function sendSchemaError<T>(
  reply: any,
  error: unknown,
  runtime: RouteRuntime,
  fallbackCode: string,
  fallbackMessage: string,
  requestId: string
): ApiResponse<T> {
  const { statusCode, code, message } = classifyError(error, fallbackCode);
  if (code === 'PERMISSION_DENIED') {
    auditDenied(runtime.auditLogger, code);
  }
  reply.code(statusCode);
  return {
    success: false,
    error: {
      code,
      message: code === fallbackCode ? (error instanceof Error ? error.message : fallbackMessage) : message,
    },
    metadata: {
      timestamp: new Date().toISOString(),
      requestId,
    },
  };
}