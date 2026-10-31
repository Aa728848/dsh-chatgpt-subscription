/**
 * 「子智能体」设置卡片的**状态与动作**。
 *
 * ## 这张卡替换了宿主的同名卡
 *
 * 宿主自带 `@deepseek-ai/dsh-client-ui-settings-subagent` 在 `plugins.item` 上以
 * `id: 'subagent'`、默认 priority 注册。本插件以同一个 id、`priority: -10` 再注册
 * 一次——槽位的遮蔽规则是「同一个 cell 上 priority 最低的那一条渲染」，于是打开
 * 「插件 → 子智能体」看到的是这张卡，而不是两张并排。
 *
 * ## 三份存储，一次保存
 *
 * | 来源 | 内容 | 通道 |
 * | --- | --- | --- |
 * | `subagent` 命名空间 | `maxDepth` / `maxActiveSubagents` | `ctx.configForms` |
 * | `subagent-model-selection-settings` 命名空间 | `enabled` / `allowedModels` | `ctx.configForms` |
 * | 本插件偏好文档 | 全局默认列表 + 每个主代理模型的专属列表 | `POST /preferences/update` |
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/subagent/subagent-card-controller
 */

import { ROUTE_PREFIX } from '../../compat.ts'
import type { SnapshotStore } from '../store.ts'

/** 宿主侧「运行限制」的命名空间。 */
export const SUBAGENT_LIMITS_NS = 'subagent'

/** 宿主侧「模型选择」的命名空间。 */
export const SUBAGENT_MODEL_SELECTION_NS = 'subagent-model-selection-settings'

/** 主代理模型下拉里代表「全局默认」的取值。 */
export const GLOBAL_TARGET = 'default'

/** 浏览器侧本地备份键（当宿主进程尚未重启加载新版 /preferences/update 时兜底）。 */
const LOCAL_STORAGE_KEY = 'dsh-chatgpt-subscription:subagent-model-preferences'

/** 一条精确的 provider/model 路由。 */
export interface SubagentModelRoute {
  provider: string
  model: string
}

/** 一条路由 + 目录里的显示名 + 当前勾选态。 */
export interface SubagentModelCandidate extends SubagentModelRoute {
  /** 不透明标识，调用方只用于查找，绝不解析。 */
  key: string
  /** 适配器给出的提供方显示名。 */
  providerName: string
  /** 适配器给出的模型显示名。 */
  modelName: string
  /** 当前目录是否还在公布这条路由。 */
  available: boolean
  /** 当前草稿是否勾选这条路由。 */
  selected: boolean
}

/** 主代理模型下拉里的一个提供方分组。 */
export interface SubagentMainModelGroup {
  provider: string
  providerName: string
  models: Array<{ key: string; model: string; modelName: string; overridden: boolean }>
}

/** 一个数字限制字段的展示态。 */
export interface SubagentLimitField {
  /** 输入框里应当显示的文本（草稿优先）。 */
  value: string
  /** 宿主基础层（未覆盖时回落到这里）。 */
  base: string
  /** 用户层是否已经覆盖了这一项。 */
  overridden: boolean
  /** 当前文本是否是合法取值。 */
  invalid: boolean
}

/** 卡片渲染所需的全部状态。 */
export interface SubagentSettingsState {
  /** 宿主是否服务这两个命名空间（至少一个）。 */
  available: boolean
  /** 宿主文档是否接受写入。 */
  writable: boolean
  /** 是否有未保存的改动。 */
  dirty: boolean
  /** 当前草稿是否不合法（保存按钮据此禁用）。 */
  invalid: boolean
  /** 是否正在保存。 */
  saving: boolean
  /** 上一次保存是否失败。 */
  failed: boolean

  /** 最大递归深度。 */
  maxDepth: SubagentLimitField
  /** 并行数量上限。 */
  maxActiveSubagents: SubagentLimitField

  /** 模型选择总开关。 */
  enabled: boolean
  /** 当前正在编辑的目标：`default` 或 `<provider>/<model>`。 */
  activeTarget: string
  /** 全局默认列表的条数。 */
  defaultCount: number
  /** 每个主代理模型的专属列表（只含非空项）。 */
  overridesByMainModel: Readonly<Record<string, readonly SubagentModelRoute[]>>
  /** 目录里公布的主代理模型分组。 */
  mainModelGroups: readonly SubagentMainModelGroup[]
  /** 已保存但目录当前不公布的主代理模型键。 */
  orphanMainModels: readonly string[]
  /** 模型目录请求状态。 */
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** 是否有部分提供方加载失败。 */
  catalogPartial: boolean
  /** 当前目标的候选行（勾选态已按目标解析）。 */
  candidates: readonly SubagentModelCandidate[]
  /** 当前目标是否已有专属列表。 */
  activeTargetOverridden: boolean
  /** 当前目标生效的条数。 */
  activeTargetCount: number
  /** 偏好文档读取状态。 */
  preferencesStatus: 'idle' | 'loading' | 'ready' | 'error'
}

/** 注入给卡片的动作面。 */
export interface SubagentSettingsActions {
  editLimit: (field: 'maxDepth' | 'maxActiveSubagents', text: string) => void
  resetLimit: (field: 'maxDepth' | 'maxActiveSubagents') => void
  toggleEnabled: () => void
  toggleModel: (key: string) => void
  setActiveTarget: (target: string) => void
  resetActiveTarget: () => void
  retryCatalog: () => void
  save: () => void
  discard: () => void
}

/** 注入给卡片的座位：快照 + 动作。 */
export interface SubagentSettingsInjected extends SubagentSettingsActions {
  store: SnapshotStore<SubagentSettingsState>
}

/** 目录里的一个提供方分组（归一化后统一带 provider + providerName，也兼容 id + name）。 */
export interface SubagentCatalogGroup {
  provider: string
  providerName: string
  models: Array<{ id: string; name: string }>
}

/** 偏好文档里与子代理模型有关的两项。 */
export interface SubagentModelPreferences {
  subagentDefaultModels?: SubagentModelRoute[]
  subagentModelsByMainModel?: Record<string, SubagentModelRoute[] | null>
}

/** 一条 configForm 变更指令。 */
export type SubagentFormOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

/**
 * 鸭子类型的设置表单面。
 */
export interface SubagentFormScope<T> {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value: T | undefined
    base: unknown
    user: unknown
    revision: number | undefined
    writable: boolean
  }
  subscribe(listener: () => void): () => void
  mutate?(ops: ReadonlyArray<SubagentFormOp>, expectedRevision?: number): Promise<boolean>
  set?(field: string, value: unknown): Promise<boolean>
}

/** 表单服务面（`ctx.configForms`）。 */
export interface SubagentConfigForms {
  get<T>(entryId: string): SubagentFormScope<T>
  whileServed?(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
}

/** 宿主 `subagent` 命名空间的取值。 */
export interface SubagentLimitsSettings {
  maxDepth?: number
  maxActiveSubagents?: number
}

/** 宿主 `subagent-model-selection-settings` 命名空间的取值。 */
export interface SubagentModelSelectionSettings {
  enabled?: boolean
  allowedModels?: SubagentModelRoute[]
}

/** 控制器的外部依赖：全部可注入，因此测试不需要真宿主。 */
export interface SubagentSettingsControllerOptions {
  /** 运行限制表单。 */
  limits?: SubagentFormScope<SubagentLimitsSettings>
  /** 模型选择表单。 */
  modelSelection?: SubagentFormScope<SubagentModelSelectionSettings>
  /** 读取模型目录。 */
  loadCatalog?: () => Promise<{ ok: boolean; groups: readonly SubagentCatalogGroup[]; partial?: boolean }>
  /** 读取本插件的偏好。 */
  loadPreferences?: () => Promise<SubagentModelPreferences | undefined>
  /** 写入本插件的偏好。 */
  savePreferences?: (patch: SubagentModelPreferences) => Promise<void>
}

/** 一条路由的不透明键。 */
export function routeKey(route: SubagentModelRoute): string {
  return `${route.provider}/${route.model}`
}

/**
 * 把 `<provider>/<model>` 拆回一条路由。
 *
 * provider id 与 model id 都可能含 `/`（例如 `openrouter/anthropic/claude`），
 * 所以只按**第一个**斜杠拆；这与 `list_subagent_models` 的输出约定一致。
 * @param key - 目标键。
 * @returns 路由，或 undefined（不是路由形态）。
 */
export function parseRouteKey(key: string): SubagentModelRoute | undefined {
  const cut = key.indexOf('/')
  if (cut <= 0 || cut === key.length - 1) return undefined
  return { provider: key.slice(0, cut), model: key.slice(cut + 1) }
}

/** 过滤并克隆非空合法路由。 */
function cloneRoutes(routes: readonly SubagentModelRoute[]): SubagentModelRoute[] {
  const out: SubagentModelRoute[] = []
  const seen = new Set<string>()
  for (const route of routes) {
    if (typeof route?.provider !== 'string' || typeof route?.model !== 'string') continue
    const provider = route.provider.trim()
    const model = route.model.trim()
    if (provider.length === 0 || model.length === 0) continue
    if (provider === 'undefined' || model === 'undefined') continue
    const key = `${provider}/${model}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ provider, model })
  }
  return out
}

function sameRouteSet(left: readonly SubagentModelRoute[], right: readonly SubagentModelRoute[]): boolean {
  if (left.length !== right.length) return false
  const keys = new Set(right.map(routeKey))
  return left.every(route => keys.has(routeKey(route)))
}

function sameOverrides(
  left: Readonly<Record<string, readonly SubagentModelRoute[]>>,
  right: Readonly<Record<string, readonly SubagentModelRoute[]>>,
): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key, index) => key === rightKeys[index] && sameRouteSet(left[key] ?? [], right[key] ?? []))
}

/** 最小快照 store：`useSyncExternalStore` 要求引用在两次变更之间稳定。 */
function createStore<T>(initial: T): SnapshotStore<T> & { setState(next: T): void } {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setState: (next: T) => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** 未绑定表单时的空快照。 */
const EMPTY_SNAPSHOT = Object.freeze({
  status: 'unavailable' as const,
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
})

/** 空表单（服务缺席时用它顶替，让所有读取都成立）。 */
const NO_SCOPE: SubagentFormScope<never> = {
  getSnapshot: () => EMPTY_SNAPSHOT,
  subscribe: () => () => {},
}

/**
 * 归一化模型目录分组：兼容宿主的 `{ id, name, models }` 与测试替身的 `{ provider, providerName, models }`。
 */
export function normalizeCatalogGroups(rawGroups: readonly unknown[]): SubagentCatalogGroup[] {
  const groups: SubagentCatalogGroup[] = []
  for (const entry of rawGroups) {
    if (typeof entry !== 'object' || entry === null) continue
    const rec = entry as Record<string, unknown>
    const provider = typeof rec['provider'] === 'string' && rec['provider'].trim().length > 0
      ? rec['provider'].trim()
      : (typeof rec['id'] === 'string' && rec['id'].trim().length > 0 ? rec['id'].trim() : '')
    if (provider.length === 0) continue
    const providerName = typeof rec['providerName'] === 'string' && rec['providerName'].trim().length > 0
      ? rec['providerName'].trim()
      : (typeof rec['name'] === 'string' && rec['name'].trim().length > 0 ? rec['name'].trim() : provider)
    const rawModels = Array.isArray(rec['models']) ? rec['models'] : []
    const models: Array<{ id: string; name: string }> = []
    for (const rawModel of rawModels) {
      if (typeof rawModel !== 'object' || rawModel === null) continue
      const mRec = rawModel as Record<string, unknown>
      const id = typeof mRec['id'] === 'string' && mRec['id'].trim().length > 0
        ? mRec['id'].trim()
        : (typeof mRec['model'] === 'string' && mRec['model'].trim().length > 0 ? mRec['model'].trim() : '')
      if (id.length === 0) continue
      const name = typeof mRec['name'] === 'string' && mRec['name'].trim().length > 0
        ? mRec['name'].trim()
        : (typeof mRec['modelName'] === 'string' && mRec['modelName'].trim().length > 0 ? mRec['modelName'].trim() : id)
      models.push({ id, name })
    }
    groups.push({ provider, providerName, models })
  }
  return groups
}

function readLocalBackup(): SubagentModelPreferences | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as SubagentModelPreferences
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return {
      subagentDefaultModels: Array.isArray(parsed.subagentDefaultModels) ? cloneRoutes(parsed.subagentDefaultModels) : [],
      subagentModelsByMainModel: parsed.subagentModelsByMainModel ?? {},
    }
  } catch {
    return undefined
  }
}

function writeLocalBackup(patch: SubagentModelPreferences): void {
  try {
    if (typeof localStorage === 'undefined') return
    const prev = readLocalBackup()
    const mergedOverrides: Record<string, SubagentModelRoute[] | null> = { ...(prev?.subagentModelsByMainModel ?? {}) }
    for (const [k, v] of Object.entries(patch.subagentModelsByMainModel ?? {})) {
      if (v === null || !Array.isArray(v) || v.length === 0) delete mergedOverrides[k]
      else mergedOverrides[k] = cloneRoutes(v)
    }
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({
      subagentDefaultModels: Array.isArray(patch.subagentDefaultModels) ? cloneRoutes(patch.subagentDefaultModels) : (prev?.subagentDefaultModels ?? []),
      subagentModelsByMainModel: mergedOverrides,
    }))
  } catch {
    // ignore storage errors
  }
}

/**
 * 读本插件偏好里的子代理模型两项。
 * @returns 偏好切片；读取失败时 undefined（卡片照常可用，只是从空列表起步）。
 */
export async function readSubagentPreferences(): Promise<SubagentModelPreferences | undefined> {
  const local = readLocalBackup()
  try {
    const response = await fetch(`${ROUTE_PREFIX}/status`, { credentials: 'same-origin' })
    if (!response.ok) return local
    const envelope = await response.json() as { ok?: boolean; value?: { preferences?: SubagentModelPreferences } }
    const preferences = envelope?.value?.preferences
    if (preferences === undefined || preferences === null) return local
    const serverDefaults = Array.isArray(preferences.subagentDefaultModels)
      ? cloneRoutes(preferences.subagentDefaultModels)
      : []
    const serverByMain = preferences.subagentModelsByMainModel ?? {}
    if (serverDefaults.length === 0 && Object.keys(serverByMain).length === 0 && local !== undefined) {
      return local
    }
    return {
      subagentDefaultModels: serverDefaults,
      subagentModelsByMainModel: serverByMain,
    }
  } catch {
    return local
  }
}

/**
 * 写本插件偏好里的子代理模型两项。
 * @param patch - 要写入的两项。
 */
export async function writeSubagentPreferences(patch: SubagentModelPreferences): Promise<void> {
  writeLocalBackup(patch)
  const response = await fetch(`${ROUTE_PREFIX}/preferences/update`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const envelope = await response.json().catch(() => undefined) as { ok?: boolean; error?: { message?: string } } | undefined
  if (!response.ok || envelope?.ok === false) {
    throw new Error(envelope?.error?.message ?? 'The deployment rejected the subagent model preferences.')
  }
}

/**
 * 读宿主模型目录。
 *
 * `remote.session.modelCatalog()` 返回 `{ ok: true, value: { groups: ModelProviderGroup[], failures } }`，
 * 其中每个 `group` 是 `{ id: string, name: string, models: Array<{ id: string, name: string }> }`。
 * @param ctx - 浏览器根上下文（只用 `get`）。
 * @returns 分组，或失败。
 */
export async function readSubagentCatalog(ctx?: { get?(name: string): unknown }): Promise<{ ok: boolean; groups: SubagentCatalogGroup[]; partial?: boolean }> {
  try {
    const remote = ctx?.get?.('remote') as { session?: { modelCatalog?: () => Promise<unknown> } } | undefined
    const session = remote?.session
    const call = session?.modelCatalog
    if (typeof call === 'function' && session !== undefined) {
      const answer = await call.call(session) as { ok?: boolean; value?: { groups?: unknown[]; failures?: unknown[] } }
      if (answer?.ok === true && Array.isArray(answer.value?.groups)) {
        return {
          ok: true,
          groups: normalizeCatalogGroups(answer.value.groups),
          partial: (answer.value.failures?.length ?? 0) > 0,
        }
      }
      return { ok: false, groups: [] }
    }
  } catch {
    return { ok: false, groups: [] }
  }
  return { ok: false, groups: [] }
}

/** 数字限制字段的解析规则。 */
function parseLimit(text: string, minimum: number): number | undefined {
  const trimmed = text.trim()
  if (!/^[0-9]+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value >= minimum && !Object.is(value, -0) ? value : undefined
}

/** 取表单快照里的一个数字字段（缺失时用兜底值）。 */
function readNumber(value: unknown, field: string, fallback: number): number {
  if (typeof value !== 'object' || value === null) return fallback
  const raw = (value as Record<string, unknown>)[field]
  return typeof raw === 'number' && Number.isSafeInteger(raw) ? raw : fallback
}

/** 用户层是否已经覆盖了某个字段（存在性即覆盖，与值无关）。 */
function userHas(user: unknown, field: string): boolean {
  return typeof user === 'object' && user !== null && field in (user as Record<string, unknown>)
}

/**
 * 子智能体设置卡片的状态机。
 */
export class SubagentSettingsController {
  private readonly limits: SubagentFormScope<SubagentLimitsSettings>
  private readonly modelSelection: SubagentFormScope<SubagentModelSelectionSettings>
  private readonly loadCatalog: () => Promise<{ ok: boolean; groups: readonly SubagentCatalogGroup[]; partial?: boolean }>
  private readonly loadPreferences: () => Promise<SubagentModelPreferences | undefined>
  private readonly savePreferences: (patch: SubagentModelPreferences) => Promise<void>
  private readonly store = createStore<SubagentSettingsState>(undefined as unknown as SubagentSettingsState)
  private readonly unsubscribes: Array<() => void> = []

  private preferences: SubagentModelPreferences | undefined
  private preferencesStatus: SubagentSettingsState['preferencesStatus'] = 'idle'
  private catalogGroups: readonly SubagentCatalogGroup[] = []
  private catalogPartial = false
  private catalogStatus: SubagentSettingsState['catalogStatus'] = 'idle'

  private draftDepth: string | undefined
  private draftDepthCleared = false
  private draftActive: string | undefined
  private draftActiveCleared = false
  private draftEnabled: boolean | undefined
  private draftDefault: SubagentModelRoute[] | undefined
  private draftOverrides: Record<string, SubagentModelRoute[]> | undefined
  private draftRevision: number | undefined

  private activeTarget: string = GLOBAL_TARGET
  private saving = false
  private failed = false
  private disposed = false
  private catalogGeneration = 0
  private saveGeneration = 0

  /**
   * @param options - 表单通道与三条外部依赖；全部可省，省略时卡片是只读的。
   */
  constructor(options: SubagentSettingsControllerOptions = {}) {
    this.limits = options.limits ?? NO_SCOPE
    this.modelSelection = options.modelSelection ?? NO_SCOPE
    this.loadCatalog = options.loadCatalog ?? (() => Promise.resolve({ ok: false, groups: [] }))
    this.loadPreferences = options.loadPreferences ?? (() => Promise.resolve(undefined))
    this.savePreferences = options.savePreferences ?? (() => Promise.resolve())
    this.unsubscribes.push(this.limits.subscribe(() => { this.publish() }))
    this.unsubscribes.push(this.modelSelection.subscribe(() => { this.publish() }))
    this.publish()
    void this.hydrate()
  }

  /** 停掉订阅与迟到的保存/目录答复。 */
  dispose(): void {
    this.disposed = true
    this.saveGeneration += 1
    this.catalogGeneration += 1
    for (const off of this.unsubscribes.splice(0)) {
      try {
        off()
      } catch {
        // 表单已经卸载：没有东西可撤。
      }
    }
  }

  /** 刷新模型目录（当适配器或设置文档在其他位置变更时调用）。 */
  refreshCatalog(): void {
    if (this.disposed) return
    void this.loadCatalogOnce()
  }

  /** 重连后重置连接态与目录。 */
  resetConnection(): void {
    if (this.disposed) return
    this.saveGeneration += 1
    this.saving = false
    this.clearDraft()
    this.catalogGroups = []
    void this.hydrate()
  }

  /**
   * 组装注入给渲染器的座位。
   * @returns 快照与全部动作。
   */
  inject(): SubagentSettingsInjected {
    return {
      store: this.store,
      editLimit: (field, text) => { this.editLimit(field, text) },
      resetLimit: (field) => { this.resetLimit(field) },
      toggleEnabled: () => { this.toggleEnabled() },
      toggleModel: (key) => { this.toggleModel(key) },
      setActiveTarget: (target) => { this.setActiveTarget(target) },
      resetActiveTarget: () => { this.resetActiveTarget() },
      retryCatalog: () => { void this.loadCatalogOnce() },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  /** 首屏：并行读偏好与目录。 */
  private async hydrate(): Promise<void> {
    this.preferencesStatus = 'loading'
    this.publish()
    const [preferences] = await Promise.all([this.loadPreferences(), this.loadCatalogOnce()])
    if (this.disposed) return
    if (preferences === undefined) {
      this.preferencesStatus = 'error'
    } else {
      this.preferences = preferences
      this.preferencesStatus = 'ready'
    }
    this.publish()
  }

  /** 拉一次目录（`refreshCatalog` 与「重试」共用）。 */
  private async loadCatalogOnce(): Promise<void> {
    if (this.disposed) return
    this.catalogGeneration += 1
    const generation = this.catalogGeneration
    this.catalogStatus = 'loading'
    this.catalogPartial = false
    this.publish()
    const answer = await this.loadCatalog()
    if (this.disposed || generation !== this.catalogGeneration) return
    if (answer.ok) {
      this.catalogGroups = normalizeCatalogGroups(answer.groups as readonly unknown[])
      this.catalogPartial = answer.partial === true
      this.catalogStatus = 'ready'
    } else {
      this.catalogGroups = []
      this.catalogStatus = 'error'
    }
    this.publish()
  }

  // ── 现值（宿主 + 偏好文档 + 向后兼容种子） ──────────────────────────────

  private currentEnabled(): boolean {
    return this.modelSelection.getSnapshot().value?.enabled === true
  }

  /**
   * 全局默认列表。
   *
   * 向后兼容种子：偏好文档里还没有这份列表（老版本、或从未保存过）时，把宿主
   * `allowedModels` 当作初始默认。
   */
  private currentDefault(): SubagentModelRoute[] {
    const stored = this.preferences?.subagentDefaultModels
    if (Array.isArray(stored) && stored.length > 0) return cloneRoutes(stored)
    const allowed = this.modelSelection.getSnapshot().value?.allowedModels
    if (Array.isArray(allowed) && allowed.length > 0) return cloneRoutes(allowed)
    return []
  }

  /** 每个主代理模型的专属列表（丢弃空数组与非法项）。 */
  private currentOverrides(): Record<string, SubagentModelRoute[]> {
    const raw = this.preferences?.subagentModelsByMainModel
    const out: Record<string, SubagentModelRoute[]> = {}
    if (raw === undefined || raw === null) return out
    for (const [key, value] of Object.entries(raw)) {
      if (!Array.isArray(value)) continue
      const cloned = cloneRoutes(value)
      if (cloned.length === 0) continue
      out[key] = cloned
    }
    return out
  }

  // ── 草稿派生 ────────────────────────────────────────────────────────────

  private enabled(): boolean {
    return this.draftEnabled ?? this.currentEnabled()
  }

  private defaultRoutes(): SubagentModelRoute[] {
    return cloneRoutes(this.draftDefault ?? this.currentDefault())
  }

  private overrides(): Record<string, SubagentModelRoute[]> {
    const source = this.draftOverrides ?? this.currentOverrides()
    const out: Record<string, SubagentModelRoute[]> = {}
    for (const [key, value] of Object.entries(source)) out[key] = cloneRoutes(value)
    return out
  }

  /** 当前目标生效的列表（专属列表优先，否则回落到全局默认）。 */
  private activeRoutes(): SubagentModelRoute[] {
    if (this.activeTarget === GLOBAL_TARGET) return this.defaultRoutes()
    const own = this.overrides()[this.activeTarget]
    return own === undefined ? this.defaultRoutes() : cloneRoutes(own)
  }

  private ensureDraft(): void {
    if (this.draftDefault !== undefined) return
    this.draftEnabled = this.currentEnabled()
    this.draftDefault = this.currentDefault()
    this.draftOverrides = this.currentOverrides()
    this.draftRevision = this.modelSelection.getSnapshot().revision
  }

  private clearDraft(): void {
    this.draftDepth = undefined
    this.draftDepthCleared = false
    this.draftActive = undefined
    this.draftActiveCleared = false
    this.draftEnabled = undefined
    this.draftDefault = undefined
    this.draftOverrides = undefined
    this.draftRevision = undefined
    this.failed = false
  }

  // ── 动作 ────────────────────────────────────────────────────────────────

  private editLimit(field: 'maxDepth' | 'maxActiveSubagents', text: string): void {
    if (this.saving) return
    if (field === 'maxDepth') {
      this.draftDepth = text
      this.draftDepthCleared = text.trim() === ''
    } else {
      this.draftActive = text
      this.draftActiveCleared = text.trim() === ''
    }
    this.failed = false
    this.publish()
  }

  private resetLimit(field: 'maxDepth' | 'maxActiveSubagents'): void {
    if (this.saving) return
    const snapshot = this.limits.getSnapshot()
    const base = snapshot.base
    const fallback = field === 'maxDepth'
      ? readNumber(base, 'maxDepth', 1)
      : readNumber(base, 'maxActiveSubagents', 8)
    if (field === 'maxDepth') {
      this.draftDepth = String(fallback)
      this.draftDepthCleared = true
    } else {
      this.draftActive = String(fallback)
      this.draftActiveCleared = true
    }
    this.failed = false
    this.publish()
  }

  private toggleEnabled(): void {
    const snapshot = this.modelSelection.getSnapshot()
    if (this.saving || snapshot.status !== 'ready' || !snapshot.writable) return
    this.ensureDraft()
    this.draftEnabled = !this.enabled()
    this.failed = false
    if (this.draftEnabled && this.catalogStatus === 'idle') void this.loadCatalogOnce()
    this.publish()
  }

  /**
   * 切换一条路由在当前目标下的勾选态。
   */
  private toggleModel(key: string): void {
    if (this.saving || !this.enabled()) return
    if (this.modelSelection.getSnapshot().status !== 'ready') return
    const route = this.candidates().find(candidate => candidate.key === key)
    if (route === undefined) return
    if (!route.provider || !route.model || route.provider === 'undefined' || route.model === 'undefined') return
    this.ensureDraft()
    const overrides = this.draftOverrides ?? this.currentOverrides()
    if (this.activeTarget === GLOBAL_TARGET) {
      const next = new Map((this.draftDefault ?? this.currentDefault()).map(item => [routeKey(item), item]))
      if (next.has(key)) next.delete(key)
      else next.set(key, { provider: route.provider, model: route.model })
      this.draftDefault = [...next.values()]
    } else {
      const base = overrides[this.activeTarget] ?? this.defaultRoutes()
      const next = new Map(base.map(item => [routeKey(item), item]))
      if (next.has(key)) next.delete(key)
      else next.set(key, { provider: route.provider, model: route.model })
      overrides[this.activeTarget] = [...next.values()]
      this.draftOverrides = overrides
    }
    this.failed = false
    this.publish()
  }

  private setActiveTarget(target: string): void {
    if (this.saving) return
    this.activeTarget = target === '' ? GLOBAL_TARGET : target
    this.publish()
  }

  /** 让当前目标恢复「跟随全局默认」：删掉它的专属列表。 */
  private resetActiveTarget(): void {
    if (this.saving || this.activeTarget === GLOBAL_TARGET) return
    this.ensureDraft()
    const overrides = this.draftOverrides ?? this.currentOverrides()
    delete overrides[this.activeTarget]
    this.draftOverrides = overrides
    this.failed = false
    this.publish()
  }

  private discard(): void {
    if (this.saving) return
    this.clearDraft()
    this.publish()
  }

  // ── 派生视图 ────────────────────────────────────────────────────────────

  /** 当前目标的候选行：目录 ∪ 已保存 ∪ 草稿里出现的每一条。 */
  private candidates(): SubagentModelCandidate[] {
    const selected = new Set(this.activeRoutes().map(routeKey))
    const retained = new Map<string, SubagentModelRoute>()
    for (const route of this.activeRoutes()) retained.set(routeKey(route), route)
    for (const route of this.currentDefault()) retained.set(routeKey(route), route)
    for (const list of Object.values(this.overrides())) {
      for (const route of list) retained.set(routeKey(route), route)
    }
    const rows: SubagentModelCandidate[] = []
    for (const group of this.catalogGroups) {
      if (!group.provider || group.provider === 'undefined') continue
      for (const model of group.models) {
        if (!model.id || model.id === 'undefined') continue
        const key = `${group.provider}/${model.id}`
        retained.delete(key)
        rows.push({
          provider: group.provider,
          model: model.id,
          key,
          providerName: group.providerName,
          modelName: model.name,
          available: true,
          selected: selected.has(key),
        })
      }
    }
    for (const [key, route] of retained) {
      if (!route.provider || !route.model || route.provider === 'undefined' || route.model === 'undefined') continue
      rows.push({
        provider: route.provider,
        model: route.model,
        key,
        providerName: route.provider,
        modelName: route.model,
        available: false,
        selected: selected.has(key),
      })
    }
    return rows
  }

  /** 主代理模型下拉的分组（目录分组 + 已保存但不可用的孤儿）。 */
  private mainModelGroups(): SubagentMainModelGroup[] {
    const overrides = this.overrides()
    const groups: SubagentMainModelGroup[] = []
    for (const group of this.catalogGroups) {
      if (!group.provider || group.provider === 'undefined') continue
      const models = group.models
        .filter(model => Boolean(model.id) && model.id !== 'undefined')
        .map(model => {
          const key = `${group.provider}/${model.id}`
          return { key, model: model.id, modelName: model.name, overridden: overrides[key] !== undefined }
        })
      if (models.length > 0) groups.push({ provider: group.provider, providerName: group.providerName, models })
    }
    return groups
  }

  /** 已保存但目录不公布的主代理模型键（下拉里单列一组）。 */
  private orphanMainModels(): string[] {
    const known = new Set<string>()
    for (const group of this.catalogGroups) {
      for (const model of group.models) known.add(`${group.provider}/${model.id}`)
    }
    return Object.keys(this.overrides()).filter(key => !known.has(key))
  }

  // ── 保存 ────────────────────────────────────────────────────────────────

  /**
   * 一次保存三份存储。
   */
  private async save(): Promise<void> {
    const state = this.store.getSnapshot()
    if (this.disposed || this.saving || !state.available || !state.writable || !state.dirty || state.invalid) return
    const desiredEnabled = this.enabled()
    const desiredDefault = this.defaultRoutes()
    const desiredOverrides = this.overrides()
    const generation = this.saveGeneration
    this.saving = true
    this.failed = false
    this.publish()
    try {
      // 1) 本插件偏好：默认列表 + 每个主代理模型的补丁（null = 删除该键）。
      const initial = this.currentOverrides()
      const patch: Record<string, SubagentModelRoute[] | null> = {}
      for (const key of new Set([...Object.keys(initial), ...Object.keys(desiredOverrides)])) {
        const list = desiredOverrides[key]
        patch[key] = list !== undefined && list.length > 0 ? cloneRoutes(list) : null
      }
      await this.savePreferences({
        subagentDefaultModels: cloneRoutes(desiredDefault),
        subagentModelsByMainModel: patch,
      })
      if (this.disposed || generation !== this.saveGeneration) return
      const nextOverrides: Record<string, SubagentModelRoute[] | null> = {}
      for (const [k, v] of Object.entries(desiredOverrides)) {
        if (v.length > 0) nextOverrides[k] = cloneRoutes(v)
      }
      this.preferences = {
        subagentDefaultModels: cloneRoutes(desiredDefault),
        subagentModelsByMainModel: nextOverrides,
      }
      this.preferencesStatus = 'ready'

      // 2) 宿主授权清单：两份列表的并集，去重保序。
      const union = new Map<string, SubagentModelRoute>()
      for (const route of desiredDefault) union.set(routeKey(route), { provider: route.provider, model: route.model })
      for (const list of Object.values(desiredOverrides)) {
        for (const route of list) union.set(routeKey(route), { provider: route.provider, model: route.model })
      }
      const unionRoutes = [...union.values()]
      const scope = this.modelSelection
      const modelSnapshot = scope.getSnapshot()
      const modelDirty = this.currentEnabled() !== desiredEnabled
        || !sameRouteSet(modelSnapshot.value?.allowedModels ?? [], unionRoutes)
      if (modelDirty && modelSnapshot.status === 'ready') {
        const ops: SubagentFormOp[] = [
          { op: 'set', path: ['enabled'], value: desiredEnabled },
          { op: 'set', path: ['allowedModels'], value: unionRoutes },
        ]
        if (typeof scope.mutate === 'function') {
          const accepted = await scope.mutate(ops, modelSnapshot.revision ?? this.draftRevision)
          if (accepted === false) throw new Error('The deployment rejected the subagent model selection settings.')
        } else if (typeof scope.set === 'function') {
          const ok1 = await scope.set('enabled', desiredEnabled)
          const ok2 = await scope.set('allowedModels', unionRoutes)
          if (ok1 === false || ok2 === false) throw new Error('The deployment rejected the subagent model selection settings.')
        }
      }

      // 3) 运行限制（只有真的改过才写）。
      if (state.maxDepth.invalid || state.maxActiveSubagents.invalid) throw new Error('invalid limits')
      const limitsSnapshot = this.limits.getSnapshot()
      const limitsOps: SubagentFormOp[] = []
      if (this.draftDepthCleared) {
        if (userHas(limitsSnapshot.user, 'maxDepth')) {
          limitsOps.push({ op: 'unset', path: ['maxDepth'] })
        }
      } else if (this.draftDepth !== undefined) {
        const nextDepth = parseLimit(this.draftDepth, 0)
        if (nextDepth !== undefined && nextDepth !== readNumber(limitsSnapshot.value, 'maxDepth', nextDepth)) {
          limitsOps.push({ op: 'set', path: ['maxDepth'], value: nextDepth })
        }
      }
      if (this.draftActiveCleared) {
        if (userHas(limitsSnapshot.user, 'maxActiveSubagents')) {
          limitsOps.push({ op: 'unset', path: ['maxActiveSubagents'] })
        }
      } else if (this.draftActive !== undefined) {
        const nextActive = parseLimit(this.draftActive, 1)
        if (nextActive !== undefined && nextActive !== readNumber(limitsSnapshot.value, 'maxActiveSubagents', nextActive)) {
          limitsOps.push({ op: 'set', path: ['maxActiveSubagents'], value: nextActive })
        }
      }
      if (limitsOps.length > 0 && limitsSnapshot.status === 'ready') {
        if (typeof this.limits.mutate === 'function') {
          const accepted = await this.limits.mutate(limitsOps, limitsSnapshot.revision)
          if (accepted === false) throw new Error('The deployment rejected the subagent limits.')
        } else if (typeof this.limits.set === 'function') {
          for (const op of limitsOps) {
            if (op.op === 'set') await this.limits.set(op.path[0]!, op.value)
          }
        }
      }

      if (this.disposed || generation !== this.saveGeneration) return
      this.saving = false
      this.clearDraft()
      this.publish()
    } catch {
      if (this.disposed || generation !== this.saveGeneration) return
      this.saving = false
      this.failed = true
      this.publish()
    }
  }

  // ── 投影 ────────────────────────────────────────────────────────────────

  private limitField(
    field: 'maxDepth' | 'maxActiveSubagents',
    minimum: number,
    fallback: number,
  ): SubagentLimitField {
    const snapshot = this.limits.getSnapshot()
    const base = readNumber(snapshot.base, field, readNumber(snapshot.value, field, fallback))
    const current = readNumber(snapshot.value, field, fallback)
    const draft = field === 'maxDepth' ? this.draftDepth : this.draftActive
    const cleared = field === 'maxDepth' ? this.draftDepthCleared : this.draftActiveCleared
    const text = cleared ? String(base) : (draft ?? String(current))
    const persistedOverridden = userHas(snapshot.user, field) || base !== current
    const overridden = cleared
      ? false
      : (draft !== undefined ? text.trim() !== '' && text.trim() !== String(base) : persistedOverridden)
    const invalid = cleared ? false : parseLimit(text, minimum) === undefined
    return {
      value: text,
      base: String(base),
      overridden,
      invalid,
    }
  }

  private projection(): SubagentSettingsState {
    const limitsSnapshot = this.limits.getSnapshot()
    const modelSnapshot = this.modelSelection.getSnapshot()
    const limitsAvailable = limitsSnapshot.status === 'ready'
    const modelsAvailable = modelSnapshot.status === 'ready'
    const maxDepth = this.limitField('maxDepth', 0, 1)
    const maxActive = this.limitField('maxActiveSubagents', 1, 8)
    const enabled = this.enabled()
    const desiredDefault = this.defaultRoutes()
    const desiredOverrides = this.overrides()
    const currentOverrides = this.currentOverrides()
    const currentDefault = this.currentDefault()

    const union = new Map<string, SubagentModelRoute>()
    for (const route of desiredDefault) union.set(routeKey(route), route)
    for (const list of Object.values(desiredOverrides)) {
      for (const route of list) union.set(routeKey(route), route)
    }
    const hostAllowed = cloneRoutes(modelSnapshot.value?.allowedModels ?? [])
    const modelsDirty = this.currentEnabled() !== enabled
      || !sameRouteSet(currentDefault, desiredDefault)
      || !sameOverrides(currentOverrides, desiredOverrides)
      || (this.draftDefault !== undefined && !sameRouteSet(hostAllowed, [...union.values()]))

    const depthPersistedOverridden = userHas(limitsSnapshot.user, 'maxDepth')
    const activePersistedOverridden = userHas(limitsSnapshot.user, 'maxActiveSubagents')
    const depthDirty = this.draftDepthCleared
      ? depthPersistedOverridden
      : (this.draftDepth !== undefined && maxDepth.value !== String(readNumber(limitsSnapshot.value, 'maxDepth', 1)))
    const activeDirty = this.draftActiveCleared
      ? activePersistedOverridden
      : (this.draftActive !== undefined && maxActive.value !== String(readNumber(limitsSnapshot.value, 'maxActiveSubagents', 8)))
    const limitsDirty = depthDirty || activeDirty

    // 空清单只在「开关是开的」时才算不合法：关着的时候清单本来就不生效。
    const emptyOverride = Object.values(desiredOverrides).some(list => list.length === 0)
    const invalid = maxDepth.invalid || maxActive.invalid
      || (enabled && (desiredDefault.length === 0 || emptyOverride))

    const activeOverridden = this.activeTarget !== GLOBAL_TARGET && desiredOverrides[this.activeTarget] !== undefined
    return {
      available: limitsAvailable || modelsAvailable,
      writable: (limitsAvailable ? limitsSnapshot.writable : true) && (modelsAvailable ? modelSnapshot.writable : true),
      dirty: limitsDirty || modelsDirty,
      invalid,
      saving: this.saving,
      failed: this.failed,
      maxDepth,
      maxActiveSubagents: maxActive,
      enabled,
      activeTarget: this.activeTarget,
      defaultCount: desiredDefault.length,
      overridesByMainModel: desiredOverrides,
      mainModelGroups: this.mainModelGroups(),
      orphanMainModels: this.orphanMainModels(),
      catalogStatus: this.catalogStatus,
      catalogPartial: this.catalogPartial,
      candidates: this.candidates(),
      activeTargetOverridden: activeOverridden,
      activeTargetCount: this.activeRoutes().length,
      preferencesStatus: this.preferencesStatus,
    }
  }

  private publish(): void {
    if (this.disposed) return
    this.store.setState(this.projection())
  }
}
