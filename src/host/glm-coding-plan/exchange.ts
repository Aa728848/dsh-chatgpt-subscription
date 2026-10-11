/**
 * 兑换链：OAuth access_token → 可用的 Coding Plan Key（计划 §3.2，证据等级 B）。
 *
 * 链路逐字照三个独立实现（TriDefender/zcode-api、Sakuralaaa/z-code-2api、CLIProxyAPI 插件生态）
 * 同构实现的那一条，四个端点与两种字段形状都记在 `EXCHANGE_PATHS` 的注释里：
 *
 *     access_token
 *       -> [仅国际区] POST {business}/api/auth/z/login  {token}                    => 业务 JWT + expires_in
 *       -> GET  {business}/api/biz/customer/getCustomerInfo                            => 默认机构 orgId / 默认项目 projectId
 *       -> GET/POST {business}/api/biz/v1/organization/{org}/projects/{proj}/api_keys   => 找或建一把 Key
 *       -> GET  .../api_keys/copy/{apiKeyId}                                          => secretKey
 *       -> {apiKeyId}.{secretKey}                                                      => Coding Plan Key
 *
 * **两区的鉴权形状本来就不一样**，这不是实现上的瑕疵（逐字：TriDefender/zcode-api
 * `src/auth/resolver.ts` 的两个分支）：
 *
 * - 国际区（`zai`）：先 `POST /api/auth/z/login` 换业务 JWT，之后所有 `/api/biz/*`
 *   带 `Authorization: Bearer <bizToken>`。
 * - 国区（`bigmodel`）：**跳过 z/login**，直接拿 OAuth access_token 当 `Authorization`
 *   头（裸值，不加 `Bearer`）打 `/api/biz/*`；host 是 `https://bigmodel.cn`
 *   （`open.bigmodel.cn` 是**模型面**的 host，别混用）。
 *
 * 推论：国区这一层**没有**业务 JWT，所以 `biz-token-cache.ts` 只服务于国际区。
 *
 * 三条必须写下来的纪律：
 *
 * 1. **本线路用自己的 Key 名**（`GLM_KEY_NAME` = `dsh-glm-coding-plan`）：
 *    社区实现用 `zcode-api-key`，撞名会导致本线路登录时轮转或删除官方 ZCode 客户端
 *    正在使用的那把 Key（计划 §3.2）。
 * 2. **落盘前必须验一次**：拿配额接口探一次 Coding Plan 面（裸 Key、无 Bearer，
 *    逐字证据 `docs/bigmodel-coding-plan-usage-quota.md`）。账号没有套餐就在**登录阶段**
 *    报错，而不是等到某次对话里以一个莫名其妙的 429 暴露出来。
 * 3. **国区这一段未验证**（计划 R5 / §9）：三个同构实现都以国际区为主，
 *    国区的业务面形状是否同构没有实测。失败时必须给出可操作报错，不得静默。
 *
 * 参考实现的许可证是 null / AGPL-3.0，所以这里**只读协议、照协议重写**，没有复制任何代码。
 */

import type { GlmAllowanceKind, GlmRegion } from '../../shared/glm-coding-plan-contracts.ts'
import {
  DISCOVERY_TIMEOUT_MS,
  ERROR_CODE,
  EXCHANGE_PATHS,
  GLM_KEY_NAME,
  QUOTA_PLAN_LEVELS,
  QUOTA_PATH,
  USER_AGENT,
  businessHost,
  keyName,
} from './types.ts'

/**
 * 国区兑换链的未验证声明。
 *
 * 任何国区失败都要把它带上：一句「兑换失败」对用户毫无指导意义，
 * 而「国区兑换链未经验证」能直接告诉他下一步是换国际区，还是用 `DSH_GLM_*` 覆盖指向实测过的部署。
 */
export const CN_EXCHANGE_UNVERIFIED_NOTICE =
  '国区（bigmodel.cn）兑换链未经验证：计划 §3.2 / R5 记录三个同构实现都以国际区为主，'
  + '国区业务面形状没有实测样本。可改用国际区登录，或用 DSH_GLM_CN_BUSINESS_HOST 等环境变量指向实测过的部署。'

/** 兑换链的任何一步失败。 */
export class GlmExchangeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options === undefined ? undefined : { cause: options.cause })
    this.name = 'GlmExchangeError'
  }
}

/**
 * 兑换链跑通了，但这把 Key 不能服务 Coding Plan 面。
 *
 * 单独一类是因为处置不同：这不是「再试一次」能解决的，也不是链路的 bug，
 * 而是这个账号没有套餐 / 套餐已失效 / 没有建 Key 的权限，必须让用户在登录阶段就看到。
 */
export class GlmCodingPlanUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GlmCodingPlanUnavailableError'
  }
}

/** 兑换链跑通并验过之后的结果。host 侧专用，不进共享契约。 */
export interface GlmCodingPlanKey {
  region: GlmRegion
  /** `{apiKeyId}.{secretKey}`：配额接口要的就是这个裸值（不可加 Bearer）。 */
  codingPlanKey: string
  apiKeyId: string
  secretKey: string
  /** Key 名，便于诊断「是不是本线路建的」。 */
  keyName: string
  /** 本次是新建的还是复用了已存在的同名 Key。 */
  keyCreated: boolean
  organizationId: string
  projectId: string
  /** 控制台侧的机构名，仅用于诊断与卡片展示。 */
  accountName: string | null
  /**
   * 业务 JWT（控制台口径：zcodejwttoken），落盘给 `biz-token-cache.ts` 用。
   *
   * 国区没有这一层（它拿裸 access_token 直接打 `/api/biz/*`），所以那里是 null。
   */
  bizToken: string | null
  /** 业务 JWT 的失效时刻（Unix 毫秒）；国区为 null。 */
  bizTokenExpiresAt: number | null
  /** 验活时读到的套餐机器档位（lite / pro / max），上游没给则为 null。 */
  planLevel: string | null
  /**
   * 验活认定的额度类型。落盘后由设置卡片如实显示，**不假装**免费额度是付费套餐。
   *
   * 缺省取 'unknown' 而不是必填：旧凭据文件里没有这个键，解析时补成 unknown
   * （见 `token-store.ts`），因此它必须允许「读不到」。
   */
  allowance?: GlmAllowanceKind
}

export interface GlmExchangeOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  /** 单次请求超时；缺省走 `DISCOVERY_TIMEOUT_MS`（20s）。 */
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

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** 把区域事实拼进报错里：国区的每一条失败都必须带 `CN_EXCHANGE_UNVERIFIED_NOTICE`。 */
function fail(region: GlmRegion, message: string, cause?: unknown): never {
  throw new GlmExchangeError(
    region === 'cn' ? message + '　' + CN_EXCHANGE_UNVERIFIED_NOTICE : message,
    cause === undefined ? undefined : { cause },
  )
}

/**
 * 业务面信封里被当成成功的那几个码。
 *
 * 与 OAuth 控制面**不同**：控制面按计划 §3.1 只认 `code === 0`，
 * 而业务面（`/api/auth/z/login` 与 `/api/biz/*`）的同构实现把 `0` 与 `200` 都当成功，
 * 还同时认 `code` 与 `status` 两个字段名。这里照业务面的证据走。
 */
function isBizSuccessCode(code: number | string): boolean {
  return code === 0 || code === 200 || code === '0' || code === '200'
}

function readBizCode(payload: Record<string, unknown>): number | string | undefined {
  const raw = payload['code'] ?? payload['status']
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  return undefined
}

/** 把 `{orgId}` / `{projectId}` / `{apiKeyId}` 三个占位符填成真路径。 */
function fillPath(template: string, values: {
  organizationId: string
  projectId: string
  apiKeyId?: string
}): string {
  return template
    .replace('{orgId}', encodeURIComponent(values.organizationId))
    .replace('{projectId}', encodeURIComponent(values.projectId))
    .replace('{apiKeyId}', encodeURIComponent(values.apiKeyId ?? ''))
}

// ---------------------------------------------------------------------------
// 第 1 步：access_token → 业务 JWT
// ---------------------------------------------------------------------------

/** 业务 JWT（控制台口径：zcodejwttoken）及其失效时刻。 */
export interface GlmBizToken {
  token: string
  /** 上游给的 `expires_in`（秒）；上游没给时按 JWT 自身的 `exp` 折算。 */
  expiresInSec: number
  expiresAt: number
}

/**
 * 只解码不校验地读一个 JWT 的 `exp`。
 *
 * 它**不参与任何鉴权判断**——校验签名需要上游密钥，本插件没有也不需要：
 * 这里只想在上游漏给 `expires_in` 时仍能给缓存算一个失效时刻。
 */
function jwtExpiryMs(token: string): number | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = asRecord(JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')))
    if (payload === undefined) return undefined
    const exp = Number(payload['exp'])
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/**
 * `POST {business}/api/auth/z/login`，体 `{"token": <oauth access_token>}`。
 *
 * 请求**不带** Authorization 头：access_token 在体里，这是三个同构实现一致的做法。
 * 响应取 `access_token`（同构实现还兼容 `accessToken` 与 `data.access_token`，本线路同样容忍）。
 *
 * `expires_in` 是业务 JWT 缓存的唯一时间来源（计划 §3.6：官方按「提前 120 秒 + 0~60 秒抖动」重取）。
 * 上游漏给时退回 JWT 自身的 `exp`；两者都没有就报错——一个不知道什么时候过期的缓存
 * 等于没有缓存，只会在长会话中途把用户踢出去。
 *
 * **只有国际区会调这个端点**：国区按逆向实现的 bigmodel 分支直接用裸 access_token
 * 打 `/api/biz/*`，根本不经过 z/login（见文件头注释）。留成导出函数是为了让 W6 与测试
 * 都能单独调它，而不是为了两区共用。
 */
export async function loginBizToken(
  accessToken: string,
  region: GlmRegion,
  options: GlmExchangeOptions = {},
): Promise<GlmBizToken> {
  const fetchFn = options.fetchFn ?? fetch
  const env = options.env ?? process.env
  const url = businessHost(region, env) + EXCHANGE_PATHS.login

  let payload: unknown
  let ok = false
  let status = 0
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({ token: accessToken }),
      signal: withTimeout(options.signal, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS),
    })
    status = response.status
    ok = response.ok
    payload = await response.json().catch(() => undefined)
  } catch (error) {
    fail(region, '业务登录（' + url + '）请求失败：' + (error instanceof Error ? error.message : String(error)), error)
  }

  if (!ok) {
    fail(region, '业务登录失败（HTTP ' + status + '）：' + url + '。OAuth 登录态可能已过期，请重新登录。')
  }
  const root = asRecord(payload)
  if (root === undefined) {
    return fail(region, '业务登录响应不是对象：' + url)
  }
  const code = readBizCode(root)
  if (code !== undefined && !isBizSuccessCode(code)) {
    fail(region, '业务登录返回业务码 ' + String(code) + '：' + (asString(root['msg']) ?? asString(root['message']) ?? '（无说明）'))
  }

  const data = asRecord(root['data']) ?? root
  const token = asString(data['access_token']) ?? asString(data['accessToken']) ?? asString(root['access_token'])
  if (token === undefined) {
    return fail(region, '业务登录响应里没有 access_token，兑换链无法继续（响应形状可能已变更）。')
  }

  const expiresInRaw = Number(data['expires_in'] ?? root['expires_in'])
  let expiresAt = Number.isFinite(expiresInRaw) && expiresInRaw > 0
    ? Date.now() + expiresInRaw * 1000
    : undefined
  if (expiresAt === undefined) expiresAt = jwtExpiryMs(token)
  if (expiresAt === undefined) {
    return fail(region, '业务登录既没有 expires_in、token 里也解不出 exp，无法判断业务 JWT 的有效期。')
  }
  return { token, expiresInSec: Math.max(1, Math.round((expiresAt - Date.now()) / 1000)), expiresAt }
}

// ---------------------------------------------------------------------------
// 第 2 步：默认机构 / 默认项目
// ---------------------------------------------------------------------------

/**
 * 「默认机构」「默认项目」的标记文案（逐字：控制台界面文案，取自同构实现的常量）。
 *
 * 找的是**包含**关系而不是全等：控制台的展示名可能带前后缀，
 * 而这两个中文名是唯一稳定的锚点——它们是界面文案，机器名随时可能变。
 */
const DEFAULT_ORG_MARKER = '默认机构'
const DEFAULT_PROJECT_MARKER = '默认项目'

/** 默认机构与默认项目。 */
export interface GlmCustomerScope {
  organizationId: string
  projectId: string
  organizationName: string | null
  projectName: string | null
}

/**
 * 业务面一次调用：统一处理状态码、信封与区域说明。
 *
 * 返回的是 `body.data ?? body`——业务接口把结果放在 `data` 里，
 * 但同构实现允许信封与数据同层，所以两种都认。
 * 返回类型刻意是 `unknown`：`api_keys` 列表的 `data` **就是一个数组**，
 * 把它当对象收下会在这一步悄悄变成空列表，然后莫名其妙地去新建一把 Key。
 */
async function bizRequest(options: {
  url: string
  method: 'GET' | 'POST'
  authorization: string
  body?: unknown
  region: GlmRegion
  action: string
  fetchFn?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<unknown> {
  const fetchFn = options.fetchFn ?? fetch

  let response: Response
  try {
    response = await fetchFn(options.url, {
      method: options.method,
      headers: {
        authorization: options.authorization,
        accept: 'application/json',
        ...(options.method === 'POST' ? { 'content-type': 'application/json' } : {}),
        'user-agent': USER_AGENT,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: withTimeout(options.signal, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS),
    })
  } catch (error) {
    fail(options.region, options.action + ' 请求失败：' + (error instanceof Error ? error.message : String(error)), error)
  }

  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    fail(options.region, options.action + ' 失败（HTTP ' + response.status + '）：' + options.url)
  }
  const root = asRecord(payload)
  if (root === undefined) {
    return fail(options.region, options.action + ' 的响应不是对象：' + options.url)
  }
  const code = readBizCode(root)
  if (code !== undefined && !isBizSuccessCode(code)) {
    fail(
      options.region,
      options.action + ' 返回业务码 ' + String(code) + '：'
      + (asString(root['msg']) ?? asString(root['message']) ?? '（无说明）'),
    )
  }
  return root['data'] === undefined || root['data'] === null ? root : root['data']
}

/** 在列表里挑名字里带标记文案的那一项。 */
function pickByName(items: readonly unknown[], marker: string): Record<string, unknown> | undefined {
  for (const item of items) {
    const record = asRecord(item)
    if (record === undefined) continue
    const name = asString(record['organizationName'])
      ?? asString(record['projectName'])
      ?? asString(record['name'])
    if (name !== undefined && name.includes(marker)) return record
  }
  return undefined
}

/**
 * `GET {business}/api/biz/customer/getCustomerInfo`：定位默认机构与默认项目。
 *
 * 找不到标记文案时退回列表第一项（同构实现的做法）：宁可猜一个，也不要让用户去回答
 * 「你的机构叫什么」——那条交互在本插件里不存在，而列表非空本身就说明账号有机构。
 * 列表为空才是真失败。
 */
export async function resolveCustomerScope(
  region: GlmRegion,
  authorization: string,
  options: GlmExchangeOptions = {},
): Promise<GlmCustomerScope> {
  const env = options.env ?? process.env
  const url = businessHost(region, env) + EXCHANGE_PATHS.customerInfo
  const raw = await bizRequest({
    url,
    method: 'GET',
    authorization,
    region,
    action: '查询客户信息（默认机构 / 默认项目）',
    ...options,
  })
  const data = asRecord(raw)
  if (data === undefined) {
    return fail(region, '客户信息的响应结构无法解析：' + url)
  }

  const orgs = Array.isArray(data['organizations'])
    ? data['organizations'] as unknown[]
    : Array.isArray(data['orgs']) ? data['orgs'] as unknown[] : []
  if (orgs.length === 0) {
    return fail(region, '账号下没有可用机构（getCustomerInfo 返回空列表）。')
  }
  const orgRecord = pickByName(orgs, DEFAULT_ORG_MARKER) ?? asRecord(orgs[0]) ?? {}
  const organizationId = asString(orgRecord['organizationId']) ?? asString(orgRecord['id']) ?? asString(orgRecord['orgId'])
  if (organizationId === undefined) {
    return fail(region, '客户信息里找不到机构 id（organizationId / id / orgId 都没有）。')
  }

  const projects = Array.isArray(orgRecord['projects']) ? orgRecord['projects'] as unknown[] : []
  if (projects.length === 0) {
    return fail(region, '机构 ' + organizationId + ' 下没有可用项目（默认项目缺失）。')
  }
  const projectRecord = pickByName(projects, DEFAULT_PROJECT_MARKER) ?? asRecord(projects[0]) ?? {}
  const projectId = asString(projectRecord['projectId']) ?? asString(projectRecord['id'])
  if (projectId === undefined) {
    return fail(region, '客户信息里找不到项目 id（projectId / id 都没有）。')
  }

  return {
    organizationId,
    projectId,
    organizationName: asString(orgRecord['organizationName']) ?? asString(orgRecord['name']) ?? null,
    projectName: asString(projectRecord['projectName']) ?? asString(projectRecord['name']) ?? null,
  }
}

// ---------------------------------------------------------------------------
// 第 3、4 步：找或建 Key，取 secret
// ---------------------------------------------------------------------------

/** 一把 api key 的最小形状。 */
export interface GlmApiKeyRef {
  apiKeyId: string
  created: boolean
}

/**
 * 在该机构该项目下找一把本线路的 Key，没有就建一把。
 *
 * 找的条件是**名字等于** `keyName()`（默认 `GLM_KEY_NAME`）：撞名的代价是
 * 官方客户端正在用的那把 Key 被轮转或删除（计划 §3.2）。
 * 列表调用失败不直接判死而是继续走新建——同构实现也是这么做的，
 * 因为「列不出来」与「没有建 Key 的权限」是两回事，后者才值得报错。
 */
export async function findOrCreateApiKey(
  region: GlmRegion,
  authorization: string,
  scope: { organizationId: string; projectId: string },
  options: GlmExchangeOptions & { name?: string } = {},
): Promise<GlmApiKeyRef> {
  const env = options.env ?? process.env
  const name = options.name ?? keyName(env)
  const url = businessHost(region, env) + fillPath(EXCHANGE_PATHS.apiKeys, scope)

  let listed: unknown[] = []
  try {
    const data = await bizRequest({
      url,
      method: 'GET',
      authorization,
      region,
      action: '列出 API Key',
      ...options,
    })
    // 列表的 data **就是数组**（同构实现按 Array.isArray 判断），也兼容包一层的形状。
    if (Array.isArray(data)) listed = data
    else {
      const record = asRecord(data)
      if (record !== undefined) {
        if (Array.isArray(record['apiKeys'])) listed = record['apiKeys'] as unknown[]
        else if (Array.isArray(record['list'])) listed = record['list'] as unknown[]
      }
    }
  } catch {
    listed = []
  }

  for (const item of listed) {
    const record = asRecord(item)
    if (record === undefined || asString(record['name']) !== name) continue
    const apiKeyId = asString(record['apiKey']) ?? asString(record['apiKeyId']) ?? asString(record['id'])
    // 只在形状真的可用时复用：一条畸形记录走新建，比存下一把注定 401 的凭据好。
    if (apiKeyId !== undefined) return { apiKeyId, created: false }
  }

  const created = await bizRequest({
    url,
    method: 'POST',
    authorization,
    region,
    action: '创建 API Key（名称 ' + name + '）',
    ...options,
    body: { name },
  })
  const createdRecord = asRecord(created)
  const apiKeyId = asString(createdRecord?.['apiKey'])
    ?? asString(createdRecord?.['apiKeyId'])
    ?? asString(createdRecord?.['id'])
  if (apiKeyId === undefined) {
    return fail(region, '创建 API Key 的响应里没有 apiKey 字段（响应形状可能已变更）。')
  }
  return { apiKeyId, created: true }
}

/**
 * `GET .../api_keys/copy/{apiKeyId}`：取 secretKey。
 *
 * secret 只在这个端点出现一次，所以每次兑换都要再取一次，没有可依赖的缓存。
 * 缺 secret 是硬失败：Coding Plan Key 的形状就是 `id.secret`（计划 §3.2、D4），
 * 拿半把 Key 去配额接口只会得到一个没有出处的 401。
 */
export async function copyApiKeySecret(
  region: GlmRegion,
  authorization: string,
  scope: { organizationId: string; projectId: string; apiKeyId: string },
  options: GlmExchangeOptions = {},
): Promise<string> {
  const env = options.env ?? process.env
  const url = businessHost(region, env) + fillPath(EXCHANGE_PATHS.apiKeyCopy, scope)
  const data = await bizRequest({
    url,
    method: 'GET',
    authorization,
    region,
    action: '取 API Key 的 secret',
    ...options,
  })
  const record = asRecord(data)
  const secret = asString(record?.['secretKey']) ?? asString(record?.['secret_key'])
  if (secret === undefined) {
    return fail(region, 'API Key copy 的响应里没有 secretKey（响应形状可能已变更）。')
  }
  return secret
}

// ---------------------------------------------------------------------------
// 落盘前校验
// ---------------------------------------------------------------------------

/**
 * 「账号没有付费 Coding Plan」这一类业务码 → 一句能照做的提示。
 *
 * 这张表现在是**放行信号**而不是拒绝信号（见下方 `classifyProbe`）：命中它的应答说明
 * 凭据本身被配额面认出来了，拒的是套餐/额度维度。官方文档（逐字：
 * zcode.z.ai/cn/docs/configuration）写明新用户注册即自动获得 5 天、每天 800 万 token 的
 * 「体验套餐」，因此这类账号必须放行——「没有付费套餐」不等于「没有额度」。
 */
const NO_PLAN_REASONS: Readonly<Record<number, string>> = {
  [ERROR_CODE.NO_BALANCE]: '账号没有余额，也没有可用的资源包。',
  [ERROR_CODE.NO_PERMISSION]: '当前套餐不包含 Coding Plan API。',
  [ERROR_CODE.PLAN_EXPIRED]: 'GLM Coding Plan 套餐已失效。',
  [ERROR_CODE.PLAN_LIMIT]: '套餐额度已用尽（本线路只提示，不绕过）。',
  [ERROR_CODE.MODEL_NOT_IN_PLAN]: '当前套餐不包含 Coding Plan 模型。',
}

/**
 * 「凭据本身不被接受」这一类业务码。
 *
 * 与上面那张表的区别就是本次改动要解决的那件事：**这一组说的是 key 有问题，
 * 上面那一组说的是账号没有付费套餐**。前者必须失败（放行等于拿着一把废 Key 进对话），
 * 后者必须放行（挡住新用户等于把免费额度用户挡在门外）。
 *
 * **未验证**：本插件没有实机账号，无法确认上游在 Coding Plan Key 无效时**一定**返回这三个码
 * 之一而不是别的形状。因此「裸 401/403 且无法从业务码上判定」的那一支走 `unknown` 放行，
 * 见 `classifyProbe` 的注释。
 */
const BAD_CREDENTIAL_REASONS: Readonly<Record<number, string>> = {
  [ERROR_CODE.AUTH_MISSING]: 'Coding Plan Key 没有出现在请求头里。',
  [ERROR_CODE.AUTH_INVALID]: 'Coding Plan Key 无效或不被接受。',
  [ERROR_CODE.AUTH_EXPIRED]: 'Coding Plan Key 已过期。',
}

/** 探一次 Coding Plan 面的结果。 */
export interface GlmPlanProbe {
  planLevel: string | null
  /**
   * 这次探活认定的额度类型。
   *
   * `plan` = 配额面给出了付费套餐的机器档位；`free-trial` = 配额面明确按套餐/额度维度
   * 拒了它（凭据有效）；`unknown` = 分不出是「key 坏了」还是「没有付费套餐」，
   * 而本线路在分不出时**选择放行**。
   */
  allowance: GlmAllowanceKind
}

/**
 * 把一次配额探活的观察结果归成三种额度类型之一。
 *
 * 判定依据（**全部是本仓库可查的证据，没有一条来自实机样本**）：
 *
 * 本函数只处理**成功读到数据**这一种情况（失败分支各自带自己的依据，见下方各分支注释）：
 *
 * - 读出的 `data.level` 落在已知付费档位（lite / pro / max）里 → `plan`。
 * - 读不出可识别的 `level` → `unknown`。**不猜**：没有实测样本证明免费额度账号会给出什么
 *   `level`，把「读到了配额」直接当成「有付费套餐」就是谎报。
 *
 * 另外两种 `unknown` 由失败分支给出（裸 401/403、无法归类的业务码）。它们和上面这条同属一类：
 * **分不出来就不假装知道**，同时一律放行。理由是不对称的——
 * 额度耗尽时上游会回 429，那是**可恢复**的；而误拒一个有效账号是**不可恢复**的
 * （用户再也登不进这条线路，也没有任何办法自查）。宁可让一把可疑的 key 进池子，
 * 让第一次真实请求把问题暴露出来。
 */
function classifyProbe(data: Record<string, unknown> | undefined): GlmAllowanceKind {
  const level = data === undefined ? undefined : asString(data['level'])
  if (level !== undefined && (QUOTA_PLAN_LEVELS as readonly string[]).includes(level)) {
    return 'plan'
  }
  return 'unknown'
}

function noPlanError(region: GlmRegion, detail: string): GlmCodingPlanUnavailableError {
  return new GlmCodingPlanUnavailableError(
    '兑换成功，但这把 Key 不能服务 GLM Coding Plan：' + detail
    + (region === 'cn' ? '　' + CN_EXCHANGE_UNVERIFIED_NOTICE : ''),
  )
}

/**
 * 落盘前的验活：`GET {business}/api/monitor/usage/quota/limit`。
 *
 * 头是 `authorization: <id>.<secret>` **裸值**——加了 Bearer 会鉴权失败，
 * 这与模型面正好相反（逐字：`docs/bigmodel-coding-plan-usage-quota.md`，证据等级 A）。
 *
 * 这一步的价值分两半，而两半的**处置相反**：
 *
 * - 凭据本身坏了（业务码落在 `BAD_CREDENTIAL_REASONS`）→ 登录阶段就失败。一把废 Key
 *   进对话只会让用户在某次请求里以一个莫名其妙的 401 暴露出来。
 * - 凭据有效但**没有付费套餐**（业务码落在 `NO_PLAN_REASONS`，或裸 401/403 分不出）→
 *   **放行**，并把额度类型如实记成 `free-trial` / `unknown`。官方文档（逐字：
 *   zcode.z.ai/cn/docs/configuration）写明新用户注册即自动获得 5 天、每天 800 万 token 的
 *   「体验套餐：无需付费」，所以「没有付费 Coding Plan」不等于「没有额度」——硬拒在登录阶段
 *   等于把免费额度的新用户全部挡在门外。额度耗尽时上游回 429，那是可恢复的。
 */
export async function verifyCodingPlanKey(
  region: GlmRegion,
  codingPlanKey: string,
  options: GlmExchangeOptions = {},
): Promise<GlmPlanProbe> {
  const fetchFn = options.fetchFn ?? fetch
  const env = options.env ?? process.env
  const url = businessHost(region, env) + QUOTA_PATH

  let response: Response
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: {
        // 裸 Key，不加 Bearer（见上方注释）。
        authorization: codingPlanKey,
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      signal: withTimeout(options.signal, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS),
    })
  } catch (error) {
    fail(region, '配额验活请求失败：' + (error instanceof Error ? error.message : String(error)), error)
  }

  const payload: unknown = await response.json().catch(() => undefined)
  const root = asRecord(payload)

  const rootCode = root === undefined ? undefined : Number(root['code'])
  const finiteCode = rootCode !== undefined && Number.isFinite(rootCode) ? rootCode : undefined

  if (!response.ok) {
    // 唯一的硬失败分支：业务码明说「凭据本身不被接受」。
    if (finiteCode !== undefined && BAD_CREDENTIAL_REASONS[finiteCode] !== undefined) {
      throw noPlanError(region, '业务码 ' + finiteCode + '：' + BAD_CREDENTIAL_REASONS[finiteCode])
    }
    // 套餐/额度维度的拒绝：配额面已经认出这把 Key，拒的是它的套餐。官方文档写明新用户
    // 有免费体验额度，所以放行并如实记成 free-trial。
    if (finiteCode !== undefined && NO_PLAN_REASONS[finiteCode] !== undefined) {
      return { planLevel: null, allowance: 'free-trial' }
    }
    if (response.status === 401 || response.status === 403) {
      // **未验证**：正文里没有可识别的业务码，分不出「key 真坏了」与「上游对无套餐账号也回 401」。
      // 选放行（unknown）：额度耗尽时上游回 429，可恢复；误拒有效账号不可恢复。
      return { planLevel: null, allowance: 'unknown' }
    }
    fail(region, '配额验活失败（HTTP ' + response.status + '）：' + url)
  }

  if (root === undefined) {
    return fail(region, '配额验活的响应不是对象：' + url)
  }
  const bizCode = readBizCode(root)
  if (bizCode !== undefined && !isBizSuccessCode(bizCode)) {
    const numeric = Number(bizCode)
    if (Number.isFinite(numeric) && BAD_CREDENTIAL_REASONS[numeric] !== undefined) {
      throw noPlanError(region, '业务码 ' + numeric + '：' + BAD_CREDENTIAL_REASONS[numeric])
    }
    if (Number.isFinite(numeric) && NO_PLAN_REASONS[numeric] !== undefined) {
      // 与上面同一个依据：套餐/额度维度，放行成免费额度。
      return { planLevel: null, allowance: 'free-trial' }
    }
    // 其余业务码（含上游新增的未识别码）：**未验证**它们是否表达「没有套餐」，选放行。
    return { planLevel: null, allowance: 'unknown' }
  }

  const data = asRecord(root['data']) ?? root
  return { planLevel: asString(data['level']) ?? null, allowance: classifyProbe(data) }
}

// ---------------------------------------------------------------------------
// 全链路
// ---------------------------------------------------------------------------

/**
 * 这一层之后 `/api/biz/*` 该带的头。
 *
 * 两区不同，逐字照 TriDefender/zcode-api 的两个分支：国际区换出业务 JWT 再带
 * `Bearer`，国区**跳过换**、直接用裸 access_token。
 */
export async function resolveBizAuthorization(
  accessToken: string,
  region: GlmRegion,
  options: GlmExchangeOptions = {},
): Promise<{ authorization: string; bizToken: string | null; bizTokenExpiresAt: number | null }> {
  if (region === 'intl') {
    const biz = await loginBizToken(accessToken, region, options)
    return {
      authorization: 'Bearer ' + biz.token,
      bizToken: biz.token,
      bizTokenExpiresAt: biz.expiresAt,
    }
  }
  // 国区：裸 access_token，无 Bearer。
  return { authorization: accessToken, bizToken: null, bizTokenExpiresAt: null }
}

/**
 * 走完整条兑换链并验活。
 *
 * 调用方（W6）拿到的是一把**已经证明凭据有效**的 Coding Plan Key：
 * 任何一步没过都不返回 Key，失败一律以异常形式给出可读原因。
 *
 * 注意「证明可用」这句话现在的口径：它证明的是**这把 Key 会被上游认出来**，
 * 不是「账号有付费套餐」。没有付费套餐（含体验额度）的账号同样在这里成功返回，
 * 额度类型记在 `allowance` 上。
 *
 * @throws {@link GlmCodingPlanUnavailableError} 链路通但这把 Key 不能服务 Coding Plan
 * @throws {@link GlmExchangeError} 链路本身没走通
 */
export async function exchangeForCodingPlanKey(
  accessToken: string,
  region: GlmRegion,
  options: GlmExchangeOptions = {},
): Promise<GlmCodingPlanKey> {
  const env = options.env ?? process.env
  const configured = keyName(env)
  // GLM_KEY_NAME 是默认值（可被 DSH_GLM_KEY_NAME 覆盖）；这里兜一次底，
  // 免得一个空名字走完整条链之后建出一把没有名字、只能靠「第一个」认回来的 Key。
  const effectiveName = configured.trim() === '' ? GLM_KEY_NAME : configured

  const biz = await resolveBizAuthorization(accessToken, region, options)
  const authorization = biz.authorization
  const scope = await resolveCustomerScope(region, authorization, options)
  const key = await findOrCreateApiKey(region, authorization, scope, { ...options, name: effectiveName })
  const secret = await copyApiKeySecret(region, authorization, { ...scope, apiKeyId: key.apiKeyId }, options)
  const codingPlanKey = key.apiKeyId + '.' + secret
  const probe = await verifyCodingPlanKey(region, codingPlanKey, options)

  return {
    region,
    codingPlanKey,
    apiKeyId: key.apiKeyId,
    secretKey: secret,
    keyName: effectiveName,
    keyCreated: key.created,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    accountName: scope.organizationName,
    bizToken: biz.bizToken,
    bizTokenExpiresAt: biz.bizTokenExpiresAt,
    planLevel: probe.planLevel,
    allowance: probe.allowance,
  }
}
