/**
 * DatabaseService 审计记录点单元测试（P4b，规格 §8.2）
 *
 * 覆盖：
 * - executeQuery：成功记 event=query（全部 §8.2 字段）；validateQuery 拒绝记 event=denied（errorCode 必填）；
 *   适配器异常记 event=query status=error。
 * - getEnumValues/getSampleData：内部查询记 event=query。
 * - getSchema/getTableInfo：记 event=metadata（耗时 + status）。
 * - 无审计上下文（getAuditContext()=undefined）→ 跳过不写。
 * - SQL 超过 2048 字符截断（sqlTruncated=true）。
 * - 审计写失败绝不阻断查询（logger 抛错 → 查询照常返回）。
 *
 * 离线可跑：mock 适配器 + os.tmpdir 临时审计文件，无真实数据库。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../src/core/database-service.js';
import { AuditLogger } from '../../src/security/audit-logger.js';
import { runWithAuditContext } from '../../src/security/audit-context.js';
import type { AuditContext } from '../../src/security/audit-context.js';
import { AclError } from '../../src/security/errors.js';
import type { DbAdapter, DbConfig, QueryResult, SchemaInfo } from '../../src/types/adapter.js';

/** 测试用审计上下文（§8.1 字段；测试直接构造，模拟接线方注入） */
const CTX: AuditContext = {
  requestId: 'req-u1',
  transport: 'rest',
  principal: 'k-unit',
  keyFingerprint: 'abcd1234ef56',
  source: 'ok-ro',
  clientIp: '10.0.0.9',
};

interface AuditLine {
  event: string;
  status?: string;
  errorCode?: string | null;
  sql?: string;
  sqlBytes?: number;
  sqlTruncated?: boolean;
  rows?: number;
  durationMs?: number;
  source?: string;
  principal?: string;
  [key: string]: unknown;
}

class MockAdapter implements DbAdapter {
  private readonly failQuery: boolean;

  constructor(opts: { failQuery?: boolean } = {}) {
    this.failQuery = opts.failQuery === true;
  }

  async connect(): Promise<void> {
    /* no-op */
  }

  async disconnect(): Promise<void> {
    /* no-op */
  }

  async executeQuery(_query: string, _params?: unknown[]): Promise<QueryResult> {
    if (this.failQuery) {
      throw new Error('mock query failure');
    }
    return { rows: [{ value: 'x' }, { value: 'y' }], affectedRows: 0, executionTime: 1 };
  }

  async getSchema(): Promise<SchemaInfo> {
    return {
      databaseType: 'mysql',
      databaseName: 'mock',
      tables: [
        {
          name: 'users',
          schema: 'public',
          columns: [
            { name: 'id', type: 'int', nullable: false },
            { name: 'status', type: 'varchar', nullable: true },
          ],
          primaryKeys: ['id'],
        },
      ],
    };
  }

  isWriteOperation(query: string): boolean {
    return /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|RENAME)\b/i.test(query);
  }
}

const SAFE_CONFIG: DbConfig = { type: 'mysql', permissionMode: 'safe' };

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'db-audit-test-'));
  tmpDirs.push(dir);
  return dir;
}

interface Harness {
  auditPath: string;
  service: DatabaseService;
}

/** 构造带审计 logger 的 DatabaseService + mock adapter */
function makeService(adapterOpts: { failQuery?: boolean } = {}): Harness {
  const auditPath = join(makeTmpDir(), 'audit.ndjson');
  const logger = new AuditLogger({ auditLogPath: auditPath });
  const service = new DatabaseService(
    new MockAdapter(adapterOpts),
    SAFE_CONFIG,
    undefined,
    undefined,
    logger
  );
  return { auditPath, service };
}

function readAudit(auditPath: string): AuditLine[] {
  const content = readFileSync(auditPath, 'utf8');
  return content
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditLine);
}

describe('DatabaseService 审计记录点（§8.2）', () => {
  it('executeQuery 成功 → event=query，含 §8.2 全部字段', async () => {
    const { auditPath, service } = makeService();
    await runWithAuditContext(CTX, async () => {
      const result = await service.executeQuery('SELECT * FROM users');
      expect(result.rows).toHaveLength(2);
    });

    const lines = readAudit(auditPath);
    expect(lines).toHaveLength(1);
    const rec = lines[0];
    expect(rec.event).toBe('query');
    expect(rec.status).toBe('ok');
    expect(rec.errorCode).toBe(null);
    expect(rec.sql).toBe('SELECT * FROM users');
    expect(rec.sqlBytes).toBe(Buffer.byteLength('SELECT * FROM users', 'utf8'));
    expect(rec.sqlTruncated).toBe(false);
    expect(rec.rows).toBe(2);
    expect(typeof rec.durationMs).toBe('number');
    expect(rec.durationMs).toBeGreaterThanOrEqual(0);
    // 上下文字段透传
    expect(rec.requestId).toBe('req-u1');
    expect(rec.transport).toBe('rest');
    expect(rec.principal).toBe('k-unit');
    expect(rec.keyFingerprint).toBe('abcd1234ef56');
    expect(rec.source).toBe('ok-ro');
    expect(rec.clientIp).toBe('10.0.0.9');
  });

  it('validateQuery 拒绝（safe 上 DELETE）→ event=denied + errorCode=PERMISSION_DENIED，且抛出 AclError', async () => {
    const { auditPath, service } = makeService();
    await runWithAuditContext(CTX, async () => {
      await expect(service.executeQuery('DELETE FROM users')).rejects.toBeInstanceOf(AclError);
    });

    const lines = readAudit(auditPath);
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('denied');
    expect(lines[0].status).toBe('denied');
    expect(lines[0].errorCode).toBe('PERMISSION_DENIED');
    expect(lines[0].source).toBe('ok-ro');
    // §8.2：denied 的 sql 可空（保持与 auditDenied 一致，不记录待执行 SQL）
    expect('sql' in lines[0]).toBe(false);
  });

  it('适配器异常 → event=query status=error + errorCode 省略，且原样抛出', async () => {
    const { auditPath, service } = makeService({ failQuery: true });
    await runWithAuditContext(CTX, async () => {
      await expect(service.executeQuery('SELECT 1')).rejects.toThrow('mock query failure');
    });

    const lines = readAudit(auditPath);
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('query');
    expect(lines[0].status).toBe('error');
    expect('errorCode' in lines[0]).toBe(false);
    expect(lines[0].sql).toBe('SELECT 1');
  });

  it('SQL 超过 2048 字符 → 截断 + sqlTruncated=true + 字节数=2048', async () => {
    const { auditPath, service } = makeService();
    const longSql = 'SELECT ' + 'a'.repeat(2090);
    await runWithAuditContext(CTX, async () => {
      await service.executeQuery(longSql);
    });

    const lines = readAudit(auditPath);
    expect(lines[0].sql).toHaveLength(2048);
    expect(lines[0].sqlTruncated).toBe(true);
    expect(lines[0].sqlBytes).toBe(2048);
  });

  it('getEnumValues 内部查询 → event=query（前置 getTableInfo 的 metadata 另行记录）', async () => {
    const { auditPath, service } = makeService();
    await runWithAuditContext(CTX, async () => {
      const r = await service.getEnumValues('users', 'status');
      expect(r.values).toEqual(['x', 'y']);
    });

    const lines = readAudit(auditPath);
    const queries = lines.filter((l) => l.event === 'query');
    expect(queries).toHaveLength(1);
    expect(queries[0].status).toBe('ok');
    expect(queries[0].sql).toContain('SELECT DISTINCT');
    expect(queries[0].rows).toBe(2);
    // getTableInfo 内部 getSchema 的 metadata 行
    expect(lines.filter((l) => l.event === 'metadata').length).toBeGreaterThanOrEqual(1);
  });

  it('getSampleData 内部查询 → event=query', async () => {
    const { auditPath, service } = makeService();
    await runWithAuditContext(CTX, async () => {
      const r = await service.getSampleData('users');
      expect(r.rowCount).toBe(2);
    });

    const lines = readAudit(auditPath);
    const queries = lines.filter((l) => l.event === 'query');
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('SELECT');
    expect(queries[0].status).toBe('ok');
  });

  it('getSchema → event=metadata（耗时 + status；不需要 sql）', async () => {
    const { auditPath, service } = makeService();
    await runWithAuditContext(CTX, async () => {
      await service.getSchema();
    });

    const lines = readAudit(auditPath);
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('metadata');
    expect(lines[0].status).toBe('ok');
    expect('sql' in lines[0]).toBe(false);
    expect(typeof lines[0].durationMs).toBe('number');
  });

  it('getTableInfo → event=metadata（含内部 getSchema 的 metadata 行）', async () => {
    const { auditPath, service } = makeService();
    await runWithAuditContext(CTX, async () => {
      const t = await service.getTableInfo('users');
      expect(t.name).toBe('users');
    });

    const lines = readAudit(auditPath);
    const metadatas = lines.filter((l) => l.event === 'metadata');
    expect(metadatas.length).toBeGreaterThanOrEqual(2); // getSchema + getTableInfo 各自一条
    expect(metadatas[metadatas.length - 1].status).toBe('ok');
  });

  it('无审计上下文（getAuditContext()=undefined）→ 跳过不写任何行', async () => {
    const { auditPath, service } = makeService();
    // 直接调用（不在 runWithAuditContext 内）
    await service.executeQuery('SELECT 1');
    await service.getSchema();
    // 未发生任何写：审计文件从未被创建
    expect(existsSync(auditPath)).toBe(false);
  });

  it('审计写失败绝不阻断查询（logger 抛错 → 查询照常返回）', async () => {
    class ThrowingWriter extends AuditLogger {
      protected override writeLine(_fd: number, _line: string): void {
        throw new Error('injected audit write failure');
      }
    }
    const auditPath = join(makeTmpDir(), 'audit.ndjson');
    const logger = new ThrowingWriter({ auditLogPath: auditPath });
    expect(logger.isEnabled).toBe(true);
    const service = new DatabaseService(new MockAdapter(), SAFE_CONFIG, undefined, undefined, logger);

    let result: QueryResult | undefined;
    await runWithAuditContext(CTX, async () => {
      result = await service.executeQuery('SELECT 1'); // 不应抛错
    });
    expect(result!.rows).toHaveLength(2);
    expect(logger.writeFailureCount).toBeGreaterThan(0);
  });

  it('未注入 auditLogger → 全部为 no-op，查询与元数据照常工作', async () => {
    const service = new DatabaseService(new MockAdapter(), SAFE_CONFIG);
    const r = await runWithAuditContext(CTX, async () => {
      const res = await service.executeQuery('SELECT 1');
      await service.getSchema();
      return res;
    });
    expect(r.rows).toHaveLength(2);
  });
});