/**
 * Redis 命令权限策略
 *
 * Redis 不是 SQL，`safety.ts` 的关键字检测对其无效。本模块把 Redis 命令映射到
 * 与 SQL 一致的权限类型（read / insert / update / delete / ddl），并负责：
 * - 只读模式（权限只有 read）：仅允许纯读命令白名单；
 * - 其他模式：按命令类别校验对应权限；
 * - 未知命令（含 Redis 模块命令）：只有 full（含 ddl）模式才允许，避免 CONFIG/EVAL/
 *   MODULE 等管理类命令在 readwrite 下被意外放行。
 *
 * 注意：`EVAL`/`EVALSHA`/`FCALL` 之类可在服务端执行任意 Lua，按 ddl（需 full）处理；
 * `CONFIG SET dir` + `SAVE` 可写任意文件，`MODULE LOAD` 可加载本地动态库，均按 ddl 处理。
 */

import type { PermissionType } from '../types/adapter.js';

/** 纯读命令（只读模式唯一允许的集合） */
export const REDIS_READ_COMMANDS: ReadonlySet<string> = new Set([
  'get', 'mget', 'getrange', 'strlen', 'exists', 'type',
  'ttl', 'pttl', 'expiretime', 'pexpiretime',
  'keys', 'scan', 'hscan', 'sscan', 'zscan',
  'hget', 'hmget', 'hgetall', 'hkeys', 'hvals', 'hlen', 'hexists', 'hstrlen',
  'smembers', 'scard', 'sismember', 'smismember', 'sinter', 'sunion', 'sdiff',
  'zrange', 'zrevrange', 'zrangebyscore', 'zrevrangebyscore', 'zrangebylex', 'zrevrangebylex',
  'zcard', 'zscore', 'zmscore', 'zrank', 'zrevrank', 'zcount', 'zlexcount',
  'lrange', 'llen', 'lindex', 'lpos',
  'bitcount', 'getbit',
  'info', 'dbsize', 'time', 'ping', 'echo', 'randomkey', 'dump', 'lastsave',
  'xlen', 'xrange', 'xrevrange', 'xread', 'xinfo',
  'geodist', 'geopos', 'geohash', 'geosearch', 'pfcount',
  'lcs', 'sort_ro',
]);

/** 创建/写入类命令（需要 insert 权限） */
const REDIS_INSERT_COMMANDS: ReadonlySet<string> = new Set([
  'set', 'setnx', 'setex', 'psetex', 'mset', 'msetnx', 'append',
  'incr', 'decr', 'incrby', 'decrby', 'incrbyfloat',
  'hset', 'hsetnx', 'hmset', 'hincrby', 'hincrbyfloat',
  'lpush', 'rpush', 'lpushx', 'rpushx', 'linsert',
  'sadd',
  'zadd', 'zincrby',
  'pfadd',
  'xadd',
  'setbit', 'bitfield',
  'geoadd',
  'copy',
]);

/** 修改类命令（需要 update 权限） */
const REDIS_UPDATE_COMMANDS: ReadonlySet<string> = new Set([
  'setrange', 'getset', 'lset', 'rpoplpush', 'lmove',
  'rename', 'renamenx', 'move',
  'expire', 'pexpire', 'expireat', 'pexpireat', 'persist', 'getex',
  'bitop',
  'pfmerge',
  'xack', 'xclaim', 'xautoclaim', 'xgroup', 'xsetid',
  'sort',
  'georadius', 'georadiusbymember', 'geosearchstore', 'georadius_store',
]);

/** 删除类命令（需要 delete 权限） */
const REDIS_DELETE_COMMANDS: ReadonlySet<string> = new Set([
  'del', 'unlink',
  'lpop', 'rpop', 'lmpop', 'ltrim', 'lrem',
  'hdel',
  'srem', 'spop', 'smove',
  'zrem', 'zremrangebyrank', 'zremrangebyscore', 'zremrangebylex', 'zpopmin', 'zpopmax', 'zmpop',
  'xdel',
  'getdel',
  'flushdb', 'flushall',
]);

/** 管理/高危命令（需要 ddl，即 full 模式） */
const REDIS_DDL_COMMANDS: ReadonlySet<string> = new Set([
  'config', 'module', 'acl', 'client', 'cluster', 'command',
  'slaveof', 'replicaof', 'migrate', 'restore', 'swapdb', 'failover', 'sentinel',
  'shutdown', 'debug', 'monitor', 'sync', 'psync',
  'save', 'bgsave', 'bgrewriteaof',
  'script', 'function',
  'eval', 'evalsha', 'eval_ro', 'evalsha_ro', 'fcall', 'fcall_ro',
  'multi', 'exec', 'discard', 'watch', 'unwatch',
  'replconf', 'subscribe', 'unsubscribe', 'psubscribe', 'punsubscribe', 'publish',
]);

export interface RedisCommandDecision {
  allowed: boolean;
  /** 拒绝时返回中文原因 */
  reason?: string;
  /** 该命令要求的权限（未识别为 undefined） */
  requiredPermission?: PermissionType;
}

function permissionLabel(p: PermissionType): string {
  const labels: Record<PermissionType, string> = {
    read: '读取(read)',
    insert: '插入(insert)',
    update: '更新(update)',
    delete: '删除(delete)',
    ddl: '管理/DDL(ddl)',
  };
  return labels[p];
}

/** 从查询串中取出 Redis 命令名（第一条命令的第一个 token） */
export function extractRedisCommand(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const token = trimmed.split(/\s+/)[0];
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(token)) {
    return null;
  }
  return token.toLowerCase();
}

/**
 * 判定 Redis 命令是否允许执行。
 * @param query 客户端提交的命令串（如 "GET user:1"）
 * @param permissions 当前生效权限（含 read）
 */
export function decideRedisCommand(query: string, permissions: PermissionType[]): RedisCommandDecision {
  // 拒绝换行：避免把多条命令塞进一个字符串（虽然 ioredis.call 会按参数拆分，这里仍做纵深防御）
  if (/[\r\n]/.test(query)) {
    return { allowed: false, reason: 'Redis 命令不允许包含换行符（一次只能执行一条命令）' };
  }

  const command = extractRedisCommand(query);
  if (command === null) {
    return { allowed: false, reason: '无法识别的 Redis 命令' };
  }

  const isReadOnly = permissions.length === 1 && permissions[0] === 'read';

  if (REDIS_READ_COMMANDS.has(command)) {
    return { allowed: true, requiredPermission: 'read' };
  }

  let required: PermissionType | undefined;
  if (REDIS_DELETE_COMMANDS.has(command)) {
    required = 'delete';
  } else if (REDIS_UPDATE_COMMANDS.has(command)) {
    required = 'update';
  } else if (REDIS_INSERT_COMMANDS.has(command)) {
    required = 'insert';
  } else if (REDIS_DDL_COMMANDS.has(command)) {
    required = 'ddl';
  }

  if (required === undefined) {
    if (permissions.includes('ddl')) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason:
        `Redis 命令 "${command.toUpperCase()}" 不在允许列表中（当前权限：${permissions.join(', ')}）。` +
        '未知命令（含模块命令）仅在 full 模式下允许。',
    };
  }

  if (permissions.includes(required)) {
    return { allowed: true, requiredPermission: required };
  }

  if (isReadOnly) {
    return {
      allowed: false,
      reason:
        `❌ 操作被拒绝：当前为只读模式，不允许 Redis ${command.toUpperCase()} 命令。` +
        `该命令需要${permissionLabel(required)}权限。`,
    };
  }

  return {
    allowed: false,
    reason:
      `❌ 操作被拒绝：当前权限不允许 Redis ${command.toUpperCase()} 命令。` +
      `需要的权限：${permissionLabel(required)}；当前权限：${permissions.join(', ')}`,
  };
}
