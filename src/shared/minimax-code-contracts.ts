/**
 * MiniMax Code（编程订阅）线路的共享契约。
 *
 * host 与 client 两半只依赖本文件的类型与常量，互不 import。
 * 本文件由调度者冻结：类型名与常量名不得更改，可追加。
 */

import type {
  AccountRotationStrategy,
  PoolAccountSummaryDto,
} from './account-pool-contracts.ts'

export const MINIMAX_CODE_PROVIDER_ID = 'minimax-code'
export const MINIMAX_CODE_PROVIDER_NAME = 'MiniMax Code（编程订阅）'

/** 区域。cn 用 account.minimax.cn / agent.minimax.cn；global 用对应 .io 域名。 */
export type MinimaxCodeRegion = 'cn' | 'global'

/** M3.1 的思考档位；M2.7 恒定开启，M3 为开关二态。 */
export type MinimaxCodeReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * 全线共用的思考档位，按从小到大的顺序排列。
 *
 * 设置卡片只渲染这一份列表：档位是线路级的词汇表（`isMinimaxCodeReasoningEffort`
 * 就是按它校验的），而不是单个模型的能力表。某个模型实际接受哪些档位由
 * `MinimaxCodeModelOption.reasoningEfforts` 单独给出——把两者合成一份会让卡片
 * 在给一个只认 `default` 的模型显示 `max` 时无从判断是模型不支持还是文案没写。
 */
export const MINIMAX_CODE_REASONING_EFFORTS: readonly MinimaxCodeReasoningEffort[] =
  ['default', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 路由前缀（host 暴露、client 消费）。
 *
 * 与其余各订阅线路一致：每条线路把自己的设置面挂在 `/<line>/api` 下
 * （antigravity / claude / command-code / kimi-code / workbuddy 都是如此），
 * 而不是挂到 Codex 那条线路的 `/api/dsh-chatgpt-subscription` 前缀下面。
 * 唯一的 `/api/dsh-chatgpt-subscription` 前缀属于 Codex 自己的路由表。
 */
export const MINIMAX_CODE_ROUTE_PREFIX = '/minimax-code/api'

export interface MinimaxCodeAccount {
  id: string
  label: string
  email?: string
  /** 凭据代数，每次刷新自增；用于诊断两侧刷新争用。 */
  generation: number
  expiresAtMs: number
}

export interface MinimaxCodeCredentialStorage {
  /** minimax-native = 直接复用 MiniMax Code 的 auth.json；其余为插件自持。 */
  kind: 'minimax-native' | 'dpapi' | 'file'
  path?: string
}

export interface MinimaxCodeWebLogin {
  loginId: string
  userCode: string
  verificationUri: string
  expiresInSec: number
}

/**
 * 一个配额窗口。
 *
 * Token Plan 同时给两个窗口：5 小时滚动窗口与每周窗口。两者都要单独呈现，
 * 因为周窗口还带一个显示倍率（服务端返回 percentage 与 boost 两个值，渲染值
 * 是两者相乘），而把两个窗口合成一个数字会让用户无法判断是哪一边快用完了。
 */
export interface MinimaxCodeQuotaWindow {
  /** 稳定标识，由客户端本地化成窗口名；不要在这里放展示文案。 */
  key: 'interval' | 'weekly'
  /** 剩余百分比（周窗口已乘上 boost）。服务端未给出时为 null。 */
  remainingPercent: number | null
  /** 已用百分比；由剩余百分比取反得到。 */
  usedPercent?: number
  /** 已用/总量；仅当服务端计数与其百分比自洽时才有值（见 host 侧消歧说明）。 */
  used?: number
  total?: number
  /** 该窗口重置的绝对时刻（Unix 毫秒）。 */
  resetsAtMs?: number
  /** 服务端把该窗口标为不限量。 */
  unlimited?: boolean
}

export interface MinimaxCodeQuota {
  label: string
  usedPercent?: number
  resetsAtMs?: number
  /** 每个窗口的明细；服务端只给了一个数字时缺省。 */
  windows?: MinimaxCodeQuotaWindow[]
  /** 本快照读取时刻（Unix 毫秒），便于卡片判断数据新旧。 */
  fetchedAtMs?: number
}

/** 一条模型行的思考形态；取值与 host 目录里的 MinimaxCodeThinkingMode 一致。 */
export type MinimaxCodeThinkingModeDto = 'always-on' | 'toggle' | 'forced-effort'

/**
 * 设置卡片渲染的一行模型。
 *
 * 硬编码目录（host 的 `MINIMAX_CODE_MODELS`）带的是「模型是什么」，这里带的是
 * 「这个安装当前怎么用它」：启用与否、生效的上下文窗口、请求缺省输出上限。
 * 两者分开是因为前者随代码发布、后者随用户设置变化；把设置混进目录会让一份
 * 用户数据看起来像一条已发布的目录项。
 */
export interface MinimaxCodeModelOption {
  id: string
  name: string
  /** 是否由 DSH 提供给会话模型选择器。 */
  enabled: boolean
  /** 目录声明的默认上下文窗口。 */
  defaultContextWindow: number
  /** 生效窗口：有覆盖值时用覆盖值，否则等于 `defaultContextWindow`。 */
  contextWindow: number
  /** 调用方不指定时，本线路请求的输出上限。 */
  defaultMaxTokens: number
  /** 本模型接受的思考档位；没有可选档位时缺省。 */
  reasoningEfforts?: string[]
  /** 会话未指定档位时使用的档位。 */
  defaultReasoningEffort?: string
  /** 思考形态：恒定开启 / 开关二态 / 强制带档位。 */
  thinking: MinimaxCodeThinkingModeDto
  description: string | null
}

/**
 * 每日签到偏好。
 *
 * 签到面同时覆盖 cn 与 global 两个区域（官方 CLI 的 public-gateway 对两个
 * region 各有源站），因此这里不像 workbuddy 那样只限国区：账号自己的
 * region 决定走哪个源站。没有可配置的窗口：宿主启动后的第一次 tick
 * 就是当天签到。
 */
export interface MinimaxCodeCheckinSettings {
  /** 是否由进程内调度器自动签到。 */
  enabled: boolean
}

/**
 * 设置卡片渲染的签到聚合。
 *
 * 有意不带账号身份：卡片只显示一行「今日已签 x/y」，不做逐账号明细。
 */
export interface MinimaxCodeCheckinSummary {
  enabled: boolean
  /** 参与签到的账号数（号池中当前可选的账号）。 */
  totalAccounts: number
  /** 今日已确认签到的账号数（本已签过，或由某次运行签成）。 */
  doneToday: number
  /** 今日签到面报告不可签的账号数（当日格非「可领」状态，按小时复查）。 */
  skippedToday: number
  /** 今日重试次数耗尽仍未签成的账号数。 */
  failedToday: number
  /** 调度器上次运行时刻（Unix 毫秒），自动或手动。 */
  lastRunAt: number | null
  /** 已签到账号当前连续签到天数的最大值；今天还没人签时缺省。 */
  streakDays?: number
  /** 最近一次运行实际领到的积分；本轮没人新签时缺省。 */
  claimedPoints?: number
}

export interface MinimaxCodeWebStatus {
  /** 线路总开关；关闭时适配器不暴露任何模型。 */
  enabled: boolean
  authenticated: boolean
  providerId: typeof MINIMAX_CODE_PROVIDER_ID
  region: MinimaxCodeRegion
  storage: MinimaxCodeCredentialStorage
  account?: MinimaxCodeAccount
  login?: MinimaxCodeWebLogin
  /** 硬编码目录渲染成的模型行（远端 `/v1/models` 不可用）。 */
  models: MinimaxCodeModelOption[]
  /** 每条被覆盖的模型当前保存的上下文窗口；未被覆盖的模型不出现。 */
  contextWindowOverrides: Record<string, number>
  /** 未指定时的全局思考档位；null 表示各模型用自己的默认档位。 */
  defaultReasoningEffort: MinimaxCodeReasoningEffort | null
  /** 无可用用量快照时为 undefined，UI 应优雅降级。 */
  quota?: MinimaxCodeQuota
  /**
   * 用量快照缺失、且原因值得告诉用户时给出。
   *
   * - `credential-not-accepted`：端点应答了，但**拒绝本线路持有的凭据类型**——
   *   `/v1/token_plan/remains` 只接受平台 API 密钥，MiniMax Code 的
   *   `mcode-public` 登录态在四种认证写法下都被拒（`base_resp.status_code: 1004`）。
   * - `unreachable`：没有任何候选主机给出可用应答。
   */
  quotaUnavailable?: 'credential-not-accepted' | 'unreachable'
  /** 本插件是否正在服务该 Provider 路由；被别的适配器占用时为 false。 */
  serving: boolean
  /** 路由被别的适配器占用时的诊断文案。 */
  conflict: string | null
  /**
   * 凭据是否由本插件自己持有（即本插件设备码登录写下的那一份）。
   *
   * false 有两种情况：尚未登录，或当前登录态属于 MiniMax Code 桌面端自己
   * （`~/.minimax/auth`）。后者本插件**会**在需要时续期并原子写回（只读优先），
   * 但**不会删除**它——删掉等于把用户从正在运行的官方客户端里踢下线。因此
   * 「登出」对它无效，卡片必须据此禁用按钮并说明原因，而不是给出一个按下去
   * 没有效果的按钮。
   */
  ownedByPlugin: boolean
  /**
   * 号池里的账号，供设置卡片的「账号管理」渲染。
   *
   * 与其余各线路同构（复用同一个共享卡片与同一份 DTO）：每条元素只带非机密的
   * 展示信息，令牌永远不过这条边界。桌面端自有账号在其中会被标为
   * `removable: false`——它归 MiniMax Code 所有，本插件只读与续期。
   */
  accounts?: PoolAccountSummaryDto[]
  /** 下一个请求会使用的账号。 */
  activeAccountId?: string
  /** 号池调度策略；无号池时缺省为顺序耗尽。 */
  rotationStrategy?: AccountRotationStrategy
  /** 本进程是否装载了号池。false 时卡片按单凭据模式渲染。 */
  poolInstalled?: boolean
  /** 每日签到聚合；未装载签到调度器时为 null。 */
  checkin?: MinimaxCodeCheckinSummary | null
}

