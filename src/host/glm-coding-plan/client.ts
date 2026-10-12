/**
 * GLM（ZCode 账号）线路的上游 I/O：模型目录、配额、订阅列表，外加凭据验活的转出。
 *
 * 本文件有两条互相矛盾、且**不可互相抄**的认证规则，写错任何一处都会得到一个看似合理的
 * 401/鉴权失败，所以它们各自写在自己的函数上方：
 *
 * 1. **模型面**（目录拉取、Anthropic 面、OpenAI 面）用 `Authorization: Bearer {id.secret}`，
 *    Anthropic 面还要**成对**发 `x-api-key`。这两个请求头函数直接委托给
 *    `./mapper-anthropic.ts` 与 `./mapper-openai.ts` 的实现——它们才是发请求的路径，
 *    在这里另写一份就等于给「认证头」留下第二处可以漂移的真相。
 * 2. **配额 / 订阅面**用**裸 Key**，`authorization: <id>.<secret>`，**不加 `Bearer` 前缀**
 *    （逐字证据：`docs/bigmodel-coding-plan-usage-quota.md`，计划 §3.4；官方文档写明
 *    加了 Bearer 会鉴权失败）。`test/glm-coding-plan-client.test.ts` 对此有回归断言。
 *
 * 配额解析的语义照 dsh-web 仓库 `packages/dsh-usage/src/core/adapters.ts` 的 `glmPlan()`
 * 对齐（只读参考，没有复制代码），三条要点都是逐条照抄它的行为：
 *
 * - 上层信封要求 `success === true`，否则不解析；
 * - `TIME_LIMIT` 是 MCP 请求上限，**不是套餐窗口**，跳过；
 * - `unit` 用 `./types.ts` 的 `QUOTA_UNIT_WINDOW` 映射，**未知 unit 一律丢弃**，不发明窗口；
 * - `TOKENS_LIMIT` 的比例取 `percentage`，`CREDIT_LIMIT` 取 `currentValue / usage` 的比例
 *   （两者都不成比例时才退回 `percentage`）。
 */

import type {
  GlmQuotaSnapshotDto,
  GlmQuotaWindow,
  GlmQuotaWindowKey,
  GlmRegion,
} from '../../shared/glm-coding-plan-contracts.ts'
import { quotaResetMs } from '../common/account-quota.ts'
import {
  CATALOG_CACHE_TTL_MS,
  DISCOVERY_TIMEOUT_MS,
  PROVIDER_NAME,
  QUOTA_CACHE_TTL_MS,
  QUOTA_PATH,
  QUOTA_PLAN_LEVELS,
  QUOTA_ROW_TYPE,
  QUOTA_UNIT_WINDOW,
  SUBSCRIPTION_PATH,
  USER_AGENT,
  businessHost,
} from './types.ts'
import { glmAnthropicHeaders } from './mapper-anthropic.ts'
import { glmOpenAiHeaders, modelsUrl } from './mapper-openai.ts'
import { verifyCodingPlanKey } from './exchange.ts'
import {
  GLM_MODEL_CATALOG,
  catalogSize,
  isGlmModelId,
  listModelIds,
  modelsForRegion,
  resolveGlmModel,
  undeclaredGlmModelEntry,
  type GlmModelEntry,
} from './model-catalog.ts'

export { listModelIds, catalogSize, modelsForRegion, isGlmModelId, verifyCodingPlanKey }
export type { GlmPlanProbe } from './exchange.ts'

/** 一次上游读的可调项。`fetchFn` / `signal` 供测试注入，`env` 让 `DSH_GLM_*` 覆盖在调用时生效。 */
export interface GlmRequestOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  /** 单次请求超时；缺省走 `DISCOVERY_TIMEOUT_MS`。 */
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * 读一个有限数字（数字或可解析的字符串）。
 *
 * 与参考实现 `toNum()` 同语义：上游把 `unit` / `percentage` 之类的字段写成字符串是见过的，
 * 直接按数字读会漏掉一整类真实响应。
 */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** 读一个非空字符串。 */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 把比例夹进可渲染的 0-100 区间（照参考实现的 `clampPercent`）。 */
function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** 一句可以直接展示给用户的失败原因；正文只截前 200 字，且不含任何请求头。 */
function failure(detail: string): string {
  return PROVIDER_NAME + ' ' + detail
}

/** 响应正文的一句话摘要（去换行、截断），用于把上游原因带给调用方。 */
function summarize(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200)
}

// ---------------------------------------------------------------------------
// 请求头（三个面，三套规则）
// ---------------------------------------------------------------------------

/**
 * Anthropic 面的请求头（双头：`x-api-key` + `Authorization: Bearer`，同值）。
 *
 * **委托**给 `./mapper-anthropic.ts` 的 `glmAnthropicHeaders`，本文件不复制第二份。
 * 目录拉取与探活都会用它，认证规则只有一处真相。
 */
export function glmAnthropicProbeHeaders(codingPlanKey: string): Record<string, string> {
  return glmAnthropicHeaders(codingPlanKey, { accept: 'application/json' })
}

/**
 * OpenAI 兼容面的请求头（只有 `Authorization: Bearer`，**没有** `x-api-key`）。
 *
 * **委托**给 `./mapper-openai.ts` 的 `glmOpenAiHeaders`：双头是 Anthropic 面的性质，
 * 这里多发一个头不会更好，只会让复审误以为两面共用一套认证。
 */
export function glmOpenAiProbeHeaders(codingPlanKey: string): Record<string, string> {
  return glmOpenAiHeaders(codingPlanKey)
}

/**
 * 配额 / 订阅面的请求头：**裸 Key，不加 `Bearer`**。
 *
 * 逐字证据：`docs/bigmodel-coding-plan-usage-quota.md`（计划 §3.4）——加了 Bearer 前缀会鉴权失败。
 * 这与模型面正好相反，所以这里没有任何「兼容两种写法」的分支：
 * 那种写法在上游表现为一次必然失败的请求，而失败原因（401）不会告诉你前缀多写了。
 *
 * @param codingPlanKey - 兑换链拼出的 `{apiKeyId}.{secretKey}`。空白即抛错，不发一个注定被拒的请求。
 */
export function quotaRequestHeaders(codingPlanKey: string): Record<string, string> {
  const key = codingPlanKey.trim()
  if (key === '') {
    throw new Error(failure('的配额接口需要一把 Coding Plan Key（裸值，不加 Bearer）；空凭据不会变成一个能通过鉴权的请求。'))
  }
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    // 裸 Key。禁止在这里拼 'Bearer '——见本函数注释。
    authorization: key,
    'user-agent': USER_AGENT,
    'accept-language': 'en-US,en',
  }
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/**
 * 配额 URL：`{business}{QUOTA_PATH}`。
 *
 * 走**业务面** host（国区 `bigmodel.cn` / 国际区 `api.z.ai`）而不是模型面：
 * `./types.ts` 的 `businessHost()` 就是这条路的唯一出处。
 *
 * **未验证**：官方文档写「区域 host `https://api.z.ai` 或 `https://bigmodel.cn`，
 * 国区亦可用 `open.bigmodel.cn`」，国区到底哪个是规范入口没有实测样本（计划 D9：无实机账号）。
 * 本文件取 `businessHost()`，需要指向另一个部署时用 `DSH_GLM_*_BUSINESS_HOST` 覆盖。
 */
export function quotaUrl(region: GlmRegion, env: NodeJS.ProcessEnv = process.env): string {
  return businessHost(region, env) + QUOTA_PATH
}

/** 订阅列表 URL：`{business}{SUBSCRIPTION_PATH}`（套餐名 / 续费时刻）。 */
export function subscriptionUrl(region: GlmRegion, env: NodeJS.ProcessEnv = process.env): string {
  return businessHost(region, env) + SUBSCRIPTION_PATH
}

export { modelsUrl, QUOTA_PATH, SUBSCRIPTION_PATH }

// ---------------------------------------------------------------------------
// 模型目录
// ---------------------------------------------------------------------------

/**
 * 解析 `/api/coding/paas/v4/models` 的响应。
 *
 * 与随包目录合并的规则（照历史实现 `7e40fce:src/host/zhipu/client.ts` 的 `parseCatalogModels`）：
 * **目录里的能力声明永远是权威，实时列表只补它明确给出的那一个字段**——上下文窗口。
 * 梯子、收不收图、可不可关思考、协议面这四项实时列表都不公布（**未验证**：没有样本证明它会公布），
 * 让它们被列表的沉默改写成「猜」就是本文件存在的反面。
 *
 * **未验证**：列表的字段名。历史实现读 `context_window` / `contextWindow` /
 * `max_input_tokens`，本文件连 `context_length` 一起认；真实响应样本缺一份，
 * 上游若换了字段名，表现是「退回随包目录的窗口值」而不是崩溃。
 */
export function parseCatalogListing(payload: unknown, region: GlmRegion): GlmModelEntry[] {
  const root = asRecord(payload)
  const list = Array.isArray(root?.['data'])
    ? root['data'] as unknown[]
    : Array.isArray(root?.['models'])
      ? root['models'] as unknown[]
      : Array.isArray(payload) ? payload : []
  const entries: GlmModelEntry[] = []
  for (const item of list) {
    const record = asRecord(item)
    if (record === undefined) continue
    const id = asText(record['id']) ?? asText(record['model'])
    if (id === undefined) continue
    const window = asNumber(record['context_window'])
      ?? asNumber(record['contextWindow'])
      ?? asNumber(record['context_length'])
      ?? asNumber(record['max_input_tokens'])
    const contextWindow = typeof window === 'number' && window > 0 ? Math.round(window) : undefined
    // 列表是按部署分区的：它返回的每个 id 都是这个部署在服务的，所以区域一定包含本次查询的部署。
    if (!isGlmModelId(id)) {
      entries.push(undeclaredGlmModelEntry(id, {
        region,
        ...(contextWindow === undefined ? {} : { contextWindow }),
      }))
      continue
    }
    const known = resolveGlmModel(id)
    entries.push({
      ...known,
      regions: known.regions.includes(region) ? known.regions : [...known.regions, region],
      ...(contextWindow === undefined ? {} : { defaultContextWindow: contextWindow }),
    })
  }
  return entries
}

/**
 * 拉一次模型目录。
 *
 * 失败**抛错**而不是静默返回空列表：调用方（连接测试）需要知道「没读到」，
 * 而 {@link loadCatalog} 才是那个负责回落随包目录的函数。
 */
export async function fetchCatalog(
  region: GlmRegion,
  codingPlanKey: string,
  options: GlmRequestOptions = {},
): Promise<GlmModelEntry[]> {
  const fetchFn = options.fetchFn ?? fetch
  const url = modelsUrl(region, options.env ?? process.env)
  const response = await fetchFn(url, {
    method: 'GET',
    headers: glmOpenAiProbeHeaders(codingPlanKey),
    signal: withTimeout(options.signal, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    const detail = summarize(text)
    throw new Error(
      failure('读取模型目录失败（HTTP ' + response.status + '）: ' + url)
      + (detail === '' ? '' : '：' + detail),
    )
  }
  let payload: unknown
  try {
    payload = JSON.parse(text) as unknown
  } catch {
    throw new Error(failure('返回的模型目录不是可读的 JSON：' + url))
  }
  return parseCatalogListing(payload, region)
}

interface CatalogSnapshot {
  region: GlmRegion
  models: GlmModelEntry[]
  fetchedAt: number
}

let cachedCatalog: CatalogSnapshot | undefined
const catalogInFlight = new Map<GlmRegion, Promise<GlmModelEntry[]>>()

/** 最近一次成功读到的目录；只读缓存，不发请求。 */
export function getCachedCatalog(region?: GlmRegion): GlmModelEntry[] {
  if (region === undefined || cachedCatalog?.region === region) return cachedCatalog?.models ?? []
  return []
}

/** 忘记目录缓存（登录、登出、测试）。 */
export function clearCachedCatalog(): void {
  cachedCatalog = undefined
  catalogInFlight.clear()
}

/**
 * 带 TTL 的目录读，失败时保留上一份快照、再失败则回落到随包目录。
 *
 * 回落链是有顺序的：**同区域的旧快照** → **随包目录（按区域过滤）**。
 * 绝不让另一区域的快照顶替——它的行只声明了来处那个区域，落到调用方的区域过滤上会一行不剩，
 * 结果是「模型选择器空了」而不是「退回随包目录」。
 */
export async function loadCatalog(
  region: GlmRegion,
  codingPlanKey: string,
  options: GlmRequestOptions & { force?: boolean } = {},
): Promise<GlmModelEntry[]> {
  if (options.force !== true
    && cachedCatalog !== undefined
    && cachedCatalog.region === region
    && Date.now() - cachedCatalog.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return cachedCatalog.models
  }
  const inFlight = catalogInFlight.get(region)
  if (inFlight !== undefined) return inFlight
  const fallback = (): GlmModelEntry[] => getCachedCatalog(region).length > 0
    ? getCachedCatalog(region)
    : modelsForRegion(region, GLM_MODEL_CATALOG)
  const request = fetchCatalog(region, codingPlanKey, options)
    .then((models) => {
      if (models.length > 0) {
        cachedCatalog = { region, models, fetchedAt: Date.now() }
        return models
      }
      return fallback()
    })
    .catch(() => fallback())
  catalogInFlight.set(region, request)
  try {
    return await request
  } finally {
    if (catalogInFlight.get(region) === request) catalogInFlight.delete(region)
  }
}

// ---------------------------------------------------------------------------
// 配额
// ---------------------------------------------------------------------------

/** 上游 `limits` 数组里的一行（只保留本线路要用的字段）。 */
export interface GlmQuotaLimitRow {
  type: string
  unit: number | undefined
  percentage: number | undefined
  currentValue: number | undefined
  usage: number | undefined
  /** 重置时刻（Unix 毫秒）；上游没给或给了非正值时为 null。 */
  resetsAt: number | null
}

/**
 * 把 `data.limits` 读成结构化行。
 *
 * 这里**只做搬运不做筛选**：`TIME_LIMIT` 与未知 `unit` 的丢弃发生在
 * {@link parseQuotaSnapshot} 里，留在同一处才能一眼看清「哪些行被丢掉、为什么」。
 *
 * **未验证**：字段名。字段取自历史实现与 dsh-usage 的 `glmPlan()`（`unit` / `type` /
 * `percentage` / `currentValue` / `usage` / `nextResetTime`），没有一份真实响应样本。
 */
export function parseQuotaLimits(payload: unknown): GlmQuotaLimitRow[] {
  const data = asRecord(asRecord(payload)?.['data'])
  const list = data?.['limits']
  if (!Array.isArray(list)) return []
  const rows: GlmQuotaLimitRow[] = []
  for (const item of list) {
    const record = asRecord(item)
    if (record === undefined) continue
    const type = asText(record['type'])
    if (type === undefined) continue
    rows.push({
      type,
      unit: asNumber(record['unit']),
      percentage: asNumber(record['percentage']),
      currentValue: asNumber(record['currentValue']),
      usage: asNumber(record['usage']),
      resetsAt: quotaResetMs(asNumber(record['nextResetTime'])),
    })
  }
  return rows
}

/**
 * `unit` → 窗口标识；表里没有的编号返回 undefined（**丢弃，不发明**）。
 *
 * 编号不是升序的（月度是 5、周度是 6），所以逐条照 `./types.ts` 的 `QUOTA_UNIT_WINDOW`，
 * 不按大小猜。猜出来的那一行会在卡片上画出一条并不存在的额度条。
 */
function quotaWindowKeyFor(unit: number | undefined): GlmQuotaWindowKey | undefined {
  if (unit === undefined) return undefined
  return Object.prototype.hasOwnProperty.call(QUOTA_UNIT_WINDOW, unit)
    ? QUOTA_UNIT_WINDOW[unit]
    : undefined
}

/**
 * 一行配额对应的已用百分比；算不出来时 undefined（**不是 0**）。
 *
 * `null` 与 `0` 是两种主张：null 是「上游没给出有界额度」，画成进度条等于谎报用量
 * （`./types.ts` 里给 W6 的装配规则第三条）。所以算不出来就交出 undefined，让调用方丢弃该窗口。
 */
function usedPercentOf(row: GlmQuotaLimitRow): number | undefined {
  if (row.type === QUOTA_ROW_TYPE.credit) {
    const used = row.currentValue
    const limit = row.usage
    if (used !== undefined && limit !== undefined && limit > 0) return clampPercent((used / limit) * 100)
  }
  return row.percentage === undefined ? undefined : clampPercent(row.percentage)
}

/** 解析配额快照时由调用方补上的东西（订阅列表读到的部分）。 */
export interface GlmQuotaParseOptions {
  /** 订阅列表给出的展示套餐名。 */
  planName?: string | null
  /** 订阅列表给出的续费时刻（Unix 毫秒）。 */
  renewsAt?: number | null
  /** 本次读取时刻（Unix 毫秒）。 */
  now?: number
  /** 实际应答的端点路径，供设置卡片诊断。 */
  sources?: readonly string[]
}

/**
 * 解析一次配额响应成 `GlmQuotaSnapshotDto`；不可解析时返回 null。
 *
 * 与参考实现 `glmPlan()` 一致的四条：
 *
 * 1. 上层信封必须 `success === true`，否则不解析（这个端点会用 HTTP 200 回一个业务失败）；
 * 2. `TIME_LIMIT` 是 MCP 请求上限，**不是套餐窗口**，跳过；
 * 3. `unit` 走封闭映射，**未知编号丢弃**；
 * 4. 剩下的行里 `TOKENS_LIMIT` 取 `percentage`、`CREDIT_LIMIT` 取 `currentValue/usage`。
 *
 * 另外两个本仓库自己的决定：
 *
 * - **同一个窗口键只保留第一行**。上游若给了两行 unit 3，画出来就是两条一模一样的额度条，
 *   而第二条可能是别的计量口径；宁可少画一条，也不把两种口径混成一条。
 * - **一个窗口都没有时返回 null**（参考实现同样把「无窗口」当成没有快照）。
 *   一份没有窗口的快照会在卡片上渲染成「什么都没消耗」，那比不显示更糟。
 */
export function parseQuotaSnapshot(
  payload: unknown,
  options: GlmQuotaParseOptions = {},
): GlmQuotaSnapshotDto | null {
  const root = asRecord(payload)
  if (root === undefined || root['success'] !== true) return null
  const data = asRecord(root['data'])
  if (data === undefined) return null
  const rows = parseQuotaLimits(payload)
  const windows: GlmQuotaWindow[] = []
  const seen = new Set<GlmQuotaWindowKey>()
  for (const row of rows) {
    if (row.type === QUOTA_ROW_TYPE.time) continue
    if (row.type !== QUOTA_ROW_TYPE.tokens && row.type !== QUOTA_ROW_TYPE.credit) continue
    const key = quotaWindowKeyFor(row.unit)
    if (key === undefined || seen.has(key)) continue
    seen.add(key)
    windows.push({
      key,
      usedPercent: usedPercentOf(row) ?? null,
      resetsAt: row.resetsAt,
    })
  }
  if (windows.length === 0) return null
  return {
    planName: options.planName ?? null,
    planLevel: asText(data['level']) ?? null,
    windows,
    renewsAt: options.renewsAt ?? null,
    fetchedAt: options.now ?? Date.now(),
    sources: options.sources === undefined ? [QUOTA_PATH] : [...options.sources],
    // 读到了配额快照只说明这把 Key 被认出来了，**不等于**账号有付费套餐：
    // 免费体验额度账号同样可能读得到。所以这里按 level 判定，认不出就是 unknown，
    // 绝不因为「读到快照」就报成 plan。
    allowance: isGlmPlanLevel(data['level']) ? 'plan' : 'unknown',
  }
}

/** `data.level` 是不是本线路认识的机器档位（lite / pro / max）。 */
export function isGlmPlanLevel(value: unknown): value is string {
  return typeof value === 'string' && (QUOTA_PLAN_LEVELS as readonly string[]).includes(value)
}

/** 订阅列表读到的套餐事实。 */
export interface GlmSubscriptionPlan {
  planName: string | null
  renewsAt: number | null
}

/**
 * 解析订阅列表 → 套餐名 / 续费时刻。
 *
 * **尽力而为**：读不到套餐名不影响配额窗口（它们来自另一个端点），
 * 所以本函数的任何不确定都只表现为 null，不会让整张配额卡片失败。
 *
 * **未验证**：字段名。读法取自历史实现（`planName` / `name` / `productName`、
 * `expireTime` / `expiredTime` / `renewTime`，`data` 可以是对象也可以是数组），
 * 没有一份真实响应样本；上游换字段名时表现为「卡片上没有套餐名」，而不是崩溃。
 */
export function parseSubscriptionPlan(payload: unknown): GlmSubscriptionPlan {
  const root = asRecord(payload)
  if (root === undefined || root['success'] === false) return { planName: null, renewsAt: null }
  const data = root['data']
  const records: Record<string, unknown>[] = []
  if (Array.isArray(data)) {
    for (const item of data) {
      const record = asRecord(item)
      if (record !== undefined) records.push(record)
    }
  } else {
    const single = asRecord(data) ?? root
    records.push(single)
  }
  let planName: string | null = null
  let renewsAt: number | null = null
  for (const record of records) {
    planName ??= asText(record['planName']) ?? asText(record['name']) ?? asText(record['productName']) ?? null
    if (renewsAt === null) {
      const raw = asNumber(record['expireTime']) ?? asNumber(record['expiredTime']) ?? asNumber(record['renewTime'])
      renewsAt = quotaResetMs(raw)
    }
  }
  return { planName, renewsAt }
}

// ---------------------------------------------------------------------------
// 配额缓存
// ---------------------------------------------------------------------------

/** 一次配额读的结果。失败以 `error` 呈现，不以异常呈现。 */
export interface GlmQuotaRead {
  snapshot: GlmQuotaSnapshotDto | null
  /** 面向用户的失败原因；成功时为 null。与 `GlmStatusDto.quotaError` 是同一个位置。 */
  error: string | null
  /** 这次是否直接命中缓存。 */
  fromCache: boolean
}

interface QuotaEntry {
  accountId: string | undefined
  at: number
  snapshot: GlmQuotaSnapshotDto | null
  error: string | null
}

/** 最多记住多少个账号的快照（与 minimax-code 同一条上界：进程不该按见过的 id 无限增长）。 */
const QUOTA_ACCOUNT_LIMIT = 20

let quotaSnapshot: QuotaEntry | null = null
const quotaByAccount = new Map<string, QuotaEntry>()
const quotaInFlight = new Map<string, Promise<GlmQuotaRead>>()
let quotaCacheEpoch = 0

function quotaEntryFor(accountId: string | undefined): QuotaEntry | null {
  if (accountId === undefined || accountId === '') return quotaSnapshot
  return quotaByAccount.get(accountId) ?? null
}

function rememberQuota(entry: QuotaEntry): void {
  quotaSnapshot = entry
  if (entry.accountId === undefined || entry.accountId === '') return
  quotaByAccount.delete(entry.accountId)
  quotaByAccount.set(entry.accountId, entry)
  while (quotaByAccount.size > QUOTA_ACCOUNT_LIMIT) {
    const oldest = quotaByAccount.keys().next().value
    if (oldest === undefined) break
    quotaByAccount.delete(oldest)
  }
}

/** 最近一次读到的快照，不发请求。 */
export function getCachedQuota(): GlmQuotaSnapshotDto | null {
  return quotaSnapshot?.snapshot ?? null
}

/**
 * 只返回**属于这个账号**的快照，不发请求。
 *
 * 配额跟着账号走：轮转决定了下一个请求花哪个账号的额度，所以一份快照只描述它被读取时
 * 那个账号的消耗。缺省 / 空 id 退回「最新一次读」，那是页面级卡片要的语义。
 */
export function getCachedQuotaFor(accountId?: string | null): GlmQuotaSnapshotDto | null {
  if (accountId === undefined || accountId === null || accountId === '') return getCachedQuota()
  return quotaByAccount.get(accountId)?.snapshot ?? null
}

/** 忘记配额缓存（登出、换账号、测试）。不给 id 就全清。 */
export function clearCachedQuota(accountId?: string | null): void {
  quotaCacheEpoch += 1
  quotaInFlight.clear()
  if (accountId === undefined || accountId === null || accountId === '') {
    quotaSnapshot = null
    quotaByAccount.clear()
    return
  }
  quotaByAccount.delete(accountId)
  if (quotaSnapshot?.accountId === accountId) quotaSnapshot = null
}

/** 读订阅列表；失败一律降级成「没有套餐名」，配额窗口不受影响。 */
export async function fetchSubscriptionPlan(
  region: GlmRegion,
  codingPlanKey: string,
  options: GlmRequestOptions = {},
): Promise<GlmSubscriptionPlan | null> {
  const fetchFn = options.fetchFn ?? fetch
  try {
    const response = await fetchFn(subscriptionUrl(region, options.env ?? process.env), {
      method: 'GET',
      headers: quotaRequestHeaders(codingPlanKey),
      signal: withTimeout(options.signal, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const payload: unknown = await response.json().catch(() => undefined)
    if (payload === undefined) return null
    return parseSubscriptionPlan(payload)
  } catch {
    return null
  }
}

/**
 * 读一次配额，返回快照或一句失败原因。
 *
 * 走缓存：命中 `QUOTA_CACHE_TTL_MS` 内的同账号结果直接返回（设置卡片在轮询这个接口）。
 * 订阅列表是**尽力而为**的第二段：它只补套餐名与续费时刻，失败不影响已经拿到的窗口。
 *
 * 为什么不抛异常而用 `error`：卡片的降级契约是「没有数字 + 一句原因」
 * （`GlmStatusDto.quota` 可空、`quotaError` 与它并列），抛异常会把同一个决定
 * 推给七个调用点各写一遍。需要「没读到就算失败」的调用方（连接测试）用
 * {@link verifyCodingPlanKey}，它本来就会抛。
 *
 * @param accountId - 这次读是为哪个池内账号做的；缓存按它分桶。
 * @throws 只有一种：凭据是空白。那是调用方的 bug（不该把空凭据发到网络上），
 *   所以它同步抛出，与「上游读失败返回 `error`」那条路径分开。
 */
export async function fetchGlmQuota(
  region: GlmRegion,
  codingPlanKey: string,
  options: GlmRequestOptions & { accountId?: string; force?: boolean } = {},
): Promise<GlmQuotaRead> {
  if (codingPlanKey.trim() === '') {
    throw new Error(failure('的配额读取需要一把 Coding Plan Key（裸值，不加 Bearer）。'))
  }
  const accountId = options.accountId
  const cached = quotaEntryFor(accountId)
  if (options.force !== true && cached !== null && Date.now() - cached.at < QUOTA_CACHE_TTL_MS) {
    return { snapshot: cached.snapshot, error: cached.error, fromCache: true }
  }
  const key = accountId ?? ''
  const inFlight = quotaInFlight.get(key)
  if (inFlight !== undefined) return inFlight

  const epoch = quotaCacheEpoch
  const request = (async (): Promise<GlmQuotaRead> => {
    const fetchFn = options.fetchFn ?? fetch
    const env = options.env ?? process.env
    const now = Date.now()
    const sources: string[] = [QUOTA_PATH]
    let response: Response
    try {
      response = await fetchFn(quotaUrl(region, env), {
        method: 'GET',
        headers: quotaRequestHeaders(codingPlanKey),
        signal: withTimeout(options.signal, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS),
      })
    } catch (error) {
      return {
        snapshot: null,
        error: failure('配额接口不可达：' + (error instanceof Error ? error.message : String(error))),
        fromCache: false,
      }
    }
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      const detail = summarize(text)
      return {
        snapshot: null,
        error: failure('配额查询失败（HTTP ' + response.status + '）')
          + (detail === '' ? '' : '：' + detail),
        fromCache: false,
      }
    }
    let payload: unknown
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      return { snapshot: null, error: failure('配额查询返回的不是 JSON。'), fromCache: false }
    }

    // 尽力而为的第二段：套餐名与续费时刻。它失败时窗口照样有效。
    const plan = await fetchSubscriptionPlan(region, codingPlanKey, options)
    const snapshot = parseQuotaSnapshot(payload, {
      planName: plan?.planName ?? null,
      renewsAt: plan?.renewsAt ?? null,
      now,
      ...(plan === null ? {} : { sources: [...sources, SUBSCRIPTION_PATH] }),
    })
    if (snapshot === null) {
      // 这句会**原样出现在卡片上**，所以只写用户能照做的话；技术原因留在代码里：
      // `parseQuotaSnapshot` 返回 null 只有两种情况——信封 `success` 不为 true，
      // 或窗口行全部被丢弃（未知 `unit` 一律丢、`TIME_LIMIT` 是 MCP 请求上限不是套餐窗口）。
      return {
        snapshot: null,
        error: failure('上游没有返回可显示的额度窗口。'),
        fromCache: false,
      }
    }
    return { snapshot, error: null, fromCache: false }
  })()

  quotaInFlight.set(key, request)
  try {
    const read = await request
    // 清缓存发生在飞行途中时，这次结果不属于当前这一代缓存，不能写回去。
    if (epoch === quotaCacheEpoch) {
      rememberQuota({ accountId, at: Date.now(), snapshot: read.snapshot, error: read.error })
    }
    return read
  } finally {
    if (quotaInFlight.get(key) === request) quotaInFlight.delete(key)
  }
}
