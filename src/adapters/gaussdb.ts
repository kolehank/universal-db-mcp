/**
 * GaussDB / OpenGauss 数据库适配器
 * 使用 pg 驱动实现 DbAdapter 接口
 * GaussDB 和 OpenGauss 基于 PostgreSQL 开发，兼容 PostgreSQL 协议
 *
 * 性能优化：使用批量查询获取 Schema 信息，避免 N+1 查询问题
 * 连接管理：使用连接池 + TCP Keep-Alive + 断线自动重试，确保长连接稳定性
 */

import pg from 'pg';
import type {
  DbAdapter,
  QueryResult,
  SchemaInfo,
  TableInfo,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  RelationshipInfo,
} from '../types/adapter.js';
import { isWriteOperation as checkWriteOperation } from '../utils/safety.js';

const { Pool } = pg;

export class GaussDBAdapter implements DbAdapter {
  private pool: pg.Pool | null = null;
  /** 已设置过只读会话的物理连接（避免每次查询重复 SET） */
  private readonly roPrepared = new WeakSet<object>();
  private config: {
    host: string;
    port: number;
    user?: string;
    password?: string;
    database?: string;
    /** 只读配置：会话级强制只读（default_transaction_read_only=on） */
    readOnly?: boolean;
  };

  constructor(config: {
    host: string;
    port: number;
    user?: string;
    password?: string;
    database?: string;
    readOnly?: boolean;
  }) {
    this.config = config;
  }

  private isConnectionError(error: unknown): boolean {
    const msg = String((error as any)?.message || '');
    const code = String((error as any)?.code || '');
    return /Connection terminated|ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|57P01|57P03|08003|08006/.test(msg + code);
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (this.isConnectionError(error)) {
        return await fn();
      }
      throw error;
    }
  }

  /**
   * 连接到 GaussDB / OpenGauss 数据库
   */
  async connect(): Promise<void> {
    try {
      this.pool = new Pool({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        max: 3,
        idleTimeoutMillis: 60000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 30000,
      });

      // 测试连接
      await this.pool.query('SELECT 1');
    } catch (error) {
      throw new Error(
        `GaussDB 连接失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * 断开数据库连接
   */
  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  /**
   * 执行 SQL 查询
   */
  async executeQuery(query: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.pool) {
      throw new Error('数据库未连接');
    }

    const startTime = Date.now();

    try {
      const result = await this.withRetry(() => this.queryWithReadOnlyGuard(query, params));
      const executionTime = Date.now() - startTime;

      return {
        rows: result.rows,
        affectedRows: result.rowCount || 0,
        executionTime,
        metadata: {
          command: result.command,
          fields: result.fields?.map(f => ({
            name: f.name,
            dataTypeID: f.dataTypeID,
          })),
        },
      };
    } catch (error) {
      throw new Error(
        `查询执行失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * 只读配置下，每个物理连接首次使用时设置 default_transaction_read_only=on。
   * 这是数据库侧强制（即使 SQL 文本校验被绕过也无法写入），随后再执行用户查询。
   */
  private async queryWithReadOnlyGuard(query: string, params?: unknown[]): Promise<pg.QueryResult> {
    const client = await this.pool!.connect();
    try {
      if (this.config.readOnly && !this.roPrepared.has(client)) {
        await client.query('SET default_transaction_read_only = on');
        this.roPrepared.add(client);
      }
      return await client.query(query, params);
    } finally {
      client.release();
    }
  }

  /**
   * 获取数据库结构信息（批量查询优化版本）
   */
  async getSchema(): Promise<SchemaInfo> {
    if (!this.pool) {
      throw new Error('数据库未连接');
    }

    try {
      return await this.withRetry(() => this._getSchemaImpl());
    } catch (error) {
      throw new Error(
        `获取数据库结构失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * 获取数据库结构信息的内部实现
   */
  private async _getSchemaImpl(): Promise<SchemaInfo> {
      // 获取数据库版本
      const versionResult = await this.pool!.query('SELECT version()');
      const version = versionResult.rows[0]?.version || 'unknown';

      // 获取当前数据库名
      const dbResult = await this.pool!.query('SELECT current_database()');
      const databaseName = dbResult.rows[0]?.current_database || this.config.database || 'unknown';

      // 批量获取所有表的列信息
      const allColumnsResult = await this.pool!.query(`
        SELECT
          c.table_schema,
          c.table_name,
          c.column_name,
          c.data_type,
          c.is_nullable,
          c.column_default,
          c.character_maximum_length,
          c.numeric_precision,
          c.numeric_scale,
          c.ordinal_position
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON c.table_schema = t.table_schema AND c.table_name = t.table_name
        WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_schema, c.table_name, c.ordinal_position
      `);

      // 批量获取所有表的主键信息
      const allPrimaryKeysResult = await this.pool!.query(`
        SELECT
          n.nspname as schema_name,
          t.relname as table_name,
          a.attname as column_name
        FROM pg_index i
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE i.indisprimary
          AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        ORDER BY n.nspname, t.relname, a.attnum
      `);

      // 批量获取所有表的索引信息
      const allIndexesResult = await this.pool!.query(`
        SELECT
          n.nspname as schema_name,
          t.relname as table_name,
          i.relname as index_name,
          a.attname as column_name,
          ix.indisunique as is_unique
        FROM pg_class t
        JOIN pg_index ix ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relkind = 'r'
          AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND NOT ix.indisprimary
        ORDER BY n.nspname, t.relname, i.relname, a.attnum
      `);

      // 批量获取所有表的行数估算和表注释
      const allStatsResult = await this.pool!.query(`
        SELECT
          n.nspname as schema_name,
          c.relname as table_name,
          c.reltuples::bigint as estimated_rows,
          obj_description(c.oid, 'pg_class') as table_comment
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r'
          AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      `);

      // 批量获取所有外键信息
      let allForeignKeys: any[] = [];
      try {
        const allForeignKeysResult = await this.pool!.query(`
          SELECT
            n.nspname AS schema_name,
            c.conname AS constraint_name,
            t.relname AS table_name,
            a.attname AS column_name,
            rn.nspname AS ref_schema_name,
            rt.relname AS referenced_table,
            ra.attname AS referenced_column,
            CASE c.confdeltype
              WHEN 'a' THEN 'NO ACTION'
              WHEN 'r' THEN 'RESTRICT'
              WHEN 'c' THEN 'CASCADE'
              WHEN 'n' THEN 'SET NULL'
              WHEN 'd' THEN 'SET DEFAULT'
            END AS delete_rule,
            CASE c.confupdtype
              WHEN 'a' THEN 'NO ACTION'
              WHEN 'r' THEN 'RESTRICT'
              WHEN 'c' THEN 'CASCADE'
              WHEN 'n' THEN 'SET NULL'
              WHEN 'd' THEN 'SET DEFAULT'
            END AS update_rule,
            array_position(c.conkey, a.attnum) AS column_position
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_class rt ON rt.oid = c.confrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_namespace rn ON rn.oid = rt.relnamespace
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
          JOIN pg_attribute ra ON ra.attrelid = rt.oid AND ra.attnum = c.confkey[array_position(c.conkey, a.attnum)]
          WHERE c.contype = 'f'
            AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          ORDER BY n.nspname, t.relname, c.conname, array_position(c.conkey, a.attnum)
        `);
        allForeignKeys = allForeignKeysResult.rows;
      } catch (error) {
        // 外键查询失败时忽略，返回空数组
        console.error('获取外键信息失败，跳过:', error instanceof Error ? error.message : String(error));
      }

      return this.assembleSchema(
        databaseName,
        version,
        allColumnsResult.rows,
        allPrimaryKeysResult.rows,
        allIndexesResult.rows,
        allStatsResult.rows,
        allForeignKeys
      );
  }

  /**
   * 构建带 schema 前缀的表名键
   * 默认 schema (public) 的表直接用表名，保持向后兼容
   */
  private makeTableKey(schemaName: string, tableName: string): string {
    return schemaName === 'public' ? tableName : `${schemaName}.${tableName}`;
  }

  /**
   * 组装 Schema 信息
   */
  private assembleSchema(
    databaseName: string,
    version: string,
    allColumns: any[],
    allPrimaryKeys: any[],
    allIndexes: any[],
    allStats: any[],
    allForeignKeys: any[]
  ): SchemaInfo {
    // 按 schema.table 分组列信息
    const columnsByTable = new Map<string, ColumnInfo[]>();
    const schemaByTable = new Map<string, string>();

    for (const col of allColumns) {
      const schemaName = col.table_schema || 'public';
      const tableName = col.table_name;
      const tableKey = this.makeTableKey(schemaName, tableName);

      if (!columnsByTable.has(tableKey)) {
        columnsByTable.set(tableKey, []);
        schemaByTable.set(tableKey, schemaName);
      }

      let dataType = col.data_type;
      if (col.character_maximum_length) {
        dataType += `(${col.character_maximum_length})`;
      } else if (col.numeric_precision) {
        dataType += `(${col.numeric_precision}${col.numeric_scale ? `,${col.numeric_scale}` : ''})`;
      }

      columnsByTable.get(tableKey)!.push({
        name: col.column_name,
        type: dataType,
        nullable: col.is_nullable === 'YES',
        defaultValue: col.column_default || undefined,
      });
    }

    // 按 schema.table 分组主键信息
    const primaryKeysByTable = new Map<string, string[]>();
    for (const pk of allPrimaryKeys) {
      const tableKey = this.makeTableKey(pk.schema_name || 'public', pk.table_name);
      if (!primaryKeysByTable.has(tableKey)) {
        primaryKeysByTable.set(tableKey, []);
      }
      primaryKeysByTable.get(tableKey)!.push(pk.column_name);
    }

    // 按 schema.table 分组索引信息
    const indexesByTable = new Map<string, Map<string, { columns: string[]; unique: boolean }>>();

    for (const idx of allIndexes) {
      const tableKey = this.makeTableKey(idx.schema_name || 'public', idx.table_name);
      const indexName = idx.index_name;

      if (!indexesByTable.has(tableKey)) {
        indexesByTable.set(tableKey, new Map());
      }

      const tableIndexes = indexesByTable.get(tableKey)!;

      if (!tableIndexes.has(indexName)) {
        tableIndexes.set(indexName, {
          columns: [],
          unique: idx.is_unique,
        });
      }

      tableIndexes.get(indexName)!.columns.push(idx.column_name);
    }

    // 按 schema.table 分组行数统计
    const rowsByTable = new Map<string, number>();
    const commentsByTable = new Map<string, string>();
    for (const stat of allStats) {
      const tableKey = this.makeTableKey(stat.schema_name || 'public', stat.table_name);
      rowsByTable.set(tableKey, Number(stat.estimated_rows) || 0);
      if (stat.table_comment) {
        commentsByTable.set(tableKey, stat.table_comment);
      }
    }

    // 按 schema.table 分组外键信息
    const foreignKeysByTable = new Map<string, Map<string, { columns: string[]; referencedTable: string; referencedColumns: string[]; onDelete?: string; onUpdate?: string }>>();
    const relationships: RelationshipInfo[] = [];

    for (const fk of allForeignKeys) {
      const tableKey = this.makeTableKey(fk.schema_name || 'public', fk.table_name);
      const constraintName = fk.constraint_name;
      const refTableKey = this.makeTableKey(fk.ref_schema_name || 'public', fk.referenced_table);

      if (!tableKey || !constraintName) continue;

      if (!foreignKeysByTable.has(tableKey)) {
        foreignKeysByTable.set(tableKey, new Map());
      }

      const tableForeignKeys = foreignKeysByTable.get(tableKey)!;

      if (!tableForeignKeys.has(constraintName)) {
        tableForeignKeys.set(constraintName, {
          columns: [],
          referencedTable: refTableKey,
          referencedColumns: [],
          onDelete: fk.delete_rule,
          onUpdate: fk.update_rule,
        });
      }

      const fkInfo = tableForeignKeys.get(constraintName)!;
      fkInfo.columns.push(fk.column_name);
      fkInfo.referencedColumns.push(fk.referenced_column);
    }

    // 生成全局关系视图
    for (const [tableKey, tableForeignKeys] of foreignKeysByTable.entries()) {
      for (const [constraintName, fkInfo] of tableForeignKeys.entries()) {
        relationships.push({
          fromTable: tableKey,
          fromColumns: fkInfo.columns,
          toTable: fkInfo.referencedTable,
          toColumns: fkInfo.referencedColumns,
          type: 'many-to-one',
          constraintName,
        });
      }
    }

    const tableInfos: TableInfo[] = [];

    for (const [tableKey, columns] of columnsByTable.entries()) {
      const tableIndexes = indexesByTable.get(tableKey);
      const indexInfos: IndexInfo[] = [];

      if (tableIndexes) {
        for (const [indexName, indexData] of tableIndexes.entries()) {
          indexInfos.push({
            name: indexName,
            columns: indexData.columns,
            unique: indexData.unique,
          });
        }
      }

      // 组装外键信息
      const tableForeignKeys = foreignKeysByTable.get(tableKey);
      const foreignKeyInfos: ForeignKeyInfo[] = [];

      if (tableForeignKeys) {
        for (const [constraintName, fkData] of tableForeignKeys.entries()) {
          foreignKeyInfos.push({
            name: constraintName,
            columns: fkData.columns,
            referencedTable: fkData.referencedTable,
            referencedColumns: fkData.referencedColumns,
            onDelete: fkData.onDelete,
            onUpdate: fkData.onUpdate,
          });
        }
      }

      tableInfos.push({
        name: tableKey,
        schema: schemaByTable.get(tableKey),
        comment: commentsByTable.get(tableKey) || undefined,
        columns,
        primaryKeys: primaryKeysByTable.get(tableKey) || [],
        indexes: indexInfos,
        foreignKeys: foreignKeyInfos.length > 0 ? foreignKeyInfos : undefined,
        estimatedRows: rowsByTable.get(tableKey) || 0,
      });
    }

    tableInfos.sort((a, b) => a.name.localeCompare(b.name));

    return {
      databaseType: 'gaussdb',
      databaseName,
      tables: tableInfos,
      version,
      relationships: relationships.length > 0 ? relationships : undefined,
    };
  }

  /**
   * 检查是否为写操作
   */
  isWriteOperation(query: string): boolean {
    return checkWriteOperation(query);
  }
}
