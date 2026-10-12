/**
 * GLM（ZCode 账号）线路的静态事实（host 侧）。
 *
 * 本文件里的每个取值都来自 `docs/glm-zcode-line-plan.md` §3 的逐字证据或本仓库历史提交
 * `9ad8a53` 的实测转录，注释写明「是什么、为什么、证据来自哪」；
 * 凡是没有证据能确认的取值，都在注释里标了「未验证」并说明缺什么。
 *
 * 两条必须记住的上游事实：
 *
 * 1. 套餐额度只在 **Coding Plan 专用面**生效。通用 OpenAI 面 `/api/paas/v4` 不是本线路的
 *    模型面——官方文档的 Common mistakes 段明确写了走那个面套餐额度不会正确生效，
 *    所以下面只有 `CHAT_PATH_OPENAI`（`/api/coding/paas/v4`），没有通用面的常量。
 * 2. 两个部署彼此独立，一区铸造的 Key 被另一区拒绝。区域是**凭据的属性**，
 *    因此凭据存储、账号池、配额都按区分开，一个池可以同时持有两区账号。
 */

import type { GlmQuotaWindowKey, GlmReasoningEffort, GlmRegion } from '../../shared/glm-coding-plan-contracts.ts'
import {
  GLM_CODING_PLAN_PROVIDER_ID,
  GLM_CODING_PLAN_PROVIDER_NAME,
  GLM_REASONING_EFFORTS,
} from '../../shared/glm-coding-plan-contracts.ts'

export const PROVIDER_ID = GLM_CODING_PLAN_PROVIDER_ID
export const PROVIDER_NAME = GLM_CODING_PLAN_PROVIDER_NAME

/** 本线路在包里使用的档位名，等于共享契约的线路级词汇表（同一份数组，不另建一份）。 */
export const GLM_CODING_EFFORTS = GLM_REASONING_EFFORTS

// ---------------------------------------------------------------------------
// 两区 host 表
// ---------------------------------------------------------------------------

/** 一个部署上的三个 host：控制台/业务面、模型面、浏览器授权入口。 */
export interface GlmRegionHosts {
  /**
   * 控制台 / 业务面。兑换链（`/api/auth/z/login`、`/api/biz/*`）与配额接口都打这里。
   *
   * 国区取 `https://bigmodel.cn`（计划 §3.4 逐字：「区域 host https://api.z.ai 或
   * https://bigmodel.cn，国区亦可用 open.bigmodel.cn」）；国际区 `https://api.z.ai`。
   */
  business: string
  /** 模型面，即下面两个 CHAT_PATH_* 的前缀。 */
  api: string
  /** 浏览器 OAuth 授权入口。 */
  authorize: string
  /**
   * 授权入口带什么参数。
   *
   * 国区是 `appId=zcode`（`bigmodelProviderConfig.ts:19-20,24`），
   * 国际区是 `client_id=client_P8X5CMWmlaRO9gyO-KSqtg`（`zaiProviderConfig.ts:21,26`），
   * 两区参数名都不同，所以参数名本身也进表里，不在调用处写死。
   */
  authorizeParamName: 'appId' | 'client_id'
  authorizeParamValue: string
}

/**
 * 两个部署的 host 表（证据等级 A，计划 §3.1 / §3.3 / §3.4）。
 *
 * `intl` 的 business 与 api 同为 `https://api.z.ai` 不是笔误：国际区把控制台业务面
 * 和模型面放在同一个源站上；国区则分属 bigmodel.cn 与 open.bigmodel.cn。
 */
export const REGION_HOSTS: Record<GlmRegion, GlmRegionHosts> = {
  cn: {
    business: 'https://bigmodel.cn',
    api: 'https://open.bigmodel.cn',
    authorize: 'https://bigmodel.cn/login',
    authorizeParamName: 'appId',
    authorizeParamValue: 'zcode',
  },
  intl: {
    business: 'https://api.z.ai',
    api: 'https://api.z.ai',
    authorize: 'https://chat.z.ai/api/oauth/authorize',
    authorizeParamName: 'client_id',
    authorizeParamValue: 'client_P8X5CMWmlaRO9gyO-KSqtg',
  },
}

// ---------------------------------------------------------------------------
// OAuth 控制面（ZCode 自己的 CLI 登录流）
// ---------------------------------------------------------------------------

/**
 * ZCode 控制面与授权中转页的共同源站。
 *
 * 两者同源是逐字事实：`configUtils.ts:5,34-40` 的桌面回调中转在 `zcode.z.ai/app/oauth/login`，
 * 计划 §3.1 的 cli/init 与 cli/poll 在 `zcode.z.ai/api/v1/*`。
 */
export const ZCODE_WEB_BASE = 'https://zcode.z.ai'

/** OAuth 控制面 API 根（证据等级 A：`cli-oauth.ts:88,98`、:106-115）。 */
export const ZCODE_API_BASE = 'https://zcode.z.ai/api/v1'

/** 开流端点：`POST {ZCODE_API_BASE}/oauth/cli/init`，体 `{"provider":"zai"|"bigmodel"}`。 */
export const CLI_INIT_PATH = '/oauth/cli/init'

/** 轮询端点前缀：`GET {ZCODE_API_BASE}/oauth/cli/poll/{flow_id}`。 */
export const CLI_POLL_PATH = '/oauth/cli/poll'

/**
 * 开流体里的 `provider` 取值：国际区 `zai`、国区 `bigmodel`。
 *
 * 取自 `cli-oauth.ts:88` 的开流请求体，是本线路唯一需要把「区域」翻译成「上游 provider 名」
 * 的地方；翻译错会让开流成功但回调落到另一个部署的账号上。
 */
export const CLI_PROVIDER_BY_REGION: Record<GlmRegion, 'zai' | 'bigmodel'> = {
  cn: 'bigmodel',
  intl: 'zai',
}

/** 桌面回调中转的自定义 scheme（逐字：`configUtils.ts:34-40`）。 */
export const DESKTOP_CALLBACK_REDIRECT_URI = 'zcode://oauth/callback'

/** 桌面回调中转页路径（`{ZCODE_WEB_BASE}/app/oauth/login`）。 */
export const DESKTOP_LOGIN_RELAY_PATH = '/app/oauth/login'

/** 中转页查询参数名：`redirect` 与 `app_version`（逐字：`configUtils.ts:34-40`）。 */
export const DESKTOP_LOGIN_RELAY_PARAMS = {
  redirect: 'redirect',
  appVersion: 'app_version',
} as const

/**
 * 两个 provider adapter 的授权参数里**没有 PKCE**。
 *
 * 逐字证据：`bigmodelProviderAdapter.ts:108-118` 的授权参数只有 redirect / appId / state。
 * 所以本线路的授权请求不得附带 `code_challenge`——上游不校验它，加上去只是自我安慰，
 * 反而会让日后复审误以为已做过 PKCE。
 */
export const PKCE_SUPPORTED = false

/** pollToken 的熵长度：`randomBytes(32).toString('hex')`（逐字：`cli-oauth.ts:116`）。 */
export const POLL_TOKEN_ENTROPY_BYTES = 32

/** 开流响应字段（逐字：`cli-oauth.ts:138,172`）。 */
export const CLI_INIT_RESPONSE_FIELDS = {
  flowId: 'flow_id',
  authorizeUrl: 'authorize_url',
  expiresAt: 'expires_at',
  pollIntervalSec: 'poll_interval_sec',
} as const

/** 就绪载荷字段（逐字：`cli-oauth.ts:203-238`）。 */
export const CLI_READY_FIELDS = {
  status: 'status',
  token: 'token',
  user: 'user',
  bigmodel: 'bigmodel',
  zai: 'zai',
  accessToken: 'access_token',
  refreshToken: 'refresh_token',
} as const

/** 上游就绪态的字面量。 */
export const CLI_READY_STATUS = 'ready'

// ---------------------------------------------------------------------------
// 模型面（双协议，逐模型声明走哪一面）
// ---------------------------------------------------------------------------

/**
 * Anthropic 兼容面前缀（证据等级 A：`zcode.z.ai/en/docs/qa` 第 6 条原文）。
 *
 * 请求打 `{api}{CHAT_PATH_ANTHROPIC}/v1/messages`。
 *
 * 认证是**双头**：官方源码注释逐字写着「Anthropic 兼容网关会同时读取 x-api-key 和
 * Bearer Authorization」（`model/model-execution.ts:425-437`），同值各发一份。
 */
export const CHAT_PATH_ANTHROPIC = '/api/anthropic'

/**
 * OpenAI 兼容面（Coding Plan 专用）前缀（证据等级 A：同上，QA 文档第 6 条）。
 *
 * 请求打 `{api}{CHAT_PATH_OPENAI}/chat/completions`。
 *
 * 刻意**不是** `/api/paas/v4`：那是通用开放平台面，官方文档的 Common mistakes 段写明
 * 走那个面套餐额度不会正确生效。也就是说本线路拿到的套餐订阅在那个面上表现为按量计费，
 * 用户会看到「明明买了套餐却在扣余额」。
 */
export const CHAT_PATH_OPENAI = '/api/coding/paas/v4'

// ---------------------------------------------------------------------------
// 兑换链：OAuth access_token → 可用 Coding Plan Key
// ---------------------------------------------------------------------------

/**
 * 兑换链的四段路径（证据等级 B：逆向实测，计划 §3.2）。
 *
 * 三个独立项目（TriDefender/zcode-api、Sakuralaaa/z-code-2api、CLIProxyAPI 插件生态）
 * 同构实现了同一条链路：
 *
 * ```
 * OAuth access_token
 *   -> POST {business}/api/auth/z/login  {token}                       => 业务 token
 *   -> GET  {business}/api/biz/customer/getCustomerInfo                => 默认 orgId / projectId
 *   -> GET/POST {business}/api/biz/v1/organization/{org}/projects/{proj}/api_keys => 找或建一把 Key
 *   -> GET  {business}/api/biz/v1/organization/{org}/projects/{proj}/api_keys/copy/{apiKeyId}
 *   -> 拼成 {apiKey}.{secretKey}                                       => Coding Plan API Key
 * ```
 *
 * 等级 B 的原因：这不是官方公开契约，上游随时可能改路径或字段。所以下面每一个值都由
 * `DSH_GLM_*` 环境变量可覆盖（见本文件末尾的覆盖表），上游变更时能一处回滚。
 *
 * **国区这一段未验证**（计划 R5 / §9）：三个同构实现都以国际区为主，国区是否同构没有实测。
 * 国区兑换失败必须给出可操作报错，不得静默。
 */
export const EXCHANGE_PATHS = {
  /** 换业务 token（JWT）。响应带 `expires_in`，见 `BIZ_TOKEN_*` 一节。 */
  login: '/api/auth/z/login',
  /** 换默认机构 orgId 与默认项目 projectId。 */
  customerInfo: '/api/biz/customer/getCustomerInfo',
  /** 列出该机构该项目下的 Key；缺失时用它建一把。 */
  apiKeys: '/api/biz/v1/organization/{orgId}/projects/{projectId}/api_keys',
  /** 取某把 Key 的 secretKey（路径末段是 apiKeyId）。 */
  apiKeyCopy: '/api/biz/v1/organization/{orgId}/projects/{projectId}/api_keys/copy/{apiKeyId}',
} as const

/**
 * 本线路在账号上创建的 Key 名。
 *
 * 刻意**不是**社区实现用的 `zcode-api-key`（`resolver.ts` 的 `ZAI_API_KEY_NAME`）：
 * 用同一个名字会与官方客户端已建的 Key 撞名，导致登录本线路时轮转或删除官方客户端正在用的
 * 那把 Key。换成本插件自己的名字之后，两边各用各的，互不干扰（计划 §3.2）。
 */
export const GLM_KEY_NAME = 'dsh-glm-coding-plan'

// ---------------------------------------------------------------------------
// 配额与订阅
// ---------------------------------------------------------------------------

/**
 * 配额窗口接口（证据等级 A：`docs/bigmodel-coding-plan-usage-quota.md`）。
 *
 * 认证头是 `authorization: <id>.<secret>` **裸 Key，不可加 Bearer 前缀**
 * （加了会鉴权失败，逐字证据同上）——与模型面用 Bearer / x-api-key 正好相反。
 */
export const QUOTA_PATH = '/api/monitor/usage/quota/limit'

/** 订阅列表接口（套餐名 / 续费时间）。证据等级同 `9ad8a53` 的实测转录。 */
export const SUBSCRIPTION_PATH = '/api/biz/subscription/list'

/**
 * `unit` → 配额窗口的映射（证据等级 A：`dsh-usage/src/core/adapters.ts:249`）。
 *
 * 上游的编号不是升序排列的——月度是 5、周度是 6——所以这里逐条照抄而不是「按大小猜」。
 * 未知 unit **不下发、不发明窗口**（同文件 `glmPlan()` 的解析语义）。
 */
export const QUOTA_UNIT_WINDOW: Readonly<Record<number, 'five-hour' | 'weekly' | 'monthly'>> = {
  3: 'five-hour',
  5: 'monthly',
  6: 'weekly',
}

/**
 * 配额行的类型取值（证据等级 A：同文件 :240-304）。
 *
 * - `TOKENS_LIMIT` token 套餐窗口
 * - `CREDIT_LIMIT` 额度套餐窗口，比例 = `currentValue` / `usage`
 * - `TIME_LIMIT` MCP 请求上限，**不是套餐窗口**，不得画成配额条
 */
export const QUOTA_ROW_TYPE = {
  tokens: 'TOKENS_LIMIT',
  credit: 'CREDIT_LIMIT',
  time: 'TIME_LIMIT',
} as const

/** 套餐机器档位取值（`data.level`，证据等级 A：同文件 :300）。 */
export const QUOTA_PLAN_LEVELS = ['lite', 'pro', 'max'] as const

/**
 * 每个窗口的名义长度（分钟），键就是线路自己的窗口标识。
 *
 * W6 的 `account-pool.ts` 装配 `PoolAccountQuotaDto` 时要用这张表：
 * 共享的 `PoolAccountQuotaWindowDto` 只有 `label` / `usedPercent` /
 * `windowDurationMins` / `resetsAt`，**没有窗口 key**，所以长度是线路自己的
 * `key` 映射过去的唯一一座桥。同一条先例在 minimax-code 的 `WINDOW_MINUTES`。
 *
 * 装配时另有三条规则，它们不在本文件实现（那是 W6 的装配活），但必须照做：
 *
 * 1. **`label` 一律传空字符串**。窗口名的规范在客户端字典里，客户端按
 *    `windowDurationMins` 本地化（`quotaWindowLabel`），host 没有资格下发展示文案。
 * 2. **`usedPercent` 为 null 的窗口必须丢弃**。null 不是 0%，是「未说明」，
 *    画成一条进度条等于谎报用量。
 * 3. `fetchedAt` 取 `GlmQuotaSnapshotDto.fetchedAt`。
 *
 * 这三条已经由 `src/host/common/account-quota.ts` 的 `quotaWindow()` / `poolQuota()`
 * 实现（同一句话在那份文件的注释里已经对七条线路说过一次），
 * W6 应直接调用它们，不要另写一份。
 *
 * 取值：
 *
 * - `five-hour` = 300。逐字证据：unit 3 是 5 小时滚动窗口。
 * - `weekly` = 10_080、`monthly` = 43_200。
 *
 * **未验证**：周与月这两个数是按词义取的（7 天 / 30 天），上游只给了「周度」「月度」
 * 这个名称，没有任何证据给出窗口长度——缺一条真实配额响应样本里的窗口起止时刻。
 * 5 小时那一档不受影响，它有逐字证据。实测长度若不同，改这一张表即可。
 */
export const QUOTA_WINDOW_MINUTES: Readonly<Record<GlmQuotaWindowKey, number>> = {
  'five-hour': 300,
  weekly: 10_080,
  monthly: 43_200,
}

// ---------------------------------------------------------------------------
// 超时与缓存
// ---------------------------------------------------------------------------

/**
 * OAuth 总超时上界：`min(now + 5min, expires_at * 1000)`。
 *
 * 逐字证据 `bootstrap/src/auth-login.ts:41`。取两者较小的原因是 `expires_at` 才是上游
 * 真正的失效时刻，本地 5 分钟只是兜底；只写死 5 分钟会在上游给更短有效期时多轮询到必然失败。
 */
export const OAUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 轮询最小间隔：`max(1000ms, poll_interval_sec * 1000)`（逐字：`cli-oauth.ts:106-115`）。
 *
 * 1 秒这个下限来自上游自己只校验「不小于 1 秒」，它同时也是防打爆上游的底线。
 *
 * **未验证**：`poll_interval_sec` 服务端实际下发值只见最小 1 秒的校验，没有任何实测样本
 * （计划 §9 明确未验证清单第 1 条）。缺一份真实开流响应样本。
 */
export const POLL_MIN_INTERVAL_MS = 1_000

/** 单次 OAuth HTTP 请求的超时（沿用 `9ad8a53` 的 `ZAI_OAUTH_REQUEST_TIMEOUT_MS`）。 */
export const OAUTH_REQUEST_TIMEOUT_MS = 30_000

/** 单次上游业务/模型请求的超时（沿用 `9ad8a53` 的 `CHAT_TIMEOUT_MS`）。 */
export const CHAT_TIMEOUT_MS = 300_000

/** 模型目录 / 配额发现阶段的超时（沿用 `9ad8a53` 的 `DISCOVERY_TIMEOUT_MS`）。 */
export const DISCOVERY_TIMEOUT_MS = 20_000

/**
 * 业务 JWT 的提前刷新量：120 秒（逐字：`zai-business-token-cache.ts:64-73`）。
 *
 * 为什么必须提前：这一层**没有 refresh_token 可用**——官方 `oauthService.ts:972-975`
 * 对刷新直接抛「OAuth 暂未提供 refresh token 交换接口，请重新登录」，两个 adapter 也都
 * 没有实现 `refreshToken()`（计划 §3.6、R3）。所以业务 JWT 一过期就只能重登，
 * 提前 120 秒重取是唯一能避免用户在长会话中途被踢出登录态的办法。
 */
export const BIZ_TOKEN_REFRESH_MARGIN_SECONDS = 120

/**
 * 重取业务 JWT 时的随机抖动上限：0~60 秒（同上）。
 *
 * 没有抖动时，同一时刻登录的多个账号会在同一秒一起重取，把上游打成尖峰。
 */
export const BIZ_TOKEN_REFRESH_JITTER_SECONDS = 60

/** 配额缓存 TTL（沿用 `9ad8a53` 的 `QUOTA_CACHE_TTL_MS`）。 */
export const QUOTA_CACHE_TTL_MS = 2 * 60 * 1000

/** 模型目录缓存 TTL（沿用 `9ad8a53` 的 `CATALOG_CACHE_TTL_MS`）。 */
export const CATALOG_CACHE_TTL_MS = 30 * 60 * 1000

export const STREAM_IDLE_TIMEOUT_MS = 300_000
export const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/**
 * 调用方不指定输出上限时本线路请求的 token 数（沿用 `9ad8a53`）。
 *
 * **未验证**：这不是任何 GLM-5.x 模型的官方上限，只是历史线路的兜底值。
 * 缺官方模型表；W5 的模型目录落地后每个模型应以目录声明为准。
 */
export const DEFAULT_MAX_TOKENS = 32_768

/**
 * 目录没声明上下文窗口时的兜底值（沿用 `9ad8a53`）。
 *
 * **未验证**：同上，缺 GLM-5.x 各模型的官方上下文窗口表。
 * 它只用于「目录尚未落地 / 未知模型」，不能当作任何模型的真实窗口。
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * 本插件在 `User-Agent` 里报的身份。
 *
 * 如实报成这个第三方插件，不冒充官方客户端：base URL 与头部词汇是上游公开契约，
 * 而冒用官方客户端身份既不诚实也可能构成违约。
 */
export const USER_AGENT =
  'dsh-chatgpt-subscription (+https://github.com/Aa728848/dsh-chatgpt-subscription)'

// ---------------------------------------------------------------------------
// 业务错误码表
// ---------------------------------------------------------------------------

/**
 * 平台级业务错误码（逐条沿用 `9ad8a53` 的实测转录，证据等级 A）。
 *
 * HTTP 状态保持通用，真实条件写在正文里——多个条件共用同一个状态码，
 * 这正是分类**不能停在状态行**的原因。
 *
 * 「可重试」一列是本线路的重试判读依据：
 *
 * - 可重试：`RATE_LIMITED`（退避后重试，号池可换账号）、`OVERLOADED`（瞬时过载）
 * - 不可重试：其余全部。重试它们只会把一次确定的失败拖成多次，并在额度类错误上多烧一次额度。
 * - `USAGE_LIMIT` / `PLAN_LIMIT` 带重置时刻，正确处置是等窗口重置或提示用户，
 *   立即重试只会在已用尽的窗口上继续失败。
 * - `AUTH_*` 的处置是重新登录或提前刷新业务 JWT，不是重试同一请求。
 *
 * @see https://docs.z.ai/api-reference/api-code
 */
export const ERROR_CODE = {
  /** 401 — 凭据没出现在头部里。不可重试。 */
  AUTH_MISSING: 1001,
  /** 401 — 令牌过期或不对，重新登录才修得好。不可重试。 */
  AUTH_INVALID: 1000,
  /**
   * 401 — 令牌过期。
   *
   * 不可重试，但处置分两层：业务 JWT 可以提前 120 秒自己重取，
   * access_token 过期只能重新登录（上游没有 refresh 交换接口）。
   */
  AUTH_EXPIRED: 1003,
  /** 429 — 没有余额也没有可用的资源包。不可重试。 */
  NO_BALANCE: 1113,
  /** 400 — 未知模型 id。不可重试（本地目录不该发出这种 id，出现即目录错了）。 */
  UNKNOWN_MODEL: 1211,
  /** 400 — 该模型不提供这个调用方式。不可重试——正是逐模型声明协议的用处。 */
  WRONG_METHOD: 1212,
  /** 400 — 缺必填参数。不可重试。 */
  MISSING_PARAM: 1213,
  /** 400 — 参数取值被拒，例如不支持的思考档位。不可重试。 */
  INVALID_PARAM: 1214,
  /** 403 — 账号的套餐不包含这个 API。不可重试。 */
  NO_PERMISSION: 1220,
  /** 400 — 提示词超出模型窗口。不可重试，本地应先压缩。 */
  PROMPT_TOO_LONG: 1261,
  /** 400 — 上游自己的内容过滤拒绝了这个输入。不可重试。 */
  CONTENT_FILTERED: 1301,
  /** 429 — 请求频率限制。**可重试**：退避后重试，号池可换一个账号。 */
  RATE_LIMITED: 1302,
  /** 429 — 瞬时服务过载。**可重试**。 */
  OVERLOADED: 1305,
  /** 429 — 某个具名用量窗口已用尽，正文带重置时刻。不可重试。 */
  USAGE_LIMIT: 1308,
  /** 429 — Coding Plan 套餐已失效。不可重试。 */
  PLAN_EXPIRED: 1309,
  /** 429 — 周度/月度额度用尽，正文带重置时刻。不可重试。 */
  PLAN_LIMIT: 1310,
  /** 429 — 当前套餐不包含这个模型。不可重试。 */
  MODEL_NOT_IN_PLAN: 1311,
} as const

// ---------------------------------------------------------------------------
// 思考档位：词汇表之外还有「模型真实梯子」
// ---------------------------------------------------------------------------

/**
 * 两套词汇表的统一排名。
 *
 * DSH 的档位词汇比上游宽：`minimal` / `medium` / `xhigh` 在别的线路上都存在。
 * 上游收到不认识的档位会直接报错，所以每个档位都要先落到**模型真实梯子**上再发出去。
 *
 * 为什么必须**跨两套词汇表排名**，而不是只排上游那三档——这是本仓库历史记录下来的 bug：
 * 只排 `low`/`high`/`max` 三档时，`minimal` 属于「未识别」，而未识别一律落在中档，
 * 于是 `minimal` 被发成 `high`：模型想得比用户要求的长得多，**更慢而且多计费**。
 * 把 `none`(0) / `minimal`(1) 也排进去，它们才有地方可落——`minimal` 会收敛到 `low`，
 * 这才是用户的意思。
 */
const EFFORT_RANKS: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

/** 未识别档位的排名：中档，绝不取两端。 */
const UNKNOWN_EFFORT_RANK = EFFORT_RANKS.high!

/**
 * 把一个档位收敛到某个模型真实梯子上的最近一档。
 *
 * 平手向上取，与其余各线路的收敛一致（宁可多想一点，也不要少想）。
 * 梯子为空（该模型不接受 `reasoning_effort`）时返回 null，
 * 调用方据此**不发**档位字段，而不是发一个模型不认的值。
 */
export function convergeGlmEffort(
  effort: string,
  ladder: readonly string[],
): GlmReasoningEffort | null {
  if (ladder.length === 0) return null
  const rank = (value: string): number =>
    EFFORT_RANKS[value.trim().toLowerCase()] ?? UNKNOWN_EFFORT_RANK
  const target = rank(effort)
  let best = ladder[0]!
  for (const candidate of ladder) {
    const distance = Math.abs(rank(candidate) - target)
    const bestDistance = Math.abs(rank(best) - target)
    if (distance < bestDistance || (distance === bestDistance && rank(candidate) > rank(best))) {
      best = candidate
    }
  }
  // 梯子是模型自己声明的，所以命中的一定是能命名的档位；断言只记录调用方数据已经保证的事。
  return best as GlmReasoningEffort
}

/** 档位参数是否是本线路词汇表里的值（供 route 层校验自由输入）。 */
export function isGlmReasoningEffort(value: unknown): value is GlmReasoningEffort {
  return value === 'low' || value === 'high' || value === 'max'
}

// ---------------------------------------------------------------------------
// 环境变量覆盖（DSH_GLM_*）
// ---------------------------------------------------------------------------

/**
 * 覆盖表。理由是兑换链为证据等级 B、OAuth 控制面是上游第一方端点，
 * 它们都可能在上游一次变更后整体失效（R4）；覆盖让回滚变成改一个环境变量，
 * 而不是发一个版本。
 *
 * 读取一律发生在**调用时**（不是模块加载时），这样改环境变量立即生效、也便于测试注入。
 */
function hostOverride(env: NodeJS.ProcessEnv, name: string): string {
  const value = (env[name] ?? '').trim()
  return value === '' ? '' : value.replace(/\/+$/, '')
}

function textOverride(env: NodeJS.ProcessEnv, name: string): string {
  const value = (env[name] ?? '').trim()
  return value === '' ? '' : value
}

/** 一个区域的业务面 host。 */
export function businessHost(region: GlmRegion, env: NodeJS.ProcessEnv = process.env): string {
  const override = hostOverride(env, region === 'cn' ? 'DSH_GLM_CN_BUSINESS_HOST' : 'DSH_GLM_INTL_BUSINESS_HOST')
  return override !== '' ? override : REGION_HOSTS[region].business
}

/**
 * 一个区域的模型面 base（不带尾部斜杠）。
 *
 * 覆盖值原样接受，所以指向反代根的部署可以直接写反代地址。
 */
export function apiBaseForRegion(region: GlmRegion, env: NodeJS.ProcessEnv = process.env): string {
  const override = hostOverride(env, region === 'cn' ? 'DSH_GLM_CN_API_HOST' : 'DSH_GLM_INTL_API_HOST')
  return override !== '' ? override : REGION_HOSTS[region].api
}

/** 浏览器授权页 URL，已带上该区域的 appId / client_id 参数。 */
export function authorizeUrl(region: GlmRegion, env: NodeJS.ProcessEnv = process.env): string {
  const override = hostOverride(
    env,
    region === 'cn' ? 'DSH_GLM_CN_AUTHORIZE_URL' : 'DSH_GLM_INTL_AUTHORIZE_URL',
  )
  const base = override !== '' ? override : REGION_HOSTS[region].authorize
  const paramName = textOverride(
    env,
    region === 'cn' ? 'DSH_GLM_CN_APP_ID' : 'DSH_GLM_CLIENT_ID',
  ) || REGION_HOSTS[region].authorizeParamValue
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}${encodeURIComponent(REGION_HOSTS[region].authorizeParamName)}=${encodeURIComponent(paramName)}`
}

/** OAuth 控制面 API 根（两区共用同一个控制面）。 */
export function oauthApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return hostOverride(env, 'DSH_GLM_OAUTH_API_BASE') || ZCODE_API_BASE
}

/** 桌面回调中转页的源站。 */
export function oauthWebBase(env: NodeJS.ProcessEnv = process.env): string {
  return hostOverride(env, 'DSH_GLM_OAUTH_WEB_BASE') || ZCODE_WEB_BASE
}

/** 开流端点完整 URL。 */
export function cliInitUrl(env: NodeJS.ProcessEnv = process.env): string {
  return oauthApiBase(env) + CLI_INIT_PATH
}

/** 轮询端点完整 URL。 */
export function cliPollUrl(flowId: string, env: NodeJS.ProcessEnv = process.env): string {
  return oauthApiBase(env) + CLI_POLL_PATH + '/' + encodeURIComponent(flowId)
}

/**
 * 桌面回调中转 URL：`{web}/app/oauth/login?redirect=zcode://oauth/callback&app_version=<ver>`。
 *
 * `app_version` 传本插件自己的版本号。
 *
 * **未验证**：服务端是否校验这个版本号、是否要求某个最低版本，都没有任何实测样本
 * （计划 §9 明确未验证清单第 2 条同族的握手路径问题）。缺一份真实中转响应。
 */
export function desktopLoginRelayUrl(appVersion: string, env: NodeJS.ProcessEnv = process.env): string {
  const query = new URLSearchParams({
    [DESKTOP_LOGIN_RELAY_PARAMS.redirect]: DESKTOP_CALLBACK_REDIRECT_URI,
    [DESKTOP_LOGIN_RELAY_PARAMS.appVersion]: appVersion,
  })
  return oauthWebBase(env) + DESKTOP_LOGIN_RELAY_PATH + '?' + query.toString()
}

/** 本线路创建 Key 时用的名字（可覆盖，默认值刻意不同于官方客户端的 key 名）。 */
export function keyName(env: NodeJS.ProcessEnv = process.env): string {
  return textOverride(env, 'DSH_GLM_KEY_NAME') || GLM_KEY_NAME
}

// ---------------------------------------------------------------------------
// 区域解析
// ---------------------------------------------------------------------------

/** 认不出区域时的默认部署。国际区是本仓库的历史默认值（沿用 `9ad8a53` 的 `regionForBaseUrl`）。 */
export const DEFAULT_REGION: GlmRegion = 'intl'

/**
 * 一个 host 属于哪个部署。
 *
 * 判据分两层，是有意的：先按「整串等于（或以其为根）某个已知 host」匹配，
 * `DSH_GLM_*` 覆盖值也参与这一步——部署把某区指到反代之后，host 上已经看不到原域名，
 * 只按域名片段判断会把反代地址错判成国际区；再退回按域名片段判断；
 * 两条都不命中才回落 `DEFAULT_REGION`。
 *
 * 回落本身是刻意的：这个函数回答的是「凭据没自述区域时猜一个」，
 * 猜错的代价落在调用方身上——用错的 host 会拿到明确的鉴权失败，而不是静默串区。
 */
export function regionForHost(host: string | undefined, env: NodeJS.ProcessEnv = process.env): GlmRegion {
  const value = (host ?? '').trim().toLowerCase()
  if (value === '') return DEFAULT_REGION
  const overrides: ReadonlyArray<readonly [string, GlmRegion]> = [
    [hostOverride(env, 'DSH_GLM_CN_BUSINESS_HOST'), 'cn'],
    [hostOverride(env, 'DSH_GLM_CN_API_HOST'), 'cn'],
    [hostOverride(env, 'DSH_GLM_CN_AUTHORIZE_URL'), 'cn'],
    [hostOverride(env, 'DSH_GLM_INTL_BUSINESS_HOST'), 'intl'],
    [hostOverride(env, 'DSH_GLM_INTL_API_HOST'), 'intl'],
    [hostOverride(env, 'DSH_GLM_INTL_AUTHORIZE_URL'), 'intl'],
  ]
  for (const [candidate, region] of overrides) {
    if (candidate === '') continue
    const lower = candidate.toLowerCase()
    if (value === lower || value.startsWith(lower + '/')) return region
  }
  if (value.includes('bigmodel.cn')) return 'cn'
  if (value.includes('z.ai')) return 'intl'
  return DEFAULT_REGION
}

/** 把自由输入的区域名规整到本线路认识的部署；认不出来时返回 undefined。 */
export function normalizeRegion(value: unknown): GlmRegion | undefined {
  if (value === 'cn' || value === 'intl') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'cn' || normalized === 'china' || normalized === 'bigmodel') return 'cn'
    if (normalized === 'intl' || normalized === 'global' || normalized === 'international') return 'intl'
  }
  return undefined
}
