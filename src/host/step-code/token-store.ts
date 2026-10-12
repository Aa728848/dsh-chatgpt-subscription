/**
 * Step Code（Step Plan 订阅）线路的凭据 / 模型设置 / 偏好三件套。
 *
 * 本线路的凭据有一个别的线路都没有的性质，先说清楚，因为它决定了本文件几乎所有设计：
 *
 * **凭据是静态的。** Step 的 api_key 不是会话令牌——它不轮换、不刷新、不过期
 * （逐字：官方把它存成 `expires: Number.MAX_SAFE_INTEGER`，`step-provider/index.ts:367`，
 * 且 `refreshStepOAuth` 对任何别的 refresh 一律抛错）。所以：
 *
 * - 本文件**没有** refresh 相关的一切（没有提前刷新量、没有抖动、没有刷新链）；
 * - 号池不得因为 `expires` 是 MAX_SAFE_INTEGER 就判成异常——那正是「永不过期」的写法；
 * - 号池不得轮换它，一个池里的账号只有「能用」与「被用户撤销」两种状态，
 *   后者由上游拒绝表现为鉴权失败，不是本地时钟到期。
 *
 * 第二件必须记住的事：**本线路自己拥有它的凭据副本，但从不拥有 stepcode 的文件**。
 * adopt 只是把 `~/.stepcode/auth.json` 读成一份快照存进本插件自己的凭据存储
 * （波次 2A 的 `adopt.ts` 只读、不写、不删）。所以这里落盘的 adopt 凭据带
 * `adopted / source / sourcePath` 三个判别式字段，与其它线路的 adopt 语义一致。
 *
 * 三件套的分工与兄弟线路一致：凭据走 DPAPI / Keychain / Secret Service；
 * 模型设置是明文 JSON，带写后回读校验；偏好在 harness 还提供 register 接缝时注册进
 * 设置文档，没有就落回那个 JSON 文件。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import z from '@deepseek-ai/schemastery'
import type { CredentialStore } from '../token-store.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
import { dshHomeDir } from '../common/home.ts'
import { hasRegister, resolveSettingsNamespace, type SettingsScope } from '../common/settings-compat.ts'
import {
  mergeContextWindowOverrides,
  type ContextWindowOverridePatch,
} from '../common/context-window-overrides.ts'
import type { StepCodeProfile, StepCodeReasoningEffort } from '../../shared/step-code-contracts.ts'
import {
  STEP_CODE_CACHE_REQUEST_PARAMS_DEFAULT,
  STEP_CODE_REASONING_EFFORTS,
  isStepCodeReasoningEffort,
} from '../../shared/step-code-contracts.ts'
import { DEFAULT_VISIBLE_MODEL_IDS, listModelIds } from './model-catalog.ts'
import { PROVIDER_ID, STATIC_EXPIRES_AT, normalizeProfile } from './types.ts'

/** 本线路在设置文档里注册的命名空间。 */
export const STEP_CODE_PREFERENCES_NAMESPACE = 'dsh-step-code'

// ---------------------------------------------------------------------------
// 凭据
// ---------------------------------------------------------------------------

/**
 * 这份凭据是从哪条路来的。
 *
 * - `browser`：云端轮询登录换到的 api_key。
 * - `manual`：用户手动粘贴的开放平台 API Key（按量计费）。
 * - `adopt`：从本机 stepcode 客户端读来的登录态快照。
 *
 * 它与 `profile` 是**两件事**：`profile` 决定打哪个端点，`origin` 决定这份东西
 * 本插件能不能对它做任何写操作。adopt 来的那份是别人登录态的拷贝，
 * 本插件对它连写都不写（上游那边才是权威）。
 */
export type StepCodeCredentialOrigin = 'browser' | 'manual' | 'adopt'

/** 本线路读 stepcode 登录态时的来源标记（与 `src/host/token-store.ts` 的 adopt 判别式同构）。 */
export const STEPCODE_CREDENTIAL_SOURCE = 'stepcode-client'

/**
 * 一份可服务请求的 Step 凭据。
 *
 * 真正发请求只用 `apiKey` 一个字段（Bearer）。其余字段分三类：
 *
 * - **非机密的账号事实**（`uid` / `accountName`）：卡片渲染与诊断用；
 * - **路由事实**（`profile`）：它唯一决定区域与两个 base，见 `./types.ts` 的 `PROFILE_HOSTS`；
 * - adopt 判别式（`adopted` / `source` / `sourcePath`）：见文件头。
 *
 * **刻意不落 `refreshToken` / `expiresAt`**：它们对静态凭据没有意义，而落两个永远为
 * 常量的字段只会诱使后来的代码写出「检查过期 → 刷新」这条在这条线路上永远走不通的分支。
 * 需要表达「永不过期」时读 `STATIC_EXPIRES_AT` 与 `STATIC_REFRESH_TOKEN` 常量。
 */
export interface StepCodeCredentials {
  /** 真正发请求用的 Key。Host-only，永不过这条边界。 */
  apiKey: string
  origin: StepCodeCredentialOrigin
  /** 凭据自述的 profile；**区域与端点都由它唯一决定**，不另存一份。 */
  profile: StepCodeProfile
  /** 上游可选的账号标识（已按长度与字符集过滤）；没有时为 null。 */
  uid: string | null
  /** 控制台侧的账号显示名（非机密）；没有时为 null。 */
  accountName: string | null
  /** 本插件接管这份凭据的时刻（Unix 毫秒）。 */
  authenticatedAt: number

  // --- adopt 判别式：另外两条路来的凭据没有这三个字段 ------------------------
  /**
   * 判别式，取字面量 `true`。一个布尔比一句注释更难被忽略，
   * 而这条判断一旦失效就是对本插件不拥有的登录态做一次写操作。
   */
  adopted?: true
  /** 恒为 {@link STEPCODE_CREDENTIAL_SOURCE}。 */
  source?: typeof STEPCODE_CREDENTIAL_SOURCE
  /** 读的是哪个文件，卡片照它显示。 */
  sourcePath?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Step Code 凭据字段无效：' + key)
  return value
}

function isOrigin(value: unknown): value is StepCodeCredentialOrigin {
  return value === 'browser' || value === 'manual' || value === 'adopt'
}

/**
 * 校验并归一化一份落盘的凭据。
 *
 * 缺的字段一律拒绝而不是补默认值：缺 `apiKey` 的凭据发出去一定是一次 401，
 * 而「给它编一个 profile」只会把请求静默打到另一个区域的端点上——
 * 那是一次跨区请求，不是一次本地失败。
 *
 * `profile` 认不出来时**拒绝**而不是回落到默认 profile：默认 profile 是给
 * 「凭据没自述区域」的猜测准备的（`DEFAULT_PROFILE`），而落盘的凭据总该自述；
 * 猜错的代价是一次拿国区凭据去打国际区端点的明确鉴权失败，排查成本远高于让它重新登录。
 */
export function parseStepCodeCredentials(value: unknown): StepCodeCredentials {
  if (!isRecord(value)) throw new Error('Step Code 凭据载荷无效')
  const apiKey = asString(value.apiKey)
  if (apiKey === undefined) throw new Error('Step Code 凭据缺少 apiKey')
  const profile = normalizeProfile(value.profile)
  if (profile === undefined) throw new Error('Step Code 凭据的 profile 无效')

  const origin = isOrigin(value.origin)
    ? value.origin
    : isAdoptedSnapshot(value) ? 'adopt' : 'browser'
  const credentials: StepCodeCredentials = {
    apiKey,
    origin,
    profile,
    uid: optionalString(value, 'uid') ?? null,
    accountName: optionalString(value, 'accountName') ?? null,
    authenticatedAt: asFiniteNumber(value.authenticatedAt) ?? 0,
  }
  if (origin === 'adopt') {
    credentials.adopted = true
    credentials.source = STEPCODE_CREDENTIAL_SOURCE
    const sourcePath = optionalString(value, 'sourcePath')
    if (sourcePath !== undefined) credentials.sourcePath = sourcePath
  }
  return credentials
}

/** 一份值是否带着 adopt 判别式（本地判读，供落盘解析用）。 */
function isAdoptedSnapshot(value: Record<string, unknown>): boolean {
  return value.adopted === true && value.source === STEPCODE_CREDENTIAL_SOURCE
}

/**
 * 一份凭据是不是 adopt 快照（号池与适配器据此拒绝对它做任何写操作）。
 *
 * 它读的是**凭据对象本身**而不是某个内存标记：号池文件会被重新读、会被别处改写，
 * 一个只活在内存里的判断会在重启后消失，于是 adopt 凭据被当成插件自有的写一次——
 * 那是一次对别人的登录态的越权操作。
 */
export function isAdoptedStepCodeCredential(credentials: StepCodeCredentials): boolean {
  return isAdoptedSnapshot(credentials as unknown as Record<string, unknown>)
}

/**
 * 凭据的失效时刻：恒为 `STATIC_EXPIRES_AT`。
 *
 * 它存在的意义是**让号池有一个可以调用的钩子**（`AccountPoolHooks.expiresAt`），
 * 而不是让号池去猜。返回 MAX_SAFE_INTEGER 是诚实的：这条线路的凭据本地永不到期，
 * 上游撤销它表现为一次鉴权失败，由号池的 `markAuthFailed` 路径处理。
 */
export function stepCodeCredentialsExpireAt(_credentials: StepCodeCredentials): number {
  return STATIC_EXPIRES_AT
}

/**
 * 这份凭据需不需要刷新：**永远为 false**。
 *
 * 它存在的意义与上面那个一样：号池的 `needsRefresh` 钩子是可选的，
 * 本线路提供它并如实回答「不需要」，是为了让「不刷新」成为**一个被断言的事实**
 * 而不是「没实现那个钩子」。真接上刷新钩子的后果是：一次必然失败的刷新
 * （上游没有刷新端点，`refreshStepOAuth` 直接抛错）会把一个能用的账号标成 expired。
 */
export function stepCodeCredentialsNeedRefresh(
  _credentials: StepCodeCredentials,
  _now: number,
): boolean {
  return false
}

/** 浏览器登录换到的凭据 → 落盘形态。 */
export function credentialsFromLogin(input: {
  apiKey: string
  profile: StepCodeProfile
  uid?: string | null
  accountName?: string | null
}): StepCodeCredentials {
  return {
    apiKey: input.apiKey,
    origin: 'browser',
    profile: input.profile,
    uid: input.uid ?? null,
    accountName: input.accountName ?? null,
    authenticatedAt: Date.now(),
  }
}

/** 手动粘贴的开放平台 Key → 落盘形态。 */
export function credentialsFromApiKey(input: {
  apiKey: string
  profile: StepCodeProfile
}): StepCodeCredentials {
  return {
    apiKey: input.apiKey,
    origin: 'manual',
    profile: input.profile,
    uid: null,
    accountName: null,
    authenticatedAt: Date.now(),
  }
}

/**
 * adopt 快照 → 落盘形态。
 *
 * 判别式与 `sourcePath` 一并写入，让 `isAdoptedStepCodeCredential()`
 * 在**任何一次读回**之后仍然给出同一个答案——这是「永不做写操作」能跨重启成立的全部原因。
 */
export function credentialsFromAdopt(input: {
  apiKey: string
  profile: StepCodeProfile
  uid?: string | null
  sourcePath: string
}): StepCodeCredentials {
  return {
    apiKey: input.apiKey,
    origin: 'adopt',
    profile: input.profile,
    uid: input.uid ?? null,
    accountName: null,
    authenticatedAt: Date.now(),
    adopted: true,
    source: STEPCODE_CREDENTIAL_SOURCE,
    sourcePath: input.sourcePath,
  }
}

/** 凭据文件路径（本线路自己拥有；号池把主账号镜像到这里）。 */
export function credentialPath(): string {
  return path.join(dshHomeDir(), 'storages', 'step-code-credentials.json')
}

/** 模型设置文件路径。 */
export function modelSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'step-code-models.json')
}

/**
 * 额度凭据文件路径（**与线路凭据分开的一份**）。
 *
 * 分开是因为两者性质不同：线路凭据是「一把长期 Key」，额度凭据是
 * 「一次账号密码会话换来的 Oasis-Token」，后者会过期、会需要重登。
 * 合成一份会让「删掉额度登录」变成「登出整条线路」，而这两件事在用户看来完全无关。
 *
 * 它的内容**只存在于 host**：共享契约里的 `StepCodeQuotaCredentialStatusDto`
 * 只下发「有没有、从哪来、什么时候过期、上次读它出了什么问题」。
 */
export function quotaCredentialPath(): string {
  return path.join(dshHomeDir(), 'storages', 'step-code-quota-credential.json')
}

function credentialAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}

function createCredentialBackend<T>(
  filePath: string,
  parse: (value: unknown) => T,
  label: string,
): CredentialStore<T> {
  if (process.platform === 'win32') {
    return new WindowsDpapiCredentialStore(filePath + '.dpapi', parse)
  }
  if (process.platform === 'darwin') {
    return new MacKeychainCredentialStore(PROVIDER_ID, credentialAccount(filePath), parse)
  }
  if (process.platform === 'linux') {
    return new SecretServiceCredentialStore(PROVIDER_ID, credentialAccount(filePath), parse)
  }
  throw new Error(label + ' 凭据存储只支持 Windows、macOS 或 Linux。')
}

// 登录、配额读与适配器流共享同一条落盘顺序。
const credentialOperations = new Map<string, Promise<void>>()

function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(key)
  const result = (credentialOperations.get(resolved) || Promise.resolve()).then(operation)
  const settled = result.then(() => undefined, () => undefined)
  credentialOperations.set(resolved, settled)
  void settled.then(() => {
    if (credentialOperations.get(resolved) === settled) credentialOperations.delete(resolved)
  })
  return result
}

/**
 * 加密凭据存储。
 *
 * 与兄弟线路同构：写入之后回读比对，避免「写成功了但下一次启动读到的是别的东西」；
 * 按路径排队，避免两个同时落地的写互相丢掉。
 *
 * **没有明文迁移分支**——这是本线路与 glm / kimi 的唯一结构差异，而且是刻意的：
 * 那两条线路的历史上真的存在过明文凭据文件要迁移，本线路从未发布过，
 * 一个「读明文再删掉它」的分支在这里只会是一段永不执行的死代码，
 * 以及一个将来可能被人加上去的、写 stepcode 文件的机会。
 */
export class StepCodeCredentialStore {
  // 显式声明而不是构造函数参数属性：Node 的类型擦除加载器不接受参数属性，
  // 而这个包是被直接以 TypeScript 形式导入的。
  private readonly filePath: string
  private readonly backend: CredentialStore<StepCodeCredentials>

  constructor(filePath: string = credentialPath(), backend?: CredentialStore<StepCodeCredentials>) {
    this.filePath = filePath
    this.backend = backend
      ?? createCredentialBackend(filePath, parseStepCodeCredentials, 'Step Code')
  }

  /** 人可读的存储位置说明（Windows DPAPI / macOS Keychain / Linux Secret Service）。 */
  path(): string {
    if (process.platform === 'win32') return this.filePath + '.dpapi'
    const kind = process.platform === 'darwin' ? 'Keychain' : 'Secret Service'
    return kind + ': ' + PROVIDER_ID + '/' + credentialAccount(this.filePath)
  }

  read(): Promise<StepCodeCredentials | null> {
    return serialize(this.filePath, () => this.backend.load())
  }

  write(credentials: StepCodeCredentials): Promise<void> {
    return serialize(this.filePath, async () => {
      const normalized = parseStepCodeCredentials(credentials)
      await this.backend.save(normalized)
      const restored = await this.backend.load()
      if (!isDeepStrictEqual(restored, normalized)) {
        throw new Error('Step Code 加密凭据写入校验失败')
      }
    })
  }

  delete(): Promise<void> {
    return serialize(this.filePath, () => this.backend.clear())
  }
}

// ---------------------------------------------------------------------------
// 额度凭据（只存在于 host）
// ---------------------------------------------------------------------------

/**
 * 开发者中心的额度凭据。
 *
 * 它等价于一次账号密码会话：`Oasis-Token` 是登录态，`deviceId` 必须与该 token 的
 * `device_id` claim 一致（计划 `5、`10 风险 5），少一个都不行。
 *
 * `source` 如实记录它是怎么来的——自动登录失败时的手动粘贴兜底是这条线路的
 * 正路之一（不是降级的临时措施），所以两种来源在卡片上是并列的。
 *
 * **绝不进入任何共享契约**：契约里只有它的状态 DTO。
 */
export interface StepCodeQuotaCredential {
  /** `Oasis-Token`。Host-only。 */
  token: string
  /** `Oasis-Webid`：必须与 token 的 `device_id` claim 一致。 */
  deviceId: string
  /** 登录用到的账号（非机密，用于卡片显示是哪一路凭据在服务）。 */
  account: string | null
  source: 'auto' | 'manual'
  /** 过期时刻（Unix 毫秒）；上游未给出时为 null。 */
  expiresAt: number | null
}

/** 校验并归一化一份落盘的额度凭据。缺 token 或 deviceId 一律拒绝——少一个就是一次必然的鉴权失败。 */
export function parseStepCodeQuotaCredential(value: unknown): StepCodeQuotaCredential {
  if (!isRecord(value)) throw new Error('Step Code 额度凭据载荷无效')
  const token = asString(value.token)
  if (token === undefined) throw new Error('Step Code 额度凭据缺少 Oasis-Token')
  const deviceId = asString(value.deviceId)
  if (deviceId === undefined) throw new Error('Step Code 额度凭据缺少 Oasis-Webid')
  return {
    token,
    deviceId,
    account: optionalString(value, 'account') ?? null,
    source: value.source === 'auto' ? 'auto' : 'manual',
    expiresAt: asFiniteNumber(value.expiresAt) ?? null,
  }
}

/**
 * 额度凭据的加密存储。
 *
 * 与线路凭据**分开存**（路径见 {@link quotaCredentialPath} 的理由），
 * 但用的是同一个平台矩阵：DPAPI / Keychain / Secret Service。
 */
export class StepCodeQuotaCredentialStore {
  private readonly filePath: string
  private readonly backend: CredentialStore<StepCodeQuotaCredential>

  constructor(filePath: string = quotaCredentialPath()) {
    this.filePath = filePath
    this.backend = createCredentialBackend(filePath, parseStepCodeQuotaCredential, 'Step Code 额度')
  }

  path(): string {
    if (process.platform === 'win32') return this.filePath + '.dpapi'
    const kind = process.platform === 'darwin' ? 'Keychain' : 'Secret Service'
    return kind + ': ' + PROVIDER_ID + '/quota/' + credentialAccount(this.filePath)
  }

  read(): Promise<StepCodeQuotaCredential | null> {
    return serialize(this.filePath, () => this.backend.load())
  }

  write(credential: StepCodeQuotaCredential): Promise<void> {
    return serialize(this.filePath, async () => {
      const normalized = parseStepCodeQuotaCredential(credential)
      await this.backend.save(normalized)
      const restored = await this.backend.load()
      if (!isDeepStrictEqual(restored, normalized)) {
        throw new Error('Step Code 额度凭据写入校验失败')
      }
    })
  }

  delete(): Promise<void> {
    return serialize(this.filePath, () => this.backend.clear())
  }
}

// ---------------------------------------------------------------------------
// 模型设置与偏好
// ---------------------------------------------------------------------------

/**
 * 本线路设置文档里**用户自己**的那一半。
 *
 * 随包目录 `STEP_CODE_MODEL_CATALOG` 刻意不存：它跟着代码走，存一份副本会让一个
 * 落后一个版本的设置文件读到这份构建已经不再服务的模型列表。
 */
export interface StepCodeModelSettings {
  /** 线路总开关。只有显式 false 才是关闭。 */
  enabled?: boolean
  /**
   * 用户勾选的模型 id；缺省或空数组 = **不过滤（全选）**，非空 = 显式选择。
   *
   * 为什么不是三态（`null` = 不过滤）：冻结契约里的
   * `StepCodeSettingsUpdateDto.enabledModelIds` 是 `string[]`，没有 null 这一格；
   * 而本线路的目录**登录后才运行时发现**，一个刚装上还没登录的用户手里必然只有一个
   * 空数组。把空数组读成「一个都不启用」会让设置页在用户还没登录时就显示成
   * 「已禁用全部模型」——那是关于目录的谎报，目录这时根本还不存在。
   * 真要把模型全关，关线路总开关（`enabled`）是明确且语义正确的那一个动作。
   *
   * 字段**可选**是同一件事的另一半：它必须能区分「用户没选过」与「用户选了空集」。
   * 装配侧（`catalogModelOptions`）与本文件的合并逻辑都以这条注释为准。
   */
  enabledModelIds?: string[]
  /** 逐模型上下文窗口覆盖；缺省用目录声明值。 */
  contextWindowOverrides: Record<string, number>
  /** 会话没指定档位时用的档位；null 表示各模型用自己的默认。 */
  defaultReasoningEffort: StepCodeReasoningEffort | null
  /** 手动指定下一个请求使用的账号；null 交回号池调度。 */
  selectedAccountId: string | null
  /** 请求侧是否发送缓存参数（默认 false，见共享契约的缓存一节）。 */
  cacheRequestParams: boolean
}

/** 一个设置补丁。 */
export interface StepCodeSettingsPatch {
  enabled?: boolean
  enabledModelIds?: string[]
  /**
   * 补丁而不是整张表：`null` 必须能作为一个**值**活下来，
   * 它是卡片上的「恢复目录默认」，删掉恰好一个键。
   */
  contextWindowOverrides?: ContextWindowOverridePatch
  defaultReasoningEffort?: StepCodeReasoningEffort | null
  selectedAccountId?: string | null
  cacheRequestParams?: boolean
}

/**
 * 路由与适配器共用的接缝。
 *
 * `status()` 同步：它在模型选择器查询与卡片轮询上被调用，两者都只需要一份快照；
 * 把它做成 promise 会让每一条热路径都去等一次磁盘读，而它的变化速度是人的速度。
 */
export interface StepCodePreferenceStore {
  /**
   * 文件后端是异步预热的，所以 `status()` 在那次读落定之前先回答出厂默认值。
   * 启动时按偏好行动的一方必须先 await 它，否则它行动在默认值而不是用户的选择上。
   */
  ready(): Promise<void>
  status(): StepCodeModelSettings
  update(patch: StepCodeSettingsPatch): Promise<StepCodeModelSettings>
}

const DEFAULT_ENABLED_MODEL_IDS: string[] = [...DEFAULT_VISIBLE_MODEL_IDS]

/** 一次全新安装的设置：全开、无过滤、无覆盖、无指定账号、缓存参数不发。 */
export function defaultStepCodeModelSettings(): StepCodeModelSettings {
  return {
    enabled: true,
    // 出厂值取自**随包**目录（此刻是空数组），因此等价于「不过滤」。
    // 它不取自运行时目录：那会让「用户没选过」与「用户选了运行时目录里的某个 id」
    // 这两件事互相污染（同 glm 线路把随包目录排除在设置文档之外的同一条理由）。
    enabledModelIds: [...DEFAULT_ENABLED_MODEL_IDS],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    selectedAccountId: null,
    cacheRequestParams: STEP_CODE_CACHE_REQUEST_PARAMS_DEFAULT,
  }
}

/**
 * 归一化一份解析出来的设置文档。
 *
 * 这里什么都不抛：它在启动和每次状态轮询上被读，手改过或降级过的文档必须降级成一份
 * 可用的选择，而不是让整条线路不可用。
 */
export function parseStepCodeModelSettings(value: unknown): StepCodeModelSettings {
  if (!isRecord(value)) return defaultStepCodeModelSettings()
  const enabledModelIds = Array.isArray(value.enabledModelIds)
    ? value.enabledModelIds.filter((id): id is string => typeof id === 'string')
    : [...DEFAULT_ENABLED_MODEL_IDS]
  const contextWindowOverrides: Record<string, number> = {}
  if (isRecord(value.contextWindowOverrides)) {
    for (const [modelId, raw] of Object.entries(value.contextWindowOverrides)) {
      // 非正数或非有限值被丢弃而不是夹到某个下限：它会让该模型上的每一次请求都按
      // 一个目录从未声明过的窗口来规划，而路由层本来就拒绝这种值——走到这里只可能是
      // 文件被手改过，回落目录默认才是诚实的修复。
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        contextWindowOverrides[modelId] = Math.floor(raw)
      }
    }
  }
  return {
    // 只有显式 false 才是关闭：键缺失是出厂状态，把它读成「关」会让一个从没碰过开关的
    // 用户看不到任何模型。
    enabled: value.enabled !== false,
    enabledModelIds,
    contextWindowOverrides,
    defaultReasoningEffort: isStepCodeReasoningEffort(value.defaultReasoningEffort)
      ? value.defaultReasoningEffort
      : null,
    selectedAccountId: asString(value.selectedAccountId) ?? null,
    // 同理：只有显式 true 才发缓存参数。
    cacheRequestParams: value.cacheRequestParams === true,
  }
}

/**
 * 把一个补丁应用到一份设置文档上。
 *
 * 合并逻辑住在两个 store 之外：register 后端必须用与文件后端**同一套**规则归一化 scope 的值，
 * 同一份逻辑写两遍就是两条存储路径第一次学到新字段时开始漂移的方式。
 */
export function mergeStepCodeSettings(
  current: StepCodeModelSettings,
  patch: StepCodeSettingsPatch,
): StepCodeModelSettings {
  return {
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled !== false,
    // 空数组是一个**真实值**（= 不过滤），不是「这个补丁没带这个字段」。
    enabledModelIds: patch.enabledModelIds !== undefined
      ? patch.enabledModelIds
      : current.enabledModelIds,
    contextWindowOverrides: patch.contextWindowOverrides !== undefined
      ? mergeContextWindowOverrides(current.contextWindowOverrides, patch.contextWindowOverrides)
      : current.contextWindowOverrides,
    defaultReasoningEffort: patch.defaultReasoningEffort !== undefined
      ? patch.defaultReasoningEffort
      : current.defaultReasoningEffort,
    selectedAccountId: patch.selectedAccountId !== undefined
      ? patch.selectedAccountId
      : current.selectedAccountId ?? null,
    cacheRequestParams: patch.cacheRequestParams !== undefined
      ? patch.cacheRequestParams
      : current.cacheRequestParams === true,
  }
}

/**
 * 凭据旁边的设置文件。
 *
 * 没有 register 接缝的 harness（0.1.7，以及无头 host）启动时读的就是它，所以它必须扛得住崩溃：
 * 写入走「临时文件 + rename」，写完立刻回读比对再报告成功。
 */
export class StepCodeModelSettingsStore {
  private readonly filePath: string

  constructor(filePath: string = modelSettingsPath()) {
    this.filePath = filePath
  }

  path(): string {
    return this.filePath
  }

  async read(): Promise<StepCodeModelSettings> {
    try {
      return parseStepCodeModelSettings(
        JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown,
      )
    } catch {
      // 读不到或读坏了就回落出厂默认。
      return defaultStepCodeModelSettings()
    }
  }

  async write(settings: StepCodeModelSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = this.filePath + '.tmp.' + Date.now()
    await fs.writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', 'utf8')
    await fs.rename(temporary, this.filePath)
    const restored = parseStepCodeModelSettings(
      JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown,
    )
    if (!isDeepStrictEqual(restored, settings)) {
      throw new Error('Step Code 模型设置写入失败：落盘的选择与刚写入的不一致')
    }
  }

  /**
   * 在与凭据写入同一条按路径排队的锁里做「读-改-写」。
   *
   * 没有它，两个同时落地的补丁各读同一份文档，后一个写会把前一个悄悄丢掉——
   * 一次没有任何报错的模型选择丢失。
   */
  updateSettings(patch: StepCodeSettingsPatch): Promise<StepCodeModelSettings> {
    return serialize(this.filePath, async () => {
      const next = mergeStepCodeSettings(await this.read(), patch)
      await this.write(next)
      return next
    })
  }
}

/**
 * 把模型选择绑到 DSH 设置文档（harness 还提供 register 接缝时），
 * 否则绑到凭据旁边的 JSON 文件。
 *
 * ⚠ **scope 形状里的 `enabledModelIds` 是 optional，而 schemastery 会把
 * 缺省的 `z.array(z.string())` 归一化成 `[]`**（实测：空对象经过一个
 * 只有 `z.array(z.string())` 的 object 会得到 `{ ids: [] }`）。
 * 所以这里**不给它写 `.default()`**，缺省就让它读成空数组——
 * 而空数组在本线路的语义里正好就是「不过滤」（见 {@link StepCodeModelSettings}）。
 * 外面那个类型断言是必需的：schemastery 的输出类型会把这个键声明成必填，
 * 而运行时它是可缺省的，不断言就是一处类型层面的谎报。
 */
export function registerStepCodePreferenceStore(
  settings?: unknown,
  fallbackStore: StepCodeModelSettingsStore = new StepCodeModelSettingsStore(),
): StepCodePreferenceStore {
  if (!hasRegister(settings)) {
    // 没有设置命名空间可写时，凭据旁边的 JSON 文件就是 store。它在这里被读一次，
    // 于是上一次运行保存的选择在这一次启动后仍然有效；这次读不被 await，
    // 免得在启动时装配插件的一方被一次磁盘读挡住，`status()` 在它落定前先回答默认值。
    let snapshot: StepCodeModelSettings = defaultStepCodeModelSettings()
    const warmed = fallbackStore.read().then((stored) => { snapshot = stored }).catch(() => undefined)
    return {
      ready: () => warmed,
      status: () => snapshot,
      update: async (patch) => {
        snapshot = await fallbackStore.updateSettings(patch)
        return snapshot
      },
    }
  }

  const scope = settings.register(resolveSettingsNamespace(STEP_CODE_PREFERENCES_NAMESPACE), z.object({
    enabled: z.boolean().default(true),
    // 刻意不给 .default()：见本函数上方那段注释（缺省归一化成 []，而 [] 与「不过滤」同义）。
    enabledModelIds: z.array(z.string()),
    contextWindowOverrides: z.dict(z.number()).default({}),
    defaultReasoningEffort: z
      .union([
        ...STEP_CODE_REASONING_EFFORTS.map((effort) => z.const(effort)),
        z.const(null),
      ])
      .default(null),
    selectedAccountId: z.union([z.string(), z.const(null)]).default(null),
    cacheRequestParams: z.boolean().default(STEP_CODE_CACHE_REQUEST_PARAMS_DEFAULT),
  })) as SettingsScope<{
    enabled?: boolean
    enabledModelIds?: string[]
    contextWindowOverrides: Record<string, number>
    defaultReasoningEffort: StepCodeReasoningEffort | null
    selectedAccountId: string | null
    cacheRequestParams?: boolean
  }>

  const currentValue = (): StepCodeModelSettings => {
    const value = scope.get()
    const settings: StepCodeModelSettings = {
      // 只有显式 false 才是关闭。
      enabled: value.enabled !== false,
      contextWindowOverrides: value.contextWindowOverrides,
      defaultReasoningEffort: isStepCodeReasoningEffort(value.defaultReasoningEffort)
        ? value.defaultReasoningEffort
        : null,
      selectedAccountId: value.selectedAccountId ?? null,
      cacheRequestParams: value.cacheRequestParams === true,
    }
    // 空数组与缺省同义（不过滤），所以这里不制造一次「用户选了空集」的假象。
    if (Array.isArray(value.enabledModelIds) && value.enabledModelIds.length > 0) {
      settings.enabledModelIds = value.enabledModelIds
    }
    return settings
  }

  return {
    // register 后端是同步读的，没有要等的；这个接缝存在是为了调用方不必知道自己拿的是哪一个。
    ready: async () => undefined,
    status: currentValue,
    update: async (patch) => {
      // 只读一次：两次读一个活的 scope 可能跨过另一个订阅者的写入，
      // 拿第二读去合并、第一读去落盘，正是这个 store 要避免的丢失更新。
      const normalized = mergeStepCodeSettings(currentValue(), patch)
      await scope.update({
        enabled: normalized.enabled !== false,
        enabledModelIds: normalized.enabledModelIds ?? [],
        contextWindowOverrides: normalized.contextWindowOverrides,
        defaultReasoningEffort: normalized.defaultReasoningEffort,
        selectedAccountId: normalized.selectedAccountId,
        cacheRequestParams: normalized.cacheRequestParams === true,
      })
      // 同时镜像进文件，这样下一次跑在没有 register 接缝的 harness 上时用户的选择还在。
      // 镜像是尽力而为的：刚刚成功落盘的是注册文档。
      void fallbackStore.updateSettings(patch).catch(() => undefined)
      return normalized
    },
  }
}

export { listModelIds }
