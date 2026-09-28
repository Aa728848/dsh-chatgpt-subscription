/**
 * MiniMax Code（编程订阅）线路的共享契约。
 *
 * host 与 client 两半只依赖本文件的类型与常量，互不 import。
 * 本文件由调度者冻结：类型名与常量名不得更改，可追加。
 */

export const MINIMAX_CODE_PROVIDER_ID = 'minimax-code'
export const MINIMAX_CODE_PROVIDER_NAME = 'MiniMax Code（编程订阅）'

/** 区域。cn 用 account.minimax.cn / agent.minimax.cn；global 用对应 .io 域名。 */
export type MinimaxCodeRegion = 'cn' | 'global'

/** M3.1 的思考档位；M2.7 恒定开启，M3 为开关二态。 */
export type MinimaxCodeReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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

export interface MinimaxCodeQuota {
  label: string
  usedPercent?: number
  resetsAtMs?: number
}

export interface MinimaxCodeWebStatus {
  authenticated: boolean
  providerId: typeof MINIMAX_CODE_PROVIDER_ID
  region: MinimaxCodeRegion
  storage: MinimaxCodeCredentialStorage
  account?: MinimaxCodeAccount
  login?: MinimaxCodeWebLogin
  /** 硬编码目录里的模型 id 列表（远端 /v1/models 不可用）。 */
  models: readonly string[]
  /** 无配额接口时为 undefined，UI 应优雅降级。 */
  quota?: MinimaxCodeQuota
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
}
