/**
 * Package Version Reader
 *
 * 运行时读取 package.json 的 version 字段。
 * 不能用静态 import（tsconfig rootDir: ./src 限制，dist 与 package.json 同根，
 * 本文件经 tsc 编译到 dist/utils/ 后，new URL('../package.json', import.meta.url)
 * 仍能正确解析到发布根目录的 package.json）。
 */

import { readFileSync } from 'node:fs';

let cachedVersion: string | undefined;

/** 返回 package.json 的 version 字符串（首次调用后缓存） */
export function readPackageVersion(): string {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }
  const pkgPath = new URL('../../package.json', import.meta.url);
  const parsed = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('package.json 缺少 version 字段');
  }
  cachedVersion = parsed.version;
  return cachedVersion;
}