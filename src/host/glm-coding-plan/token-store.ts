/**
 * GLM（ZCode 账号）线路的凭据 / 模型设置 / 偏好三件套。
 *
 * 本线路**自己拥有**它的凭据文件：不像 minimax-code 那样读桌面客户端的 auth.json，
 * 也不像 claude 那样把一份 adopt 快照当权威。浏览器 OAuth 登录与 adopt 走的是同一条
 * 兑换链（计划 D4），两者产出**同一种** `GlmCodingPlanKey`，所以下游（号池、适配器）
 * 不必区分来源——除了**一件**事：
 *
 * - adopt 来的账号**永不可刷新**。它只是本机 ZCode 客户端登录态的一份拷贝，
 *   上游那边才是权威；计划 §3.6 又明确「没有 refresh 接口」，所以拷贝一旦落后，
 *   唯一能做的是让它失效并让用户重新登录，而不是花钱去刷新它。
 * - 浏览器登录来的账号可以在 access_token 仍然有效时被上游拒绝之后**重新兑换**一把
 *   Coding Plan Key（兑换链的输入就是 access_token），这不算「刷新」，是重跑一次链。
 *
 * 这条区别必须落在**凭据本身**上而不是落在号池的某个内存标记上：号池文件会被重新读、
 * 会被另一处代码改写，一个只活在内存里的判断会在重启后消失，于是 adopt 账号被刷新一次
 * ——那是一次拿别人的登录态去花额度的请求。因此这里用 adopt.ts 自己的判别式字段
 * （`adopted: true` + `source: 'zcode-client'` + `codingPlan`）落盘，
 * `isAdoptedZcodeCredential()` 对**整份凭据对象**直接给出答案。
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
import { mergeContextWindowOverrides, type ContextWindowOverridePatch } from '../common/context-window-overrides.ts'
import type { GlmReasoningEffort, GlmRegion } from '../../shared/glm-coding-plan-contracts.ts'
import { GLM_REASONING_EFFORTS, isGlmAllowanceKind } from '../../shared/glm-coding-plan-contracts.ts'
import { DEFAULT_VISIBLE_MODEL_IDS, listModelIds } from './model-catalog.ts'
import { PROVIDER_ID, isGlmReasoningEffort } from './types.ts'
import { ZCODE_CREDENTIAL_SOURCE, type GlmAdoptedCredential } from './adopt.ts'
import type { GlmCliCredentials } from './oauth.ts'
import type { GlmCodingPlanKey } from './exchange.ts'

// ---------------------------------------------------------------------------
// 凭据
// ---------------------------------------------------------------------------

/** 本线路在设置文档里注册的命名空间。 */
export const GLM_CODING_PLAN_PREFERENCES_NAMESPACE = 'dsh-glm-coding-plan'

/**
 * 这份凭据是「登进来的」还是「捡回来的」。
 *
 * 它不是一个偏好设置：它决定号池敢不敢对这份凭据动任何写操作，所以与凭据同生共死。
 */
export type GlmCodingPlanCredentialOrigin = 'browser' | 'adopt'

/**
 * 一份可服务请求的 Coding Plan 凭据。
 *
 * 真正发请求用的是 `codingPlan.codingPlanKey`（`{apiKeyId}.{secretKey}`）：模型面把它
 * 放进 Bearer / x-api-key，配额面把它**裸着**放进 authorization（两种写法的证据见
 * `mapper-anthropic.ts` 与 `client.ts` 的注释）。其余字段分三类：
 *
 * - 兑换链的输入与留档（accessToken 等）：重新兑换一把 Key 时唯一的输入；
 * - 非机密的账号事实（userId / email）：卡片渲染用；
 * - adopt 判别式（`adopted` / `source` / `sourcePath`）：见文件头。
 *
 * 区域不另存一份：它由 `codingPlan.region` 决定，而区域是**凭据的属性**（计划 §3.3），
 * 一个池里可以同时有两区账号。
 */
export interface GlmCodingPlanCredentials {
  /** 兑换链产物（已含验活）。 */
  codingPlan: GlmCodingPlanKey
  origin: GlmCodingPlanCredentialOrigin
  /** OAuth access_token：重新兑换 Coding Plan Key 的唯一输入。 */
  accessToken: string
  /** 上游同包下发，但**没有**对应的刷新接口（计划 §3.6），只留档与诊断。 */
  refreshToken: string | null
  userId: string | null
  email: string | null
  displayName: string | null
  /** 本插件接管这份登录态的时刻（Unix 毫秒）。 */
  authenticatedAt: number

  // --- adopt 判别式：浏览器登录来的凭据没有这三个字段 ------------------------
  /**
   * 判别式，取字面量 `true`。`isAdoptedZcodeCredential()` 读的就是它加上 `source` 与
   * `codingPlan`；一个布尔比一句注释更难被忽略，而这条判断一旦失效就是一次越权刷新。
   */
  adopted?: true
  /** 恒为 `ZCODE_CREDENTIAL_SOURCE`（'zcode-client'）。 */
  source?: typeof ZCODE_CREDENTIAL_SOURCE
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
  if (typeof value !== 'string') throw new Error('GLM 凭据字段无效：' + key)
  return value
}

function isRegion(value: unknown): value is GlmRegion {
  return value === 'cn' || value === 'intl'
}

/**
 * 校验并归一化一份落盘的凭据。
 *
 * 缺的字段一律拒绝而不是补默认值：缺 `codingPlanKey` 的凭据发出去一定是一次 401，
 * 而「给它编一个失效时刻」只会让号池相信它还能用。
 */
export function parseGlmCodingPlanCredentials(value: unknown): GlmCodingPlanCredentials {
  if (!isRecord(value)) throw new Error('GLM 凭据载荷无效')
  const plan = isRecord(value.codingPlan) ? value.codingPlan : undefined
  if (plan === undefined) throw new Error('GLM 凭据缺少兑换链产物')
  const codingPlanKey = asString(plan.codingPlanKey)
  if (codingPlanKey === undefined) throw new Error('GLM 凭据缺少 Coding Plan Key')
  const region = isRegion(plan.region) ? plan.region : undefined
  if (region === undefined) throw new Error('GLM 凭据的区域无效')
  const authenticatedAt = asFiniteNumber(value.authenticatedAt) ?? 0

  const credentials: GlmCodingPlanCredentials = {
    codingPlan: {
      region,
      codingPlanKey,
      apiKeyId: asString(plan.apiKeyId) ?? '',
      secretKey: asString(plan.secretKey) ?? '',
      keyName: asString(plan.keyName) ?? '',
      keyCreated: plan.keyCreated === true,
      organizationId: asString(plan.organizationId) ?? '',
      projectId: asString(plan.projectId) ?? '',
      accountName: asString(plan.accountName) ?? null,
      // 国区没有业务 JWT 这一层，落盘时不要假设它存在（任务书接线要点）。
      bizToken: asString(plan.bizToken) ?? null,
      bizTokenExpiresAt: asFiniteNumber(plan.bizTokenExpiresAt) ?? null,
      planLevel: asString(plan.planLevel) ?? null,
      // 额度类型是**后加的**字段：旧凭据文件里没有它，缺省补成 unknown（= 分不出来），
      // 而不是猜成 'plan'。猜错的后果是给一个免费额度用户谎报付费套餐。
      allowance: isGlmAllowanceKind(plan.allowance) ? plan.allowance : 'unknown',
    },
    origin: isAdoptedSnapshot(value) ? 'adopt' : 'browser',
    accessToken: asString(value.accessToken) ?? '',
    refreshToken: optionalString(value, 'refreshToken') ?? null,
    userId: optionalString(value, 'userId') ?? null,
    email: optionalString(value, 'email') ?? null,
    displayName: optionalString(value, 'displayName') ?? null,
    authenticatedAt,
  }
  if (credentials.origin === 'adopt') {
    credentials.adopted = true
    credentials.source = ZCODE_CREDENTIAL_SOURCE
    const sourcePath = optionalString(value, 'sourcePath')
    if (sourcePath !== undefined) credentials.sourcePath = sourcePath
  }
  return credentials
}

/** 一份值是否带着 adopt 判别式（本地判读，供落盘解析用）。 */
function isAdoptedSnapshot(value: Record<string, unknown>): boolean {
  return value.adopted === true && value.source === ZCODE_CREDENTIAL_SOURCE
}

/** 一份凭据是不是 adopt 快照（号池据此拒绝刷新它）。 */
export function isAdoptedCredential(credentials: GlmCodingPlanCredentials): boolean {
  return isAdoptedSnapshot(credentials as unknown as Record<string, unknown>)
}

/**
 * 浏览器登录的凭据 → 落盘形态。
 *
 * 兑换链已经跑完并验过活，这里只做形状转换。登录的部署与兑换的部署必须一致：
 * 区域是凭据的属性，而 `codingPlan.region` 记的是兑换那一侧的事实。
 */
export function credentialsFromCliLogin(
  session: GlmCliCredentials,
  codingPlan: GlmCodingPlanKey,
): GlmCodingPlanCredentials {
  return {
    codingPlan,
    origin: 'browser',
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    userId: session.userId,
    email: session.email,
    displayName: session.displayName,
    authenticatedAt: session.authenticatedAt,
  }
}

/**
 * adopt 来的凭据 → 落盘形态。
 *
 * 判别式与 `sourcePath` 一并写入，让 `isAdoptedZcodeCredential()` 在**任何一次读回**之后
 * 仍然给出同一个答案——这是「永不可刷新」能跨重启成立的全部原因。
 */
export function credentialsFromAdopt(adopted: GlmAdoptedCredential): GlmCodingPlanCredentials {
  return {
    codingPlan: adopted.codingPlan,
    origin: 'adopt',
    accessToken: adopted.accessToken,
    refreshToken: adopted.refreshToken,
    userId: adopted.userId,
    email: adopted.email,
    displayName: adopted.displayName,
    authenticatedAt: adopted.authenticatedAt,
    adopted: true,
    source: ZCODE_CREDENTIAL_SOURCE,
    sourcePath: adopted.sourcePath,
  }
}

/** 凭据文件路径（本线路自己拥有；号池把主账号镜像到这里）。 */
export function credentialPath(): string {
  return path.join(dshHomeDir(), 'storages', 'glm-coding-plan-credentials.json')
}

/** 模型设置文件路径。 */
export function modelSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'glm-coding-plan-models.json')
}

function credentialAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}

function createCredentialBackend(filePath: string): CredentialStore<GlmCodingPlanCredentials> {
  if (process.platform === 'win32') {
    return new WindowsDpapiCredentialStore(filePath + '.dpapi', parseGlmCodingPlanCredentials)
  }
  if (process.platform === 'darwin') {
    return new MacKeychainCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseGlmCodingPlanCredentials)
  }
  if (process.platform === 'linux') {
    return new SecretServiceCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseGlmCodingPlanCredentials)
  }
  throw new Error('GLM（ZCode 账号）凭据存储只支持 Windows、macOS 或 Linux。')
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
 * 加密凭据存储；明文 JSON 只是迁移来源。
 *
 * 与 kimi-code 同构：读回加密值之后立刻删掉明文（一份别的进程能读到的凭据副本不该留着），
 * 写入之后回读比对，避免「写成功了但下一次启动读到的是别的东西」。
 */
export class GlmCodingPlanCredentialStore {
  // 显式声明而不是构造函数参数属性：Node 的类型擦除加载器不接受参数属性，
  // 而这个包是被直接以 TypeScript 形式导入的。
  private readonly filePath: string
  private readonly backend: CredentialStore<GlmCodingPlanCredentials>

  constructor(filePath: string = credentialPath(), backend?: CredentialStore<GlmCodingPlanCredentials>) {
    this.filePath = filePath
    this.backend = backend ?? createCredentialBackend(filePath)
  }

  /** 人可读的存储位置说明（Windows DPAPI / macOS Keychain / Linux Secret Service）。 */
  path(): string {
    if (process.platform === 'win32') return this.filePath + '.dpapi'
    const kind = process.platform === 'darwin' ? 'Keychain' : 'Secret Service'
    return kind + ': ' + PROVIDER_ID + '/' + credentialAccount(this.filePath)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    return serialize(this.filePath, operation)
  }

  private async removeLegacy(): Promise<void> {
    try {
      await fs.unlink(this.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('GLM 旧明文凭据清理失败')
      }
    }
  }

  private async saveVerified(credentials: GlmCodingPlanCredentials): Promise<void> {
    await this.backend.save(credentials)
    const restored = await this.backend.load()
    if (!isDeepStrictEqual(restored, credentials)) {
      throw new Error('GLM 加密凭据写入校验失败')
    }
    await this.removeLegacy()
  }

  read(): Promise<GlmCodingPlanCredentials | null> {
    return this.serialize(async () => {
      // 损坏 / 被锁的安全存储绝不回落成过期明文。
      const current = await this.backend.load()
      if (current !== null) {
        await this.removeLegacy()
        return current
      }
      let legacy: string
      try {
        const stats = await fs.lstat(this.filePath)
        if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Invalid credential file')
        if (process.getuid && stats.uid !== process.getuid()) throw new Error('Invalid credential owner')
        if (process.platform !== 'win32') await fs.chmod(this.filePath, 0o600)
        legacy = await fs.readFile(this.filePath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw new Error('GLM 旧明文凭据读取失败')
      }
      let credentials: GlmCodingPlanCredentials
      try {
        credentials = parseGlmCodingPlanCredentials(JSON.parse(legacy) as unknown)
      } catch {
        throw new Error('GLM 旧明文凭据载荷无效')
      }
      await this.saveVerified(credentials)
      return credentials
    })
  }

  write(credentials: GlmCodingPlanCredentials): Promise<void> {
    return this.serialize(() => this.saveVerified(parseGlmCodingPlanCredentials(credentials)))
  }

  delete(): Promise<void> {
    return this.serialize(async () => {
      // 先删迁移来源：一次失败的登出不能让它复活。
      await this.removeLegacy()
      await this.backend.clear()
    })
  }
}

// ---------------------------------------------------------------------------
// 模型设置与偏好
// ---------------------------------------------------------------------------

/**
 * 本线路设置文档里**用户自己**的那一半。
 *
 * 随包目录 `GLM_MODEL_CATALOG` 刻意不存：它跟着代码走，存一份副本会让一个落后一个
 * 版本的设置文件读到这份构建已经不再服务的模型列表。
 */
export interface GlmCodingPlanModelSettings {
  /** 线路总开关。只有显式 false 才是关闭。 */
  enabled?: boolean
  /** DSH 提供给会话模型选择器的目录 id。 */
  enabledModelIds: string[]
  /** 逐模型上下文窗口覆盖；缺省用目录声明值。 */
  contextWindowOverrides: Record<string, number>
  /** 会话没指定档位时用的档位；null 表示各模型用自己的默认。 */
  defaultReasoningEffort: GlmReasoningEffort | null
  /** 手动指定下一个请求使用的账号；null 交回号池调度。 */
  selectedAccountId: string | null
}

/**
 * 一个设置补丁。
 *
 * `contextWindowOverrides` 是补丁而不是整张表：`null` 必须能作为一个**值**活下来，
 * 它是卡片上的「恢复目录默认」，删掉恰好一个键。
 */
export interface GlmCodingPlanSettingsPatch {
  enabled?: boolean
  enabledModelIds?: string[]
  contextWindowOverrides?: ContextWindowOverridePatch
  defaultReasoningEffort?: GlmReasoningEffort | null
  selectedAccountId?: string | null
}

/**
 * 路由与适配器共用的接缝。
 *
 * `status()` 同步：它在模型选择器查询与卡片轮询上被调用，两者都只需要一份快照；
 * 把它做成 promise 会让每一条热路径都去等一次磁盘读，而它的变化速度是人的速度。
 */
export interface GlmCodingPlanPreferenceStore {
  /**
   * 文件后端是异步预热的，所以 `status()` 在那次读落定之前先回答出厂默认值。
   * 启动时按偏好行动的一方必须先 await 它，否则它行动在默认值而不是用户的选择上。
   */
  ready(): Promise<void>
  status(): GlmCodingPlanModelSettings
  update(patch: GlmCodingPlanSettingsPatch): Promise<GlmCodingPlanModelSettings>
}

const DEFAULT_ENABLED_MODEL_IDS: string[] = [...DEFAULT_VISIBLE_MODEL_IDS]

/** 一次全新安装的设置：全开、无覆盖、无指定账号。 */
function defaultGlmCodingPlanSettings(): GlmCodingPlanModelSettings {
  return {
    enabled: true,
    enabledModelIds: [...DEFAULT_ENABLED_MODEL_IDS],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    selectedAccountId: null,
  }
}

/**
 * 归一化一份解析出来的设置文档。
 *
 * 这里什么都不抛：它在启动和每次状态轮询上被读，手改过或降级过的文档必须降级成一份
 * 可用的选择，而不是让整条线路不可用。
 */
function parseGlmCodingPlanModelSettings(value: unknown): GlmCodingPlanModelSettings {
  if (!isRecord(value)) return defaultGlmCodingPlanSettings()
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
    defaultReasoningEffort: isGlmReasoningEffort(value.defaultReasoningEffort)
      ? value.defaultReasoningEffort
      : null,
    selectedAccountId: asString(value.selectedAccountId) ?? null,
  }
}

/**
 * 把一个补丁应用到一份设置文档上。
 *
 * 合并逻辑住在两个 store 之外：register 后端必须用与文件后端**同一套**规则归一化 scope 的值，
 * 同一份逻辑写两遍就是两条存储路径第一次学到新字段时开始漂移的方式。
 */
export function mergeGlmCodingPlanSettings(
  current: GlmCodingPlanModelSettings,
  patch: GlmCodingPlanSettingsPatch,
): GlmCodingPlanModelSettings {
  return {
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled !== false,
    enabledModelIds: patch.enabledModelIds ?? current.enabledModelIds,
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
 * 凭据旁边的设置文件。
 *
 * 没有 register 接缝的 harness（0.1.7，以及无头 host）启动时读的就是它，所以它必须扛得住崩溃：
 * 写入走「临时文件 + rename」，写完立刻回读比对再报告成功。
 */
export class GlmCodingPlanModelSettingsStore {
  private readonly filePath: string

  constructor(filePath: string = modelSettingsPath()) {
    this.filePath = filePath
  }

  path(): string {
    return this.filePath
  }

  async read(): Promise<GlmCodingPlanModelSettings> {
    try {
      return parseGlmCodingPlanModelSettings(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown)
    } catch {
      // 读不到或读坏了就回落出厂默认。
      return defaultGlmCodingPlanSettings()
    }
  }

  async write(settings: GlmCodingPlanModelSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = this.filePath + '.tmp.' + Date.now()
    await fs.writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', 'utf8')
    await fs.rename(temporary, this.filePath)
    const restored = parseGlmCodingPlanModelSettings(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown)
    if (!isDeepStrictEqual(restored, settings)) {
      throw new Error('GLM 模型设置写入失败：落盘的选择与刚写入的不一致')
    }
  }

  /**
   * 在与凭据写入同一条按路径排队的锁里做「读-改-写」。
   *
   * 没有它，两个同时落地的补丁各读同一份文档，后一个写会把前一个悄悄丢掉——
   * 一次没有任何报错的模型选择丢失。
   */
  updateSettings(patch: GlmCodingPlanSettingsPatch): Promise<GlmCodingPlanModelSettings> {
    return serialize(this.filePath, async () => {
      const next = mergeGlmCodingPlanSettings(await this.read(), patch)
      await this.write(next)
      return next
    })
  }
}

/**
 * 把模型选择绑到 DSH 设置文档（harness 还提供 register 接缝时），
 * 否则绑到凭据旁边的 JSON 文件。
 */
export function registerGlmCodingPlanPreferenceStore(
  settings?: unknown,
  fallbackStore: GlmCodingPlanModelSettingsStore = new GlmCodingPlanModelSettingsStore(),
): GlmCodingPlanPreferenceStore {
  if (!hasRegister(settings)) {
    // 没有设置命名空间可写时，凭据旁边的 JSON 文件就是 store。它在这里被读一次，
    // 于是上一次运行保存的选择在这一次启动后仍然有效；这次读不被 await，
    // 免得在启动时装配插件的一方被一次磁盘读挡住，`status()` 在它落定前先回答默认值。
    let snapshot: GlmCodingPlanModelSettings = defaultGlmCodingPlanSettings()
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

  const scope = settings.register(resolveSettingsNamespace(GLM_CODING_PLAN_PREFERENCES_NAMESPACE), z.object({
    enabled: z.boolean().default(true),
    enabledModelIds: z.array(z.string()).default([...DEFAULT_ENABLED_MODEL_IDS]),
    contextWindowOverrides: z.dict(z.number()).default({}),
    defaultReasoningEffort: z
      .union([
        ...GLM_REASONING_EFFORTS.map((effort) => z.const(effort)),
        z.const(null),
      ])
      .default(null),
    selectedAccountId: z.union([z.string(), z.const(null)]).default(null),
  })) as SettingsScope<{
    enabled: boolean
    enabledModelIds: string[]
    contextWindowOverrides: Record<string, number>
    defaultReasoningEffort: GlmReasoningEffort | null
    selectedAccountId: string | null
  }>

  const currentValue = (): GlmCodingPlanModelSettings => {
    const value = scope.get()
    return {
      enabled: value.enabled !== false,
      enabledModelIds: value.enabledModelIds,
      contextWindowOverrides: value.contextWindowOverrides,
      defaultReasoningEffort: isGlmReasoningEffort(value.defaultReasoningEffort)
        ? value.defaultReasoningEffort
        : null,
      selectedAccountId: value.selectedAccountId ?? null,
    }
  }

  return {
    // register 后端是同步读的，没有要等的；这个接缝存在是为了调用方不必知道自己拿的是哪一个。
    ready: async () => undefined,
    status: currentValue,
    update: async (patch) => {
      // 只读一次：两次读一个活的 scope 可能跨过另一个订阅者的写入，
      // 拿第二读去合并、第一读去落盘，正是这个 store 要避免的丢失更新。
      const normalized = mergeGlmCodingPlanSettings(currentValue(), patch)
      await scope.update(normalized)
      // 同时镜像进文件，这样下一次跑在没有 register 接缝的 harness 上时用户的选择还在。
      // 镜像是尽力而为的：刚刚成功落盘的是注册文档。
      void fallbackStore.updateSettings(patch).catch(() => undefined)
      return normalized
    },
  }
}

export { listModelIds }

