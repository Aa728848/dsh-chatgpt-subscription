/**
 * GLM（ZCode 账号）线路的共享契约。
 *
 * host 与 client 两半只依赖本文件的类型与常量，互不 import。
 * 本文件由调度者冻结：类型名与常量名不得更改，可追加。
 *
 * 边界精神与 `account-pool-contracts.ts` 首行一致：这里的一切都是公开信息，
 * **任何凭据都不越过这条边界**。OAuth access_token、业务 JWT（zcodejwttoken）、
 * 兑换链换出的 Coding Plan Key（`{apiKey}.{secretKey}`）、pollToken 一律不出现在
 * 下列任何类型里；手工粘贴兜底的请求体也正因如此**刻意不在本文件声明**——
 * 它必然带凭据，由 host 侧自行解析，不进冻结契约。
 *
 * 取值依据：`docs/glm-zcode-line-plan.md` §3（逐字证据）、§4（决策 D1-D9）。
 */

import type {
  AccountPoolStatusDto,
  PoolAccountSummaryDto,
} from './account-pool-contracts.ts'

/** 线路 id。与用户自建的 `zai` / `zhipu` 兼容路由、已退役的 `zhipu-coding-plan` 都不同名（D1）。 */
export const GLM_CODING_PLAN_PROVIDER_ID = 'glm-coding-plan'

/** 设置卡片与 hub 卡片上显示的名字（D1）。 */
export const GLM_CODING_PLAN_PROVIDER_NAME = 'GLM（ZCode 账号）'

/**
 * 路由前缀（host 暴露、client 消费）。
 *
 * 与其余各订阅线路一致：每条线路把自己的设置面挂在 `/<line>/api` 下，
 * 不挂到 Codex 那条线路的 `/api/dsh-chatgpt-subscription` 前缀下面。
 */
export const GLM_CODING_PLAN_ROUTE_PREFIX = '/glm-coding-plan/api'

/**
 * 账号所属区域。
 *
 * 两个部署彼此独立：一区铸造的 Coding Plan Key 会被另一区拒绝，所以区域是**凭据的属性**
 * 而不是请求的属性，一个号池可以同时持有两区账号且互不串用（计划 §1、§3.3、§8.2）。
 *
 * - `cn`：国区智谱开放平台（业务 bigmodel.cn / 模型 open.bigmodel.cn）
 * - `intl`：国际区 Z.ai（业务与模型同为 api.z.ai）
 */
export type GlmRegion = 'cn' | 'intl'

/**
 * 该模型走哪个协议面（D3：双协议，逐模型声明）。
 *
 * 官方 Coding Plan 同时提供 Anthropic 兼容面与 OpenAI 兼容面，但**不是每个模型都上两面**，
 * 所以协议归属由模型目录逐行声明；未知模型不猜协议（D3 明确要求）。
 */
export type GlmWire = 'anthropic' | 'openai'

/**
 * 本线路能命名的思考档位。
 *
 * GLM-5.x 家族在 Coding Plan 上只接受 `low` / `high` / `max` 三档，
 * 其它取值上游直接报错（计划 §3.5 前的历史转录、9ad8a53 `CODING_EFFORTS`）。
 */
export type GlmReasoningEffort = 'low' | 'high' | 'max'

/**
 * 线路级档位词汇表，从低到高。
 *
 * 设置卡片只渲染这一份列表——它是**线路级词汇表**，不是某个模型的能力表。
 * 某个模型真实接受哪些档位由 `GlmModelOption.reasoningEfforts` 单独给出；
 * 把两者合成一份会让卡片在给一个只认 `low` 的模型显示 `max` 时，
 * 无从判断是模型不支持还是文案没写。
 */
export const GLM_REASONING_EFFORTS: readonly GlmReasoningEffort[] = ['low', 'high', 'max']

/** 区域参数是否落在这条线路认识的部署上（供 route 层校验自由输入的 region）。 */
export function isGlmRegion(value: unknown): value is GlmRegion {
  return value === 'cn' || value === 'intl'
}

/** 协议面参数是否是这条线路的两种面之一。 */
export function isGlmWire(value: unknown): value is GlmWire {
  return value === 'anthropic' || value === 'openai'
}

/**
 * 配额窗口的稳定标识。
 *
 * 取值直接对应上游 `/api/monitor/usage/quota/limit` 的 `unit` 字段
 * （计划 §3.4，证据等级 A）：
 *
 * - `five-hour` ← unit 3（5 小时滚动窗口）
 * - `monthly`   ← unit 5
 * - `weekly`    ← unit 6
 *
 * 刻意是封闭联合而不是自由字符串：未知 unit **不下发、不发明窗口**
 * （计划 §3.4 引用 dsh-usage `glmPlan()` 的解析语义），
 * 做成 `string` 等于把「不发明」这条规则从类型上撤掉。
 */
export type GlmQuotaWindowKey = 'five-hour' | 'weekly' | 'monthly'

/**
 * 账号当前**用的是什么额度**。
 *
 * 官方文档（逐字：zcode.z.ai/cn/docs/configuration）：新用户连接 BigModel 账号后自动获得
 * 「体验套餐：无需付费，在首次使用起的 5 天内，每天提供 800 万 token 的 GLM 系列模型体验额度」；
 * welcome 页同样写明「新用户可享受每日免费的 GLM 旗舰模型体验额度」。
 * 所以**「没有付费 Coding Plan」不等于「没有额度」**——这条类型就是为如实区分两者而存在的。
 *
 * - `plan`：配额面给出付费套餐的机器档位（lite / pro / max）。
 * - `free-trial`：探活被配额面明确拒绝，但拒绝原因是**套餐/额度**维度（无余额、套餐不含该
 *   API、套餐失效、额度用尽），不是凭据本身无效。按上面的官方文档，这类账号应放行并由上游
 *   在额度耗尽时以 429 告知。
 * - `unknown`：探活结果不足以区分「凭据无效」与「没有付费套餐」时的**保守取值**。
 *
 * **未验证**：`free-trial` 与 `unknown` 的分界依赖上游在「凭据无效」时是否一定给出鉴权类
 * 业务码（1000 / 1001 / 1003）。本插件没有实机账号，无法确认；因此 `unknown` 这一档存在的
 * 意义就是「分不出来时不假装知道」。
 */
export type GlmAllowanceKind = 'plan' | 'free-trial' | 'unknown'

/** 额度类型参数是否落在本线路认识的三个取值上。 */
export function isGlmAllowanceKind(value: unknown): value is GlmAllowanceKind {
  return value === 'plan' || value === 'free-trial' || value === 'unknown'
}

/**
 * 一个配额窗口。
 *
 * 呈现单位是「已用百分比」而不是「剩余百分比」：额度型套餐（CREDIT_LIMIT）
 * 的比例 = `currentValue`/`usage`，与 token 型（TOKENS_LIMIT）不同源，
 * 归一成本线路统一的一个已用百分比才能画同一条进度条。
 */
export interface GlmQuotaWindow {
  /** 上游 `unit` 映射出的窗口标识，由客户端本地化成窗口名。 */
  key: GlmQuotaWindowKey
  /** 已用百分比，0-100。上游没给出有界额度时为 null。 */
  usedPercent: number | null
  /** 该窗口重置的绝对时刻（Unix 毫秒）；上游未给出时为 null。 */
  resetsAt: number | null
}

/** 某一时刻的整份配额快照。 */
export interface GlmQuotaSnapshotDto {
  /** 展示用套餐名（订阅列表给出时才有）。 */
  planName: string | null
  /** `data.level` 的机器档位：lite / pro / max（计划 §3.4，证据等级 A）。 */
  planLevel: string | null
  windows: GlmQuotaWindow[]
  /** 套餐续费时刻（Unix 毫秒）；上游未给出时为 null。 */
  renewsAt: number | null
  /** 本次读取时刻（Unix 毫秒），卡片据此判断数据新旧。 */
  fetchedAt: number
  /** 实际应答的端点路径，供设置卡片诊断。 */
  sources: string[]
  /**
   * 当前这份快照背后用的是付费套餐还是免费体验额度。
   *
   * 可选是为了**不破坏既有构造点**：旧版本 host / 旧快照里没有这个键时，
   * 客户端按 'unknown' 渲染（见客户端本地化），而不是假装是付费套餐。
   */
  allowance?: GlmAllowanceKind
}

/**
 * 设置卡片渲染的一行模型（计划 §7：图标 + 名称 + 一句话描述 + 行尾勾）。
 *
 * 能力**不得从模型名推断**（计划 §1、§7）：`glm-5.3-flash` 收图而 `glm-5.3` 不收、
 * `glm-5.2` 两个档位而 `glm-5.3` 三个，都是历史草案记录过的反例。
 */
export interface GlmModelOption {
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
  /** 调用方不指定时，本线路请求的输出上限。 */
  defaultMaxTokens: number
  /**
   * 该模型**真实**接受的思考档位；空数组表示它不接受 `reasoning_effort`。
   *
   * 这是「模型真实梯子」，与 `GLM_REASONING_EFFORTS`（线路级词汇表）是两回事。
   */
  reasoningEfforts: readonly GlmReasoningEffort[]
  /** 思考能否关闭。与上一条正交：档位非空而本项为 false = 恒定开启。 */
  thinkingDisableable: boolean
  /** 该模型走哪个协议面。 */
  wire: GlmWire
  /** 是否接受 image 输入。 */
  supportsImages: boolean
  /** 服务该模型的区域；账号自身区域必须落在其中（R8：两区模型 id 不一致）。 */
  regions: readonly GlmRegion[]
  /** 官方描述；目录没有时为 null。 */
  description: string | null
}

/**
 * 一个池内账号的展示行。
 *
 * 扩展共享的 `PoolAccountSummaryDto`，因此同样只带非机密信息：
 * 这里没有任何字段派生自 OAuth token、业务 JWT 或 Coding Plan Key，
 * 连「Key 的后四位」这类片段也不给。
 */
export interface GlmAccountSummaryDto extends PoolAccountSummaryDto {
  /** 该账号登录的部署；区域属于凭据，池内可混有 cn 与 intl。 */
  region: GlmRegion
  /** 兑换链解析出的默认机构 id（非机密，用于诊断两区是否串号）。 */
  organizationId?: string
  /** 控制台侧的账号显示名。 */
  accountName?: string
}

/** 账号身份（设置卡片渲染用），不带任何凭据。 */
export interface GlmAccountDto {
  /** 稳定、非机密的选中键。 */
  id: string
  /** 上游 `user.user_id`。 */
  userId: string | null
  /** 上游 `user.email`。 */
  email: string | null
  /** 上游 `user.name`。 */
  displayName: string | null
  region: GlmRegion
  /** Unix 毫秒；本插件不落 `user.avatar` 的原始字节，只保留是否已取到。 */
  authenticatedAt: number | null
}

/**
 * 浏览器 OAuth 登录流程的实时状态，卡片轮询它。
 *
 * 浏览器不是卡片能控制的东西，所以流程跑在 host 上，卡片只跟随这里
 * （与其余各线路的登录面同构）。
 *
 * `authorizeUrl` 始终下发，即使 host 同时打开过浏览器——启动失败时用户还能手动打开。
 */
export interface GlmLoginFlowStatus {
  status: 'idle' | 'pending' | 'complete' | 'error'
  /** 本次流程要登录的部署。 */
  region?: GlmRegion
  /** 浏览器必须打开的授权页（已带上 appId / client_id 参数）。 */
  authorizeUrl?: string
  startedAt?: number
  completedAt?: number
  /** 上游 `expires_at` 换算出的绝对时刻（Unix 毫秒）；总超时以它为上界。 */
  expiresAt?: number
  /** 上游 `poll_interval_sec`；客户端据此显示「每 N 秒查询一次」。 */
  pollIntervalSec?: number
  /** pending 阶段的人类可读进度。 */
  progress?: string
  /** 流程完成后账号的邮箱。 */
  email?: string
  /** 失败原因（面向用户，不是堆栈）。 */
  error?: string
  /**
   * 本次失败是否值得自动回落。
   *
   * 轮询错误语义（计划 §3.1，证据等级 B）：4xx（除 408/429）、信封 `code !== 0`、
   * 未知 status 都是**致命**；5xx / 网络错误 / 畸形 200 按 pending 重试。
   */
  retryable?: boolean
}

/** 设置面接受的补丁。 */
export interface GlmSettingsUpdateDto {
  enabled?: boolean
  enabledModelIds?: string[]
  /** 数字表示为该模型设置覆盖值；`null` 恢复目录默认。 */
  contextWindowOverrides?: Record<string, number | null>
  /** `null` 表示各模型用自己的默认档位。 */
  defaultReasoningEffort?: GlmReasoningEffort | null
  /** 手动指定下一个请求使用的账号；`null` 交回号池调度。 */
  selectedAccountId?: string | null
}

/** 显式连通性测试的结果。 */
export interface GlmConnectionDto {
  connected: boolean
  /** 探测请求的往返耗时。 */
  latencyMs: number
  /** 探测用到的账号；未登录时为 null。 */
  account: GlmAccountSummaryDto | null
  /** 探测所用的模型。 */
  model: string | null
  checkedAt: number
  /** 失败原因（面向用户）。 */
  error?: string
}

/**
 * adopt（本机已登录的 ZCode 客户端登录态）的一次尝试结果。
 *
 * adopt 只是省一次登录的快捷路径，**失败永不阻断**（计划 D6、R6）：
 * 每个 `reason` 对应一种「回落浏览器登录」的说明，卡片据此给出不同的下一步。
 */
export interface GlmAdoptResultDto {
  /** 是否真的尝试了 adopt（没找到凭据文件时为 false）。 */
  attempted: boolean
  /** 是否拿到可用登录态。 */
  adopted: boolean
  reason?:
    | 'no-credentials-file'
    | 'secret-unavailable'
    | 'decrypt-failed'
    | 'token-expired'
    | 'exchange-failed'
    | 'not-a-zcode-login'
  /** 成功时采用的部署。 */
  region?: GlmRegion
}

/**
 * 设置卡片与 composer 徽标渲染所需的全部状态。
 *
 * 继承共享的号池切片，因此每条元素只带非机密展示信息；令牌永远不过这条边界。
 */
export interface GlmStatusDto extends Partial<AccountPoolStatusDto> {
  /** 线路总开关；关闭时适配器不暴露任何模型。 */
  enabled?: boolean
  authenticated: boolean
  hasCredentials: boolean
  providerId: typeof GLM_CODING_PLAN_PROVIDER_ID
  /** 凭据存储位置说明（Windows DPAPI / macOS Keychain / Linux SecretService）。 */
  storagePath: string
  /** 下一次登录要用的部署。 */
  region: GlmRegion
  account: GlmAccountDto | null
  /** 无可用快照时为 null，UI 应优雅降级。 */
  quota: GlmQuotaSnapshotDto | null
  lastFetchedAt: number | null
  /** 本次应答背后是否正在刷新配额。 */
  quotaRefreshing?: boolean
  /** 配额读取失败的原因；与快照并列给出，而不是互相取代。 */
  quotaError?: string | null
  models: GlmModelOption[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: GlmReasoningEffort | null
  /** 当前进行中的登录流程；无流程时为 null。 */
  login?: GlmLoginFlowStatus | null
  /**
   * 登录落盘时探活认定的额度类型（付费套餐 / 免费体验额度 / 未判定）。
   *
   * 与 `quota.allowance` 分开给：免费额度账号很可能**读不到配额快照**
   * （配额接口本身可能就是它拒绝服务的那一面），那时只有这一项能诚实地告诉用户
   * 「你是免费体验额度，不是付费套餐」。
   */
  allowance?: GlmAllowanceKind
  /** 本插件是否正在服务该 Provider 路由。 */
  serving: boolean
  /** 路由被别的适配器占用时的诊断文案。 */
  conflict: string | null
}
