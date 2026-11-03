/**
 * HTTP Server Entry Point
 * Starts the HTTP API server
 */

import type { AppConfig } from '../types/http.js';
import { createHttpServer } from './server.js';
import { loadSecurityEnv } from '../utils/config-loader.js';

/**
 * fail-closed 启动判定（用例 1）：
 * 无 DATASOURCE_CONFIG 且 ALLOW_ADHOC_CONNECTIONS 不为 'true' → 拒绝启动（退出码 1）。
 * 纯函数、无副作用，便于单元测试。
 */
export function shouldFailClosedHttpStart(
  datasourceConfigPath: string | undefined,
  allowAdhocConnections: boolean | undefined
): boolean {
  return !datasourceConfigPath && allowAdhocConnections !== true;
}

/**
 * Start HTTP server
 */
export async function startHttpServer(config: AppConfig): Promise<void> {
  // fail-closed（仅 HTTP 模式生效）：无注册表且未显式开启 adhoc → 拒绝启动
  const securityEnv = loadSecurityEnv();
  if (shouldFailClosedHttpStart(securityEnv.datasourceConfig, securityEnv.allowAdhocConnections)) {
    console.error(
      '❌ Failed to start HTTP server (fail-closed): DATASOURCE_CONFIG is not set ' +
        'and ALLOW_ADHOC_CONNECTIONS is not "true". Refusing to start without a datasource registry.'
    );
    process.exit(1);
  }

  try {
    // Create server
    const server = await createHttpServer(config);

    // Get configuration
    const port = config.http?.port || 3000;
    const host = config.http?.host || '0.0.0.0';

    // Start listening
    await server.listen({ port, host });

    console.log('');
    console.log('🚀 HTTP API Server started successfully!');
    console.log('');
    console.log(`📍 Server URL: http://${host}:${port}`);
    console.log(`📊 Supported databases: 17 types`);
    console.log(`🛡️  Security: API Key authentication ${config.http?.apiKeys.length ? 'enabled' : 'disabled (WARNING!)'}`);
    console.log(`⚡ Rate limiting: ${config.http?.rateLimit.max} requests per ${config.http?.rateLimit.window}`);
    console.log('');
    console.log('📖 API Endpoints:');
    console.log('   GET  /api/health          - Health check');
    console.log('   GET  /api/info            - Service information');
    console.log('   POST /api/connect         - Connect to database');
    console.log('   POST /api/disconnect      - Disconnect from database');
    console.log('   POST /api/query           - Execute query');
    console.log('   POST /api/execute         - Execute write operation');
    console.log('   GET  /api/tables          - List tables');
    console.log('   GET  /api/schema          - Get database schema');
    console.log('   GET  /api/schema/:table   - Get table information');
    console.log('');

    // Graceful shutdown
    const signals = ['SIGINT', 'SIGTERM'];
    signals.forEach(signal => {
      process.on(signal, async () => {
        console.log(`\n⏹️  Received ${signal}, shutting down gracefully...`);
        await server.close();
        console.log('👋 Server closed');
        process.exit(0);
      });
    });

  } catch (error) {
    console.error('❌ Failed to start HTTP server:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
