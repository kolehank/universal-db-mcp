/**
 * 数据源注册表（Datasource Registry）
 *
 * 服务端预注册数据源 + key→源白名单 + 服务端权威权限（规格 datasource-acl.md §3/§4）。
 * - 类型（PermissionLevel / DatasourceDef / ApiKeyDef / DatasourceRegistryConfig）只在本模块定义。
 * - loadDatasourceRegistry(configPath)：读 JSON → ${ENV:VAR} 展开 → §3.3 全部校验（一次性列出所有错误）。
 * - resolveEffectivePermission：§4.1 min(sourceMax ?? safe, keyMax ?? full)。
 * - decideAccess：§4.2 决策表。
 * - 查找/展开后的明文 host/port/user/password 保留在实例内（resolveSource），
 *   对外只读访问器不导出密文，listSources() 仅返回 name/type/description。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizeDbType } from '../utils/adapter-factory.js';

/** 权限级别：safe < readwrite < full */
export type PermissionLevel = 'safe' | 'readwrite' | 'full';

/** 数据源定义（含连接参数；password 为明文，仅存于注册表实例内部） */
export interface DatasourceDef {
  name: string;
  description?: string;
  type: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  filePath?: string;
  authSource?: string;
  oracleClientPath?: string;
  /** 缺省视为 'safe' */
  maxPermission?: PermissionLevel;
}

/** API Key 定义：allowedSources 仅引用顶层 sources[].name，不含任何连接信息 */
export interface ApiKeyDef {
  key: string;
  name: string;
  allowedSources: string[];
  /** 只能把 source 上限再压低；缺省视为 'full' */
  maxPermission?: PermissionLevel;
}

/** 注册表 JSON 顶层形状（$schemaVersion 恒为 1，加载时校验） */
export interface DatasourceRegistryConfig {
  $schemaVersion: 1;
  allowAdhocConnections?: boolean;
  adhocTargetAllowlist?: string[];
  apiKeys: ApiKeyDef[];
  sources: DatasourceDef[];
}

/** 合法权限值集合 */
export const PERMISSION_LEVELS: readonly PermissionLevel[] = ['safe', 'readwrite', 'full'];

/** 源名校验正则（§3.3 规则 2） */
export const SOURCE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** ${ENV:VAR} 引用模式 */
const ENV_REF_PATTERN = /\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}/g;

function rank(p: PermissionLevel): number {
  // 序：safe(0) < readwrite(1) < full(2)
  if (p === 'safe') {
    return 0;
  }
  if (p === 'readwrite') {
    return 1;
  }
  return 2;
}

/** 取两个权限中更严格的一个（min，序：safe < readwrite < full） */
export function minPermission(a: PermissionLevel, b: PermissionLevel): PermissionLevel {
  return rank(a) <= rank(b) ? a : b;
}

/**
 * §4.1 生效权限算法：
 * sourceMax = SOURCE.maxPermission ?? 'safe'
 * keyMax    = KEY.maxPermission    ?? 'full'
 * effective = min(sourceMax, keyMax)
 * key 可省略（stdio 无 key 时取 sourceMax）。
 */
export function resolveEffectivePermission(
  source?: Pick<DatasourceDef, 'maxPermission'> | null,
  key?: Pick<ApiKeyDef, 'maxPermission'> | null
): PermissionLevel {
  const sourceMax: PermissionLevel = source?.maxPermission ?? 'safe';
  const keyMax: PermissionLevel = key?.maxPermission ?? 'full';
  return minPermission(sourceMax, keyMax);
}

/** keyFingerprint：sha256(key) 前 12 位，禁止记录明文 key */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key, 'utf-8').digest('hex').slice(0, 12);
}

function hasValue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

function hostOf(target: string): string | undefined {
  const idx = target.lastIndexOf(':');
  if (idx <= 0 || idx === target.length - 1) {
    return undefined;
  }
  return target.slice(0, idx);
}

function portOf(target: string): string | undefined {
  const idx = target.lastIndexOf(':');
  if (idx <= 0 || idx === target.length - 1) {
    return undefined;
  }
  return target.slice(idx + 1);
}

/**
 * host:port 精确匹配，host 大小写不敏感（§4.2 / §3.3 规则 7）。
 * 白名单为空 → 恒 false（"空白名单=不限制"由 decideAccess 在更高层处理）。
 */
export function isAdhocAllowed(target: string, allowlist: string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) {
    return false;
  }
  const targetHost = hostOf(target);
  const targetPort = portOf(target);
  if (targetHost === undefined || targetPort === undefined) {
    return false;
  }
  const targetHostLower = targetHost.toLowerCase();
  return allowlist.some(entry => {
    const h = hostOf(entry);
    const p = portOf(entry);
    return h !== undefined && p !== undefined && h.toLowerCase() === targetHostLower && p === targetPort;
  });
}

/** 仅接受 host:port 精确匹配；拒绝 CIDR/通配符/空白/非法端口 */
function isValidAllowlistEntry(entry: string): boolean {
  if (entry.includes('/') || entry.includes('*')) {
    return false;
  }
  const host = hostOf(entry);
  const port = portOf(entry);
  if (host === undefined || port === undefined || host.trim().length === 0) {
    return false;
  }
  if (/\s/.test(entry)) {
    return false;
  }
  if (!/^\d+$/.test(port)) {
    return false;
  }
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    return false;
  }
  return true;
}

/** ${ENV:VAR} 展开单个字符串；引用的环境变量不存在 → 收集错误（不允许静默空串） */
function expandEnvInString(value: string, errors: string[], path: string): string {
  return value.replace(ENV_REF_PATTERN, (match, varName: string) => {
    const v = process.env[varName];
    if (v === undefined) {
      errors.push(`${path}: 引用的环境变量 ${varName} 不存在（${match}）`);
      return match;
    }
    return v;
  });
}

/** 递归展开任意 JSON 值中的所有字符串（${ENV:VAR} 可出现在任意字符串值中） */
function expandEnvInValue(value: unknown, errors: string[], path: string): unknown {
  if (typeof value === 'string') {
    return expandEnvInString(value, errors, path);
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => expandEnvInValue(v, errors, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvInValue(v, errors, `${path}.${k}`);
    }
    return out;
  }
  return value;
}

function validateSource(raw: unknown, index: number, names: string[], errors: string[]): void {
  const path = `sources[${index}]`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${path}: 源定义必须是 JSON 对象`);
    return;
  }
  const s = raw as Record<string, unknown>;
  const name = s.name;

  if (typeof name !== 'string' || name.length === 0) {
    errors.push(`${path}.name: 缺少非空 name`);
  } else if (!SOURCE_NAME_PATTERN.test(name)) {
    errors.push(`${path}.name: "${name}" 不符合 ^[a-z0-9][a-z0-9_-]{0,63}$`);
  }
  if (typeof name === 'string' && name.length > 0 && names.includes(name)) {
    errors.push(`${path}.name: 重复的源名 "${name}"`);
  }
  if (typeof name === 'string' && name.length > 0 && !names.includes(name)) {
    names.push(name);
  }

  const type = s.type;
  if (typeof type !== 'string' || type.length === 0) {
    errors.push(`${path}.type: 缺少非空 type`);
  }

  if (s.maxPermission !== undefined && s.maxPermission !== null) {
    if (typeof s.maxPermission !== 'string' || !(PERMISSION_LEVELS as readonly string[]).includes(s.maxPermission)) {
      errors.push(`${path}.maxPermission: 非法值 ${JSON.stringify(s.maxPermission)}，必须是 safe|readwrite|full`);
    }
  }

  // sqlite 专用规则：必须有 filePath，且不得有 host/port
  let canonicalType: string | undefined;
  if (typeof type === 'string' && type.length > 0) {
    try {
      canonicalType = normalizeDbType(type);
    } catch {
      // type 非法（normalizeDbType 抛错）在此上报
      errors.push(`${path}.type: 不支持的数据库类型 "${type}"`);
    }
  }
  if (canonicalType === 'sqlite') {
    if (!hasValue(s.filePath)) {
      errors.push(`${path}.filePath: sqlite 源必须指定 filePath`);
    }
    if (hasValue(s.host)) {
      errors.push(`${path}.host: sqlite 源不得包含 host`);
    }
    if (hasValue(s.port)) {
      errors.push(`${path}.port: sqlite 源不得包含 port`);
    }
  }
}

function validateKey(
  raw: unknown,
  index: number,
  sourceNames: string[],
  keyValues: string[],
  keyNames: string[],
  errors: string[]
): void {
  const path = `apiKeys[${index}]`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${path}: key 定义必须是 JSON 对象`);
    return;
  }
  const k = raw as Record<string, unknown>;

  if (typeof k.key !== 'string' || k.key.length === 0) {
    errors.push(`${path}.key: 缺少非空 key`);
  } else if (keyValues.includes(k.key)) {
    errors.push(`${path}.key: 重复的 key`);
  } else {
    keyValues.push(k.key);
  }

  if (typeof k.name !== 'string' || k.name.length === 0) {
    errors.push(`${path}.name: 缺少非空 name（审计主体）`);
  } else if (keyNames.includes(k.name)) {
    errors.push(`${path}.name: 重复的 key 名 "${k.name}"`);
  } else {
    keyNames.push(k.name);
  }

  if (k.maxPermission !== undefined && k.maxPermission !== null) {
    if (typeof k.maxPermission !== 'string' || !(PERMISSION_LEVELS as readonly string[]).includes(k.maxPermission)) {
      errors.push(`${path}.maxPermission: 非法值 ${JSON.stringify(k.maxPermission)}，必须是 safe|readwrite|full`);
    }
  }

  // allowedSources：空数组或缺省 = 该 key 不能访问任何注册源（合法）；悬挂引用 / "*" 报错
  if (k.allowedSources === undefined || k.allowedSources === null) {
    return;
  }
  if (!Array.isArray(k.allowedSources)) {
    errors.push(`${path}.allowedSources: 必须是字符串数组`);
    return;
  }
  k.allowedSources.forEach((ref, j) => {
    const refPath = `${path}.allowedSources[${j}]`;
    if (typeof ref !== 'string') {
      errors.push(`${refPath}: 必须是字符串`);
      return;
    }
    if (ref === '*') {
      errors.push(`${refPath}: 禁止通配符 "*"`);
      return;
    }
    if (!sourceNames.includes(ref)) {
      errors.push(`${refPath}: 悬挂引用 "${ref}"（不在 sources 中）`);
    }
  });
}

/** 展开 + 校验注册表原始 JSON，收集全部错误；有错则返回 null */
function expandAndValidate(raw: unknown): { config: DatasourceRegistryConfig | null; errors: string[] } {
  const errors: string[] = [];
  const expanded = expandEnvInValue(raw, errors, '(registry)');

  if (expanded === null || typeof expanded !== 'object' || Array.isArray(expanded)) {
    errors.push('注册表根节点必须是 JSON 对象');
    return { config: null, errors };
  }
  const root = expanded as Record<string, unknown>;

  if (root.$schemaVersion !== 1) {
    errors.push(`$schemaVersion 必须为 1，实际为 ${JSON.stringify(root.$schemaVersion)}`);
  }
  if (root.allowAdhocConnections !== undefined && root.allowAdhocConnections !== null) {
    if (typeof root.allowAdhocConnections !== 'boolean') {
      errors.push('allowAdhocConnections 必须是布尔值');
    }
  }

  const sourceNames: string[] = [];
  if (root.sources === undefined) {
    errors.push('缺少 sources 字段');
  } else if (!Array.isArray(root.sources)) {
    errors.push('sources 必须是数组');
  } else {
    root.sources.forEach((s, i) => validateSource(s, i, sourceNames, errors));
  }

  const keyValues: string[] = [];
  const keyNames: string[] = [];
  if (root.apiKeys === undefined) {
    errors.push('缺少 apiKeys 字段');
  } else if (!Array.isArray(root.apiKeys)) {
    errors.push('apiKeys 必须是数组');
  } else {
    root.apiKeys.forEach((k, i) => validateKey(k, i, sourceNames, keyValues, keyNames, errors));
  }

  if (root.adhocTargetAllowlist !== undefined && root.adhocTargetAllowlist !== null) {
    if (!Array.isArray(root.adhocTargetAllowlist)) {
      errors.push('adhocTargetAllowlist 必须是数组');
    } else {
      root.adhocTargetAllowlist.forEach((entry, i) => {
        if (typeof entry !== 'string' || !isValidAllowlistEntry(entry)) {
          errors.push(
            `adhocTargetAllowlist[${i}]: 非法条目 ${JSON.stringify(entry)}，仅接受 host:port 精确匹配（不支持 CIDR/通配符）`
          );
        }
      });
    }
  }

  if (errors.length > 0) {
    return { config: null, errors };
  }

  const config: DatasourceRegistryConfig = {
    $schemaVersion: 1,
    allowAdhocConnections: root.allowAdhocConnections === true,
    adhocTargetAllowlist: Array.isArray(root.adhocTargetAllowlist) ? (root.adhocTargetAllowlist as string[]) : [],
    apiKeys: root.apiKeys as ApiKeyDef[],
    sources: root.sources as DatasourceDef[],
  };
  return { config, errors };
}

/**
 * 从已解析的原始 JSON 构建注册表（校验不过 → 一次性抛出所有错误，逐行列出）。
 * 供 loadDatasourceRegistry 与测试/热重载使用。
 */
export function buildRegistryFromRaw(raw: unknown, sourceLabel: string): DatasourceRegistry {
  const { config, errors } = expandAndValidate(raw);
  if (config === null) {
    throw new Error(`数据源注册表校验失败（${sourceLabel}）:\n${errors.join('\n')}`);
  }
  return new DatasourceRegistry(config, sourceLabel);
}

/**
 * 加载注册表：读 JSON → ${ENV:VAR} 展开 → §3.3 全部 8 条校验。
 * 任一校验失败即失败，错误一次性列出（Error message 逐行）。
 */
export function loadDatasourceRegistry(configPath: string): DatasourceRegistry {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取数据源注册表文件 ${configPath}: ${detail}`);
  }
  return buildRegistryFromRaw(raw, configPath);
}

/** ACL 拒绝码（§6 错误码中的 ACL 相关部分） */
export type AccessDenyCode =
  | 'ADHOC_DISABLED'
  | 'ADHOC_TARGET_DENIED'
  | 'SOURCE_NOT_FOUND'
  | 'INVALID_REQUEST';

/** §4.2 决策结果 */
export type AccessDecision = { decision: 'allow' } | { decision: 'deny'; code: AccessDenyCode };

/** decideAccess 入参（由各通道 handler 将请求规整后传入） */
export interface DecideAccessParams {
  /** 请求携带的 source 名（未带为 undefined；SOURCE_NOT_FOUND 同时覆盖"未知源"与"key 无权"） */
  source?: string;
  /** 注册表模式下已解析出的 key（legacy 模式无注册表，为 undefined） */
  key?: Pick<ApiKeyDef, 'allowedSources'> | null;
  /** 注册表模式是否生效（有 DATASOURCE_CONFIG） */
  registryEnabled: boolean;
  /** adhoc 是否开启（ALLOW_ADHOC_CONNECTIONS=true 或注册表 allowAdhocConnections=true） */
  adhocEnabled: boolean;
  /** adhoc 目标白名单（空数组 = 不限制，legacy 行为） */
  adhocTargetAllowlist?: string[];
  /** 请求是否携带 adhoc 连接参数（type/host/...） */
  hasAdhocParams: boolean;
  /** 请求携带的 adhoc 目标 host:port（用于白名单精确匹配） */
  adhocTarget?: string;
}

function deny(code: AccessDenyCode): AccessDecision {
  return { decision: 'deny', code };
}

/**
 * §4.2 决策表逐行实现：
 * 1. source 命中且 key 有权 → allow
 * 2/3. key 无权 或 未知 source → SOURCE_NOT_FOUND（不可区分）
 * 4. adhoc 字段 + adhoc 未开 → ADHOC_DISABLED
 * 5. adhoc 开 + 目标不在白名单 → ADHOC_TARGET_DENIED
 * 6. adhoc 开 +（白名单为空 或 命中）→ allow（legacy 行为）
 * 7. 无任何连接参数 → INVALID_REQUEST
 */
export function decideAccess(params: DecideAccessParams): AccessDecision {
  // 有 source 时忽略其余连接参数（§5.2/5.3/5.4）
  if (params.source !== undefined && params.source !== null && params.source !== '') {
    if (!params.registryEnabled) {
      return deny('SOURCE_NOT_FOUND');
    }
    const sources = params.key?.allowedSources;
    if (!sources || !sources.includes(params.source)) {
      return deny('SOURCE_NOT_FOUND');
    }
    return { decision: 'allow' };
  }

  // 未带任何连接参数
  if (!params.hasAdhocParams) {
    return deny('INVALID_REQUEST');
  }

  // adhoc 参数存在
  if (!params.adhocEnabled) {
    return deny('ADHOC_DISABLED');
  }

  const allowlist = params.adhocTargetAllowlist ?? [];
  if (allowlist.length === 0) {
    return { decision: 'allow' };
  }
  if (params.adhocTarget === undefined || params.adhocTarget === null || params.adhocTarget === '') {
    return deny('ADHOC_TARGET_DENIED');
  }
  if (isAdhocAllowed(params.adhocTarget, allowlist)) {
    return { decision: 'allow' };
  }
  return deny('ADHOC_TARGET_DENIED');
}

/**
 * 数据源注册表实例。
 * 密文（host/port/user/password、key）仅通过受控接口（resolveSource/findKey）在实例内读取，
 * 不可整体导出；listSources() 只返回 name/type/description。
 */
export class DatasourceRegistry {
  private readonly _sources: ReadonlyArray<DatasourceDef>;
  private readonly _apiKeys: ReadonlyArray<ApiKeyDef>;
  private readonly _configPath: string;
  private readonly _allowAdhocConnections: boolean;
  private readonly _adhocTargetAllowlist: ReadonlyArray<string>;
  private readonly sourceIndex: Map<string, DatasourceDef>;
  private readonly keyIndex: Map<string, ApiKeyDef>;
  private readonly fingerprintIndex: Map<string, ApiKeyDef>;

  constructor(config: DatasourceRegistryConfig, configPath: string) {
    this._configPath = configPath;
    this._sources = Object.freeze([...config.sources]);
    // §3.4 中 allowedSources 为非可选字段：缺省（undefined）归一化为空数组 = 不能访问任何注册源
    this._apiKeys = Object.freeze([...config.apiKeys].map(k => ({ ...k, allowedSources: k.allowedSources ?? [] })));
    this._allowAdhocConnections = config.allowAdhocConnections === true;
    this._adhocTargetAllowlist = Object.freeze([...(config.adhocTargetAllowlist ?? [])]);
    this.sourceIndex = new Map(config.sources.map(s => [s.name, s]));
    this.keyIndex = new Map();
    this.fingerprintIndex = new Map();
    for (const k of this._apiKeys) {
      this.keyIndex.set(k.key, k);
      this.fingerprintIndex.set(keyFingerprint(k.key), k);
    }
  }

  /** 只读访问器：源码定义（含明文连接参数，供服务端内部连接使用） */
  get sources(): ReadonlyArray<DatasourceDef> {
    return this._sources;
  }

  /** 只读访问器：key 定义 */
  get apiKeys(): ReadonlyArray<ApiKeyDef> {
    return this._apiKeys;
  }

  /** 注册表文件路径 */
  get configPath(): string {
    return this._configPath;
  }

  /** 注册表 allowAdhocConnections（§3.1：env ALLOW_ADHOC_CONNECTIONS=true 时覆盖此值） */
  get allowAdhocConnections(): boolean {
    return this._allowAdhocConnections;
  }

  /** adhoc 出站目标白名单 */
  get adhocTargetAllowlist(): ReadonlyArray<string> {
    return this._adhocTargetAllowlist;
  }

  /** 对外安全列表：仅 name/type/description，不含 host/port/user/password */
  listSources(): Array<{ name: string; type: string; description?: string }> {
    return this._sources.map(s => ({
      name: s.name,
      type: s.type,
      ...(s.description !== undefined ? { description: s.description } : {}),
    }));
  }

  /** 按名解析完整源定义（含明文连接参数，服务端内部使用；不存在返回 undefined） */
  resolveSource(name: string): DatasourceDef | undefined {
    return this.sourceIndex.get(name);
  }

  /** 按明文 key 查找（受控接口，供 auth/审计主体验证使用） */
  findKey(key: string): ApiKeyDef | undefined {
    return this.keyIndex.get(key);
  }

  /** 按 keyFingerprint 查找（从不落审计日志的明文 key 反查，供吊销判定等） */
  getKeyByFingerprint(fingerprint: string): ApiKeyDef | undefined {
    return this.fingerprintIndex.get(fingerprint);
  }

  /** 指定源 + key 的生效权限（§4.1） */
  effectivePermission(name: string, key?: Pick<ApiKeyDef, 'maxPermission'> | null): PermissionLevel {
    return resolveEffectivePermission(this.sourceIndex.get(name), key);
  }

  /**
   * §7.1 SIGHUP 热加载：重新读取并校验注册表文件，返回**新实例**（调用方原子替换引用）。
   * - 与启动同一套 buildRegistryFromRaw 校验管线（JSON 读取 → ${ENV:} 重新展开 → §3.3 全部校验）；
   * - 任一错误 → 抛错（一次性列出），本实例原样保留、调用方保留旧配置，进程不退出；
   * - 返回全新实例；已建会话（Session / sessionMeta）存的是连接时的解析结果，天然是旧配置快照。
   */
  reload(configPath?: string): DatasourceRegistry {
    return loadDatasourceRegistry(configPath ?? this._configPath);
  }
}

/**
 * 可变注册表引用承载（评审裁决 9 的最小实现，P5）。
 * auth/routes 经 createRegistryView 读取 holder.current 获取「当前实例」；
 * SIGHUP 重载成功后原子执行 holder.current = newRegistry，后续请求即读到新配置，
 * 已建会话持旧实例（快照语义自动成立）。
 */
export interface RegistryHolder {
  current: DatasourceRegistry;
}

/**
 * 构造一个「实时委托视图」（评审裁决 9）：
 * 视图是 DatasourceRegistry 的形状（getter + 方法全部委托 holder.current），
 * 注入 auth/routes 后，每次请求读到的是当前实例——重载替换 holder.current 即对新请求生效。
 * 因 mcp-sse/middleware 在 setup 时捕获 registry 引用，直接用实例无法实现热替换，
 * 用视图规避对只读文件（mcp-sse.ts）的改动；旧实例本身不可变，视图只做转发。
 */
export function createRegistryView(holder: RegistryHolder): DatasourceRegistry {
  const view: { [key: string]: unknown } = {};
  Object.defineProperties(view, {
    sources: { get: () => holder.current.sources, enumerable: true },
    apiKeys: { get: () => holder.current.apiKeys, enumerable: true },
    configPath: { get: () => holder.current.configPath, enumerable: true },
    allowAdhocConnections: { get: () => holder.current.allowAdhocConnections, enumerable: true },
    adhocTargetAllowlist: { get: () => holder.current.adhocTargetAllowlist, enumerable: true },
  });
  Object.assign(view, {
    listSources: () => holder.current.listSources(),
    resolveSource: (name: string) => holder.current.resolveSource(name),
    findKey: (key: string) => holder.current.findKey(key),
    getKeyByFingerprint: (fingerprint: string) => holder.current.getKeyByFingerprint(fingerprint),
    effectivePermission: (name: string, key?: Pick<ApiKeyDef, 'maxPermission'> | null) =>
      holder.current.effectivePermission(name, key),
    reload: (configPath?: string) => holder.current.reload(configPath),
  });
  return view as unknown as DatasourceRegistry;
}
