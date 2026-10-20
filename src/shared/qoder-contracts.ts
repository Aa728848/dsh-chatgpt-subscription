/**
 * Qoder（订阅）线路的共享契约。
 *
 * host 与 client 两半只依赖本文件的类型与常量，互不 import。
 * 本文件由调度者冻结：类型名与常量名不得更改，可追加。
 *
 * 边界精神与 `account-pool-contracts.ts` 首行一致：这里的一切都是公开信息，
 * **任何凭据都不越过这条边界**。Qoder 的三种凭据——设备流换到的 job token、
 * 手动粘贴的 PAT（`pt-...`）、adopt 读到的 `~/.qoder/.auth/user` 快照——一律不出现在
 * 下列任何类型里。手动粘贴 PAT 的请求体也正因如此**刻意不在本文件声明**：它必然带凭据，
 * 由 host 侧自行解析，不进冻结契约。
 *
 * 取值依据：`docs/qoder-line-plan.md` §1-§5，以及逐字来源
 * Qoder 官方文档（docs.qoder.com/cli/authentication）、
 * 开源实现 simonsmh/pi-provider-qoder（live 验证）与 Liki4/qodercli2api
 * （qodercli v1.1.34 的全合成 frozen fixtures）。
 */

import type {
  AccountPoolStatusDto,
  PoolAccountSummaryDto,
} from './account-pool-contracts.ts'

/** 线路 id。与官方 CLI 的 `qoder` 同名是有意的：模型 id 与端点词汇都照它。 */
export const QODER_PROVIDER_ID = 'qoder'

/** 设置卡片与 hub 卡片上显示的名字。 */
export const QODER_PROVIDER_NAME = 'Qoder（订阅）'

/**
 * 路由前缀（host 暴露、client 消费）。
 *
 * 与其余各订阅线路一致：每条线路把自己的设置面挂在 `/<line>/api` 下，
 * 不挂到 Codex 那条线路的 `/api/dsh-chatgpt-subscription` 前缀下面。
 */
export const QODER_ROUTE_PREFIX = '/qoder/api'

/**
 * 账号所属区域。
 *
 * `qoder.sh`（全球）与 `qoder.com.cn`（中国）两套部署互不通用：一个区铸造的凭据
 * 打另一个区的端点会被拒。区域因此是**凭据的属性**而不是请求的属性，一个号池可以同时
 * 持有两区账号且互不串用（计划 §1；与 step-code 的 profile 同一原则）。
 *
 * 取值逐字来自 pi-provider-qoder `src/region.ts` 的 `QoderMode`。
 */
export type QoderRegion = 'global' | 'cn'

/** 全部区域，声明顺序即设置页的默认顺序（全球区在前：它是唯一支持浏览器设备流的）。 */
export const QODER_REGIONS: readonly QoderRegion[] = ['global', 'cn']

/** 参数是否是本线路认识的区域（供 route 层校验自由输入）。 */
export function isQoderRegion(value: unknown): value is QoderRegion {
  return value === 'global' || value === 'cn'
}

/**
 * 本线路能命名的思考档位。
 *
 * 取值就是 DSH 的完整档位词汇，而不是上游那几档：上游不认识的档位一律被
 * `convergeQoderEffort`（host 侧 `types.ts`）收敛到**模型真实梯子**上再发出去，
 * 两份词汇表是分开的——详见 `QODER_REASONING_EFFORTS` 的注释。
 */
export type QoderReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * 线路级档位词汇表，从低到高。
 *
 * 上游的档位是**逐模型**声明的（目录条目的 `thinking_config.enabled.efforts` 的键集，
 * pi-provider `catalog.ts` `buildThinkingLevelMap`），未在集合里的档位不能发。
 * 线路级词汇表比上游宽是**故意的**：本地收敛即可，而窄表一旦上游加了新档位就无处安放。
 */
export const QODER_REASONING_EFFORTS: readonly QoderReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/** 档位参数是否是本线路词汇表里的值（供 route 层校验自由输入）。 */
export function isQoderReasoningEffort(value: unknown): value is QoderReasoningEffort {
  return typeof value === 'string' && (QODER_REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * 一只额度桶的稳定标识。
 *
 * 逐字取自 `GET {openapi}/api/v2/quota/usage` 的载荷键（pi-provider `auth/usage.ts`）：
 *
 * - `personal`：`userQuota`，账号自带的周期额度；
 * - `add-on`：`addOnQuota`，加购 Credits；
 * - `org`：`orgResourcePackage`，组织资源包（总额字段是 `cap` 而不是 `total`）。
 *
 * 刻意是封闭联合而不是自由字符串：上游给出一个认不出的桶时**不下发、不发明**。
 */
export type QoderQuotaBucketKind = 'personal' | 'add-on' | 'org'

/**
 * 一只额度桶。
 *
 * Qoder 的额度是**绝对量**（总额 / 已用 / 剩余 + 单位），不是窗口——没有「已用百分比
 * 与重置时刻」这一对，所以不硬塞进窗口形状。所有数字都可能缺失：上游没报就是没报，
 * 缺失渲染成占位符，而不是 0（计划 §5；技能规约「零不是未知」）。
 */
export interface QoderQuotaBucketDto {
  /** 线路自己的桶标识，由客户端本地化成桶名。 */
  kind: QoderQuotaBucketKind
  /** 该桶的总额度；上游未给出时为 null。 */
  total: number | null
  /** 该桶的已用额度；上游未给出时为 null。 */
  used: number | null
  /** 该桶的剩余额度；上游未给出时为 null。 */
  remaining: number | null
  /** 上游自述的单位（如 Credits）；未给出时为 null。 */
  unit: string | null
}

/**
 * 某一时刻的整份额度快照。
 *
 * `buckets` 只装上游真的报了的桶；一只桶都不认识时快照本身不下发（卡片显示
 * 「读不出来」而不是一张全空的卡）。
 */
export interface QoderQuotaSnapshotDto {
  buckets: QoderQuotaBucketDto[]
  /** 账号周期截止（Unix 毫秒）；上游未给出时为 null。 */
  expiresAt: number | null
  /** 本次读取时刻（Unix 毫秒），卡片据此判断数据新旧。 */
  fetchedAt: number
  /** 这份快照是在哪个区域读到的（额度跟着账号走，账号的区域即快照的区域）。 */
  region: QoderRegion
}

/**
 * 设置卡片渲染的一行模型（图标 + 名称 + 行尾勾）。
 *
 * 能力**不得从模型名推断**（计划 §4）：目录完全靠运行时发现，能力字段一律来自
 * 端点字段（`is_vl` / `is_reasoning` / `thinking_config` / `context_config`），
 * 拿不到的走区域兜底值。
 */
export interface QoderModelOption {
  /** 公开 id：上游 `display_name` 去空白（pi-provider `toQoderModelId` 同一规则）。 */
  id: string
  /** 显示名（上游 `display_name` 原样）。 */
  name: string
  /** 一句话能力描述：思考形态 / 可选档位 / 输入模态 / 上下文窗口。 */
  hint: string
  /** 是否由 DSH 提供给会话模型选择器。 */
  enabled: boolean
  /** 目录声明的默认上下文窗口（token）。 */
  defaultContextWindow: number
  /** 生效窗口：有覆盖值时用覆盖值，否则等于 `defaultContextWindow`。 */
  contextWindow: number
  /** 调用方不指定时，本线路请求的输出上限（目录不报输出上限，取文档化的上游上限）。 */
  defaultMaxTokens: number
  /** 该模型**真实**接受的思考档位；空数组表示它不接受 `reasoning_effort`。 */
  reasoningEfforts: readonly QoderReasoningEffort[]
  /** 思考能否关闭。与上一条正交：档位非空而本项为 false = 恒定开启。 */
  thinkingDisableable: boolean
  /** 是否接受 image 输入（上游 `is_vl`）。 */
  supportsImages: boolean
  /** 服务该模型的区域；同一个 id 在两区的可用性可能不同。 */
  regions: readonly QoderRegion[]
  /** 上游描述；目录没有时为 null。 */
  description: string | null
}

/**
 * 一个池内账号的展示行。
 *
 * 扩展共享的 `PoolAccountSummaryDto`，因此同样只带非机密信息：
 * 这里没有任何字段派生自 job token、PAT 或刷新令牌，连 token 的片段也不给。
 */
export interface QoderAccountSummaryDto extends PoolAccountSummaryDto {
  /** 账号所属区域；区域属于凭据，池内可混有 global 与 cn。 */
  region: QoderRegion
  /** 凭据来源：浏览器设备流 / 手动粘贴 PAT / adopt 本机登录态。 */
  origin: 'device' | 'pat' | 'adopt'
  /** 账号邮箱（非机密，上游 userinfo 自述）；没有时缺省（与基类 `email?: string` 同形）。 */
  email?: string
  /** 账号显示名（非机密）；没有时缺省。 */
  accountName?: string
}

/**
 * 设备流登录流程的实时状态，卡片轮询它。
 *
 * 这条线路**不开本地回调端口**：流程跑在 host 上，卡片只跟随这里
 * （与其余各线路的登录面同构）。用户在浏览器里人工确认，host 轮询取回凭据。
 *
 * `authorizeUrl` 始终下发，即使 host 同时打开过浏览器——启动失败时用户还能手动打开。
 */
export interface QoderLoginFlowStatus {
  status: 'idle' | 'pending' | 'complete' | 'error'
  /** 本次流程要登录的区域（设备流只会是 `global`，但如实记录）。 */
  region?: QoderRegion
  /** 浏览器必须打开的授权页（`https://qoder.com/device/selectAccounts?…`，由 host 拼）。 */
  authorizeUrl?: string
  startedAt?: number
  completedAt?: number
  /** 本地总超时换算出的绝对时刻（Unix 毫秒）。 */
  expiresAt?: number
  /** 轮询间隔（秒）；客户端据此显示「每 N 秒查询一次」。 */
  pollIntervalSec?: number
  /** pending 阶段的人类可读进度。 */
  progress?: string
  /** 流程完成后拿到的账号标识（上游 `user_id`）。 */
  uid?: string
  /** 失败原因（面向用户，不是堆栈）。 */
  error?: string
  /** 本次失败是否值得自动重试（传输类失败为 true，协议类与用户取消为 false）。 */
  retryable?: boolean
}

/** 设置面接受的补丁。 */
export interface QoderSettingsUpdateDto {
  enabled?: boolean
  enabledModelIds?: string[]
  /** 数字表示为该模型设置覆盖值；`null` 恢复目录默认。 */
  contextWindowOverrides?: Record<string, number | null>
  /** `null` 表示各模型用自己的默认档位。 */
  defaultReasoningEffort?: QoderReasoningEffort | null
  /** 手动指定下一个请求使用的账号；`null` 交回号池调度。 */
  selectedAccountId?: string | null
}

/** 显式连通性测试的结果。 */
export interface QoderConnectionDto {
  connected: boolean
  /** 探测请求的往返耗时。 */
  latencyMs: number
  /** 探测用到的账号；未登录时为 null。 */
  account: QoderAccountSummaryDto | null
  /** 探测所用的目录首行模型 id；读不到时为 null。 */
  model: string | null
  checkedAt: number
  /** 失败原因（面向用户）。 */
  error?: string
}

/**
 * adopt（本机已登录的 qodercli 客户端登录态）的一次尝试结果。
 *
 * adopt 只是省一次登录的快捷路径，**失败永不阻断**：每个 `reason` 对应一种
 * 「换一条路登录」的说明，卡片据此给出不同的下一步。
 */
export interface QoderAdoptResultDto {
  /** 是否真的尝试了 adopt（没找到凭据文件时为 false）。 */
  attempted: boolean
  /** 是否拿到可用登录态。 */
  adopted: boolean
  /**
   * 失败原因。
   *
   * `unsupported-shape` 是「读懂了但没有认出的字段组合」；`not-a-qoder-login` 是
   * 「文件在、能解密，但里面没有 access_token」；`region-unresolved` 是「解密成功但
   * 两个区域的 userinfo 都不认这把 token」——三者的下一步不同，所以分开。
   */
  reason?: 'no-credentials-file' | 'invalid-credentials' | 'unsupported-shape' | 'not-a-qoder-login' | 'region-unresolved'
  /** 成功时采用的区域。 */
  region?: QoderRegion
}

/**
 * 本进程累计的缓存用量（**只读展示**，不含任何金额）。
 *
 * 只放 token：Qoder 订阅没有公开的 token 单价（计划 §5），卡片能诚实给出的只有
 * 「读入多少、写出多少、样本多大」。命中率由客户端算——**分母为 0 时是「还不知道」，
 * 不是「一个都没命中」**，因此这个 DTO 不带百分比字段。
 *
 * 与 step-code 不同，本线路的写侧**不**恒为 0：上游的
 * `prompt_tokens_details.cache_write_tokens` 可能真的报数（pi-provider `stream.ts`
 * 的 usage 解析），所以写侧如实累计，不发「恒零」声明。
 */
export interface QoderCacheStatsDto {
  /** 缓存读入 token（`prompt_tokens_details.cached_tokens`）。 */
  cacheReadTokens: number
  /** 未命中的输入 token：本轮聚合 prompt 减去缓存读入与写入的那部分。 */
  missedInputTokens: number
  /** 缓存写入 token（`prompt_tokens_details.cache_write_tokens`；上游没报就是 0）。 */
  cacheWriteTokens: number
  /** 这些数字覆盖了几次请求；样本未知时为 null。 */
  requests: number | null
}

/**
 * 设置卡片与 composer 徽标渲染所需的全部状态。
 *
 * 继承共享的号池切片，因此每条元素只带非机密展示信息；令牌永远不过这条边界。
 */
export interface QoderStatusDto extends Partial<AccountPoolStatusDto> {
  /** 线路总开关；关闭时适配器不暴露任何模型。 */
  enabled?: boolean
  authenticated: boolean
  hasCredentials: boolean
  providerId: typeof QODER_PROVIDER_ID
  /** 凭据存储位置说明（Windows DPAPI / macOS Keychain / Linux SecretService）。 */
  storagePath: string
  /** 下一次登录要用的区域（设备流只在全球区开放）。 */
  region: QoderRegion
  account: QoderAccountSummaryDto | null
  /** 无可用快照时为 null，UI 应优雅降级。 */
  quota: QoderQuotaSnapshotDto | null
  lastFetchedAt: number | null
  /** 本次应答背后是否正在刷新额度。 */
  quotaRefreshing?: boolean
  /** 额度读取失败的原因；与快照并列给出，而不是互相取代。 */
  quotaError?: string | null
  models: QoderModelOption[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: QoderReasoningEffort | null
  /** 当前进行中的登录流程；无流程时为 null。 */
  login?: QoderLoginFlowStatus | null
  /**
   * 本进程累计的缓存用量；尚无样本时为 undefined。
   *
   * 客户端把「未下发」与「下发了一个 0」分开渲染（占位符 vs 真实的 0%），
   * 所以这里刻意是可选的：缺失表达的是「还不知道」，不是「没有命中」。
   */
  cacheStats?: QoderCacheStatsDto
  /** 本插件是否正在服务该 Provider 路由。 */
  serving: boolean
  /** 路由被别的适配器占用时的诊断文案。 */
  conflict: string | null
}
