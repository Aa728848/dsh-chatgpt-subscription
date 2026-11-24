import { CODEX_CHATGPT_PROVIDER_ID } from '../../../compat.ts'
import type { AntigravityAcpStatusDto } from '../../../shared/antigravity-acp-contracts.ts'
import type { ClaudeWebStatus } from '../../../shared/claude-contracts.ts'
import type { ClinePassWebStatus } from '../../../shared/cline-pass-contracts.ts'
import type { CommandCodeWebStatus } from '../../../shared/command-code-contracts.ts'
import type { PluginStatusDto } from '../../../shared/contracts.ts'
import { GLM_CODING_PLAN_PROVIDER_ID, type GlmStatusDto } from '../../../shared/glm-coding-plan-contracts.ts'
import type { KimiCodeWebStatus } from '../../../shared/kimi-code-contracts.ts'
import type { MinimaxCodeWebStatus } from '../../../shared/minimax-code-contracts.ts'
import type { OpenDesignWebStatus } from '../../../shared/opendesign-contracts.ts'
import { QIANWEN_TOKEN_PLAN_PROVIDER_ID, type QianwenStatusDto } from '../../../shared/qianwen-token-plan-contracts.ts'
import { QODER_PROVIDER_ID, type QoderStatusDto } from '../../../shared/qoder-contracts.ts'
import { RELAYONE_PROVIDER_ID, type RelayOneStatusDto } from '../../../shared/relayone-contracts.ts'
import { STEP_CODE_PROVIDER_ID, type StepCodeStatusDto } from '../../../shared/step-code-contracts.ts'
import type { WorkBuddyWebStatus } from '../../../shared/workbuddy-contracts.ts'
import { quotaLevel } from '../../common/ComposerQuotaBadge.tsx'
import { formatPercent } from '../../common/format.ts'
import { createLineApi } from '../../common/line-api.ts'
import { AntigravityAcpApi } from '../../providers/antigravity-acp/api.ts'
import { PROVIDER_ROUTE_ID as ANTIGRAVITY_PROVIDER_ID } from '../../providers/antigravity-acp/route.ts'
import { ClinePassApi } from '../../providers/cline-pass/api.ts'
import { SubscriptionApi } from '../../providers/codex-chatgpt/api.ts'
import { quotaWindows } from '../../providers/codex-chatgpt/quota.ts'
import * as glmApi from '../../providers/glm-coding-plan/api.ts'
import { QUOTA_WINDOW_MINUTES as GLM_WINDOW_MINUTES } from '../../providers/glm-coding-plan/locales.ts'
import { OpenDesignApi } from '../../providers/opendesign/api.ts'
import * as qianwenApi from '../../providers/qianwen-token-plan/api.ts'
import { qianwenCacheHitRatio } from '../../providers/qianwen-token-plan/useQianwenSection.ts'
import * as qoderApi from '../../providers/qoder/api.ts'
import * as relayOneApi from '../../providers/relayone/api.ts'
import { relayOneQuotaAmount, relayOneQuotaIsUnlimited, relayOneQuotaText } from '../../providers/relayone/quota-format.ts'
import * as stepCodeApi from '../../providers/step-code/api.ts'
import { QUOTA_WINDOW_MINUTES as STEP_WINDOW_MINUTES } from '../../providers/step-code/locales.ts'
import {
  clampPercent,
  formatResetCountdown,
  formatWindowDurationLabel,
  type QuotaBarItem,
  type QuotaFactItem,
  type SessionQuotaDict,
  type SessionQuotaSnapshot,
} from './model.ts'

export interface SessionQuotaAdapter<Status = unknown> {
  providerId: string
  readStatus(refresh: boolean): Promise<Status>
  toSnapshot(
    status: Status,
    modelId: string | undefined,
    dict: SessionQuotaDict,
    nowMs?: number,
  ): SessionQuotaSnapshot | null
}

const codexApi = new SubscriptionApi()
const claudeApi = createLineApi('/claude/api', 'Claude')
const kimiApi = createLineApi('/kimi-code/api', 'Kimi Code')
const minimaxApi = createLineApi('/minimax-code/api', 'MiniMax Code')
const commandCodeApi = createLineApi('/command-code/api', 'Command Code')
const workBuddyApi = createLineApi('/workbuddy/api', 'WorkBuddy')
const clinePassApi = new ClinePassApi()
const openDesignApi = new OpenDesignApi()
const antigravityApi = new AntigravityAcpApi()

function compactTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1_000) return String(Math.floor(value))
  if (value < 1_000_000) return (value / 1_000).toFixed(value < 10_000 ? 1 : 0) + 'K'
  return (value / 1_000_000).toFixed(1) + 'M'
}

function summarizeBars(bars: readonly QuotaBarItem[]): {
  summaryText: string
  summaryLevel: SessionQuotaSnapshot['summaryLevel']
  summaryPercent: number
} {
  const tightest = bars.reduce((best, current) =>
    current.remainingPercent < best.remainingPercent ? current : best)
  const rounded = Math.round(tightest.remainingPercent)
  return {
    summaryText: `${rounded}%`,
    summaryLevel: tightest.level,
    summaryPercent: rounded,
  }
}

export function codexToSnapshot(
  status: PluginStatusDto,
  modelId: string | undefined,
  dict: SessionQuotaDict,
  nowMs?: number,
): SessionQuotaSnapshot | null {
  if (status.preferences?.quickQuotaVisible === false) return null
  const quota = status.quota
  if (quota === undefined || quota.buckets.length === 0) return null
  const model = modelId?.toLowerCase() ?? ''
  const wantsSpark = model.includes('spark')
  const bucket = wantsSpark
    ? quota.buckets.find((c) => `${c.id} ${c.name}`.toLowerCase().includes('spark'))
    : quota.buckets.find((c) => c.id === 'codex')
      ?? quota.buckets.find((c) => c.name.toLowerCase() === 'codex')
      ?? quota.buckets[0]
  if (bucket === undefined) return null

  const windows = [...quotaWindows(bucket)].sort(
    (a, b) => (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity),
  )
  const bars: QuotaBarItem[] = windows.map((win, index) => {
    const remaining = clampPercent(100 - win.usedPercent)
    return {
      key: `${bucket.id}-${win.windowDurationMins ?? index}`,
      label: formatWindowDurationLabel(win.windowDurationMins, `#${index + 1}`, dict),
      remainingPercent: remaining,
      resetText: formatResetCountdown(win.resetsAt, dict, nowMs),
      level: quotaLevel(remaining),
    }
  })

  const facts: QuotaFactItem[] = []
  if (quota.credits?.unlimited) {
    facts.push({ key: 'credits', label: dict.credits, value: dict.unlimited })
  } else if (quota.credits?.balance) {
    facts.push({ key: 'credits', label: dict.credits, value: quota.credits.balance })
  }
  if (quota.resetCredits && quota.resetCredits.availableCount > 0) {
    facts.push({ key: 'reset-credits', label: dict.resetCredits, value: String(quota.resetCredits.availableCount) })
  }
  if (bars.length === 0 && facts.length === 0) return null

  const summary = bars.length > 0
    ? summarizeBars(bars)
    : { summaryText: facts[0]!.value, summaryLevel: 'normal' as const, summaryPercent: null }

  return {
    providerId: CODEX_CHATGPT_PROVIDER_ID,
    providerName: 'Codex',
    planBadge: bucket.planType ?? undefined,
    ...summary,
    bars,
    facts,
  }
}

export function claudeToSnapshot(
  status: ClaudeWebStatus,
  _modelId: string | undefined,
  dict: SessionQuotaDict,
  nowMs?: number,
): SessionQuotaSnapshot | null {
  if (!status.authenticated || status.quota === null || status.quota === undefined) return null
  const bars: QuotaBarItem[] = []
  for (const win of status.quota.windows) {
    const remaining = win.remainingPercent
      ?? (win.usedPercent === null ? null : 100 - win.usedPercent)
    if (remaining === null || !Number.isFinite(remaining)) continue
    const clamped = clampPercent(remaining)
    bars.push({
      key: win.id,
      label: formatWindowDurationLabel(win.windowMinutes, win.label, dict),
      remainingPercent: clamped,
      resetText: formatResetCountdown(win.resetsAt, dict, nowMs),
      level: quotaLevel(clamped),
    })
  }
  if (bars.length === 0) return null
  return {
    providerId: 'claude-subscription',
    providerName: 'Claude',
    planBadge: status.account?.subscriptionType ?? undefined,
    ...summarizeBars(bars),
    bars,
    facts: [],
  }
}

export function kimiToSnapshot(
  status: KimiCodeWebStatus,
  _modelId: string | undefined,
  dict: SessionQuotaDict,
  nowMs?: number,
): SessionQuotaSnapshot | null {
  if (!status.authenticated || status.quota === null || status.quota === undefined) return null
  const sorted = [...(status.quota.windows ?? [])].sort(
    (a, b) => (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity),
  )
  const bars: QuotaBarItem[] = sorted.map((win) => {
    const remaining = clampPercent(100 - win.usedPercent)
    return {
      key: win.id,
      label: formatWindowDurationLabel(win.windowDurationMins, win.label, dict),
      remainingPercent: remaining,
      resetText: formatResetCountdown(win.resetsAt, dict, nowMs),
      level: quotaLevel(remaining),
    }
  })
  const facts: QuotaFactItem[] = []
  const wallet = status.quota.extraUsage
  if (wallet !== null && wallet !== undefined && wallet.balanceCents !== null) {
    const amount = `${(wallet.balanceCents / 100).toFixed(2)} ${wallet.currency ?? ''}`.trim()
    facts.push({ key: 'wallet', label: dict.balance, value: amount })
  }
  if (bars.length === 0 && facts.length === 0) return null
  const summary = bars.length > 0
    ? summarizeBars(bars)
    : { summaryText: facts[0]!.value, summaryLevel: 'normal' as const, summaryPercent: null }
  return {
    providerId: 'kimi-code',
    providerName: 'Kimi Code',
    planBadge: status.quota.planName ?? undefined,
    ...summary,
    bars,
    facts,
  }
}

export function minimaxToSnapshot(
  status: MinimaxCodeWebStatus,
  _modelId: string | undefined,
  dict: SessionQuotaDict,
  nowMs?: number,
): SessionQuotaSnapshot | null {
  if (!status.authenticated || status.quota === undefined) return null
  const quota = status.quota
  const bars: QuotaBarItem[] = []
  const facts: QuotaFactItem[] = []
  if (quota.usedPercent !== undefined && Number.isFinite(quota.usedPercent)) {
    const remaining = clampPercent(100 - quota.usedPercent)
    bars.push({
      key: 'minimax-main',
      label: quota.label,
      remainingPercent: remaining,
      resetText: formatResetCountdown(quota.resetsAtMs, dict, nowMs),
      level: quotaLevel(remaining),
    })
  } else if (quota.label) {
    facts.push({ key: 'plan', label: dict.planTier, value: quota.label })
  }
  if (bars.length === 0 && facts.length === 0) return null
  const summary = bars.length > 0
    ? summarizeBars(bars)
    : { summaryText: facts[0]!.value, summaryLevel: 'normal' as const, summaryPercent: null }
  return {
    providerId: 'minimax-code',
    providerName: 'MiniMax Code',
    ...summary,
    bars,
    facts,
  }
}

export function commandCodeToSnapshot(
  status: CommandCodeWebStatus,
  _modelId: string | undefined,
  dict: SessionQuotaDict,
  nowMs?: number,
): SessionQuotaSnapshot | null {
  if (!status.authenticated || status.quota === null || status.quota === undefined) return null
  const quota = status.quota
  const sorted = [...(quota.windows ?? [])].sort(
    (a, b) => (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity),
  )
  const bars: QuotaBarItem[] = sorted.map((win) => {
    const remaining = clampPercent(100 - win.usedPercent)
    return {
      key: win.id,
      label: formatWindowDurationLabel(win.windowDurationMins, win.label, dict),
      remainingPercent: remaining,
      resetText: formatResetCountdown(win.resetsAt, dict, nowMs),
      level: quotaLevel(remaining),
    }
  })
  if (bars.length === 0) {
    for (const meter of quota.meters ?? []) {
      if (meter.remainingFraction === null || !Number.isFinite(meter.remainingFraction)) continue
      const remaining = clampPercent(meter.remainingFraction * 100)
      bars.push({
        key: meter.id,
        label: meter.label,
        remainingPercent: remaining,
        resetText: formatResetCountdown(meter.resetsAt, dict, nowMs),
        level: quotaLevel(remaining),
      })
    }
  }
  const facts: QuotaFactItem[] = []
  if (quota.unlimited) {
    facts.push({ key: 'unlimited', label: dict.credits, value: dict.unlimited })
  } else if (quota.creditBalance !== null) {
    facts.push({ key: 'credits', label: dict.credits, value: quota.creditBalance })
  }
  if (bars.length === 0 && facts.length === 0) return null
  const summary = bars.length > 0
    ? summarizeBars(bars)
    : { summaryText: quota.unlimited ? '∞' : facts[0]!.value, summaryLevel: 'normal' as const, summaryPercent: null }
  return {
    providerId: 'command-code',
    providerName: 'Command Code',
    ...summary,
    bars,
    facts,
  }
}

export function glmToSnapshot(
  status: GlmStatusDto,
  _modelId: string | undefined,
  dict: SessionQuotaDict,
  nowMs?: number,
): SessionQuotaSnapshot | null {
  if (!status.authenticated || status.quota === null || status.quota === undefined) return null
  const bars: QuotaBarItem[] = []
  for (const win of status.quota.windows) {
    if (typeof win.usedPercent !== 'number' || !Number.isFinite(win.usedPercent)) continue
    const remaining = clampPercent(100 - win.usedPercent)
    bars.push({
      key: win.key,
      label: formatWindowDurationLabel(GLM_WINDOW_MINUTES[win.key], win.key, dict),
      remainingPercent: remaining,
      resetText: formatResetCountdown(win.resetsAt, dict, nowMs),
      level: quotaLevel(remaining),
    })
  }
  if (bars.length === 0) return null
  return {
    providerId: GLM_CODING_PLAN_PROVIDER_ID,
    providerName: 'GLM Coding Plan',
    planBadge: status.quota.planName ?? status.quota.planLevel ?? undefined,
    ...summarizeBars(bars),
    bars,
    facts: [],
  }
}

export function stepCodeToSnapshot(
  status: StepCodeStatusDto,
  _modelId: string | undefined,
  dict: SessionQuotaDict,
  nowMs?: number,
): SessionQuotaSnapshot | null {
  if (!status.authenticated || status.quota === null || status.quota === undefined) return null
  const quota = status.quota
  const bars: QuotaBarItem[] = []
  const facts: QuotaFactItem[] = []
  if (quota.kind === 'windowed') {
    for (const win of quota.windows) {
      if (typeof win.usedPercent !== 'number' || !Number.isFinite(win.usedPercent)) continue
      const remaining = clampPercent(100 - win.usedPercent)
      bars.push({
        key: win.key,
        label: formatWindowDurationLabel(STEP_WINDOW_MINUTES[win.key], win.key, dict),
        remainingPercent: remaining,
        resetText: formatResetCountdown(win.resetsAt, dict, nowMs),
        level: quotaLevel(remaining),
      })
    }
  } else if (quota.kind === 'credit') {
    quota.creditBuckets.forEach((bucket, index) => {
      facts.push({
        key: `bucket-${index}`,
        label: dict.creditBucket.replace('{index}', String(index + 1)),
        value: `${bucket.remaining} / ${bucket.total}`,
      })
    })
  }
  if (bars.length === 0 && facts.length === 0) return null
  const summary = bars.length > 0
    ? summarizeBars(bars)
    : { summaryText: facts[0]!.value, summaryLevel: 'normal' as const, summaryPercent: null }
  return {
    providerId: STEP_CODE_PROVIDER_ID,
    providerName: 'Step Code',
    planBadge: quota.planName ?? undefined,
    ...summary,
    bars,
    facts,
  }
}

export function clinePassToSnapshot(
  status: ClinePassWebStatus,
  _modelId: string | undefined,
  dict: SessionQuotaDict,
  nowMs?: number,
): SessionQuotaSnapshot | null {
  if (!status.authenticated || status.usage === null) return null
  const accounts = status.usage.accounts.filter((a) => a.ok && a.windows.length > 0)
  if (accounts.length === 0) return null
  const primary = accounts[0]!
  const bars: QuotaBarItem[] = primary.windows.map((win, index) => {
    const remaining = clampPercent(100 - win.percentUsed)
    return {
      key: `${primary.alias}-${index}`,
      label: win.label,
      remainingPercent: remaining,
      resetText: formatResetCountdown(win.resetsAt, dict, nowMs),
      level: quotaLevel(remaining),
    }
  })
  if (bars.length === 0) return null
  return {
    providerId: 'cline-pass',
    providerName: 'Cline Pass',
    planBadge: primary.alias || undefined,
    ...summarizeBars(bars),
    bars,
    facts: [],
  }
}

export function qoderToSnapshot(
  status: QoderStatusDto,
  _modelId: string | undefined,
  _dict: SessionQuotaDict,
): SessionQuotaSnapshot | null {
  if (!status.authenticated || status.quota === null || status.quota === undefined) return null
  const bars: QuotaBarItem[] = []
  for (const bucket of status.quota.buckets) {
    if (bucket.total === null || bucket.total <= 0 || bucket.used === null) continue
    const remaining = clampPercent((1 - bucket.used / bucket.total) * 100)
    const unit = bucket.unit ? ` ${bucket.unit}` : ''
    bars.push({
      key: bucket.kind,
      label: bucket.kind,
      remainingPercent: remaining,
      detailText: bucket.remaining !== null ? `${bucket.remaining}${unit}` : undefined,
      level: quotaLevel(remaining),
    })
  }
  if (bars.length === 0) return null
  return {
    providerId: QODER_PROVIDER_ID,
    providerName: 'Qoder',
    ...summarizeBars(bars),
    bars,
    facts: [],
  }
}

export function openDesignToSnapshot(
  status: OpenDesignWebStatus,
  _modelId: string | undefined,
  dict: SessionQuotaDict,
): SessionQuotaSnapshot | null {
  if (!status.authenticated || status.usage === null) return null
  const readable = status.usage.accounts.filter((a) => a.ok && a.balanceUsd !== null)
  if (readable.length === 0) return null
  const account = readable[0]!
  const bars: QuotaBarItem[] = []
  if (account.codingPlan && account.codingPlan.error === '') {
    for (const win of account.codingPlan.windows) {
      const limit = Number(win.limitCredits)
      const left = Number(win.remainingCredits)
      if (!Number.isFinite(limit) || !Number.isFinite(left) || limit <= 0) continue
      const remaining = clampPercent((left / limit) * 100)
      bars.push({
        key: String(win.durationSeconds),
        label: formatWindowDurationLabel(win.durationSeconds / 60, `${win.durationSeconds}s`, dict),
        remainingPercent: remaining,
        level: quotaLevel(remaining),
      })
    }
  }
  const facts: QuotaFactItem[] = []
  if (account.balanceUsd !== null && account.balanceUsd !== '') {
    const balanceText = account.balanceUsd.startsWith('$') ? account.balanceUsd : `$${account.balanceUsd}`
    facts.push({ key: 'balance', label: dict.balance, value: balanceText })
  }
  if (bars.length === 0 && facts.length === 0) return null
  const summary = bars.length > 0
    ? summarizeBars(bars)
    : { summaryText: facts[0]!.value, summaryLevel: 'normal' as const, summaryPercent: null }
  return {
    providerId: 'opendesign',
    providerName: 'OpenDesign',
    ...summary,
    bars,
    facts,
  }
}

export function workBuddyToSnapshot(
  status: WorkBuddyWebStatus,
  _modelId: string | undefined,
  dict: SessionQuotaDict,
  nowMs?: number,
): SessionQuotaSnapshot | null {
  if (!status.authenticated) return null
  if (status.pool?.paused === true) {
    const reason = status.pool.pauseReason ? ` — ${status.pool.pauseReason}` : ''
    return {
      providerId: 'workbuddy-subscription',
      providerName: 'WorkBuddy',
      summaryText: dict.poolPaused,
      summaryLevel: 'danger',
      summaryPercent: null,
      bars: [],
      facts: [],
      note: `${dict.poolPaused}${reason}`,
    }
  }
  const quota = status.quota
  if (quota === null || quota === undefined) return null
  const bars: QuotaBarItem[] = []
  for (const meter of quota.meters ?? []) {
    if (meter.remainingFraction === null || !Number.isFinite(meter.remainingFraction)) continue
    const remaining = clampPercent(meter.remainingFraction * 100)
    bars.push({
      key: meter.id,
      label: meter.label,
      remainingPercent: remaining,
      resetText: formatResetCountdown(meter.resetsAt, dict, nowMs),
      level: quotaLevel(remaining),
    })
  }
  const facts: QuotaFactItem[] = []
  if (quota.remainingCredits !== null && Number.isFinite(quota.remainingCredits)) {
    facts.push({ key: 'credits', label: dict.credits, value: String(quota.remainingCredits) })
  }
  if (bars.length === 0 && facts.length === 0) return null
  const summary = bars.length > 0
    ? summarizeBars(bars)
    : { summaryText: facts[0]!.value, summaryLevel: 'normal' as const, summaryPercent: null }
  return {
    providerId: 'workbuddy-subscription',
    providerName: 'WorkBuddy',
    ...summary,
    bars,
    facts,
  }
}

/**
 * Antigravity (ACP): displays only plan tier and last-turn token usage.
 * Official ACP does not report remaining quota percentages yet, so `bars` stays
 * empty until upstream adds a quota query.
 */
export function antigravityToSnapshot(
  status: AntigravityAcpStatusDto,
  _modelId: string | undefined,
  dict: SessionQuotaDict,
): SessionQuotaSnapshot | null {
  if (status.auth.authenticated !== true) return null
  const tier = status.auth.tier
  const usage = status.usage
  if (tier === undefined && usage === undefined) return null
  const facts: QuotaFactItem[] = []
  if (tier !== undefined) {
    facts.push({ key: 'tier', label: dict.planTier, value: tier.name })
  }
  if (usage !== undefined) {
    facts.push({ key: 'input', label: dict.lastInput, value: compactTokens(usage.inputTokens) })
    facts.push({ key: 'output', label: dict.lastOutput, value: compactTokens(usage.outputTokens) })
  }
  return {
    providerId: ANTIGRAVITY_PROVIDER_ID,
    providerName: 'Antigravity',
    planBadge: tier?.name,
    summaryText: tier?.name ?? compactTokens(usage?.inputTokens ?? 0),
    summaryLevel: 'normal',
    summaryPercent: null,
    bars: [],
    facts,
  }
}

export function qianwenToSnapshot(
  status: QianwenStatusDto,
  _modelId: string | undefined,
  dict: SessionQuotaDict,
): SessionQuotaSnapshot | null {
  if (!status.authenticated || !status.cacheStats) return null
  const ratio = qianwenCacheHitRatio(status.cacheStats)
  if (ratio === null) return null
  const percent = clampPercent(Math.round(ratio * 100))
  const bars: QuotaBarItem[] = [{
    key: 'cache-hit',
    label: dict.cacheHit,
    remainingPercent: percent,
    level: quotaLevel(percent),
  }]
  const facts: QuotaFactItem[] = [{
    key: 'cache-read',
    label: dict.cacheRead,
    value: compactTokens(status.cacheStats.cacheReadTokens),
  }]
  return {
    providerId: QIANWEN_TOKEN_PLAN_PROVIDER_ID,
    providerName: 'Qianwen',
    ...summarizeBars(bars),
    bars,
    facts,
  }
}

export function relayOneToSnapshot(
  status: RelayOneStatusDto,
  _modelId: string | undefined,
  dict: SessionQuotaDict,
): SessionQuotaSnapshot | null {
  if (!status.authenticated || status.quota === undefined) return null
  const quota = status.quota
  const text = relayOneQuotaText(quota)
  if (text === null) return null
  const bars: QuotaBarItem[] = []
  const facts: QuotaFactItem[] = []
  if (!relayOneQuotaIsUnlimited(quota) && typeof quota.remainingPercent === 'number' && Number.isFinite(quota.remainingPercent)) {
    const remaining = clampPercent(quota.remainingPercent)
    bars.push({
      key: 'relayone-main',
      label: dict.quotaAvailable,
      remainingPercent: remaining,
      detailText: quota.state === 'stale' ? dict.quotaStale : undefined,
      level: quotaLevel(remaining),
    })
  }
  if (relayOneQuotaIsUnlimited(quota)) {
    facts.push({ key: 'unlimited', label: dict.quotaAvailable, value: dict.unlimited })
  } else {
    const available = relayOneQuotaAmount(quota.totalAvailable, quota.quotaPerUnit)
    const used = relayOneQuotaAmount(quota.totalUsed, quota.quotaPerUnit)
    const granted = relayOneQuotaAmount(quota.totalGranted, quota.quotaPerUnit)
    if (available !== null) facts.push({ key: 'avail', label: dict.quotaAvailable, value: available })
    if (used !== null) facts.push({ key: 'used', label: dict.quotaUsed, value: used })
    if (granted !== null) facts.push({ key: 'granted', label: dict.quotaGranted, value: granted })
  }
  if (bars.length === 0 && facts.length === 0) return null
  const summary = bars.length > 0
    ? summarizeBars(bars)
    : { summaryText: text, summaryLevel: 'normal' as const, summaryPercent: null }
  return {
    providerId: RELAYONE_PROVIDER_ID,
    providerName: 'RelayOne',
    ...summary,
    bars,
    facts,
  }
}

export const SESSION_QUOTA_ADAPTERS: ReadonlyMap<string, SessionQuotaAdapter<any>> = new Map<string, SessionQuotaAdapter<any>>([
  [CODEX_CHATGPT_PROVIDER_ID, {
    providerId: CODEX_CHATGPT_PROVIDER_ID,
    readStatus: () => codexApi.status(),
    toSnapshot: codexToSnapshot,
  }],
  ['claude-subscription', {
    providerId: 'claude-subscription',
    readStatus: (refresh) => (refresh ? claudeApi.post<ClaudeWebStatus>('/quota') : claudeApi.get<ClaudeWebStatus>('/status')),
    toSnapshot: claudeToSnapshot,
  }],
  ['kimi-code', {
    providerId: 'kimi-code',
    readStatus: (refresh) => (refresh ? kimiApi.post<KimiCodeWebStatus>('/quota') : kimiApi.get<KimiCodeWebStatus>('/status')),
    toSnapshot: kimiToSnapshot,
  }],
  ['minimax-code', {
    providerId: 'minimax-code',
    readStatus: () => minimaxApi.get<MinimaxCodeWebStatus>('/quota'),
    toSnapshot: minimaxToSnapshot,
  }],
  ['command-code', {
    providerId: 'command-code',
    readStatus: (refresh) => (refresh ? commandCodeApi.post<CommandCodeWebStatus>('/quota') : commandCodeApi.get<CommandCodeWebStatus>('/status')),
    toSnapshot: commandCodeToSnapshot,
  }],
  [GLM_CODING_PLAN_PROVIDER_ID, {
    providerId: GLM_CODING_PLAN_PROVIDER_ID,
    readStatus: (refresh) => (refresh ? glmApi.post<GlmStatusDto>('/quota', {}) : glmApi.get<GlmStatusDto>('/status')),
    toSnapshot: glmToSnapshot,
  }],
  [STEP_CODE_PROVIDER_ID, {
    providerId: STEP_CODE_PROVIDER_ID,
    readStatus: (refresh) => (refresh ? stepCodeApi.post<StepCodeStatusDto>('/quota', {}) : stepCodeApi.get<StepCodeStatusDto>('/status')),
    toSnapshot: stepCodeToSnapshot,
  }],
  ['cline-pass', {
    providerId: 'cline-pass',
    readStatus: (refresh) => clinePassApi.status(refresh),
    toSnapshot: clinePassToSnapshot,
  }],
  [QODER_PROVIDER_ID, {
    providerId: QODER_PROVIDER_ID,
    readStatus: (refresh) => (refresh ? qoderApi.post<QoderStatusDto>('/quota', {}) : qoderApi.get<QoderStatusDto>('/status')),
    toSnapshot: qoderToSnapshot,
  }],
  ['opendesign', {
    providerId: 'opendesign',
    readStatus: () => openDesignApi.status(),
    toSnapshot: openDesignToSnapshot,
  }],
  ['workbuddy-subscription', {
    providerId: 'workbuddy-subscription',
    readStatus: (refresh) => (refresh ? workBuddyApi.post<WorkBuddyWebStatus>('/quota') : workBuddyApi.get<WorkBuddyWebStatus>('/status')),
    toSnapshot: workBuddyToSnapshot,
  }],
  [ANTIGRAVITY_PROVIDER_ID, {
    providerId: ANTIGRAVITY_PROVIDER_ID,
    readStatus: (refresh) => (refresh ? antigravityApi.refresh() : antigravityApi.status()),
    toSnapshot: antigravityToSnapshot,
  }],
  [QIANWEN_TOKEN_PLAN_PROVIDER_ID, {
    providerId: QIANWEN_TOKEN_PLAN_PROVIDER_ID,
    readStatus: () => qianwenApi.get<QianwenStatusDto>('/status'),
    toSnapshot: qianwenToSnapshot,
  }],
  [RELAYONE_PROVIDER_ID, {
    providerId: RELAYONE_PROVIDER_ID,
    readStatus: (refresh) => (refresh ? relayOneApi.post<RelayOneStatusDto>('/catalog/refresh', {}) : relayOneApi.get<RelayOneStatusDto>('/status')),
    toSnapshot: relayOneToSnapshot,
  }],
])

export function formatRemainingPercent(value: number): string {
  return `${formatPercent(clampPercent(value), 0)}%`
}
