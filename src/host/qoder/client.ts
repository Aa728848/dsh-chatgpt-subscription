/**
 * Qoder（订阅）线路的上游 I/O：模型目录 + 额度 + userinfo + PAT 兑换 + 令牌刷新。
 *
 * 本文件只做两件事：**把请求发到上游**，以及**把上游的载荷翻译成本线路的形状**。
 * 对话传输（编码 body、拆信封流）不在这里——那是 mapper.ts / adapter.ts 的活。
 *
 * ---------------------------------------------------------------------------
 * 三条必须记住的上游事实（逐字证据在每处注释里）
 * ---------------------------------------------------------------------------
 *
 * 1. **目录与对话都要 COSY 签名。** 模型列表是一个带 COSY 头的 GET（无 body；
 *    签名里 body 分量是空串）。OpenAPI 面（PAT 兑换 / userinfo / 额度 / 设备轮询）
 *    是 plain Bearer，不签名（pi-provider 的全部 openapi 调用一致）。
 * 2. **COSY 版本落后会拿到缩减目录。** 版本每日跟随 Qoder CLI 的 release feed
 *    （pi-provider cosy-version.ts 同一设计），失败回落随包版本。
 * 3. **额度失败绝不影响模型请求。** 额度是非公开个人端点（计划 §5、§9 风险 1），
 *    它的一切都返回**值**（QoderQuotaRead），没有一条路径把错误抛给调用方之外的边界。
 *
 * ---------------------------------------------------------------------------
 * 注入缝
 * ---------------------------------------------------------------------------
 * 每个网络函数都接受 fetchFn（默认 fetch）与 env（默认 process.env），且 env
 * **在调用时**读取（不是模块加载时），这样单测不碰真实网络也不碰真实凭据。
 */

import {
  catalogSnapshotName,
  rehydrateCatalogCache,
  writeCatalogSnapshot,
} from '../common/catalog-snapshot.ts'
import type {
  QoderQuotaBucketDto,
  QoderQuotaBucketKind,
  QoderQuotaSnapshotDto,
  QoderRegion,
} from '../../shared/qoder-contracts.ts'
import {
  CATALOG_CACHE_TTL_MS,
  CHAT_PATH,
  CHAT_QUERY,
  COSY_VERSION_REFRESH_MS,
  DISCOVERY_TIMEOUT_MS,
  JOB_TOKEN_EXCHANGE_PATH,
  MODEL_LIST_PATH,
  MODEL_LIST_QUERY,
  PROVIDER_NAME,
  QODER_BUNDLED_COSY_VERSION,
  QODER_CLI_RELEASES_URL,
  QODER_OPENAPI_COSY_VERSION,
  QUOTA_CACHE_TTL_MS,
  QUOTA_USAGE_PATH,
  REFRESH_TOKEN_PATH,
  USERINFO_PATH,
  USER_AGENT,
  centerBaseForRegion,
  inferenceBaseForRegion,
  openapiBaseForRegion,
  COSY_CLIENT_TYPE,
} from './types.ts'
import { buildQoderCosyHeaders, resolveQoderMachineId, type QoderCosyIdentity } from './cosy.ts'
import {
  parsePersistedQoderModelEntries,
  parseQoderModelListing,
  persistedQoderModelRecord,
  type QoderModelEntry,
} from './model-catalog.ts'
import { qoderExpiresAtFrom, type QoderCredentials } from './token-store.ts'
import path from 'node:path'
import { dshHomeDir } from '../common/home.ts'
import { readFile, writeFile, mkdir } from 'node:fs/promises'

// ---------------------------------------------------------------------------
// 小工具（纯、只读、无副作用）
// ---------------------------------------------------------------------------

export interface QoderRequestOptions {
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

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 一个有限非负数字；额度字段可能是字符串，两种都收（同 step-code 的 asNumber 的理由）。 */
function asQuotaNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined
  if (typeof value === 'string') {
    const parsed = Number(value.trim().replace(/[,\s]/g, ''))
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
  }
  return undefined
}

/** 错误详情去控制字符并截断（卡片与日志共用同一口径）。 */
export function qoderErrorDetail(text: string, limit = 240): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, limit)
}

// ---------------------------------------------------------------------------
// 上游凭据与 COSY 身份
// ---------------------------------------------------------------------------

/**
 * 本线路发上游请求需要的那份凭据切片。
 *
 * 这是**号池凭据的结构化超集**：account-pool.ts 的 QoderCredentials 加了来源与
 * 落盘字段，而本文件的每个函数都能直接吃号池交出来的凭据，而不必认识池。
 */
export interface QoderUpstreamCredential {
  readonly accessToken: string
  readonly region: QoderRegion
  readonly uid: string | null
  readonly email: string | null
  readonly accountName: string | null
  readonly organizationId?: string | null
  readonly organizationTags?: readonly string[]
  readonly dataPolicyAgreed?: boolean
}

/**
 * 凭据切片 → COSY 身份。
 *
 * UserInfo 的字段顺序**固定**（uid / security_oauth_token / name / aid / email，
 * 逐字 pi-provider \`cosy.ts\` 的 UserInfo 形状）：它原样进 AES 明文，而官方算法
 * 对 raw 字符串原样处理（docs/oauth.md §5），所以这里手写键序而不是 JSON.stringify
 * 一个对象——后者的键序是实现细节，不是协议事实。
 */
export function qoderCosyIdentityOf(
  credentials: QoderUpstreamCredential,
  env: NodeJS.ProcessEnv = process.env,
): QoderCosyIdentity {
  const uid = credentials.uid ?? 'qoder-user'
  const rawUserInfo = '{"uid":' + JSON.stringify(uid)
    + ',"security_oauth_token":' + JSON.stringify(credentials.accessToken)
    + ',"name":' + JSON.stringify(credentials.accountName ?? '')
    + ',"aid":""'
    + ',"email":' + JSON.stringify(credentials.email ?? '') + '}'
  return {
    uid,
    rawUserInfo,
    machineId: resolveQoderMachineId(env),
    cosyVersion: getQoderCosyVersion(),
    dataPolicyAgreed: credentials.dataPolicyAgreed === true,
    organizationId: credentials.organizationId ?? null,
    organizationTags: credentials.organizationTags ?? [],
  }
}

/** OpenAPI 面请求的头（plain Bearer，不签名；逐字 pi-provider pat.ts 的头集）。 */
export function qoderOpenapiHeaders(credentials: { accessToken: string }): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: 'Bearer ' + credentials.accessToken,
    'cosy-version': QODER_OPENAPI_COSY_VERSION,
    'cosy-clienttype': COSY_CLIENT_TYPE,
    'user-agent': USER_AGENT,
  }
}

// ---------------------------------------------------------------------------
// COSY 版本跟随（逐字 pi-provider cosy-version.ts 的设计）
// ---------------------------------------------------------------------------

/** 版本缓存的磁盘位置（目录缓存旁边）。 */
function cosyVersionCachePath(): string {
  return path.join(dshHomeDir(), 'storages', 'qoder-cosy-version.json')
}

interface QoderCosyVersionCache {
  version?: string
  checkedAt?: number
}

let cosyVersionMem: QoderCosyVersionCache | null | undefined
let cosyVersionRefreshInFlight: Promise<void> | null = null

/** 一个值是不是合法的 x.y.z 版本串。 */
export function isQoderCliVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value)
}

/** x.y.z 的数字比较。 */
export function compareQoderCliVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! - pb[i]!
  }
  return 0
}

async function readCosyVersionCache(): Promise<QoderCosyVersionCache | null> {
  if (cosyVersionMem !== undefined) return cosyVersionMem
  try {
    const data = JSON.parse(await readFile(cosyVersionCachePath(), 'utf8')) as QoderCosyVersionCache
    cosyVersionMem = data
    return data
  } catch {
    cosyVersionMem = null
    return null
  }
}

async function writeCosyVersionCache(data: QoderCosyVersionCache): Promise<void> {
  cosyVersionMem = data
  try {
    await mkdir(path.dirname(cosyVersionCachePath()), { recursive: true })
    await writeFile(cosyVersionCachePath(), JSON.stringify(data, null, 2) + '\n', 'utf8')
  } catch {
    // 只读的家目录不许把请求弄死：内存里的那份仍然生效。
  }
}

/**
 * 当前签名用的 COSY 版本：缓存里更新的 CLI release 优先，否则随包回落。
 * 同步且**无网络**；刷新发生在 {@link refreshQoderCosyVersion}。
 */
export function getQoderCosyVersion(): string {
  const cached = cosyVersionMem?.version
  if (isQoderCliVersion(cached) && compareQoderCliVersions(cached, QODER_BUNDLED_COSY_VERSION) >= 0) {
    return cached
  }
  return QODER_BUNDLED_COSY_VERSION
}

/**
 * 跟随 Qoder CLI 的最新 release（每日最多一次，失败完全容忍）。
 *
 * 逐字 pi-provider \`refreshGatewayCosyVersion\` 的设计：网关给 COSY 版本落后的客户端
 * 发**缩减的**模型目录，所以签名身份要跟着 CLI 走；但任何失败（离线、坏载荷、更旧的
 * tag）都回落到既有版本——签名绝不依赖这次 fetch 成功。
 */
export async function refreshQoderCosyVersion(options: QoderRequestOptions & { force?: boolean } = {}): Promise<void> {
  const now = Date.now()
  const cached = await readCosyVersionCache()
  if (options.force !== true && typeof cached?.checkedAt === 'number' && now - cached.checkedAt < COSY_VERSION_REFRESH_MS) {
    return
  }
  if (cosyVersionRefreshInFlight !== null) return cosyVersionRefreshInFlight
  cosyVersionRefreshInFlight = (async () => {
    try {
      const fetchFn = options.fetchFn ?? fetch
      const response = await fetchFn(QODER_CLI_RELEASES_URL, {
        headers: { accept: 'application/vnd.github.v3+json', 'user-agent': USER_AGENT },
        signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
      })
      if (!response.ok) return
      const releases = (await response.json().catch(() => undefined)) as unknown
      if (!Array.isArray(releases)) return
      const latest = releases.find((release) =>
        isRecord(release) && release.draft !== true && release.prerelease !== true && isQoderCliVersion(release.tag_name))
      const stampedAt = Date.now()
      if (latest !== undefined && compareQoderCliVersions((latest as { tag_name: string }).tag_name, getQoderCosyVersion()) > 0) {
        await writeCosyVersionCache({ version: (latest as { tag_name: string }).tag_name, checkedAt: stampedAt })
      } else {
        await writeCosyVersionCache({ ...(cached?.version === undefined ? {} : { version: cached.version }), checkedAt: stampedAt })
      }
    } catch {
      // 离线或坏载荷：继续用缓存/随包版本签名，下一个刷新窗口再试。
    } finally {
      cosyVersionRefreshInFlight = null
    }
  })()
  return cosyVersionRefreshInFlight
}

/** 测试用：清掉进程内版本缓存。 */
export function clearQoderCosyVersionCache(): void {
  cosyVersionMem = undefined
}

// ---------------------------------------------------------------------------
// 模型目录（COSY 签名的 GET + TTL 缓存 + 磁盘快照）
// ---------------------------------------------------------------------------

/** 模型列表 URL。 */
export function qoderModelListUrl(region: QoderRegion, env: NodeJS.ProcessEnv = process.env): string {
  return inferenceBaseForRegion(region, env) + MODEL_LIST_PATH + '?' + MODEL_LIST_QUERY
}

/** 对话 URL（adapter 用；拼在这里，全局只有这一处）。 */
export function qoderChatUrl(region: QoderRegion, env: NodeJS.ProcessEnv = process.env): string {
  return inferenceBaseForRegion(region, env) + '/algo' + CHAT_PATH + '?' + CHAT_QUERY
}

/**
 * 目录里的一条模型（host 内部形状 = 能力行；只含端点真的报了的字段装配出来的结果）。
 * 与 step-code 的 StepCodeCatalogEntry 不同：本线路的解析直接产出能力行
 * （{@link parseQoderModelListing}），缓存里放的就是它。
 */
export type QoderCatalogEntry = QoderModelEntry

/** 一次目录读取的失败必须变成空目录，而不是异常。 */
async function requestQoderModelCatalog(
  credentials: QoderUpstreamCredential,
  options: QoderRequestOptions,
): Promise<QoderCatalogEntry[]> {
  const fetchFn = options.fetchFn ?? fetch
  const env = options.env ?? process.env
  if (credentials.accessToken.trim() === '') return []
  try {
    // 先跟随 COSY 版本（节流在函数内）：版本落后会拿到缩减目录（types.ts 的注释）。
    await refreshQoderCosyVersion({ fetchFn, signal: options.signal, env })
    const url = qoderModelListUrl(credentials.region, env)
    const identity = qoderCosyIdentityOf(credentials, env)
    const headers = buildQoderCosyHeaders(identity, {
      encodedBody: '',
      url,
      accept: 'application/json',
      withContentType: false,
    })
    const response = await fetchFn(url, {
      method: 'GET',
      headers,
      signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
    })
    if (!response.ok) return []
    const payload = (await response.json().catch(() => undefined)) as unknown
    return parseQoderModelListing(payload, credentials.region)
  } catch {
    // 离线、鉴权失败、端点改版：目录是可降级的（取不到时选择器走随包兜底表）。
    return []
  }
}

/** 无凭据 / 失败 / 离线时目录为空：调用方回落随包表，而不是抛错。 */
export async function fetchQoderModelCatalog(
  credentials: QoderUpstreamCredential,
  options: QoderRequestOptions = {},
): Promise<QoderCatalogEntry[]> {
  return requestQoderModelCatalog(credentials, options)
}

/** 一个区域一份的目录缓存（目录是**端点**的属性，不是账号的；TTL 见 types.ts）。 */
let cachedCatalog:
  | { region: QoderRegion; entries: QoderCatalogEntry[]; fetchedAt: number }
  | undefined
/** 每次清缓存都推进它，好让已经在飞的请求不发布结果（照抄 step-code/client.ts）。 */
let catalogCacheEpoch = 0
let catalogInFlight: Promise<QoderCatalogEntry[]> | null = null
let catalogInFlightRegion: QoderRegion | null = null
/** 本进程已经为哪些区域试过磁盘快照。 */
const catalogSnapshotScopesLoaded = new Set<QoderRegion>()

/** 本进程当前记住的目录（纯内存读，不触发任何网络请求）。 */
export function getCachedQoderModelCatalog(region?: QoderRegion): readonly QoderCatalogEntry[] {
  if (region !== undefined) return cachedCatalog?.region === region ? cachedCatalog.entries : []
  return cachedCatalog?.entries ?? []
}

/**
 * 本进程此刻拿到的目录是**实时目录**（上游真的答过）还是**随包兜底表**。
 *
 * 这条判定必须单独导出、口径只有一处，因为下游对它有两个消费者而两处的后果都很具体：
 *
 * - `adapter.listModels` 与状态面的勾选标记要知道「这一份目录是不是这个账号真实可用的
 *   集合」，才知道用不用用户的白名单去筛它（见下面的「两套 id 词汇表」）；
 * - 任何自己拼「缓存有没有 / 是不是空」的地方都会与它漂：一处按 `undefined` 判空、
 *   另一处按「条目数为 0」判空，兜底表就会被当成本账号的真实目录。
 *
 * -------------------------------------------------------------------------
 * 两套 id 词汇表（这是缺陷 1 的证据，别再合并它们）
 * -------------------------------------------------------------------------
 * 用户的白名单是在设置卡片上对着**实时目录**勾出来的 id，而实时目录的 id 就是上游
 * `display_name` 去空白（model-catalog.ts `toQoderModelId`）；随包兜底表照录
 * pi-provider 的静态表，同一批模型在两边**叫法不同**：
 *
 * | 实时目录（用户勾的） | 随包兜底表 |
 * | --- | --- |
 * | `DeepSeek-Flash` | `DeepSeek-V4-Flash` |
 * | `Qwen3.8-Flash` | `Qwen3.8-Max` / `Qwen3.7-Plus` |
 * | `Ultimate` | `Ultimate`（少数恰好同名） |
 *
 * 所以「用白名单去筛兜底表」这件事在冷启动时必然收敛成空集，而 `listModels` 返回空
 * 会让 DSH 把整个 provider 分组过滤掉——选择器里连 Qoder 都不剩。
 *
 * @param region 要判定的区域（目录是区域的属性，别的区域的缓存不算数）。
 */
export function qoderCatalogIsLive(region: QoderRegion): boolean {
  return cachedCatalog !== undefined
    && cachedCatalog.region === region
    && cachedCatalog.entries.length > 0
}

/** 清掉内存目录、快照 scope 与在飞的去重。 */
export function clearCachedQoderModelCatalog(): void {
  cachedCatalog = undefined
  catalogCacheEpoch += 1
  catalogInFlight = null
  catalogInFlightRegion = null
  catalogSnapshotScopesLoaded.clear()
}

/**
 * 当前进程的目录缓存是否「需要（或应该）拉一次」：空缓存、别的区域的缓存、
 * 或者已经旧到过了 {@link CATALOG_CACHE_TTL_MS}。
 *
 * 之所以把这条判定单独导出，是因为它有两个消费者而只能有一份口径：设置卡片的
 * `GET /status` 要在应答背后决定「这次要不要顺手拉一次」，而不是每条路径
 * 各写一遍「有没有缓存 / 过没过期」。判定口径分叉的那种后果很具体——一处按
 * `undefined` 判空、另一处按「条目数为 0」判空，于是空数组缓存永远被判成
 * 「有缓存，不用拉」，选择器就永远停在兜底表上。
 *
 * 读的是与 {@link loadQoderModelCatalog} **同一个** `cachedCatalog` 与其
 * `fetchedAt`，所以「这里说不用拉」与「那边会直接命中缓存」是同一件事。
 * 纯读：不联网、不写缓存、不改任何状态，因此可以在应答路径上随手调用。
 *
 * @param region 要判定的区域（目录是区域的属性，别的区域的缓存不算数）。
 * @param now    当前时刻；显式传入是为了让「过期」这件事在测试里可确定。
 */
/**
 * 缓存目录的写入时刻（Unix 毫秒），没有缓存时为 undefined。
 *
 * 给「过期判定」的测试一个**确定**的基准：测试原先在 await 返回后用
 * `Date.now()` 去推边界，而缓存里的 `fetchedAt` 是稍早一次 `Date.now()`，
 * 两次读时钟之间的毫秒差会让「差一毫秒到期仍算新鲜」这条断言偶发翻车。
 * 读的是与 {@link qoderCatalogNeedsRefresh} 同一个字段，纯读、无副作用。
 */
export function qoderCatalogFetchedAt(region: QoderRegion): number | undefined {
  const cached = cachedCatalog
  if (cached === undefined || cached === null || cached.region !== region) return undefined
  return cached.fetchedAt
}

export function qoderCatalogNeedsRefresh(region: QoderRegion, now: number = Date.now()): boolean {
  // 判定与 {@link qoderCatalogIsLive} **同一口径**：反过来读那一个函数，两处就不会漂。
  if (!qoderCatalogIsLive(region)) return true
  return now - cachedCatalog!.fetchedAt >= CATALOG_CACHE_TTL_MS
}

/**
 * 进程内实时目录的指纹：还没有实时目录（只有随包兜底表）时是空数组的序列化。
 *
 * 「这次刷新有没有真的换掉目录」的判定**只有这一处**。它有两个调用方，而两处
 * 判错的后果都很具体：
 *
 * - `routes.ts` 的刷新路径在这一条上决定发不发 `llm/adapters-updated`：这张卡片
 *   每 60 秒轮询一次，无条件发就等于让模型选择器每拍重建一遍；
 * - `index.ts` 的**启动预热**同样要发一次，而且启动那一刻根本没有任何订阅方在等，
 *   发早发晚都不影响正确性——但它与刷新路径必须是同一句判词，否则「目录变了没有」
 *   在两条路径上会给出两个答案。
 *
 * 用 id 序列而不是数组引用：{@link loadQoderModelCatalog} 命中缓存时会把**同一个
 * 数组**交回来，按引用比较永远相等，那样「目录真的变了」就永远判不出来。
 *
 * @param region 要取指纹的区域（目录是区域的属性，别的区域的缓存不算数）。
 */
export function qoderCatalogFingerprint(region: QoderRegion): string {
  return JSON.stringify(getCachedQoderModelCatalog(region).map((entry) => entry.id))
}

/**
 * 快照回填：本进程第一次碰到这个区域时，把上一次落盘的真实目录读回内存。
 *
 * 抽成一处是因为它有**两个入口**，而两个入口必须落进同一份状态：启动预热
 * （{@link warmQoderModelCatalog}）与懒加载（{@link loadQoderModelCatalog}）。
 * `catalogSnapshotScopesLoaded` 让「每个区域只读一次盘」这件事在两条路径之间
 * 共享——预热读过的区域，第一次 `loadQoderModelCatalog` 就不会再读一遍。
 *
 * @returns 回填成功时快照的 `fetchedAt`，没有可用快照时为 0（调用方照旧取上游）。
 */
async function rehydrateQoderCatalogFromSnapshot(region: QoderRegion): Promise<number> {
  if (catalogSnapshotScopesLoaded.has(region)) return 0
  catalogSnapshotScopesLoaded.add(region)
  const rehydratedAt = await rehydrateCatalogCache(
    catalogSnapshotName('qoder', region),
    // 快照的读取侧必须与写入侧（refreshQoderModelCatalog 的 persistedQoderModelRecord）
    // 互为反函数。这里曾经错用 parseQoderModelListing（它只认上游的 { chat } 载荷），
    // 于是任何快照都解析成空数组被丢掉——磁盘上明明有真实目录，冷启动却永远从兜底表
    // 起步。形状对不上时是静默的，所以这条注释与那一对函数必须一起存在。
    (value) => {
      const entries = parsePersistedQoderModelEntries(value, region)
      return entries.length > 0 ? entries : undefined
    },
    (fetchedAt, entries) => {
      cachedCatalog = { region, entries, fetchedAt }
    },
    0,
  )
  // accept 收到的 fetchedAt 就是快照写入时刻（= 上一次上游真的答过的时刻），
  // 所以回填出来的缓存天然带着正确的 TTL 起点，不会被立刻判成过期。
  return rehydratedAt
}

/**
 * 启动预热：把上一次落盘的真实目录**立刻**放回进程内缓存，再让上游刷新跑在背后。
 *
 * ---------------------------------------------------------------------------
 * 为什么要在启动时预热
 * ---------------------------------------------------------------------------
 * `cachedCatalog` 是进程内的，宿主一重启它就是空的；而此时磁盘快照
 * （`<DSH_HOME>/storages/qoder-global-catalog.json`）里明明躺着上一次的真实目录。
 * 没有预热时，唯一把它读回来的入口是 `loadQoderModelCatalog`，而它只被设置页的
 * `GET /status` / 登录 / adopt / `POST /catalog/refresh` 调用——于是**启动之后、
 * 用户第一次打开设置页之前**，`adapter.listModels` 读到的是随包兜底表（全球区
 * 15 条），模型选择器就把这一大片缺省模型摊在用户面前；等设置页被打开、那次
 * 应答背后的刷新落地，它才换成真实的两条。用户看到的是「重启后先冒出一堆假模型，
 * 点一下设置页才正常」。
 *
 * 预热把这段空窗压到进程启动的第一拍：快照是本地读，几十毫秒内就位。
 *
 * ---------------------------------------------------------------------------
 * 为什么不能 await（调用方必须 `void ... .catch()`）
 * ---------------------------------------------------------------------------
 * 第二段（`loadQoderModelCatalog`）在**没有快照**的机器上就是一次真实的上游请求：
 * 它会跟随 COSY 版本、签一次名、打一次目录端点，超时上限是 `DISCOVERY_TIMEOUT_MS`。
 * 把它 await 在插件装配里，等于让整个宿主插件的装载挂在一条可降级的网络请求上——
 * 离线、上游抽风、代理没起来，都会变成「插件装不上」，而这条线路在没有目录时本来
 * 就有一张随包兜底表可用。所以：预热是**尽力而为**，失败一律吞掉，调用方不等待。
 *
 * 有快照时它不会等网络：快照回填之后 `loadQoderModelCatalog` 走的是「陈旧缓存
 * 立刻返回 + 后台刷新」那条路（见该函数），所以正常机器的预热是毫秒级的。
 *
 * @param credentials 预热用的凭据切片。没有账号时调用方不该调用本函数。
 * @param options     与其它上游函数同一套注入缝（fetchFn / env）。
 * @returns **快照回填之后、网络刷新之前**那份目录的指纹，也就是这次预热里「上游那一版
 *   将要顶替掉的是什么」。调用方拿它当比较基线：与它不同才算「目录真的变了」。
 *   只为发一次事件而返回它，而不是让调用方自己再取一次——那样它取到的是回填**之前**
 *   的空目录，冷启动时永远「变了」，等于每次启动都无条件发事件。
 *   预热失败时返回回填后（可能仍为空）的指纹。
 */
export async function warmQoderModelCatalog(
  credentials: QoderUpstreamCredential,
  options: QoderRequestOptions = {},
): Promise<string> {
  const region = credentials.region
  let baseline = qoderCatalogFingerprint(region)
  try {
    const rehydratedAt = await rehydrateQoderCatalogFromSnapshot(region)
    // 基线取在**回填之后**：没有快照时它仍是空数组的序列化（这一次上游取到什么就是
    // 什么变化），有快照时它是快照那一版（上游与它不同才是真的变化）。
    baseline = qoderCatalogFingerprint(region)
    if (rehydratedAt > 0) {
      // 快照已经就位：这一次调用**不等网络**，它只让上游刷新跑在背后
      // （陈旧缓存分支：立刻返回旧值 + fire-and-forget 刷新）。
      void loadQoderModelCatalog(credentials, options).catch(() => undefined)
      return baseline
    }
    // 没有快照：这一次取上游是唯一能拿到真实目录的路径，值得把它做完。
    // 失败在 loadQoderModelCatalog 内部已经收敛成「旧值或空」，这里再兜一层。
    await loadQoderModelCatalog(credentials, options)
  } catch {
    // 预热没有资格让任何东西失败：插件装载、模型选择器、设置页都不等它。
  }
  return baseline
}

/**
 * TTL 缓存 + in-flight 去重 + 磁盘快照的目录读取（三层各解决一件事，
 * 照抄 step-code/client.ts 的同名结构）：
 *
 * - **TTL**：目录不是快变数据；
 * - **in-flight 去重**：同一个区域上并发的两个调用共用一次请求；
 * - **磁盘快照**（catalog-snapshot.ts）：冷启动不等网络；快照按区域分文件。
 *
 * force: true 跳过缓存与快照直接重取（设置卡片的「刷新」按钮用）。
 */
export async function loadQoderModelCatalog(
  credentials: QoderUpstreamCredential,
  options: QoderRequestOptions & { force?: boolean } = {},
): Promise<QoderCatalogEntry[]> {
  const region = credentials.region
  if (options.force === true) return refreshQoderModelCatalog(credentials, options)
  if (cachedCatalog !== undefined
    && cachedCatalog.region === region
    && Date.now() - cachedCatalog.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return cachedCatalog.entries
  }
  // 有陈旧缓存时立刻返回它并后台刷新。
  if (cachedCatalog !== undefined && cachedCatalog.region === region) {
    void refreshQoderModelCatalog(credentials, options).catch(() => undefined)
    return cachedCatalog.entries
  }
  // 快照回填与启动预热**同一处实现**（rehydrateQoderCatalogFromSnapshot）：
  // 预热已经读过的区域这里直接返回 0，不会再读一次盘。
  const rehydratedAt = await rehydrateQoderCatalogFromSnapshot(region)
  if (rehydratedAt > 0) {
    // 陈旧缓存立刻返回旧值 + 后台刷新：冷启动的第一拍就不等网络。
    void refreshQoderModelCatalog(credentials, options).catch(() => undefined)
    return cachedCatalog === undefined ? [] : cachedCatalog.entries
  }
  return refreshQoderModelCatalog(credentials, options)
}

/** 一个区域一个在飞请求；失败时退回同区域的旧缓存，绝不抛。 */
function refreshQoderModelCatalog(
  credentials: QoderUpstreamCredential,
  options: QoderRequestOptions = {},
): Promise<QoderCatalogEntry[]> {
  const region = credentials.region
  if (catalogInFlight !== null && catalogInFlightRegion === region) return catalogInFlight
  const epoch = catalogCacheEpoch
  const sameRegion = (): QoderCatalogEntry[] =>
    cachedCatalog?.region === region ? cachedCatalog.entries : []
  const request = requestQoderModelCatalog(credentials, options)
    .then((entries) => {
      // 清缓存落在飞行途中：把结果交给调用方，但不发布，也不落快照。
      if (epoch !== catalogCacheEpoch) return entries.length > 0 ? entries : sameRegion()
      if (entries.length > 0) {
        const fetchedAt = Date.now()
        cachedCatalog = { region, entries, fetchedAt }
        // 快照存**上游原始载荷**的还原（条目是解析结果；写回条目本身——快照的读取侧
        // 用 parsePersistedQoderModelEntries 再过一遍，字段缺了走兜底，与首次解析一致）。
        void writeCatalogSnapshot(
          catalogSnapshotName('qoder', region),
          entries.map(persistedQoderModelRecord),
          fetchedAt,
        )
        return entries
      }
      return sameRegion()
    })
    .catch(() => sameRegion())
  catalogInFlight = request
  catalogInFlightRegion = region
  return request.finally(() => {
    if (catalogInFlight === request) {
      catalogInFlight = null
      catalogInFlightRegion = null
    }
  })
}

// ---------------------------------------------------------------------------
// userinfo / PAT 兑换 / 令牌刷新 / 设备轮询（OpenAPI 面，plain Bearer）
// ---------------------------------------------------------------------------

/** 上游 userinfo 的账号事实。 */
export interface QoderUserInfo {
  userID: string
  email: string
  name: string
  organizationId?: string
  organizationTags?: string[]
  dataPolicyAgreed?: boolean
}

/**
 * GET {openapi}/api/v1/userinfo（Bearer job token；best-effort 字段读取，
 * 逐字 pi-provider pat.ts \`fetchUserInfo\` 的字段名）。
 *
 * 失败**抛错**（与目录不同）：调用方是登录/刷新路径，一把读不出 userinfo 的 token
 * 在 CN 会被推理面拒成「Login expired」（105），让调用方知道比静默兜底诚实。
 */
export async function fetchQoderUserInfo(
  accessToken: string,
  region: QoderRegion,
  options: QoderRequestOptions = {},
): Promise<QoderUserInfo> {
  const fetchFn = options.fetchFn ?? fetch
  const env = options.env ?? process.env
  const response = await fetchFn(openapiBaseForRegion(region, env) + USERINFO_PATH, {
    method: 'GET',
    headers: qoderOpenapiHeaders({ accessToken }),
    signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
  })
  if (!response.ok) {
    const detail = qoderErrorDetail(await response.text().catch(() => ''), 160)
    throw new Error(PROVIDER_NAME + ' userinfo 请求失败（HTTP ' + response.status + '）' + (detail === '' ? '' : '：' + detail))
  }
  const payload = (await response.json().catch(() => undefined)) as unknown
  if (!isRecord(payload)) throw new Error(PROVIDER_NAME + ' userinfo 响应不是 JSON 对象')
  // 逐字段「可能缺失」地读（计划 §9 风险 5：这份载荷没有逐字 schema）。
  const tags = Array.isArray(payload.organization_tags)
    ? payload.organization_tags.filter((tag): tag is string => typeof tag === 'string' && tag !== '')
    : undefined
  return {
    userID: asText(payload.id) ?? asText(payload.uid) ?? '',
    email: asText(payload.email) ?? '',
    name: asText(payload.name) ?? asText(payload.username) ?? '',
    ...(asText(payload.organization_id) === undefined ? {} : { organizationId: asText(payload.organization_id) }),
    ...(tags === undefined ? {} : { organizationTags: tags }),
    ...(typeof payload.data_policy_agreed === 'boolean' ? { dataPolicyAgreed: payload.data_policy_agreed } : {}),
  }
}

/** PAT 兑换的返回值。 */
export interface QoderJobTokenExchange {
  /** 短期 job token（\`jt-...\`）。 */
  token: string
  /** job refresh token（\`jrt-...\`）；上游没给时为 null。 */
  refreshToken: string | null
  /** 过期时刻（Unix 毫秒，已含安全边）。 */
  expiresAt: number
}

/**
 * 一次 PAT 兑换的失败，带 HTTP 状态（调用方据此分类「token 被拒」与「瞬时故障」）。
 */
export class QoderPatExchangeError extends Error {
  readonly status: number
  /** 兑换打的是哪个区（区域猜错是这类 400 最常见的真因）。 */
  readonly region: QoderRegion

  constructor(message: string, status: number, region: QoderRegion) {
    super(message)
    this.name = 'QoderPatExchangeError'
    this.status = status
    this.region = region
  }
}

/**
 * 上游对这个状态的回答是否在说「这把 token 不认」。
 *
 * 四个区共用一套语义：400 BadRequest 是服务端读完了 `personal_token` 才发现它
 * 不被接受（缺字段、写错字段名、空体也是 400，但那种请求来自别的实现，不来自这里）；
 * 401/403 是鉴权拒绝；404 是这套部署上没有这个 token。
 */
export function qoderPatRejectionStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404
}

/**
 * POST {openapi}/api/v1/jobToken/exchange，体 \`{"personal_token":"<pt-...>","machine_id":…}\`。
 *
 * PAT 不能直接鉴权，必须先兑换（docs.qoder.com/cli/authentication + pi-provider pat.ts）。
 * 失败抛 {@link QoderPatExchangeError}（登录路径要如实告诉用户 PAT 被拒）。
 *
 * **`machine_id` 是官方 CLI 1.1.74 的请求体字段**（qodercli2api `docs/oauth.md` §3：
 * `getMachineIdentityRequestFields` 为 exchange/refresh 补上既有 machine_id，
 * 没有 UMID 时不补 machine_token，也不拿 machine_id 冒充它）。早先按 pi-provider
 * 只发 `personal_token` 的形状在实测里仍可能被服务端接受，但没有理由不发这个官方字段。
 */
export async function exchangeQoderJobToken(
  personalToken: string,
  region: QoderRegion,
  options: QoderRequestOptions = {},
): Promise<QoderJobTokenExchange> {
  const fetchFn = options.fetchFn ?? fetch
  const env = options.env ?? process.env
  const response = await fetchFn(openapiBaseForRegion(region, env) + JOB_TOKEN_EXCHANGE_PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'cosy-version': QODER_OPENAPI_COSY_VERSION,
      'cosy-clienttype': COSY_CLIENT_TYPE,
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({ personal_token: personalToken, machine_id: resolveQoderMachineId(env) }),
    signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
  })
  if (!response.ok) {
    const detail = qoderErrorDetail(await response.text().catch(() => ''), 160)
    throw new QoderPatExchangeError(
      PROVIDER_NAME + ' PAT 兑换失败（HTTP ' + response.status + '）' + (detail === '' ? '' : '：' + detail),
      response.status,
      region,
    )
  }
  const payload = (await response.json().catch(() => undefined)) as unknown
  if (!isRecord(payload)) throw new Error(PROVIDER_NAME + ' PAT 兑换响应不是 JSON 对象')
  // 200 也可能没给 token（技能规约「200 也可能没有凭据」：看形状，不只看状态码）。
  const token = asText(payload.token)
  if (token === undefined) throw new Error(PROVIDER_NAME + ' PAT 兑换响应里没有 token')
  return {
    token,
    refreshToken: asText(payload.refresh_token) ?? null,
    expiresAt: qoderExpiresAtFrom(payload.expires_at, payload.expires_in),
  }
}

/**
 * POST {center}/algo/api/v3/user/refresh_token（Bearer access + \`{"refreshToken"}\`）。
 *
 * 逐字 pi-provider \`refreshQoderTokenForMode\` 的请求形状（live 验证）。
 * 失败抛错由调用方（号池的 refresh 钩子）分类。
 */
export async function refreshQoderAccessToken(
  credentials: { accessToken: string; refreshToken: string },
  region: QoderRegion,
  options: QoderRequestOptions = {},
): Promise<QoderJobTokenExchange> {
  const fetchFn = options.fetchFn ?? fetch
  const env = options.env ?? process.env
  const response = await fetchFn(centerBaseForRegion(region, env) + REFRESH_TOKEN_PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: 'Bearer ' + credentials.accessToken,
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({ refreshToken: credentials.refreshToken }),
    signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
  })
  if (!response.ok) {
    const error = new Error(PROVIDER_NAME + ' 令牌刷新失败（HTTP ' + response.status + '）') as Error & { status?: number }
    error.status = response.status
    throw error
  }
  const payload = (await response.json().catch(() => undefined)) as unknown
  if (!isRecord(payload)) throw new Error(PROVIDER_NAME + ' 令牌刷新响应不是 JSON 对象')
  const token = asText(payload.token)
  if (token === undefined) throw new Error(PROVIDER_NAME + ' 令牌刷新响应里没有 token')
  return {
    token,
    // token 轮换：上游给了新的就用新的，没给就留住旧的那把（pi-provider 同一规则）。
    refreshToken: asText(payload.refresh_token) ?? credentials.refreshToken,
    expiresAt: qoderExpiresAtFrom(payload.expires_at, payload.expires_in),
  }
}

// ---------------------------------------------------------------------------
// 额度（非公开个人端点；失败以值返回，绝不抛）
// ---------------------------------------------------------------------------

/** 一次额度读取的结果；失败以值返回而不是抛出（路由据此下发 quotaError）。 */
export type QoderQuotaRead =
  | { ok: true; snapshot: QoderQuotaSnapshotDto }
  | { ok: false; error: string }

/** 一只桶的归一化（org 桶的总额字段是 \`cap\` 而不是 \`total\`，逐字 pi-provider usage.ts）。 */
function normalizeQoderBucket(value: unknown, kind: QoderQuotaBucketKind): QoderQuotaBucketDto | undefined {
  if (!isRecord(value)) return undefined
  const total = asQuotaNumber(kind === 'org' ? (value.cap ?? value.total) : value.total) ?? null
  const used = asQuotaNumber(value.used) ?? null
  const remaining = asQuotaNumber(value.remaining) ?? null
  if (total === null && used === null && remaining === null) return undefined
  return {
    kind,
    total,
    used,
    remaining,
    unit: asText(value.unit) ?? null,
  }
}

/**
 * 归一化一份额度载荷。
 *
 * 一只桶都不认识时返回 undefined（上游改版或账号没有套餐）——快照不下发，
 * 卡片显示「读不出来」而不是一张全空的卡。缺失的数字保持缺失，**绝不发明**
 * （技能规约「零不是未知」）。
 */
export function normalizeQoderQuotaSnapshot(
  value: unknown,
  region: QoderRegion,
  fetchedAt: number = Date.now(),
): QoderQuotaSnapshotDto | undefined {
  if (!isRecord(value)) return undefined
  const buckets: QoderQuotaBucketDto[] = []
  const personal = normalizeQoderBucket(value.userQuota, 'personal')
  if (personal !== undefined) buckets.push(personal)
  const addOn = normalizeQoderBucket(value.addOnQuota, 'add-on')
  if (addOn !== undefined) buckets.push(addOn)
  const org = normalizeQoderBucket(value.orgResourcePackage, 'org')
  if (org !== undefined) buckets.push(org)
  // 上游另外报的两个字段：额度用尽（isQuotaExceeded）与升级页（upgradeUrl）。
  // 它们是**账号层面的事实**，不是某只桶的数字：三只桶全是 0 时上游也会说
  // 「额度已用尽」，而卡片此前只看得见 0/0，于是「额度看着还在」与「请求被拒」
  // 同时成立（issue #74）。
  const quotaExceeded = value.isQuotaExceeded === true
  const upgradeUrl = asText(value.upgradeUrl) ?? null
  // 一只桶都不认识时快照不下发（卡片显示「读不出来」而不是一张全空的卡）——
  // 但上游明说额度已用尽时除外：那是一条真事实，丢掉它卡片就会继续显示「有额度」。
  if (buckets.length === 0 && !quotaExceeded) return undefined
  // expiresAt 是 Unix 毫秒（pi-provider usage.ts 的契约注释）；越界值丢弃而不是让
  // 格式化炸掉（8.64e15 是 JS Date 的上界）。
  const expiresRaw = asQuotaNumber(value.expiresAt) ?? null
  const expiresAt = expiresRaw !== null && expiresRaw <= 8.64e15 ? expiresRaw : null
  return { buckets, expiresAt, quotaExceeded, upgradeUrl, fetchedAt, region }
}

/** 按账号记住的额度快照与在飞去重。 */
const quotaCacheByAccount = new Map<string, { snapshot: QoderQuotaSnapshotDto; fetchedAt: number }>()
let quotaInFlight: Promise<QoderQuotaRead> | null = null
let quotaInFlightAccount: string | null = null

/** 某账号最近一次读到的额度快照（纯内存读；号池装配摘要时用）。 */
export function getCachedQoderQuotaFor(accountId: string): QoderQuotaSnapshotDto | undefined {
  const entry = quotaCacheByAccount.get(accountId)
  if (entry === undefined) return undefined
  if (Date.now() - entry.fetchedAt >= QUOTA_CACHE_TTL_MS) return entry.snapshot
  return entry.snapshot
}

/** 测试与登出用：清掉内存额度缓存。 */
export function clearCachedQoderQuota(): void {
  quotaCacheByAccount.clear()
  quotaInFlight = null
  quotaInFlightAccount = null
}

/**
 * GET {openapi}/api/v2/quota/usage（Bearer job token）。
 *
 * ⚠ 非公开个人端点（计划 §5、§9 风险 1）。TTL 缓存 + 在飞去重；失败以值返回。
 * \`cacheKey\` 是号池账号 id：快照记在**账号**名下，额度跟着账号走。
 */
export async function loadQoderQuota(
  credentials: QoderUpstreamCredential,
  options: QoderRequestOptions & { force?: boolean; cacheKey?: string } = {},
): Promise<QoderQuotaRead> {
  const cacheKey = options.cacheKey ?? credentials.uid ?? credentials.accessToken
  const cached = quotaCacheByAccount.get(cacheKey)
  if (options.force !== true && cached !== undefined && Date.now() - cached.fetchedAt < QUOTA_CACHE_TTL_MS) {
    return { ok: true, snapshot: cached.snapshot }
  }
  if (quotaInFlight !== null && quotaInFlightAccount === cacheKey) return quotaInFlight
  const request = (async (): Promise<QoderQuotaRead> => {
    const fetchFn = options.fetchFn ?? fetch
    const env = options.env ?? process.env
    try {
      const response = await fetchFn(openapiBaseForRegion(credentials.region, env) + QUOTA_USAGE_PATH, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer ' + credentials.accessToken,
          'user-agent': USER_AGENT,
        },
        signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
      })
      if (!response.ok) {
        const detail = qoderErrorDetail(await response.text().catch(() => ''), 160)
        return { ok: false, error: '额度接口返回 HTTP ' + response.status + (detail === '' ? '' : '：' + detail) }
      }
      const snapshot = normalizeQoderQuotaSnapshot((await response.json().catch(() => undefined)) as unknown, credentials.region)
      if (snapshot === undefined) return { ok: false, error: '额度响应里没有认识的额度桶（上游可能改版）。' }
      quotaCacheByAccount.set(cacheKey, { snapshot, fetchedAt: Date.now() })
      return { ok: true, snapshot }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })()
  quotaInFlight = request
  quotaInFlightAccount = cacheKey
  return request.finally(() => {
    if (quotaInFlight === request) {
      quotaInFlight = null
      quotaInFlightAccount = null
    }
  })
}
