/**
 * 错误分类机制（评审裁决 §4-10 / 规格 §6）
 *
 * AclError：带错误码的轻量错误类型，用于让路由 catch 按 code 映射 HTTP 状态码。
 * - 本 phase 只在两处产生 AclError：
 *   1. database-service 捕获 validateQuery 抛出的写权限拒绝 → code='PERMISSION_DENIED'（不改 safety.ts）；
 *   2. （接入方自行构造，如 CONNECT_FAILED 场景）。
 * - classifyError：路由 catch 的统一分类入口，未带 code 的普通 Error 走 fallback。
 */

/** 规格 §6 错误码 → HTTP 状态码 */
const ACL_STATUS: Record<string, number> = {
  INVALID_REQUEST: 400,
  ADHOC_DISABLED: 403,
  ADHOC_TARGET_DENIED: 403,
  SOURCE_NOT_FOUND: 404,
  PERMISSION_DENIED: 403,
  CONNECT_FAILED: 502,
};

/** 带错误码的领域错误（至少支持 PERMISSION_DENIED，规格 §6 全量见上方状态表） */
export class AclError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AclError';
    this.code = code;
  }
}

export interface ClassifiedError {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * 按 error.code 映射 HTTP 状态码：
 * - AclError → 查 §6 表（未知 code 回落到 fallbackStatus）；
 * - 其他普通 Error → fallbackCode + fallbackStatus（保持既有 500 语义，换码不变）。
 */
export function classifyError(
  error: unknown,
  fallbackCode: string,
  fallbackStatus = 500
): ClassifiedError {
  if (error instanceof AclError) {
    return {
      statusCode: ACL_STATUS[error.code] ?? fallbackStatus,
      code: error.code,
      message: error.message,
    };
  }
  return {
    statusCode: fallbackStatus,
    code: fallbackCode,
    message: error instanceof Error ? error.message : '服务器内部错误',
  };
}