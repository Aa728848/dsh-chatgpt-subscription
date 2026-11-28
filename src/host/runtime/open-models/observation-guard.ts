/**
 * 开源模型共享入库前观测头、Kimi 只读空转检测、真实 ESC ANSI 清洗与非受控线路失控提醒。
 *
 * 四项精准能力均通过 {@link matchOpenModelProfile} 严格按模型画像门控：
 *
 * 1. **入库前单行自描述观测头（`observationHeader`）**：
 *    在大块根级文本观测（≥ 1,200 字符、无 `parent`、无 `decision.value`）首次入库前
 *    前置 `[OBS | tool=... | target=... | status=...]`，为 KDA/GDN 线性递推状态与
 *    Gated DSA / IndexShare / MSA / QSA 稀疏索引器提供高对比度语义锚，0% 破前缀缓存。
 * 2. **Kimi K3 / K3.1 Pro 变参只读空转检测（`readOnlySpinGuard`，治 `kimi-code#3214`）**：
 *    在非导航/非计划模式下，连续多次调用纯只读工具（`read`/`grep`/`glob` 等）而无任何
 *    写入/执行推进时，通过 `additionalContexts` 温和提醒模型整合已有证据推进编辑或交付。
 *    高上下文（≥ 200K）下收紧阈值（8 → 6）；每轮至多提醒一次，绝不阻断工具执行。
 * 3. **Kimi K3 / K3.1 Pro 真实 ESC ANSI 控制码清洗（`sanitizeEscAnsi`）**：
 *    在 `llm/stream` 文本流增量中剥离偶发泄漏的真实 ESC CSI 序列（`\x1b[...m`），
 *    绝不误伤源码中的普通文本 `[0m` 或数组索引。
 * 4. **非受控第一方线路的温和失控与 A-B-A-B 循环提醒（`unmanagedRunawayGuard`）**：
 *    例如官方 `deepseek` / `deepseek-official` 线路上的 `deepseek-v4-pro` / `deepseek-v4-flash`
 *    不在 `CONTROLLED_PROVIDERS` 中，此处补齐温和分级提醒 + A-B-A-B 交替循环提醒（绝不与
 *    受控线路上的 `installKimiRepeatBreaker` 叠加）。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/open-models/observation-guard
 */
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { cacheWarmupNavigationIntentOf } from '../cache-warmup/retrieval-intent.ts'
import { CONTROLLED_PROVIDERS } from '../../common/model-request-control.ts'
import {
  createReadOnlySpinTracker,
  createToolRunawayGuard,
  observationFromToolExecution,
  renderReadOnlySpinReminder,
  type ReadOnlySpinTracker,
  type ToolRunawayGuard,
  type ToolRunawayReminder,
} from '../../common/tool-runaway.ts'
import {
  OBSERVATION_HEADER_PREFIX,
  OBSERVATION_TAG_MIN_CHARS,
  OBSERVATION_TAG_TOOLS,
  buildObservationHeader,
} from '../deepseek-v41-flash/observation-tagger.ts'
import { defaultEstimateContextTokens } from '../deepseek-v41-flash/state-anchor.ts'
import { isRealUserMessage } from '../deepseek-v41-flash/goal-intake.ts'
import { readScopeRoute } from '../deepseek-v41-flash/match.ts'
import { matchOpenModelProfile, matchOpenModelScope } from './profiles.ts'

/** 开源模型只读空转 / 非受控线路失控提醒的消息来源 kind。 */
export const OPEN_MODEL_GUARD_NOTICE_SOURCE_KIND = 'open-model-guard-notice'

/** 高上下文收紧 Kimi 只读空转阈值的估算 token 线。 */
export const READ_ONLY_SPIN_HIGH_CONTEXT_TOKENS = 200_000

/** 匹配真实 ESC 引导的 ANSI CSI SGR 控制序列（绝不误伤普通 ASCII 文本 `[0m`）。 */
const ESC_ANSI_CSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

const CONTROLLED_PROVIDER_SET: ReadonlySet<string> = new Set(CONTROLLED_PROVIDERS)

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 开源模型运行时温和提醒（Kimi 只读空转 / 非受控第一方线路 V4 失控）。 */
    'open-model-guard-notice': { kind: 'open-model-guard-notice' } & { form?: 'notice'; summary?: string }
  }
}

interface EventHostLike {
  on?(name: string, listener: (...args: never[]) => unknown, options?: unknown): unknown
  off?(name: string, listener: (...args: never[]) => unknown): unknown
  get?(name: string): unknown
  readonly agents?: { get?(id: unknown): unknown }
}

interface StreamChunkLike {
  readonly type: string
  readonly text?: string
  readonly [key: string]: unknown
}

interface StreamOptionsLike {
  readonly provider?: string
  readonly model?: string
  readonly sessionId?: string
  readonly purpose?: string
}

export interface OpenModelObservationGuardOptions {
  /** 总开关活引用。默认 true。 */
  readonly enabled?: () => boolean
  /** 失控/只读空转提醒开关（默认跟随主插件 `toolRunawayGuard`）。 */
  readonly runawayEnabled?: () => boolean
  /** 观测头最小文本字符阈值（默认 1200）。 */
  readonly minChars?: number
  /** 可选上下文 token 估算覆盖（测试用）。 */
  readonly estimateContextTokens?: (agent: unknown, observedChars: number) => number
}

/** 无损清除真实 ESC 引导的 ANSI CSI 终端控制序列；纯文本原样返回。 */
export function stripEscAnsiSequences(text: string): string {
  if (!text.includes('\u001b')) return text
  return text.replace(ESC_ANSI_CSI_PATTERN, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isEnabled(read: (() => boolean) | undefined): boolean {
  if (read === undefined) return true
  try {
    return read() !== false
  } catch {
    return false
  }
}

function totalTextChars(blocks: readonly ContentBlock[]): number {
  let sum = 0
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') sum += block.text.length
  }
  return sum
}

function prependHeaderToBlocks(blocks: readonly ContentBlock[], header: string): ContentBlock[] | undefined {
  const firstTextIdx = blocks.findIndex(block => block.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
  if (firstTextIdx < 0) return undefined
  const first = blocks[firstTextIdx] as { type: 'text'; text: string }
  if (first.text.startsWith(OBSERVATION_HEADER_PREFIX)) return undefined
  const next = [...blocks]
  next[firstTextIdx] = { ...first, text: `${header}\n${first.text}` }
  return next
}

function createGuardNotice(text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: OPEN_MODEL_GUARD_NOTICE_SOURCE_KIND,
      form: 'notice',
      summary,
    },
  })
}

function appendAdditionalContext(decision: PostToolDecision, notice: UserMessage): PostToolDecision {
  const additionalContexts = decision.additionalContexts === undefined
    ? [notice]
    : [...decision.additionalContexts, notice]
  return {
    ...decision,
    additionalContexts,
  } as PostToolDecision
}

function resolveStreamProvider(ctx: EventHostLike | undefined, request: StreamOptionsLike): string | undefined {
  if (typeof request.provider === 'string' && request.provider.length > 0) return request.provider
  if (ctx === undefined || request.sessionId === undefined) return undefined
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (isRecord(registry) && typeof registry['get'] === 'function') {
      const agent = (registry['get'] as (id: unknown) => unknown)(request.sessionId)
      const provider = readScopeRoute(agent).provider
      if (provider !== undefined) return provider
    }
  } catch {
    // 忽略。
  }
  try {
    const agent = ctx.agents?.get?.(request.sessionId)
    return readScopeRoute(agent).provider
  } catch {
    return undefined
  }
}

function subscribe(
  host: EventHostLike | undefined,
  event: string,
  listener: (...args: never[]) => unknown,
): (() => void) | undefined {
  if (typeof host?.on !== 'function') return undefined
  const attempts: readonly unknown[] = [{ global: true }, undefined]
  for (const options of attempts) {
    try {
      const handle = options === undefined
        ? host.on(event, listener)
        : host.on(event, listener, options)
      if (typeof handle === 'function') return handle as () => void
      if (handle !== null && typeof handle === 'object' && typeof (handle as { dispose?: unknown }).dispose === 'function') {
        return () => { (handle as { dispose(): void }).dispose() }
      }
      return () => {
        try {
          host.off?.(event, listener)
        } catch {
          // 忽略已移除监听。
        }
      }
    } catch {
      continue
    }
  }
  return undefined
}

interface SpinSessionState {
  readonly tracker: ReadOnlySpinTracker
  remindedThisTurn: boolean
}

/**
 * 安装开源模型共享入库前观测头、Kimi 只读空转提醒、ESC ANSI 清洗与非受控线路失控提醒。
 */
export function installOpenModelObservationGuard(
  ctx: unknown,
  options: OpenModelObservationGuardOptions = {},
): () => void {
  const host = typeof ctx === 'object' && ctx !== null ? (ctx as EventHostLike) : undefined
  const minChars = Math.max(1, options.minChars ?? OBSERVATION_TAG_MIN_CHARS)
  const estimateTokens = options.estimateContextTokens ?? defaultEstimateContextTokens

  const spinStates = new Map<string, SpinSessionState>()
  const runawayGuards = new Map<string, ToolRunawayGuard>()
  let disposed = false

  const spinStateFor = (sessionKey: string): SpinSessionState => {
    let state = spinStates.get(sessionKey)
    if (state === undefined) {
      state = { tracker: createReadOnlySpinTracker(), remindedThisTurn: false }
      spinStates.set(sessionKey, state)
    }
    return state
  }

  const runawayGuardFor = (sessionKey: string): ToolRunawayGuard => {
    let guard = runawayGuards.get(sessionKey)
    if (guard === undefined) {
      guard = createToolRunawayGuard({ remindOnAbabCycle: true })
      runawayGuards.set(sessionKey, guard)
    }
    return guard
  }

  // 1. tools/post-execute：观测头 + Kimi 只读空转提醒 + 非受控线路失控/A-B-A-B 提醒。
  const onPostExecute = async (
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    const decision = await next()
    if (disposed || !isEnabled(options.enabled)) return decision
    if (decision.kind !== 'accept') return decision
    if ((exec as { parent?: unknown })?.parent !== undefined) return decision

    const matched = matchOpenModelScope(exec.agent)
    if (matched === undefined) return decision
    const { route, profile } = matched

    let nextDecision: PostToolDecision = decision

    // 1a) 入库前单行自描述观测头（不动 decision.value）。
    if (
      profile.observationHeader
      && OBSERVATION_TAG_TOOLS.has(exec.name)
      && (decision as { value?: unknown }).value === undefined
    ) {
      const blocks = decision.content ?? result.content
      if (Array.isArray(blocks) && blocks.length > 0 && totalTextChars(blocks) >= minChars) {
        const header = buildObservationHeader(exec.name, exec.arguments, result.isError === true)
        const tagged = prependHeaderToBlocks(blocks, header)
        if (tagged !== undefined) {
          nextDecision = {
            kind: 'accept',
            content: tagged,
            ...(decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }),
          }
        }
      }
    }

    const sessionKey = route.sessionId ?? (isRecord(exec.agent) && typeof exec.agent['id'] === 'string' ? exec.agent['id'] : undefined)

    // 1b) Kimi K3 / K3.1 Pro 变参只读空转检测（非导航/非计划模式才触发）。
    if (
      profile.readOnlySpinGuard
      && isEnabled(options.runawayEnabled)
      && sessionKey !== undefined
    ) {
      const spin = spinStateFor(sessionKey)
      const streak = spin.tracker.observe(exec.name)
      if (streak > 0 && !spin.remindedThisTurn && !cacheWarmupNavigationIntentOf(exec.agent)) {
        const approxTokens = estimateTokens(exec.agent, 0)
        const baseThreshold = profile.readOnlySpinThreshold ?? 8
        const highCtxThreshold = profile.readOnlySpinHighContextThreshold ?? 6
        const activeThreshold = approxTokens >= READ_ONLY_SPIN_HIGH_CONTEXT_TOKENS
          ? Math.min(baseThreshold, highCtxThreshold)
          : baseThreshold
        if (streak >= activeThreshold) {
          spin.remindedThisTurn = true
          nextDecision = appendAdditionalContext(
            nextDecision,
            createGuardNotice(
              renderReadOnlySpinReminder(streak),
              `${profile.label} read-only spin reminder (x${streak})`,
            ),
          )
        }
      }
    }

    // 1c) 非受控第一方线路上的 DeepSeek-V4 Pro/Flash 等，补齐温和失控 + A-B-A-B 循环提醒。
    if (
      profile.unmanagedRunawayGuard
      && isEnabled(options.runawayEnabled)
      && sessionKey !== undefined
      && (route.provider === undefined || !CONTROLLED_PROVIDER_SET.has(route.provider))
    ) {
      const guard = runawayGuardFor(sessionKey)
      const observation = observationFromToolExecution(exec.name, exec.arguments, result)
      const reminder: ToolRunawayReminder | undefined = guard.observe(observation)
      if (reminder !== undefined) {
        nextDecision = appendAdditionalContext(
          nextDecision,
          createGuardNotice(reminder.text, `${profile.label} runaway reminder`),
        )
      }
    }

    return nextDecision
  }

  // 2. agent/pre-step：新用户回合归零只读空转与失控连击。
  const onPreStep = async (
    payload: { readonly agent?: unknown; readonly messages?: readonly unknown[]; readonly modelSelection?: unknown },
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const decision = await next()
    if (disposed) return decision
    const matched = matchOpenModelScope(payload?.agent, payload?.modelSelection)
    if (matched === undefined) return decision
    const sessionKey = matched.route.sessionId
    if (sessionKey === undefined) return decision
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    // 用白名单而非仅排除 `form === 'notice'`，避免 `todo-reminder` / `runtime-context`（`form: 'snapshot'`）误重置空转与失控计数器。
    if (messages.some(isRealUserMessage)) {
      const spin = spinStates.get(sessionKey)
      if (spin !== undefined) {
        spin.tracker.reset()
        spin.remindedThisTurn = false
      }
      runawayGuards.get(sessionKey)?.reset()
    }
    return decision
  }

  // 3. llm/stream：仅对 `sanitizeEscAnsi` 模型（Kimi K3/K3.1）无损清洗文本流里的真实 ESC ANSI 序列。
  const onStream = (
    request: StreamOptionsLike,
    next: () => AsyncIterable<StreamChunkLike>,
  ): AsyncIterable<StreamChunkLike> => {
    const stream = next()
    if (disposed || !isEnabled(options.enabled)) return stream
    const provider = resolveStreamProvider(host, request)
    const profile = matchOpenModelProfile(request?.model, provider)
    if (profile === undefined || !profile.sanitizeEscAnsi) return stream

    async function* sanitized(): AsyncIterable<StreamChunkLike> {
      for await (const chunk of stream) {
        if (chunk !== null && typeof chunk === 'object') {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.includes('\u001b')) {
            yield { ...chunk, text: stripEscAnsiSequences(chunk.text) }
            continue
          }
          if (
            chunk.type === 'block-end'
            && isRecord(chunk['block'])
            && chunk['block']['type'] === 'text'
            && typeof chunk['block']['text'] === 'string'
            && (chunk['block']['text'] as string).includes('\u001b')
          ) {
            yield {
              ...chunk,
              block: { ...chunk['block'], text: stripEscAnsiSequences(chunk['block']['text'] as string) },
            }
            continue
          }
        }
        yield chunk
      }
    }
    return sanitized()
  }

  const onDisposed = (payload: { readonly agent?: unknown } | undefined): void => {
    const matched = matchOpenModelScope(payload?.agent)
    const key = matched?.route.sessionId
    if (key !== undefined) {
      spinStates.delete(key)
      runawayGuards.delete(key)
    }
  }

  const offPost = subscribe(host, 'tools/post-execute', onPostExecute as never)
  const offPreStep = subscribe(host, 'agent/pre-step', onPreStep as never)
  const offStream = subscribe(host, 'llm/stream', onStream as never)
  const offDisposed = subscribe(host, 'agent/disposed', onDisposed as never)

  return () => {
    if (disposed) return
    disposed = true
    for (const off of [offPost, offPreStep, offStream, offDisposed]) {
      try {
        off?.()
      } catch {
        // 卸载期忽略单点异常。
      }
    }
    spinStates.clear()
    runawayGuards.clear()
  }
}
