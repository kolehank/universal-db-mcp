/**
 * Adapter Factory - Centralized database adapter creation
 * Extracts adapter creation logic for reuse across MCP and HTTP modes
 */

import type { DbAdapter, DbConfig } from '../types/adapter.js';
import { isReadOnlyConfig, resolvePermissions } from './safety.js';
import { MySQLAdapter } from '../adapters/mysql.js';
import { PostgreSQLAdapter } from '../adapters/postgres.js';
import { RedisAdapter } from '../adapters/redis.js';
import { OracleAdapter } from '../adapters/oracle.js';
import { DMAdapter } from '../adapters/dm.js';
import { SQLServerAdapter } from '../adapters/sqlserver.js';
import { MongoDBAdapter } from '../adapters/mongodb.js';
import { SQLiteAdapter } from '../adapters/sqlite.js';
import { KingbaseAdapter } from '../adapters/kingbase.js';
import { GaussDBAdapter } from '../adapters/gaussdb.js';
import { OceanBaseAdapter } from '../adapters/oceanbase.js';
import { TiDBAdapter } from '../adapters/tidb.js';
import { ClickHouseAdapter } from '../adapters/clickhouse.js';
import { PolarDBAdapter } from '../adapters/polardb.js';
import { VastbaseAdapter } from '../adapters/vastbase.js';
import { HighGoAdapter } from '../adapters/highgo.js';
import { GoldenDBAdapter } from '../adapters/goldendb.js';

/**
 * Supported database types
 */
export type DbType =
  | 'mysql'
  | 'postgres'
  | 'redis'
  | 'oracle'
  | 'dm'
  | 'sqlserver'
  | 'mongodb'
  | 'sqlite'
  | 'kingbase'
  | 'gaussdb'
  | 'oceanbase'
  | 'tidb'
  | 'clickhouse'
  | 'polardb'
  | 'vastbase'
  | 'highgo'
  | 'goldendb';

/**
 * Normalize database type aliases to canonical names
 */
export function normalizeDbType(type: string): DbType {
  const normalized = type.toLowerCase();

  // Handle aliases
  if (normalized === 'mssql') {
    return 'sqlserver';
  }
  if (normalized === 'opengauss') {
    return 'gaussdb';
  }

  // Validate type
  const validTypes: DbType[] = [
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
  ];

  if (!validTypes.includes(normalized as DbType)) {
    throw new Error(
      `不支持的数据库类型: ${type}。支持的类型: ${validTypes.join(', ')}`
    );
  }

  return normalized as DbType;
}

/**
 * Validate database configuration
 */
export function validateDbConfig(config: DbConfig): void {
  // Normalize type
  const dbType = normalizeDbType(config.type);

  // SQLite special validation
  if (dbType === 'sqlite') {
    if (!config.filePath) {
      throw new Error('SQLite 数据库需要指定 filePath 参数');
    }
    return;
  }

  // Other databases need host and port
  if (!config.host || !config.port) {
    throw new Error(`${dbType} 数据库需要指定 host 和 port 参数`);
  }
}

/**
 * Create database adapter based on configuration
 */
export function createAdapter(config: DbConfig): DbAdapter {
  // Validate configuration
  validateDbConfig(config);

  // Normalize type
  const dbType = normalizeDbType(config.type);

  // 只读配置 → 适配器建立会话级只读（数据库侧强制，不依赖 SQL 文本校验）
  const readOnly = isReadOnlyConfig(config);

  // Create adapter based on type
  switch (dbType) {
    case 'mysql':
      return new MySQLAdapter({
        host: config.host!,
        port: config.port!,
        user: config.user,
        password: config.password,
        database: config.database,
        readOnly,
      });

    case 'postgres':
      return new PostgreSQLAdapter({
        host: config.host!,
        port: config.port!,
        user: config.user,
        password: config.password,
        database: config.database,
        readOnly,
      });

    case 'redis':
      return new RedisAdapter({
        host: config.host!,
        port: config.port!,
        password: config.password,
        database: config.database,
        readOnly,
      });

    case 'oracle':
      return new OracleAdapter({
        host: config.host!,
        port: config.port!,
        user: config.user,
        password: config.password,
        database: config.database,
        oracleClientPath: config.oracleClientPath,
        readOnly,
      });

    case 'dm':
      return new DMAdapter({
        host: config.host!,
        port: config.port!,
        user: config.user,
        password: config.password,
        database: config.database,
        readOnly,
      });

    case 'sqlserver':
      return new SQLServerAdapter({
        host: config.host!,
        port: config.port!,
        user: config.user,
        password: config.password,
        database: config.database,
        readOnly,
      });

    case 'mongodb':
      return new MongoDBAdapter({
        host: config.host!,
        port: config.port!,
        user: config.user,
        password: config.password,
        database: config.database,
        authSource: (config as any).authSource,
        // MongoDB 没有会话级只读，改为按操作类型在适配器内强制权限（P0-3）
        permissions: resolvePermissions(config),
      });

    case 'sqlite':
      return new SQLiteAdapter({
        filePath: config.filePath!,
        // 只读配置用文件级只读打开；readwrite/full 才允许写
        readonly: readOnly,
      });

    case 'kingbase':
      return new KingbaseAdapter({
        host: config.host!,
        port: config.port!,
        user: config.user,
        password: config.password,
        database: config.database,
        readOnly,
      });

    case 'gaussdb':
      return new GaussDBAdapter({
        host: config.host!,
        port: config.port!,
        user: config.user,
        password: config.password,
        database: config.database,
        readOnly,
      });

    case 'oceanbase':
      return new OceanBaseAdapter({
        host: config.host!,
        port: config.port!,
        user: config.user,
        password: config.password,
        database: config.database,
        readOnly,
      });

    case 'tidb':
      return new TiDBAdapter({
        host: config.host!,
        port: config.port!,
        user: config.user,
        password: config.password,
        database: config.database,
        readOnly,
      });

    case 'clickhouse':
      return new ClickHouseAdapter({
        host: config.host!,
        port: config.port!,
        user: config.user,
        password: config.password,
        database: config.database,
        readOnly,
      });

    case 'polardb':
      return new PolarDBAdapter({
        host: config.host!,
        port: config.port!,
        user: config.user,
        password: config.password,
        database: config.database,
        readOnly,
      });

    case 'vastbase':
      return new VastbaseAdapter({
        host: config.host!,
        port: config.port!,
        user: config.user,
        password: config.password,
        database: config.database,
        readOnly,
      });

    case 'highgo':
      return new HighGoAdapter({
        host: config.host!,
        port: config.port!,
        user: config.user,
        password: config.password,
        database: config.database,
        readOnly,
      });

    case 'goldendb':
      return new GoldenDBAdapter({
        host: config.host!,
        port: config.port!,
        user: config.user,
        password: config.password,
        database: config.database,
        readOnly,
      });

    default:
      throw new Error(`不支持的数据库类型: ${dbType}`);
  }
}
