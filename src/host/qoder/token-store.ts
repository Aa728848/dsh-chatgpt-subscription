/**
 * Qoder（订阅）线路的凭据 / 模型设置 / 偏好三件套。
 *
 * 本线路的凭据与 step-code 相反的那个性质先说清楚，因为它决定了本文件的设计：
 *
 * **凭据会过期、可刷新。** Qoder 的 job/device token 带着 `expires_at` / `expires_in`
 * （pi-provider `pat.ts` / `login.ts`；qodercli2api `docs/oauth.md` §3）。所以：
 *
 * - 本文件**有** refresh 相关的一切（过期时刻、提前刷新量、刷新输入的留存）；
 * - PAT 来源的凭据**留住 PAT 本体**（host-only，绝不进共享契约），因为 PAT 的
 *   「刷新」就是拿它重新兑换一把 job token（pi-provider `oauth.ts` 的
 *   `isPatRefresh` 路径同一做法）；
 * - 号池的 `expiresAt`/`needsRefresh`/`refresh` 钩子都是活的，
 *   刷新失败按 401/403 → expired、其余 → 瞬时 分类（account-pool.ts）。
 *
 * 第二件必须记住的事：**本线路自己拥有它的凭据副本，但从不拥有 qodercli 的文件**。
 * adopt 只是把 `~/.qoder/.auth/user` 读成一份快照存进本插件自己的凭据存储
 * （`adopt.ts` 只读、不写、不删）。落盘的 adopt 凭据带 `adopted / source / sourcePath`
 * 三个判别式字段，与其它线路的 adopt 语义一致。
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
import type { QoderReasoningEffort, QoderRegion } from '../../shared/qoder-contracts.ts'
import {
  QODER_REASONING_EFFORTS,
  isQoderReasoningEffort,
  isQoderRegion,
} from '../../shared/qoder-contracts.ts'
import { DEFAULT_VISIBLE_MODEL_IDS, listModelIds } from './model-catalog.ts'
import {
  PROVIDER_ID,
  QODER_DEFAULT_TOKEN_TTL_MS,
  QODER_EXPIRY_SAFETY_MS,
  QODER_REFRESH_AHEAD_MS,
} from './types.ts'

/** 本线路在设置文档里注册的命名空间。 */
export const QODER_PREFERENCES_NAMESPACE = 'dsh-qoder'

// ---------------------------------------------------------------------------
// 凭据
// ---------------------------------------------------------------------------

/**
 * 这份凭据是从哪条路来的。
 *
 * - `device`：浏览器设备流（仅全球区）。
 * - `pat`：用户手动粘贴的 Personal Access Token 兑换来的 job token。
 * - `adopt`：从本机 qodercli 客户端读来的登录态快照。
 *
 * 它与 `region` 是**两件事**：`region` 决定打哪套端点，`origin` 决定这份东西
 * 怎么刷新（PAT 重兑换 vs refresh_token）以及本插件能不能对它做任何写操作。
 */
export type QoderCredentialOrigin = 'device' | 'pat' | 'adopt'

/** 本线路读 qodercli 登录态时的来源标记（与兄弟线路的 adopt 判别式同构）。 */
export const QODER_CLI_CREDENTIAL_SOURCE = 'qoder-cli'

/**
 * 一份可服务请求的 Qoder 凭据。
 *
 * 真正发请求只用 `accessToken`（Bearer + COSY 载荷里的 `security_oauth_token`）。
 * 其余字段分四类：
 *
 * - **刷新输入**（`refreshToken` / `expiresAt` / `personalToken`）：过期后续命的原料；
 * - **非机密的账号事实**（`uid` / `email` / `accountName`）：COSY 载荷与卡片渲染用；
 * - **路由事实**（`region`）：它唯一决定端点表，见 `./types.ts` 的 `REGION_HOSTS`；
 * - **COSY 头的条件字段**（`organizationId` / `organizationTags` / `dataPolicyAgreed`）：
 *   非空才出现在请求头里（inference-protocol.md §2 的 presence 矩阵）；
 * - adopt 判别式（`adopted` / `source` / `sourcePath`）：见文件头。
 */
export interface QoderCredentials {
  /** 真正发请求用的 job/device token。Host-only，永不过共享边界。 */
  accessToken: string
  /** 刷新令牌（`jrt-...` 或设备流的 refresh_token）；没有时为 null。 */
  refreshToken: string | null
  /** 过期时刻（Unix 毫秒，已含安全边）；上游没给时按兑换时刻 + 24h 兜底。 */
  expiresAt: number
  /** 凭据自述的区域；**端点由它唯一决定**，不另存一份。 */
  region: QoderRegion
  origin: QoderCredentialOrigin
  /** 上游账号 id（COSY 的 `Cosy-User`）；缺它 CN 会报「Login expired」（105）。 */
  uid: string | null
  /** 账号邮箱（COSY UserInfo 的 `email`，非机密）；没有时为 null。 */
  email: string | null
  /** 账号显示名（COSY UserInfo 的 `name`）；没有时为 null。 */
  accountName: string | null
  /**
   * PAT 来源的凭据留住的 PAT 本体（`pt-...`）。
   *
   * **Host-only，永远不过共享契约的边界**：它的唯一用途是过期后重新兑换一把
   * job token（pi-provider 把 PAT 编进 refresh 字段，同一件事）。非 PAT 来源为 null。
   */
  personalToken: string | null
  /** 组织 id（`Cosy-Organization-Id` 的条件字段）；个人账号为 null。 */
  organizationId: string | null
  /** 组织 tags（`Cosy-Organization-Tags` 的条件字段，逗号连接前的那份数组）。 */
  organizationTags: string[]
  /** `Cosy-Data-Policy` 的取值开关：true → `agree`，否则 `disagree`（fixture 的默认）。 */
  dataPolicyAgreed: boolean
  /** 本插件接管这份凭据的时刻（Unix 毫秒）。 */
  authenticatedAt: number

  // --- adopt 判别式：另外两条路来的凭据没有这三个字段 ------------------------
  /** 判别式，取字面量 `true`（与兄弟线路同：一个布尔比一句注释更难被忽略）。 */
  adopted?: true
  /** 恒为 {@link QODER_CLI_CREDENTIAL_SOURCE}。 */
  source?: typeof QODER_CLI_CREDENTIAL_SOURCE
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
  if (typeof value !== 'string') throw new Error('Qoder 凭据字段无效：' + key)
  return value
}

function isOrigin(value: unknown): value is QoderCredentialOrigin {
  return value === 'device' || value === 'pat' || value === 'adopt'
}

/**
 * 校验并归一化一份落盘的凭据。
 *
 * 缺的字段一律拒绝而不是补默认值：缺 `accessToken` 的凭据发出去一定是一次 401；
 * 缺 `uid` 的凭据在 CN 会被报「Login expired」（105）——但它不拒绝：全球区对这个字段
 * 更宽容，而号池装配侧会在发卡前尽力补齐（oauth.ts 的 userinfo 步骤）。
 *
 * `region` 认不出来时**拒绝**而不是回落默认：落盘的凭据总该自述；猜错的代价是
 * 拿一区的凭据去打另一区的端点，一次明确的鉴权失败，排查成本远高于重新登录。
 */
export function parseQoderCredentials(value: unknown): QoderCredentials {
  if (!isRecord(value)) throw new Error('Qoder 凭据载荷无效')
  const accessToken = asString(value.accessToken)
  if (accessToken === undefined) throw new Error('Qoder 凭据缺少 accessToken')
  if (!isQoderRegion(value.region)) throw new Error('Qoder 凭据的 region 无效')
  const origin = isOrigin(value.origin)
    ? value.origin
    : isAdoptedSnapshot(value) ? 'adopt' : 'device'
  const credentials: QoderCredentials = {
    accessToken,
    refreshToken: optionalString(value, 'refreshToken') ?? null,
    expiresAt: asFiniteNumber(value.expiresAt) ?? 0,
    region: value.region,
    origin,
    uid: optionalString(value, 'uid') ?? null,
    email: optionalString(value, 'email') ?? null,
    accountName: optionalString(value, 'accountName') ?? null,
    personalToken: optionalString(value, 'personalToken') ?? null,
    organizationId: optionalString(value, 'organizationId') ?? null,
    organizationTags: Array.isArray(value.organizationTags)
      ? value.organizationTags.filter((tag): tag is string => typeof tag === 'string' && tag !== '')
      : [],
    dataPolicyAgreed: value.dataPolicyAgreed === true,
    authenticatedAt: asFiniteNumber(value.authenticatedAt) ?? 0,
  }
  if (origin === 'adopt') {
    credentials.adopted = true
    credentials.source = QODER_CLI_CREDENTIAL_SOURCE
    const sourcePath = optionalString(value, 'sourcePath')
    if (sourcePath !== undefined) credentials.sourcePath = sourcePath
  }
  return credentials
}

/** 一份值是否带着 adopt 判别式（本地判读，供落盘解析用）。 */
function isAdoptedSnapshot(value: Record<string, unknown>): boolean {
  return value.adopted === true && value.source === QODER_CLI_CREDENTIAL_SOURCE
}

/**
 * 一份凭据是不是 adopt 快照（号池与适配器据此知道它的上游权威是 qodercli 的文件）。
 *
 * 它读的是**凭据对象本身**而不是某个内存标记（同 step-code 的同名函数的理由）。
 */
export function isAdoptedQoderCredential(credentials: QoderCredentials): boolean {
  return isAdoptedSnapshot(credentials as unknown as Record<string, unknown>)
}

/**
 * 凭据的失效时刻：自述的 `expiresAt`；缺 0 时按「接管时刻 + 24h」补一份诚实的兜底
 * （pi-provider 的缺省寿命），让号池的刷新钩子有东西可判。
 */
export function qoderCredentialsExpireAt(credentials: QoderCredentials): number {
  if (credentials.expiresAt > 0) return credentials.expiresAt
  return (credentials.authenticatedAt > 0 ? credentials.authenticatedAt : Date.now()) + QODER_DEFAULT_TOKEN_TTL_MS
}

/**
 * 这份凭据需不需要刷新：`expiresAt - 3600_000 < now` 时刷新
 * （逐字 qodercli2api `docs/oauth.md` §3 的提前 1 小时）。
 */
export function qoderCredentialsNeedRefresh(credentials: QoderCredentials, now: number): boolean {
  return qoderCredentialsExpireAt(credentials) - QODER_REFRESH_AHEAD_MS < now
}

/**
 * 兑换/刷新响应里的过期时刻 → Unix 毫秒（已含 5 分钟安全边）。
 *
 * 三种形态都收（计划 §9 风险 6）：
 *
 * - `expiresAt`：ISO 字符串或 Unix 秒/毫秒——用**量级**分辨（10^10 秒是 2286 年，
 *   更大的数一定已经是毫秒）；
 * - `expiresIn`：相对时长。pi-provider 注释说观测到的是**毫秒**，qodercli2api 按秒读；
 *   同一量级判据两处都兼容（小于 10^7 的值按秒才合理：10^7 秒约 4 个月，
 *   而一把 job token 的寿命以小时/天计）。
 */
export function qoderExpiresAtFrom(expiresAt: unknown, expiresIn: unknown, now: number = Date.now()): number {
  const numeric = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
  const absolute = numeric(expiresAt)
  if (absolute !== undefined) {
    const ms = absolute > 1e12 ? absolute : absolute * 1000
    return ms - QODER_EXPIRY_SAFETY_MS
  }
  if (typeof expiresAt === 'string' && expiresAt.trim() !== '') {
    const parsed = Date.parse(expiresAt)
    if (Number.isFinite(parsed)) return parsed - QODER_EXPIRY_SAFETY_MS
    const asNumber = Number(expiresAt)
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return (asNumber > 1e12 ? asNumber : asNumber * 1000) - QODER_EXPIRY_SAFETY_MS
    }
  }
  const relative = numeric(expiresIn)
  if (relative !== undefined) {
    // expires_in 的单位两份来源不一致：量级判别（< 10^7 视为秒，否则视为毫秒）。
    return now + (relative < 1e7 ? relative * 1000 : relative) - QODER_EXPIRY_SAFETY_MS
  }
  return now + QODER_DEFAULT_TOKEN_TTL_MS - QODER_EXPIRY_SAFETY_MS
}

/** 凭据文件路径（本线路自己拥有；号池把主账号镜像到这里）。 */
export function credentialPath(): string {
  return path.join(dshHomeDir(), 'storages', 'qoder-credentials.json')
}

/** 模型设置文件路径。 */
export function modelSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'qoder-models.json')
}

/**
 * machine id 文件路径（本线路自己持有的那份）。
 *
 * adopt 优先读 qodercli 的 `~/.qoder/.auth/machine_id`（解密它的凭据文件必须用那把
 * 原配 key）；本线路自己发请求用的 machine id 落在这里——不与 qodercli 的混用，
 * 也不写它的目录（读取顺序见 cosy.ts）。
 */
export function machineIdPath(): string {
  return path.join(dshHomeDir(), 'storages', 'qoder-machine-id')
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

// 登录、刷新回写与适配器流共享同一条落盘顺序。
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
 * 与兄弟线路同构：写入之后回读比对；按路径排队，避免两个同时落地的写互相丢掉。
 * 没有明文迁移分支（本线路从未发布过，没有历史文件要迁）。
 */
export class QoderCredentialStore {
  // 显式声明而不是构造函数参数属性：Node 的类型擦除加载器不接受参数属性。
  private readonly filePath: string
  private readonly backend: CredentialStore<QoderCredentials>

  constructor(filePath: string = credentialPath(), backend?: CredentialStore<QoderCredentials>) {
    this.filePath = filePath
    this.backend = backend ?? createCredentialBackend(filePath, parseQoderCredentials, 'Qoder')
  }

  /** 人可读的存储位置说明（Windows DPAPI / macOS Keychain / Linux Secret Service）。 */
  path(): string {
    if (process.platform === 'win32') return this.filePath + '.dpapi'
    const kind = process.platform === 'darwin' ? 'Keychain' : 'Secret Service'
    return kind + ': ' + PROVIDER_ID + '/' + credentialAccount(this.filePath)
  }

  read(): Promise<QoderCredentials | null> {
    return serialize(this.filePath, () => this.backend.load())
  }

  write(credentials: QoderCredentials): Promise<void> {
    return serialize(this.filePath, async () => {
      const normalized = parseQoderCredentials(credentials)
      await this.backend.save(normalized)
      const restored = await this.backend.load()
      if (!isDeepStrictEqual(restored, normalized)) {
        throw new Error('Qoder 加密凭据写入校验失败')
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
 * 随包目录 `QODER_MODEL_CATALOG_*` 刻意不存：它跟着代码走（同 step-code 的理由）。
 */
export interface QoderModelSettings {
  /** 线路总开关。只有显式 false 才是关闭。 */
  enabled?: boolean
  /**
   * 用户勾选的模型 id；缺省或空数组 = **不过滤（全选）**，非空 = 显式选择。
   * （语义逐字照抄 step-code：schemastery 会把缺省的 `z.array(z.string())` 归一化成
   * `[]`，所以没有「null = 不过滤」的第三态。）
   */
  enabledModelIds?: string[]
  /** 逐模型上下文窗口覆盖；缺省用目录声明值。 */
  contextWindowOverrides: Record<string, number>
  /** 会话没指定档位时用的档位；null 表示各模型用自己的默认。 */
  defaultReasoningEffort: QoderReasoningEffort | null
  /** 手动指定下一个请求使用的账号；null 交回号池调度。 */
  selectedAccountId: string | null
}

/** 一个设置补丁。 */
export interface QoderSettingsPatch {
  enabled?: boolean
  enabledModelIds?: string[]
  /** 补丁而不是整张表：`null` 必须能作为一个**值**活下来（卡片的「恢复目录默认」）。 */
  contextWindowOverrides?: ContextWindowOverridePatch
  defaultReasoningEffort?: QoderReasoningEffort | null
  selectedAccountId?: string | null
}

/**
 * 路由与适配器共用的接缝（与 step-code 同一个形状，`status()` 同步的理由也相同）。
 */
export interface QoderPreferenceStore {
  ready(): Promise<void>
  status(): QoderModelSettings
  update(patch: QoderSettingsPatch): Promise<QoderModelSettings>
}

const DEFAULT_ENABLED_MODEL_IDS: string[] = [...DEFAULT_VISIBLE_MODEL_IDS]

/** 一次全新安装的设置：全开、无过滤、无覆盖、无指定账号。 */
export function defaultQoderModelSettings(): QoderModelSettings {
  return {
    enabled: true,
    // 出厂值取自**随包**目录（空数组 = 不过滤），不取自运行时目录（同 step-code 的理由）。
    enabledModelIds: [...DEFAULT_ENABLED_MODEL_IDS],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    selectedAccountId: null,
  }
}

/**
 * 归一化一份解析出来的设置文档。什么都不抛：手改过或降级过的文档必须降级成一份
 * 可用的选择，而不是让整条线路不可用。
 */
export function parseQoderModelSettings(value: unknown): QoderModelSettings {
  if (!isRecord(value)) return defaultQoderModelSettings()
  const enabledModelIds = Array.isArray(value.enabledModelIds)
    ? value.enabledModelIds.filter((id): id is string => typeof id === 'string')
    : [...DEFAULT_ENABLED_MODEL_IDS]
  const contextWindowOverrides: Record<string, number> = {}
  if (isRecord(value.contextWindowOverrides)) {
    for (const [modelId, raw] of Object.entries(value.contextWindowOverrides)) {
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        contextWindowOverrides[modelId] = Math.floor(raw)
      }
    }
  }
  return {
    // 只有显式 false 才是关闭：键缺失是出厂状态。
    enabled: value.enabled !== false,
    enabledModelIds,
    contextWindowOverrides,
    defaultReasoningEffort: isQoderReasoningEffort(value.defaultReasoningEffort)
      ? value.defaultReasoningEffort
      : null,
    selectedAccountId: asString(value.selectedAccountId) ?? null,
  }
}

/** 把一个补丁应用到一份设置文档上（register 与文件两个后端共用这一套规则）。 */
export function mergeQoderSettings(
  current: QoderModelSettings,
  patch: QoderSettingsPatch,
): QoderModelSettings {
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
  }
}

/**
 * 凭据旁边的设置文件（没有 register 接缝的 harness 启动时读的就是它）。
 * 写入走「临时文件 + rename」，写完立刻回读比对再报告成功。
 */
export class QoderModelSettingsStore {
  private readonly filePath: string

  constructor(filePath: string = modelSettingsPath()) {
    this.filePath = filePath
  }

  path(): string {
    return this.filePath
  }

  async read(): Promise<QoderModelSettings> {
    try {
      return parseQoderModelSettings(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown)
    } catch {
      return defaultQoderModelSettings()
    }
  }

  async write(settings: QoderModelSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = this.filePath + '.tmp.' + Date.now()
    await fs.writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', 'utf8')
    await fs.rename(temporary, this.filePath)
    const restored = parseQoderModelSettings(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown)
    if (!isDeepStrictEqual(restored, settings)) {
      throw new Error('Qoder 模型设置写入失败：落盘的选择与刚写入的不一致')
    }
  }

  /** 在与凭据写入同一条按路径排队的锁里做「读-改-写」。 */
  updateSettings(patch: QoderSettingsPatch): Promise<QoderModelSettings> {
    return serialize(this.filePath, async () => {
      const next = mergeQoderSettings(await this.read(), patch)
      await this.write(next)
      return next
    })
  }
}

/**
 * 把模型选择绑到 DSH 设置文档（harness 还提供 register 接缝时），
 * 否则绑到凭据旁边的 JSON 文件。
 *
 * ⚠ `enabledModelIds` 不给 `.default()`（与 step-code 同一处实测：
 * schemastery 会把缺省的数组归一化成 `[]`，而 `[]` 与「不过滤」同义）。
 */
export function registerQoderPreferenceStore(
  settings?: unknown,
  fallbackStore: QoderModelSettingsStore = new QoderModelSettingsStore(),
): QoderPreferenceStore {
  if (!hasRegister(settings)) {
    let snapshot: QoderModelSettings = defaultQoderModelSettings()
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

  const scope = settings.register(resolveSettingsNamespace(QODER_PREFERENCES_NAMESPACE), z.object({
    enabled: z.boolean().default(true),
    // 刻意不给 .default()：见本函数上方那段注释。
    enabledModelIds: z.array(z.string()),
    contextWindowOverrides: z.dict(z.number()).default({}),
    defaultReasoningEffort: z
      .union([
        ...QODER_REASONING_EFFORTS.map((effort) => z.const(effort)),
        z.const(null),
      ])
      .default(null),
    selectedAccountId: z.union([z.string(), z.const(null)]).default(null),
  })) as SettingsScope<{
    enabled?: boolean
    enabledModelIds?: string[]
    contextWindowOverrides: Record<string, number>
    defaultReasoningEffort: QoderReasoningEffort | null
    selectedAccountId: string | null
  }>

  const currentValue = (): QoderModelSettings => {
    const value = scope.get()
    const settings: QoderModelSettings = {
      enabled: value.enabled !== false,
      contextWindowOverrides: value.contextWindowOverrides,
      defaultReasoningEffort: isQoderReasoningEffort(value.defaultReasoningEffort)
        ? value.defaultReasoningEffort
        : null,
      selectedAccountId: value.selectedAccountId ?? null,
    }
    // 空数组与缺省同义（不过滤），所以这里不制造一次「用户选了空集」的假象。
    if (Array.isArray(value.enabledModelIds) && value.enabledModelIds.length > 0) {
      settings.enabledModelIds = value.enabledModelIds
    }
    return settings
  }

  return {
    ready: async () => undefined,
    status: currentValue,
    update: async (patch) => {
      const normalized = mergeQoderSettings(currentValue(), patch)
      await scope.update({
        enabled: normalized.enabled !== false,
        enabledModelIds: normalized.enabledModelIds ?? [],
        contextWindowOverrides: normalized.contextWindowOverrides,
        defaultReasoningEffort: normalized.defaultReasoningEffort,
        selectedAccountId: normalized.selectedAccountId,
      })
      // 同时镜像进文件（下一次跑在没有 register 接缝的 harness 上时用户的选择还在）。
      void fallbackStore.updateSettings(patch).catch(() => undefined)
      return normalized
    },
  }
}

export { listModelIds }
