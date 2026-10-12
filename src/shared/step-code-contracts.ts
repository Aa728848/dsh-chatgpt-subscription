/**
 * Step Code（Step Plan 订阅）线路的共享契约。
 *
 * host 与 client 两半只依赖本文件的类型与常量，互不 import。
 * 本文件由调度者冻结：类型名与常量名不得更改，可追加。
 *
 * 边界精神与 `account-pool-contracts.ts` 首行一致：这里的一切都是公开信息，
 * **任何凭据都不越过这条边界**。Step 的四种凭据——云端轮询换到的 `credential.api_key`、
 * 手动粘贴的 Platform API Key、adopt 读到的 `~/.stepcode/auth.json` 快照、开发者中心的
 * `Oasis-Token`——一律不出现在下列任何类型里。手工粘贴与账号密码登录的请求体也正因如此
 * **刻意不在本文件声明**：它必然带凭据，由 host 侧自行解析，不进冻结契约。
 * 与之配套的是 `StepCodeQuotaCredentialStatusDto`：它只下发「有没有、从哪来」，
 * 凭据本身仅存在于 host。
 *
 * 取值依据：`docs/step-code-line-plan.md` §1/§2/§3/§4/§5，以及只读参照
 * 官方 Step-Code 源码（`packages/coding-agent/src/step/onboarding.ts`、
 * `packages/providers/src/step-provider/{index,login-client,login-polling}.ts`、
 * `packages/coding-agent/docs/step-integration.md:81-86`、
 * `packages/providers/src/api/openai-completions.ts:799,1496-1529`）。
 */

import type {
  AccountPoolStatusDto,
  PoolAccountSummaryDto,
} from './account-pool-contracts.ts'

/** 线路 id。与官方客户端的 `step` 不同名，也不与既有任何线路重名。 */
export const STEP_CODE_PROVIDER_ID = 'step-code'

/** 设置卡片与 hub 卡片上显示的名字。 */
export const STEP_CODE_PROVIDER_NAME = 'Step Code（Step Plan 订阅）'

/**
 * 路由前缀（host 暴露、client 消费）。
 *
 * 与其余各订阅线路一致：每条线路把自己的设置面挂在 `/<line>/api` 下，
 * 不挂到 Codex 那条线路的 `/api/dsh-chatgpt-subscription` 前缀下面。
 */
export const STEP_CODE_ROUTE_PREFIX = '/step-code/api'

/**
 * 凭据 profile：线路里唯一的「凭据种类 + 区域」联合。
 *
 * 取值与官方 `STEP_LOGIN_PROFILE_IDS`（`step/onboarding.ts:3`）**逐字相同**，一个不多一个不少。
 * 四行各有各的模型 base 与授权 base（见 `docs/step-integration.md:81-86` 的表），
 * 官方把「一条 profile 自带它的两个端点与它的环境变量覆盖」写成一条规则
 * （`onboarding.ts:23-27` 的注释：so adding a region cannot silently inherit
 * another region's endpoint），本线路照抄同一结构，不在调用处按区域另拼端点。
 *
 * - `step_plan`：国区 Step Plan 订阅，凭据来自浏览器授权，消耗订阅额度。
 * - `step_plan_oversea`：国际区 Step Plan 订阅，凭据来自浏览器授权。
 * - `platform_cn`：国区开放平台 API Key，按量计费。
 * - `platform_oversea`：国际区开放平台 API Key，按量计费。
 */
export type StepCodeProfile = 'step_plan' | 'step_plan_oversea' | 'platform_cn' | 'platform_oversea'

/**
 * 全部 profile，声明顺序即设置页的默认顺序。
 *
 * 它是**线路认识的凭据清单**，不是模型清单，也不是凭据优先级。
 */
export const STEP_CODE_PROFILES: readonly StepCodeProfile[] = [
  'step_plan',
  'step_plan_oversea',
  'platform_cn',
  'platform_oversea',
]

/**
 * 账号所属区域。
 *
 * `api.stepfun.ai` 与 `api.stepfun.com` 互不通用：国际区凭据打国区端点会被拒。
 * 区域因此是**凭据的属性**而不是请求的属性，一个号池可以同时持有两区账号且互不串用
 * （计划 §1、§10 风险 6）。它由 profile 唯一决定，所以本线路不给它自由输入。
 */
export type StepCodeRegion = 'cn' | 'intl'

/**
 * profile → 区域。
 *
 * 这是四行 profile 表里**唯一**由 profile 自述、无需再查端点的映射，所以放进共享契约：
 * host 与 client 都要在只拿到 profile 的场合回答区域（卡片列、区域徽标、
 * 跨区报错的措辞），两份实现各写一张表就是一次漂移。
 *
 * 逐条照抄官方 `PROFILE_DEFINITIONS`（`step/onboarding.ts:33-83`）的域名：
 * `.com` 是国区、`.ai` 是国际区。
 */
const REGION_BY_PROFILE: Readonly<Record<StepCodeProfile, StepCodeRegion>> = {
  step_plan: 'cn',
  step_plan_oversea: 'intl',
  platform_cn: 'cn',
  platform_oversea: 'intl',
}

/** 一个 profile 属于哪个区域；profile 已在联合类型上，这里不做运行时校验。 */
export function stepCodeRegionOf(profile: StepCodeProfile): StepCodeRegion {
  return REGION_BY_PROFILE[profile]
}

/** 参数是否是本线路认识的 profile（供 route 层校验自由输入）。 */
export function isStepCodeProfile(value: unknown): value is StepCodeProfile {
  return typeof value === 'string' && (STEP_CODE_PROFILES as readonly string[]).includes(value)
}

/** 参数是否是本线路认识的区域（供 route 层校验自由输入）。 */
export function isStepCodeRegion(value: unknown): value is StepCodeRegion {
  return value === 'cn' || value === 'intl'
}

/**
 * 本线路能命名的思考档位。
 *
 * 取值就是 DSH 的完整档位词汇，而不是上游那一档或几档：上游不认识的档位一律被
 * `convergeStepCodeEffort`（host 侧 `types.ts`）收敛到**模型真实梯子**上再发出去，
 * 两份词汇表是分开的——详见 `STEP_CODE_REASONING_EFFORTS` 的注释。
 */
export type StepCodeReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * 线路级档位词汇表，从低到高。
 *
 * 设置卡片只渲染这一份列表——它是**线路级词汇表**，不是某个模型的能力表。
 * 某个模型真实接受哪些档位由 `StepCodeModelOption.reasoningEfforts` 单独给出；
 * 把两者合成一份会让卡片在给一个只认两档的模型显示六档时，
 * 无从判断是模型不支持还是文案没写。
 *
 * 它比上游宽是**故意的**：上游的 `reasoning_effort_support_list` 是逐模型声明的
 * （未在列表里的档位映射为「不支持」，含关闭值），所以宽表在本地收敛即可，
 * 而窄表一旦上游加了新档位就无处安放。
 */
export const STEP_CODE_REASONING_EFFORTS: readonly StepCodeReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/** 档位参数是否是本线路词汇表里的值（供 route 层校验自由输入）。 */
export function isStepCodeReasoningEffort(value: unknown): value is StepCodeReasoningEffort {
  return typeof value === 'string' && (STEP_CODE_REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * 额度窗口的稳定标识。
 *
 * 两条取值分属**两代套餐**，上游同时在用，所以是三个而不是两个：
 *
 * - `five-hour`：老式 5 小时滚动窗口（载荷字段 `five_hour_usage_left_rate`）。
 * - `weekly`：老式周窗口（载荷字段 `weekly_usage_left_rate`）。
 * - `credit`：现行 Credit 池（`plan_credit_rate_limit.credit_buckets[]`）。
 *
 * 刻意是封闭联合而不是自由字符串：上游给出一个认不出的窗口时**不下发、不发明**
 * （本线路按载荷形状判定两代套餐，不单信 `plan_family`），做成 `string`
 * 等于把「不发明」这条规则从类型上撤掉。
 */
export type StepCodeQuotaWindowKey = 'five-hour' | 'weekly' | 'credit'

/** 一个额度窗口。 */
export interface StepCodeQuotaWindow {
  /** 线路自己的窗口标识，由客户端本地化成窗口名。 */
  key: StepCodeQuotaWindowKey
  /** 已用百分比，0-100。上游没给出有界额度时为 null（不是 0%）。 */
  usedPercent: number | null
  /** 该窗口重置的绝对时刻（Unix 毫秒）；上游未给出时为 null。 */
  resetsAt: number | null
}

/**
 * 一个 Credit 桶。
 *
 * 新式套餐（`plan_family=2`）把额度拆成若干桶（订阅额度 / 充值额度 …），
 * 每个桶有自己的总额、剩余与失效时刻。它们不是「窗口」——窗口有已用百分比，
 * 桶有绝对量，所以两种形状分别建模，不硬塞进同一张进度条。
 */
export interface StepCodeQuotaBucket {
  /** 该桶的总额度。 */
  total: number
  /** 该桶的剩余额度。 */
  remaining: number
  /** 该桶额度的失效时刻（Unix 毫秒）；上游未给出时为 null。 */
  expiresAt: number | null
  /** 该桶的重置时刻（Unix 毫秒）；上游未给出时为 null。 */
  resetsAt: number | null
}

/**
 * 某一时刻的整份额度快照。
 *
 * `kind` 如实记录读到的是哪一代套餐，而不是把两代揉成一份「看起来一样」的形状：
 * 老式账号只有两个窗口，新式账号只有 Credit 桶，混在一起会让卡片画出一条
 * 上游从没说过存在的进度条。
 */
export interface StepCodeQuotaSnapshotDto {
  /**
   * 读到的是哪一代载荷。
   *
   * - `windowed`：老式的 5 小时 / 周窗口。
   * - `credit`：新式的 Credit 月池。
   * - `unknown`：两端都认不出来（上游改版、或账号根本没有 Step Plan 套餐）。
   */
  kind: 'windowed' | 'credit' | 'unknown'
  /** 展示用套餐名；上游未给出时为 null。 */
  planName: string | null
  /** `plan_family` 的机器值（新式为 2）；上游未给出时为 null。 */
  planFamily: number | null
  windows: StepCodeQuotaWindow[]
  creditBuckets: StepCodeQuotaBucket[]
  /** 套餐续费时刻（Unix 毫秒）；上游未给出时为 null。 */
  renewsAt: number | null
  /** 本次读取时刻（Unix 毫秒），卡片据此判断数据新旧。 */
  fetchedAt: number
  /** 实际应答的端点路径，供设置卡片诊断。 */
  sources: string[]
  /** 这份快照是在哪个区域的开发者中心读到的。 */
  region: StepCodeRegion
}

/**
 * 设置卡片渲染的一行模型（图标 + 名称 + 一句话描述 + 行尾勾）。
 *
 * 能力**不得从模型名推断**（计划 §3）：本线路的目录完全靠运行时发现，随包表刻意为空
 * （见 host 侧 `model-catalog.ts`），拿不出证据的字段一律走端点字段或兜底值。
 */
export interface StepCodeModelOption {
  id: string
  name: string
  /** 一句话能力描述：思考形态 / 可选档位 / 输入模态 / 上下文窗口。 */
  hint: string
  /** 是否由 DSH 提供给会话模型选择器。 */
  enabled: boolean
  /** 目录声明的默认上下文窗口（token）。 */
  defaultContextWindow: number
  /** 生效窗口：有覆盖值时用覆盖值，否则等于 `defaultContextWindow`。 */
  contextWindow: number
  /** 调用方不指定时，本线路请求的输出上限（端点不报输出上限，默认等于上下文窗口）。 */
  defaultMaxTokens: number
  /**
   * 该模型**真实**接受的思考档位；空数组表示它不接受 `reasoning_effort`。
   *
   * 这是「模型真实梯子」，与 `STEP_CODE_REASONING_EFFORTS`（线路级词汇表）是两回事。
   */
  reasoningEfforts: readonly StepCodeReasoningEffort[]
  /** 思考能否关闭。与上一条正交：档位非空而本项为 false = 恒定开启。 */
  thinkingDisableable: boolean
  /** 是否接受 image 输入。 */
  supportsImages: boolean
  /** 目录报的 `max_input_tokens`；端点未报时等于 `defaultContextWindow`。 */
  maxInputTokens: number
  /** 服务该模型线的 profile（同一 id 在两条 profile 上的可用性可能不同）。 */
  profiles: readonly StepCodeProfile[]
  /** 官方描述；目录没有时为 null。 */
  description: string | null
}

/**
 * 一个池内账号的展示行。
 *
 * 扩展共享的 `PoolAccountSummaryDto`，因此同样只带非机密信息：
 * 这里没有任何字段派生自 api_key、Oasis-Token 或账号密码，连 Key 的片段也不给。
 */
export interface StepCodeAccountSummaryDto extends PoolAccountSummaryDto {
  /** 该账号登录的 profile；区域属于凭据，池内可混有 cn 与 intl。 */
  profile: StepCodeProfile
  region: StepCodeRegion
  /** 控制台侧的账号显示名。 */
  accountName?: string
}

/**
 * 云端轮询登录流程的实时状态，卡片轮询它。
 *
 * 这条线路**不开本地回调端口**：流程跑在 host 上，卡片只跟随这里
 * （与其余各线路的登录面同构）。用户在浏览器里人工确认，host 轮询取回凭据。
 *
 * `authorizeUrl` 始终下发，即使 host 同时打开过浏览器——启动失败时用户还能手动打开。
 */
export interface StepCodeLoginFlowStatus {
  status: 'idle' | 'pending' | 'complete' | 'error'
  /** 本次流程要登录的 profile。 */
  profile?: StepCodeProfile
  /** 浏览器必须打开的授权页（`{authBase}/cli-login-remote?flow_id=…`，由客户端自己拼）。 */
  authorizeUrl?: string
  startedAt?: number
  completedAt?: number
  /** 上游 `expires_at` 换算出的绝对时刻（Unix 毫秒）；总超时以它为上界。 */
  expiresAt?: number
  /** 上游 `poll_interval_sec`（已 clamp 到 ≤60）；客户端据此显示「每 N 秒查询一次」。 */
  pollIntervalSec?: number
  /** pending 阶段的人类可读进度。 */
  progress?: string
  /** 流程完成后拿到的账号标识（上游可选的 `uid`，已按长度与字符集过滤）。 */
  uid?: string
  /** 失败原因（面向用户，不是堆栈）。 */
  error?: string
  /**
   * 本次失败是否值得自动回落。
   *
   * 重试判读（官方 `isRetryableStepCliLoginError`，`login-client.ts:100-105`）：
   * `protocol` 类（2xx 但形状/字段值不合协议）**永不重试**；`transport`（请求根本没拿到响应）
   * 重试；`http` 仅 408 / 429 / ≥500 重试。其余一律致命。
   */
  retryable?: boolean
}

/** 设置面接受的补丁。 */
export interface StepCodeSettingsUpdateDto {
  enabled?: boolean
  enabledModelIds?: string[]
  /** 数字表示为该模型设置覆盖值；`null` 恢复目录默认。 */
  contextWindowOverrides?: Record<string, number | null>
  /** `null` 表示各模型用自己的默认档位。 */
  defaultReasoningEffort?: StepCodeReasoningEffort | null
  /** 手动指定下一个请求使用的账号；`null` 交回号池调度。 */
  selectedAccountId?: string | null
  /**
   * 是否在请求里发送缓存参数（见本文件的缓存一节）。
   *
   * 默认 false，与官方一致：官方对 Step 端点**不发任何缓存参数**，
   * `prompt_cache_key` 的发出条件硬绑 `baseUrl.includes('api.openai.com')`
   * （`openai-completions.ts:799`）。把它做成默认关的能力位，是为了对未文档化字段零风险，
   * 等真实账号实测过端点接受度再决定要不要打开。
   */
  cacheRequestParams?: boolean
}

/** 显式连通性测试的结果。 */
export interface StepCodeConnectionDto {
  connected: boolean
  /** 探测请求的往返耗时。 */
  latencyMs: number
  /** 探测用到的账号；未登录时为 null。 */
  account: StepCodeAccountSummaryDto | null
  /** 探测所用的模型。 */
  model: string | null
  checkedAt: number
  /** 失败原因（面向用户）。 */
  error?: string
}

/**
 * adopt（本机已登录的 stepcode 客户端登录态）的一次尝试结果。
 *
 * adopt 只是省一次登录的快捷路径，**失败永不阻断**：每个 `reason` 对应一种
 * 「换一条路登录」的说明，卡片据此给出不同的下一步。
 */
export interface StepCodeAdoptResultDto {
  /** 是否真的尝试了 adopt（没找到凭据文件时为 false）。 */
  attempted: boolean
  /** 是否拿到可用登录态。 */
  adopted: boolean
  /**
   * 失败原因。
   *
   * `not-a-stepcode-login` 是「文件在、也能解析，但里面不是 Step 的登录态」
   * （例如同一份 auth.json 里别的 provider 条目），与 `unsupported-shape`
   * （读懂了但形状不认识）分开，因为前者的下一步是换一种凭据方式，
   * 后者的下一步是升级本插件。
   */
  reason?: 'no-credentials-file' | 'invalid-credentials' | 'unsupported-shape' | 'not-a-stepcode-login'
  /** 成功时采用的 profile。 */
  profile?: StepCodeProfile
  /** 成功时采用的区域。 */
  region?: StepCodeRegion
}

/**
 * 开发者中心额度凭据的**状态**（不是凭据本身）。
 *
 * 额度面用 `Cookie: Oasis-Token=<t>; Oasis-Webid=<device_id>` 鉴权，那个 token
 * 等价于一次账号登录。它只存在于 host，永远不过这条边界；这里下发的只是
 * 「有没有、从哪来、大概什么时候过期、读它时出了什么问题」。
 */
export interface StepCodeQuotaCredentialStatusDto {
  hasCredential: boolean
  /** `auto` = 账号密码自动换来的；`manual` = 用户从浏览器开发者工具粘贴的。 */
  source: 'auto' | 'manual' | null
  /** 登录用到的账号（非机密，用于卡片显示是哪一路凭据在服务）。 */
  account?: string | null
  /** 过期时刻（Unix 毫秒）；上游未给出时为 null。 */
  expiresAt?: number | null
  /** 上次用它读取失败的原因；与「有没有」并列给出，而不是互相取代。 */
  error?: string | null
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

/**
 * 请求侧缓存参数的出厂状态：关。
 *
 * 理由是官方行为而不是我们的保守：官方 Step-Code **对 Step 端点不发任何缓存参数**
 * ——`prompt_cache_key` 的发出条件硬绑 `baseUrl.includes('api.openai.com')`
 * （`openai-completions.ts:799-801`），会话亲和头由 `compat.sendSessionAffinityHeaders`
 * 控制且对 Step 为 false，`cache_control` 只在 Anthropic 格式下发出。
 * 「官方支持缓存参数」≠「会对 Step 发」：所以默认关，把是否发做成用户可见的能力位。
 */
export const STEP_CODE_CACHE_REQUEST_PARAMS_DEFAULT = false

/**
 * `prompt_cache_key` 的长度上限：64 个**码点**。
 *
 * 按码点而不是 UTF-16 长度截断，是因为这个值会是一段会话 id 之类的短标识，
 * 而代理链与日志系统都按字符数计长；按码点截断得到的字符串在任何一种计数下都不会超标。
 */
export const STEP_CODE_PROMPT_CACHE_KEY_MAX_LENGTH = 64

/**
 * 响应侧「缓存读入量」的解析优先级，从先到后。
 *
 * 这条链是本线路最容易被想当然的一处，顺序有理由：
 *
 * 1. `prompt_tokens_details.cached_tokens` —— OpenAI 规范的字段，最优先。
 * 2. `cache_read_input_tokens` —— Anthropic 规范的字段，出现在同包时说明端点混用两套词汇。
 * 3. **顶层 `cached_tokens`** —— Step 官方文档只给这个字段（命中判据就是它 > 0），
 *    所以它必须**在自己那条分支上被认**，而不是只当作别人的兜底。
 * 4. `prompt_cache_hit_tokens` —— DeepSeek 一族的命名。
 * 5. 0。
 *
 * 都不命中时取 0：0 表示「上游没报」，而不是「一定没命中」——
 * 命中与否由用户对照 `fetchedAt` 与自己的前缀长度判断。
 */
export const STEP_CODE_CACHE_READ_FIELD_ORDER = [
  'prompt_tokens_details.cached_tokens',
  'cache_read_input_tokens',
  'cached_tokens',
  'prompt_cache_hit_tokens',
] as const

/**
 * 缓存**写**入量在本线路恒为 0，卡片据此显式声明。
 *
 * Step 服务端是自动前缀缓存：前缀够了就命中，客户端没有「写入」这个动作，
 * 也没有对应的计费项。所以任何声称本线路写过缓存的数字都是编的。
 * 该常量由波次 2B 的 mapper 填进用量对象，让卡片如实标注而不是留一个看起来像 bug 的 0。
 */
export const STEP_CODE_CACHE_WRITE_NOTE = 'always-zero-on-this-route'

/**
 * 模型单价在官方表里全为 0，因此本线路的缓存用量卡片**只剩 token 维度**。
 *
 * 这不是「暂时没查」，而是官方 `STEP_MODEL_DEFAULTS.cost` 把四个键都写成 0
 * （`step-provider/index.ts:102`）——上游没有给这张表填过单价。
 * 卡片的处置因此是**只展示 token 与命中率、不展示任何金额**：
 * 拿 0 当单价算出「省了 0 元」是正确但无用，拿编的费率算出「省了 N 元」是撒谎。
 */
export const STEP_CODE_PRICING_STATUS = 'undocumented-zero' as const

/**
 * 本进程累计的缓存用量（**只读展示**，不含任何金额）。
 *
 * 只放 token：官方模型表把 cost 四键全写成 0（{@link STEP_CODE_PRICING_STATUS}），
 * 所以卡片能诚实给出的只有「读入多少、未命中多少、样本多大」这三件事。
 * 命中率由客户端算（cacheRead / (cacheRead + missedInput)）——**分母为 0 时是
 * 「还不知道」，不是「一个都没命中」**，因此这个字段本身不带百分比，免得把一个
 * 没有样本的状态固化成数字。
 *
 * 写侧仍然下发，但它的值在本线路上恒为 0，卡片据 {@link STEP_CODE_CACHE_WRITE_NOTE}
 * 标注而不是画一条永远是 0 的进度条。
 */
export interface StepCodeCacheStatsDto {
  /** 缓存读入 token，字段口径见 {@link STEP_CODE_CACHE_READ_FIELD_ORDER}。 */
  cacheReadTokens: number
  /** 未命中的输入 token：本轮聚合 prompt 减去缓存读入的那部分。 */
  missedInputTokens: number
  /** 写侧 token；本线路恒为 0。 */
  cacheWriteTokens: number
  /** 这些数字覆盖了几次请求；样本未知时为 null（卡片据此决定要不要显示样本量）。 */
  requests: number | null
}

/**
 * 设置卡片与 composer 徽标渲染所需的全部状态。
 *
 * 继承共享的号池切片，因此每条元素只带非机密展示信息；令牌永远不过这条边界。
 */
export interface StepCodeStatusDto extends Partial<AccountPoolStatusDto> {
  /** 线路总开关；关闭时适配器不暴露任何模型。 */
  enabled?: boolean
  authenticated: boolean
  hasCredentials: boolean
  providerId: typeof STEP_CODE_PROVIDER_ID
  /** 凭据存储位置说明（Windows DPAPI / macOS Keychain / Linux SecretService）。 */
  storagePath: string
  /** 下一次登录要用的 profile；区域由它唯一决定。 */
  profile: StepCodeProfile
  account: StepCodeAccountSummaryDto | null
  /** 无可用快照时为 null，UI 应优雅降级。 */
  quota: StepCodeQuotaSnapshotDto | null
  lastFetchedAt: number | null
  /** 本次应答背后是否正在刷新额度。 */
  quotaRefreshing?: boolean
  /** 额度读取失败的原因；与快照并列给出，而不是互相取代。 */
  quotaError?: string | null
  models: StepCodeModelOption[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: StepCodeReasoningEffort | null
  /** 当前进行中的登录流程；无流程时为 null。 */
  login?: StepCodeLoginFlowStatus | null
  /** 开发者中心额度凭据的状态（**不是**凭据本身）。 */
  quotaCredential?: StepCodeQuotaCredentialStatusDto
  /** 请求侧是否发送缓存参数；false 时本线路一个缓存参数都不发（见缓存一节）。 */
  cacheRequestParams: boolean
  /**
   * 本进程累计的缓存用量；尚无样本时为 undefined。
   *
   * 客户端把「未下发」与「下发了一个 0」分开渲染（占位符 vs 真实的 0%），
   * 所以这里刻意是可选的：缺失表达的是「还不知道」，不是「没有命中」。
   */
  cacheStats?: StepCodeCacheStatsDto
  /** 本插件是否正在服务该 Provider 路由。 */
  serving: boolean
  /** 路由被别的适配器占用时的诊断文案。 */
  conflict: string | null
}
