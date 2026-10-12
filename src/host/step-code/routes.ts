/**
 * Step Code（Step Plan 订阅）线路的 web 路由。
 *
 * 路由表与客户端 `src/client/step-code/api.ts` 里那一份是**同一个约定**，两边必须逐条对上：
 *
 * ```
 * GET  /status           -> StepCodeStatusDto（页面的唯一读口）
 * POST /settings         StepCodeSettingsUpdateDto -> StepCodeStatusDto
 * POST /accounts         { action, accountId } / { action:'strategy', strategy } -> StepCodeStatusDto
 * POST /login/start      { profile } -> StepCodeLoginFlowStatus
 * GET  /login/status     -> StepCodeLoginFlowStatus
 * POST /login/cancel     { } -> StepCodeLoginFlowStatus
 * POST /login/manual     { profile, apiKey } -> StepCodeStatusDto（请求体带凭据，不在冻结契约里）
 * POST /adopt            { } -> StepCodeAdoptResultDto
 * POST /connection/test  { } -> StepCodeConnectionDto
 * POST /quota            { } -> StepCodeStatusDto（强制刷新额度）
 * POST /catalog/refresh  { } -> StepCodeStatusDto
 * POST /quota/credential { mode:'password'|'manual'|'clear', account?, password?, token? } -> StepCodeStatusDto
 * ```
 *
 * 信封：除 `/adopt` 与 `/connection/test` 外一律 `{ ok, value }`，因为客户端走的
 * `createLineApi` 会把信封拆掉、直接把 `value` 当 DTO 用；这两条路由的契约把 DTO 定在
 * 顶层，所以它们**直接**返回 DTO（`createLineApi` 对没有布尔 `ok` 的应答原样返回整体）。
 *
 * 同源校验不可省：每个 POST 都过 `isSameOriginMutation`，与兄弟线路同一份实现。
 *
 * 本文件**不持有任何凭据，也不算任何用量**：落盘与兑换交给 token-store / account-pool /
 * oauth / adopt，上游 I/O 交给 client.ts，额度快照的累计交给 adapter.ts 的缓存累计器。
 * 它只做三件事：读设置、组装状态面、把同源的 POST 翻译成对上面那些模块的一次调用。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import type { ContextWindowOverridePatch } from '../common/context-window-overrides.ts'
import { QuotaRefresh } from '../common/quota-refresh.ts'
import { isSameOriginMutation } from '../common/same-origin.ts'
import type { AccountRotationStrategy } from '../../shared/account-pool-contracts.ts'
import {
  STEP_CODE_PROVIDER_ID,
  STEP_CODE_ROUTE_PREFIX,
  isStepCodeReasoningEffort,
  type StepCodeAccountSummaryDto,
  type StepCodeAdoptResultDto,
  type StepCodeCacheStatsDto,
  type StepCodeConnectionDto,
  type StepCodeLoginFlowStatus,
  type StepCodeProfile,
  type StepCodeQuotaCredentialStatusDto,
  type StepCodeQuotaSnapshotDto,
  type StepCodeStatusDto,
} from '../../shared/step-code-contracts.ts'
import {
  cachedStepCodeModelCatalog,
  readStepCodeCacheStats,
} from './adapter.ts'
import { adoptStepCodeSignIn, type StepCodeAdoptedCredential } from './adopt.ts'
import {
  stepCodePoolStatus,
  type StepCodeAccountPool,
} from './account-pool.ts'
import {
  OASIS_MANUAL_PASTE_HINT,
  loadStepModelCatalog,
  loadStepQuota,
  manualStepCodeQuotaCredential,
  parseStepModelCatalog,
  signInOasisQuotaCredential,
  stepCodeErrorDetail,
  stepCodeModelHeaders,
  stepModelCatalogUrl,
  type StepCodeQuotaCredential as StepCodeQuotaReadCredential,
  type StepCodeUpstreamCredential,
} from './client.ts'
import { catalogModelOptions, type StepCodeModelEntry } from './model-catalog.ts'
import {
  beginStepCodeLogin,
  getStepCodeLoginStatus,
  resetStepCodeLogin,
  stepCodeCredentialFromApiKey,
  type StepCodeStoredCredential,
} from './oauth.ts'
import {
  StepCodeCredentialStore,
  StepCodeModelSettingsStore,
  StepCodeQuotaCredentialStore,
  credentialsFromAdopt,
  credentialsFromApiKey,
  credentialsFromLogin,
  type StepCodeModelSettings,
  type StepCodePreferenceStore,
  type StepCodeQuotaCredential as StoredQuotaCredential,
  type StepCodeSettingsPatch,
} from './token-store.ts'
import { DEFAULT_PROFILE, DISCOVERY_TIMEOUT_MS, PROVIDER_NAME, normalizeProfile } from './types.ts'

const MAX_BODY_BYTES = 64 * 1024

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

/** 一次尝试的结果；失败以值返回而不是抛出，好让路由把它答成 400 而不是 500。 */
type Attempt<T> = { ok: true; value: T } | { ok: false; error: string }

async function attempt<T>(run: () => T | Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
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
export function stepCodeSubPathOf(requestUrl: string): string {
  const pathname = new URL(requestUrl || '/', 'http://dsh.local').pathname
  if (pathname === STEP_CODE_ROUTE_PREFIX) return ''
  if (pathname.startsWith(STEP_CODE_ROUTE_PREFIX + '/')) {
    return pathname.slice(STEP_CODE_ROUTE_PREFIX.length + 1)
  }
  return pathname.replace(/^\/+/, '')
}

function readOption<T>(value: T | (() => T) | undefined, fallback: T): T {
  return typeof value === 'function' ? (value as () => T)() : value ?? fallback
}

/**
 * 设置来源：register 后端与文件后端形状不同，这里收敛成一个。
 *
 * `status()` 允许是 promise：文件后端要读盘，而卡片每 60 秒轮询一次状态。
 * register 后端同步返回，实现方不必知道自己被允许同步。
 */
export interface StepCodeSettingsSource {
  status(): StepCodeModelSettings | Promise<StepCodeModelSettings>
  update(patch: StepCodeSettingsPatch): Promise<StepCodeModelSettings>
}

function registeredSettingsSource(preferences: StepCodePreferenceStore): StepCodeSettingsSource {
  return { status: () => preferences.status(), update: (patch) => preferences.update(patch) }
}

function fileSettingsSource(store: StepCodeModelSettingsStore): StepCodeSettingsSource {
  return { status: () => store.read(), update: (patch) => store.updateSettings(patch) }
}

/** 设置来源：register 后端优先，没有就落回凭据旁边的 JSON 文件。 */
export function stepCodeSettingsSource(
  preferences: StepCodePreferenceStore | undefined,
  fallback: StepCodeModelSettingsStore,
): StepCodeSettingsSource {
  return preferences === undefined ? fileSettingsSource(fallback) : registeredSettingsSource(preferences)
}

/**
 * 用平台默认浏览器打开一个 URL（尽力而为）。
 *
 * 与其余各线路同一份形状。启动失败是可恢复的：同一个 URL 始终在登录状态里，
 * 卡片也把它渲染成一个可点的链接，所以这里**永远不抛**。
 */
/**
 * 用系统默认程序打开一个 URL。
 *
 * 它**不是**默认行为（见下面 `registerStepCodeRoutes` 里那句「缺省不开浏览器」）：
 * 授权页由设置卡片自己打开，host 只在显式注入 `openBrowser` 时才代劳——需要这种行为的
 * 部署可以直接把这个函数作为注入口传进去，而不是让每条线路各自复制一份 spawn 逻辑。
 */
export function openPlatformBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref()
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', '"' + url + '"'], {
        stdio: 'ignore',
        detached: true,
        windowsVerbatimArguments: true,
      }).on('error', () => undefined).unref()
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref()
    }
  } catch {
    // 尽力而为：URL 同时在登录状态里，用户可以自己打开。
  }
}

/**
 * 开流请求里的客户端版本（上游只拿它做审计，从不参与鉴权）。
 *
 * 如实读本包自己的 `package.json`；读不到时留 undefined，让 oauth.ts 上报
 * `0.0.0-unknown`——编一个像真的版本号只会在排障时误导人。
 */
let pluginVersion: string | undefined | null = null
function clientVersion(): string | undefined {
  if (pluginVersion === null) {
    try {
      const manifest = createRequire(import.meta.url)('../package.json') as { version?: unknown }
      pluginVersion = typeof manifest.version === 'string' ? manifest.version : undefined
    } catch {
      pluginVersion = undefined
    }
  }
  return pluginVersion ?? undefined
}

export interface StepCodeRouteOptions {
  fetchFn?: typeof fetch
  /** 本插件是否正在服务这条 Provider 路由；每次状态都重新读。 */
  serving?: boolean | (() => boolean)
  /** 路由被别的适配器占用时的诊断文案；每次状态都重新读。 */
  conflict?: string | null | (() => string | null)
  /** 号池；本进程装了才有。 */
  accountPool?: StepCodeAccountPool
  /** 额度凭据的存储；缺省按平台加密矩阵落在自己的文件上。 */
  quotaCredentialStore?: StepCodeQuotaCredentialStore
  /**
   * 打开授权页的方式；缺省用平台默认浏览器。
   *
   * 显式传入一个空函数就把这条外部副作用整个摘掉（测试的用法，与 GLM 的注入口同形）。
   * 卡片自己也会 `window.open` 同一个链接，所以注入空函数就能只留一处开浏览器的地方。
   */
  openBrowser?: (url: string) => void
  /** 环境变量读取处；缺省 process.env，且**调用时**读取。 */
  env?: NodeJS.ProcessEnv
}

/** 号池凭据 → 上游面认得的三件事（client.ts 的结构化超集）。 */
function upstreamCredentialOf(credentials: { access: string; profile: StepCodeProfile; uid?: string }): StepCodeUpstreamCredential {
  return {
    apiKey: credentials.access,
    profile: credentials.profile,
    ...(credentials.uid === undefined ? {} : { uid: credentials.uid }),
  }
}

/** 落盘的额度凭据 → 上游读额度要的那一份（account 缺失时不构造这个键）。 */
function quotaReadCredentialOf(stored: StoredQuotaCredential): StepCodeQuotaReadCredential {
  return {
    token: stored.token,
    deviceId: stored.deviceId,
    source: stored.source,
    ...(stored.account === null ? {} : { account: stored.account }),
    ...(stored.expiresAt === null ? {} : { expiresAt: stored.expiresAt }),
  }
}

/** 额度凭据的**状态**（不是凭据本身）；凭据永远不过这条边界。 */
function quotaCredentialStatusOf(
  stored: StoredQuotaCredential | null,
  error: string | null,
): StepCodeQuotaCredentialStatusDto {
  if (stored === null) {
    return { hasCredential: false, source: null, account: null, expiresAt: null, error }
  }
  return {
    hasCredential: true,
    source: stored.source,
    account: stored.account,
    expiresAt: stored.expiresAt,
    error,
  }
}

/** 号池切片的收紧形状（本线路状态面实际持有的那一部分）。 */
export interface StepCodePoolSlice {
  accounts: StepCodeAccountSummaryDto[]
  rotationStrategy: AccountRotationStrategy
  activeAccountId?: string
}

export interface StepCodeStatusSources {
  options: StepCodeRouteOptions
  settings: StepCodeSettingsSource
  /** 下一次登录要用的 profile（区域由它唯一决定）。 */
  profile: StepCodeProfile
  /** 号池切片：唯一装配它的地方是 account-pool 的 stepCodePoolStatusSlice（这里只收紧形状）。 */
  pool: StepCodePoolSlice
  /** 本次读到的账号（卡片渲染用，不带任何凭据）。 */
  account: StepCodeAccountSummaryDto | null
  /** 这个部署当前的模型目录（缓存读，轮询不联网）。 */
  catalog: readonly StepCodeModelEntry[]
  /** 本进程为当前账号记住的额度快照。 */
  quota: StepCodeQuotaSnapshotDto | null
  /** 额度凭据的状态切片。 */
  quotaCredential: StepCodeQuotaCredentialStatusDto
  /** 本次应答背后是否正在刷新额度。 */
  quotaRefreshing: boolean
  /** 上一次额度读失败的原因；没有快照可渲染时为 null。 */
  quotaError: string | null
  /** 本进程累计的缓存用量；尚无样本时为 undefined（客户端据此渲染占位符）。 */
  cacheStats: StepCodeCacheStatsDto | undefined
}

/**
 * 组装 `StepCodeStatusDto`。
 *
 * 号池读不出来不能带倒整张卡：连接那一半仍然值得渲染，只是账号列表是空的。
 */
export async function getStepCodeStatus(sources: StepCodeStatusSources): Promise<StepCodeStatusDto> {
  const { options, settings } = sources
  const settingsValue = await settings.status()
  const quota = sources.quota
  const cacheStats = sources.cacheStats
  const accountCount = sources.pool.accounts.length
  return {
    ...sources.pool,
    enabled: settingsValue.enabled !== false,
    // 「有没有凭据」以号池为准：池是路由与轮转的权威。
    authenticated: accountCount > 0,
    hasCredentials: sources.account !== null || accountCount > 0,
    providerId: STEP_CODE_PROVIDER_ID,
    storagePath: options.accountPool?.path() ?? '',
    profile: sources.profile,
    account: sources.account,
    quota,
    lastFetchedAt: quota === null ? null : quota.fetchedAt,
    quotaRefreshing: sources.quotaRefreshing,
    quotaError: sources.quotaError,
    models: catalogModelOptions(sources.catalog, {
      enabledModelIds: settingsValue.enabledModelIds,
      contextWindowOverrides: settingsValue.contextWindowOverrides,
    }),
    contextWindowOverrides: settingsValue.contextWindowOverrides,
    defaultReasoningEffort: settingsValue.defaultReasoningEffort,
    // 登录流程的公开状态（凭据不出这一层）。
    login: getStepCodeLoginStatus(),
    quotaCredential: sources.quotaCredential,
    cacheRequestParams: settingsValue.cacheRequestParams === true,
    // 「还没有样本」与「样本全是 0」必须能被区分，所以缺失就是缺失。
    ...(cacheStats === undefined ? {} : { cacheStats }),
    serving: readOption(options.serving, true),
    conflict: readOption(options.conflict, null),
  }
}

/** 请求体 → 设置补丁。自由输入的字段逐个校验，认不出的取值直接丢掉而不是猜。 */
function patchFromBody(body: Record<string, unknown>): StepCodeSettingsPatch {
  const patch: StepCodeSettingsPatch = {}
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  if (Array.isArray(body.enabledModelIds)) {
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
    if (effort === null || isStepCodeReasoningEffort(effort)) patch.defaultReasoningEffort = effort
  }
  if (body.selectedAccountId !== undefined) {
    patch.selectedAccountId = typeof body.selectedAccountId === 'string' ? body.selectedAccountId : null
  }
  if (typeof body.cacheRequestParams === 'boolean') patch.cacheRequestParams = body.cacheRequestParams
  return patch
}

/** 请求体里的 profile（认不出时回落默认部署）。 */
function profileFromBody(body: Record<string, unknown>): StepCodeProfile {
  return normalizeProfile(body.profile) ?? DEFAULT_PROFILE
}

/**
 * 注册本线路的路由。
 *
 * 本文件不持有凭据：账号的落盘与轮转在号池，额度凭据在它自己那份加密存储里，
 * 而线路凭据由号池镜像。设置的唯一写入点是 `POST /settings`。
 */
export function registerStepCodeRoutes(
  ctx: Context,
  settings: StepCodeSettingsSource,
  options: StepCodeRouteOptions = {},
): () => void {
  const fetchFn = options.fetchFn ?? fetch
  const accountPool = options.accountPool
  const quotaRefresh = new QuotaRefresh()
  const quotaStore = options.quotaCredentialStore ?? new StepCodeQuotaCredentialStore()
  // 缺省**不开浏览器**：授权页由设置卡片自己 `window.open`（见
  // client/step-code/useStepCodeSection.ts），host 再开一次就是同一张登录页出现两个页签。
  // 这是本仓库已经修过三次的缺陷，`test/login-opens-browser-once.test.ts` 文件头逐字写着
  // 「Claude、Command Code、GLM 的 host 都曾经在 /login 里把同一个 URL 再开一次，于是每次
  // 登录都弹出两个一模一样的页面」。`/login/start` 仍然把 authorizeUrl 下发（/login/status
  // 也读得到），所以在没有 window.open 的宿主里用户照样能点那个链接。
  // 需要 host 代劳的部署可以显式注入 `openBrowser`。
  const open = options.openBrowser ?? (() => undefined)

  /** 上一次成功读到、属于当前账号的额度快照（纯内存）。 */
  let quotaSnapshot: StepCodeQuotaSnapshotDto | null = null
  /**
   * 上一次额度读失败的原因；读到快照时清空。
   *
   * 必须记下来而不是丢掉：额度面是**非公开接口**，`loadStepQuota` 的失败以返回值呈现
   * （不抛），所以 `quotaRefresh.lastError()` 看不到它。
   */
  let quotaError: string | null = null
  /** 额度凭据的缓存：undefined = 还没读过一次（读盘 + 解密，不必每次轮询都做一遍）。 */
  let quotaCredential: StoredQuotaCredential | null | undefined

  const readQuotaCredential = async (): Promise<StoredQuotaCredential | null> => {
    if (quotaCredential === undefined) {
      quotaCredential = await quotaStore.read().catch(() => null)
    }
    return quotaCredential
  }

  /**
   * 没有号池时使用的那份单凭据存储（无头 host 与测试的形态）。
   *
   * 生产路径上它**不写**：号池才是路由与轮转的权威，settings.update 之外没有任何理由
   * 去动这份镜像。
   */
  const singleCredentialStore = new StepCodeCredentialStore()

  /**
   * 三种凭据来源各自落库：有池时进池，没有池时落到单凭据存储（无头 host 与测试的形态）。
   *
   * 两条路径的凭据形状不同（号池存 oauth 形状，单凭据存储存本线路自己的落盘形状），
   * 所以各自用 `account-pool` / `token-store` 自己的装配函数，绝不互相代写。
   * 三个入口刻意分开而不是收成一个带参数的函数：
   * 「登录来的」「粘贴来的」「adopt 来的」在号池里落的是不同的入口（来源标记不同），
   * 合成一个就会在某一次调用里用错名字。
   */
  const saveLoginCredential = async (credentials: StepCodeStoredCredential): Promise<void> => {
    if (accountPool !== undefined) {
      await accountPool.addAccount(credentials)
      return
    }
    await singleCredentialStore.write(credentialsFromLogin({
      apiKey: credentials.access,
      profile: credentials.profile,
      uid: credentials.uid,
    }))
  }

  const savePastedCredential = async (credentials: StepCodeStoredCredential): Promise<void> => {
    if (accountPool !== undefined) {
      await accountPool.addApiKeyCredential(credentials)
      return
    }
    await singleCredentialStore.write(credentialsFromApiKey({
      apiKey: credentials.access,
      profile: credentials.profile,
    }))
  }

  const saveAdoptedCredential = async (adopted: StepCodeAdoptedCredential): Promise<void> => {
    if (accountPool !== undefined) {
      await accountPool.addAdoptedCredential(adopted)
      return
    }
    await singleCredentialStore.write(credentialsFromAdopt({
      apiKey: adopted.credentials.access,
      profile: adopted.credentials.profile,
      uid: adopted.credentials.uid,
      sourcePath: adopted.sourcePath ?? '',
    }))
  }

  /**
   * 一次额度读：账号来自号池（与一次模型请求同一个账号），开发者中心凭据来自它自己的存储。
   *
   * 失败**不抛**：额度是非公开接口，它的失败绝不能影响模型请求（计划 §5、§10 风险 1），
   * 原因记进 `quotaError` 下发给卡片。
   */
  const refreshQuota = async (force: boolean): Promise<void> => {
    quotaError = null
    if (accountPool === undefined) return
    let target: Awaited<ReturnType<StepCodeAccountPool['getQuotaReadTarget']>> | null = null
    try {
      target = await accountPool.getQuotaReadTarget(fetchFn)
    } catch (error) {
      quotaError = messageOf(error)
      return
    }
    const stored = await readQuotaCredential()
    if (stored === null) {
      quotaError = PROVIDER_NAME + ' 还没有开发者中心凭据，额度读不了。' + OASIS_MANUAL_PASTE_HINT
      return
    }
    const read = await loadStepQuota(quotaReadCredentialOf(stored), target.profile, {
      fetchFn,
      force,
      // 快照记在**号池账号**名下：额度跟着账号走，账号卡才能画出自己那一行的进度。
      cacheKey: target.accountId,
      ...(options.env === undefined ? {} : { env: options.env }),
    })
    if (read.ok) {
      // 只有读到新的快照才替换：一次失败的读**不**抹掉上一次成功读到的数字。
      // 契约让 quota 与 quotaError 并列给出而不是互相取代，原因就在这里——
      // 「额度读失败」与「没有额度数据」对用户是两件事。
      quotaSnapshot = read.snapshot
    } else {
      quotaError = read.error
    }
  }

  /** 一次目录读：凭据来自号池，目录按 profile 缓存（client.ts 的注释即此意）。 */
  const refreshCatalog = async (force: boolean): Promise<void> => {
    if (accountPool === undefined) return
    const target = await accountPool.getQuotaReadTarget(fetchFn).catch(() => null)
    if (target === null) return
    await loadStepModelCatalog(upstreamCredentialOf(target.credentials), {
      fetchFn,
      force,
      ...(options.env === undefined ? {} : { env: options.env }),
    }).catch(() => undefined)
  }

  /** 号池里当前该展示的那一行（active → primary → 第一行）。 */
  const pickAccount = (pool: StepCodePoolSlice): StepCodeAccountSummaryDto | null => {
    const accounts = pool.accounts
    const id = pool.activeAccountId
      ?? accounts.find((account) => account.isPrimary)?.id
      ?? accounts[0]?.id
    return accounts.find((account) => account.id === id) ?? null
  }

  /**
   * 号池切片。
   *
   * 读的是 `stepCodePoolStatus`：它与 `stepCodePoolStatusSlice` 是同一次读
   * （后者就是前者取三个键），但返回类型没有被冻结契约的 `Partial<AccountPoolStatusDto>`
   * 放宽，于是这里拿到的仍然是**带 profile / region 的** `StepCodeAccountSummaryDto`，
   * 而不是要再断言一次才能喂给 `StepCodeStatusDto.account` 的基类摘要。
   */
  const poolSlice = async (): Promise<StepCodePoolSlice> => {
    const status = await stepCodePoolStatus(accountPool)
    return {
      accounts: status.accounts,
      rotationStrategy: status.rotationStrategy,
      ...(status.activeAccountId === undefined ? {} : { activeAccountId: status.activeAccountId }),
    }
  }

  const readStatus = async (): Promise<StepCodeStatusDto> => {
    const pool = await poolSlice()
    const account = pickAccount(pool)
    const profile = account?.profile ?? DEFAULT_PROFILE
    const stored = await readQuotaCredential()
    return await getStepCodeStatus({
      options: accountPool === undefined ? { ...options, accountPool: undefined } : options,
      settings,
      profile,
      pool,
      account,
      catalog: cachedStepCodeModelCatalog(profile),
      quota: quotaSnapshot,
      quotaCredential: quotaCredentialStatusOf(stored, quotaError),
      quotaRefreshing: quotaRefresh.refreshing,
      // 池里没有账号时不存在「额度读失败」这回事：探活会先报「号池中没有账号」，
      // 把它当成额度失败会在未登录的卡片上凭空多一句红字。
      quotaError: pool.accounts.length === 0 ? null : quotaError,
      cacheStats: readStepCodeCacheStats(),
    })
  }

  /**
   * 登录完成后把凭据收进池，并顺手同步一次目录。
   *
   * 目录刷新是尽力而为：模型目录拿不到时选择器变宽而不是消失，所以它没有资格
   * 把一次成功的登录变成一次失败的登录。
   */
  const onLoginComplete = async (credentials: StepCodeStoredCredential): Promise<void> => {
    await saveLoginCredential(credentials)
    await refreshCatalog(true)
  }

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = stepCodeSubPathOf(request.url ?? '/')
    const method = request.method ?? 'GET'

    try {
      if (path === '' || path === 'status') {
        if (method !== 'GET') return sendMethodNotAllowed(response)
        // 配额刷新跑在应答**背后**：await 进来会把上游超时放进每一次轮询，
        // 而这张卡是被轮询的。没有快照可渲染时例外，那一次读必须等。
        if (options.fetchFn !== undefined && accountPool !== undefined) {
          if (quotaSnapshot === null) await quotaRefresh.run(() => refreshQuota(false))
          else quotaRefresh.start(() => refreshQuota(false))
        }
        return sendJson(response, 200, { ok: true, value: await readStatus() })
      }

      if (path === 'settings') {
        if (method === 'GET') return sendJson(response, 200, { ok: true, value: await readStatus() })
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const patch = patchFromBody(await readRequestJson(request))
        // **本线路设置的唯一写入点**。先落盘再发事件：适配器读的就是这份设置，
        // 事件只负责让 DSH 重建模型选择器。
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
            // 本插件只读 ~/.stepcode/auth.json，从不写它：删掉池里的一行只是删掉本插件
            // 自己的加密记录，用户的 stepcode 会话不受影响。
            await accountPool.deleteAccount(accountId)
            break
          case 'relogin':
            // 本线路没有刷新接口，所以「重新登录」在 host 这一侧只能撤掉鉴权失败标记与冷却，
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
        const profile = profileFromBody(await readRequestJson(request))
        const flow = await beginStepCodeLogin(profile, {
          ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(clientVersion() === undefined ? {} : { version: clientVersion() }),
          onSave: onLoginComplete,
        })
        sendJson(response, 200, { ok: true, value: flow })
        // **URL 先下发、再尝试打开浏览器**：authorizeUrl 始终在上面的应答里，
        // 所以开不开得起来用户都还有同一个可点的链接；而反过来先开窗口再下发，
        // 用户会在应答到达之前看到一个不知道该干什么的页面。
        if (flow.status === 'pending' && typeof flow.authorizeUrl === 'string' && flow.authorizeUrl !== '') {
          open(flow.authorizeUrl)
        }
        return
      }

      if (path === 'login/status') {
        if (method !== 'GET') return sendMethodNotAllowed(response)
        // 这条 GET 只读状态：oauth.ts 自己在后台轮询（且不擅自轮询——用户关掉设置页之后
        // host 就该停下），所以这里不需要像某些兄弟线路那样顺带推进状态机。
        return sendJson(response, 200, { ok: true, value: getStepCodeLoginStatus() })
      }

      if (path === 'login/cancel') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        resetStepCodeLogin()
        return sendJson(response, 200, { ok: true, value: getStepCodeLoginStatus() })
      }

      if (path === 'login/manual') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const body = await readRequestJson(request)
        // 请求体带凭据，刻意不在冻结契约里（见 contracts 的文件头），由 host 自行解析。
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey : ''
        if (apiKey.trim() === '') {
          return sendJson(response, 400, { ok: false, error: '请粘贴一个 Platform API Key。' })
        }
        const profile = profileFromBody(body)
        const credentials = stepCodeCredentialFromApiKey(profile, apiKey)
        await savePastedCredential(credentials)
        await refreshCatalog(true)
        return sendJson(response, 200, { ok: true, value: await readStatus() })
      }

      if (path === 'adopt') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        // adopt 永不抛（adopt.ts 的契约）：每一种失败都是 reason，卡片据此回落浏览器登录。
        const outcome = await adoptStepCodeSignIn(
          options.env === undefined ? {} : { env: options.env },
        )
        if (outcome.adopted !== undefined) {
          await saveAdoptedCredential(outcome.adopted)
          await refreshCatalog(true)
        }
        // adopt 失败**永不阻断**，所以这一条直接返回裸 DTO（信封会把它误判成一次失败）。
        return sendJson(response, 200, outcome.result as StepCodeAdoptResultDto)
      }

      if (path === 'connection/test') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        // 探针是**验活**而不是发一次生成请求：它便宜、不花额度。
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
        await refreshCatalog(true)
        return sendJson(response, 200, { ok: true, value: await readStatus() })
      }

      if (path === 'quota/credential') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const body = await readRequestJson(request)
        const mode = typeof body.mode === 'string' ? body.mode : ''
        const pool = await poolSlice()
        const profile = pickAccount(pool)?.profile ?? DEFAULT_PROFILE
        if (mode === 'clear') {
          await quotaStore.delete()
          quotaCredential = null
        } else if (mode === 'password') {
          const account = typeof body.account === 'string' ? body.account.trim() : ''
          // 密码只在这一行活着：它进 signIn 的入参，不进任何 DTO、不进日志、不落盘。
          const password = typeof body.password === 'string' ? body.password : ''
          if (account === '') return sendJson(response, 400, { ok: false, error: '请填写账号。' })
          if (password === '') return sendJson(response, 400, { ok: false, error: '请填写密码。' })
          // 上游登录失败是**用户可见的一句话**（OasisSignInError 还带着手动粘贴兜底的提示），
          // 所以它是 400 而不是 500：卡片要显示的就是这句话。
          const signed = await attempt(() => signInOasisQuotaCredential({
            profile,
            account,
            password,
            fetchFn,
            ...(options.env === undefined ? {} : { env: options.env }),
          }))
          if (!signed.ok) return sendJson(response, 400, { ok: false, error: signed.error })
          const credential = signed.value
          const stored: StoredQuotaCredential = {
            token: credential.token,
            deviceId: credential.deviceId,
            account: credential.account ?? account,
            source: credential.source,
            expiresAt: credential.expiresAt ?? null,
          }
          await quotaStore.write(stored)
          quotaCredential = stored
        } else if (mode === 'manual') {
          const token = typeof body.token === 'string' ? body.token : ''
          const account = typeof body.account === 'string' ? body.account.trim() : ''
          // 同上：粘贴的 token 解析不出来时，那句话本身就是给用户的诊断。
          const pasted = await attempt(() => manualStepCodeQuotaCredential(token, account === '' ? {} : { account }))
          if (!pasted.ok) return sendJson(response, 400, { ok: false, error: pasted.error })
          const credential = pasted.value
          const stored: StoredQuotaCredential = {
            token: credential.token,
            deviceId: credential.deviceId,
            account: credential.account ?? null,
            source: credential.source,
            expiresAt: credential.expiresAt ?? null,
          }
          await quotaStore.write(stored)
          quotaCredential = stored
        } else {
          return sendJson(response, 400, { ok: false, error: '未知的额度凭据提交方式：' + mode })
        }
        // 刚换了一把凭据就立刻读一次，卡片因此在本次应答里就能看到窗口，而不是空卡片。
        await quotaRefresh.run(() => refreshQuota(true))
        return sendJson(response, 200, { ok: true, value: await readStatus() })
      }

      return sendJson(response, 404, { ok: false, error: 'Route not found.' })
    } catch (error) {
      return sendJson(response, 500, { ok: false, error: messageOf(error) })
    }
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: STEP_CODE_ROUTE_PREFIX, handler })
  return () => {
    dispose()
  }
}

/**
 * 显式连通性测试。
 *
 * 探针是**验活**而不是发一次生成请求：对目录端点做一次带凭据的 GET 并计时，
 * 便宜且不花额度。它答「这把凭据还能不能读这个 profile 的目录」，
 * 答不了「这个模型能不能被调用」——后者要花一次真实生成，交给用户发第一条消息。
 *
 * 失败一律变成一个可读的 `error` 字段而不是抛出：这张卡要显示的就是这句话。
 */
async function probeConnection(
  accountPool: StepCodeAccountPool | undefined,
  fetchFn: typeof fetch,
  env: NodeJS.ProcessEnv | undefined,
): Promise<StepCodeConnectionDto> {
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
    const response = await fetchFn(stepModelCatalogUrl(credentials.profile, env ?? process.env), {
      method: 'GET',
      headers: stepCodeModelHeaders(credentials),
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
          + (detail === '' ? '' : '：' + stepCodeErrorDetail(detail, 160)),
      }
    }
    // 只解析、不发布：探针的结果不进目录缓存（缓存由 refreshCatalog 负责写盘与去重）。
    const entries = parseStepModelCatalog(await response.json().catch(() => undefined) as unknown)
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
