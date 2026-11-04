/**
 * AuditContext / AsyncLocalStorage 单元测试（P4a）
 * 验证上下文传递、异步边界、并发隔离、嵌套覆盖。
 */

import { describe, expect, it } from 'vitest';
import { getAuditContext, runWithAuditContext, type AuditContext } from '../../src/security/audit-context.js';

function makeCtx(overrides: Partial<AuditContext> = {}): AuditContext {
  return {
    requestId: 'req-1',
    transport: 'rest',
    principal: 'reporting-bot',
    keyFingerprint: 'ab12cd34ef56',
    source: 'finance-ro',
    clientIp: '10.0.0.9',
    ...overrides,
  };
}

describe('AuditContext / AsyncLocalStorage', () => {
  it('不在 runWithAuditContext 作用域内时返回 undefined', () => {
    expect(getAuditContext()).toBeUndefined();
  });

  it('同步作用域内可取到上下文，退出后恢复为 undefined', () => {
    expect(getAuditContext()).toBeUndefined();
    runWithAuditContext(makeCtx(), () => {
      expect(getAuditContext()).toEqual(makeCtx());
    });
    expect(getAuditContext()).toBeUndefined();
  });

  it('async 边界内（await 之后）仍持有同一上下文', async () => {
    await runWithAuditContext(makeCtx({ requestId: 'req-async' }), async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(getAuditContext()?.requestId).toBe('req-async');
      expect(getAuditContext()?.source).toBe('finance-ro');
    });
    expect(getAuditContext()).toBeUndefined();
  });

  it('并行的两个 run 互不串扰（请求隔离）', async () => {
    const seen: string[] = [];
    await Promise.all([
      runWithAuditContext(makeCtx({ requestId: 'a' }), async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        seen.push(getAuditContext()!.requestId);
      }),
      runWithAuditContext(makeCtx({ requestId: 'b' }), async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(getAuditContext()!.requestId);
      }),
    ]);
    expect(seen.sort()).toEqual(['a', 'b']);
  });

  it('嵌套 run 覆盖外层上下文，退出内层后恢复外层', () => {
    runWithAuditContext(makeCtx({ requestId: 'outer' }), () => {
      expect(getAuditContext()?.requestId).toBe('outer');
      runWithAuditContext(makeCtx({ requestId: 'inner', source: 'ok-rw' }), () => {
        expect(getAuditContext()?.requestId).toBe('inner');
        expect(getAuditContext()?.source).toBe('ok-rw');
      });
      expect(getAuditContext()?.requestId).toBe('outer'); // 已恢复
      expect(getAuditContext()?.source).toBe('finance-ro');
    });
    expect(getAuditContext()).toBeUndefined();
  });

  it('透传同步返回值', () => {
    const value = runWithAuditContext(makeCtx(), () => 42);
    expect(value).toBe(42);
  });

  it('透传异步（Promise）返回值', async () => {
    const value = await runWithAuditContext(makeCtx(), async () => 'done');
    expect(value).toBe('done');
  });
});