/**
 * Health and Info Routes
 * System health check and service information endpoints
 */

import type { FastifyInstance } from 'fastify';
import type { HealthResponse, InfoResponse, ApiResponse } from '../../types/http.js';
import { readPackageVersion } from '../../utils/package-version.js';

export async function setupHealthRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/health
   * Health check endpoint
   */
  fastify.get<{ Reply: ApiResponse<HealthResponse> }>('/api/health', async (request) => {
    return {
      success: true,
      data: {
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      },
      metadata: {
        timestamp: new Date().toISOString(),
        requestId: request.id,
      },
    };
  });

  /**
   * GET /api/info
   * Service information endpoint
   */
  fastify.get<{ Reply: ApiResponse<InfoResponse> }>('/api/info', async (request) => {
    return {
      success: true,
      data: {
        name: 'universal-db-mcp',
        version: readPackageVersion(),
        mode: 'http',
        supportedDatabases: [
          'mysql',
          'postgres',
          'redis',
          'oracle',
          'dm',
          'sqlserver',
          'mongodb',
          'sqlite',
          'kingbase',
          'gaussdb',
          'oceanbase',
          'tidb',
          'clickhouse',
          'polardb',
          'vastbase',
          'highgo',
          'goldendb',
        ],
      },
      metadata: {
        timestamp: new Date().toISOString(),
        requestId: request.id,
      },
    };
  });
}
