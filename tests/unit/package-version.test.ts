/**
 * readPackageVersion 单元测试
 */

import { describe, it, expect } from 'vitest';
import { readPackageVersion } from '../../src/utils/package-version';

describe('readPackageVersion', () => {
  it('返回 package.json 的 version 字符串（semver 格式）', () => {
    const version = readPackageVersion();
    expect(typeof version).toBe('string');
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(version.length).toBeGreaterThan(0);
  });

  it('多次调用结果一致', () => {
    expect(readPackageVersion()).toBe(readPackageVersion());
  });
});