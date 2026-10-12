/**
 * Step Code 线路的上游 I/O：模型目录 + 开发者中心额度。
 *
 * 本文件只做两件事：**把请求发到上游**，以及**把上游的载荷翻译成本线路的形状**。
 * 传输（发送模型请求、拆流）不在这里——那是 mapper.ts / adapter.ts 的活。
 *
 * ---------------------------------------------------------------------------
 * 三条必须记住的上游事实（逐字证据在每处注释里）
 * ---------------------------------------------------------------------------
 *
 * 1. **base 归一化是幂等循环，不是 endsWith 判断。**
 *    官方 normalizeStepApiBaseUrl（step-provider/index.ts:378-400）反复剥掉尾部的
 *    /v1/messages、/messages、/v1，因为历史配置里出现过**重复后缀**（/v1/v1/messages）：
 *    一次 endsWith 只能修好一层，两层就还剩一层。本文件照抄那个循环。
 *
 * 2. **逐模型详情在域名根的 /v1，不在 /step_plan/v1。**
 *    index.ts:420-426：the subpath variant 404s。所以 stepModelDetailUrl 走
 *    {origin}/v1/models/{id}，而列表走 {归一化 base}/v1/models。
 *    这两条**故意不一样**，合并它们就是那个 404。
 *
 * 3. **额度失败绝不影响模型请求。**
 *    额度面是**非公开接口**（计划 §5、§10 风险 1），上游改一次路径或字段就全失效。
 *    所以额度的一切都返回**值**（StepCodeQuotaRead），没有一条路径把错误抛给调用方
 *    之外的边界：调用方不需要 try/catch 就能安全地把额度塞进状态面。
 *
 * ---------------------------------------------------------------------------
 * 注入缝
 * ---------------------------------------------------------------------------
 * 每个网络函数都接受 fetchFn（默认 fetch）与 env（默认 process.env），
 * 且 env **在调用时**读取（不是模块加载时），这样单测不碰真实网络也不碰真实凭据。
 */

import { randomBytes } from 'node:crypto'
import { quotaResetMs } from '../common/account-quota.ts'
import {
  catalogSnapshotName,
  rehydrateCatalogCache,
  writeCatalogSnapshot,
} from '../common/catalog-snapshot.ts'
import {
  stepCodeRegionOf,
  type StepCodeProfile,
  type StepCodeQuotaBucket,
  type StepCodeQuotaSnapshotDto,
  type StepCodeQuotaWindow,
  type StepCodeRegion,
} from '../../shared/step-code-contracts.ts'
import {
  CATALOG_CACHE_TTL_MS,
  CHAT_COMPLETIONS_PATH,
  DISCOVERY_TIMEOUT_MS,
  MODEL_DETAIL_BASE_PATH,
  MODELS_PATH,
  PROVIDER_NAME,
  QUOTA_AUTH_PATHS,
  QUOTA_CACHE_TTL_MS,
  QUOTA_COOKIE_NAMES,
  QUOTA_CREDIT_FIELDS,
  OASIS_APP_ID,
  OASIS_PLATFORM,
  QUOTA_HEADERS,
  QUOTA_LEGACY_FIELDS,
  QUOTA_PATHS,
  USABLE_MODEL_TYPES,
  USER_AGENT,
  apiBaseForProfile,
  authBaseForProfile,
} from './types.ts'

// ---------------------------------------------------------------------------
// 小工具（与 workbuddy/client.ts 同一套：纯、只读、无副作用）
// ---------------------------------------------------------------------------

export interface StepCodeRequestOptions {
  /** 测试缝。默认 fetch。 */
  fetchFn?: typeof fetch
  signal?: AbortSignal
  /** 环境变量读取处。默认 process.env，且**调用时**读取。 */
  env?: NodeJS.ProcessEnv
}

function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/** 去空白后非空的字符串，或 undefined。 */
function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 一个有限数字，**int / float / 数字字符串**三种写法都认。
 *
 * 额度面的字段是上游手写 JSON（0.95、0、"0.95" 都出现过），把「它一定是 number」
 * 写进类型是一次上游改版就会崩的假设。收在这里一处，比每个字段各写一遍判断可靠。
 */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/[,\s]/g, '')
    if (trimmed === '') return undefined
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') return true
    if (normalized === 'false' || normalized === '0') return false
  }
  return undefined
}

/** 字符串数组（reasoning_effort_support_list），非字符串元素被丢弃。 */
function asTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const item of value) {
    const text = asText(item)
    if (text !== undefined) result.push(text)
  }
  return result
}

/**
 * 一个时刻，Unix **毫秒**；上游没给或给不出来时为 null。
 *
 * 两种形态都收（计划 §5）：
 *
 * - **数字**：可能是秒也可能是毫秒，用**量级**分辨——10^10 秒是 2286 年，
 *   所以更大的数一定已经是毫秒（共享的 quotaResetMs() 就是这条判据）。
 * - **字符串**：可能是 ISO 8601（2026-01-01T00:00:00Z），也可能只是数字串；
 *   后者先当数字解析。解析不出来就返回 null——**不猜**。
 */
function asTimestampMs(value: unknown): number | null {
  const numeric = asNumber(value)
  if (numeric !== undefined) return quotaResetMs(numeric)
  const text = asText(value)
  if (text === undefined) return null
  const parsed = Date.parse(text.includes('T') ? text : text.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : null
}

/** 已用百分比有界到 0-100；(1 - left_rate) * 100 是唯一的算法。 */
function usedPercentFrom(leftRate: number | undefined): number | null {
  if (leftRate === undefined) return null
  return Math.min(100, Math.max(0, (1 - leftRate) * 100))
}

/** 错误详情去控制字符并截断到 MAX_ERROR_DETAIL_LENGTH（逐字 login-client.ts:39）。 */
export function stepCodeErrorDetail(text: string, limit = 240): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, limit)
}

// ---------------------------------------------------------------------------
// 上游凭据与请求头
// ---------------------------------------------------------------------------

/**
 * 本线路发上游请求只需要的三件事：一个 key、它属于哪条 profile、（可选）账号标识。
 *
 * 这是**号池凭据的结构化超集**：account-pool.ts 的 StepCodeCredentials 就是它加一个
 * 来源标记，所以本文件的每个函数都能直接吃号池交出来的凭据，而不必认识池。
 */
export interface StepCodeUpstreamCredential {
  readonly apiKey: string
  readonly profile: StepCodeProfile
  readonly uid?: string
}

/**
 * 模型面请求的头（逐字 index.ts:453-456：只有 accept 与 authorization）。
 *
 * 刻意**不加** user-agent：官方目录请求就这两个头，凭空多一个头不会让目录多返回
 * 一个字段，却会让「我们发的与官方一致」这句话变成假的。
 */
export function stepCodeModelHeaders(credentials: StepCodeUpstreamCredential): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: 'Bearer ' + credentials.apiKey,
  }
}

// ---------------------------------------------------------------------------
// base URL 拼装（本波证据要求给出函数名与行号的那一组）
// ---------------------------------------------------------------------------

/**
 * 把任意写法的 Step base 归一化成**路由前缀**（不带尾部斜杠、不带版本段）。
 *
 * 逐字照抄官方 normalizeStepApiBaseUrl（index.ts:378-400），包括它的理由：
 * /v1/messages、/messages、/v1 三种尾部**反复**剥，直到剥不动为止。官方的原话是
 * Be tolerant of files produced by an intermediate release that already contained
 * one duplicated suffix——所以用循环而不是 if。
 *
 * 非法 URL 原样返回（与官方一致）：校验是 provider resolver 的职责，而这个导出函数
 * 也会被拿去修复已有配置，坏条目应当留给正常的校验去报错。
 */
export function normalizeStepApiBaseUrl(value: string): string {
  try {
    const url = new URL(value)
    let pathname = url.pathname.replace(/\/+$/u, '')
    for (;;) {
      const lower = pathname.toLowerCase()
      const suffix = ['/v1/messages', '/messages', '/v1'].find((candidate) => lower.endsWith(candidate))
      if (suffix === undefined) break
      pathname = pathname.slice(0, -suffix.length).replace(/\/+$/u, '')
    }
    url.pathname = pathname === '' ? '/' : pathname
    return url.toString().replace(/\/$/u, '')
  } catch {
    return value
  }
}

/**
 * 一条 profile 的模型面 base（**已归一化**的路由前缀）。
 *
 * 取值来自 apiBaseForProfile（含环境变量覆盖），归一化在这里做掉，于是所有调用点
 * 拼路径时不会把版本段发两次。
 */
export function stepApiRoutePrefix(profile: StepCodeProfile, env: NodeJS.ProcessEnv = process.env): string {
  return normalizeStepApiBaseUrl(apiBaseForProfile(profile, env))
}

/**
 * OpenAI 风格 base（.../v1），逐字照抄官方 stepOpenAiBaseUrl（index.ts:410-412）。
 *
 * step_plan → https://api.stepfun.com/step_plan/v1；platform_cn → .../v1。
 */
export function stepOpenAiBaseUrl(profile: StepCodeProfile, env: NodeJS.ProcessEnv = process.env): string {
  return stepApiRoutePrefix(profile, env) + '/v1'
}

/** 对话请求 URL：{归一化 base}/v1/chat/completions。 */
export function stepChatCompletionsUrl(profile: StepCodeProfile, env: NodeJS.ProcessEnv = process.env): string {
  return stepApiRoutePrefix(profile, env) + CHAT_COMPLETIONS_PATH
}

/** 目录请求 URL：{归一化 base}/v1/models。 */
export function stepModelCatalogUrl(profile: StepCodeProfile, env: NodeJS.ProcessEnv = process.env): string {
  return stepApiRoutePrefix(profile, env) + MODELS_PATH
}

/**
 * 逐模型详情的 base：**域名根的 /v1**（逐字 index.ts:414-426）。
 *
 * 反直觉但是必须：/step_plan/v1/models/{id} 会 404。解析不出域名时退回归一化 base，
 * 与官方一致（官方那句 Falls back to the input if it is not a valid URL）。
 */
export function stepModelDetailBaseUrl(profile: StepCodeProfile, env: NodeJS.ProcessEnv = process.env): string {
  const base = apiBaseForProfile(profile, env)
  try {
    return new URL(base).origin + MODEL_DETAIL_BASE_PATH
  } catch {
    return stepApiRoutePrefix(profile, env) + MODEL_DETAIL_BASE_PATH
  }
}

/** 逐模型详情 URL：{域名根}/v1/models/{encodeURIComponent(id)}。 */
export function stepModelDetailUrl(
  profile: StepCodeProfile,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return stepModelDetailBaseUrl(profile, env) + '/models/' + encodeURIComponent(modelId)
}

// ---------------------------------------------------------------------------
// 模型目录（实时发现）
// ---------------------------------------------------------------------------

/**
 * 目录里的一条模型，**只含端点真的报了的字段**。
 *
 * modelType / maxInputTokens / description 允许缺失是刻意的：计划 §10 风险 2 明说这些
 * 字段都不在官方文档里，**一律按可能缺失处理**。能力**不从模型名推断**（计划 §3）。
 */
export interface StepCodeCatalogEntry {
  readonly id: string
  readonly name: string
  readonly modelType?: string
  readonly maxInputTokens?: number
  readonly reasoning: boolean
  readonly vision: boolean
  /** reasoning_effort_support_list；空数组表示端点没声明或一个都不支持。 */
  readonly efforts: readonly string[]
  readonly description: string | null
}

/**
 * 解析 GET {base}/v1/models 的载荷。
 *
 * 逐字照抄官方 fetchStepModels 的读法（index.ts:462-494），三条规则各有理由：
 *
 * - **id 必填，缺失就跳过**（index.ts:470）：没有 id 的条目既无法被请求也无法被选中。
 * - **model_type 的过滤是二元的**（index.ts:481-486）：只保留**存在该字段**的条目里
 *   USABLE_MODEL_TYPES 的两个字面量；**全部条目都不带该字段时整表不过滤**——
 *   那是更老的/别的端点，向后兼容比过滤更重要。
 * - **按 id 去重**（index.ts:487-491）：同一 id 出现两次时取第一次。
 *
 * 纯函数、导出：格式规则可以脱离文件系统与网络被测试。
 */
export function parseStepModelCatalog(payload: unknown): StepCodeCatalogEntry[] {
  const root = asRecord(payload)
  const list = Array.isArray(payload) ? payload : Array.isArray(root?.data) ? root.data : []

  const candidates: Array<{ id: string; record: Record<string, unknown> }> = []
  for (const item of list) {
    const record = asRecord(item)
    if (record === undefined) continue
    const id = asText(record.id)
    if (id === undefined) continue
    candidates.push({ id, record })
  }

  const typed = candidates.some((entry) => asText(entry.record.model_type) !== undefined)
  const entries: StepCodeCatalogEntry[] = []
  const seen = new Set<string>()
  for (const { id, record } of candidates) {
    const modelType = asText(record.model_type)
    if (typed && (modelType === undefined || !USABLE_MODEL_TYPES.includes(modelType))) continue
    if (seen.has(id)) continue
    seen.add(id)
    const declared = asNumber(record.max_input_tokens)
    const maxInputTokens = declared !== undefined && declared > 0 ? declared : undefined
    entries.push({
      id,
      name: asText(record.name) ?? id,
      ...(modelType === undefined ? {} : { modelType }),
      ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
      reasoning: asBoolean(record.enable_reason) === true,
      vision: asBoolean(record.enable_vision_input) === true,
      efforts: asTextArray(record.reasoning_effort_support_list),
      description: asText(record.description) ?? null,
    })
  }
  return entries
}

/** 一次目录读取的失败必须变成空目录，而不是异常。 */
async function requestStepModelCatalog(
  credentials: StepCodeUpstreamCredential,
  options: StepCodeRequestOptions,
): Promise<StepCodeCatalogEntry[]> {
  const fetchFn = options.fetchFn ?? fetch
  const env = options.env ?? process.env
  if (credentials.apiKey.trim() === '') return []
  try {
    const response = await fetchFn(stepModelCatalogUrl(credentials.profile, env), {
      method: 'GET',
      headers: stepCodeModelHeaders(credentials),
      signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
    })
    if (!response.ok) return []
    const payload = (await response.json().catch(() => undefined)) as unknown
    return parseStepModelCatalog(payload)
  } catch {
    // 离线、鉴权失败、端点改版：目录是可降级的（计划 §3：取不到时选择器变宽而不是消失）。
    return []
  }
}

/** 无凭据 / 失败 / 离线时目录为空：调用方回落随包表，而不是抛错。 */
export async function fetchStepModelCatalog(
  credentials: StepCodeUpstreamCredential,
  options: StepCodeRequestOptions = {},
): Promise<StepCodeCatalogEntry[]> {
  return requestStepModelCatalog(credentials, options)
}

/**
 * 一个 profile 一份的目录缓存，TTL = CATALOG_CACHE_TTL_MS。
 *
 * 按 profile 而不是按凭据缓存：目录是**端点**的属性（同一个 profile 换个账号看到的是
 * 同一份列表），按凭据缓存会让换账号作废缓存、又会让每个账号各存一份相同的列表。
 */
let cachedCatalog:
  | { profile: StepCodeProfile; entries: StepCodeCatalogEntry[]; fetchedAt: number }
  | undefined
/** 每次清缓存都推进它，好让已经在飞的请求不发布结果（照抄 workbuddy/client.ts）。 */
let catalogCacheEpoch = 0
let catalogInFlight: Promise<StepCodeCatalogEntry[]> | null = null
let catalogInFlightProfile: StepCodeProfile | null = null
/** 本进程已经为哪些 profile 试过磁盘快照：没有快照的 scope 不必每次都重读。 */
const catalogSnapshotScopesLoaded = new Set<StepCodeProfile>()

/** 本进程当前记住的目录（纯内存读，不触发任何网络请求）。 */
export function getCachedStepModelCatalog(profile?: StepCodeProfile): readonly StepCodeCatalogEntry[] {
  if (profile !== undefined) return cachedCatalog?.profile === profile ? cachedCatalog.entries : []
  return cachedCatalog?.entries ?? []
}

/** 清掉内存目录、快照 scope 与在飞的去重。 */
export function clearCachedStepModelCatalog(): void {
  cachedCatalog = undefined
  catalogCacheEpoch += 1
  catalogInFlight = null
  catalogInFlightProfile = null
  catalogSnapshotScopesLoaded.clear()
}

/**
 * TTL 缓存 + in-flight 去重 + 磁盘快照的目录读取。
 *
 * 三层各解决一件事，照抄 workbuddy/client.ts:397-491：
 *
 * - **TTL**：目录不是快变数据，半小时的陈旧比一次网络往返划算。
 * - **in-flight 去重**：同一个 profile 上并发的两个调用共用一次请求。
 * - **磁盘快照**（catalog-snapshot.ts）：冷启动不等网络。快照按 profile 分文件，
 *   所以国际区的列表不会把国区调用方喂成空。
 *
 * force: true 跳过缓存与快照直接重取（设置卡片的「刷新」按钮用）。
 */
export async function loadStepModelCatalog(
  credentials: StepCodeUpstreamCredential,
  options: StepCodeRequestOptions & { force?: boolean } = {},
): Promise<StepCodeCatalogEntry[]> {
  const profile = credentials.profile
  if (options.force === true) return refreshStepModelCatalog(credentials, options)
  if (cachedCatalog !== undefined
    && cachedCatalog.profile === profile
    && Date.now() - cachedCatalog.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return cachedCatalog.entries
  }
  // 有陈旧缓存时立刻返回它并后台刷新：等着一个打不开的端点，会把每次模型解析
  // 都变成整个发现超时。
  if (cachedCatalog !== undefined && cachedCatalog.profile === profile) {
    void refreshStepModelCatalog(credentials, options).catch(() => undefined)
    return cachedCatalog.entries
  }
  if (!catalogSnapshotScopesLoaded.has(profile)) {
    catalogSnapshotScopesLoaded.add(profile)
    const rehydratedAt = await rehydrateCatalogCache(
      catalogSnapshotName('step-code', profile),
      (value) => {
        const entries = parseStepModelCatalog(value)
        return entries.length > 0 ? entries : undefined
      },
      (fetchedAt, entries) => {
        cachedCatalog = { profile, entries, fetchedAt }
      },
      0,
    )
    if (rehydratedAt > 0) {
      void refreshStepModelCatalog(credentials, options).catch(() => undefined)
      return cachedCatalog === undefined ? [] : cachedCatalog.entries
    }
  }
  return refreshStepModelCatalog(credentials, options)
}

/** 一个 profile 一个在飞请求；失败时退回同 profile 的旧缓存，绝不抛。 */
function refreshStepModelCatalog(
  credentials: StepCodeUpstreamCredential,
  options: StepCodeRequestOptions = {},
): Promise<StepCodeCatalogEntry[]> {
  const profile = credentials.profile
  if (catalogInFlight !== null && catalogInFlightProfile === profile) return catalogInFlight
  const epoch = catalogCacheEpoch
  const sameProfile = (): StepCodeCatalogEntry[] =>
    cachedCatalog?.profile === profile ? cachedCatalog.entries : []
  const request = requestStepModelCatalog(credentials, options)
    .then((entries) => {
      // 清缓存落在飞行途中：把结果交给调用方，但不发布，也不落快照。
      if (epoch !== catalogCacheEpoch) return entries.length > 0 ? entries : sameProfile()
      if (entries.length > 0) {
        const fetchedAt = Date.now()
        cachedCatalog = { profile, entries, fetchedAt }
        void writeCatalogSnapshot(catalogSnapshotName('step-code', profile), entries, fetchedAt)
        return entries
      }
      return sameProfile()
    })
    .catch(() => sameProfile())
  catalogInFlight = request
  catalogInFlightProfile = profile
  return request.finally(() => {
    if (catalogInFlight === request) {
      catalogInFlight = null
      catalogInFlightProfile = null
    }
  })
}

/**
 * 逐模型档位：GET {域名根}/v1/models/{id} 的顶层 reasoning_effort_support_list。
 *
 * 逐字照抄官方 fetchStepModelEfforts（index.ts:532-552）：**任何**失败都返回
 * undefined 而不是抛错或返回空数组——「没取到」与「这个模型一个档位都不支持」是两句
 * 话，前者不能被后者冒充。
 *
 * 注意它读的是**顶层**字段，不是 data 里的一份列表（官方就这么读）。
 */
export async function fetchStepModelEfforts(
  credentials: StepCodeUpstreamCredential,
  modelId: string,
  options: StepCodeRequestOptions = {},
): Promise<string[] | undefined> {
  const fetchFn = options.fetchFn ?? fetch
  const env = options.env ?? process.env
  if (credentials.apiKey.trim() === '') return undefined
  try {
    const response = await fetchFn(stepModelDetailUrl(credentials.profile, modelId, env), {
      method: 'GET',
      headers: stepCodeModelHeaders(credentials),
      signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const payload = asRecord((await response.json().catch(() => undefined)) as unknown)
    const efforts = asTextArray(payload?.reasoning_effort_support_list)
    return efforts.length > 0 ? efforts : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 额度面（开发者中心，**非公开接口**）
// ---------------------------------------------------------------------------

/**
 * 老式载荷的 reset 时间字段名（逐字：计划 §5 的「+ *_reset_time」）。
 *
 * types.ts 的 QUOTA_LEGACY_FIELDS 只收了两个 left_rate，没收它们的 reset 字段名，
 * 所以这两个常量暂住本文件；**待上提到 types.ts**（避免下个波次再抄一遍）。
 */
export const STEP_QUOTA_LEGACY_RESET_FIELDS = {
  fiveHour: 'five_hour_reset_time',
  weekly: 'weekly_reset_time',
} as const

/**
 * 套餐状态里的套餐名 / 续费时刻候选字段。
 *
 * ⚠ **未验证**：GetStepPlanStatus 的响应形状没有任何公开文档，本表按常见写法列了几种，
 * 取到第一个非空值就用，取不到就是 null（卡片少一个字段，而不是显示一个编的值）。
 * 待上提到 types.ts。
 */
export const STEP_QUOTA_STATUS_FIELDS = {
  planName: ['plan_name', 'package_name', 'product_name', 'name'],
  renewAt: ['renew_time', 'renew_at', 'expire_time', 'expires_at'],
} as const

/** OASIS 匿名设备 Cookie 名（逐字：计划 §5 的 GET {auth} 取 INGRESSCOOKIE）。 */
export const OASIS_INGRESS_COOKIE = 'INGRESSCOOKIE'

/** 额度凭据的来源，与冻结契约的 StepCodeQuotaCredentialStatusDto['source'] 同一组取值。 */
export type StepCodeQuotaCredentialSource = 'auto' | 'manual'

/**
 * 开发者中心的额度凭据：Oasis-Token + 与它成对的 Oasis-Webid。
 *
 * **两个字段必须一起流动**：服务端要求 Oasis-Webid 等于该 token 的 device_id claim，
 * 否则报「token is embezzled」（计划 §10 风险 5）。所以它不是「一个 token 加一个可以
 * 随便填的头」，而是一对凭据。
 *
 * ⚠ 它等价于一次账号登录，**永远不过 host → client 的边界**；下发的是
 * StepCodeQuotaCredentialStatusDto 那张「有没有、从哪来」的切片。
 */
export interface StepCodeQuotaCredential {
  readonly token: string
  readonly deviceId: string
  readonly source: StepCodeQuotaCredentialSource
  /** 非机密：登录用到的账号，仅供卡片显示是哪一路凭据在服务。 */
  readonly account?: string
  /** 过期时刻（Unix 毫秒）；上游未给出时为 null。 */
  readonly expiresAt?: number | null
}

/**
 * 从 token 的 JWT 载荷里取 device_id claim；取不出（不是 JWT / 没有这个 claim）时
 * 返回 undefined。**在本地解码**，token 绝不发给任何地方去解析（照 codex-adopt.ts）。
 *
 * 找不到签名密钥，也就不验证签名——这里只是把服务端已经签过的那句话读出来用。
 */
export function oasisDeviceIdFromToken(token: string): string | undefined {
  // token 可能是裸 JWT，也可能是官方的 `access...refresh` 拼接串；**device_id 在
  // refresh 那一半**（逐字：CodexBar `webID(forToken:)` 先说 "The device_id lives in
  // the refresh half; fall back to the access half." 再从后往前找）。所以这里也倒序扫，
  // 顺序反了就会以为「token 里没有 device_id」而退回一个猜出来的 webid。
  for (const half of token.split('...').reverse()) {
    const deviceId = deviceIdFromJwt(half)
    if (deviceId !== undefined) return deviceId
  }
  return undefined
}

/** 解一个裸 JWT 的 `device_id`；不是 JWT 或没有该 claim 时 undefined。 */
function deviceIdFromJwt(jwt: string): string | undefined {
  const parts = jwt.split('.')
  if (parts.length !== 3) return undefined
  try {
    const claims = asRecord(JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8')) as unknown)
    if (claims === undefined) return undefined
    return asText(claims.device_id) ?? asText(claims.deviceId) ?? asText(claims.did)
  } catch {
    return undefined
  }
}

/** token 里声明的过期时刻（exp，Unix 秒 → 毫秒）；取不出时 null。 */
function oasisExpiryFromToken(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const claims = asRecord(JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8')) as unknown)
    const exp = asNumber(claims?.exp)
    return exp === undefined || exp <= 0 ? null : Math.round(exp * 1000)
  } catch {
    return null
  }
}

/**
 * 手动粘贴兜底：用户在浏览器开发者工具里复制 Oasis-Token，deviceId 顺带从 token 里解。
 *
 * 解不出 device_id 时**直接失败**，而不是让用户随便填一个：填错的上游会报
 * 「token is embezzled」，那比这里一句「这个 token 里没有 device_id」难查得多。
 */
export function manualStepCodeQuotaCredential(
  token: string,
  options: { account?: string } = {},
): StepCodeQuotaCredential {
  const trimmed = token.trim()
  if (trimmed === '') throw new Error(PROVIDER_NAME + '：粘贴的 Oasis-Token 是空的。')
  const deviceId = oasisDeviceIdFromToken(trimmed)
  if (deviceId === undefined) {
    throw new Error(
      PROVIDER_NAME + '：这个 Oasis-Token 里解不出 device_id。'
      + '请从开发者工具复制完整的 token，而不是被截断的一段。',
    )
  }
  return {
    token: trimmed,
    deviceId,
    source: 'manual',
    ...(options.account === undefined ? {} : { account: options.account }),
    expiresAt: oasisExpiryFromToken(trimmed),
  }
}

/** 自动登录失败时给卡片的一句话：降级到手动粘贴，而不是让用户反复重试密码。 */
export const OASIS_MANUAL_PASTE_HINT =
  '自动登录失败。请打开 Step 开发者中心，在浏览器开发者工具里复制 Oasis-Token 并粘贴到设置页。'

/**
 * 自动登录失败时抛出的错误：带一句「下一步做什么」，而不是把上游原文丢给用户。
 */
export class OasisSignInError extends Error {
  /** 面向用户的下一步（手动粘贴兜底）。 */
  readonly hint: string

  constructor(message: string) {
    super(message)
    this.name = 'OasisSignInError'
    this.hint = OASIS_MANUAL_PASTE_HINT
  }
}

/** 读一条响应上的全部 Set-Cookie；老运行时只有折叠的 get('set-cookie')。 */
function readSetCookies(headers: Headers): string[] {
  const withSetCookie = headers as Headers & { getSetCookie?: () => string[] }
  if (typeof withSetCookie.getSetCookie === 'function') return withSetCookie.getSetCookie()
  const single = headers.get('set-cookie')
  return single === null ? [] : [single]
}

/** 从一条 Set-Cookie 里取某个 cookie 的值（第一个匹配）。 */
function cookieValue(setCookies: readonly string[], name: string): string | undefined {
  const prefix = name + '='
  for (const entry of setCookies) {
    const start = entry.indexOf(prefix)
    if (start < 0) continue
    const rest = entry.slice(start + prefix.length)
    const end = rest.indexOf(';')
    const value = end < 0 ? rest : rest.slice(0, end)
    if (value !== '') return value
  }
  return undefined
}

/**
 * 从一处 token 字段里取字符串。
 *
 * 上游返回的**不是**一个字符串，而是一个对象（实测 2026-10-12）：
 *
 * ```json
 * {"accessToken":{"raw":"eyJ…","duration":1800,"mode":1},
 *  "refreshToken":{"raw":"eyJ…"}}
 * ```
 *
 * 所以只认 string 的读取一定拿不到 token，即使 HTTP 200 也一样——这正是
 * 「设备注册没有拿到 token（HTTP 200）」那条报错的成因。裸字符串写法仍保留兼容。
 */
function tokenString(value: unknown): string | undefined {
  const direct = asText(value)
  if (direct !== undefined) return direct
  const record = asRecord(value)
  if (record === undefined) return undefined
  // `raw` 是实测字段名；`token` / `value` 是同一族的兜底写法。
  return asText(record.raw) ?? asText(record.token) ?? asText(record.value)
}

/**
 * 把一对 token 拼成官方客户端使用的 `access...refresh` 形状。
 *
 * 逐字依据：CodexBar 的 StepFun 实现（`StepFunUsageFetcher.combinedToken`）——
 * `return "\(accessToken)...\(refreshToken)"`，且 `webID(forToken:)` 会
 * **先在 refresh 那一半里找 `device_id`**，找不到才回落 access 那一半。
 * 这就是为什么我们只解单个 JWT 时拿不到 device_id：它在 refresh 里。
 * refresh 缺失时退化成裸 access token（同一个参考实现也这么做）。
 */
function combinedOasisToken(payload: unknown): string | undefined {
  const root = asRecord(payload)
  if (root === undefined) return undefined
  const data = asRecord(root.data)
  const access = firstTokenOf([data, root], ['accessToken', 'access_token', 'oasisToken', 'oasis_token', 'token'])
  if (access === undefined) return undefined
  const refresh = firstTokenOf([data, root], ['refreshToken', 'refresh_token'])
  return refresh === undefined || refresh === '' ? access : access + '...' + refresh
}

/** 依次在若干候选来源里找第一个可用的 token 字符串。 */
function firstTokenOf(
  sources: readonly (Record<string, unknown> | undefined)[],
  keys: readonly string[],
): string | undefined {
  for (const source of sources) {
    if (source === undefined) continue
    for (const key of keys) {
      const value = tokenString(source[key])
      if (value !== undefined) return value
    }
  }
  return undefined
}

export interface StepCodeOasisSignInInput {
  /** 走哪个区域的开发者中心（profile 唯一决定）。 */
  readonly profile: StepCodeProfile
  /** 账号（手机号 / 邮箱，按 Step 的登录口径）。 */
  readonly account: string
  readonly password: string
  readonly fetchFn?: typeof fetch
  readonly signal?: AbortSignal
  readonly env?: NodeJS.ProcessEnv
}

/**
 * 账号密码换 Oasis-Token，三步（逐字：计划 §5）。
 *
 * 1. `GET {authBase}` 取 `Set-Cookie: INGRESSCOOKIE=…`（网关的匿名 cookie）。
 * 2. `POST …/PassportService/RegisterDevice` 注册设备，换匿名 token。
 * 3. `POST …/PassportService/SignInByPassword` 用账号密码换 Oasis-Token。
 *
 * 失败一律抛 {@link OasisSignInError}：调用方据此降级到「手动粘贴」（计划 §5）。
 * 账号密码**只出现在这一步的请求体里**，不写日志、不落盘、不进任何返回值。
 *
 * ⚠ 请求体字段名**未验证**（这两个接口不属于任何公开契约），按常见写法给最小集合。
 */
export async function signInOasisQuotaCredential(
  input: StepCodeOasisSignInInput,
): Promise<StepCodeQuotaCredential> {
  const fetchFn = input.fetchFn ?? fetch
  const env = input.env ?? process.env
  const authBase = authBaseForProfile(input.profile, env)
  const signal = timeoutSignal(input.signal, DISCOVERY_TIMEOUT_MS)

  // 1) 匿名入口 cookie。取不到它并不致命（有的部署不设），所以只是 warn 式地继续。
  let ingressCookie: string | undefined
  try {
    const entry = await fetchFn(authBase, { method: 'GET', signal, redirect: 'error' })
    ingressCookie = cookieValue(readSetCookies(entry.headers), OASIS_INGRESS_COOKIE)
  } catch {
    ingressCookie = undefined
  }

  const cookieHeader = ingressCookie === undefined ? '' : OASIS_INGRESS_COOKIE + '=' + ingressCookie + '; '
  const deviceId = randomBytes(16).toString('hex')

  const deviceBody = JSON.stringify({
    device_id: deviceId,
    device_name: 'dsh-chatgpt-subscription',
    platform: process.platform,
    arch: process.arch,
  })

  // 2) 注册设备换匿名 token。
  const anonymousToken = await postOasisJson(
    authBase + QUOTA_AUTH_PATHS.registerDevice,
    deviceBody,
    { fetchFn, signal, cookieHeader, origin: authBase, referer: authBase + '/' },
    '设备注册',
  )

  // 匿名 token 自带 device_id，登录那一步的 oasis-webid 必须与它一致
  // （逐字：CodexBar 在 signInByPassword 里 `webID(forToken: anonToken)`）。
  const anonymousWebid = oasisDeviceIdFromToken(anonymousToken) ?? deviceId

  // 3) 账号密码换 Oasis-Token。请求体逐字照官方客户端：**`{username, password}`**，
  //    没有 device_id / anonymous_token。早期实现自己发明了字段名，服务端不认。
  //
  //    ★ 这一条请求必须在 **cookie 里带上匿名 token**，否则一律 401。实测（2026-10-12，真实账号）：
  //
  //      cookie: Oasis-Token=<access>...<refresh>（**无空格**成对形式）+ Oasis-Webid + INGRESSCOOKIE
  //        -> HTTP 200 + accessToken/refreshToken
  //      cookie: 只带 access、或只带 refresh
  //        -> HTTP 401 {"code":"unauthenticated","message":"token is illegal"}
  //      把两个 token 之间多打一个空格（access + " ... " + refresh）
  //        -> HTTP 401 "token is malformed: could not base64 decode header"
  //
  //    这几个 401 的措辞会误导人以为「缺字段」，其实是**登录会话的身份凭据**没随 cookie 发出去；
  //    服务端用匿名 token 找它自己的会话。凭据顺序与拼接形式都必须逐字保持。
  const signInCookie = OASIS_INGRESS_COOKIE + '=' + (ingressCookie ?? '') + '; '
    + QUOTA_COOKIE_NAMES.webid + '=' + anonymousWebid + '; '
    + QUOTA_COOKIE_NAMES.token + '=' + anonymousToken
  const signedIn = await postOasisJson(
    authBase + QUOTA_AUTH_PATHS.signInByPassword,
    JSON.stringify({ username: input.account, password: input.password }),
    {
      fetchFn,
      signal,
      cookieHeader: signInCookie,
      webid: anonymousWebid,
      origin: authBase,
      // 浏览器的 `origin`/`referer` 指向开发者中心的登录页；少了它们与不带登录会话等价。
      referer: authBase + '/login?source_app=' + (stepCodeRegionOf(input.profile) === 'cn' ? 'platform-cn' : 'platform'),
    },
    '账号登录',
  )

  // Oasis-Webid 必须等于 token 的 device_id claim；解不出就退回匿名那一步的 webid，
  // 再解不出就是上游没给——那是一次真实的失败，而不是一个可以猜的头。
  const webid = oasisDeviceIdFromToken(signedIn) ?? anonymousWebid
  return {
    token: signedIn,
    deviceId: webid,
    source: 'auto',
    account: input.account,
    expiresAt: oasisExpiryFromToken(signedIn),
  }
}

async function postOasisJson(
  url: string,
  body: string,
  options: {
    fetchFn: typeof fetch
    signal: AbortSignal
    cookieHeader: string
    webid?: string
    /** 同源 `origin`；抓包里每条请求都带它。 */
    origin?: string
    /** `referer` 逐字取自浏览器抓包；缺了它，网关会当作另一个来源。 */
    referer?: string
  },
  label: string,
): Promise<string> {
  let response: Response
  try {
    response = await options.fetchFn(url, {
      method: 'POST',
      redirect: 'error',
      signal: options.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        [QUOTA_HEADERS.appid]: OASIS_APP_ID,
        [QUOTA_HEADERS.platform]: OASIS_PLATFORM,
        ...(options.webid === undefined ? {} : { [QUOTA_HEADERS.webid]: options.webid }),
        'user-agent': USER_AGENT,
        // 抓包里每条请求都带同源 `origin`；`referer` 指向开发者中心的登录页。
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.referer === undefined ? {} : { referer: options.referer }),
        ...(options.cookieHeader === '' ? {} : { cookie: options.cookieHeader }),
      },
      body,
    })
  } catch (error) {
    throw new OasisSignInError(PROVIDER_NAME + '：' + label + '请求失败（'
      + (error instanceof Error ? error.message : String(error)) + '）。')
  }
  const text = await response.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    parsed = undefined
  }
  // 取 `{raw}` 对象并拼成 `access...refresh`：上游给的是对象，不是字符串，
  // 只认字符串会在这里丢掉一个 HTTP 200 里的 token。
  const token = combinedOasisToken(response.ok ? parsed : undefined)
  if (token === undefined) {
    throw new OasisSignInError(PROVIDER_NAME + '：' + label + '没有拿到 token（HTTP '
      + response.status + '）' + (text === '' ? '' : '：' + stepCodeErrorDetail(text, 160)))
  }
  return token
}

// ---------------------------------------------------------------------------
// 额度载荷：两代形状
// ---------------------------------------------------------------------------

/**
 * 剥掉 devcenter 的信封（data / data.result），取到真正放字段的那一层。
 *
 * 它存在是为了**按载荷形状判定**（计划 §5 的加粗句）：判定依据是「字段长什么样」，
 * 而不是「信封里的 plan_family 是几」。先剥干净，判定函数才只看字段。
 */
function unwrapQuotaEnvelope(payload: unknown): Record<string, unknown> | undefined {
  const root = asRecord(payload)
  if (root === undefined) return undefined
  const data = asRecord(root.data) ?? root
  return asRecord(data.result) ?? data
}

/**
 * 把多次应答合成一份载荷（浅合并，后者覆盖前者）。
 *
 * 两个接口是分开打的，而套餐名/续费时刻只在一个里、额度窗口只在另一个里；
 * 合成之后再判定，才不会因为「先打的那个不认识」就把一代套餐判成 unknown。
 */
export function mergeStepQuotaPayloads(...payloads: readonly unknown[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const payload of payloads) {
    const body = unwrapQuotaEnvelope(payload)
    if (body === undefined) continue
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null) merged[key] = value
    }
  }
  return merged
}

export interface StepCodeQuotaParseContext {
  /** 读到的开发者中心属于哪个区域（由 profile 唯一决定）。 */
  readonly region: StepCodeRegion
  /** 实际应答过的端点路径，供设置卡片诊断（计划 §5：sources 记实际打过的路径）。 */
  readonly sources: readonly string[]
  /** 本次读取时刻；缺省用现在。 */
  readonly fetchedAt?: number
}

/** 一个老式窗口：left_rate 缺失时直接不给（null 不是 0%）。 */
function legacyWindow(
  body: Record<string, unknown>,
  key: StepCodeQuotaWindow['key'],
  rateField: string,
  resetField: string,
): StepCodeQuotaWindow | undefined {
  const usedPercent = usedPercentFrom(asNumber(body[rateField]))
  if (usedPercent === null) return undefined
  return { key, usedPercent, resetsAt: asTimestampMs(body[resetField]) }
}

/**
 * 把 devcenter 载荷翻译成 StepCodeQuotaSnapshotDto。
 *
 * **按载荷形状判定两代套餐，不单信 plan_family**（计划 §5 的加粗句）：
 *
 * - 老式：顶层 five_hour_usage_left_rate / weekly_usage_left_rate + *_reset_time。
 * - 新式：plan_credit_rate_limit.{subscription_credit_left_rate, topup_credit_left_rate,
 *   credit_buckets[]}，桶的每项是 {credit_total, credit_residual, expire_at, next_reset_at}。
 *
 * 两代都认不出来时 kind = 'unknown'，**不发明**第三条形状。
 * 数字字段三种写法（int / float / 数字字符串）、时间戳两种形态（数字 / 字符串）都收，
 * 见本文件顶部的 asNumber / asTimestampMs。
 *
 * 纯函数、导出：形状规则可以脱离网络被测试。
 */
export function parseStepQuotaSnapshot(
  payload: unknown,
  context: StepCodeQuotaParseContext,
): StepCodeQuotaSnapshotDto {
  const body = unwrapQuotaEnvelope(payload) ?? {}
  const windows: StepCodeQuotaWindow[] = []
  const creditBuckets: StepCodeQuotaBucket[] = []

  const fiveHour = legacyWindow(
    body,
    'five-hour',
    QUOTA_LEGACY_FIELDS.fiveHour,
    STEP_QUOTA_LEGACY_RESET_FIELDS.fiveHour,
  )
  if (fiveHour !== undefined) windows.push(fiveHour)
  const weekly = legacyWindow(
    body,
    'weekly',
    QUOTA_LEGACY_FIELDS.weekly,
    STEP_QUOTA_LEGACY_RESET_FIELDS.weekly,
  )
  if (weekly !== undefined) windows.push(weekly)

  const credit = asRecord(body[QUOTA_CREDIT_FIELDS.root])
  if (credit !== undefined) {
    const subscription = usedPercentFrom(asNumber(credit[QUOTA_CREDIT_FIELDS.subscription]))
    if (subscription !== null) windows.push({ key: 'credit', usedPercent: subscription, resetsAt: null })
    const rawBuckets = credit[QUOTA_CREDIT_FIELDS.buckets]
    for (const item of Array.isArray(rawBuckets) ? rawBuckets : []) {
      const record = asRecord(item)
      if (record === undefined) continue
      const total = asNumber(record.credit_total)
      const remaining = asNumber(record.credit_residual)
      // 两个绝对量都没有的桶不给：一行只有时间的桶画出来是空的。
      if (total === undefined && remaining === undefined) continue
      creditBuckets.push({
        total: total ?? 0,
        remaining: remaining ?? 0,
        expiresAt: asTimestampMs(record.expire_at),
        resetsAt: asTimestampMs(record.next_reset_at),
      })
    }
  }

  const creditTyped = creditBuckets.length > 0
    || usedPercentFrom(asNumber(credit?.[QUOTA_CREDIT_FIELDS.subscription])) !== null
    || usedPercentFrom(asNumber(credit?.[QUOTA_CREDIT_FIELDS.topup])) !== null
  const kind: StepCodeQuotaSnapshotDto['kind'] = creditTyped
    ? 'credit'
    : windows.length > 0 ? 'windowed' : 'unknown'

  let planName: string | null = null
  for (const field of STEP_QUOTA_STATUS_FIELDS.planName) {
    const value = asText(body[field])
    if (value !== undefined) { planName = value; break }
  }
  let renewsAt: number | null = null
  for (const field of STEP_QUOTA_STATUS_FIELDS.renewAt) {
    const value = asTimestampMs(body[field])
    if (value !== null) { renewsAt = value; break }
  }

  return {
    kind,
    planName,
    planFamily: asNumber(body[QUOTA_CREDIT_FIELDS.planFamily]) ?? null,
    windows,
    creditBuckets,
    renewsAt,
    fetchedAt: context.fetchedAt ?? Date.now(),
    sources: [...context.sources],
    region: context.region,
  }
}

/**
 * 一次额度读取的结果。
 *
 * 刻意**不**是 throw：额度面是非公开接口，而它的失败绝不能影响模型请求
 *（计划 §5、§10 风险 1）。调用方拿到 {ok:false, error} 就能把失败写进状态面，
 * 不必把 try/catch 铺到每个调用点。
 */
export type StepCodeQuotaRead =
  | { readonly ok: true; readonly snapshot: StepCodeQuotaSnapshotDto }
  | { readonly ok: false; readonly error: string }

/**
 * 读一次额度；两个接口都失败时返回 {ok:false}，**不抛**。
 *
 * 先打 QueryStepPlanRateLimit（额度窗口 / Credit 池），再打 GetStepPlanStatus
 *（套餐名与续费时刻）。第二个打不通不影响第一个的结果：它只补展示字段。
 * sources 记的是**实际应答过**的路径，而不是打算要打的路径。
 */
export async function readStepQuota(
  quotaCredential: StepCodeQuotaCredential,
  profile: StepCodeProfile,
  options: StepCodeRequestOptions = {},
): Promise<StepCodeQuotaRead> {
  const fetchFn = options.fetchFn ?? fetch
  const env = options.env ?? process.env
  const authBase = authBaseForProfile(profile, env)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    [QUOTA_HEADERS.appid]: OASIS_APP_ID,
    [QUOTA_HEADERS.platform]: OASIS_PLATFORM,
    [QUOTA_HEADERS.webid]: quotaCredential.deviceId,
    'user-agent': USER_AGENT,
    // Oasis-Webid 必须等于 token 的 device_id claim，否则服务端报「token is embezzled」。
    // 真实浏览器抓包（2026-10-12，platform.stepfun.com/account-overview）里这条请求同时带了
    // 三样：Cookie `Oasis-Webid=<device_id>; Oasis-Token=<access...refresh>`、**头** `oasis-webid`、
    // 以及 `origin` + `referer`（referer 指向 account-overview）。少任何一样都可能被网关拒。
    cookie: QUOTA_COOKIE_NAMES.token + '=' + quotaCredential.token
      + '; ' + QUOTA_COOKIE_NAMES.webid + '=' + quotaCredential.deviceId,
    origin: authBase,
    referer: authBase + '/account-overview',
  }

  const payloads: unknown[] = []
  const sources: string[] = []
  let lastError = '未知错误'
  for (const path of [QUOTA_PATHS.rateLimit, QUOTA_PATHS.planStatus]) {
    try {
      const response = await fetchFn(authBase + path, {
        method: 'POST',
        headers,
        body: '{}',
        signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
      })
      const text = await response.text().catch(() => '')
      if (!response.ok) {
        lastError = path + ' 返回 HTTP ' + response.status
          + (text === '' ? '' : '（' + stepCodeErrorDetail(text, 160) + '）')
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text) as unknown
      } catch {
        lastError = path + ' 的响应不是 JSON（上游可能已改版）'
        continue
      }
      payloads.push(parsed)
      sources.push(path)
    } catch (error) {
      lastError = path + ' 请求失败：' + (error instanceof Error ? error.message : String(error))
    }
  }

  if (payloads.length === 0) {
    return { ok: false, error: PROVIDER_NAME + ' 额度读取失败：' + lastError }
  }
  const snapshot = parseStepQuotaSnapshot(mergeStepQuotaPayloads(...payloads), {
    region: stepCodeRegionOf(profile),
    sources,
    fetchedAt: Date.now(),
  })
  return { ok: true, snapshot }
}

/**
 * 额度快照的缓存键。
 *
 * **额度跟着账号走**（共享号池契约的原话）：一次轮转决定哪个账号花下一次请求，
 * 线路级的一份读数描述的是「恰好轮到的那个账号」。所以键里带账号标识；
 * 账号标识缺失时退回 profile —— 代价是两个都没有 uid 的账号共用一份读数，
 * 那仍然是「我们只知道这么多」，不是编的数字。
 */
export function stepCodeQuotaCacheKey(profile: StepCodeProfile, accountId?: string | null): string {
  const id = accountId === undefined || accountId === null || accountId === '' ? 'primary' : accountId
  return profile + ':' + id
}

/** 记住下来的快照，纯内存读；号池装配账号卡片时调它（绝不在这里发请求）。 */
const cachedQuotaEntries = new Map<string, StepCodeQuotaSnapshotDto>()

let quotaInFlight: Promise<StepCodeQuotaRead> | null = null
let quotaInFlightKey: string | null = null

/** 本进程为某个账号记住的最新额度快照（纯内存读，从不发请求）。 */
export function getCachedStepQuotaFor(accountId?: string | null): StepCodeQuotaSnapshotDto | undefined {
  if (accountId === undefined || accountId === null || accountId === '') return undefined
  return cachedQuotaEntries.get(accountId)
}

/** 一次成功读取之后由调用方登记（键与 stepCodeQuotaCacheKey 一致）。 */
export function rememberStepQuotaSnapshot(
  accountId: string,
  snapshot: StepCodeQuotaSnapshotDto,
): void {
  cachedQuotaEntries.set(accountId, snapshot)
}

/** 清掉额度缓存与在飞去重（登录/切号时调用）。 */
export function clearCachedStepQuota(): void {
  cachedQuotaEntries.clear()
  quotaInFlight = null
  quotaInFlightKey = null
}

/**
 * 带 TTL 与 in-flight 去重的额度读取。
 *
 * TTL = QUOTA_CACHE_TTL_MS；force: true 跳过缓存（设置卡片的「刷新」）。
 * 失败**不缓存**：非公开接口改版后恢复得很快，缓存住一个失败只会让用户多等一个 TTL。
 */
export async function loadStepQuota(
  quotaCredential: StepCodeQuotaCredential,
  profile: StepCodeProfile,
  options: StepCodeRequestOptions & { force?: boolean; cacheKey?: string } = {},
): Promise<StepCodeQuotaRead> {
  const key = options.cacheKey ?? stepCodeQuotaCacheKey(profile, quotaCredential.account)
  if (options.force !== true) {
    const cached = cachedQuotaEntries.get(key)
    if (cached !== undefined && Date.now() - cached.fetchedAt < QUOTA_CACHE_TTL_MS) {
      return { ok: true, snapshot: cached }
    }
    if (quotaInFlight !== null && quotaInFlightKey === key) return quotaInFlight
  }

  const request = readStepQuota(quotaCredential, profile, options)
    .then((read) => {
      if (read.ok) rememberStepQuotaSnapshot(key, read.snapshot)
      return read
    })
    .catch((error: unknown) => ({
      ok: false as const,
      error: PROVIDER_NAME + ' 额度读取失败：' + (error instanceof Error ? error.message : String(error)),
    }))
  if (options.force === true) return request
  quotaInFlight = request
  quotaInFlightKey = key
  try {
    return await request
  } finally {
    if (quotaInFlight === request) {
      quotaInFlight = null
      quotaInFlightKey = null
    }
  }
}
