/**
 * Qoder（订阅）线路的 DSH 适配器。
 *
 * 形状与 Step Code / GLM 同构（\`extends LlmAdapter\`：listModels / resolveModel /
 * prepareCall / stream / catalog / credentialFor），但它**不碰任何协议细节**：
 *
 * - 请求体、流解析、用量与错误分类全部来自 \`./mapper.ts\`；
 * - COSY 签名与 body 编码全部来自 \`./cosy.ts\`；
 * - URL 与目录缓存全部来自 \`./client.ts\`；
 * - 目录的归一化全部来自 \`./model-catalog.ts\`。
 *
 * 也就是说本文件只回答三件事：**这一行请求用哪个目录行**、**用哪把凭据**、
 * **失败之后换不换账号**。任何一份签名、编码或 JSON 解析在这里出现第二遍，
 * 就等于给线路造了第二条会漂移的真相。
 *
 * 三处刻意如此：
 *
 * 1. **凭据只在 \`credentialFor()\` 一处取。** 有号池时轮转（核心自己处理刷新），
 *    没有池时读单凭据存储（无头 host 与测试的形态）。
 * 2. **请求路径不联网。** 目录只读 \`client.ts\` 的进程内缓存，随包目录兜底；
 *    实时目录是 \`/catalog/refresh\` 与登录/adopt 的产物。
 * 3. **缓存用量在本进程累计。** 累计器住在本文件（流的末端是唯一知道用量帧的地方），
 *    \`/status\` 由 \`readQoderCacheStats()\` 读它；路由不另算第二套口径。
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
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  STREAM_IDLE_TIMEOUT_CODE,
  STREAM_IDLE_TIMEOUT_MS,
  wrapStreamWithWatchdog,
  type StreamActivity,
} from '../common/idle-watchdog.ts'
import {
  normalizeGenerateOptions,
  type GenerateOptions as NormalizedGenerateOptions,
} from '../common/llm-compat.ts'
import { outputReservation } from '../common/output-reservation.ts'
import { requestImageTargetOrOriginal, type AttachmentImageReader } from '../common/request-images.ts'
import { retryAfterMs } from '../wire-auth.ts'
import {
  clearCachedQoderModelCatalog,
  getCachedQoderModelCatalog,
  getQoderCosyVersion,
  qoderCatalogIsLive,
  qoderChatUrl,
  qoderCosyIdentityOf,
  type QoderUpstreamCredential,
} from './client.ts'
import { buildQoderCosyHeaders, encodeQoderBody } from './cosy.ts'
import {
  bundledQoderCatalog,
  catalogSize,
  convergeQoderEnabledModelIds,
  defaultContextWindowFor,
  maxOutputTokensFor,
  resolveQoderModel,
  type QoderModelEntry,
} from './model-catalog.ts'
import {
  assertQoderStreamComplete,
  buildQoderChatRequest,
  classifyQoderFailure,
  closeQoderStream,
  createQoderStreamState,
  offloadOldestQoderRequestImages,
  processQoderStreamLine,
  qoderRequestOptionsFor,
  resolveRequestImages,
} from './mapper.ts'
import {
  QoderCredentialStore,
  QoderModelSettingsStore,
  type QoderCredentials,
  type QoderModelSettings,
  type QoderPreferenceStore,
} from './token-store.ts'
import type { QoderAccountPool } from './account-pool.ts'
import { PROVIDER_ID, PROVIDER_NAME } from './types.ts'
import type { QoderCacheStatsDto, QoderRegion } from '../../shared/qoder-contracts.ts'

/**
 * 这条路由的瞬时故障重试策略，与兄弟线路逐字一致。
 *
 * 刻意不在集合里：AUTH（被拒的 token 每次都一样，而它只能重新授权）、
 * PROVIDER_ERROR（400 或套餐拒绝）、ABORTED（调用方自己取消）。
 */
export const QODER_RETRY_POLICY_CONFIG: {
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
  QODER_RETRY_POLICY_CONFIG,
  'dsh-chatgpt-subscription.qoder.retry',
)

/** 上游没有给 Retry-After 时，一次 429 按 5 分钟冷却。 */
export const QODER_POOL_COOLDOWN_MS = 5 * 60 * 1000

/**
 * 这个部署能调的模型：**进程内缓存优先、随包目录兜底，请求路径上绝不联网**。
 *
 * 实时目录由 \`/catalog/refresh\`、登录/adopt，以及 \`GET /status\` **应答背后**
 * 的那次自动刷新产生（见 routes.ts）；本函数自己一次请求都不发——
 * 让每一次模型解析都去打上游只会把设置页变成一条压测。
 */
export function cachedQoderModelCatalog(region: QoderRegion): readonly QoderModelEntry[] {
  const runtime = getCachedQoderModelCatalog(region)
  return runtime.length > 0 ? runtime : bundledQoderCatalog(region)
}

/**
 * 一行的白名单该按哪一套规则收敛；**口径只有这一处**。
 *
 * 适配器的过滤（listModels）与状态面的勾选标记（getQoderStatus）都从这里读，
 * 免得两边各写一份「兜底阶段要不要按白名单筛」而慢慢漂开。
 *
 * - 实时目录：按白名单收敛 + 过滤（上游下线一个模型后，那份残留 id 不该再占名额，
 *   也不该让「已选 N / M」的分子大于目录条目数）；
 * - 兜底表：**不按白名单筛**，全部返回（它是能力占位，且与白名单不是同一套 id
 *   词汇表——见 client.ts 的 qoderCatalogIsLive）；
 * - `[]`（用户明确全关）与 `null`（不过滤）在两种阶段下的含义都不变：全关就是全关。
 *
 * @param stored 用户存下来的选择（三态）。
 * @param live   当前拿到的是实时目录（true）还是随包兜底表（false）。
 * @param catalog 当前这一份目录（兜底阶段它只用来决定「有没有条目可给」）。
 * @returns 收敛后的白名单；`null` = 不过滤。
 */
export function convergeQoderSelection(
  stored: readonly string[] | null,
  live: boolean,
  catalog: readonly QoderModelEntry[],
): string[] | null {
  if (live) return convergeQoderEnabledModelIds(stored, catalog.map((entry) => entry.id))
  // 兜底表阶段只有 `[]` 还能表达出确定的意思（全关），其余一律当成「不过滤」：
  //
  // - `null`（没挑过）本来就是不过滤，原样返回 null；
  // - 非空白名单**不能**拿去筛兜底表，也不能原样交回给调用方去筛——两种写法结果一样，
  //   都是「按一套错词汇过滤」，于是本函数的下游（listModels）返回 0 个模型，
  //   DSH 把整个 provider 分组过滤掉。所以这里直接返回 null：占位期间全部可用。
  return stored === null || stored.length > 0 ? null : []
}

/**
 * 设置卡片渲染的模型总数（hub 概览用；取两区随包表的较大者）。
 *
 * ⚠ 它**不带区域**，所以只适合当「这条线路大概有几个模型」的量级读数。
 * 需要与勾选收敛对齐时用 {@link cachedQoderModelCatalog}（按区取，分子分母同源）。
 */
export function qoderCatalogSize(): number {
  return catalogSize(getCachedQoderModelCatalog().length > 0
    ? getCachedQoderModelCatalog()
    : bundledQoderCatalog('global'))
}

// ---------------------------------------------------------------------------
// 进程内缓存用量累计
// ---------------------------------------------------------------------------

interface QoderCacheTotals {
  /** 本轮聚合的 prompt token（未命中 + 缓存读入 + 写侧）。 */
  promptTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  requests: number
}

/**
 * 本进程累计的缓存用量。
 *
 * 写成模块级而不是适配器实例级，是因为契约里的 \`QoderStatusDto.cacheStats\` 说的是
 * 「本进程累计」（同 step-code 的同名累计器的理由）。
 */
let cacheTotals: QoderCacheTotals = {
  promptTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  requests: 0,
}

/** 记下一次请求的用量（流读到终止帧之后调用）。 */
export function rememberQoderCacheUsage(usage: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}): void {
  cacheTotals = {
    promptTokens: cacheTotals.promptTokens + usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    cacheReadTokens: cacheTotals.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: cacheTotals.cacheWriteTokens + usage.cacheWriteTokens,
    requests: cacheTotals.requests + 1,
  }
}

/**
 * 卡片要的那份切片；**尚无样本时返回 undefined**。
 *
 * 「还没有样本」与「样本全都没命中」必须能被区分：契约里 \`cacheStats\` 是可选的，
 * 客户端把缺失渲染成占位符、把 0 渲染成真实的 0%，所以这里绝不下发一个全 0 的对象。
 */
export function readQoderCacheStats(): QoderCacheStatsDto | undefined {
  if (cacheTotals.requests === 0) return undefined
  return {
    cacheReadTokens: cacheTotals.cacheReadTokens,
    missedInputTokens: Math.max(0, cacheTotals.promptTokens - cacheTotals.cacheReadTokens - cacheTotals.cacheWriteTokens),
    cacheWriteTokens: cacheTotals.cacheWriteTokens,
    requests: cacheTotals.requests,
  }
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

/** 一行请求要用的凭据：发请求只需要 client.ts 认得的那份切片。 */
export interface QoderPickedCredential {
  /** 号池里的账号 id；无池（单凭据路径）时为 null。 */
  accountId: string | null
  credentials: QoderUpstreamCredential
}

export interface QoderAdapterOptions {
  fetchFn?: typeof fetch
  attachments?: AttachmentImageReader
  /** 多账号号池；缺省走单凭据路径（无头 host 与测试）。 */
  accountPool?: QoderAccountPool
}

/** 单凭据存储读出的凭据 → 上游面认得的切片。 */
function upstreamCredentialOf(credentials: QoderCredentials): QoderUpstreamCredential {
  return {
    accessToken: credentials.accessToken,
    region: credentials.region,
    uid: credentials.uid,
    email: credentials.email,
    accountName: credentials.accountName,
    organizationId: credentials.organizationId,
    organizationTags: credentials.organizationTags,
    dataPolicyAgreed: credentials.dataPolicyAgreed,
  }
}

/**
 * Qoder（订阅）线路的 LlmAdapter 实现。
 *
 * 请求面只有一个：COSY 签名的 SSE 对话端点（两区同一协议面，区域由凭据决定），
 * 所以本文件里**没有**协议面判定——URL 由 client.ts 从凭据的区域得出。
 */
export class QoderAdapter extends LlmAdapter {
  // 显式声明而不是构造函数参数属性：Node 的类型擦除加载器不接受参数属性。
  private readonly store: QoderCredentialStore
  private readonly modelSettings: QoderModelSettingsStore
  private readonly preferences: QoderPreferenceStore | undefined
  private readonly accountPool: QoderAccountPool | null
  private readonly options: QoderAdapterOptions

  constructor(
    store: QoderCredentialStore = new QoderCredentialStore(),
    modelSettings: QoderModelSettingsStore = new QoderModelSettingsStore(),
    preferences?: QoderPreferenceStore,
    options: QoderAdapterOptions = {},
  ) {
    super()
    this.store = store
    this.modelSettings = modelSettings
    this.preferences = preferences
    this.options = options
    this.accountPool = options.accountPool ?? null
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

  imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef) {
    return requestImageTargetOrOriginal(image)
  }

  private settings(): Promise<QoderModelSettings> {
    return this.preferences === undefined
      ? this.modelSettings.read()
      : Promise.resolve(this.preferences.status())
  }

  /** 这个部署的目录行（缓存优先，请求路径不联网）。 */
  private catalog(region: QoderRegion): readonly QoderModelEntry[] {
    return cachedQoderModelCatalog(region)
  }

  /**
   * 这一行请求用哪份凭据。
   *
   * 有池时轮转（核心自己做刷新）；没有池时读单凭据存储（无头 host 与测试的形态）。
   */
  private async credentialFor(excludeIds?: ReadonlySet<string>): Promise<QoderPickedCredential> {
    const fetchFn = this.options.fetchFn ?? fetch
    if (this.accountPool !== null) {
      const effective = await this.accountPool.getEffectiveCredential(excludeIds, fetchFn)
      return {
        accountId: effective.account.id,
        credentials: upstreamCredentialOf(effective.credentials),
      }
    }
    const stored = await this.store.read()
    if (stored === null) {
      throw new LlmError(
        '还没有登录 ' + PROVIDER_NAME
        + ' 账号。请在设置页点击登录（全球区）、粘贴 PAT，或在本机 qodercli 登录后使用导入。',
        'MISSING_CREDENTIAL',
      )
    }
    return { accountId: null, credentials: upstreamCredentialOf(stored) }
  }

  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const prov = provider || PROVIDER_ID
    const settings = await this.settings()
    // 总开关关掉后本线路在选择器里一个模型都不出现（与兄弟线路逐字一致）。
    if (settings.enabled === false) return []
    const picked = await this.credentialFor().catch(() => null)
    if (picked === null) return []
    const region = picked.credentials.region
    const available = this.catalog(region)
    // 三态：null / undefined = 不过滤（全选），[] = 用户全关，非空 = 白名单。
    //
    // **收敛只在实时目录上做，兜底表不做白名单过滤。** 理由是两套 id 词汇表不是同一套：
    // 白名单是用户对着**某一版实时目录**勾出来的 id（= 上游 display_name 去空白），而随包
    // 兜底表照录 pi-provider 的静态表，同一批模型在两边叫法不同（`DeepSeek-Flash` 对
    // `DeepSeek-V4-Flash`、`Qwen3.8-Flash` 对 `Qwen3.8-Max`/Plus，证据见
    // client.ts 的 qoderCatalogIsLive）。冷启动时进程里没有实时目录、只有兜底表，拿白名单
    // 去筛它必然收敛成 `[]`，于是本函数返回 0 个模型——DSH 会把整个 provider 分组过滤掉，
    // 模型选择器里连 Qoder 都不剩（这就是「重启后 Qoder 整个消失」）。
    //
    // 兜底表是**能力占位**，不是这个账号此刻真实可用的集合，用一份只对某一版目录有意义的
    // 白名单去筛它没有意义：占位期间让全部模型都能被选中是可接受的，实时目录一到就收敛成
    // 真实集合（那时白名单与目录同源，收敛才有内容）。
    //
    // 唯一的例外是 `[]`：全关是**用户明确的意图**，与词汇表无关，兜底阶段同样生效。
    const selected = convergeQoderSelection(
      settings.enabledModelIds ?? null,
      qoderCatalogIsLive(region),
      available,
    )
    const allow = selected === null ? null : new Set(selected)
    return available
      .filter((model) => allow === null || allow.has(model.id))
      .map((model) => ({
        provider: prov,
        id: model.id,
        name: model.name,
        // 收不收图按目录逐行声明（is_vl），不从模型名推断。
        inputModalities: model.supportsImages ? ['text', 'image'] : ['text'],
      }))
  }

  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError(PROVIDER_NAME + ' 模型解析已取消', 'ABORTED')
    const settings = await this.settings()
    const picked = await this.credentialFor().catch(() => null)
    const region = picked?.credentials.region ?? 'global'
    const catalog = this.catalog(region)
    const entry = resolveQoderModel(model, catalog, region)
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
      ...outputReservation(
        contextWindow > 0 ? contextWindow : entry.defaultContextWindow,
        maxOutputTokensFor(model, catalog),
      ),
      // 空梯子 = 该模型不接受 reasoning_effort，这时**不**声明 reasoning 段。
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
      (watchdogSignal, activity) => this.requestStream(options, watchdogSignal, activity),
      options.signal,
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_CODE,
      PROVIDER_NAME,
    )
  }

  /**
   * 一次请求的完整往返：选账号 → 定目录行 → 编码+签名 → 发 → 解析信封流。
   *
   * 账号轮转的循环只有一处：一次 429 或一次 AUTH 会把那个账号移出本次请求，
   * 由另一个账号来发**同一份**请求体。没有池时这个循环只跑一次。
   *
   * 编码与签名的顺序是协议事实（inference-protocol.md §3-§4）：先 JSON.stringify
   * 一次拿到字节，codec 编码这同一份字节，签名覆盖编码后的字符串——任何中间的
   * 一道 re-marshal 都会让签名的字节与发送的字节漂移。
   */
  private async *requestStream(
    options: GenerateOptions,
    signal: AbortSignal,
    activity?: StreamActivity,
  ): AsyncGenerator<StreamChunk> {
    const fetchFn = this.options.fetchFn ?? fetch
    const settings = await this.settings()
    // 超大图片先换成占位文本；共用 mapper 的既有接缝，与兄弟线路同一份。
    const requestOptions = offloadOldestQoderRequestImages(normalizeGenerateOptions(options))
    const images = await resolveRequestImages(requestOptions, this.options.attachments, signal)

    const tried = new Set<string>()
    let response: Response | undefined
    let picked = await this.credentialFor(tried)

    while (true) {
      if (picked.accountId !== null) tried.add(picked.accountId)
      const region = picked.credentials.region
      const catalog = this.catalog(region)
      const entry = resolveQoderModel(options.model, catalog, region)
      const wireOptions = qoderRequestOptionsFor(entry, {
        defaultMaxTokens: maxOutputTokensFor(options.model, catalog),
      })
      // 请求体拼一次、串行化一次；编码与签名都吃这同一份字节。
      const bodyText = JSON.stringify(buildQoderChatRequest(
        requestOptions,
        images,
        wireOptions,
        {
          modelKey: entry.upstreamKey,
          entry,
          cosyVersion: getQoderCosyVersion(),
          sessionId: options.sessionId,
        },
      ))
      const encodedBody = encodeQoderBody(bodyText)
      const url = qoderChatUrl(region)
      const identity = qoderCosyIdentityOf(picked.credentials)
      const headers = buildQoderCosyHeaders(identity, {
        encodedBody,
        url,
        accept: 'text/event-stream',
        withContentType: true,
        modelKey: entry.upstreamKey,
        modelSource: entry.source,
      })

      try {
        response = await fetchFn(url, {
          method: 'POST',
          headers,
          body: encodedBody,
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
      // 错误分类**只在 mapper 里**，本文件不再写第二份：两份分类器一定会漂。
      const failure = classifyQoderFailure(response.status, detail.slice(0, 600))

      if (picked.accountId !== null && this.accountPool !== null) {
        if (failure.code === 'RATE_LIMIT') {
          const after = retryAfterMs(response.headers)
          await this.accountPool
            .markCooldown(picked.accountId, after ?? QODER_POOL_COOLDOWN_MS, PROVIDER_NAME + ' 429：上游限流或额度用尽')
            .catch(() => undefined)
          if (await this.accountPool.hasAnotherAvailableAccount(tried)) {
            picked = await this.credentialFor(tried)
            continue
          }
        } else if (failure.code === 'AUTH') {
          // 凭据被拒是**这个账号**的事：保留它（重新授权才恢复），把它移出本次请求。
          await this.accountPool.markAuthFailed(picked.accountId, failure.message).catch(() => undefined)
          if (await this.accountPool.hasAnotherAvailableAccount(tried)) {
            picked = await this.credentialFor(tried)
            continue
          }
        }
      }

      throw failure
    }

    if (response === undefined) throw new LlmError(PROVIDER_NAME + ' 没有返回任何响应', 'PROVIDER_ERROR')
    if (response.body === null) throw new LlmError(PROVIDER_NAME + ' 返回了空响应体', 'PROVIDER_ERROR')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const state = createQoderStreamState()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        // 传输层收到字节就是连接还活着的证据：心跳帧不产生任何可展示 chunk，
        // 计时判据因此下沉到传输层，而不是解析器是否产出。
        if (value !== undefined && value.byteLength > 0) activity?.pulse()
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          // 每个完整帧各上报一次；纯注释帧正是展示层计时会误判成静默的那种。
          activity?.pulse()
          for (const chunk of processQoderStreamLine(line, state)) yield chunk
          if (state.finished) return
        }
      }
      buffer += decoder.decode()
      if (buffer.trim() !== '') {
        for (const line of buffer.split('\n')) {
          for (const chunk of processQoderStreamLine(line, state)) yield chunk
        }
      }
      if (state.finished) return
      // 没有终止事件的流是被截断的回复，不是一份完整答案。
      assertQoderStreamComplete(state)
      for (const chunk of closeQoderStream(state)) yield chunk
    } finally {
      // 缓存用量在这里记账：流的末端是唯一同时知道「这次请求有没有用量帧」的地方，
      // 而没有用量帧的一拍不计入样本（否则 requests 会把没报用量的请求算进来）。
      if (state.sawUsage) {
        rememberQoderCacheUsage({
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
          cacheReadTokens: state.cacheReadTokens,
          cacheWriteTokens: state.cacheWriteTokens,
        })
      }
      void reader.cancel().catch(() => undefined)
    }
  }
}

export { clearCachedQoderModelCatalog, PROVIDER_ID, PROVIDER_NAME }
