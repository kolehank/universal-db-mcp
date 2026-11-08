/**
 * 安全检查工具
 * 用于防止误操作删库等危险行为
 *
 * 3.0.1 安全加固（P0）：
 * - 只读模式不再只判断「首个关键字」——先做词法归一化（去掉字符串/注释/标识符，
 *   MySQL 以 `/*!` 开头的可执行注释保留其内容），再按语句拆分逐条校验；
 * - 只读模式对首关键字做白名单，并额外拦截 WITH/EXPLAIN 内部的 DML/DDL、
 *   SELECT ... INTO、FOR UPDATE、危险函数（pg_read_file/load_file/utl_file 等）；
 * - 非只读模式也对每条语句做操作类型校验，堵住 `SELECT 1; DELETE`、`WITH ... DELETE`；
 * - Redis / MongoDB 为非 SQL 协议：Redis 走 redis-command-policy，MongoDB 走
 *   mongo-command-policy（按操作类型与聚合阶段校验）。
 *
 * 注意：代码层校验是纵深防御，真正的主防线仍是数据库账号最小权限 + 只读会话
 * （各适配器在 readOnly 时会话级设置只读）。
 */

import type { DbConfig, PermissionType } from '../types/adapter.js';
import { decideRedisCommand } from './redis-command-policy.js';
import { decideMongoQuery } from './mongo-command-policy.js';

/**
 * 操作类型到 SQL 关键字的映射
 */
const OPERATION_KEYWORDS: Record<Exclude<PermissionType, 'read'>, readonly string[]> = {
  insert: ['INSERT', 'REPLACE', 'UPSERT'],
  update: ['UPDATE', 'MERGE'],
  delete: ['DELETE', 'TRUNCATE'],
  ddl: ['CREATE', 'ALTER', 'DROP', 'RENAME', 'COMMENT', 'GRANT', 'REVOKE', 'CALL', 'EXEC', 'EXECUTE', 'DO', 'LOCK', 'UNLOCK', 'VACUUM', 'ANALYZE', 'ATTACH', 'DETACH', 'COPY', 'IMPORT', 'LOAD'],
} as const;

/**
 * 预设权限模式
 */
const PERMISSION_PRESETS: Record<string, readonly PermissionType[]> = {
  safe: ['read'],
  readwrite: ['read', 'insert', 'update'],
  full: ['read', 'insert', 'update', 'delete', 'ddl'],
} as const;

/**
 * 解析配置得到最终权限列表
 */
export function resolvePermissions(config: DbConfig): PermissionType[] {
  // 向后兼容：allowWrite=true 且未设置新参数时，等价于 full
  if (config.allowWrite === true && !config.permissionMode && !config.permissions) {
    return [...PERMISSION_PRESETS.full];
  }

  // 直接指定 permissions 数组（优先级最高）
  if (config.permissions?.length) {
    const perms = new Set<PermissionType>(['read', ...config.permissions]);
    return Array.from(perms);
  }

  // 使用预设模式
  if (config.permissionMode && config.permissionMode !== 'custom') {
    return [...PERMISSION_PRESETS[config.permissionMode]];
  }

  // 默认安全模式
  return [...PERMISSION_PRESETS.safe];
}

/**
 * 是否为「只读」配置（权限集合恰好只有 read）。
 * 各适配器据此开启会话级只读（PG 的 default_transaction_read_only、MySQL 的
 * SESSION TRANSACTION READ ONLY、SQLite 的 query_only 等）。
 */
export function isReadOnlyConfig(config: DbConfig): boolean {
  const permissions = resolvePermissions(config);
  return permissions.length === 1 && permissions[0] === 'read';
}

/**
 * 检查 SQL 语句是否以指定关键字开头
 */
function startsWithKeyword(query: string, keyword: string): boolean {
  const pattern = new RegExp(`^(\\s|--.*|/\\*.*?\\*/)*${keyword}\\b`, 'i');
  return pattern.test(query);
}

/**
 * 检查 SQL 语句是否包含写操作
 * @param query - 待检查的 SQL 语句
 * @returns 如果包含写操作返回 true
 */
export function isWriteOperation(query: string): boolean {
  const upperQuery = query.trim().toUpperCase();
  for (const keywords of Object.values(OPERATION_KEYWORDS)) {
    for (const keyword of keywords) {
      if (startsWithKeyword(upperQuery, keyword)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 词法归一化
// ---------------------------------------------------------------------------

/**
 * 去掉字符串字面量、注释与引号标识符，只保留语句结构，便于做关键字检测。
 * - 字符串/标识符内容替换为空格，避免把字符串里的关键字误判为语句；
 * - MySQL `/*! ... *​/` 可执行注释：**保留**其内部 SQL（MySQL 会执行它）；
 * - 支持 PG 的 `$tag$ ... $tag$` 字符串。
 */
export function stripSqlLiterals(query: string): string {
  let out = '';
  let i = 0;
  const n = query.length;

  while (i < n) {
    const ch = query[i];
    const next = query[i + 1];

    // 单引号字符串（支持 '' 与反斜杠转义）
    if (ch === "'") {
      out += ' ';
      i += 1;
      while (i < n) {
        if (query[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (query[i] === "'") {
          if (query[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // 引号标识符：双引号 / 反引号 / SQL Server 方括号
    if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      out += ' ';
      i += 1;
      while (i < n) {
        if (query[i] === close) {
          if (close !== ']' && query[i + 1] === close) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // 行注释：-- 与 MySQL 的 #
    if ((ch === '-' && next === '-') || ch === '#') {
      while (i < n && query[i] !== '\n') {
        i += 1;
      }
      out += ' ';
      continue;
    }

    // 块注释（含 MySQL 可执行注释）
    if (ch === '/' && next === '*') {
      if (query[i + 2] === '!') {
        // /*!50000 DROP TABLE t */ —— MySQL 会执行内部内容，保留并继续归一化
        let j = i + 3;
        while (j < n && /\d/.test(query[j] ?? '')) {
          j += 1;
        }
        const end = query.indexOf('*/', j);
        const inner = end === -1 ? query.slice(j) : query.slice(j, end);
        out += ` ${stripSqlLiterals(inner)} `;
        i = end === -1 ? n : end + 2;
        continue;
      }
      const end = query.indexOf('*/', i + 2);
      out += ' ';
      i = end === -1 ? n : end + 2;
      continue;
    }

    // PostgreSQL dollar-quoted 字符串：$$...$$ 或 $tag$...$tag$
    if (ch === '$') {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(query.slice(i));
      if (match) {
        const tag = match[0];
        const end = query.indexOf(tag, i + tag.length);
        out += ' ';
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

/** 按顶层分号拆分语句（此时字符串/注释已被抹掉） */
function splitStatements(strippedQuery: string): string[] {
  return strippedQuery
    .split(';')
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

/** 取语句首个关键字（跳过前导括号与空白） */
function firstKeyword(statement: string): string | null {
  let s = statement.trim();
  while (s.startsWith('(')) {
    s = s.slice(1).trim();
  }
  const match = /^([A-Za-z]+)/.exec(s);
  return match ? match[1].toUpperCase() : null;
}

/** 首关键字 → 操作类型 */
function operationOfKeyword(keyword: string): Exclude<PermissionType, 'read'> | null {
  for (const [opType, keywords] of Object.entries(OPERATION_KEYWORDS) as Array<
    [Exclude<PermissionType, 'read'>, readonly string[]]
  >) {
    if (keywords.includes(keyword)) {
      return opType;
    }
  }
  return null;
}

const OP_RANK: Record<Exclude<PermissionType, 'read'>, number> = {
  insert: 1,
  update: 2,
  delete: 3,
  ddl: 4,
};

/** WITH / EXPLAIN 等包装语句内部可能隐藏的写操作关键字 */
const INNER_WRITE_KEYWORDS = /^(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|RENAME|GRANT|REVOKE|ATTACH|DETACH|COPY|VACUUM|REINDEX)$/;

/**
 * 检测单条语句的操作类型。
 * - 普通语句按首关键字；
 * - WITH/EXPLAIN/括号包裹的语句额外扫描内部 token，取最高危操作。
 */
function detectOperationOfStatement(
  statement: string
): { type: Exclude<PermissionType, 'read'>; keyword: string } | null {
  const keyword = firstKeyword(statement);
  if (keyword === null) {
    return null;
  }

  const direct = operationOfKeyword(keyword);
  if (direct !== null && keyword !== 'WITH' && keyword !== 'EXPLAIN') {
    return { type: direct, keyword };
  }

  // WITH ... / EXPLAIN ...：扫描内部写操作关键字
  if (keyword === 'WITH' || keyword === 'EXPLAIN') {
    let highest: { type: Exclude<PermissionType, 'read'>; keyword: string } | null = null;
    const tokens = statement.match(/\b[A-Za-z]+\b/g) ?? [];
    for (const token of tokens) {
      const upper = token.toUpperCase();
      if (!INNER_WRITE_KEYWORDS.test(upper)) {
        continue;
      }
      const opType = operationOfKeyword(upper);
      if (opType === null) {
        continue;
      }
      if (highest === null || OP_RANK[opType] > OP_RANK[highest.type]) {
        highest = { type: opType, keyword: upper };
      }
    }
    return highest;
  }

  return null;
}

/**
 * 只读模式允许的首关键字白名单。
 * 刻意不包含 SET/RESET/BEGIN/COMMIT/ROLLBACK 等会话控制语句：
 * 例如 `SET default_transaction_read_only = off` 会直接关掉会话级只读保护。
 */
const SAFE_FIRST_KEYWORDS: ReadonlySet<string> = new Set([
  'SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN',
  'TABLE', 'VALUES', 'PRAGMA', 'USE', 'HELP',
]);

/** 只读模式下需要显式拦截的危险函数 / 语法 */
const DANGEROUS_FUNCTIONS = new RegExp(
  '\\b(' +
    [
      // PostgreSQL
      'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file', 'pg_stat_get_file',
      'pg_sleep', 'pg_terminate_backend', 'pg_cancel_backend', 'lo_import', 'lo_export',
      'dblink', 'dblink_exec', 'set_config',
      // MySQL / MariaDB
      'load_file', 'sys_exec', 'sys_eval',
      // SQLite 扩展函数（需要先 load_extension，后者同样被拦截）
      'load_extension',
      // Oracle / 达梦
      'utl_file', 'utl_http', 'utl_smtp', 'utl_tcp', 'dbms_scheduler', 'dbms_lock', 'dbms_pipe',
      // SQL Server
      'xp_cmdshell', 'openrowset', 'opendatasource', 'sp_executesql', 'sp_oacreate', 'sp_oamethod',
    ].join('|') +
    ')\\b',
  'i'
);

/** 只读模式允许的 PRAGMA（仅读取元信息；带 `=` 的一律拒绝） */
const SAFE_PRAGMA_NAMES = new RegExp(
  '^(?:[A-Za-z_][A-Za-z0-9_]*\\.)?(table_info|table_xinfo|table_list|index_list|index_info|index_xinfo|foreign_key_list|foreign_key_check|database_list|compile_options|encoding|integrity_check|quick_check|collation_list|function_list|module_list|pragma_list|user_version)\\b',
  'i'
);

function denyReadOnly(reason: string): never {
  throw new Error(
    `❌ 操作被拒绝：只读模式仅允许查询操作。${reason}\n` +
    '当前权限：read（只读模式）\n' +
    '如需更多权限，请使用 --permission-mode 或 --permissions 参数，或改用只读数据库账号。'
  );
}

/** 只读模式下逐条校验语句 */
function assertStatementSafe(statement: string): void {
  const keyword = firstKeyword(statement);
  if (keyword === null) {
    denyReadOnly('无法识别的 SQL 语句。');
  }
  if (!SAFE_FIRST_KEYWORDS.has(keyword)) {
    denyReadOnly(`不允许 ${keyword} 语句。`);
  }

  // SELECT ... INTO（PG 建表 / MySQL 写文件或变量）
  if (/\bINTO\b/i.test(statement)) {
    denyReadOnly('不允许 SELECT ... INTO（可能写文件或建表）。');
  }

  // 行级锁属于写语义
  if (/\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i.test(statement)) {
    denyReadOnly('不允许 SELECT ... FOR UPDATE（加锁属于写操作）。');
  }

  if (DANGEROUS_FUNCTIONS.test(statement)) {
    denyReadOnly('语句包含只读模式下禁止的危险函数。');
  }

  if (keyword === 'PRAGMA') {
    if (statement.includes('=')) {
      denyReadOnly('不允许带赋值的 PRAGMA 语句。');
    }
    const pragmaName = statement.replace(/^PRAGMA\s+/i, '').trim();
    if (!SAFE_PRAGMA_NAMES.test(pragmaName)) {
      denyReadOnly(`PRAGMA ${pragmaName.split(/\s+/)[0]} 不在只读白名单中。`);
    }
  }

  if (keyword === 'WITH' || keyword === 'EXPLAIN') {
    const inner = detectOperationOfStatement(statement);
    if (inner !== null) {
      denyReadOnly(`语句内部包含 ${inner.keyword} 写操作。`);
    }
  }
}

/**
 * 校验 SQL（支持多语句）：
 * - 只读模式：每条语句都必须落在白名单内；
 * - 其他模式：逐条语句检查操作类型是否在权限集合内。
 * - SQLite 额外禁止 ATTACH/DETACH：即使拥有写权限，也不允许把任意本地文件挂载为数据库
 *   （数据库文件路径只允许由服务端注册表/CLI 指定）。
 */
function validateSql(query: string, permissions: PermissionType[], dbType?: string): void {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('❌ 查询语句不能为空。');
  }

  const statements = splitStatements(stripSqlLiterals(query));
  if (statements.length === 0) {
    throw new Error('❌ 查询语句不能为空。');
  }

  if (dbType === 'sqlite') {
    for (const statement of statements) {
      if (/\b(ATTACH|DETACH)\b/i.test(statement)) {
        throw new Error(
          '❌ 操作被拒绝：SQLite 不允许 ATTACH / DETACH。' +
          '数据库文件只能由服务端注册表（DATASOURCE_CONFIG）或启动参数指定。'
        );
      }
      // VACUUM INTO 'file' 会写出任意路径文件
      if (/\bVACUUM\s+INTO\b/i.test(statement)) {
        throw new Error('❌ 操作被拒绝：SQLite 不允许 VACUUM INTO（会写出任意文件）。');
      }
    }
  }

  const readOnly = permissions.length === 1 && permissions[0] === 'read';

  if (readOnly) {
    for (const statement of statements) {
      assertStatementSafe(statement);
    }
    return;
  }

  // 非只读模式：逐条语句按权限校验（多语句也不能绕过）
  for (const statement of statements) {
    const detected = detectOperationOfStatement(statement);
    if (detected !== null && !permissions.includes(detected.type)) {
      throw new Error(
        `❌ 操作被拒绝：当前权限不允许 ${detected.keyword} 操作。\n` +
        `需要的权限：${permissionLabel(detected.type)}\n` +
        `当前权限：${permissions.join(', ')}\n` +
        `如需更多权限，请使用 --permission-mode 或 --permissions 参数。`
      );
    }
  }
}

function permissionLabel(type: Exclude<PermissionType, 'read'>): string {
  const labels: Record<string, string> = {
    insert: '插入(insert)',
    update: '更新(update)',
    delete: '删除(delete)',
    ddl: 'DDL(ddl)',
  };
  return labels[type] ?? type;
}

/**
 * 验证查询是否允许执行
 * @param query - 待执行的查询
 * @param configOrAllowWrite - DbConfig 对象或 allowWrite 布尔值（向后兼容）
 * @throws 如果查询被拒绝，抛出带有中文提示的错误
 */
export function validateQuery(query: string, configOrAllowWrite: DbConfig | boolean): void {
  // 向后兼容：支持旧的 boolean 参数
  if (typeof configOrAllowWrite === 'boolean') {
    validateSql(query, configOrAllowWrite ? [...PERMISSION_PRESETS.full] : [...PERMISSION_PRESETS.safe]);
    return;
  }

  const config = configOrAllowWrite;
  const dbType = (config.type || '').toLowerCase();
  const permissions = resolvePermissions(config);

  // Redis 不是 SQL，走命令权限策略
  if (dbType === 'redis') {
    const decision = decideRedisCommand(query, permissions);
    if (!decision.allowed) {
      throw new Error(decision.reason ?? '❌ 操作被拒绝：Redis 命令不允许执行。');
    }
    return;
  }

  // MongoDB 为文档操作（非 SQL），按操作类型逐条校验权限（P0-3）。
  if (dbType === 'mongodb') {
    const decision = decideMongoQuery(query, permissions);
    if (!decision.allowed) {
      throw new Error(decision.reason ?? '❌ 操作被拒绝：MongoDB 操作不允许执行。');
    }
    return;
  }

  validateSql(query, permissions, dbType);
}

/**
 * 获取查询中的危险关键字（用于日志记录）
 * @param query - SQL 查询语句
 * @returns 找到的危险关键字数组
 */
export function getDangerousKeywords(query: string): string[] {
  const upperQuery = query.trim().toUpperCase();
  const allKeywords = Object.values(OPERATION_KEYWORDS).flat();
  return allKeywords.filter(keyword => upperQuery.includes(keyword));
}

/**
 * 格式化权限列表用于显示
 */
export function formatPermissions(permissions: PermissionType[]): string {
  const labels: Record<PermissionType, string> = {
    read: '读取',
    insert: '插入',
    update: '更新',
    delete: '删除',
    ddl: 'DDL',
  };
  return permissions.map(p => `${labels[p]}(${p})`).join(', ');
}
