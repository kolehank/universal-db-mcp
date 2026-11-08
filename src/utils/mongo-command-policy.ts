/**
 * MongoDB 操作权限策略（P0-3）
 *
 * MongoDB 不是 SQL，无法套用关键字白名单，因此按「操作类型」做权限判定：
 * - find / findOne / count / distinct / aggregate（不含 $out/$merge）→ read
 * - insert / insertOne / insertMany → insert
 * - update / updateOne / updateMany / replace / aggregate 的 $merge → update
 * - delete / deleteOne / deleteMany / remove / aggregate 的 $out（会整体替换集合）→ delete
 * - drop / create / rename 以及未知操作 → ddl
 *
 * 额外拦截服务端脚本执行：
 * - `$where`（query 中执行 JS）、`$function` / `$accumulator`（聚合中执行 JS）
 *   只有 ddl（full）权限才放行，避免只读/读写会话执行任意服务端代码。
 *
 * 本策略在两层生效：safety.validateQuery（执行前，拒绝时 → 403）与
 * MongoDBAdapter.executeQuery（适配器内再做一次纵深防御）。
 */

import type { PermissionType } from '../types/adapter.js';

export interface ParsedMongoQuery {
  collection: string;
  operation: string;
  query?: unknown;
  update?: unknown;
  pipeline?: unknown;
  options?: Record<string, unknown>;
}

export interface MongoDecision {
  allowed: boolean;
  /** 执行该操作需要的最低权限（read 表示纯读） */
  requiredPermission: PermissionType;
  reason?: string;
}

const READ_OPS = new Set([
  'find', 'findone', 'count', 'countdocuments', 'distinct', 'aggregate',
]);

const INSERT_OPS = new Set(['insert', 'insertone', 'insertmany']);

const UPDATE_OPS = new Set([
  'update', 'updateone', 'updatemany', 'replace', 'replaceone',
]);

const DELETE_OPS = new Set([
  'delete', 'deleteone', 'deletemany', 'remove', 'removeone', 'removemany',
]);

const DDL_OPS = new Set([
  'drop', 'dropcollection', 'dropdatabase', 'create', 'createcollection',
  'createindex', 'dropindex', 'dropindexes', 'rename', 'renamecollection',
]);

const PERMISSION_LABEL: Record<PermissionType, string> = {
  read: '读取(read)',
  insert: '插入(insert)',
  update: '更新(update)',
  delete: '删除(delete)',
  ddl: 'DDL(ddl)',
};

/**
 * 解析 MongoDB 查询字符串（与 MongoDBAdapter 使用同一实现）。
 * 支持：
 * - JSON：{"collection":"users","operation":"find","query":{...}}
 * - db.collection.operation({...})
 */
export function parseMongoQuery(query: string): ParsedMongoQuery {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('MongoDB 查询语句不能为空');
  }
  const trimmed = query.trim();

  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('无效的 JSON 查询格式');
    }
    return assertParsed(parsed);
  }

  const match = trimmed.match(/db\.(\w+)\.(\w+)\((.*)\)/s);
  if (match) {
    const [, collection, operation, argsStr] = match;
    let args: unknown = {};
    if (argsStr.trim()) {
      try {
        args = JSON.parse(argsStr);
      } catch {
        throw new Error('无效的查询参数格式');
      }
    }
    return assertParsed({ collection, operation, query: args });
  }

  throw new Error('不支持的查询格式。请使用 JSON 格式或 db.collection.operation() 格式');
}

function assertParsed(value: unknown): ParsedMongoQuery {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('无效的 MongoDB 查询：顶层必须是 JSON 对象');
  }
  const obj = value as Record<string, unknown>;
  const collection = obj.collection;
  const operation = obj.operation;
  if (typeof collection !== 'string' || collection.trim().length === 0) {
    throw new Error('MongoDB 查询缺少 collection 字段');
  }
  if (typeof operation !== 'string' || operation.trim().length === 0) {
    throw new Error('MongoDB 查询缺少 operation 字段');
  }
  return {
    collection,
    operation,
    query: obj.query,
    update: obj.update,
    pipeline: obj.pipeline,
    options:
      obj.options !== null && typeof obj.options === 'object' && !Array.isArray(obj.options)
        ? (obj.options as Record<string, unknown>)
        : undefined,
  };
}

/** 递归收集对象/数组中的全部键名（限制深度，防异常输入） */
function collectKeys(value: unknown, keys: Set<string>, depth = 0): void {
  if (depth > 32 || value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, keys, depth + 1);
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    keys.add(key);
    collectKeys(child, keys, depth + 1);
  }
}

/**
 * 判定一次 MongoDB 查询需要的权限，并给出是否允许的结论。
 */
export function decideMongoOperation(
  parsed: ParsedMongoQuery,
  permissions: PermissionType[]
): MongoDecision {
  const operation = parsed.operation.toLowerCase();
  const required = requiredPermissionOf(parsed, operation);

  if (required === null) {
    return {
      allowed: false,
      requiredPermission: 'ddl',
      reason: `❌ 操作被拒绝：不支持的 MongoDB 操作 ${parsed.operation}。`,
    };
  }

  if (permissions.includes(required)) {
    return { allowed: true, requiredPermission: required };
  }

  return {
    allowed: false,
    requiredPermission: required,
    reason:
      `❌ 操作被拒绝：MongoDB ${parsed.operation} 操作需要 ${PERMISSION_LABEL[required]} 权限。\n` +
      `当前权限：${permissions.join(', ')}\n` +
      '如需更多权限，请使用 --permission-mode 或 --permissions 参数，或改用受限数据库账号。',
  };
}

/** 返回所需权限；返回 null 表示无法识别（按拒绝处理） */
function requiredPermissionOf(
  parsed: ParsedMongoQuery,
  operation: string
): PermissionType | null {
  if (READ_OPS.has(operation)) {
    // 聚合管道里的 $out/$merge 属于写操作
    if (operation === 'aggregate') {
      const stageKeys = new Set<string>();
      collectKeys(parsed.pipeline, stageKeys);
      if (stageKeys.has('$out')) {
        return 'delete';
      }
      if (stageKeys.has('$merge')) {
        return 'update';
      }
    }
    // 服务端脚本：只有 full 放行
    if (containsServerSideScript(parsed)) {
      return 'ddl';
    }
    return 'read';
  }

  if (INSERT_OPS.has(operation)) {
    return 'insert';
  }
  if (UPDATE_OPS.has(operation)) {
    return 'update';
  }
  if (DELETE_OPS.has(operation)) {
    return 'delete';
  }
  if (DDL_OPS.has(operation)) {
    return 'ddl';
  }
  // 未知操作：适配器本身也会拒绝；这里按 ddl 处理，只有 full 能走到适配器报错
  return 'ddl';
}

/** query/update/pipeline 中是否包含 $where / $function / $accumulator */
function containsServerSideScript(parsed: ParsedMongoQuery): boolean {
  const keys = new Set<string>();
  collectKeys(parsed.query, keys);
  collectKeys(parsed.update, keys);
  collectKeys(parsed.pipeline, keys);
  return keys.has('$where') || keys.has('$function') || keys.has('$accumulator');
}

/** 便捷入口：直接对查询字符串做权限判定（safety.ts 使用） */
export function decideMongoQuery(
  query: string,
  permissions: PermissionType[]
): MongoDecision {
  let parsed: ParsedMongoQuery;
  try {
    parsed = parseMongoQuery(query);
  } catch (error) {
    return {
      allowed: false,
      requiredPermission: 'read',
      reason: `❌ 操作被拒绝：${error instanceof Error ? error.message : '无效的 MongoDB 查询'}`,
    };
  }
  return decideMongoOperation(parsed, permissions);
}
