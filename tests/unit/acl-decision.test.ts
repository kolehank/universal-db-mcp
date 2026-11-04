/**
 * §4.2 决策表 单元测试（逐行覆盖）
 */

import { describe, it, expect } from 'vitest';
import { decideAccess } from '../../src/security/datasource-registry';
import type { DecideAccessParams } from '../../src/security/datasource-registry';

function decide(overrides: Partial<DecideAccessParams> = {}) {
  const base: DecideAccessParams = {
    registryEnabled: true,
    adhocEnabled: false,
    hasAdhocParams: false,
  };
  return decideAccess({ ...base, ...overrides });
}

describe('decideAccess（§4.2 决策表）', () => {
  it('有 source 且 key 的 allowedSources 包含它 → allow', () => {
    const result = decide({
      source: 'ok-ro',
      key: { allowedSources: ['ok-ro', 'ok-rw'] },
    });
    expect(result).toEqual({ decision: 'allow' });
  });

  it('带 source 但 key 的 allowedSources 不包含 → SOURCE_NOT_FOUND（与"源不存在"不可区分）', () => {
    const result = decide({
      source: 'ok-rw',
      key: { allowedSources: ['ok-ro'] },
    });
    expect(result).toEqual({ decision: 'deny', code: 'SOURCE_NOT_FOUND' });
  });

  it('带未知 source → SOURCE_NOT_FOUND', () => {
    const result = decide({
      source: 'nope',
      key: { allowedSources: ['ok-ro'] },
    });
    expect(result).toEqual({ decision: 'deny', code: 'SOURCE_NOT_FOUND' });
  });

  it('注册表模式下 key 缺失、带 source → SOURCE_NOT_FOUND（无 key 视为无权）', () => {
    const result = decide({ source: 'ok-ro', key: undefined });
    expect(result).toEqual({ decision: 'deny', code: 'SOURCE_NOT_FOUND' });
  });

  it('未带 source、存在 adhoc 参数、adhoc 未开启 → ADHOC_DISABLED', () => {
    const result = decide({
      adhocEnabled: false,
      hasAdhocParams: true,
      adhocTarget: '10.1.2.3:3306',
    });
    expect(result).toEqual({ decision: 'deny', code: 'ADHOC_DISABLED' });
  });

  it('未带 source、adhoc 开启、目标不在白名单 → ADHOC_TARGET_DENIED', () => {
    const result = decide({
      adhocEnabled: true,
      hasAdhocParams: true,
      adhocTarget: '10.9.9.9:3306',
      adhocTargetAllowlist: ['10.1.2.3:3306'],
    });
    expect(result).toEqual({ decision: 'deny', code: 'ADHOC_TARGET_DENIED' });
  });

  it('adhoc 开启且目标是空字符串/缺失、名单非空 → ADHOC_TARGET_DENIED', () => {
    expect(
      decide({ adhocEnabled: true, hasAdhocParams: true, adhocTargetAllowlist: ['10.1.2.3:3306'] })
    ).toEqual({ decision: 'deny', code: 'ADHOC_TARGET_DENIED' });
    expect(
      decide({ adhocEnabled: true, hasAdhocParams: true, adhocTarget: '', adhocTargetAllowlist: ['10.1.2.3:3306'] })
    ).toEqual({ decision: 'deny', code: 'ADHOC_TARGET_DENIED' });
  });

  it('adhoc 开启且白名单为空 → 放行（legacy 行为）', () => {
    const result = decide({
      adhocEnabled: true,
      hasAdhocParams: true,
      adhocTarget: '10.9.9.9:3306',
      adhocTargetAllowlist: [],
    });
    expect(result).toEqual({ decision: 'allow' });
  });

  it('adhoc 开启且白名单未提供（undefined）→ 放行', () => {
    const result = decide({ adhocEnabled: true, hasAdhocParams: true });
    expect(result).toEqual({ decision: 'allow' });
  });

  it('adhoc 开启、目标命中白名单（host 大小写不敏感）→ 放行', () => {
    const result = decide({
      adhocEnabled: true,
      hasAdhocParams: true,
      adhocTarget: 'DB.INTERNAL:5432',
      adhocTargetAllowlist: ['db.internal:5432', '10.1.2.3:3306'],
    });
    expect(result).toEqual({ decision: 'allow' });
  });

  it('未带任何连接参数 → INVALID_REQUEST', () => {
    const result = decide({});
    expect(result).toEqual({ decision: 'deny', code: 'INVALID_REQUEST' });
  });

  it('legacy（无注册表）+ 显式开 adhoc + 空名单 → 放行', () => {
    const result = decide({
      registryEnabled: false,
      adhocEnabled: true,
      hasAdhocParams: true,
      adhocTarget: '10.1.2.3:3306',
      adhocTargetAllowlist: [],
    });
    expect(result).toEqual({ decision: 'allow' });
  });

  it('legacy 模式下携带 source → SOURCE_NOT_FOUND（无注册表即无已知源）', () => {
    const result = decide({ registryEnabled: false, source: 'db1' });
    expect(result).toEqual({ decision: 'deny', code: 'SOURCE_NOT_FOUND' });
  });

  it('legacy + adhoc 参数但 adhoc 未开 → ADHOC_DISABLED', () => {
    const result = decide({ registryEnabled: false, adhocEnabled: false, hasAdhocParams: true });
    expect(result).toEqual({ decision: 'deny', code: 'ADHOC_DISABLED' });
  });

  it('有 source 时忽略其余连接参数（adhoc 参数一并忽略）', () => {
    const result = decide({
      source: 'ok-ro',
      key: { allowedSources: ['ok-ro'] },
      hasAdhocParams: true,
      adhocEnabled: false,
      adhocTarget: 'evil:3306',
    });
    expect(result).toEqual({ decision: 'allow' });
  });

  it('source 为空字符串视为未携带 → INVALID_REQUEST（无其他参数）', () => {
    const result = decide({ source: '' });
    expect(result).toEqual({ decision: 'deny', code: 'INVALID_REQUEST' });
  });
});