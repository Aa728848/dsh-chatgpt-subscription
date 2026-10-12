/**
 * 云端轮询式浏览器登录（**不开本地回调端口**）。
 *
 * 逐字照抄官方三件套：`login-client.ts`（init/poll 的协议与重试）、
 * `login-polling.ts`（轮询循环与截止）、`step-provider/index.ts:268-309`（登录整体）。
 * 状态机外壳照抄 `workbuddy/oauth.ts`（flow / controller / getWebLoginStatus / resetWebLogin），
 * 因为设置卡片跟随的是同一组四个入口。
 *
 * ---------------------------------------------------------------------------
 * 两个值，两种角色，**绝不可混用**（逐字 login-client.ts:11-16）
 * ---------------------------------------------------------------------------
 *
 * - `poll_token` —— 客户端侧唯一的凭据。它**只**出现在 `Authorization: Bearer` 头里，
 *   绝不进 URL、日志或磁盘。
 * - `flow_id` —— 公开标识，会进浏览器地址栏、历史与截图，单独一个兑不出凭据。
 *
 * 本文件把这件事做成结构性的：poll_token 只作为 `pollToken` 参数流向 `request()` 的
 * 头构造那一处（见 `loginHeaders`），URL 由 authBase + 路径 + flow_id 拼成，
 * 两段代码互不相交；uid 与 flow_id 的过滤也各有自己的上限（UID_MAX_LENGTH / FLOW_ID_PATTERN）。
 *
 * ---------------------------------------------------------------------------
 * 这条线路的凭据永不过期、永不刷新
 * ---------------------------------------------------------------------------
 * Step 的 api_key 不是会话令牌（index.ts:363-371），所以：
 *
 * - 凭据形态固定为 {type:'oauth', access, refresh: STATIC_REFRESH_TOKEN, expires: STATIC_EXPIRES_AT}；
 * - `refreshStepCodeCredential` 存在，但**永远抛错**——它存在的意义是让任何「刷新」路径
 *   得到一句明确的拒绝，而不是悄悄拿哨兵去换一次必然失败的新凭据。
 */

import { randomBytes } from 'node:crypto'
import type { StepCodeLoginFlowStatus, StepCodeProfile } from '../../shared/step-code-contracts.ts'
import {
  CLI_FAILURE_DENIED,
  CLI_INIT_PATH,
  CLI_INIT_RESPONSE_FIELDS,
  CLI_LOGIN_AUTHORIZE_PATH,
  CLI_POLL_PATH,
  CLI_POLL_STATE,
  CLI_READY_FIELDS,
  FLOW_ID_PATTERN,
  LOGIN_FLOW_TIMEOUT_MS,
  LOGIN_REQUEST_TIMEOUT_MS,
  MAX_ERROR_DETAIL_LENGTH,
  POLL_MAX_INTERVAL_SEC,
  POLL_MIN_INTERVAL_MS,
  POLL_TOKEN_ENTROPY_BYTES,
  PROVIDER_NAME,
  STATIC_EXPIRES_AT,
  STATIC_REFRESH_TOKEN,
  UID_MAX_LENGTH,
  UID_PATTERN,
  authBaseForProfile,
  loginTimeoutMs,
} from './types.ts'

// ---------------------------------------------------------------------------
// 客户端身份
// ---------------------------------------------------------------------------

/**
 * 开流请求体里的终端信息（逐字 `StepCliClientInfo`，index.ts:280-285）。
 *
 * **只用于上游审计**，从不参与鉴权：`name` 固定是官方的 'stepcode'，因为服务端
 * 按它识别这条协议；本插件的身份由 `version` 字段如实上报，不冒充官方版本。
 */
export interface StepCodeClientInfo {
  readonly name: string
  readonly version: string
  readonly platform: string
}

/** 客户端名逐字照抄官方（`defaultStepCliClientInfo`，login-client.ts:104-108）。 */
export const STEP_CODE_CLIENT_NAME = 'stepcode'

/**
 * 接入层没有给版本时上报的版本串。
 *
 * 如实取一个「未知」而不是编一个像真的版本号：上游把它写进审计日志，编造会让
 * 排障时看到一条不存在的客户端版本。接入层（有 `package.json` 的那一层）应传真实版本。
 */
export const STEP_CODE_CLIENT_VERSION_UNKNOWN = '0.0.0-unknown'

/** 审计信息（逐字 login-client.ts:104-108：平台取 process.platform-process.arch）。 */
export function defaultStepCodeClientInfo(version: string): StepCodeClientInfo {
  return {
    name: STEP_CODE_CLIENT_NAME,
    version,
    platform: process.platform + '-' + process.arch,
  }
}

/**
 * 新的一次登录用的 poll_token：`randomBytes(32).toString('hex')`（逐字 index.ts:278）。
 *
 * 32 字节 = 64 位十六进制，与 `POLL_TOKEN_PATTERN` 对齐。它只进 Authorization 头。
 */
export function createStepCodePollToken(): string {
  return randomBytes(POLL_TOKEN_ENTROPY_BYTES).toString('hex')
}

// ---------------------------------------------------------------------------
// 错误分类与重试
// ---------------------------------------------------------------------------

/**
 * 一次登录请求失败的类别（逐字 `StepCliLoginErrorKind`，login-client.ts:70-76）。
 *
 * - `http`：非 2xx，或 2xx 但信封里的 `status` 非 0。
 * - `protocol`：2xx 但形状或字段值不合协议（**永不重试**）。
 * - `transport`：请求根本没拿到响应。
 */
export type StepCodeLoginErrorKind = 'http' | 'protocol' | 'transport'

/** 一条登录请求错误；`httpStatus` 只在 http 类里有意义。 */
export class StepCodeLoginRequestError extends Error {
  readonly kind: StepCodeLoginErrorKind
  readonly httpStatus?: number

  constructor(
    kind: StepCodeLoginErrorKind,
    message: string,
    options: { readonly httpStatus?: number; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'StepCodeLoginRequestError'
    this.kind = kind
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus
  }
}

/**
 * 这条错误值不值得自动重试（逐字 `isRetryableStepCliLoginError`，login-client.ts:95-100）。
 *
 * protocol 永不重试（形状不对说明对面不是我们以为的那个服务端）；transport 重试；
 * http 只在 408 / 429 / >=500 时重试。
 */
export function isRetryableStepCodeLoginError(error: unknown): boolean {
  if (!(error instanceof StepCodeLoginRequestError) || error.kind === 'protocol') return false
  const status = error.httpStatus
  if (status === undefined) return error.kind === 'transport'
  return status === 408 || status === 429 || status >= 500
}

/** protocol 类错误：形状/字段值不合协议，不重试。 */
function protocolError(phase: string, detail: string, cause?: unknown): StepCodeLoginRequestError {
  return new StepCodeLoginRequestError('protocol', PROVIDER_NAME + ' 登录 ' + phase + ' ' + detail, {
    ...(cause === undefined ? {} : { cause }),
  })
}

/** 成功体里的 `desc` 去控制字符后截断到 MAX_ERROR_DETAIL_LENGTH（逐字 login-client.ts:342-346）。 */
function envelopeDetail(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return ''
  const desc = readString(payload as Record<string, unknown>, 'desc')
  if (desc === undefined) return ''
  return ': ' + desc.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, MAX_ERROR_DETAIL_LENGTH)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 收窄 uid：长度 <= 64 且 /^[\w.@:-]+$/，不合格**整个丢弃**（逐字 login-client.ts:359-362）。
 *
 * 不合格就丢弃而不是截断：截断出来的 uid 可能与另一个账号撞上，而撞上的后果是
 * 号池里两行指向同一个身份。
 */
function readBoundedUid(value: string | undefined): string | undefined {
  if (value === undefined || value.length > UID_MAX_LENGTH || !UID_PATTERN.test(value)) return undefined
  return value
}

// ---------------------------------------------------------------------------
// 请求层
// ---------------------------------------------------------------------------

/**
 * 一次登录请求的响应体上限：64 KiB（逐字 login-client.ts:32）。
 *
 * 两个响应都是小 JSON；不设上限时，一个坏掉或恶意的端点可以把内存吃光。
 */
export const STEP_CODE_MAX_RESPONSE_BYTES = 64 * 1024

/** 解析一个 authBase；必须是 https 且不含凭据（逐字 login-client.ts:320-334）。 */
function parseAuthBase(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(PROVIDER_NAME + ' 的授权地址不是合法 URL：' + value)
  }
  if (url.protocol !== 'https:') throw new Error(PROVIDER_NAME + ' 的授权地址必须使用 https')
  if (url.username !== '' || url.password !== '') {
    throw new Error(PROVIDER_NAME + ' 的授权地址不得包含用户名或密码')
  }
  return url
}

/**
 * poll_token 只到这里为止：`Authorization: Bearer <token>`。
 *
 * 这个函数是 poll_token 在本文件里的**唯一**出口，它没有第二个参数可以把它带进 URL。
 */
function loginHeaders(pollToken: string, withBody: boolean): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: 'Bearer ' + pollToken,
    ...(withBody ? { 'content-type': 'application/json' } : {}),
  }
}

/** 读至多 STEP_CODE_MAX_RESPONSE_BYTES，超出即 protocol 错误。 */
async function readBoundedText(response: Response, phase: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > STEP_CODE_MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined)
    throw protocolError(phase, '响应超过体积上限')
  }
  const body = response.body
  if (body === null) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > STEP_CODE_MAX_RESPONSE_BYTES) throw protocolError(phase, '响应超过体积上限')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 单请求 + 读体都受限；每次退出都清掉定时器。 */
async function withLoginTimeout<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  timeoutError: () => Error,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const active = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
  const timer = setTimeout(() => controller.abort(timeoutError()), Math.max(0, timeoutMs))
  const aborted = new Promise<T>((resolve, reject) => {
    active.addEventListener('abort', () => {
      const reason: unknown = active.reason
      reject(reason instanceof Error ? reason : timeoutError())
    }, { once: true })
  })
  try {
    active.throwIfAborted()
    return await Promise.race([run(active), aborted])
  } finally {
    clearTimeout(timer)
  }
}

function abortReasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error('操作已取消')
}

/** 可被取消的 sleep（逐字 utils/sleep.ts 的语义）。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    const timer = setTimeout(() => { cleanup(); resolve() }, Math.max(0, ms))
    function onAbort(): void {
      clearTimeout(timer)
      cleanup()
      reject(abortReasonOf(signal))
    }
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

interface LoginRequestInput {
  readonly phase: 'init' | 'poll'
  readonly url: string
  readonly method: 'GET' | 'POST'
  readonly pollToken: string
  readonly body?: unknown
  readonly signal?: AbortSignal
  readonly fetchFn?: typeof fetch
}

/**
 * 一次登录请求（init 与 poll 共用）。
 *
 * 逐字照抄 login-client.ts:221-289 的判定顺序，每一步都有它的理由：
 *
 * 1. `redirect: 'error'` + `credentials: 'omit'`：**不带 cookie**，也不跟着 302 走
 *    （跟着走会把浏览器侧的会话混进一条纯 API 协议）。
 * 2. 拿到响应先限流读体：读失败时**错误响应的体是可选项**，HTTP 状态仍然决定重试。
 * 3. `!response.ok` → http 类；2xx 但不是 JSON 对象 → protocol 类；
 * 4. 2xx 但信封里 `status` 存在且非 0 → **按失败处理**（这是本线路最容易漏的一步：
 *    服务端会用 200 携带业务错误）。
 */
async function request(input: LoginRequestInput): Promise<Record<string, unknown>> {
  return withLoginTimeout(
    LOGIN_REQUEST_TIMEOUT_MS,
    input.signal,
    () => new StepCodeLoginRequestError('transport', PROVIDER_NAME + ' 登录请求超时'),
    async (signal) => {
      const pollToken = input.pollToken.trim()
      if (pollToken === '') throw new Error(PROVIDER_NAME + ' 登录的 poll_token 不能为空')
      const fetchFn = input.fetchFn ?? fetch
      let response: Response
      try {
        response = await fetchFn(input.url, {
          method: input.method,
          redirect: 'error',
          credentials: 'omit',
          signal,
          headers: loginHeaders(pollToken, input.body !== undefined),
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        })
      } catch (error) {
        if (signal.aborted) throw abortReasonOf(signal)
        throw new StepCodeLoginRequestError(
          'transport',
          PROVIDER_NAME + ' 登录 ' + input.phase + ' 请求失败：'
            + (error instanceof Error ? error.message : String(error)),
          { cause: error },
        )
      }

      let text = ''
      try {
        text = await readBoundedText(response, input.phase)
      } catch (error) {
        if (signal.aborted) throw abortReasonOf(signal)
        if (response.ok) {
          if (error instanceof StepCodeLoginRequestError) throw error
          throw new StepCodeLoginRequestError(
            'transport',
            PROVIDER_NAME + ' 登录 ' + input.phase + ' 的响应被中断',
            { cause: error },
          )
        }
      }

      let parsed: unknown
      try {
        parsed = text.trim() === '' ? undefined : JSON.parse(text)
      } catch (error) {
        if (response.ok) throw protocolError(input.phase, '响应不是合法 JSON', error)
      }

      if (!response.ok) {
        throw new StepCodeLoginRequestError(
          'http',
          PROVIDER_NAME + ' 登录 ' + input.phase + ' 请求失败（HTTP ' + response.status + '）'
            + envelopeDetail(parsed),
          { httpStatus: response.status },
        )
      }
      if (!isRecord(parsed)) throw protocolError(input.phase, '响应不是 JSON 对象')
      const status = readNumber(parsed, 'status')
      if (status !== undefined && status !== 0) {
        throw new StepCodeLoginRequestError(
          'http',
          PROVIDER_NAME + ' 登录被拒绝' + envelopeDetail(parsed),
          { httpStatus: response.status },
        )
      }
      return parsed
    },
  )
}

// ---------------------------------------------------------------------------
// init / poll
// ---------------------------------------------------------------------------

/** 开流成功后的三件事（逐字 StepCliLoginInit，login-client.ts:49-57）。 */
export interface StepCodeLoginInit {
  /** 公开标识：会进浏览器地址栏，单独一个兑不出凭据。 */
  readonly flowId: string
  /** 永远由客户端自己拼；服务端可能返回的 authorize_url 被**忽略**（见下）。 */
  readonly authorizeUrl: string
  /** 已 clamp 到 <= 60。 */
  readonly pollIntervalSec: number
  /** 上游硬截止，Unix **秒**。 */
  readonly expiresAt: number
}

export interface StepCodeCliLoginInitInput {
  readonly profile: StepCodeProfile
  readonly pollToken: string
  readonly client: StepCodeClientInfo
  readonly fetchFn?: typeof fetch
  readonly signal?: AbortSignal
  readonly env?: NodeJS.ProcessEnv
}

/**
 * POST {authBase}/api/stdhttp/v1/cli-login/init。
 *
 * 请求体（逐字 index.ts:126-135）：profile、**origin**（授权中心的源站，不是模型面）、
 * client 审计信息。
 *
 * 授权页 URL **客户端自己拼**（逐字 login-client.ts:139-141）：服务端可能返回
 * authorize_url，但那个值是从 CLI 看过去的（重定向到 CLI 而不是浏览器），
 * 对「人在浏览器里点」这件事没有意义，所以只认自己拼的。
 *
 * 响应校验三件事，缺一即 protocol 错误：flow_id 合 FLOW_ID_PATTERN、
 * poll_interval_sec >= 1、expires_at > 0。
 */
export async function initStepCodeCliLogin(
  input: StepCodeCliLoginInitInput,
): Promise<StepCodeLoginInit> {
  const env = input.env ?? process.env
  const base = parseAuthBase(authBaseForProfile(input.profile, env))
  const payload = await request({
    phase: 'init',
    url: base.origin + CLI_INIT_PATH,
    method: 'POST',
    pollToken: input.pollToken,
    body: {
      profile: input.profile,
      origin: base.origin,
      client: { name: input.client.name, version: input.client.version, platform: input.client.platform },
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.fetchFn === undefined ? {} : { fetchFn: input.fetchFn }),
  })

  const flowId = readString(payload, CLI_INIT_RESPONSE_FIELDS.flowId)
  if (flowId === undefined || !FLOW_ID_PATTERN.test(flowId)) {
    throw protocolError('init', '响应里没有可用的 flow_id')
  }
  const authorizeUrl = new URL(CLI_LOGIN_AUTHORIZE_PATH, base.origin + '/')
  authorizeUrl.searchParams.set('flow_id', flowId)
  const pollIntervalSec = readNumber(payload, CLI_INIT_RESPONSE_FIELDS.pollIntervalSec)
  if (pollIntervalSec === undefined || pollIntervalSec < 1) {
    throw protocolError('init', '响应里的 poll_interval_sec 小于 1 秒')
  }
  const expiresAt = readNumber(payload, CLI_INIT_RESPONSE_FIELDS.expiresAt)
  if (expiresAt === undefined || expiresAt <= 0) {
    throw protocolError('init', '响应里没有 expires_at')
  }
  return {
    flowId,
    authorizeUrl: authorizeUrl.toString(),
    pollIntervalSec: Math.min(pollIntervalSec, POLL_MAX_INTERVAL_SEC),
    expiresAt,
  }
}

/** 一次轮询的三种结果（逐字 StepCliLoginPoll，login-client.ts:61-68）。 */
export type StepCodeLoginPoll =
  | { readonly state: 'pending' }
  | { readonly state: 'ready'; readonly apiKey: string; readonly uid?: string }
  | { readonly state: 'failed'; readonly reason: 'denied' | 'unknown' }

export interface StepCodeCliLoginPollInput {
  readonly profile: StepCodeProfile
  readonly pollToken: string
  readonly flowId: string
  readonly fetchFn?: typeof fetch
  readonly signal?: AbortSignal
  readonly env?: NodeJS.ProcessEnv
}

/**
 * GET {authBase}/api/stdhttp/v1/cli-login/poll/{encodeURIComponent(flow_id)}。
 *
 * 三种 state 各自的下一步不同，所以分开建模：
 *
 * - pending：继续等。
 * - ready：取 credential.api_key（必须非空）与**顶层**可选 uid。
 * - failed：**只有字面 denied** 归为「用户在浏览器里拒绝了」；其余 reason 一律
 *   归为「未知失败」——两者的下一步不同（再点一次 vs 等上游恢复）。
 * - 其它 state：protocol 错误（对面不是我们以为的那个服务端）。
 *
 * 逐字照抄 login-client.ts:174-209，包括 flow_id 的二次校验：形状不对的 flow_id
 * 说明 URL 被污染或上游改版，重发多少次都一样。
 */
export async function pollStepCodeCliLogin(
  input: StepCodeCliLoginPollInput,
): Promise<StepCodeLoginPoll> {
  const env = input.env ?? process.env
  const base = parseAuthBase(authBaseForProfile(input.profile, env))
  if (!FLOW_ID_PATTERN.test(input.flowId)) throw protocolError('poll', 'flow_id 形状不合法')
  const payload = await request({
    phase: 'poll',
    url: base.origin + CLI_POLL_PATH + '/' + encodeURIComponent(input.flowId),
    method: 'GET',
    pollToken: input.pollToken,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.fetchFn === undefined ? {} : { fetchFn: input.fetchFn }),
  })

  const state = readString(payload, CLI_READY_FIELDS.state)
  if (state === CLI_POLL_STATE.pending) return { state: 'pending' }
  if (state === CLI_POLL_STATE.failed) {
    const reason = readString(payload, CLI_READY_FIELDS.reason)
    return { state: 'failed', reason: reason === CLI_FAILURE_DENIED ? 'denied' : 'unknown' }
  }
  if (state !== CLI_POLL_STATE.ready) throw protocolError('poll', '响应里有未知的 state')

  const credential = payload[CLI_READY_FIELDS.credential]
  if (!isRecord(credential)) throw protocolError('poll', 'ready 响应里没有 credential 对象')
  const apiKey = readString(credential, CLI_READY_FIELDS.apiKey)
  if (apiKey === undefined) throw protocolError('poll', 'ready 响应里没有 api_key')
  const uid = readBoundedUid(readString(payload, CLI_READY_FIELDS.uid))
  return { state: 'ready', apiKey, ...(uid === undefined ? {} : { uid }) }
}

export interface WaitForStepCodeLoginInput {
  readonly init: StepCodeLoginInit
  readonly profile: StepCodeProfile
  readonly pollToken: string
  readonly fetchFn?: typeof fetch
  readonly signal?: AbortSignal
  readonly env?: NodeJS.ProcessEnv  /**
   * 外层登录自己的截止（Unix 毫秒）。可选。
   *
   * 官方只有服务端 expires_at 一个截止（login-polling.ts:20-25），而外层登录另有
   * 一个本地总时限；两个都实现时取**先到者**，否则本地时限形同虚设。
   */
  readonly localDeadline?: number
}

/**
 * 轮询直到拿到凭据、用户拒绝，或到达截止。
 *
 * 逐字照抄 login-polling.ts:21-51，包括它的两条：
 *
 * - 间隔 clamp 到 [1s, 60s]：上游可以让我们慢一点，但不能让一次轮询停几分钟。
 * - 截止 = init.expiresAt * 1000（服务端的硬截止），不是本地猜测的时长；
 *   外层登录（beginStepCodeLogin）另有自己的总时限，两者取先到者。
 *
 * 重试判定走 isRetryableStepCodeLoginError：可重试的错误被吞掉继续下一轮，
 * 不可重试的直接抛出。
 */
export async function waitForStepCodeLogin(
  input: WaitForStepCodeLoginInput,
): Promise<{ readonly apiKey: string; readonly uid?: string }> {
  const timeoutError = (): Error =>
    new Error(PROVIDER_NAME + ' 登录超时：没有在有效期内完成浏览器授权。')
  const serverRemaining = input.init.expiresAt * 1000 - Date.now()
  const localRemaining = input.localDeadline === undefined ? Infinity : input.localDeadline - Date.now()
  const remaining = Math.min(serverRemaining, localRemaining)
  input.signal?.throwIfAborted()
  if (remaining <= 0) throw timeoutError()
  const interval = Math.min(
    POLL_MAX_INTERVAL_SEC * 1000,
    Math.max(POLL_MIN_INTERVAL_MS, input.init.pollIntervalSec * 1000),
  )
  return withLoginTimeout(remaining, input.signal, timeoutError, async (signal) => {
    for (;;) {
      try {
        const result = await pollStepCodeCliLogin({
          profile: input.profile,
          pollToken: input.pollToken,
          flowId: input.init.flowId,
          ...(input.fetchFn === undefined ? {} : { fetchFn: input.fetchFn }),
          signal,
          ...(input.env === undefined ? {} : { env: input.env }),
        })
        signal.throwIfAborted()
        if (result.state === 'ready') {
          return result.uid === undefined
            ? { apiKey: result.apiKey }
            : { apiKey: result.apiKey, uid: result.uid }
        }
        if (result.state === 'failed') {
          throw new Error(result.reason === 'denied'
            ? PROVIDER_NAME + ' 登录被拒绝：你在浏览器里没有确认授权。'
            : PROVIDER_NAME + ' 登录失败：上游在浏览器侧终止了这次授权。')
        }
      } catch (error) {
        signal.throwIfAborted()
        if (!isRetryableStepCodeLoginError(error)) throw error
      }
      await sleep(interval, signal)
    }
  })
}

// ---------------------------------------------------------------------------
// 凭据形态：永不过期、永不刷新
// ---------------------------------------------------------------------------

/**
 * 本线路落盘用的凭据形态（逐字 index.ts:301-306 的 OAuthCredentials）。
 *
 * 三个字段各有其存在的理由：
 *
 * - refresh 是**静态哨兵**（STATIC_REFRESH_TOKEN）。它不是可用的 refresh token，
 *   而是「这份凭据没有刷新链」的显式声明——官方 refreshStepOAuth 见到不是它的
 *   refresh 就抛错，所以任何别的进程/版本都能认出这份凭据。
 * - expires 恒为 STATIC_EXPIRES_AT（Number.MAX_SAFE_INTEGER）。它是「永不过期」的写法，
 *   **不是**异常数据：读回时不得把它当成坏值（JSON 存不下 Infinity，所以取 MAX）。
 * - profile 是区域的唯一来源（计划 §1）：api.stepfun.ai 与 api.stepfun.com 互不通用。
 */
export interface StepCodeStoredCredential {
  readonly type: 'oauth'
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly profile: StepCodeProfile
  readonly uid?: string
}

/** 从一次成功登录的结果造出凭据（uid 不合格时已经被丢掉，这里只做装配）。 */
export function stepCodeCredentialFromLogin(
  profile: StepCodeProfile,
  ready: { readonly apiKey: string; readonly uid?: string },
): StepCodeStoredCredential {
  const apiKey = ready.apiKey.trim()
  if (apiKey === '') throw new Error(PROVIDER_NAME + ' 登录成功但没有拿到 api_key')
  const uid = readBoundedUid(ready.uid)
  return {
    type: 'oauth',
    access: apiKey,
    refresh: STATIC_REFRESH_TOKEN,
    expires: STATIC_EXPIRES_AT,
    profile,
    ...(uid === undefined ? {} : { uid }),
  }
}

/**
 * 手动粘贴 Platform API Key（按量计费的两条 profile）造出的凭据。
 *
 * 形状与浏览器登录**完全一致**：同一条线路上两种来源的凭据在池里不该被区别对待
 *（Step 的 api_key 本身就不分来源）。
 */
export function stepCodeCredentialFromApiKey(
  profile: StepCodeProfile,
  apiKey: string,
  uid?: string,
): StepCodeStoredCredential {
  const trimmed = apiKey.trim()
  if (trimmed === '') throw new Error(PROVIDER_NAME + ' API Key 是空的。')
  const bounded = readBoundedUid(uid)
  return {
    type: 'oauth',
    access: trimmed,
    refresh: STATIC_REFRESH_TOKEN,
    expires: STATIC_EXPIRES_AT,
    profile,
    ...(bounded === undefined ? {} : { uid: bounded }),
  }
}

/** 一份值是不是本线路的凭据形态。 */
export function isStepCodeStoredCredential(value: unknown): value is StepCodeStoredCredential {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.type === 'oauth' && typeof record.access === 'string' && record.access.trim() !== ''
}

/** 凭据不可刷新的那句说明（号池与路由共用同一句）。 */
export const STEP_CODE_CREDENTIAL_NOT_REFRESHABLE =
  PROVIDER_NAME + ' 的凭据不会过期，也没有刷新链。Step 侧的 api_key 被撤销后只有重新授权才能拿到新的。'

/**
 * 「刷新」这条路径的**显式拒绝**。
 *
 * 它必须是一个被拒绝的 Promise 而不是一次静默的空操作：调用方（号池的 refresh 钩子、
 * 适配器的 401 处理）会把错误报给用户，而静默返回旧凭据会让一次注定失败的请求
 * 看起来像成功了。逐字照抄官方 refreshStepOAuth（index.ts:316-321）的拒绝语义。
 */
export function refreshStepCodeCredential(
  credential: StepCodeStoredCredential,
): Promise<StepCodeStoredCredential> {
  void credential
  return Promise.reject(new Error(STEP_CODE_CREDENTIAL_NOT_REFRESHABLE))
}

// ---------------------------------------------------------------------------
// 流程状态机（照抄 workbuddy/oauth.ts 的 flow / controller / 四个入口）
// ---------------------------------------------------------------------------

/** 一次登录流程跑完时留在内存里的凭据（接入层没给 onSave 时的去处）。 */
let pendingCredential: StepCodeStoredCredential | null = null
let flow: StepCodeLoginFlowStatus = { status: 'idle' }
let controller: AbortController | null = null

/** 卡片轮询的状态切片。返回副本，调用方改不到内部状态。 */
export function getStepCodeLoginStatus(): StepCodeLoginFlowStatus {
  return { ...flow }
}

/** 取消进行中的流程并回到 idle（设置卡片的「取消」）。 */
export function resetStepCodeLogin(): void {
  controller?.abort('login reset')
  controller = null
  flow = { status: 'idle' }
}

/** 看看有没有一份已经拿到、还没被取走的凭据（纯内存读）。 */
export function peekStepCodeLoginCredential(): StepCodeStoredCredential | null {
  return pendingCredential
}

/** 取走那份凭据并清空（同一份凭据只该被落盘一次）。 */
export function takeStepCodeLoginCredential(): StepCodeStoredCredential | null {
  const credential = pendingCredential
  pendingCredential = null
  return credential
}

export interface StepCodeLoginOptions {
  /** 测试缝。默认 fetch。 */
  fetchFn?: typeof fetch
  env?: NodeJS.ProcessEnv
  /** 审计信息；缺省用 version 造一个（version 缺省是 unknown）。 */
  client?: StepCodeClientInfo
  version?: string
  /**
   * 完成的登录写到哪里（接入层传号池或凭据存储的保存函数）。
   *
   * 没有它时凭据只是留在内存里，等 takeStepCodeLoginCredential() 取走——
   * 本模块**不持有凭据存储**，所以不替接入层猜该写哪儿。
   */
  onSave?: (credential: StepCodeStoredCredential) => Promise<unknown>
  /** 本地总时限；缺省 10 分钟，可由 STEP_OAUTH_TIMEOUT_MS 覆盖。 */
  timeoutMs?: number
}

/**
 * 开始一次云端轮询登录：**不开本地端口**，用户去浏览器里人工确认。
 *
 * 流程跑在 host 上（controller + flow），设置卡片只跟随 getStepCodeLoginStatus——
 * 与其余各线路的登录面同构。
 *
 * 两个截止取先到者：上游的 expires_at（硬截止，逐字 login-polling.ts:20-25）
 * 与本地总时限（默认 10 分钟，可由 STEP_OAUTH_TIMEOUT_MS 覆盖）。
 */
export async function beginStepCodeLogin(
  profile: StepCodeProfile,
  options: StepCodeLoginOptions = {},
): Promise<StepCodeLoginFlowStatus> {
  resetStepCodeLogin()
  pendingCredential = null
  const active = new AbortController()
  controller = active
  const env = options.env ?? process.env
  const client = options.client
    ?? defaultStepCodeClientInfo(options.version ?? STEP_CODE_CLIENT_VERSION_UNKNOWN)
  const startedAt = Date.now()
  const pollToken = createStepCodePollToken()

  let init: StepCodeLoginInit
  try {
    init = await initStepCodeCliLogin({
      profile,
      pollToken,
      client,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      signal: active.signal,
      env,
    })
  } catch (error) {
    flow = {
      status: 'error',
      profile,
      startedAt,
      completedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
      retryable: isRetryableStepCodeLoginError(error),
    }
    if (controller === active) controller = null
    return getStepCodeLoginStatus()
  }

  const expiresAt = init.expiresAt * 1000
  flow = {
    status: 'pending',
    profile,
    authorizeUrl: init.authorizeUrl,
    startedAt,
    expiresAt,
    pollIntervalSec: init.pollIntervalSec,
    progress: '等待浏览器授权…（每 ' + init.pollIntervalSec + ' 秒查询一次）',
  }

  void (async () => {
    try {
      const ready = await waitForStepCodeLogin({
        init,
        profile,
        pollToken,
        ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
        signal: active.signal,
        env,
        localDeadline: startedAt + (options.timeoutMs ?? loginTimeoutMs(env)),
      })
      if (active.signal.aborted) return
      const credential = stepCodeCredentialFromLogin(profile, ready)
      pendingCredential = credential
      if (options.onSave !== undefined) await options.onSave(credential)
      flow = {
        status: 'complete',
        profile,
        authorizeUrl: init.authorizeUrl,
        startedAt,
        completedAt: Date.now(),
        expiresAt,
        pollIntervalSec: init.pollIntervalSec,
        progress: '授权完成',
        ...(ready.uid === undefined ? {} : { uid: ready.uid }),
      }
    } catch (error) {
      if (active.signal.aborted) return
      flow = {
        status: 'error',
        profile,
        authorizeUrl: init.authorizeUrl,
        startedAt,
        completedAt: Date.now(),
        expiresAt,
        pollIntervalSec: init.pollIntervalSec,
        error: error instanceof Error ? error.message : String(error),
        retryable: isRetryableStepCodeLoginError(error),
      }
    } finally {
      if (controller === active) controller = null
    }
  })()

  return getStepCodeLoginStatus()
}
