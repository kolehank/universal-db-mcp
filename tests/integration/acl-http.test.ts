/**
 * 规格 §11 用例表的 HTTP 子集（P1 验收：用例 3-9、16、17）
 *
 * 离线可跑：createHttpServer(config, { registry, adapterFactory, auditLogger, securityEnv }) + server.inject()，
 * 全部使用 mock 适配器，不起真实数据库。
 *
 * 前置（fixtures/registry.json）：
 *   源 ok-ro（maxPermission=safe）、ok-rw（maxPermission=readwrite）；
 *   key k-full（key=test-key-full，允许 ok-ro/ok-rw，maxPermission=full）、
 *   key k-ro（key=test-key-ro，仅允许 ok-ro，无 maxPermission → full）。
 *
 * 审计断言：用户 AuditLogger（同步 writeSync 追加写）指向 os.tmpdir() 临时文件；
 * server.inject() 完整 await 请求（含审计写），返回后再读 NDJSON 行，无需轮询。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../../src/http/server';
import { buildRegistryFromRaw } from '../../src/security/datasource-registry';
import { AuditLogger } from '../../src/security/audit-logger';
import type { DbAdapter, DbConfig, QueryResult, SchemaInfo } from '../../src/types/adapter';
import type { AppConfig } from '../../src/types/http';

const FIXTURES = join(__dirname, '..', 'fixtures');

/** 认证失败会走到 stderr 的 logger 级别压到 error，避免测试输出噪音 */
function baseConfig(): AppConfig {
  return {
    mode: 'http',
    http: {
      port: 0,
      host: '127.0.0.1',
      apiKeys: [],
      cors: { origins: '*', credentials: false },
      rateLimit: { max: 1000, window: '1m' },
      logging: { level: 'error', pretty: false },
      session: { timeout: 3600000, cleanupInterval: 300000 },
    },
  };
}

/** 可配置失败行为的 mock 适配器（DbAdapter 接口） */
class MockAdapter implements DbAdapter {
  private opts: { failConnect?: boolean };

  constructor(opts: { failConnect?: boolean } = {}) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.opts.failConnect) {
      throw new Error('mock connection refused');
    }
  }

  async disconnect(): Promise<void> {
    /* no-op */
  }

  async executeQuery(query: string, params?: unknown[]): Promise<QueryResult> {
    return { rows: [], affectedRows: 0, executionTime: 1, metadata: { query } };
  }

  async getSchema(): Promise<SchemaInfo> {
    return { databaseType: 'mysql', databaseName: 'mock', tables: [] };
  }

  isWriteOperation(query: string): boolean {
    return /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|RENAME)\b/i.test(query);
  }
}

/** 默认成功工厂：注入 MockAdapter（connect 成功） */
function okAdapterFactory(): (config: DbConfig) => DbAdapter {
  return () => new MockAdapter();
}

/** 连接必失败的工厂（用例 17：放行后连接失败 → 502） */
function failConnectAdapterFactory(): (config: DbConfig) => DbAdapter {
  return () => new MockAdapter({ failConnect: true });
}

function defaultRegistryRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, 'registry.json'), 'utf-8')) as Record<string, unknown>;
}

/** 基于 fixture 构造变体注册表 */
function variantRegistryRaw(mutate: (raw: Record<string, unknown>) => void): Record<string, unknown> {
  const raw = defaultRegistryRaw();
  mutate(raw);
  return raw;
}

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acl-http-'));
  tmpDirs.push(dir);
  return dir;
}

interface Harness {
  server: any;
  auditPath: string;
}

async function makeServer(
  registryRaw: unknown,
  adapterFactory: (config: DbConfig) => DbAdapter,
  securityEnv: Record<string, unknown> = {}
): Promise<Harness> {
  const dir = makeTmpDir();
  const auditPath = join(dir, 'audit.ndjson');
  const registry = buildRegistryFromRaw(registryRaw, 'acl-http-test');
  const auditLogger = new AuditLogger({ auditLogPath: auditPath, trustAuditUserHeader: securityEnv.trustAuditUserHeader === true });
  const server = await createHttpServer(baseConfig(), {
    registry,
    adapterFactory,
    auditLogger,
    securityEnv,
  });
  return { server, auditPath };
}

interface AuditLine {
  event: string;
  errorCode?: string | null;
  principal?: string;
  source?: string;
  [key: string]: unknown;
}

function readAudit(auditPath: string): AuditLine[] {
  try {
    const content = readFileSync(auditPath, 'utf-8');
    return content
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as AuditLine);
  } catch {
    return [];
  }
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function connectPayload(body: Record<string, unknown>): Record<string, unknown> {
  return { method: 'POST', url: '/api/connect', headers: { 'X-API-Key': 'test-key-full' }, payload: body };
}

function queryPayload(sessionId: string, query: string, url = '/api/query'): Record<string, unknown> {
  return {
    method: 'POST',
    url,
    headers: { 'X-API-Key': 'test-key-full' },
    payload: { sessionId, query },
  };
}

describe('P1 REST ACL（用例 3-9、16、17）', () => {
  it('用例 3：无 source + adhoc 字段 → 403 ADHOC_DISABLED + 审计 denied', async () => {
    const { server, auditPath } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const res = await server.inject(connectPayload({ type: 'mysql', host: '10.0.0.1', port: 3306 }));
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('ADHOC_DISABLED');

      const lines = readAudit(auditPath);
      expect(lines).toHaveLength(1);
      expect(lines[0].event).toBe('denied');
      expect(lines[0].errorCode).toBe('ADHOC_DISABLED');
      expect(lines[0].principal).toBe('k-full');
    } finally {
      await server.close();
    }
  });

  it('用例 4：带合法 source（ok-ro，key k-ro）→ 200 + sessionId + connect 审计', async () => {
    const { server, auditPath } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const res = await server.inject({
        method: 'POST',
        url: '/api/connect',
        headers: { 'X-API-Key': 'test-key-ro' },
        payload: { source: 'ok-ro' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(typeof body.data.sessionId).toBe('string');
      expect(body.data.databaseType).toBe('mysql');

      const lines = readAudit(auditPath);
      expect(lines).toHaveLength(1);
      expect(lines[0].event).toBe('connect');
      expect(lines[0].principal).toBe('k-ro');
      expect(lines[0].source).toBe('ok-ro');
      expect(lines[0].transport).toBe('rest');
    } finally {
      await server.close();
    }
  });

  it('用例 5：key 无权访问的源（ok-rw, key k-ro）→ 404 SOURCE_NOT_FOUND（非 403）+ 审计 denied', async () => {
    const { server, auditPath } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const res = await server.inject({
        method: 'POST',
        url: '/api/connect',
        headers: { 'X-API-Key': 'test-key-ro' },
        payload: { source: 'ok-rw' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('SOURCE_NOT_FOUND');

      const lines = readAudit(auditPath);
      expect(lines).toHaveLength(1);
      expect(lines[0].event).toBe('denied');
      expect(lines[0].errorCode).toBe('SOURCE_NOT_FOUND');
      expect(lines[0].source).toBe('ok-rw');
    } finally {
      await server.close();
    }
  });

  it('用例 6：未知 source → 404 SOURCE_NOT_FOUND', async () => {
    const { server } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const res = await server.inject(connectPayload({ source: 'nope' }));
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('SOURCE_NOT_FOUND');
    } finally {
      await server.close();
    }
  });

  it('用例 7：ok-ro（safe）上 DELETE → 403 PERMISSION_DENIED + 审计 denied', async () => {
    const { server, auditPath } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const conn = await server.inject(connectPayload({ source: 'ok-ro' }));
      expect(conn.statusCode).toBe(200);
      const sessionId = (JSON.parse(conn.body) as any).data.sessionId as string;

      const res = await server.inject(queryPayload(sessionId, 'DELETE FROM t'));
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('PERMISSION_DENIED');

      const lines = readAudit(auditPath);
      const denied = lines.filter((l) => l.event === 'denied');
      expect(denied).toHaveLength(1);
      expect(denied[0].errorCode).toBe('PERMISSION_DENIED');
      expect(denied[0].source).toBe('ok-ro');
      expect(denied[0].principal).toBe('k-full');
    } finally {
      await server.close();
    }
  });

  it('用例 9：变体配置 k-full=maxPermission=safe；连 ok-rw 后 INSERT → 403 PERMISSION_DENIED（取 min）', async () => {
    const raw = variantRegistryRaw((r) => {
      const k = (r.apiKeys as Array<Record<string, unknown>>).find((x) => x.name === 'k-full');
      k!.maxPermission = 'safe';
    });
    const { server, auditPath } = await makeServer(raw, okAdapterFactory());
    try {
      const conn = await server.inject(connectPayload({ source: 'ok-rw' }));
      expect(conn.statusCode).toBe(200);
      const sessionId = (JSON.parse(conn.body) as any).data.sessionId as string;

      const res = await server.inject(queryPayload(sessionId, 'INSERT INTO t (a) VALUES (1)', '/api/execute'));
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('PERMISSION_DENIED');

      const denied = readAudit(auditPath).filter((l) => l.event === 'denied');
      expect(denied).toHaveLength(1);
      expect(denied[0].errorCode).toBe('PERMISSION_DENIED');
    } finally {
      await server.close();
    }
  });

  it('用例 8：带 password 的 source 连接 → 200；密码被忽略且不产生 permission_ignored 审计', async () => {
    const { server, auditPath } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const res = await server.inject(connectPayload({ source: 'ok-ro', password: 'x' }));
      expect(res.statusCode).toBe(200);
      expect(typeof (JSON.parse(res.body) as any).data.sessionId).toBe('string');

      const lines = readAudit(auditPath);
      expect(lines.filter((l) => l.event === 'permission_ignored')).toHaveLength(0);
      // 仅 connect 一条；建库用注册表凭据（mock 看不到 body.password）
      expect(lines).toHaveLength(1);
      expect(lines[0].event).toBe('connect');
    } finally {
      await server.close();
    }
  });

  it('用例 16：adhoc 开 + 目标不在白名单 → 403 ADHOC_TARGET_DENIED + 审计 denied', async () => {
    const raw = variantRegistryRaw((r) => {
      r.allowAdhocConnections = true;
      r.adhocTargetAllowlist = ['10.1.2.3:3306'];
    });
    const { server, auditPath } = await makeServer(raw, okAdapterFactory());
    try {
      const res = await server.inject(connectPayload({ type: 'mysql', host: '10.9.9.9', port: 3306 }));
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('ADHOC_TARGET_DENIED');

      const lines = readAudit(auditPath);
      expect(lines).toHaveLength(1);
      expect(lines[0].event).toBe('denied');
      expect(lines[0].errorCode).toBe('ADHOC_TARGET_DENIED');
    } finally {
      await server.close();
    }
  });

  it('用例 17：adhoc 开 + 目标命中白名单 → 放行；连接失败 → 502 CONNECT_FAILED（不是 403）', async () => {
    const raw = variantRegistryRaw((r) => {
      r.allowAdhocConnections = true;
      r.adhocTargetAllowlist = ['10.1.2.3:3306'];
    });
    const { server } = await makeServer(raw, failConnectAdapterFactory());
    try {
      const res = await server.inject(
        connectPayload({ type: 'mysql', host: '10.1.2.3', port: 3306, user: 'u', database: 'd' })
      );
      expect(res.statusCode).toBe(502);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('CONNECT_FAILED');
    } finally {
      await server.close();
    }
  });

  it('用例 8 补充：声明宽于生效权限的 perce 字段（permissionMode:full on safe 源）→ 审计 permission_ignored', async () => {
    const { server, auditPath } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const res = await server.inject(connectPayload({ source: 'ok-ro', permissionMode: 'full' }));
      expect(res.statusCode).toBe(200);
      const lines = readAudit(auditPath);
      const ignored = lines.filter((l) => l.event === 'permission_ignored');
      expect(ignored).toHaveLength(1);
      expect(ignored[0].source).toBe('ok-ro');
      expect(ignored[0].principal).toBe('k-full');
      // 请求本身放行：permission_ignored 之后仍有 connect 审计
      expect(lines.filter((l) => l.event === 'connect')).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('注册表路径不存在/加载失败 → createHttpServer 拒绝（fail-closed，错误含原因）', async () => {
    const missing = join(makeTmpDir(), 'no-such-registry.json');
    await expect(
      createHttpServer(baseConfig(), {
        securityEnv: { datasourceConfig: missing },
        adapterFactory: okAdapterFactory(),
      })
    ).rejects.toThrow(/无法读取数据源注册表文件/);
  });

  it('disconnect 审计：event=disconnect，用会话记录的 principal/source（P4 模块接线）', async () => {
    const { server, auditPath } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const conn = await server.inject(connectPayload({ source: 'ok-ro' }));
      const sessionId = (JSON.parse(conn.body) as any).data.sessionId as string;

      const res = await server.inject({
        method: 'POST',
        url: '/api/disconnect',
        headers: { 'X-API-Key': 'test-key-full' },
        payload: { sessionId },
      });
      expect(res.statusCode).toBe(200);

      const lines = readAudit(auditPath);
      const connect = lines.find((l) => l.event === 'connect');
      const disconnect = lines.find((l) => l.event === 'disconnect');
      expect(connect?.source).toBe('ok-ro');
      expect(disconnect).toBeDefined();
      expect(disconnect!.principal).toBe('k-full');
      expect(disconnect!.source).toBe('ok-ro');
    } finally {
      await server.close();
    }
  });

  it('用例 5 补充：未知源绝不泄露「区别信息」，响应正文不区分 key 无权/源不存在', async () => {
    const { server } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const resNo = await server.inject(connectPayload({ source: 'nope' }));
      const resDenied = await server.inject({
        method: 'POST',
        url: '/api/connect',
        headers: { 'X-API-Key': 'test-key-ro' },
        payload: { source: 'ok-rw' },
      });
      expect(resNo.statusCode).toBe(404);
      expect(resDenied.statusCode).toBe(404);
      expect(JSON.parse(resNo.body).error.code).toBe('SOURCE_NOT_FOUND');
      expect(JSON.parse(resDenied.body).error.code).toBe('SOURCE_NOT_FOUND');
    } finally {
      await server.close();
    }
  });
});

describe('P4b 用例 22：AUDIT_LOG_PATH 落盘 §8.2 完整字段，写拒绝落 denied（P4 验收）', () => {
  it('正常 config + 临时审计文件：connect ok-ro → query SELECT → 审计一行 NDJSON 含 §8.2 全部字段；DELETE 被拒 → denied 行', async () => {
    const { server, auditPath } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      // key k-ro 连允许的源 ok-ro（principal=key 名）
      const conn = await server.inject({
        method: 'POST',
        url: '/api/connect',
        headers: { 'X-API-Key': 'test-key-ro' },
        payload: { source: 'ok-ro' },
      });
      expect(conn.statusCode).toBe(200);
      const sessionId = (JSON.parse(conn.body) as any).data.sessionId as string;

      // SELECT 查询成功
      const q = await server.inject({
        method: 'POST',
        url: '/api/query',
        headers: { 'X-API-Key': 'test-key-ro' },
        payload: { sessionId, query: 'SELECT * FROM users' },
      });
      expect(q.statusCode).toBe(200);

      const lines = readAudit(auditPath);
      const queryLines = lines.filter((l) => l.event === 'query');
      expect(queryLines).toHaveLength(1);
      const rec = queryLines[0];

      // §8.2 字段固定表逐项断言（ts/event/requestId/transport/principal/keyFingerprint/source/clientIp/
      //   sql/sqlBytes/sqlTruncated/status/errorCode/rows/durationMs）
      expect(typeof rec.ts).toBe('string');
      expect(rec.event).toBe('query');
      expect(typeof rec.requestId).toBe('string');
      expect(rec.transport).toBe('rest');
      expect(rec.principal).toBe('k-ro'); // 审计主体 = apiKeys[].name
      expect(typeof rec.keyFingerprint).toBe('string');
      expect(rec.keyFingerprint).toMatch(/^[0-9a-f]{12}$/);
      expect(rec.source).toBe('ok-ro');
      expect(typeof rec.clientIp).toBe('string');
      expect(rec.sql).toBe('SELECT * FROM users');
      expect(rec.sqlBytes).toBe(Buffer.byteLength('SELECT * FROM users', 'utf8'));
      expect(rec.sqlTruncated).toBe(false);
      expect(rec.status).toBe('ok');
      expect(rec.errorCode).toBe(null);
      expect(typeof rec.rows).toBe('number');
      expect(typeof rec.durationMs).toBe('number');
      expect(rec.durationMs).toBeGreaterThanOrEqual(0);

      // 写操作被拒（ok-ro=safe，DELETE 越权）→ event=denied + errorCode=PERMISSION_DENIED
      const w = await server.inject({
        method: 'POST',
        url: '/api/query',
        headers: { 'X-API-Key': 'test-key-ro' },
        payload: { sessionId, query: 'DELETE FROM users' },
      });
      expect(w.statusCode).toBe(403);
      expect((JSON.parse(w.body) as any).error.code).toBe('PERMISSION_DENIED');

      const all = readAudit(auditPath);
      const denied = all.filter((l) => l.event === 'denied');
      expect(denied).toHaveLength(1); // 写权限拒绝只落一条 denied（DatabaseService 记录点统一写）
      expect(denied[0].errorCode).toBe('PERMISSION_DENIED');
      expect(denied[0].source).toBe('ok-ro');
      expect(denied[0].principal).toBe('k-ro');
    } finally {
      await server.close();
    }
  });
});

describe('P6 收尾：X-Audit-User 审计关联与 CORS 新头放行', () => {
  it('TRUST_AUDIT_USER_HEADER=true 时 X-Audit-User 记入审计 auditUser（仅审计关联）', async () => {
    const { server, auditPath } = await makeServer(defaultRegistryRaw(), okAdapterFactory(), {
      trustAuditUserHeader: true,
    });
    try {
      const conn = await server.inject({
        method: 'POST',
        url: '/api/connect',
        headers: { 'X-API-Key': 'test-key-ro', 'X-Audit-User': 'zhangsan' },
        payload: { source: 'ok-ro' },
      });
      expect(conn.statusCode).toBe(200);
      const lines = readAudit(auditPath);
      const connectLines = lines.filter((l) => l.event === 'connect');
      expect(connectLines.length).toBeGreaterThan(0);
      expect(connectLines[0].auditUser).toBe('zhangsan');
    } finally {
      await server.close();
    }
  });

  it('默认（false）时即使客户端带 X-Audit-User 也不写 auditUser 字段', async () => {
    const { server, auditPath } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const conn = await server.inject({
        method: 'POST',
        url: '/api/connect',
        headers: { 'X-API-Key': 'test-key-ro', 'X-Audit-User': 'lisi' },
        payload: { source: 'ok-ro' },
      });
      expect(conn.statusCode).toBe(200);
      const lines = readAudit(auditPath);
      for (const l of lines) {
        expect(Object.prototype.hasOwnProperty.call(l, 'auditUser')).toBe(false);
      }
    } finally {
      await server.close();
    }
  });

  it('CORS 预检（带 origin）放行 X-DB-Source / X-Audit-User 头', async () => {
    const { server } = await makeServer(defaultRegistryRaw(), okAdapterFactory());
    try {
      const preflight = await server.inject({
        method: 'OPTIONS',
        url: '/mcp',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'x-db-source, x-audit-user',
        },
      });
      expect(preflight.statusCode).toBe(204);
      const allow = (preflight.headers['access-control-allow-headers'] as string) || '';
      expect(allow.toLowerCase()).toContain('x-db-source');
      expect(allow.toLowerCase()).toContain('x-audit-user');
    } finally {
      await server.close();
    }
  });
});