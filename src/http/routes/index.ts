/**
 * Routes Index
 * Aggregates all route setup functions
 */

import type { FastifyInstance } from 'fastify';
import { ConnectionManager } from '../../core/connection-manager.js';
import { setupHealthRoutes } from './health.js';
import { setupConnectionRoutes } from './connection.js';
import { setupQueryRoutes } from './query.js';
import { setupSchemaRoutes } from './schema.js';
import { setupMcpSseRoutes } from './mcp-sse.js';
import type { RouteRuntime } from './runtime.js';

/**
 * Setup all routes
 */
export async function setupRoutes(
  fastify: FastifyInstance,
  connectionManager: ConnectionManager,
  runtime: RouteRuntime = {}
): Promise<void> {
  // Health and info routes (no auth required)
  await setupHealthRoutes(fastify);

  // MCP SSE routes (no auth required, uses its own session management)
  // P2：注入 runtime（registry/auditLogger/adapterFactory/securityEnv）——不注入则 MCP 路由以 legacy 空配置运行，ACL 全失效
  await setupMcpSseRoutes(fastify, runtime);

  // Connection routes
  await setupConnectionRoutes(fastify, connectionManager, runtime);

  // Query routes
  await setupQueryRoutes(fastify, connectionManager, runtime);

  // Schema routes
  await setupSchemaRoutes(fastify, connectionManager, runtime);
}
