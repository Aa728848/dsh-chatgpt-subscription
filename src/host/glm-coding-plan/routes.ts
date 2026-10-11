/**
 * GLM（ZCode 账号）线路的 web 路由。
 *
 * 路由表与客户端 `src/client/glm-coding-plan/api.ts` 里那一份是**同一个约定**，两边必须逐条对上：
 *
 * ```
 * GET  /status           -> GlmStatusDto（页面的唯一读口）
 * POST /settings         GlmSettingsUpdateDto -> GlmStatusDto
 * POST /accounts         { action, accountId } / { action:'strategy', strategy } -> GlmStatusDto
 * POST /login/start      { region } -> GlmLoginFlowStatus
 * GET  /login/status     -> GlmLoginFlowStatus
 * POST /login/cancel     { region } -> GlmLoginFlowStatus
 * POST /login/manual     { region, code } -> GlmStatusDto
 * POST /adopt            { region } -> GlmAdoptResultDto
 * POST /connection/test  -> GlmConnectionDto
 * POST /quota            -> GlmStatusDto（强制刷新配额）
 * POST /catalog/refresh  -> GlmStatusDto
 * ```
 *
 * 信封：除 `/adopt` 与 `/connection/test` 外一律 `{ ok, value }`，因为客户端走的
 * `createLineApi` 会把信封拆掉、直接把 `value` 当 DTO 用；这两条路由的契约把 DTO 定在
 * 顶层，所以它们**直接**返回 DTO（`createLineApi` 对没有布尔 `ok` 的应答原样返回整体）。
 *
 * 同源校验不可省：每个 POST 都过 `isSameOriginMutation`，与兄弟线路同一份实现。
 * 本文件不持有任何凭据，所有落盘与兑换都交给 token-store / account-pool / oauth / adopt。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../common/same-origin.ts'
import { QuotaRefresh } from '../common/quota-refresh.ts'
import type { ContextWindowOverridePatch } from '../common/context-window-overrides.ts'
import {
  GLM_CODING_PLAN_PROVIDER_ID,
  GLM_CODING_PLAN_ROUTE_PREFIX,
  type GlmAdoptResultDto,
  type GlmConnectionDto,
  type GlmLoginFlowStatus,
  type GlmRegion,
  type GlmStatusDto,
} from '../../shared/glm-coding-plan-contracts.ts'
import {
  DEFAULT_REGION,
  PROVIDER_NAME,
  isGlmReasoningEffort,
  normalizeRegion,
} from './types.ts'
import {
  GLM_MODEL_CATALOG,
  catalogModelOptions,
  catalogSize,
  modelsForRegion,
} from './model-catalog.ts'
import {
  clearCachedCatalog,
  getCachedCatalog,
  getCachedQuota,
  fetchGlmQuota,
  loadCatalog,
} from './client.ts'
import { verifyCodingPlanKey } from './exchange.ts'
import { adoptZcodeSignIn } from './adopt.ts'
import {
  beginWebLogin,
  cancelWebLogin,
  getWebLoginStatus,
  pollWebLogin,
  submitLoginCode,
  type GlmCliCredentials,
  type GlmWebLogin,
} from './oauth.ts'
import { exchangeForCodingPlanKey } from './exchange.ts'
import {
  credentialsFromCliLogin,
  type GlmCodingPlanCredentials,
  type GlmCodingPlanModelSettings,
  type GlmCodingPlanModelSettingsStore,
  type GlmCodingPlanPreferenceStore,
  type GlmCodingPlanSettingsPatch,
} from './token-store.ts'

/** 设置来源：register 后端优先，没有就落回凭据旁边的 JSON 文件。 */
export function glmCodingPlanSettingsSource(
  preferences: GlmCodingPlanPreferenceStore | undefined,
  fallback: GlmCodingPlanModelSettingsStore,
): GlmCodingPlanSettingsSource {
  return preferences === undefined ? fileSettingsSource(fallback) : registeredSettingsSource(preferences)
}
import {
  glmCodingPlanPoolStatus,
  type GlmCodingPlanAccountPool,
} from './account-pool.ts'

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
export function glmSubPathOf(requestUrl: string): string {
  const pathname = new URL(requestUrl || '/', 'http://dsh.local').pathname
  if (pathname === GLM_CODING_PLAN_ROUTE_PREFIX) return ''
  if (pathname.startsWith(GLM_CODING_PLAN_ROUTE_PREFIX + '/')) {
    return pathname.slice(GLM_CODING_PLAN_ROUTE_PREFIX.length + 1)
  }
  return pathname.replace(/^\/+/, '')
}

/**
 * 登录状态投影成能下发给浏览器的形状。
 *
 * `GlmWebLogin` 带着 `credentials`（含 access_token 与 Coding Plan Key）和 host 自己的
 * `loginId`。两者都不许过这条边界——冻结契约的 `GlmLoginFlowStatus` 里本来就没有它们，
 * 这里显式挑字段而不是展开整个对象，是为了让「以后有人给 GlmWebLogin 加一个字段」
 * 变成一次需要被看见的改动。
 */
function loginStatusOf(login: GlmWebLogin | null): GlmLoginFlowStatus {
  if (login === null) return { status: 'idle' }
  const out: GlmLoginFlowStatus = { status: login.status }
  if (login.region !== undefined) out.region = login.region
  if (login.authorizeUrl !== undefined) out.authorizeUrl = login.authorizeUrl
  if (login.startedAt !== undefined) out.startedAt = login.startedAt
  if (login.completedAt !== undefined) out.completedAt = login.completedAt
  if (login.expiresAt !== undefined) out.expiresAt = login.expiresAt
  if (login.pollIntervalSec !== undefined) out.pollIntervalSec = login.pollIntervalSec
  if (login.progress !== undefined) out.progress = login.progress
  if (login.email !== undefined) out.email = login.email
  if (login.error !== undefined) out.error = login.error
  if (login.retryable !== undefined) out.retryable = login.retryable
  return out
}

export interface GlmCodingPlanRouteOptions {
  fetchFn?: typeof fetch
  /** 本插件是否正在服务这条 Provider 路由；每次状态都重新读。 */
  serving?: boolean | (() => boolean)
  /** 路由被别的适配器占用时的诊断文案；每次状态都重新读。 */
  conflict?: string | null | (() => string | null)
  /** 号池；本进程装了才有。 */
  accountPool?: GlmCodingPlanAccountPool
  /**
   * 打开授权页的方式；缺省是**什么都不做**。
   *
   * 卡片（client/glm-coding-plan/useGlmCodingPlanSection.ts 的 window.open）才是
   * 唯一开浏览器的地方。host 再开一次就是同一场登录弹出两个一模一样的页面——
   * 兄弟线路 claude / command-code 早就把这条收敛掉了，这里的缺省跟着它们走。
   *
   * 这一栏存在的理由是测试：/login/start 一共被十几条路由用例打中，显式传入一个
   * 空函数就把这条外部副作用整个摘掉；只有显式传入时才用传入的那一份。
   */
  openBrowser?: (url: string) => void
}

function readOption<T>(value: T | (() => T) | undefined, fallback: T): T {
  return typeof value === 'function' ? (value as () => T)() : value ?? fallback
}

/**
 * 设置来源：register 后端与文件后端形状不同，这里收敛成一个。
 *
 * `status()` 允许是 promise：文件后端要读盘，而卡片每次轮询都会问一次状态。
 * register 后端同步返回，实现方不必知道自己被允许同步。
 */
export interface GlmCodingPlanSettingsSource {
  status(): GlmCodingPlanModelSettings | Promise<GlmCodingPlanModelSettings>
  update(patch: GlmCodingPlanSettingsPatch): Promise<GlmCodingPlanModelSettings>
}

function registeredSettingsSource(preferences: GlmCodingPlanPreferenceStore): GlmCodingPlanSettingsSource {
  return { status: () => preferences.status(), update: (patch) => preferences.update(patch) }
}

function fileSettingsSource(store: GlmCodingPlanModelSettingsStore): GlmCodingPlanSettingsSource {
  return { status: () => store.read(), update: (patch) => store.updateSettings(patch) }
}

/**
 * 这个部署当前的模型目录。
 *
 * 进程内缓存优先、随包目录兜底：**状态轮询不联网**。卡片 60 秒轮询一次，
 * 每次打上游会把设置页变成一条压测。实时目录只由 `/catalog/refresh` 与连接测试拉取。
 */
function catalogFor(region: GlmRegion): readonly typeof GLM_MODEL_CATALOG[number][] {
  const cached = getCachedCatalog(region)
  return cached.length > 0 ? cached : modelsForRegion(region, GLM_MODEL_CATALOG)
}

/** 设置卡片渲染的模型总数（hub overview 与状态共用同一份读数）。 */
export function glmCatalogSize(): number {
  return catalogSize(GLM_MODEL_CATALOG)
}

export interface GlmStatusSources {
  options: GlmCodingPlanRouteOptions
  settings: GlmCodingPlanSettingsSource
  /** 登录流程的公开状态（凭据不出这一层）。 */
  latestLogin: GlmWebLogin | null
  /** 正在跑的配额刷新；缺省表示没有。 */
  quotaRefreshing: boolean
  /** 上一次配额读失败的原因；读到快照时为 null。缺省表示没有失败可报。 */
  quotaError?: string | null
  /** 本次读到的账号（卡片渲染用，不带任何凭据）。 */
  account: GlmCodingPlanCredentials | null
}

/**
 * 组装 `GlmStatusDto`。
 *
 * 号池读不出来不能带倒整张卡：连接那一半仍然值得渲染，只是账号列表是空的。
 */
export async function getGlmCodingPlanStatus(sources: GlmStatusSources): Promise<GlmStatusDto> {
  const { options, settings } = sources
  const settingsValue = await settings.status()
  const pool = await glmCodingPlanPoolStatus(options.accountPool)
  const served = readOption(options.serving, true)
  const conflict = readOption(options.conflict, null)
  const credential = sources.account
  const region: GlmRegion = credential?.codingPlan.region ?? DEFAULT_REGION
  const quota = getCachedQuota()
  return {
    ...pool,
    enabled: settingsValue.enabled !== false,
    // 「有没有凭据」以号池为准：池是路由与轮转的权威，单凭据文件只是它的镜像。
    authenticated: pool.accounts.length > 0,
    hasCredentials: credential !== null || pool.accounts.length > 0,
    providerId: GLM_CODING_PLAN_PROVIDER_ID,
    storagePath: options.accountPool?.path() ?? '',
    region,
    account: credential === null ? null : {
      // 非机密身份（契约明写这里只允许这些）。id 用组织 + 上游 user_id 拼，
      // 与号池行的选择键无关：卡片用它显示「当前是谁」，轮转仍然由号池决定。
      id: credential.codingPlan.organizationId + ':' + (credential.userId ?? credential.codingPlan.apiKeyId),
      userId: credential.userId,
      email: credential.email,
      displayName: credential.displayName,
      region: credential.codingPlan.region,
      authenticatedAt: credential.authenticatedAt > 0 ? credential.authenticatedAt : null,
    },
    quota,
    // 额度类型以**落盘时的探活结论**为准（凭据事实），而不是以配额快照为准：
    // 免费额度账号很可能恰恰读不到配额快照，那时只有这一项能诚实地说「你是免费额度」。
    allowance: credential?.codingPlan.allowance,
    lastFetchedAt: quota === null ? null : quota.fetchedAt,
    quotaRefreshing: sources.quotaRefreshing,
    // 池里没有账号时不存在「配额读失败」这回事：探活会先报「号池中没有账号」，
    // 把它当成配额失败会在未登录的卡片上凭空多一句红字。
    quotaError: pool.accounts.length === 0 ? null : (sources.quotaError ?? null),
    models: catalogModelOptions(catalogFor(region) as typeof GLM_MODEL_CATALOG, {
      enabledModelIds: settingsValue.enabledModelIds,
      contextWindowOverrides: settingsValue.contextWindowOverrides,
    }),
    contextWindowOverrides: settingsValue.contextWindowOverrides,
    defaultReasoningEffort: settingsValue.defaultReasoningEffort,
    login: loginStatusOf(sources.latestLogin),
    serving: served,
    conflict,
  }
}

/** 请求体 → 设置补丁。自由输入的字段逐个校验，认不出的取值直接丢掉而不是猜。 */
function patchFromBody(body: Record<string, unknown>): GlmCodingPlanSettingsPatch {
  const patch: GlmCodingPlanSettingsPatch = {}
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  if (Array.isArray(body.enabledModelIds)) {
    patch.enabledModelIds = body.enabledModelIds.filter((id): id is string => typeof id === 'string')
  }
  if (typeof body.contextWindowOverrides === 'object' && body.contextWindowOverrides !== null) {
    const overrides: ContextWindowOverridePatch = {}
    for (const [key, raw] of Object.entries(body.contextWindowOverrides as Record<string, unknown>)) {
      // null 是卡片的「恢复目录默认」，必须活过归一化才能让存储删掉恰好那个键。
      // 不合法的数字被丢掉而不是纠正：路由无法知道用户想指哪个窗口。
      if (raw === null) overrides[key] = null
      else if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) overrides[key] = Math.floor(raw)
    }
    patch.contextWindowOverrides = overrides
  }
  if (body.defaultReasoningEffort !== undefined) {
    const effort = body.defaultReasoningEffort
    if (effort === null || isGlmReasoningEffort(effort)) patch.defaultReasoningEffort = effort
  }
  if (body.selectedAccountId !== undefined) {
    patch.selectedAccountId = typeof body.selectedAccountId === 'string' ? body.selectedAccountId : null
  }
  return patch
}

/** 请求体里的 region（认不出时回落默认部署）。 */
function regionFromBody(body: Record<string, unknown>): GlmRegion {
  return normalizeRegion(body.region) ?? DEFAULT_REGION
}

/**
 * 注册本线路的路由。
 *
 * `store` 只用来读「当前该显示哪个账号」与存储位置说明；真正的路由与轮转在号池，
 * 真正���落盘在 token-store，两者都不在本文件里做。
 */
export function registerGlmCodingPlanRoutes(
  ctx: Context,
  settings: GlmCodingPlanSettingsSource,
  options: GlmCodingPlanRouteOptions = {},
): () => void {
  const fetchFn = options.fetchFn ?? fetch
  const accountPool = options.accountPool
  const quotaRefresh = new QuotaRefresh()

  /** 最近一次开流的会话；卡片轮询 /login/status 时由它推进。 */
  let latestLogin: GlmWebLogin | null = null

  /**
   * 落一次登录成功：兑换 → 落盘 → 进号池。
   *
   * 作为 `pollWebLogin` 的 `onAuthenticated` 钩子传入，所以**它抛出的错不吞**：
   * 吞掉会让卡片显示「登录成功」而凭据根本没落盘（oauth.ts 的注释写明了这条）。
   */
  const persistLogin = async (session: GlmCliCredentials): Promise<void> => {
    const plan = await exchangeForCodingPlanKey(session.accessToken, session.region, { fetchFn })
    const credentials = credentialsFromCliLogin(session, plan)
    if (accountPool !== undefined) {
      await accountPool.addAccount(credentials)
    }
    // 缓存的配额与目录都是**按账号**或按区域记的，换了一把 Key 之后旧的读数作废。
    clearCachedCatalog()
  }

  /**
   * 上一次配额读失败的原因；读到快照时清空。
   *
   * 必须记下来而不是丢掉：fetchGlmQuota 的失败以返回值呈现（不抛），所以
   * quotaRefresh.lastError() 看不到它。不记的话卡片只能说「暂无配额数据」，
   * 用户分不清「上游还没给这把 Key 开配额」与「这把 Key 根本读不了配额」。
   */
  let quotaError: string | null = null

  /**
   * 一次配额读：凭据来自号池（与一次模型请求同一个账号），快照记在这一行名下。
   */
  const refreshQuota = async (force: boolean): Promise<void> => {
    if (accountPool === undefined) return
    let target: Awaited<ReturnType<GlmCodingPlanAccountPool['getQuotaReadTarget']>> | null = null
    try {
      target = await accountPool.getQuotaReadTarget(fetchFn)
    } catch (error) {
      // 探活（选账号 + 验活）失败也是这次配额读失败的一部分，原因同样要如实下发。
      quotaError = messageOf(error)
      return
    }
    const read = await fetchGlmQuota(
      target.credentials.codingPlan.region,
      target.credentials.codingPlan.codingPlanKey,
      { fetchFn, accountId: target.accountId, force },
    ).catch((error: unknown) => ({
      snapshot: null,
      error: messageOf(error),
      fromCache: false,
    }))
    quotaError = read.error ?? (read.snapshot === null ? '配额接口没有返回可显示的窗口。' : null)
  }

  const readStatus = async (): Promise<GlmStatusDto> => {
    const account = accountPool === undefined
      ? null
      : await accountPool.read()
        .then((data) => data.accounts.find((entry) => entry.isPrimary)?.credentials
          ?? data.accounts[0]?.credentials ?? null)
        .catch(() => null)
    return await getGlmCodingPlanStatus({
      options: accountPool === undefined ? { ...options, accountPool: undefined } : options,
      settings,
      latestLogin,
      quotaRefreshing: quotaRefresh.refreshing,
      quotaError,
      account,
    })
  }

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = glmSubPathOf(request.url ?? '/')
    const method = request.method ?? 'GET'

    try {
      if (path === '' || path === 'status') {
        if (method !== 'GET') return sendMethodNotAllowed(response)
        // 配额刷新跑在应答**背后**：await 进来会把上游超时放进每一次轮询，
        // 而这张卡是被轮询的。没有快照可渲染时例外，那一次读必须等。
        if (options.fetchFn !== undefined && accountPool !== undefined) {
          if (getCachedQuota() === null) await quotaRefresh.run(() => refreshQuota(false))
          else quotaRefresh.start(() => refreshQuota(false))
        }
        return sendJson(response, 200, { ok: true, value: await readStatus() })
      }

      if (path === 'settings') {
        if (method === 'GET') return sendJson(response, 200, { ok: true, value: await readStatus() })
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const patch = patchFromBody(await readRequestJson(request))
        // 先落盘再发事件：适配器读的就是这份设置，事件只负责让 DSH 重建模型选择器。
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
            await accountPool.deleteAccount(accountId)
            break
          case 'relogin':
            // 本线路没有 refresh 接口，所以「重新登录」在 host 这一侧只能做两件事：
            // 撤掉鉴权失败标记与冷却，让这一行重新参与轮转；真正的登录由卡片重新开一次流程。
            await accountPool.clearAuthFailed(accountId)
            await accountPool.clearCooldown(accountId)
            break
          default:
            return sendJson(response, 400, { ok: false, error: '未知的账号操作：' + action })
        }
        return sendJson(response, 200, { ok: true, value: await readStatus() })
      }

      if (path === 'quota') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        // 一次失败的配额读不是一次失败的请求：契约让 quota 可空，卡片照旧渲染。
        await quotaRefresh.run(() => refreshQuota(true))
        return sendJson(response, 200, { ok: true, value: await readStatus() })
      }

      if (path === 'catalog/refresh') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        if (accountPool !== undefined) {
          const target = await accountPool.getQuotaReadTarget(fetchFn).catch(() => null)
          if (target !== null) {
            await loadCatalog(target.credentials.codingPlan.region, target.credentials.codingPlan.codingPlanKey, {
              fetchFn,
              force: true,
            }).catch(() => undefined)
          }
        }
        return sendJson(response, 200, { ok: true, value: await readStatus() })
      }

      if (path === 'connection/test') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        // 这条路由的契约把 DTO 定在**顶层**（信封会把它误判成一次失败），所以直接返回。
        return sendJson(response, 200, await probeConnection(accountPool, fetchFn))
      }

      if (path === 'login/start') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const body = await readRequestJson(request)
        const region = regionFromBody(body)
        // 浏览器打不开不是致命错误：authorizeUrl 始终在状态里，用户可以自己复制打开。
        // 卡片自己 window.open 授权页，host 再开一次就是同一场登录弹出两个一样的页面，
        // 所以这里恒定给 oauth 一个空 opener；只有显式注入了才用注入的那一份。
        latestLogin = await beginWebLogin({
          fetchFn,
          region,
          openBrowser: () => undefined,
          ...(options.openBrowser === undefined ? {} : { openBrowser: options.openBrowser }),
        })
        return sendJson(response, 200, { ok: true, value: loginStatusOf(latestLogin) })
      }

      if (path === 'login/status') {
        if (method !== 'GET') return sendMethodNotAllowed(response)
        const current = latestLogin ?? getWebLoginStatus()
        if (current === null) {
          return sendJson(response, 200, { ok: true, value: { status: 'idle' } as GlmLoginFlowStatus })
        }
        // 只有这一条 GET 会**推进**状态机：oauth.ts 刻意不在后台轮询，
        // 否则用户关掉设置页之后 host 还会继续打上游。
        if (current.status === 'pending') {
          latestLogin = await pollWebLogin(current.loginId, { fetchFn, onAuthenticated: persistLogin })
        }
        // 终态（complete / error）**留在 latestLogin 里**，不在这里清空。
        //
        // 清空过会怎样：pollWebLogin 结束时 oauth.ts 已经把会话从它的表里删掉了，
        // 所以下一拍读到的 current 是 null，卡片于是把「登录完成」显示成
        // 「尚未开始登录」——用户刚看见账号进池，就被告知他从没登录过。
        // 「读到一次就清」同样不行：卡片在流程结束前后会读好几次（2 秒一次的
        // /login/status 轮询与它带出来的那次 /status 会交错完成），
        // 先读走的那一次之后，后到的那些只会读到 idle。
        //
        // 选「留到下一次开流或用户取消」而不是定时过期：生命周期的边界本来就由
        // 用户动作划出来（/login/start 覆盖、/login/cancel 清空），加一个时钟
        // 只是把同一个竞态换成另一个竞态（卡片没在窗口内读到，成功同样会消失）。
        if (latestLogin === null) latestLogin = current
        const answer = loginStatusOf(latestLogin)
        return sendJson(response, 200, { ok: true, value: answer })
      }

      if (path === 'login/cancel') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const current = latestLogin ?? getWebLoginStatus()
        const cancelled = current === null ? false : cancelWebLogin(current.loginId)
        const status: GlmLoginFlowStatus = cancelled
          ? { status: 'idle', ...(current?.region === undefined ? {} : { region: current.region }) }
          : loginStatusOf(current)
        latestLogin = null
        return sendJson(response, 200, { ok: true, value: status })
      }

      if (path === 'login/manual') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const body = await readRequestJson(request)
        // 请求体带凭据，刻意不在冻结契约里（见 contracts 的文件头），由 host 自行解析。
        const raw = typeof body.code === 'string' ? body.code : ''
        if (raw.trim() === '') return sendJson(response, 400, { ok: false, error: '请粘贴回调链接或授权码。' })
        const current = latestLogin ?? getWebLoginStatus()
        if (current === null) {
          return sendJson(response, 400, { ok: false, error: '当前没有进行中的登录流程，请先点击登录。' })
        }
        let submitted: GlmWebLogin
        try {
          submitted = submitLoginCode(raw, { loginId: current.loginId })
        } catch (error) {
          return sendJson(response, 400, { ok: false, error: messageOf(error) })
        }
        if (submitted.status === 'error') {
          // 失败同样是终态：留住它，卡片才会说「登录失败 + 原因」。
          // 这条分支原来回的是登录流程状态而不是整份 status，与文件头的路由表
          // （POST /login/manual -> GlmStatusDto）以及客户端的读法都不一致：
          // 卡片会把一份流程状态当整份状态用，模型区与账号区随即空掉。
          latestLogin = submitted
          return sendJson(response, 200, { ok: true, value: await readStatus() })
        }
        // code 只是「上游可能已经就绪了，去看一眼」的信号；真正的凭据仍旧来自 poll。
        latestLogin = await pollWebLogin(current.loginId, { fetchFn, onAuthenticated: persistLogin })
        // 完成之后同样不清空：走粘贴这条路径登录成功时，卡片要在随后那次 /status 里
        // 看到的是「登录完成」而不是「尚未开始登录」（理由同 /login/status）。
        return sendJson(response, 200, { ok: true, value: await readStatus() })
      }

      if (path === 'adopt') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const body = await readRequestJson(request)
        // 请求里的 region 只作**提示**：本机凭据文件自带 `oauth:active_provider`，
        // 那是事实本身。adopt 出来的 DTO 会回报它真实的区域，卡片据此切换。
        void regionFromBody(body)
        const outcome = await adoptZcodeSignIn({ fetchFn })
        if (outcome.adopted !== null && accountPool !== undefined) {
          await accountPool.addAdoptedCredential(outcome.adopted)
          clearCachedCatalog()
        }
        // adopt 失败**永不阻断**：每一种失败都是契约里的一个 reason，卡片据此回落浏览器登录。
        return sendJson(response, 200, outcome.result as GlmAdoptResultDto)
      }

      return sendJson(response, 404, { ok: false, error: 'Route not found.' })
    } catch (error) {
      return sendJson(response, 500, { ok: false, error: messageOf(error) })
    }
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: GLM_CODING_PLAN_ROUTE_PREFIX, handler })
  return () => {
    dispose()
  }
}

/**
 * 显式连通性测试。
 *
 * 探针是**验活**而不是发一次生成请求：它便宜、不花额度，而 `verifyCodingPlanKey` 走的
 * 正是兑换链验活时用的那一条（配额接口裸 Key），所以它答「这把 Key 还能不能读配额」，
 * 答不了「这个模型能不能被调用」——后者要花一次真实生成，交给用户发第一条消息。
 */
async function probeConnection(
  accountPool: GlmCodingPlanAccountPool | undefined,
  fetchFn: typeof fetch,
): Promise<GlmConnectionDto> {
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
  const region = target.credentials.codingPlan.region
  const started = Date.now()
  try {
    await verifyCodingPlanKey(region, target.credentials.codingPlan.codingPlanKey, { fetchFn })
    const summaries = await accountPool!.listAccounts().catch(() => [])
    const models = catalogFor(region)
    return {
      connected: true,
      latencyMs: Date.now() - started,
      account: summaries.find((entry) => entry.id === target.accountId) ?? null,
      model: models[0]?.id ?? null,
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
