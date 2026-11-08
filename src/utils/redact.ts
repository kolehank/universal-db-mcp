/**
 * 日志脱敏工具（P0-6）
 *
 * 目的：数据库口令等敏感信息绝不进入 URL / 访问日志。
 * - HTTP 访问日志只保留 method + redacted URL；
 * - query string 中常见的口令/密钥参数统一替换为 `***`。
 */

const SECRET_QUERY_PARAMS = new Set([
  'password',
  'passwd',
  'pwd',
  'pass',
  'token',
  'access_token',
  'secret',
  'client_secret',
  'api_key',
  'apikey',
  'x-api-key',
  'x-db-password',
  'authorization',
]);

/** 把 URL query string 中的敏感参数值替换为 ***，用于日志输出 */
export function redactUrl(rawUrl: string): string {
  const queryIndex = rawUrl.indexOf('?');
  if (queryIndex === -1) {
    return rawUrl;
  }
  const base = rawUrl.slice(0, queryIndex);
  const params = new URLSearchParams(rawUrl.slice(queryIndex + 1));
  for (const key of Array.from(params.keys())) {
    if (SECRET_QUERY_PARAMS.has(key.toLowerCase())) {
      params.set(key, '***');
    }
  }
  return `${base}?${params.toString()}`;
}

/**
 * 审计 SQL 中的口令类字面量脱敏（P1-10）。
 * 仅处理「明显是口令/密钥」的赋值，保留普通业务 SQL 的可读性：
 * - `IDENTIFIED BY 'xxx'` / `IDENTIFIED WITH ... AS 'xxx'`
 * - `PASSWORD 'xxx'` / `PASSWORD = 'xxx'`
 * - `password|passwd|pwd|secret|token|api_key ... 'xxx'`（= / := / TO / BY 可选）
 */
export function redactSecretsInSql(sql: string): string {
  return sql
    .replace(/\bIDENTIFIED\s+(?:BY|WITH)\b[^'"]*?(['"])[^'"]*\1/gi, "IDENTIFIED BY '***'")
    .replace(
      /\b(password|passwd|pwd|secret|token|api[_-]?key)(\s*(?:=|:=|to|by)\s*)(['"])[^'"]*\3/gi,
      (_match, key: string) => `${key} = '***'`
    )
    .replace(/\b(PASSWORD)\s+(['"])[^'"]*\2/gi, "PASSWORD '***'");
}
