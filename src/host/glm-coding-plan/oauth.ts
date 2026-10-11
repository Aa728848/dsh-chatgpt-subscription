/**
 * 浏览器 OAuth 登录（ZCode 平台中转轮询）。
 *
 * 这条线**不是**本地回调、也不是 RFC 8628 device code：授权发生在浏览器，
 * 但令牌的落地由 ZCode 平台的服务端中转页完成，本插件只做两件事——
 * 开一次流、按上游给的节奏轮询它（计划 §3.1，证据等级 A：
 * `apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts:88-238`、
 * `bootstrap/src/auth-login.ts:41`）。
 *
 * 三个必须记住的上游事实：
 *
 * 1. **开流与轮询都用 pollToken 鉴权**，不是 cookie、不是 session：
 *    `POST {ZCODE_API_BASE}/oauth/cli/init` 与
 *    `GET {ZCODE_API_BASE}/oauth/cli/poll/{flow_id}` 的头都是
 *    `Authorization: Bearer <pollToken>`，而 pollToken 是本地生成的
 *    `randomBytes(32).toString('hex')`——它不是登录凭据，只是把一次开流
 *    与它的轮询绑在一起，所以它不进凭据存储。
 * 2. **授权参数里没有 PKCE**（计划 §3.1、`PKCE_SUPPORTED = false`）：
 *    本插件照抄上游形状，不自带 `code_challenge`。
 * 3. **回调由服务端中转页收走**：`{zcode.z.ai}/app/oauth/login?redirect=zcode://oauth/callback`
 *    是一个网页而不是本机端口，所以远程会话 / 防火墙下浏览器照样能把
 *    授权码交到上游手里——这也是「手工粘贴兜底」有意义的原因（见
 *    {@link submitLoginCode}）。
 *
 * 轮询错误语义（计划 §3.1，证据等级 B，逆向实测量化出来的四条，逐条照抄）：
 *
 * - 4xx（**除 408 / 429**）→ 致命
 * - 信封 `code !== 0`      → 致命
 * - 未知 `status`          → 致命
 * - 5xx / 网络错误 / 畸形 200 → 按 pending 重试
 *
 * 分界线是「上游给了没有结论」还是「上游给了结论」：4xx 说「这个流程不行」，
 * 5xx 与畸形 200 只是这一次没拿到结论，重试到 `expires_at` 才是真正的上界。
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { GlmLoginFlowStatus, GlmRegion } from '../../shared/glm-coding-plan-contracts.ts'
import {
  CLI_INIT_RESPONSE_FIELDS,
  CLI_PROVIDER_BY_REGION,
  CLI_READY_FIELDS,
  CLI_READY_STATUS,
  DEFAULT_REGION,
  OAUTH_FLOW_TIMEOUT_MS,
  OAUTH_REQUEST_TIMEOUT_MS,
  POLL_MIN_INTERVAL_MS,
  POLL_TOKEN_ENTROPY_BYTES,
  USER_AGENT,
  cliInitUrl,
  cliPollUrl,
} from './types.ts'

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/**
 * 致命的登录失败：重试同一个流程不会改变结果。
 *
 * 计划 §3.1 的三条致命语义（4xx、信封 `code !== 0`、未知 status）都归到这里，
 * 另外开流响应的字段校验失败也是同一类——上游已经给了结论，只是结论是「你发的请求不对」。
 */
export class GlmLoginFatalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GlmLoginFatalError'
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 把调用方的取消信号与本次请求的超时合成一个。 */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 剥掉业务信封，取真正承载字段的那一层。
 *
 * 上游有两种可能的形状（**未验证**：计划 §3.1 逐字记录的是平铺的
 * `{flow_id, authorize_url, ...}`，而 Z.ai 系端点普遍再包一层 `{code, data}`）。
 * 所以判据是「顶层有没有我要的字段」：有就原样用，没有才去 `data` 里找。
 * 两种形状都不满足时返回 undefined，交给调用方按「畸形 200」处理。
 */
function unwrapBody(
  payload: Record<string, unknown>,
  expectedKeys: readonly string[],
): Record<string, unknown> | undefined {
  if (expectedKeys.some((key) => key in payload)) return payload
  const data = asRecord(payload['data'])
  return data !== undefined && expectedKeys.some((key) => key in data) ? data : undefined
}

/**
 * 读出信封里的业务码。
 *
 * 计划 §3.1 写的是「信封 `code !== 0` 一律致命」，所以这里**只**认 0 与 '0'：
 * 别的数值（含 200）在这个控制面上都算异常，宁可当成致命也不要当成成功。
 * 没有 `code` 字段时返回 undefined，交给调用方按平铺响应处理。
 */
function readEnvelopeCode(payload: Record<string, unknown>): number | string | undefined {
  const code = payload['code']
  if (typeof code === 'number' && Number.isFinite(code)) return code
  if (typeof code === 'string' && code.trim() !== '') return code.trim()
  return undefined
}

// ---------------------------------------------------------------------------
// 开流
// ---------------------------------------------------------------------------

/** 一次开流的上游响应，字段名来自 `CLI_INIT_RESPONSE_FIELDS`（逐字：`cli-oauth.ts:138,172`）。 */
export interface GlmCliInit {
  flowId: string
  authorizeUrl: string
  /** 上游失效时刻（Unix 毫秒，由 `expires_at` 秒换算）。 */
  expiresAt: number
  /** 上游建议的轮询间隔（秒）；实际间隔还要过 `POLL_MIN_INTERVAL_MS` 下限。 */
  pollIntervalSec: number
  /** 本次流程的 pollToken，只有开流与轮询会用到它。 */
  pollToken: string
}

export interface GlmRequestOptions {
  /** 注入的 fetch；测试全部走它，所以本文件离网。 */
  fetchFn?: typeof fetch
  signal?: AbortSignal
  /** 环境覆盖（`DSH_GLM_*`），读取时机与 types.ts 的覆盖表一致：调用时读。 */
  env?: NodeJS.ProcessEnv
}

function cliHeaders(pollToken: string): Record<string, string> {
  return {
    // 逐字（`cli-oauth.ts:98`）：开流与轮询都用同一个 Bearer pollToken。
    authorization: 'Bearer ' + pollToken,
    accept: 'application/json',
    'user-agent': USER_AGENT,
  }
}

/**
 * 开一次流：`POST {ZCODE_API_BASE}/oauth/cli/init`。
 *
 * 请求体只有 `{"provider": "zai" | "bigmodel"}`——区域到上游 provider 名的翻译只在这一处
 * （`CLI_PROVIDER_BY_REGION`），翻译错会让开流成功但授权落到另一个部署的账号上。
 */
export async function requestCliInit(
  region: GlmRegion,
  options: GlmRequestOptions = {},
): Promise<GlmCliInit> {
  const fetchFn = options.fetchFn ?? fetch
  const env = options.env ?? process.env
  const pollToken = randomBytes(POLL_TOKEN_ENTROPY_BYTES).toString('hex')
  const url = cliInitUrl(env)

  const response = await fetchFn(url, {
    method: 'POST',
    headers: { ...cliHeaders(pollToken), 'content-type': 'application/json' },
    body: JSON.stringify({ provider: CLI_PROVIDER_BY_REGION[region] }),
    signal: withTimeout(options.signal, OAUTH_REQUEST_TIMEOUT_MS),
  })

  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const record = asRecord(payload)
    const message = asString(record?.msg) ?? asString(record?.message) ?? ''
    throw new GlmLoginFatalError(
      'ZCode 开流失败（HTTP ' + response.status + '）'
      + (message === '' ? '' : '：' + message)
      + '（' + url + '）',
    )
  }

  const root = asRecord(payload)
  const body = root === undefined ? undefined : unwrapBody(root, Object.values(CLI_INIT_RESPONSE_FIELDS))
  if (body === undefined) {
    throw new GlmLoginFatalError('ZCode 开流响应不是对象，缺少 ' + Object.values(CLI_INIT_RESPONSE_FIELDS).join(' / '))
  }

  // 四个字段缺一不可（逐字：`cli-oauth.ts:138,172`）。缺任何一个都意味着
  // 本插件拿不到轮询地址或失效时刻，继续下去只能空转到超时，所以当场判致命。
  const flowId = asString(body[CLI_INIT_RESPONSE_FIELDS.flowId])
  const authorizeUrl = asString(body[CLI_INIT_RESPONSE_FIELDS.authorizeUrl])
  const expiresAtSec = asNumber(body[CLI_INIT_RESPONSE_FIELDS.expiresAt])
  const pollIntervalSec = asNumber(body[CLI_INIT_RESPONSE_FIELDS.pollIntervalSec])
  const missing: string[] = []
  if (flowId === undefined) missing.push(CLI_INIT_RESPONSE_FIELDS.flowId)
  if (authorizeUrl === undefined) missing.push(CLI_INIT_RESPONSE_FIELDS.authorizeUrl)
  if (expiresAtSec === undefined || expiresAtSec <= 0) missing.push(CLI_INIT_RESPONSE_FIELDS.expiresAt)
  if (pollIntervalSec === undefined) missing.push(CLI_INIT_RESPONSE_FIELDS.pollIntervalSec)
  if (missing.length > 0) {
    throw new GlmLoginFatalError('ZCode 开流响应缺少字段：' + missing.join(' / '))
  }

  return {
    flowId: flowId!,
    authorizeUrl: authorizeUrl!,
    expiresAt: expiresAtSec! * 1000,
    pollIntervalSec: pollIntervalSec!,
    pollToken,
  }
}

// ---------------------------------------------------------------------------
// 轮询
// ---------------------------------------------------------------------------

/** 就绪载荷里 `user` 的子字段（逐字：计划 §3.1 的 `user:{user_id,email,name,avatar}`）。 */
const CLI_USER_FIELDS = {
  userId: 'user_id',
  email: 'email',
  name: 'name',
  avatar: 'avatar',
} as const

/**
 * 上游的「还没好」状态字面量。
 *
 * **未验证**：计划 §3.1 与 `types.ts` 只逐字记录了 `ready`（`CLI_READY_STATUS`），
 * `pending` 是按同构实现取的。取错的后果是：真正的 pending 会被判成「未知 status」而致命，
 * 卡片立刻报错而不是继续等——所以这里把未知值按致命处理（计划 §3.1 的原话），
 * 上游若换了字面量，日志里会出现这条致命原因，届时改这一行即可。
 */
const CLI_PENDING_STATUS = 'pending'

/** 一次登录成功后的凭据。host 侧专用，**不进任何共享契约**。 */
export interface GlmCliCredentials {
  region: GlmRegion
  /** 兑换链的输入（计划 §3.2）：它是 `POST /api/auth/z/login` 的 `token`。 */
  accessToken: string
  /**
   * 上游同包下发的 refresh_token。
   *
   * **没有**对应的刷新接口（计划 §3.6：官方 `oauthService.ts:972-975` 直接抛错），
   * 所以这个值只做留档与诊断，**不要**据此实现任何刷新路径。
   */
  refreshToken: string | null
  /**
   * 就绪载荷里的 `token`（ZCode 平台自己的 JWT）。
   *
   * 本线路不拿它做任何鉴权，只留档：计划 §9 明确记录 `data.token` 的完整 payload
   * 未验证，缺一份真实的解码样本。
   */
  zcodeToken: string | null
  userId: string | null
  email: string | null
  displayName: string | null
  /** 上游给了头像地址时只记「有」，不落原始字节。 */
  hasAvatar: boolean
  authenticatedAt: number
}

/** 一次轮询的结论。致命不是一个结论，是一个异常（{@link GlmLoginFatalError}）。 */
export type GlmPollOutcome =
  | { kind: 'pending'; progress: string }
  | { kind: 'ready'; credentials: GlmCliCredentials }

/**
 * 解析就绪载荷。
 *
 * 只有 `{provider 键}.access_token` 是硬要求：它一丢，兑换链就没有输入，
 * 而按计划 §3.1 的错误语义这属于「畸形 200」，应当按 pending 重试到超时，
 * 而不是让用户拿着一个半成品凭据进对话。其余字段缺失只降级为 null。
 */
function parseReadyCredentials(
  payload: Record<string, unknown>,
  region: GlmRegion,
  now: number,
): GlmCliCredentials | null {
  const providerKey = CLI_PROVIDER_BY_REGION[region]
  const body = unwrapBody(payload, [CLI_READY_FIELDS.status, providerKey])
  if (body === undefined) return null
  const provider = asRecord(body[CLI_READY_FIELDS[providerKey]])
  if (provider === undefined) return null
  const accessToken = asString(provider[CLI_READY_FIELDS.accessToken])
  if (accessToken === undefined) return null
  const user = asRecord(body[CLI_READY_FIELDS.user]) ?? {}
  const avatar = asString(user[CLI_USER_FIELDS.avatar])
  return {
    region,
    accessToken,
    refreshToken: asString(provider[CLI_READY_FIELDS.refreshToken]) ?? null,
    zcodeToken: asString(body[CLI_READY_FIELDS.token]) ?? null,
    userId: asString(user[CLI_USER_FIELDS.userId]) ?? null,
    email: asString(user[CLI_USER_FIELDS.email]) ?? null,
    displayName: asString(user[CLI_USER_FIELDS.name]) ?? null,
    hasAvatar: avatar !== undefined,
    authenticatedAt: now,
  }
}

/**
 * 轮询一次：`GET {ZCODE_API_BASE}/oauth/cli/poll/{flow_id}`。
 *
 * 返回值只有 pending / ready 两种；「该停了」的情况按计划 §3.1 分三类抛出：
 * 4xx（除 408/429）与未知 status 抛 {@link GlmLoginFatalError}，
 * 而 5xx、网络错误与畸形 200 都返回 pending——这四种在上游眼里都是「这次没有结论」。
 */
export async function pollCliFlow(
  flow: { flowId: string; pollToken: string; region: GlmRegion },
  options: GlmRequestOptions = {},
): Promise<GlmPollOutcome> {
  const fetchFn = options.fetchFn ?? fetch
  const env = options.env ?? process.env
  const url = cliPollUrl(flow.flowId, env)

  let response: Response
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: cliHeaders(flow.pollToken),
      signal: withTimeout(options.signal, OAUTH_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    // 调用方主动取消时原样抛出：那不是「上游没结论」，不要把取消吞成 pending。
    if (options.signal?.aborted === true) throw error
    return { kind: 'pending', progress: '连接上游失败，正在重试…' }
  }

  const payload: unknown = await response.json().catch(() => undefined)

  if (response.status >= 500) {
    return { kind: 'pending', progress: '上游暂时不可用（HTTP ' + response.status + '），正在重试…' }
  }
  if (!response.ok) {
    // 408/429 是「再等等」的信号（上游自己在限流或处理超时），其余 4xx 一律致命。
    if (response.status === 408 || response.status === 429) {
      return { kind: 'pending', progress: '上游要求稍后再试（HTTP ' + response.status + '），正在重试…' }
    }
    throw new GlmLoginFatalError('ZCode 登录轮询被拒绝（HTTP ' + response.status + '）：' + url)
  }

  const root = asRecord(payload)
  if (root === undefined) {
    return { kind: 'pending', progress: '上游返回了无法解析的响应，正在重试…' }
  }

  const code = readEnvelopeCode(root)
  if (code !== undefined && code !== 0 && code !== '0') {
    const message = asString(root.msg) ?? asString(root.message)
    throw new GlmLoginFatalError(
      'ZCode 登录轮询返回业务错误码 ' + String(code) + (message === undefined ? '' : '：' + message),
    )
  }

  const body = unwrapBody(root, [CLI_READY_FIELDS.status, CLI_READY_FIELDS.user])
  const status = body === undefined ? undefined : asString(body[CLI_READY_FIELDS.status])

  if (status === CLI_PENDING_STATUS) {
    return { kind: 'pending', progress: '等待你在浏览器里完成授权…' }
  }
  if (status === CLI_READY_STATUS) {
    const credentials = parseReadyCredentials(root, flow.region, Date.now())
    if (credentials === null) {
      // 就绪却没有可用的 access_token：上游改了载荷形状，属于畸形 200，按 pending 重试。
      return { kind: 'pending', progress: '就绪响应缺少 access_token，正在重试…' }
    }
    return { kind: 'ready', credentials }
  }

  throw new GlmLoginFatalError(
    'ZCode 登录轮询返回未知的 status：' + (status === undefined ? '(缺失)' : status),
  )
}

// ---------------------------------------------------------------------------
// 登录流程状态机
// ---------------------------------------------------------------------------

/**
 * 截止时刻：`min(now + 5min, expires_at * 1000)`（逐字：`auth-login.ts:41`）。
 *
 * 取小者的理由写在 `OAUTH_FLOW_TIMEOUT_MS` 的注释里：`expires_at` 才是上游真正的失效时刻，
 * 本地 5 分钟只是兜底。
 */
export function flowDeadlineMs(now: number, expiresAt: number): number {
  return Math.min(now + OAUTH_FLOW_TIMEOUT_MS, expiresAt)
}

/** 轮询间隔：`max(1000ms, poll_interval_sec * 1000)`（逐字：`cli-oauth.ts:106-115`）。 */
export function pollIntervalMs(pollIntervalSec: number): number {
  return Math.max(POLL_MIN_INTERVAL_MS, pollIntervalSec * 1000)
}

/** 一次登录流程的对外状态：冻结契约的 `GlmLoginFlowStatus` 加上本插件自己的会话 id。 */
export interface GlmWebLogin extends GlmLoginFlowStatus {
  /**
   * 本次流程的会话 id。卡片轮询与取消都用它；
   * `GlmLoginFlowStatus` 里没有这个字段，因为「会话 id」是 host 的实现细节，
   * 不该出现在共享契约里。
   */
  loginId: string
  /** 就绪时的凭据；其它状态为 null。这个字段**不出这个模块**。 */
  credentials: GlmCliCredentials | null
}

interface LoginSession {
  loginId: string
  region: GlmRegion
  flow: { flowId: string; pollToken: string; region: GlmRegion }
  init: GlmCliInit
  startedAt: number
  deadline: number
  intervalMs: number
  /** 下一次轮询允许的最早时刻，防止卡片把上游打成限流。 */
  nextPollAt: number
  status: GlmLoginFlowStatus
  /** 用户手工粘回来的回调 code；它使下一次轮询立刻发生。永不出现在状态快照里。 */
  manualCode: string | null
}

const loginSessions = new Map<string, LoginSession>()

/** 最近一次开流的会话 id；无参数读状态时用它（照 kimi-code 的单流程卡片语义）。 */
let latestLoginId: string | null = null

/** 丢掉已经越过截止时刻的会话，避免卡片重开后读到一条死流程。 */
function pruneLoginSessions(now: number = Date.now()): void {
  for (const [loginId, session] of loginSessions) {
    if (session.deadline <= now) loginSessions.delete(loginId)
  }
  if (latestLoginId !== null && !loginSessions.has(latestLoginId)) latestLoginId = null
}

/** 登录选项。 */
export interface BeginWebLoginOptions extends GlmRequestOptions {
  region?: GlmRegion
  /** 打开浏览器的方式；缺省用本平台的 `openBrowser`。测试注入一个空函数即可。 */
  openBrowser?: (url: string) => void
}

/** 把会话状态投影成对外快照（浅拷贝，调用方改不到内部状态）。 */
function snapshot(session: LoginSession, credentials: GlmCliCredentials | null = null): GlmWebLogin {
  return { ...session.status, loginId: session.loginId, credentials }
}

/**
 * 开一次浏览器登录：开流 → 尽力打开授权页 → 落一条 pending 状态。
 *
 * 这里**不开轮询循环**：卡片通过 `/login/poll` 显式驱动，host 自己在后台轮询的话，
 * 用户关掉设置页之后还会继续打上游。
 */
export async function beginWebLogin(options: BeginWebLoginOptions = {}): Promise<GlmWebLogin> {
  const region = options.region ?? DEFAULT_REGION
  const now = Date.now()
  try {
    const init = await requestCliInit(region, options)
    pruneLoginSessions(now)
    const loginId = randomUUID()
    const session: LoginSession = {
      loginId,
      region,
      flow: { flowId: init.flowId, pollToken: init.pollToken, region },
      init,
      startedAt: now,
      deadline: flowDeadlineMs(now, init.expiresAt),
      intervalMs: pollIntervalMs(init.pollIntervalSec),
      nextPollAt: 0,
      manualCode: null,
      status: {
        status: 'pending',
        region,
        authorizeUrl: init.authorizeUrl,
        startedAt: now,
        expiresAt: init.expiresAt,
        pollIntervalSec: init.pollIntervalSec,
        progress: '等待你在浏览器里完成授权…',
      },
    }
    loginSessions.set(loginId, session)
    latestLoginId = loginId

    // 授权页打不开不是致命错误：卡片始终渲染 authorizeUrl，用户可以自己复制打开。
    const open = options.openBrowser ?? openBrowser
    try {
      open(init.authorizeUrl)
    } catch {
      // 同上，URL 就在状态里。
    }
    return snapshot(session)
  } catch (error) {
    // 开流失败没有会话可更新（会话是开流成功之后才有的），所以这里只有一件事可做：
    // 清掉「最近一次流程」的指向，别让上一次的死流程顶替这次的开流，
    // 然后把原因原样抛给路由层——卡片是从那次 HTTP 失败里读原因的，不是从状态里。
    latestLoginId = null
    throw error
  }
}

/** 读某次登录（或最近一次）的公开状态。 */
export function getWebLoginStatus(loginId?: string): GlmWebLogin | null {
  const id = loginId ?? latestLoginId
  if (id === null || id === undefined) return null
  const session = loginSessions.get(id)
  if (session === undefined) return null
  return snapshot(session)
}

/** 取消一次登录，让后续轮询无从恢复。 */
export function cancelWebLogin(loginId?: string): boolean {
  const id = loginId ?? latestLoginId
  if (id === null || id === undefined) return false
  const cancelled = loginSessions.delete(id)
  if (latestLoginId === id) latestLoginId = null
  return cancelled
}

/** 测试缝：忘掉所有会话与最近一次流程。 */
export function resetWebLogins(): void {
  loginSessions.clear()
  latestLoginId = null
}

export interface PollWebLoginOptions extends GlmRequestOptions {
  /**
   * 就绪后把凭据交出去（W6 在这里落盘并把账号加进号池）。
   *
   * 本模块**不持有凭据存储**，所以持久化失败不吞：吞掉的话卡片会显示
   * 「登录成功」而凭据根本没落盘。
   */
  onAuthenticated?: (credentials: GlmCliCredentials) => Promise<void> | void
}

/**
 * 轮询一次，把状态机往前推一格。
 *
 * 三种停下来的方式都返回状态而不抛：卡片轮询的语义是「读状态」，
 * 让它去 catch 异常只会把「上游说了不行」显示成 500。
 */
export async function pollWebLogin(
  loginId: string,
  options: PollWebLoginOptions = {},
): Promise<GlmWebLogin> {
  const now = Date.now()
  const session = loginSessions.get(loginId)
  if (session === undefined) {
    return {
      loginId,
      credentials: null,
      status: 'error',
      error: '这次登录已经取消或已经过期，请重新发起登录。',
      retryable: false,
    }
  }

  // 超时检查排在清扫之前：清扫会顺手删掉过期会话，而「超时」与「被取消」
  // 在卡片上是两条不同的下一步（前者只要重新开一次流）。
  if (now >= session.deadline) {
    loginSessions.delete(loginId)
    if (latestLoginId === loginId) latestLoginId = null
    session.status = {
      ...session.status,
      status: 'error',
      progress: undefined,
      error: '登录超时：上游在 ' + new Date(session.deadline).toISOString() + ' 之前没有完成授权。',
      retryable: false,
    }
    return snapshot(session)
  }
  pruneLoginSessions(now)

  // 卡片轮询得比间隔还快时，这里回答 pending，而不是替上游把限流打出来。
  if (session.manualCode === null && now < session.nextPollAt) return snapshot(session)
  // 手工粘贴只豁免**这一次**间隔：连续豁免会让卡片按自己的节奏打上游，
  // 而上游正是靠这个间隔自我保护的。
  session.manualCode = null

  try {
    const outcome = await pollCliFlow(session.flow, options)
    if (outcome.kind === 'pending') {
      session.nextPollAt = Date.now() + session.intervalMs
      session.status = { ...session.status, status: 'pending', progress: outcome.progress }
      return snapshot(session)
    }

    loginSessions.delete(loginId)
    if (latestLoginId === loginId) latestLoginId = null
    session.status = {
      ...session.status,
      status: 'complete',
      completedAt: outcome.credentials.authenticatedAt,
      progress: undefined,
      ...(outcome.credentials.email === null ? {} : { email: outcome.credentials.email }),
      error: undefined,
      retryable: undefined,
    }
    if (options.onAuthenticated !== undefined) await options.onAuthenticated(outcome.credentials)
    return snapshot(session, outcome.credentials)
  } catch (error) {
    loginSessions.delete(loginId)
    if (latestLoginId === loginId) latestLoginId = null
    const fatal = error instanceof GlmLoginFatalError
    session.status = {
      ...session.status,
      status: 'error',
      progress: undefined,
      error: error instanceof Error ? error.message : String(error),
      retryable: !fatal,
    }
    return snapshot(session)
  }
}

// ---------------------------------------------------------------------------
// 手工粘贴兜底
// ---------------------------------------------------------------------------

/**
 * 从用户粘回来的东西里取出授权码。
 *
 * 两种输入都是自然的（照 9ad8a53 那份 `extractAuthorizationCode` 的思路）：
 * 地址栏里回不来的那串裸 code，以及整条回调 URL。
 * 回调 URL 有两个易错点，都在这里兜住：自定义 scheme（`zcode://oauth/callback?code=…`）
 * 的 query 一样能解析，而有些浏览器把参数放进 fragment（`#code=…`）。
 * 认不出来的输入返回空串——宁可让调用方报「这不像授权码」，也不要把它当 code 提交上去。
 */
export function extractAuthorizationCode(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const fromQuery = url.searchParams.get('code')
      if (fromQuery !== null && fromQuery.trim() !== '') return fromQuery.trim()
      const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
      if (hash !== '') {
        const fromHash = new URLSearchParams(hash).get('code')
        if (fromHash !== null && fromHash.trim() !== '') return fromHash.trim()
      }
      return ''
    } catch {
      return ''
    }
  }
  // 形如 `code=…&state=…` 的裸查询串。
  if (trimmed.includes('=')) {
    const fromQuery = new URLSearchParams(trimmed).get('code')
    return fromQuery === null ? '' : fromQuery.trim()
  }
  // 裸 code：没有 '=' 就没有参数表可解析。
  return trimmed
}

/**
 * 从回调里取 `error` / `error_description`。
 *
 * 用户在授权页点「拒绝」时，上游会把错误塞进回调而不是给我们一个 code。
 * 那是用户的明确决定，不该被当成「还在等」，所以单独读出来判致命。
 */
export function extractAuthorizationError(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  const params = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
    ? (() => {
        try {
          const url = new URL(trimmed)
          const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
          return new URLSearchParams(url.search + (hash === '' ? '' : '&' + hash))
        } catch {
          return new URLSearchParams()
        }
      })()
    : new URLSearchParams(trimmed.includes('=') ? trimmed : '')
  const description = params.get('error_description') ?? params.get('error')
  return description === null ? '' : description.trim()
}

/**
 * 用户把 code（或整条回调 URL）粘回来时调用。
 *
 * 存在的理由：防火墙或远程会话下浏览器可能走不到中转页，这时卡片会一直 pending 到超时，
 * 而用户手上明明已经有一个 code。
 *
 * 它做的事是**强制立刻复查一次平台流程**，不是自己拿 code 去换 token——
 * 授权码是服务端中转页（`{zcode.z.ai}/app/oauth/login?redirect=zcode://oauth/callback`）
 * 用同一个 code 换掉的，计划 §3.1 只逐字记录了 `cli/init` 与 `cli/poll` 两个端点，
 * 客户端直换端点**未验证**。所以 code 在本插件里的唯一作用是「上游可能已经就绪了，去看一眼」。
 *
 * @throws 没有进行中的流程，或粘贴内容里既没有 code 也没有 error。
 */
export function submitLoginCode(raw: string, options: { loginId?: string } = {}): GlmWebLogin {
  const id = options.loginId ?? latestLoginId
  const session = id === null || id === undefined ? undefined : loginSessions.get(id)
  if (session === undefined || session.status.status !== 'pending') {
    throw new Error('当前没有进行中的 GLM 登录流程可供补全。')
  }

  const denial = extractAuthorizationError(raw)
  if (denial !== '') {
    loginSessions.delete(session.loginId)
    if (latestLoginId === session.loginId) latestLoginId = null
    session.status = {
      ...session.status,
      status: 'error',
      progress: undefined,
      error: '授权被拒绝：' + denial,
      retryable: false,
    }
    return snapshot(session)
  }

  const code = extractAuthorizationCode(raw)
  if (code === '') {
    throw new Error('这看起来不是授权码，也不是完整的回调链接（里面没有 code 参数）。')
  }
  // code 是凭据：只留在会话内部，不进状态快照、不进任何错误消息。
  session.manualCode = code
  session.nextPollAt = 0
  session.status = { ...session.status, progress: '已收到回调，正在向上游确认…' }
  return snapshot(session)
}

// ---------------------------------------------------------------------------
// 打开浏览器
// ---------------------------------------------------------------------------

/**
 * 用平台默认浏览器打开一个 URL。
 *
 * 与其余各线路同一份形状（kimi-code / claude / command-code / antigravity 都有一份）。
 * 全部按尽力而为处理：调用方永远会展示同一个 URL，所以启动失败是可恢复的。
 */
export function openBrowser(url: string): void {
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
