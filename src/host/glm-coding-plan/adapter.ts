/**
 * GLM（ZCode 账号）线路的 DSH 适配器。
 *
 * 它做的是这一轮里**唯一**一件两个交付模块都做不了的事：
 *
 * > 按 `GlmModelOption.wire` 把一次请求送到对应的协议面。
 *
 * 目录逐行声明协议（计划 D3），所以这里不猜：`wire` 为 `anthropic` 就走
 * `mapper-anthropic.ts` 的 Messages 线，`openai` 就走 `mapper-openai.ts` 的
 * Chat Completions 线，`null`（目录没有转录过的 id）**拒绝这个模型**——挑错的表现是
 * 1212 `WRONG_METHOD`，比直接拒绝更难排查。
 *
 * 另外三件事也刻意留在这里而不是散进两个 mapper：
 *
 * - **ladder 由本层传入**：`glmEffortForLadder` / `buildChatRequest` 只收敛，不查目录。
 *   梯子来自 `GlmModelOption.reasoningEfforts`，空数组 = 该模型完全不发思考控制
 *   （**有意语义**，不是 bug）。
 * - **签名层就地合并**：`applyGlmClientSigning` 门控关闭时原样返回、零网络请求，
 *   所以这里不写任何 `if`。sessionId 在一个适配器实例的生命周期内固定复用，
 *   每次新生成会让 PoW seed 与签名串都变。
 * - **冷却键看状态码 429 与正文里的重置时刻**，而不是只看 `code`。冻结的错误码表里
 *   七条 429 有五条是额度类（`USAGE_LIMIT` / `PLAN_LIMIT` / `NO_BALANCE` / `PLAN_EXPIRED` /
 *   `MODEL_NOT_IN_PLAN`），它们不可重试，而「`code === 'RATE_LIMIT'` 才冷却」会让
 *   **已用尽的窗口永远不被冷却**——号池会一遍又一遍把同一个已用尽账号派出去。
 */

import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import { fetchWithContextBudgetRecovery } from '../common/context-budget-fetch.ts'
import { outputReservation } from '../common/output-reservation.ts'
import { normalizeGenerateOptions, type GenerateOptions as NormalizedGenerateOptions } from '../common/llm-compat.ts'
import { wrapStreamWithWatchdog } from '../common/idle-watchdog.ts'
import { retryAfterMs } from '../wire-auth.ts'
import {
  offloadOldestRequestImages,
  resolveRequestImages,
  type AttachmentImageReader,
  type ResolvedRequestImages,
} from '../common/request-images.ts'
import {
  PROVIDER_ID,
  PROVIDER_NAME,
  STREAM_IDLE_TIMEOUT_CODE,
  STREAM_IDLE_TIMEOUT_MS,
  clientSigningEnabled,
  normalizeRegion,
} from './types.ts'
import {
  GLM_MODEL_CATALOG,
  modelsForRegion,
  resolveGlmModel,
  type GlmCatalogWire,
  type GlmModelEntry,
} from './model-catalog.ts'
import {
  buildGlmAnthropicRequest,
  assertGlmStreamComplete,
  glmAnthropicHeaders,
  glmAnthropicUrl,
  glmStreamHasContent,
  glmUpstreamError,
  closeGlmAnthropicStream,
  createGlmAnthropicStreamState,
  processGlmAnthropicStreamLine,
} from './mapper-anthropic.ts'
import {
  assertStreamComplete,
  buildChatRequest,
  chatCompletionsUrl,
  classifyGlmOpenAiFailure,
  closeStream,
  createStreamState,
  glmOpenAiHeaders,
  processStreamLine,
} from './mapper-openai.ts'
import { getCachedCatalog } from './client.ts'
import { applyGlmClientSigning, GlmClientSigner } from './signing.ts'
import {
  GlmCodingPlanCredentialStore,
  GlmCodingPlanModelSettingsStore,
  type GlmCodingPlanCredentials,
  type GlmCodingPlanModelSettings,
  type GlmCodingPlanPreferenceStore,
} from './token-store.ts'
import type { GlmCodingPlanAccountPool } from './account-pool.ts'
import type { GlmRegion, GlmWire } from '../../shared/glm-coding-plan-contracts.ts'

/**
 * 这条路由的瞬时故障重试策略。
 *
 * 可重试的集合与兄弟线路逐字一致：RATE_LIMIT（真的背压）、SERVER（上游 5xx）、
 * TRANSPORT（没有应答的连接）、TIMEOUT（卡住的流，由空闲看门狗负责）。
 *
 * 刻意不在集合里：AUTH（被拒的 Key 每次都一样）、QUOTA（额度用尽，等窗口重置）、
 * PROVIDER_ERROR（400 或套餐拒绝）、ABORTED（调用方自己取消）。
 */
export const GLM_CODING_PLAN_RETRY_POLICY_CONFIG: {
  mode: 'normal'
  maxRetries: number
  retryableCodes: string[]
  backoff: { initialDelayMs: number; maxDelayMs: number; jitterRatio: number }
} = {
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  backoff: { initialDelayMs: 1_500, maxDelayMs: 15_000, jitterRatio: 0.2 },
}

const RETRY_POLICY = resolveRetryPolicy(
  GLM_CODING_PLAN_RETRY_POLICY_CONFIG,
  'dsh-chatgpt-subscription.glm-coding-plan.retry',
)

/** 上游没有给 `Retry-After`、正文也没有重置时刻时，一次冷却按多久算。 */
export const GLM_POOL_COOLDOWN_MS = 5 * 60 * 1000

/**
 * 从一份 429 正文里取窗口重置时刻（Unix 毫秒）。
 *
 * 它**不做分类**——分类是两个 mapper 各自唯一的一份，本文件只取一个时间：
 * 「这个账号要到什么时候才能再用」是号池需要的，而「这是不是限流」不是。
 *
 * **未验证**：字段名。上游的配额响应里出现过 `nextResetTime` 与 `resetTime`，
 * 429 正文用什么字段没有样本，所以这里只认这几个已知拼写，认不出就返回 undefined，
 * 由调用方回落到 `Retry-After` 或默认冷却时长。
 */
export function readGlmResetAt(body: unknown): number | undefined {
  const pick = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
    if (typeof value === 'string' && value.trim() !== '') {
      const numeric = Number(value)
      if (Number.isFinite(numeric) && numeric > 0) return numeric
      const parsed = Date.parse(value)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    return undefined
  }
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  for (const key of ['resetTime', 'nextResetTime', 'resetAt', 'resetsAt', 'reset_time', 'next_reset_time']) {
    const found = pick(record[key])
    if (found !== undefined) return found > 10_000_000_000 ? found : found * 1000
  }
  const data = typeof record.data === 'object' && record.data !== null
    ? record.data as Record<string, unknown>
    : undefined
  if (data !== undefined && data !== record) return readGlmResetAt(data)
  return undefined
}

/**
 * 一次 429 该不该冷却这个账号、冷却多久。
 *
 * 判据是**状态码 429**，而不是错误码：冻结的 `ERROR_CODE` 表里七条 429 中五条是额度类，
 * 它们分别映射到 `QUOTA` / `PROVIDER_ERROR`，只认 `code === 'RATE_LIMIT'` 会让
 * 「窗口已用尽」永远走不到冷却这一步——而那恰恰是最需要冷却的场景。
 *
 * 时长按可靠度依次取：正文里的重置时刻 → `Retry-After` → 默认 5 分钟。
 * 重置时刻是唯一能让「等窗口重开再试」变成事实的那个数。
 */
export function glmCooldownDecision(input: {
  status: number
  headers?: Headers
  body?: unknown
}): { cooldown: boolean; durationMs: number; reason: string } {
  if (input.status !== 429) return { cooldown: false, durationMs: 0, reason: '' }
  const resetsAt = readGlmResetAt(input.body)
  if (resetsAt !== undefined) {
    const durationMs = Math.max(30_000, resetsAt - Date.now())
    return { cooldown: true, durationMs, reason: PROVIDER_NAME + ' 429：用量窗口将于 ' + new Date(resetsAt).toISOString() + ' 重置' }
  }
  const after = input.headers === undefined ? undefined : retryAfterMs(input.headers)
  if (after !== undefined && after > 0) {
    return { cooldown: true, durationMs: after, reason: PROVIDER_NAME + ' 429：上游要求 ' + Math.ceil(after / 1000) + ' 秒后再试' }
  }
  return { cooldown: true, durationMs: GLM_POOL_COOLDOWN_MS, reason: PROVIDER_NAME + ' 429：上游未给重置时刻，按 5 分钟冷却' }
}

/**
 * 一次请求的线路形状：URL、请求头、请求体，以及它走了哪个协议面。
 *
 * 做成一个**纯函数**而不是把构建过程埋进流里，是为了「两个 mapper 按 wire 正确路由」
 * 与「ladder 正确传入」这两条验收点能被直接断言：它们是这个函数的输出，不是
 * 一次网络往返的副产品。
 */
export interface GlmRequestPlan {
  /** 实际走的协议面；调用方据此选流解析器。 */
  wire: GlmWire
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/**
 * 目录里没有转录过的模型：拒绝，而不是替它挑一个面。
 *
 * 计划 D3 的原话是「未知模型不猜协议」。猜错的表现是上游 1212 `WRONG_METHOD`，
 * 而那一条正文说的是「该模型不提供这个调用方式」，会把排查引向协议而不是目录。
 */
function requireWire(modelId: string, entry: GlmModelEntry): GlmWire {
  const wire: GlmCatalogWire = entry.wire
  if (wire === 'anthropic' || wire === 'openai') return wire
  throw new LlmError(
    PROVIDER_NAME + ' 的模型目录里没有 ' + modelId + ' 的协议声明，无法选择调用面。'
    + '请在设置页刷新模型目录；若这是上游新增的模型，本插件还没记录它走哪个面。',
    'NOT_FOUND',
  )
}

/**
 * 构造一次请求。**不联网、不读设置**，所以可以被单独测。
 *
 * @param options - harness 归一化后的会话。
 * @param request - 区域、目录行、已读图片与环境覆盖。
 */
export function buildGlmRequestPlan(
  options: NormalizedGenerateOptions,
  request: {
    region: GlmRegion
    entry: GlmModelEntry
    images?: ResolvedRequestImages
    env?: NodeJS.ProcessEnv
  },
): GlmRequestPlan {
  const wire = requireWire(options.model, request.entry)
  // 认证头由调用方在拿到真实 Coding Plan Key 之后补上（两个 mapper 的头构造都需要它），
  // 所以这里只决定**发哪个面、发什么体**，不碰凭据。
  if (wire === 'anthropic') {
    return {
      wire,
      url: glmAnthropicUrl(request.region, request.env),
      headers: { accept: 'text/event-stream' },
      body: buildGlmAnthropicRequest(options, {
        // 梯子由本层传入：mapper 只收敛，不查目录。空数组 = 该模型不发任何思考控制。
        ladder: request.entry.reasoningEfforts,
        ...(request.images === undefined ? {} : { images: request.images }),
        defaultMaxTokens: request.entry.defaultMaxTokens,
      }),
    }
  }
  return {
    wire,
    url: chatCompletionsUrl(request.region, request.env),
    headers: { accept: 'text/event-stream' },
    body: buildChatRequest(options, request.images, {
      // 同样由本层传入；`supportsImages` 决定请求里的图按「读不出来」明说还是内联。
      reasoningEfforts: request.entry.reasoningEfforts,
      supportsImages: request.entry.supportsImages,
      defaultMaxTokens: request.entry.defaultMaxTokens,
    }),
  }
}

export interface GlmCodingPlanAdapterOptions {
  fetchFn?: typeof fetch
  attachments?: AttachmentImageReader
  /** 多账号号池；缺省走单凭据路径（无头 host 与测试）。 */
  accountPool?: GlmCodingPlanAccountPool
}

/**
 * GLM（ZCode 账号）线路的 LlmAdapter 实现。
 *
 * 目录在进程内缓存优先：请求路径上不去打上游拉目录（那会让每一次请求都多一个往返，
 * 而且卡片打开时就能把目录同步好），实时目录只作为 `/catalog/refresh` 的产物存在。
 */
export class GlmCodingPlanAdapter extends LlmAdapter {
  // 显式声明而不是构造函数参数属性：Node 的类型擦除加载器不接受参数属性。
  private readonly store: GlmCodingPlanCredentialStore
  private readonly modelSettings: GlmCodingPlanModelSettingsStore
  private readonly preferences: GlmCodingPlanPreferenceStore | undefined
  private readonly accountPool: GlmCodingPlanAccountPool | null
  private readonly options: GlmCodingPlanAdapterOptions
  /**
   * 签名器：每个适配器实例一个。
   *
   * 握手结果与私钥按凭据缓存，而一个池里可以同时有两区多个账号，所以做成实例级而不是模块级单例。
   * 默认门控关闭时它从不被用到（`applyGlmClientSigning` 直接原样返回），
   * 换凭据时也不需要手动清——因为它按 `apiKey` 派生缓存键。
   */
  private readonly signer: GlmClientSigner
  /** 一个实例内固定复用的会话 id；每次新生成都会改变 PoW seed 与签名串。 */
  private readonly signingSessionId: string

  constructor(
    store: GlmCodingPlanCredentialStore = new GlmCodingPlanCredentialStore(),
    modelSettings: GlmCodingPlanModelSettingsStore = new GlmCodingPlanModelSettingsStore(),
    preferences?: GlmCodingPlanPreferenceStore,
    options: GlmCodingPlanAdapterOptions = {},
  ) {
    super()
    this.store = store
    this.modelSettings = modelSettings
    this.preferences = preferences
    this.options = options
    this.accountPool = options.accountPool ?? null
    this.signer = new GlmClientSigner({
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    })
    this.signingSessionId = 'dsh-glm-coding-plan'
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: PROVIDER_NAME }
  }

  providerRetryPolicy(): ResolvedRetryPolicy {
    return RETRY_POLICY
  }

  imageRequestPricing(): undefined {
    return undefined
  }

  private settings(): Promise<GlmCodingPlanModelSettings> {
    return this.preferences === undefined
      ? this.modelSettings.read()
      : Promise.resolve(this.preferences.status())
  }

  /**
   * 这个部署能调的模型。
   *
   * 进程内缓存优先、随包目录兜底：**请求路径上绝不联网**。
   * 实时目录只由 `/catalog/refresh` 与连接测试拉取，落进 `client.ts` 的缓存。
   */
  private catalog(region: GlmRegion): GlmModelEntry[] {
    const cached = getCachedCatalog(region)
    return cached.length > 0 ? cached : modelsForRegion(region, GLM_MODEL_CATALOG)
  }

  /**
   * 这一行请求用哪份凭据。
   *
   * 有池时轮转；没有池时读单凭据存储（无头 host 与测试的形态）。
   * 两条路径都不主动刷新：Coding Plan Key 不声明失效时刻（见 account-pool 的 needsRefresh）。
   */
  private async credentialFor(
    excludeIds?: ReadonlySet<string>,
  ): Promise<{ accountId: string | null; credentials: GlmCodingPlanCredentials }> {
    const fetchFn = this.options.fetchFn ?? fetch
    if (this.accountPool !== null) {
      const effective = await this.accountPool.getEffectiveCredential(excludeIds, fetchFn)
      return { accountId: effective.account.id, credentials: effective.credentials }
    }
    const stored = await this.store.read()
    if (stored === null) {
      throw new LlmError(
        '还没有登录 ' + PROVIDER_NAME + ' 账号。请在设置页点击登录，或先在 ZCode 客户端登录后使用 adopt。',
        'MISSING_CREDENTIAL',
      )
    }
    return { accountId: null, credentials: stored }
  }

  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const prov = provider || PROVIDER_ID
    const settings = await this.settings()
    if (settings.enabled === false) return []
    const pick = await this.credentialFor().catch(() => null)
    if (pick === null) return []
    const region = pick.credentials.codingPlan.region
    const available = this.catalog(region)
    const enabled = new Set(settings.enabledModelIds)
    return available
      .filter((model) => model.wire !== null && enabled.has(model.id))
      .map((model) => ({
        provider: prov,
        id: model.id,
        name: model.name,
        // 收不收图按目录逐行声明，不从模型名推断（计划 §1、§7）。
        inputModalities: model.supportsImages ? ['text', 'image'] : ['text'],
      }))
  }

  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError(PROVIDER_NAME + ' 模型解析已取消', 'ABORTED')
    const settings = await this.settings()
    const pick = await this.credentialFor().catch(() => null)
    const region: GlmRegion = pick?.credentials.codingPlan.region ?? 'intl'
    const catalog = this.catalog(region)
    const entry = resolveGlmModel(model, catalog)
    const override = settings.contextWindowOverrides[model]
    const contextWindow = typeof override === 'number' && Number.isFinite(override) && override > 0
      ? override
      : entry.defaultContextWindow
    const efforts = entry.reasoningEfforts
    // 用户配置的那一档优先；模型不认就交回上游自己的默认（发一个上游拒收的值更糟）。
    const configured = settings.defaultReasoningEffort
    const defaultEffortId = configured !== null && configured !== undefined && efforts.includes(configured)
      ? ReasoningEffortId(configured)
      : undefined
    return {
      provider,
      id: model,
      name: entry.name,
      inputModalities: entry.supportsImages ? ['text', 'image'] : ['text'],
      context: { contextWindow: contextWindow > 0 ? contextWindow : entry.defaultContextWindow },
      ...outputReservation(contextWindow > 0 ? contextWindow : entry.defaultContextWindow, entry.defaultMaxTokens),
      // 空梯子 = 该模型不接受 reasoning_effort，这时**不**声明 reasoning 段，
      // 让 DSH 知道它没有可调档位，而不是给它一个空的档位表。
      ...(efforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts: efforts.map((effort) => ({ id: ReasoningEffortId(effort), name: effort })),
              ...(defaultEffortId === undefined ? {} : { defaultEffort: defaultEffortId }),
            },
          }),
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* wrapStreamWithWatchdog(
      (watchdogSignal) => this.requestStream(options, watchdogSignal),
      options.signal,
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_CODE,
      PROVIDER_NAME,
    )
  }

  /**
   * 一次请求的完整往返：选账号 → 定协议面 → 发 → 解析流。
   *
   * 账号轮转的循环只有一处：一次 429 或一次 AUTH 会把那个账号移出本次请求，
   * 由另一个账号来发**同一份**请求体。没有池时这个循环只跑一次。
   */
  private async *requestStream(options: GenerateOptions, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const fetchFn = this.options.fetchFn ?? fetch
    const settings = await this.settings()
    // 超大图片先换成占位文本；共用共享的预算机制，与兄弟线路同一份。
    const requestOptions = offloadOldestRequestImages(normalizeGenerateOptions(options))
    const images = await resolveRequestImages(requestOptions, this.options.attachments, signal)

    const tried = new Set<string>()
    let response: Response | undefined
    let plan: GlmRequestPlan | undefined
    let picked = await this.credentialFor(tried)

    while (true) {
      if (picked.accountId !== null) tried.add(picked.accountId)
      const region = normalizeRegion(picked.credentials.codingPlan.region) ?? 'intl'
      plan = buildGlmRequestPlan(requestOptions, {
        region,
        entry: resolveGlmModel(options.model, this.catalog(region)),
        images,
      })
      const key = picked.credentials.codingPlan.codingPlanKey
      const headers = plan.wire === 'anthropic'
        ? glmAnthropicHeaders(key, plan.headers)
        : glmOpenAiHeaders(key, plan.headers)
      // 就地合并：门控关闭时原样返回、零网络请求，所以这里不需要任何分支。
      const signed = clientSigningEnabled(process.env)
        ? await applyGlmClientSigning(headers, { apiKey: key, signal }, {
          signer: this.signer,
          sessionId: this.signingSessionId,
          ...(this.options.fetchFn === undefined ? {} : { fetchFn: this.options.fetchFn }),
        })
        : headers
      const body = JSON.stringify(plan.body)

      try {
        response = await fetchWithContextBudgetRecovery(fetchFn)(plan.url, {
          method: 'POST',
          headers: signed,
          body,
          // 空闲看门狗拥有这个 deadline：它在出字时重置，所以一次又长又活跃的生成
          // 不会被一个墙钟上限砍断。
          signal,
        })
      } catch (error) {
        if (signal.aborted) throw new LlmError(PROVIDER_NAME + ' 请求已取消', 'ABORTED', { cause: error })
        throw new LlmError(
          PROVIDER_NAME + ' 请求失败：' + (error instanceof Error ? error.message : String(error)),
          'TRANSPORT',
          { cause: error },
        )
      }

      if (response.ok) break

      const detail = await response.text().catch(() => '')
      let parsedBody: unknown
      try {
        parsedBody = JSON.parse(detail) as unknown
      } catch {
        parsedBody = detail
      }
      // 错误分类**只在 mapper 里**，本文件不再写第二份：两份分类器一定会漂。
      const failure = plan.wire === 'anthropic'
        ? glmUpstreamError({ status: response.status, body: parsedBody })
        : classifyGlmOpenAiFailure(response.status, detail.slice(0, 600), response.headers)

      if (picked.accountId !== null && this.accountPool !== null) {
        const decision = glmCooldownDecision({ status: response.status, headers: response.headers, body: parsedBody })
        if (decision.cooldown) {
          await this.accountPool.markCooldown(picked.accountId, decision.durationMs, decision.reason)
            .catch(() => undefined)
          if (await this.accountPool.hasAnotherAvailableAccount(tried)) {
            picked = await this.credentialFor(tried)
            continue
          }
        } else if (failure.code === 'AUTH') {
          // 凭据被拒是**这个账号**的事：保留它（重新登录才恢复），把它移出本次请求。
          await this.accountPool.markAuthFailed(picked.accountId, failure.message).catch(() => undefined)
          if (await this.accountPool.hasAnotherAvailableAccount(tried)) {
            picked = await this.credentialFor(tried)
            continue
          }
        }
      }

      throw failure
    }

    const settled = plan!
    if (response === undefined) throw new LlmError(PROVIDER_NAME + ' 没有返回任何响应', 'PROVIDER_ERROR')
    if (response.body === null) throw new LlmError(PROVIDER_NAME + ' 返回了空响应体', 'PROVIDER_ERROR')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    if (settled.wire === 'anthropic') {
      const state = createGlmAnthropicStreamState()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            for (const chunk of processGlmAnthropicStreamLine(line, state)) yield chunk
            if (state.finished) return
          }
        }
        buffer += decoder.decode()
        if (buffer.trim() !== '') {
          for (const line of buffer.split('\n')) {
            for (const chunk of processGlmAnthropicStreamLine(line, state)) yield chunk
          }
        }
        if (state.finished) return
        // 没有终止事件就结束的流是被截断的回复，不是一份完整答案。
        if (!glmStreamHasContent(state)) {
          throw new LlmError(PROVIDER_NAME + ' 的 Anthropic 面没有返回任何内容', 'PROVIDER_ERROR')
        }
        assertGlmStreamComplete(state)
        for (const chunk of closeGlmAnthropicStream(state)) yield chunk
      } finally {
        void reader.cancel().catch(() => undefined)
      }
      return
    }

    const state = createStreamState()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          for (const chunk of processStreamLine(line, state)) yield chunk
          if (state.finished) return
        }
      }
      buffer += decoder.decode()
      if (buffer.trim() !== '') {
        for (const line of buffer.split('\n')) {
          for (const chunk of processStreamLine(line, state)) yield chunk
        }
      }
      if (state.finished) return
      assertStreamComplete(state)
      for (const chunk of closeStream(state)) yield chunk
    } finally {
      void reader.cancel().catch(() => undefined)
    }
  }
}
