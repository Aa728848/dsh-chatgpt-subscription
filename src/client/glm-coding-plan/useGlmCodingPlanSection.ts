/**
 * GLM（ZCode 账号）设置卡片的状态、副作用与动作。
 *
 * 与 WorkBuddy / MiniMax Code 同样的分工：这个文件是行为，GlmCodingPlanSection.tsx
 * 是渲染，两者之间只通过下面这一个具名结构交接，卡片因此保持「只画」的状态。
 *
 * 一条设计约束贯穿全文件：**能力与文案都不在本文件重算**。模型行的一句话描述来自
 * 契约里的 GlmModelOption.hint（host 由随包目录生成），配额窗口名由共享配额条按
 * windowDurationMins 本地化；客户端一旦自己推断能力，就等于把「能力不得从模型名推断」
 * 这条规则（计划 §7）重新打开。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountRotationStrategy } from '../../shared/account-pool-contracts.ts'
import {
  isGlmRegion,
  type GlmAccountSummaryDto,
  type GlmAdoptResultDto,
  type GlmConnectionDto,
  type GlmLoginFlowStatus,
  type GlmModelOption,
  type GlmQuotaSnapshotDto,
  type GlmRegion,
  type GlmStatusDto,
} from '../../shared/glm-coding-plan-contracts.ts'
import type { AccountPoolLabels } from '../common/AccountPoolSection.tsx'
import { contextDraftsFor } from '../common/ContextWindowEditor.tsx'
import { formatCapacity, parsePositiveCapacity } from '../common/format.ts'
import { createQuotaFollowUp, type QuotaFollowUp } from '../common/quota-follow-up.ts'
import { get, messageOf, post } from './api.ts'
import { zh } from './locales.ts'

/** 登录状态机的轮询节奏。真实超时与间隔由 host 拥有，卡片只是跟随。 */
const LOGIN_POLL_INTERVAL_MS = 2_000

/** 卡片渲染的键。与兄弟卡片一样用自己的字典，不复用 hub 挂在 settings.section 上的座位。 */
export type Translate = (key: keyof typeof zh) => string

/** 本卡片的字典；身份稳定，依赖它的 effect 才不会每次渲染重建。 */
export const fallbackTranslate: Translate = (key) => zh[key]

/**
 * 共享账号池卡片需要的标签集，按本卡片的字典逐键查出来。
 *
 * 从共享 ZH 标签对象自身的键推导，因此共享卡片新增一个标签而这里漏掉时
 * 是编译错误，而不是页面上少一句话。
 */
function accountPoolLabelsFor(t: Translate): AccountPoolLabels {
  return {
    accountPool: t('accountPool'),
    addAccount: t('addAccount'),
    accountCount: t('accountCount'),
    primaryAccount: t('primaryAccount'),
    activeAccount: t('activeAccount'),
    setPrimary: t('setPrimary'),
    deleteAccount: t('deleteAccount'),
    cooling: t('cooling'),
    cooldownLeft: t('cooldownLeft'),
    cooldownRemaining: t('cooldownRemaining'),
    cooldownRemainingSeconds: t('cooldownRemainingSeconds'),
    modelCooldown: t('modelCooldown'),
    clearCooldown: t('clearCooldown'),
    needsRelogin: t('needsRelogin'),
    relogin: t('relogin'),
    rotationStrategy: t('rotationStrategy'),
    strategySequential: t('strategySequential'),
    strategyRoundRobin: t('strategyRoundRobin'),
    strategySticky: t('strategySticky'),
    noAccounts: t('noAccounts'),
    email: t('email'),
    expires: t('expires'),
    lastUsed: t('lastUsed'),
    accountId: t('accountId'),
    accountQuota: t('accountQuota'),
    quotaNone: t('quotaNone'),
    quotaSnapshot: t('quotaSnapshot'),
    quotaResets: t('quotaResets'),
    quotaExhausted: t('quotaExhausted'),
    quotaWindow: t('quotaWindow'),
    quotaUsed: t('quotaUsed'),
    quotaFactsScope: t('quotaFactsScope'),
    composerLabel: t('composerLabel'),
  }
}

/**
 * host 下发的号池行 → 契约里带区域的那一行。
 *
 * 冻结契约写的是 `accounts?: PoolAccountSummaryDto[]`（GlmStatusDto 继承的是
 * Partial<AccountPoolStatusDto>），元素类型是最小的 PoolAccountSummaryDto，
 * GlmAccountSummaryDto 是它的**扩展**而不是它的元素类型；契约已冻结，所以这里在
 * 客户端补齐：region 等 host 确实下发的字段原样取，只有缺失时才回落到当前区域。
 */
function glmAccounts(status: GlmStatusDto | null): GlmAccountSummaryDto[] {
  const fallback = status?.region ?? 'cn'
  type Extra = Partial<Pick<GlmAccountSummaryDto, 'region' | 'organizationId' | 'accountName'>>
  return (status?.accounts ?? []).map((account) => {
    const extra = account as typeof account & Extra
    return {
      ...account,
      region: isGlmRegion(extra.region) ? extra.region : fallback,
      ...(extra.organizationId === undefined ? {} : { organizationId: extra.organizationId }),
      ...(extra.accountName === undefined ? {} : { accountName: extra.accountName }),
    }
  })
}
export interface GlmCodingPlanSectionProps {
  onModelChange?: () => void
}

/** 账号卡片上的一个动作。 */
export type GlmAccountAction = 'set-primary' | 'delete' | 'clear-cooldown' | 'relogin'

/** 视图可以消费的全部内容，按「会变的事实 / 从答案派生的 / 能触发的」分组。 */
export interface GlmCodingPlanSectionView {
  state: {
    status: GlmStatusDto | null
    loading: boolean
    busy: string | null
    error: string | null
    connection: GlmConnectionDto | null
    adoptResult: GlmAdoptResultDto | null
    pasteValue: string
    /** 「导入」与「手工粘贴」按哪个区域发起；两个登录按钮各自固定区域，不读它。 */
    region: GlmRegion
    /** 手工粘贴兜底是否展开（没有进行中的流程时默认收起）。 */
    pasteOpen: boolean
    contextDrafts: Record<string, string>
    savingModel: string | null
  }
  derived: {
    accounts: GlmAccountSummaryDto[]
    models: GlmModelOption[]
    /** 上下文窗口编辑器的行：只有勾选了的模型才有可覆盖的窗口。 */
    contextModels: GlmModelOption[]
    overrideCount: number
    login: GlmLoginFlowStatus | null
    quota: GlmQuotaSnapshotDto | null
    authenticated: boolean
    poolLabels: AccountPoolLabels
  }
  actions: {
    setRegion(region: GlmRegion): void
    login(region: GlmRegion): Promise<void>
    cancelLogin(): Promise<void>
    submitPaste(): Promise<void>
    setPasteValue(value: string): void
    togglePaste(): void
    adopt(): Promise<void>
    clearAdoptResult(): void
    accountAction(action: GlmAccountAction, accountId: string): Promise<void>
    setStrategy(strategy: AccountRotationStrategy): Promise<void>
    toggleModel(modelId: string, enabled: boolean): void
    setAllModels(enabled: boolean): void
    saveContextWindow(modelId: string): Promise<void>
    resetContextWindow(modelId: string): Promise<void>
    resetAllContextWindows(): Promise<void>
    updateContextDraft(modelId: string, draft: string): void
    refreshQuota(): Promise<void>
    refreshCatalog(): Promise<void>
    testConnection(): Promise<void>
  }
}

export function useGlmCodingPlanSection({ onModelChange }: GlmCodingPlanSectionProps = {}): GlmCodingPlanSectionView {
  const t: Translate = fallbackTranslate
  const [status, setStatus] = useState<GlmStatusDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connection, setConnection] = useState<GlmConnectionDto | null>(null)
  const [adoptResult, setAdoptResult] = useState<GlmAdoptResultDto | null>(null)
  const [pasteValue, setPasteValue] = useState('')
  // 手工粘贴兜底的展开态。功能不删（回调被拦时它是唯一出路），只是没有进行中
  // 的流程时不再常年占版面；流程一开始（pending / error）自动展开，结束后自动收起。
  const [pasteOpen, setPasteOpen] = useState(false)
  const [region, setRegionState] = useState<GlmRegion>('cn')
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [savingModel, setSavingModel] = useState<string | null>(null)

  // 用户是否亲手选过区域。没选过时跟随 host 下发的 status.region，选过之后
  // 不再被 60 秒一次的静默刷新改回去。
  const regionTouched = useRef(false)
  // 上游在应答背后刷新配额时的补读，一次只挂一个。
  const quotaFollowUp = useRef<QuotaFollowUp | undefined>(undefined)

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setError(null)
    try {
      const next = await get<GlmStatusDto>('/status')
      setStatus(next)
      setContextDrafts(contextDraftsFor(next))
      if (!regionTouched.current) setRegionState(next.region)
      quotaFollowUp.current ??= createQuotaFollowUp()
      quotaFollowUp.current.observe(next.quotaRefreshing === true, () => { void loadStatus(true) })
    } catch (cause) {
      if (!quiet) setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') void loadStatus(true)
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    const timer = window.setInterval(refreshWhenVisible, 60_000)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      quotaFollowUp.current?.cancel()
    }
  }, [loadStatus])

  // 浏览器授权不是卡片能控制的东西，流程跑在 host 上，卡片只跟随。
  // 'complete' / 'error' 由这次轮询读到后由 loadStatus 带来的新状态接管。
  const loginStatus = status?.login?.status
  useEffect(() => {
    if (loginStatus !== 'pending') return
    let stopped = false
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const poll = await get<GlmLoginFlowStatus>('/login/status')
          if (stopped) return
          if (poll.status === 'complete') {
            setPasteValue('')
            await loadStatus()
            onModelChange?.()
          } else if (poll.status === 'error') {
            setError(poll.error ?? t('loginError'))
          }
        } catch {
          // 轮询失败是暂时性的：5xx 与畸形应答都按 pending 处理，下一拍重试。
        }
      })()
    }, LOGIN_POLL_INTERVAL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [loginStatus, loadStatus, onModelChange, t])

  const setRegion = useCallback((next: GlmRegion) => {
    regionTouched.current = true
    setRegionState(next)
  }, [])

  // 兜底框跟着登录流程的阶段走，而不是跟着「这一页渲染了多久」：
  // pending / error 是用户最需要一个手动出口的两个阶段（此刻才真的能生效），
  // idle / complete 时上游会话已经结束，粘贴不会被接受，收起来更诚实。
  useEffect(() => {
    setPasteOpen(loginStatus === 'pending' || loginStatus === 'error')
  }, [loginStatus])

  const login = async (loginRegion: GlmRegion): Promise<void> => {
    try {
      setBusy(`login:${loginRegion}`)
      setError(null)
      setConnection(null)
      setPasteValue('')
      const flow = await post<GlmLoginFlowStatus>('/login/start', { region: loginRegion })
      await loadStatus(true)
      // 卡片是唯一打开浏览器的地方；弹窗被拦下也不要紧，下面渲染的就是同一个链接。
      if (flow.authorizeUrl !== undefined && flow.authorizeUrl !== '') {
        try {
          window.open(flow.authorizeUrl, '_blank', 'noopener,noreferrer')
        } catch {
          // 无 window.open 的宿主（如某些内嵌壳）忽略即可，链接仍然可点。
        }
      }
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const cancelLogin = async (): Promise<void> => {
    try {
      setBusy('login:cancel')
      setError(null)
      await post<GlmLoginFlowStatus>('/login/cancel', { region })
      await loadStatus(true)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const submitPaste = async (): Promise<void> => {
    if (pasteValue.trim() === '') {
      setError(t('manualPasteEmpty'))
      return
    }
    try {
      setBusy('login-manual')
      setError(null)
      // 这条路由回的是整份 status：兑换成功会写入凭据，账号卡、模型与配额
      // 在返回时就已经过期了（请求体带凭据，刻意不进冻结契约）。
      setStatus(await post<GlmStatusDto>('/login/manual', { region, code: pasteValue.trim() }))
      setPasteValue('')
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const adopt = async (): Promise<void> => {
    try {
      setBusy('adopt')
      setError(null)
      const result = await post<GlmAdoptResultDto>('/adopt', { region })
      setAdoptResult(result)
      // adopt 只省一次登录：成功与否都要重新读状态，让账号卡与模型立刻反映真实凭据。
      await loadStatus(true)
      if (result.adopted) onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const accountAction = async (action: GlmAccountAction, accountId: string): Promise<void> => {
    try {
      setBusy(`account:${action}:${accountId}`)
      setError(null)
      setStatus(await post<GlmStatusDto>('/accounts', { action, accountId }))
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const setStrategy = async (strategy: AccountRotationStrategy): Promise<void> => {
    try {
      setBusy('strategy')
      setError(null)
      setStatus(await post<GlmStatusDto>('/accounts', { action: 'strategy', strategy }))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  /** 一个模型勾选补丁；host 回整份新状态，卡片因此不必猜哪些 id 最终生效。 */
  const applyEnabledModels = async (enabledModelIds: string[]): Promise<void> => {
    try {
      setError(null)
      const updated = await post<GlmStatusDto>('/settings', { enabledModelIds })
      setStatus(updated)
      // 刚勾上的模型还没有草稿，而上下文窗口区只渲染勾选了的模型。
      setContextDrafts(contextDraftsFor(updated))
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const toggleModel = (modelId: string, enabled: boolean): void => {
    if (status === null) return
    const current = status.models.filter((model) => model.enabled).map((model) => model.id)
    const next = enabled ? [...new Set([...current, modelId])] : current.filter((id) => id !== modelId)
    void applyEnabledModels(next)
  }

  const setAllModels = (enabled: boolean): void => {
    if (status === null || status.models.length === 0) return
    void applyEnabledModels(enabled ? status.models.map((model) => model.id) : [])
  }

  const saveContextWindow = async (modelId: string): Promise<void> => {
    const raw = contextDrafts[modelId] ?? ''
    const parsed = parsePositiveCapacity(raw)
    if (parsed === null) {
      setError(t('invalidCapacity').replace('{value}', raw))
      return
    }
    try {
      setSavingModel(modelId)
      setError(null)
      setStatus(await post<GlmStatusDto>('/settings', { contextWindowOverrides: { [modelId]: parsed } }))
      setContextDrafts((previous) => ({ ...previous, [modelId]: formatCapacity(parsed) }))
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSavingModel(null)
    }
  }

  const resetContextWindow = async (modelId: string): Promise<void> => {
    try {
      setSavingModel(modelId)
      setError(null)
      // null 是「删掉这条覆盖」的线上写法，host 删键后目录默认值重新生效。
      const updated = await post<GlmStatusDto>('/settings', { contextWindowOverrides: { [modelId]: null } })
      setStatus(updated)
      const model = updated.models.find((entry) => entry.id === modelId)
      if (model !== undefined) {
        setContextDrafts((previous) => ({ ...previous, [modelId]: formatCapacity(model.defaultContextWindow) }))
      }
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSavingModel(null)
    }
  }

  const resetAllContextWindows = async (): Promise<void> => {
    const ids = Object.keys(status?.contextWindowOverrides ?? {})
    if (ids.length === 0) return
    try {
      setError(null)
      const updated = await post<GlmStatusDto>('/settings', {
        contextWindowOverrides: Object.fromEntries(ids.map((id) => [id, null])),
      })
      setStatus(updated)
      setContextDrafts(contextDraftsFor(updated))
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const refreshQuota = async (): Promise<void> => {
    try {
      setBusy('quota')
      setError(null)
      setStatus(await post<GlmStatusDto>('/quota', {}))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const refreshCatalog = async (): Promise<void> => {
    try {
      setBusy('catalog')
      setError(null)
      setStatus(await post<GlmStatusDto>('/catalog/refresh', {}))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const testConnection = async (): Promise<void> => {
    try {
      setBusy('connection')
      setError(null)
      setConnection(await post<GlmConnectionDto>('/connection/test', {}))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const accounts = glmAccounts(status)
  const models = status?.models ?? []
  // 未勾选的模型不会被提供给会话，为它准备上下文窗口设置只是死设置。
  const contextModels = models.filter((model) => model.enabled)

  return {
    state: {
      status,
      loading,
      busy,
      error,
      connection,
      adoptResult,
      pasteValue,
      region,
      pasteOpen,
      contextDrafts,
      savingModel,
    },
    derived: {
      accounts,
      models,
      contextModels,
      overrideCount: Object.keys(status?.contextWindowOverrides ?? {}).length,
      login: status?.login ?? null,
      quota: status?.quota ?? null,
      authenticated: status?.authenticated === true,
      poolLabels: accountPoolLabelsFor(t),
    },
    actions: {
      setRegion,
      login,
      cancelLogin,
      submitPaste,
      setPasteValue,
      togglePaste: () => setPasteOpen((previous) => !previous),
      adopt,
      clearAdoptResult: () => setAdoptResult(null),
      accountAction,
      setStrategy,
      toggleModel,
      setAllModels,
      saveContextWindow,
      resetContextWindow,
      resetAllContextWindows,
      updateContextDraft: (modelId: string, draft: string) => {
        setContextDrafts((previous) => ({ ...previous, [modelId]: draft }))
      },
      refreshQuota,
      refreshCatalog,
      testConnection,
    },
  }
}
