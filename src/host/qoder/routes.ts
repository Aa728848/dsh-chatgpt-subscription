/**
 * Qoder（订阅）线路的 web 路由。
 *
 * 路由表与客户端 \`src/client/qoder/api.ts\` 里那一份是**同一个约定**，两边必须逐条对上：
 *
 * \`\`\`
 * GET  /status           -> QoderStatusDto（页面的唯一读口）
 * POST /settings         QoderSettingsUpdateDto -> QoderStatusDto
 * POST /accounts         { action, accountId } / { action:'strategy', strategy } -> QoderStatusDto
 * POST /login/start      { region } -> QoderLoginFlowStatus（设备流，仅全球区）
 * GET  /login/status     -> QoderLoginFlowStatus
 * POST /login/cancel     { } -> QoderLoginFlowStatus
 * POST /login/manual     { region, token } -> QoderStatusDto（请求体带 PAT，不在冻结契约里）
 * POST /adopt            { } -> QoderAdoptResultDto（裸 DTO；失败永不阻断）
 * POST /connection/test  { } -> QoderConnectionDto（裸 DTO）
 * POST /quota            { } -> QoderStatusDto（强制刷新额度）
 * POST /catalog/refresh  { } -> QoderStatusDto
 * \`\`\`
 *
 * 信封：除 \`/adopt\` 与 \`/connection/test\` 外一律 \`{ ok, value }\`（客户端的
 * \`createLineApi\` 会把信封拆掉；那两条路由的契约把 DTO 定在顶层，所以它们直接返回 DTO）。
 *
 * 同源校验不可省：每个 POST 都过 \`isSameOriginMutation\`，与兄弟线路同一份实现。
 *
 * 本文件**不持有任何凭据，也不算任何用量**：落盘与刷新交给 token-store / account-pool /
 * oauth / adopt，上游 I/O 交给 client.ts，缓存用量的累计是 adapter.ts 的累计器。
 * 它只做三件事：读设置、组装状态面、把同源的 POST 翻译成对上面那些模块的一次调用。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ContextWindowOverridePatch } from '../common/context-window-overrides.ts'
import { QuotaRefresh } from '../common/quota-refresh.ts'
import { isSameOriginMutation } from '../common/same-origin.ts'
import type { AccountRotationStrategy } from '../../shared/account-pool-contracts.ts'
import {
  QODER_PROVIDER_ID,
  QODER_ROUTE_PREFIX,
  isQoderReasoningEffort,
  isQoderRegion,
  type QoderAccountSummaryDto,
  type QoderAdoptResultDto,
  type QoderCacheStatsDto,
  type QoderConnectionDto,
  type QoderQuotaSnapshotDto,
  type QoderRegion,
  type QoderStatusDto,
} from '../../shared/qoder-contracts.ts'
import {
  cachedQoderModelCatalog,
  convergeQoderSelection,
  readQoderCacheStats,
} from './adapter.ts'
import { adoptQoderSignIn, type QoderAdoptedCredential } from './adopt.ts'
import {
  qoderPoolStatus,
  type QoderAccountPool,
} from './account-pool.ts'
import {
  loadQoderModelCatalog,
  loadQoderQuota,
  qoderCatalogFingerprint,
  qoderCatalogIsLive,
  qoderCatalogNeedsRefresh,
  qoderCosyIdentityOf,
  qoderModelListUrl,
  warmQoderModelCatalog,
  type QoderUpstreamCredential,
} from './client.ts'
import { buildQoderCosyHeaders } from './cosy.ts'
import {
  catalogModelOptions,
  parseQoderModelListing,
  type QoderModelEntry,
} from './model-catalog.ts'
import {
  beginQoderLogin,
  getQoderLoginStatus,
  qoderCredentialsFromPat,
  resetQoderLogin,
} from './oauth.ts'
import {
  QoderCredentialStore,
  QoderModelSettingsStore,
  type QoderCredentials,
  type QoderModelSettings,
  type QoderPreferenceStore,
  type QoderSettingsPatch,
} from './token-store.ts'
import { DISCOVERY_TIMEOUT_MS, PROVIDER_NAME, regionSupportsDeviceLogin } from './types.ts'

const MAX_BODY_BYTES = 64 * 1024

/**
 * 启动预热之后盯「后台刷新有没有换掉目录」的时间上限。
 *
 * 只影响一次事件**什么时候**发出，不影响任何请求：没有变化时它一次都不会发，
 * 有变化时它让已经在跑的选择器重读一份新的目录。上游打不回来时到点就放弃，
 * 预热本身早已返回（预热从不等待网络）。
 *
 * 上限压在上游那一次目录请求的超时**之内**：正常情况下刷新一定在它之前落地
 * （或失败回落），超过这个窗口只可能是上游彻底不可达，再等也没有意义。
 */
const QODER_CATALOG_OBSERVE_MS = DISCOVERY_TIMEOUT_MS + 5_000
/** 上面那个等待的轮询间隔：目录刷新落地没有可订阅的完成信号，只能轻轮询。 */
const QODER_CATALOG_OBSERVE_POLL_MS = 100

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendMethodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { ok: false, error: 'Method Not Allowed' })
}

function sendCrossOrigin(response: ServerResponse): void {
  sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    request.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>)
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Malformed JSON request'))
      }
    })
    request.on('error', reject)
  })
}

/** 一个请求寻址的子路径（剥掉契约前缀）。 */
export function qoderSubPathOf(requestUrl: string): string {
  const pathname = new URL(requestUrl || '/', 'http://dsh.local').pathname
  if (pathname === QODER_ROUTE_PREFIX) return ''
  if (pathname.startsWith(QODER_ROUTE_PREFIX + '/')) {
    return pathname.slice(QODER_ROUTE_PREFIX.length + 1)
  }
  return pathname.replace(/^\/+/, '')
}

function readOption<T>(value: T | (() => T) | undefined, fallback: T): T {
  return typeof value === 'function' ? (value as () => T)() : value ?? fallback
}

/**
 * 设置来源：register 后端与文件后端形状不同，这里收敛成一个（与 step-code 同形）。
 */
export interface QoderSettingsSource {
  status(): QoderModelSettings | Promise<QoderModelSettings>
  update(patch: QoderSettingsPatch): Promise<QoderModelSettings>
}

function registeredSettingsSource(preferences: QoderPreferenceStore): QoderSettingsSource {
  return { status: () => preferences.status(), update: (patch) => preferences.update(patch) }
}

function fileSettingsSource(store: QoderModelSettingsStore): QoderSettingsSource {
  return { status: () => store.read(), update: (patch) => store.updateSettings(patch) }
}

/** 设置来源：register 后端优先，没有就落回凭据旁边的 JSON 文件。 */
export function qoderSettingsSource(
  preferences: QoderPreferenceStore | undefined,
  fallback: QoderModelSettingsStore,
): QoderSettingsSource {
  return preferences === undefined ? fileSettingsSource(fallback) : registeredSettingsSource(preferences)
}

export interface QoderRouteOptions {
  fetchFn?: typeof fetch
  /** 本插件是否正在服务这条 Provider 路由；每次状态都重新读。 */
  serving?: boolean | (() => boolean)
  /** 路由被别的适配器占用时的诊断文案；每次状态都重新读。 */
  conflict?: string | null | (() => string | null)
  /** 号池；本进程装了才有。 */
  accountPool?: QoderAccountPool
  /** 环境变量读取处；缺省 process.env，且**调用时**读取。 */
  env?: NodeJS.ProcessEnv
}

/** 号池凭据 → 上游面认得的切片（client.ts 的结构化超集的反向）。 */
function upstreamCredentialOf(credentials: {
  accessToken: string
  region: QoderRegion
  uid: string | null
  email: string | null
  accountName: string | null
  organizationId: string | null
  organizationTags: string[]
  dataPolicyAgreed: boolean
}): QoderUpstreamCredential {
  return {
    accessToken: credentials.accessToken,
    region: credentials.region,
    uid: credentials.uid,
    email: credentials.email,
    accountName: credentials.accountName,
    organizationId: credentials.organizationId,
    organizationTags: credentials.organizationTags,
    dataPolicyAgreed: credentials.dataPolicyAgreed,
  }
}

/** 号池切片的收紧形状（本线路状态面实际持有的那一部分）。 */
export interface QoderPoolSlice {
  accounts: QoderAccountSummaryDto[]
  rotationStrategy: AccountRotationStrategy
  activeAccountId?: string
}

export interface QoderStatusSources {
  options: QoderRouteOptions
  settings: QoderSettingsSource
  /** 下一次登录要用的区域。 */
  region: QoderRegion
  /** 号池切片：唯一装配它的地方是 account-pool 的 qoderPoolStatusSlice（这里只收紧形状）。 */
  pool: QoderPoolSlice
  /** 本次读到的账号（卡片渲染用，不带任何凭据）。 */
  account: QoderAccountSummaryDto | null
  /** 这个部署当前的模型目录（缓存读，轮询不联网）。 */
  catalog: readonly QoderModelEntry[]
  /** 本进程为当前账号记住的额度快照。 */
  quota: QoderQuotaSnapshotDto | null
  /** 本次应答背后是否正在刷新额度。 */
  quotaRefreshing: boolean
  /** 本次应答背后是否正在刷新模型目录（客户端据此排一次补读）。 */
  catalogRefreshing: boolean
  /** 上一次额度读失败的原因；没有快照可渲染时为 null。 */
  quotaError: string | null
  /** 本进程累计的缓存用量；尚无样本时为 undefined（客户端据此渲染占位符）。 */
  cacheStats: QoderCacheStatsDto | undefined
}

/**
 * 组装 \`QoderStatusDto\`。
 *
 * 号池读不出来不能带倒整张卡：连接那一半仍然值得渲染，只是账号列表是空的。
 */
export async function getQoderStatus(sources: QoderStatusSources): Promise<QoderStatusDto> {
  const { options, settings } = sources
  const settingsValue = await settings.status()
  const quota = sources.quota
  const cacheStats = sources.cacheStats
  const accountCount = sources.pool.accounts.length
  // 勾选标记与适配器的过滤读**同一份**收敛结果（adapter.ts 的 convergeQoderSelection）：
  // 残留 id 在这里也不该再被算成「可用」，否则卡片会说「已选 3 / 2」而选择器里只有两个模型。
  //
  // 而且必须与适配器**同一条规则**：兜底表阶段不按白名单筛。否则冷启动时卡片会显示
  // 「一个都没勾」（白名单是实时目录的词汇，筛兜底表必然收敛成空），而选择器里却是全部
  // 可用的——同一个状态在两张面上说两句话，用户没法据此判断该不该重勾。
  const enabledModelIds = convergeQoderSelection(
    settingsValue.enabledModelIds,
    qoderCatalogIsLive(sources.region),
    sources.catalog,
  )
  return {
    ...sources.pool,
    enabled: settingsValue.enabled !== false,
    // 「有没有凭据」以号池为准：池是路由与轮转的权威。
    authenticated: accountCount > 0,
    hasCredentials: sources.account !== null || accountCount > 0,
    providerId: QODER_PROVIDER_ID,
    storagePath: options.accountPool?.path() ?? '',
    region: sources.region,
    account: sources.account,
    quota,
    lastFetchedAt: quota === null ? null : quota.fetchedAt,
    quotaRefreshing: sources.quotaRefreshing,
    // 与 quotaRefreshing 同一条约定：应答先出去，刷新跑在它背后。
    catalogRefreshing: sources.catalogRefreshing,
    quotaError: sources.quotaError,
    models: catalogModelOptions(sources.catalog, {
      enabledModelIds,
      contextWindowOverrides: settingsValue.contextWindowOverrides,
    }),
    // 三态如实下发：null 也是一个值（客户端据此区分「没挑过」与「全关」）。
    enabledModelIds,
    contextWindowOverrides: settingsValue.contextWindowOverrides,
    defaultReasoningEffort: settingsValue.defaultReasoningEffort,
    // 登录流程的公开状态（凭据不出这一层）。
    login: getQoderLoginStatus(),
    // 「还没有样本」与「样本全是 0」必须能被区分，所以缺失就是缺失。
    ...(cacheStats === undefined ? {} : { cacheStats }),
    serving: readOption(options.serving, true),
    conflict: readOption(options.conflict, null),
  }
}

/** 请求体 → 设置补丁。自由输入的字段逐个校验，认不出的取值直接丢掉而不是猜。 */
function patchFromBody(body: Record<string, unknown>): QoderSettingsPatch {
  const patch: QoderSettingsPatch = {}
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  // 三态：`null` 是「回到不过滤」，数组（含空数组 = 全关）是显式选择。
  if (body.enabledModelIds === null) {
    patch.enabledModelIds = null
  } else if (Array.isArray(body.enabledModelIds)) {
    patch.enabledModelIds = body.enabledModelIds.filter((id): id is string => typeof id === 'string')
  }
  if (typeof body.contextWindowOverrides === 'object' && body.contextWindowOverrides !== null) {
    const overrides: ContextWindowOverridePatch = {}
    for (const [key, raw] of Object.entries(body.contextWindowOverrides as Record<string, unknown>)) {
      // null 是卡片的「恢复目录默认」，必须活过归一化才能让存储删掉恰好那个键。
      if (raw === null) overrides[key] = null
      else if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) overrides[key] = Math.floor(raw)
    }
    patch.contextWindowOverrides = overrides
  }
  if (body.defaultReasoningEffort !== undefined) {
    const effort = body.defaultReasoningEffort
    if (effort === null || isQoderReasoningEffort(effort)) patch.defaultReasoningEffort = effort
  }
  if (body.selectedAccountId !== undefined) {
    patch.selectedAccountId = typeof body.selectedAccountId === 'string' ? body.selectedAccountId : null
  }
  return patch
}

/** 请求体里的区域（认不出时回落全球区——它是唯一支持设备流的，选错时上游明确拒）。 */
function regionFromBody(body: Record<string, unknown>): QoderRegion {
  return isQoderRegion(body.region) ? body.region : 'global'
}

/**
 * 注册本线路的路由。
 *
 * 本文件不持有凭据：账号的落盘与轮转在号池，凭据由号池镜像。
 * 设置的唯一写入点是 \`POST /settings\`。
 */
export function registerQoderRoutes(
  ctx: Context,
  settings: QoderSettingsSource,
  options: QoderRouteOptions = {},
): () => void {
  const fetchFn = options.fetchFn ?? fetch
  const accountPool = options.accountPool
  const quotaRefresh = new QuotaRefresh()
  /**
   * 目录的「应答背后刷新」器，与 `quotaRefresh` 逐字同一套模式。
   *
   * 分开建而不是复用同一个实例：两者在飞的时机不同（额度 TTL 2 分钟、目录 TTL
   * 30 分钟），共用一个 pending 会让「目录正在拉」把一次该发生的额度刷新挡掉。
   *
   * 它的 `lastError` **不下发**：目录是可降级的，取不到时选择器走随包兜底表，
   * 卡片不该因此显示一句错误（见 refreshCatalog 的注释）。
   */
  const catalogRefresh = new QuotaRefresh()

  /** 上一次成功读到、属于当前账号的额度快照（纯内存）。 */
  let quotaSnapshot: QoderQuotaSnapshotDto | null = null
  /**
   * 上一次额度读失败的原因；读到快照时清空。
   *
   * 必须记下来而不是丢掉：额度是**非公开接口**，\`loadQoderQuota\` 的失败以返回值呈现
   * （不抛），所以 \`quotaRefresh.lastError()\` 看不到它。
   */
  let quotaError: string | null = null

  /**
   * 没有号池时使用的那份单凭据存储（无头 host 与测试的形态）。
   *
   * 生产路径上它**不写**：号池才是路由与轮转的权威。
   */
  const singleCredentialStore = new QoderCredentialStore()

  /**
   * 三种凭据来源各自落库：有池时进池，没有池时落到单凭据存储（无头 host 与测试的形态）。
   * 三个入口刻意分开而不是收成一个带参数的函数（与 step-code 同一条理由）。
   */
  const saveLoginCredential = async (credentials: QoderCredentials): Promise<void> => {
    if (accountPool !== undefined) {
      await accountPool.addAccount(credentials)
      return
    }
    await singleCredentialStore.write(credentials)
  }

  const saveAdoptedCredential = async (adopted: QoderAdoptedCredential): Promise<void> => {
    if (accountPool !== undefined) {
      await accountPool.addAdoptedCredential(adopted)
      return
    }
    await singleCredentialStore.write(adopted.credentials)
  }

  /**
   * 一次额度读：账号来自号池（与一次模型请求同一个账号），额度用账号自己的
   * job token 读（本线路**没有**第二张凭据——与 step-code 的 devcenter 不同）。
   *
   * 失败**不抛**：额度是非公开接口，它的失败绝不能影响模型请求（计划 §5、§9 风险 1），
   * 原因记进 \`quotaError\` 下发给卡片。
   */
  const refreshQuota = async (force: boolean): Promise<void> => {
    quotaError = null
    if (accountPool === undefined) return
    let target: Awaited<ReturnType<QoderAccountPool['getQuotaReadTarget']>> | null = null
    try {
      target = await accountPool.getQuotaReadTarget(fetchFn)
    } catch (error) {
      quotaError = messageOf(error)
      return
    }
    const read = await loadQoderQuota(upstreamCredentialOf(target.credentials), {
      fetchFn,
      force,
      // 快照记在**号池账号**名下：额度跟着账号走，账号卡才能画出自己那一行的进度。
      cacheKey: target.accountId,
      ...(options.env === undefined ? {} : { env: options.env }),
    })
    if (read.ok) {
      // 只有读到新的快照才替换：一次失败的读**不**抹掉上一次成功读到的数字。
      quotaSnapshot = read.snapshot
    } else {
      quotaError = read.error
    }
  }

  /**
   * 一次目录读：凭据来自号池，目录按区域缓存（client.ts 的注释即此意）。
   *
   * `force` 只有用户按下「刷新目录」时才为 true：那是一个显式请求，必须真的
   * 重取。自动路径一律传 false，让 `loadQoderModelCatalog` 的 TTL 与 in-flight
   * 去重生效——否则「每次打开设置页」就等于「每次打一次上游」，而这张卡片本来
   * 每 60 秒轮询一次。
   *
   * 失败一律吞掉：目录是可降级的，选择器回落随包兜底表比让卡片报错有用。
   *
   * @returns 这次读有没有**真的换掉**进程内的实时目录。调用方据此决定要不要发
   *          `llm/adapters-updated`：目录没换就没有任何订阅方需要重读，每 60 秒
   *          轮询都发一次只会让选择器每拍重建一遍。
   */
  const refreshCatalog = async (force: boolean): Promise<boolean> => {
    if (accountPool === undefined) return false
    const target = await accountPool.getQuotaReadTarget(fetchFn).catch(() => null)
    if (target === null) return false
    const region = target.credentials.region
    // 刷新**之前**那一份的指纹：只有内容真的换了才算「目录变了」。口径在 client.ts
    // 的 {@link qoderCatalogFingerprint} 里只有一处（启动预热也读它）。
    const before = qoderCatalogFingerprint(region)
    await loadQoderModelCatalog(upstreamCredentialOf(target.credentials), {
      fetchFn,
      force,
      ...(options.env === undefined ? {} : { env: options.env }),
    }).catch(() => undefined)
    return qoderCatalogFingerprint(region) !== before
  }

  /**
   * 一次目录刷新的完整副作用：读目录，真的换了就通知 DSH 重建模型选择器。
   *
   * 事件只能在这里发（目录真的换掉之后），不能放在 `POST /catalog/refresh` 的应答
   * 路径上无条件发：应答背后那次自动刷新走的也是这条路径，而它每 60 秒轮询都会被
   * 考虑一次——无条件发就等于让选择器每拍重读一次目录。
   */
  const refreshCatalogAndAnnounce = async (force: boolean): Promise<boolean> => {
    const changed = await refreshCatalog(force)
    if (changed) ctx.emit?.('llm/adapters-updated')
    return changed
  }

  /**
   * 这个部署当前要不要在应答背后顺手拉一次目录。
   *
   * 三个条件缺一不可：有号池（没有号池就没有刷新入口，`refreshCatalog` 会直接
   * 返回）、池里有账号（没有账号时上游一定会拒，白打一次）、以及缓存确实空/过期
   * （判定留在 client.ts 的 {@link qoderCatalogNeedsRefresh}，口径只有一处）。
   *
   * 区域取号池当前该展示的那一行——它与一次真实模型请求读的是同一个区域的目录。
   */
  const catalogNeedsRefresh = (pool: QoderPoolSlice, region: QoderRegion): boolean => {
    if (accountPool === undefined || pool.accounts.length === 0) return false
    return qoderCatalogNeedsRefresh(region)
  }

  /** 号池里当前该展示的那一行（active → primary → 第一行）。 */
  const pickAccount = (pool: QoderPoolSlice): QoderAccountSummaryDto | null => {
    const accounts = pool.accounts
    const id = pool.activeAccountId
      ?? accounts.find((account) => account.isPrimary)?.id
      ?? accounts[0]?.id
    return accounts.find((account) => account.id === id) ?? null
  }

  /** 号池切片（读 qoderPoolStatus，与 qoderPoolStatusSlice 是同一次读）。 */
  const poolSlice = async (): Promise<QoderPoolSlice> => {
    const status = await qoderPoolStatus(accountPool)
    return {
      accounts: status.accounts,
      rotationStrategy: status.rotationStrategy,
      ...(status.activeAccountId === undefined ? {} : { activeAccountId: status.activeAccountId }),
    }
  }

  /**
   * 组装一次状态，并顺带回答「这一次应答背后该不该拉目录」。
   *
   * 两件事刻意由同一次读决定：判定要用的号池切片与区域只有这里面有，分开再算
   * 一遍就是两次读池，而两次之间池可以变（删账号、换 active），结论就可能与
   * 这一次应答对不上。返回值而不是靠闭包变量，是因为中间隔着 await，闭包变量
   * 会被并发进来的另一次请求改写。
   */
  const readStatusWithCatalogDecision = async (): Promise<{
    status: QoderStatusDto
    catalogWanted: boolean
  }> => {
    const pool = await poolSlice()
    const account = pickAccount(pool)
    const region = account?.region ?? 'global'
    // 在读 catalog **之前**判定：cachedQoderModelCatalog 在缓存为空时会回落
    // 随包表，读完之后就再也看不出「空」了。
    const catalogWanted = catalogNeedsRefresh(pool, region)
    const status = await getQoderStatus({
      options: accountPool === undefined ? { ...options, accountPool: undefined } : options,
      settings,
      region,
      pool,
      account,
      catalog: cachedQoderModelCatalog(region),
      quota: quotaSnapshot,
      quotaRefreshing: quotaRefresh.refreshing,
      // 「正在拉」或「这次应答背后就要拉」——对客户端是同一句话：选择器里的
      // 兜底行马上会被真实目录顶掉，该排一次补读。真正的启动在应答之后。
      catalogRefreshing: catalogRefresh.refreshing || (catalogWanted && accountPool !== undefined),
      // 池里没有账号时不存在「额度读失败」这回事：探活会先报「号池中没有账号」。
      quotaError: pool.accounts.length === 0 ? null : quotaError,
      cacheStats: readQoderCacheStats(),
    })
    return { status, catalogWanted }
  }

  const readStatus = async (): Promise<QoderStatusDto> => (await readStatusWithCatalogDecision()).status

  /**
   * 登录完成后把凭据收进池，并顺手同步一次目录。
   *
   * 目录刷新是尽力而为：模型目录拿不到时选择器走随包兜底表，所以它没有资格
   * 把一次成功的登录变成一次失败的登录。
   */
  const onLoginComplete = async (credentials: QoderCredentials): Promise<void> => {
    await saveLoginCredential(credentials)
    // 登录之后目录一定换了一批（之前可能还是另一把凭据的、或者根本是兜底表），
    // 真的换了就通知选择器重读——否则用户登录完还得手动刷新一次页面才看到模型。
    await refreshCatalogAndAnnounce(true)
  }

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = qoderSubPathOf(request.url ?? '/')
    const method = request.method ?? 'GET'

    try {
      if (path === '' || path === 'status') {
        if (method !== 'GET') return sendMethodNotAllowed(response)
        // 配额刷新跑在应答**背后**：await 进来会把上游超时放进每一次轮询。
        // 没有快照可渲染时例外，那一次读必须等。
        if (options.fetchFn !== undefined && accountPool !== undefined) {
          if (quotaSnapshot === null) await quotaRefresh.run(() => refreshQuota(false))
          else quotaRefresh.start(() => refreshQuota(false))
        }
        // 状态先组装（目录此时读的是缓存/兜底表），应答再发出去，目录的刷新
        // 排在应答**背后**：
        //
        // - await 进来等于把上游目录接口的超时塞进每一次 60 秒轮询，而打开设置页
        //   的人要的是「马上看到一张卡」；目录取不到时选择器本来就有随包兜底表，
        //   晚一两秒被真实目录顶掉完全可接受。
        // - 用 `refreshCatalog(false)` 而不是 `force: true`：force 会跳过缓存与
        //   磁盘快照，于是每进一次页面就打一次上游；false 让 TTL 与 in-flight 去重
        //   生效，绝大多数轮询因此根本不发请求（这一条由测试钉住）。
        // - 判定在 readStatus 里做（它才拿得到号池切片与区域），这里只负责按结论
        //   启动。`catalogRefresh.start` 自带在飞去重，重复调用不会再发一次。
        const {
          status,
          catalogWanted,
        } = await readStatusWithCatalogDecision()
        if (catalogWanted && accountPool !== undefined) {
          catalogRefresh.start(() => refreshCatalogAndAnnounce(false))
        }
        return sendJson(response, 200, { ok: true, value: status })
      }

      if (path === 'settings') {
        if (method === 'GET') return sendJson(response, 200, { ok: true, value: await readStatus() })
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const patch = patchFromBody(await readRequestJson(request))
        // **本线路设置的唯一写入点**。先落盘再发事件。
        await settings.update(patch)
        if (patch.enabled !== undefined || patch.enabledModelIds !== undefined) {
          ctx.emit?.('llm/adapters-updated')
        }
        return sendJson(response, 200, { ok: true, value: await readStatus() })
      }

      if (path === 'accounts') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        if (accountPool === undefined) {
          return sendJson(response, 400, { ok: false, error: '账号池未安装。' })
        }
        const body = await readRequestJson(request)
        const action = typeof body.action === 'string' ? body.action : ''
        if (action === 'strategy') {
          const strategy = body.strategy
          if (strategy !== 'sequential' && strategy !== 'round-robin' && strategy !== 'sticky') {
            return sendJson(response, 400, { ok: false, error: '未知的轮转策略。' })
          }
          await accountPool.setStrategy(strategy)
          return sendJson(response, 200, { ok: true, value: await readStatus() })
        }
        const accountId = typeof body.accountId === 'string' ? body.accountId : ''
        if (accountId === '') return sendJson(response, 400, { ok: false, error: 'accountId is required.' })
        switch (action) {
          case 'set-primary':
            await accountPool.setPrimary(accountId)
            break
          case 'clear-cooldown':
            await accountPool.clearCooldown(accountId)
            break
          case 'delete':
            // 本插件只读 ~/.qoder/.auth/user，从不写它：删掉池里的一行只是删掉本插件
            // 自己的加密记录，用户的 qodercli 会话不受影响。
            await accountPool.deleteAccount(accountId)
            break
          case 'relogin':
            // 「重新登录」在 host 这一侧只能撤掉鉴权失败标记与冷却，
            // 让这一行重新参与轮转；真正的登录由卡片重新开一次流程。
            await accountPool.clearAuthFailed(accountId)
            await accountPool.clearCooldown(accountId)
            break
          default:
            return sendJson(response, 400, { ok: false, error: '未知的账号操作：' + action })
        }
        return sendJson(response, 200, { ok: true, value: await readStatus() })
      }

      if (path === 'login/start') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const region = regionFromBody(await readRequestJson(request))
        const flow = await beginQoderLogin(region, {
          ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
          ...(options.env === undefined ? {} : { env: options.env }),
          onSave: onLoginComplete,
        })
        // **只应答 URL，host 不自行开浏览器**：授权页由设置卡片自己 window.open——
        // host 再开一次就是同一张登录页出现两个页签（本仓库修过三次的缺陷，
        // test/login-opens-browser-once.test.ts 钉着它）。
        return sendJson(response, 200, { ok: true, value: flow })
      }

      if (path === 'login/status') {
        if (method !== 'GET') return sendMethodNotAllowed(response)
        // 这条 GET 只读状态：oauth.ts 自己在后台轮询。
        return sendJson(response, 200, { ok: true, value: getQoderLoginStatus() })
      }

      if (path === 'login/cancel') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        resetQoderLogin()
        return sendJson(response, 200, { ok: true, value: getQoderLoginStatus() })
      }

      if (path === 'login/manual') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const body = await readRequestJson(request)
        // 请求体带 PAT，刻意不在冻结契约里（见 contracts 的文件头），由 host 自行解析。
        const token = typeof body.token === 'string' ? body.token : ''
        if (token.trim() === '') {
          return sendJson(response, 400, { ok: false, error: '请粘贴一个 Personal Access Token（pt-...）。' })
        }
        const region = regionFromBody(body)
        // 兑换失败是**用户可见的一句话**（PAT 被拒），所以它是 400 而不是 500。
        const credentials = await qoderCredentialsFromPat(token, region, {
          fetchFn,
          ...(options.env === undefined ? {} : { env: options.env }),
        }).catch((error: unknown) => ({ error: messageOf(error) }))
        if ('error' in credentials) {
          return sendJson(response, 400, { ok: false, error: credentials.error })
        }
        await saveLoginCredential(credentials)
        await refreshCatalogAndAnnounce(true)
        return sendJson(response, 200, { ok: true, value: await readStatus() })
      }

      if (path === 'adopt') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        // adopt 永不抛（adopt.ts 的契约）：每一种失败都是 reason，卡片据此回落。
        const outcome = await adoptQoderSignIn({
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
        })
        if (outcome.adopted !== undefined) {
          await saveAdoptedCredential(outcome.adopted)
          await refreshCatalogAndAnnounce(true)
        }
        // adopt 失败**永不阻断**，所以这一条直接返回裸 DTO（信封会把它误判成一次失败）。
        return sendJson(response, 200, outcome.result as QoderAdoptResultDto)
      }

      if (path === 'connection/test') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        // 探针是**验活**而不是发一次生成请求：对目录端点做一次带凭据的 GET 并计时，
        // 便宜且不花额度。
        return sendJson(response, 200, await probeConnection(accountPool, fetchFn, options.env))
      }

      if (path === 'quota') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        // 一次失败的额度读不是一次失败的请求：契约让 quota 可空，卡片照旧渲染。
        await quotaRefresh.run(() => refreshQuota(true))
        return sendJson(response, 200, { ok: true, value: await readStatus() })
      }

      if (path === 'catalog/refresh') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        // 事件在**目录真的换掉之后**发（refreshCatalogAndAnnounce 里），不是无条件发：
        // 一次没换到新东西的刷新不该让选择器重建一遍。
        await refreshCatalogAndAnnounce(true)
        return sendJson(response, 200, { ok: true, value: await readStatus() })
      }

      return sendJson(response, 404, { ok: false, error: 'Route not found.' })
    } catch (error) {
      return sendJson(response, 500, { ok: false, error: messageOf(error) })
    }
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: QODER_ROUTE_PREFIX, handler })
  return () => {
    dispose()
  }
}

/**
 * 插件启动时的一次目录预热（**非阻塞**，调用方不许 await）。
 *
 * 解决的问题见 client.ts 的 {@link warmQoderModelCatalog}：`cachedCatalog` 是进程内
 * 的，宿主重启后它是空的，而磁盘快照里明明躺着上一次的真实目录；在用户第一次打开
 * 设置页之前，`adapter.listModels` 读到的就是随包兜底表（15 条缺省模型），模型
 * 选择器于是先把这一大片假模型摊出来，点一下设置页才恢复正常。
 *
 * 这里是**宿主侧的那一层**，它做三件 client.ts 不该知道的事：
 *
 * 1. **凭据从号池来**（`getQuotaReadTarget`，与 `refreshCatalog` 同一个入口）：
 *    目录是区域的属性，而哪个区域要看池里当前该展示的那一行。没有池、池里没有账号、
 *    取凭据失败——三种情况都安静返回，不预热，**不报错**。
 * 2. **对比预热前后的指纹**，只有目录真的换了才发 `llm/adapters-updated`：这条与
 *    `refreshCatalogAndAnnounce` 是同一条判词（client.ts 的 qoderCatalogFingerprint），
 *    否则「目录变了没有」会在两条路径上给出两个答案。绝大多数启动里快照与上游一致，
 *    一次事件都不发。没有快照时变化当场就发生；有快照时预热不等网络，变化是晚到的，
 *    由 {@link observeQoderCatalogChange} 补发（两边都以同一份指纹为基线，不会重复）。
 * 3. **全程吞错**：预热是尽力而为，它没有资格让插件装载或首次状态应答失败。
 */
export async function warmQoderCatalogOnStartup(
  ctx: Context,
  options: QoderRouteOptions = {},
): Promise<void> {
  const accountPool = options.accountPool
  if (accountPool === undefined) return
  const fetchFn = options.fetchFn ?? fetch
  // 池里没有账号时上游一定会拒：白打一次，而且启动时连凭据都读不出来。
  const target = await accountPool.getQuotaReadTarget(fetchFn).catch(() => null)
  if (target === null) return
  const region = target.credentials.region
  // 基线与结果都取自**同一个**指纹函数（client.ts 的 qoderCatalogFingerprint），
  // 与 refreshCatalogAndAnnounce 是同一条判词：目录没换就没有任何订阅方需要重读，
  // 每一拍都发只会让模型选择器反复重建。
  const baseline = await warmQoderModelCatalog(upstreamCredentialOf(target.credentials), {
    fetchFn,
    ...(options.env === undefined ? {} : { env: options.env }),
  })
  // 没有快照时预热已经把上游那一版取回来了：这一刻就是「真的变了」。
  // 有快照时预热**不等网络**，变化是晚到的（落在下面那次后台刷新里），这里不发。
  if (qoderCatalogFingerprint(region) !== baseline) ctx.emit?.('llm/adapters-updated')
  // 晚到的那一半：以**此刻**的指纹为基线，后台刷新真的换了目录才补发一次。
  // 用此刻而不是 baseline，是为了让上面已经发过的那一次不会被重发。
  void observeQoderCatalogChange(ctx, region, qoderCatalogFingerprint(region))
}

/**
 * 盯一次「后台刷新有没有真的换掉目录」，换了就发一次 `llm/adapters-updated`。
 *
 * 存在的理由是**预热不等网络**：启动那一刻缓存里是磁盘快照，上游那一版要等后台刷新
 * 落地才知道。用户此时可能已经打开了模型选择器，而它读到的还是快照那一版——目录真的
 * 变了却没人通知，选择器就会一直停在旧的一版上，直到下一拍轮询。
 *
 * 三种结局都不额外联网，也都不重复发事件：
 *
 * - 目录已经新鲜（没有快照的那条路已经把刷新跑完了）→ `qoderCatalogNeedsRefresh` 为
 *   false，直接返回；
 * - 后台刷新在飞 → 等它落地（缓存是落地才更新）再比指纹；
 * - 上游答的还是同一批 id（绝大多数启动）→ 指纹相同，**一次都不发**。
 */
async function observeQoderCatalogChange(
  ctx: Context,
  region: QoderRegion,
  before: string,
): Promise<void> {
  const deadline = Date.now() + QODER_CATALOG_OBSERVE_MS
  // 只在「确实还有一次刷新没落地或还没跑」时等：判定口径留在 client.ts，不在这里另写。
  while (qoderCatalogNeedsRefresh(region, Date.now()) && Date.now() < deadline) {
    // unref：宿主在等待窗口内退出时，这个定时器不该把进程多留 25 秒。
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, QODER_CATALOG_OBSERVE_POLL_MS)
      timer.unref?.()
    })
  }
  if (qoderCatalogFingerprint(region) !== before) ctx.emit?.('llm/adapters-updated')
}

/**
 * 显式连通性测试。
 *
 * 探针是**验活**而不是发一次生成请求：对目录端点做一次 COSY 签名的 GET 并计时，
 * 便宜且不花额度。它答「这把凭据还能不能读这个区域的目录」，
 * 答不了「这个模型能不能被调用」——后者要花一次真实生成，交给用户发第一条消息。
 *
 * 失败一律变成一个可读的 \`error\` 字段而不是抛出：这张卡要显示的就是这句话。
 */
async function probeConnection(
  accountPool: QoderAccountPool | undefined,
  fetchFn: typeof fetch,
  env: NodeJS.ProcessEnv | undefined,
): Promise<QoderConnectionDto> {
  const checkedAt = Date.now()
  const target = accountPool === undefined ? null : await accountPool.getQuotaReadTarget(fetchFn).catch(() => null)
  if (target === null) {
    return {
      connected: false,
      latencyMs: 0,
      account: null,
      model: null,
      checkedAt,
      error: '还没有登录 ' + PROVIDER_NAME + ' 账号。',
    }
  }
  const credentials = upstreamCredentialOf(target.credentials)
  const started = Date.now()
  try {
    const url = qoderModelListUrl(credentials.region, env ?? process.env)
    const headers = buildQoderCosyHeaders(qoderCosyIdentityOf(credentials, env ?? process.env), {
      encodedBody: '',
      url,
      accept: 'application/json',
      withContentType: false,
    })
    const response = await fetchFn(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return {
        connected: false,
        latencyMs: Date.now() - started,
        account: null,
        model: null,
        checkedAt,
        error: '目录接口返回 HTTP ' + response.status
          + (detail === '' ? '' : '：' + detail.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 160)),
      }
    }
    // 只解析、不发布：探针的结果不进目录缓存（缓存由 refreshCatalog 负责写盘与去重）。
    const entries = parseQoderModelListing(await response.json().catch(() => undefined) as unknown, credentials.region)
    const accounts = await accountPool!.listAccounts().catch(() => [])
    return {
      connected: true,
      latencyMs: Date.now() - started,
      account: accounts.find((entry) => entry.id === target.accountId) ?? null,
      model: entries[0]?.id ?? null,
      checkedAt,
    }
  } catch (error) {
    return {
      connected: false,
      latencyMs: Date.now() - started,
      account: null,
      model: null,
      checkedAt,
      error: messageOf(error),
    }
  }
}
