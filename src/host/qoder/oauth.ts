/**
 * Qoder（订阅）线路的登录：浏览器设备流（仅全球区）+ PAT 兑换 + 令牌刷新。
 *
 * 协议逐字来源：
 *
 * - 设备流（PKCE 风格 challenge/verifier + nonce 轮询，**不开本地回调端口**）：
 *   qodercli2api \`docs/oauth.md\` §2（官方 CLI v1.1.34 的 frozen fixtures 互操作基线），
 *   与 pi-provider \`src/auth/login.ts\`（live 验证）互相印证；
 * - PAT 兑换：docs.qoder.com/cli/authentication（官方文档）+ pi-provider \`src/auth/pat.ts\`；
 * - 刷新：pi-provider \`src/auth/oauth.ts\` \`refreshQoderTokenForMode\`（live 验证）。
 *
 * 与 step-code 的 oauth.ts 同构的部分（流程状态机外壳：flow / controller /
 * getXxxLoginStatus / resetXxxLogin / takeXxxLoginCredential）是因为设置卡片跟随的是
 * 同一组四个入口；与它的**差异**（凭据会过期、可刷新）全部集中在
 * {@link refreshQoderCredential} 与凭据装配段。
 *
 * 凭据形状由 token-store.ts 的 \`QoderCredentials\` 定义；本文件只负责「把一次登录
 * 变成一份凭据」，不持有凭据存储。
 */

import { randomBytes, randomUUID, createHash } from 'node:crypto'
import type { QoderLoginFlowStatus, QoderRegion } from '../../shared/qoder-contracts.ts'
import {
  DEVICE_POLL_INTERVAL_MS,
  DEVICE_TOKEN_POLL_PATH,
  DEVICE_VERIFIER_BYTES,
  LOGIN_REQUEST_TIMEOUT_MS,
  PROVIDER_NAME,
  QODER_DEVICE_CLIENT_ID,
  REGION_HOSTS,
  loginTimeoutMs,
  openapiBaseForRegion,
  regionSupportsDeviceLogin,
} from './types.ts'
import {
  QoderPatExchangeError,
  exchangeQoderJobToken,
  fetchQoderUserInfo,
  qoderErrorDetail,
  qoderPatRejectionStatus,
  refreshQoderAccessToken,
  type QoderRequestOptions,
} from './client.ts'
import { resolveQoderMachineId } from './cosy.ts'
import { QODER_REGIONS } from '../../shared/qoder-contracts.ts'
import { qoderExpiresAtFrom, type QoderCredentials } from './token-store.ts'

// ---------------------------------------------------------------------------
// 设备流参数（逐字 docs/oauth.md §2.1）
// ---------------------------------------------------------------------------

/**
 * PKCE 风格参数。
 *
 * - verifier：43..128 字符（A-Z a-z 0-9 -._~）——32 字节 base64url 正好 43 字符；
 * - challenge：base64url_nopad(SHA256(verifier))；
 * - nonce：random UUID；
 * - machineId：36 字符 UUID（本机既有那把就用那把，见 cosy.ts 的读取顺序）。
 */
export function createQoderDeviceParams(env: NodeJS.ProcessEnv = process.env): {
  verifier: string
  challenge: string
  nonce: string
  machineId: string
} {
  const verifier = randomBytes(DEVICE_VERIFIER_BYTES).toString('base64url')
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    nonce: randomUUID(),
    machineId: resolveQoderMachineId(env),
  }
}

/**
 * 授权页 URL（host 拼，卡片打开）。
 *
 * 逐字 docs/oauth.md §2.1 的参数表（challenge / challenge_method=S256 / nonce /
 * machine_id / client_id=官方 CLI 的固定值）。没有 scope、redirect URI 或本地回调。
 */
export function qoderDeviceAuthorizeUrl(params: { challenge: string; nonce: string; machineId: string }): string {
  const page = REGION_HOSTS.global.deviceAuthorizePage
  if (page === null) throw new Error(PROVIDER_NAME + ' 全球区以外的部署不支持浏览器登录')
  const url = new URL(page)
  url.searchParams.set('challenge', params.challenge)
  url.searchParams.set('challenge_method', 'S256')
  url.searchParams.set('nonce', params.nonce)
  url.searchParams.set('machine_id', params.machineId)
  url.searchParams.set('client_id', QODER_DEVICE_CLIENT_ID)
  return url.toString()
}

// ---------------------------------------------------------------------------
// 设备轮询
// ---------------------------------------------------------------------------

/** 一次轮询的三种结果。 */
export type QoderDevicePoll =
  | { readonly state: 'pending' }
  | { readonly state: 'ready'; readonly token: string; readonly userId: string | null; readonly refreshToken: string | null; readonly expiresAt: number }
  | { readonly state: 'failed'; readonly reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * GET {openapi}/api/v1/deviceToken/poll?nonce=…&verifier=…&challenge_method=S256。
 *
 * 逐字 docs/oauth.md §2.2 与 pi-provider \`login.ts\` 的状态语义：
 *
 * - 404 / 202 = pending（用户还没在浏览器里确认）；
 * - 200 = 取 token（**缺 token 的 200 立即失败**——看形状，不只看状态码）；
 * - 其余非 2xx = 立即失败；
 * - transport 错误由外层轮询循环按间隔重试（到截止为止），不在这里判死。
 */
export async function pollQoderDeviceToken(
  params: { nonce: string; verifier: string },
  options: QoderRequestOptions = {},
): Promise<QoderDevicePoll> {
  const fetchFn = options.fetchFn ?? fetch
  const env = options.env ?? process.env
  const url = new URL(openapiBaseForRegion('global', env) + DEVICE_TOKEN_POLL_PATH)
  url.searchParams.set('nonce', params.nonce)
  url.searchParams.set('verifier', params.verifier)
  url.searchParams.set('challenge_method', 'S256')
  const response = await fetchFn(url.toString(), {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: options.signal ?? AbortSignal.timeout(LOGIN_REQUEST_TIMEOUT_MS),
  })
  if (response.status === 404 || response.status === 202) return { state: 'pending' }
  if (!response.ok) {
    const detail = qoderErrorDetail(await response.text().catch(() => ''), 160)
    return {
      state: 'failed',
      reason: PROVIDER_NAME + ' 设备轮询失败（HTTP ' + response.status + '）' + (detail === '' ? '' : '：' + detail),
    }
  }
  const payload = (await response.json().catch(() => undefined)) as unknown
  if (!isRecord(payload)) return { state: 'failed', reason: PROVIDER_NAME + ' 设备轮询响应不是 JSON 对象' }
  const token = asText(payload.token)
  if (token === undefined) return { state: 'failed', reason: PROVIDER_NAME + ' 设备轮询的 200 响应里没有 token' }
  return {
    state: 'ready',
    token,
    userId: asText(payload.user_id) ?? null,
    refreshToken: asText(payload.refresh_token) ?? null,
    expiresAt: qoderExpiresAtFrom(payload.expires_at, payload.expires_in),
  }
}

// ---------------------------------------------------------------------------
// 凭据装配
// ---------------------------------------------------------------------------

/**
 * 设备流轮询结果 → 落盘凭据。
 *
 * userinfo 是 best-effort 的补齐（uid 缺失会让 CN 拒成 105；全球区的设备流
 * 轮询自己带 \`user_id\`），补齐失败不使登录失败（docs/oauth.md §2：
 * enrichment 失败不使登录失败）。
 */
export async function qoderCredentialsFromDevicePoll(
  ready: { token: string; userId: string | null; refreshToken: string | null; expiresAt: number },
  machineId: string,
  options: QoderRequestOptions = {},
): Promise<QoderCredentials> {
  let email: string | null = null
  let name: string | null = null
  let uid = ready.userId
  try {
    const info = await fetchQoderUserInfo(ready.token, 'global', options)
    uid = uid ?? (info.userID === '' ? null : info.userID)
    email = info.email === '' ? null : info.email
    name = info.name === '' ? null : info.name
  } catch {
    // best-effort：uid 已有轮询给的那一份；邮箱与名字缺了只影响卡片显示。
  }
  return {
    accessToken: ready.token,
    refreshToken: ready.refreshToken,
    expiresAt: ready.expiresAt,
    region: 'global',
    origin: 'device',
    uid,
    email,
    accountName: name,
    personalToken: null,
    organizationId: null,
    organizationTags: [],
    dataPolicyAgreed: false,
    authenticatedAt: Date.now(),
    // machineId 不落盘：它不是凭据的一部分，只是签名材料；读取顺序见 cosy.ts。
    ...(() => { void machineId; return {} })(),
  }
}

/**
 * PAT → 落盘凭据。
 *
 * 兑换 + userinfo 补齐；**PAT 本体留在凭据里**（host-only），因为 PAT 的「刷新」
 * 就是拿它重新兑换一把 job token（pi-provider 把 PAT 编进 refresh 字段，
 * 本线路把它放进一个具名字段——同一件事，更好读）。
 *
 * ---------------------------------------------------------------------------
 * 自动补认区域
 * ---------------------------------------------------------------------------
 * 区域是**凭据的属性**，但 PAT 字符串本身不自述区域，而卡片上的区域选择器默认停在
 * 全球区。中国站的 PAT 拿去全球区端点兑换，上游回的是 400 `BadRequest`——没有
 * 任何一句说明「你打错了区」，用户看到的只有一串 requestId。这一步因此不是
 * 「多试一次」，而是**把选错区域的这个必然失败翻译成一次成功的登录**。
 *
 * 只在明确的 token 被拒状态下换区（{@link qoderPatRejectionStatus}）：HTTP 429、
 * 5xx、网络错误都不换——那些是瞬时故障，换区重发只会把一个可重试的问题变成两次
 * 打上游。首次命中的区域写进凭据，之后刷新照它走。
 */
export async function qoderCredentialsFromPat(
  personalToken: string,
  region: QoderRegion,
  options: QoderRequestOptions = {},
): Promise<QoderCredentials> {
  const pat = personalToken.trim()
  if (pat === '') throw new Error(PROVIDER_NAME + ' 的 PAT 是空的。')
  // 形状检查在发网络请求之前：粘贴时多带了引号/换行（从网页或终端复制最常见），
  // 上游只会回一句 BadRequest，白白让用户以为是 token 失效。
  if (!pat.startsWith('pt-')) {
    throw new Error(
      PROVIDER_NAME + ' 的 PAT 格式不对：它必须以 `pt-` 开头，粘贴时不要带引号或多余空白。'
      + '令牌在 https://qoder.com/account/integrations（中国站是 https://qoder.com.cn/account/integrations）生成。',
    )
  }
  // 首选区域打头，其余区作为「区域猜错」的候选跟在后面；顺序稳定，首个成功者即区域。
  const candidates: readonly QoderRegion[] = [region, ...QODER_REGIONS.filter((other) => other !== region)]
  let resolved: QoderRegion = region
  let exchanged: Awaited<ReturnType<typeof exchangeQoderJobToken>> | null = null
  let rejection: unknown = null
  for (const candidate of candidates) {
    try {
      exchanged = await exchangeQoderJobToken(pat, candidate, options)
      resolved = candidate
      rejection = null
      break
    } catch (error) {
      rejection = error
      // 只有「这把 token 不认」才值得换区再试；其余（限流、5xx、超时）如实上抛。
      if (!(error instanceof QoderPatExchangeError) || !qoderPatRejectionStatus(error.status)) throw error
    }
  }
  if (exchanged === null) {
    // 所有区都拒了：保留上游那句技术详情（排查要用），但先把能照做的下一步说清楚——
    // 用户看到 `{"errorCode":"BadRequest","errorMessage":"Bad request"}` 是没法行动的。
    //
    // 抛的仍是 QoderPatExchangeError（不是普通 Error）：号池的 refreshFailureStatus 按类型与
    // status 分类，换成普通 Error 会让一个「该重新登录」的账号被当成瞬时故障一直重试。
    const primary = rejection instanceof Error ? rejection.message : String(rejection)
    const tried = candidates.length > 1
      ? regionLabel(candidates[0]!) + '与' + regionLabel(candidates[1]!) + '两个区域都试过'
      : regionLabel(region) + '区域试过'
    const status = rejection instanceof QoderPatExchangeError ? rejection.status : 400
    throw new QoderPatExchangeError(
      '这把 PAT 被上游拒了（' + tried + '，都会在兑换时被拒）。'
      + '最可能的原因是它已经被撤销或过期——请到 Integrations 页重新生成一个再粘贴。'
      + '技术详情：' + primary,
      status,
      region,
    )
  }
  let uid: string | null = null
  let email: string | null = null
  let name: string | null = null
  let organizationId: string | null = null
  let organizationTags: string[] = []
  let dataPolicyAgreed = false
  try {
    const info = await fetchQoderUserInfo(exchanged.token, resolved, options)
    uid = info.userID === '' ? null : info.userID
    email = info.email === '' ? null : info.email
    name = info.name === '' ? null : info.name
    organizationId = info.organizationId ?? null
    organizationTags = info.organizationTags ?? []
    dataPolicyAgreed = info.dataPolicyAgreed === true
  } catch {
    // best-effort：兑换已成功；身份字段缺失只影响 COSY 载荷的完整度与卡片显示。
  }
  return {
    accessToken: exchanged.token,
    refreshToken: exchanged.refreshToken,
    expiresAt: exchanged.expiresAt,
    region: resolved,
    origin: 'pat',
    uid,
    email,
    accountName: name,
    personalToken: pat,
    organizationId,
    organizationTags,
    dataPolicyAgreed,
    authenticatedAt: Date.now(),
  }
}

/** 区域的短名（只用于拼给人看的一句话，卡片另有自己的文案）。 */
function regionLabel(region: QoderRegion): string {
  return REGION_HOSTS[region].title
}

/**
 * 刷新一份凭据（号池 refresh 钩子的实现）。
 *
 * 两条路径（凭据的 origin 决定）：
 *
 * - **PAT**：拿存下的 PAT 重新兑换（pi-provider 的 isPatRefresh 路径同一做法）；
 * - **其余**：\`refreshToken\` 走 center 刷新端点；没有 refreshToken 的凭据
 *   无法刷新，抛出明确的错误（号池据此把账号标成需要重新登录）。
 *
 * 失败带上 \`status\`（有 HTTP 状态时），号池据此分类「这个账号要重登」还是
 * 「瞬时故障，别判死」。
 *
 * PAT 分支走的是 {@link qoderCredentialsFromPat}，因此**也和首次登录一样会补认区域**：
 * 一份区域记错了的旧凭据，会在下一次刷新时自己搬到真正认它的那一区（区域本来就是
 * 凭据的属性，而 PAT 是唯一能问出它归属的原料）。这是修好「区域选错 → 永远 400」
 * 的第二半——只修首次登录的话，落盘里已有的错区账号会一直刷不上。
 */
export async function refreshQoderCredential(
  credentials: QoderCredentials,
  fetchFn: typeof fetch = fetch,
): Promise<QoderCredentials> {
  if (credentials.origin === 'pat' && credentials.personalToken !== null) {
    const refreshed = await qoderCredentialsFromPat(credentials.personalToken, credentials.region, { fetchFn })
    // 刷新不换身份字段之外的东西：adopt 判别式与接管时刻保持原样。
    return {
      ...refreshed,
      authenticatedAt: credentials.authenticatedAt,
      ...(credentials.adopted === true ? { adopted: true as const, source: credentials.source, sourcePath: credentials.sourcePath } : {}),
    }
  }
  if (credentials.refreshToken === null || credentials.refreshToken === '') {
    const error = new Error(PROVIDER_NAME + ' 的这份凭据没有刷新令牌，只有重新登录才能续期。') as Error & { status?: number }
    error.status = 401
    throw error
  }
  const refreshed = await refreshQoderAccessToken(
    { accessToken: credentials.accessToken, refreshToken: credentials.refreshToken },
    credentials.region,
    { fetchFn },
  )
  return {
    ...credentials,
    accessToken: refreshed.token,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
  }
}

// ---------------------------------------------------------------------------
// 流程状态机（与 step-code 的 oauth.ts 同一个外壳，理由见文件头）
// ---------------------------------------------------------------------------

let pendingCredential: QoderCredentials | null = null
let flow: QoderLoginFlowStatus = { status: 'idle' }
let controller: AbortController | null = null

/** 卡片轮询的状态切片。返回副本，调用方改不到内部状态。 */
export function getQoderLoginStatus(): QoderLoginFlowStatus {
  return { ...flow }
}

/** 取消进行中的流程并回到 idle（设置卡片的「取消」）。 */
export function resetQoderLogin(): void {
  controller?.abort('login reset')
  controller = null
  flow = { status: 'idle' }
}

/** 看看有没有一份已经拿到、还没被取走的凭据（纯内存读）。 */
export function peekQoderLoginCredential(): QoderCredentials | null {
  return pendingCredential
}

/** 取走那份凭据并清空（同一份凭据只该被落盘一次）。 */
export function takeQoderLoginCredential(): QoderCredentials | null {
  const credential = pendingCredential
  pendingCredential = null
  return credential
}

/** 可被取消的 sleep。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    const timer = setTimeout(() => { cleanup(); resolve() }, Math.max(0, ms))
    function onAbort(): void {
      clearTimeout(timer)
      cleanup()
      const reason: unknown = signal.reason
      reject(reason instanceof Error ? reason : new Error('操作已取消'))
    }
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface QoderLoginOptions {
  /** 测试缝。默认 fetch。 */
  fetchFn?: typeof fetch
  env?: NodeJS.ProcessEnv
  /** 完成的登录写到哪里（接入层传号池的保存函数）。 */
  onSave?: (credential: QoderCredentials) => Promise<unknown>
  /** 本地总时限；缺省 10 分钟，可由 QODER_LOGIN_TIMEOUT_MS 覆盖。 */
  timeoutMs?: number
}

/**
 * 开始一次浏览器设备流登录（**仅全球区**；CN 没有设备流，走 PAT 或 adopt）。
 *
 * 流程跑在 host 上（controller + flow），设置卡片只跟随 getQoderLoginStatus——
 * 与其余各线路的登录面同构。轮询节奏 2 秒一次，总超时取本地总时限
 * （服务端对 verifier 的硬截止由 404→failed 的翻转表达）。
 */
export async function beginQoderLogin(
  region: QoderRegion,
  options: QoderLoginOptions = {},
): Promise<QoderLoginFlowStatus> {
  resetQoderLogin()
  pendingCredential = null
  const startedAt = Date.now()
  // CN 没有设备流（REGION_HOSTS 表逐字如此）：在 host 侧也拒绝，而不是等到
  // 打开一个不存在的页面才失败。卡片那边同时把按钮藏起来。
  if (!regionSupportsDeviceLogin(region)) {
    flow = {
      status: 'error',
      region,
      startedAt,
      completedAt: Date.now(),
      error: PROVIDER_NAME + ' 中国站不支持浏览器登录，请改用 PAT（' + REGION_HOSTS.cn.patPage + '）或导入本机 qodercli 登录态。',
      retryable: false,
    }
    return getQoderLoginStatus()
  }
  const active = new AbortController()
  controller = active
  const env = options.env ?? process.env
  const params = createQoderDeviceParams(env)
  const authorizeUrl = qoderDeviceAuthorizeUrl(params)
  const deadline = startedAt + (options.timeoutMs ?? loginTimeoutMs(env))
  flow = {
    status: 'pending',
    region,
    authorizeUrl,
    startedAt,
    expiresAt: deadline,
    pollIntervalSec: DEVICE_POLL_INTERVAL_MS / 1000,
    progress: '等待浏览器授权…（每 ' + DEVICE_POLL_INTERVAL_MS / 1000 + ' 秒查询一次）',
  }

  void (async () => {
    try {
      for (;;) {
        active.signal.throwIfAborted()
        if (Date.now() >= deadline) {
          throw new Error(PROVIDER_NAME + ' 登录超时：没有在有效期内完成浏览器授权。')
        }
        const result = await pollQoderDeviceToken(
          { nonce: params.nonce, verifier: params.verifier },
          { ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }), signal: active.signal, env },
        )
        if (result.state === 'ready') {
          const credentials = await qoderCredentialsFromDevicePoll(result, params.machineId, {
            ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
            env,
          })
          pendingCredential = credentials
          if (options.onSave !== undefined) await options.onSave(credentials)
          flow = {
            status: 'complete',
            region,
            authorizeUrl,
            startedAt,
            completedAt: Date.now(),
            expiresAt: deadline,
            pollIntervalSec: DEVICE_POLL_INTERVAL_MS / 1000,
            progress: '授权完成',
            ...(credentials.uid === null ? {} : { uid: credentials.uid }),
          }
          return
        }
        if (result.state === 'failed') {
          throw new Error(result.reason)
        }
        await sleep(DEVICE_POLL_INTERVAL_MS, active.signal)
      }
    } catch (error) {
      if (active.signal.aborted) return
      flow = {
        status: 'error',
        region,
        authorizeUrl,
        startedAt,
        completedAt: Date.now(),
        expiresAt: deadline,
        pollIntervalSec: DEVICE_POLL_INTERVAL_MS / 1000,
        error: error instanceof Error ? error.message : String(error),
        // transport 类的失败值得重试（再点一次登录）；协议类（形状不对）不值得。
        retryable: !(error instanceof Error && /不是 JSON|没有 token/.test(error.message)),
      }
    } finally {
      if (controller === active) controller = null
    }
  })()

  return getQoderLoginStatus()
}
