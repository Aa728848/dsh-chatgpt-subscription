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

/** 路由前缀（host 暴露、client 消费）。 */
export const MINIMAX_CODE_ROUTE_PREFIX = '/api/dsh-chatgpt-subscription/minimax-code'

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
}