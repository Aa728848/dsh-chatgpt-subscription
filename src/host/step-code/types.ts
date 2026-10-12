/**
 * Step Code（Step Plan 订阅）线路的静态事实（host 侧）。
 *
 * 本文件里的每个取值都来自 `docs/step-code-line-plan.md` 的逐字证据或官方 Step-Code 源码，
 * 注释写明「是什么、为什么、证据来自哪」；凡是没有证据能确认的取值，都在注释里标了
 * 「未验证」并说明缺什么。**不另创事实**：本线路不发明端点、不发明字段、不发明档位。
 *
 * 三条必须记住的上游事实：
 *
 * 1. **区域由凭据里的 profile 唯一决定。** `api.stepfun.ai` 与 `api.stepfun.com`
 *    互不通用，国际区凭据打国区端点会被拒（`docs/step-integration.md:87-90`：
 *    the chosen profile … is the single source of the region afterwards）。
 *    所以端点永远从 profile 表里取，不在调用处按「当前设置」拼。
 * 2. **登录是云端轮询，不是本地回调。** CLI 只发 HTTPS 从不监听端口
 *    （`login-client.ts:9-10`：the CLI only makes outbound HTTPS requests and never
 *    listens on a port），所以流程能穿过 SSH、容器与没有浏览器的机器。
 * 3. **凭据永不过期、永不刷新。** Step 的 api_key 不是会话令牌：官方把它存成
 *    `{ type: 'oauth', access: apiKey, refresh: STEP_STATIC_REFRESH_TOKEN,
 *    expires: Number.MAX_SAFE_INTEGER }`（`step-provider/index.ts:363-371`），
 *    而 `refreshStepOAuth` 对任何不是那个哨兵的 refresh 一律抛错。
 *    因此 token store 与号池必须按「静态凭据」处理，且**不得**因为
 *    `expires` 是 MAX_SAFE_INTEGER 就判成异常。
 */

import type {
  StepCodeProfile,
  StepCodeReasoningEffort,
  StepCodeRegion,
} from '../../shared/step-code-contracts.ts'
import {
  STEP_CODE_PROVIDER_ID,
  STEP_CODE_PROVIDER_NAME,
  STEP_CODE_REASONING_EFFORTS,
  stepCodeRegionOf,
} from '../../shared/step-code-contracts.ts'

export const PROVIDER_ID = STEP_CODE_PROVIDER_ID
export const PROVIDER_NAME = STEP_CODE_PROVIDER_NAME

/** 本线路在 host 侧使用的档位名，等于共享契约的线路级词汇表（同一份数组，不另建一份）。 */
export const STEP_CODE_EFFORTS = STEP_CODE_REASONING_EFFORTS

// ---------------------------------------------------------------------------
// 四条 profile 的 host 表
// ---------------------------------------------------------------------------

/**
 * 这条线路的凭据是从哪来的。
 *
 * - `browser`：云端轮询的浏览器授权（Step Plan 订阅）。
 * - `apiKey`：用户手动粘贴的开放平台 API Key（按量计费）。
 *
 * 取值逐字来自 `PROFILE_DEFINITIONS.credentialSource`（`step/onboarding.ts:40,52,71,84`）。
 * 它与 profile 是一一对应的常量关系，所以仍然逐行写出来而不是由 profile 推导：
 * 官方自己的注释（`onboarding.ts:23-27`）把「一条 profile 自带它的端点与它的覆盖变量」
 * 写成一条规则，正是为了防止加一个区域时静默继承了另一个区域的端点。
 */
export type StepCodeCredentialSource = 'browser' | 'apiKey'

/** Step Plan 两条 profile 共用的一句描述（逐字：`onboarding.ts:14`）。 */
const PLAN_DESCRIPTION = 'Usage included with Mini, Plus, Pro, and Max plans'

/** 开放平台两条 profile 共用的一句描述（逐字：`onboarding.ts:15`）。 */
const PLATFORM_DESCRIPTION = 'Pay for what you use.'

/** 一条 profile 的全部 host 侧事实。 */
export interface StepCodeProfileHosts {
  /** 凭据来源。 */
  credentialSource: StepCodeCredentialSource
  /**
   * 模型面 base（**路由前缀**，不带尾部斜杠，也不带版本段）。
   *
   * Step Plan 两条是 `/step_plan`（套餐额度只在这个面生效），平台两条是 `/v1`。
   * 请求路径由 `model-catalog.ts` 的归一化函数在这条 base 上拼出来。
   */
  api: string
  /** 授权 / 开发者中心源站。登录的 init/poll 与额度面的两个接口都打这里。 */
  auth: string
  /** 用户拿 API Key 的页面（只用于卡片上给一个「去这里拿」的链接）。 */
  keyPage: string
  /** 设置卡片上这一行的标题。 */
  title: string
  /** 设置卡片上这一行的一句话说明。 */
  description: string
}

/**
 * 四条 profile 的 host 表（逐字证据：`docs/step-integration.md:81-86` 的表，
 * 与 `step/onboarding.ts:33-87` 的 `PROFILE_DEFINITIONS` 互相印证）。
 *
 * `step_plan` 与 `platform_cn` 的 auth 同为 `https://platform.stepfun.com` 不是笔误：
 * Step Plan 只是同一个开发者中心的另一个套餐页，登录面是同一个；
 * 两者的差别只在**模型面**（`/step_plan` 与 `/v1`），也只在**计费方式**。
 */
export const PROFILE_HOSTS: Readonly<Record<StepCodeProfile, StepCodeProfileHosts>> = {
  step_plan: {
    credentialSource: 'browser',
    api: 'https://api.stepfun.com/step_plan',
    auth: 'https://platform.stepfun.com',
    keyPage: 'https://platform.stepfun.com/step-plan',
    title: 'Step Plan（国区订阅）',
    description: PLAN_DESCRIPTION,
  },
  step_plan_oversea: {
    credentialSource: 'browser',
    api: 'https://api.stepfun.ai/step_plan',
    auth: 'https://platform.stepfun.ai',
    keyPage: 'https://platform.stepfun.ai/step-plan',
    title: 'Step Plan（国际区订阅）',
    description: PLAN_DESCRIPTION,
  },
  platform_cn: {
    credentialSource: 'apiKey',
    api: 'https://api.stepfun.com/v1',
    auth: 'https://platform.stepfun.com',
    keyPage: 'https://platform.stepfun.com/interface-key',
    title: 'Step 开放平台（国区 · API Key）',
    description: PLATFORM_DESCRIPTION,
  },
  platform_oversea: {
    credentialSource: 'apiKey',
    api: 'https://api.stepfun.ai/v1',
    auth: 'https://platform.stepfun.ai',
    keyPage: 'https://platform.stepfun.ai/interface-key',
    title: 'Step 开放平台（国际区 · API Key）',
    description: PLATFORM_DESCRIPTION,
  },
}


// ---------------------------------------------------------------------------
// 云端轮询登录协议
// ---------------------------------------------------------------------------

/** 开发者中心上的 CLI 登录路由前缀（逐字：`login-client.ts:22`）。 */
export const CLI_LOGIN_PATH_PREFIX = '/api/stdhttp/v1/cli-login'

/**
 * 授权中转页路径（逐字：`login-client.ts:23`）。
 *
 * 授权页 URL **由客户端自己拼**：`{authBase}/cli-login-remote?flow_id=<flow_id>`。
 * 服务端即便返回了 authorize_url 也不采信——官方 `initStepCliLogin` 用 `new URL(path, origin)`
 * 加上 URLSearchParams 自己拼（`login-client.ts:139-141`），因为服务端给的那个值
 * 是从 CLI 看过去的（重定向到 CLI 而不是浏览器），对「人在浏览器里点」这件事没有意义。
 */
export const CLI_LOGIN_AUTHORIZE_PATH = '/cli-login-remote'

/** 开流端点：`POST {auth}{CLI_LOGIN_PATH_PREFIX}/init`。 */
export const CLI_INIT_PATH = CLI_LOGIN_PATH_PREFIX + '/init'

/** 轮询端点前缀：`GET {auth}{CLI_LOGIN_PATH_PREFIX}/poll/{flow_id}`。 */
export const CLI_POLL_PATH = CLI_LOGIN_PATH_PREFIX + '/poll'

/**
 * poll_token 的熵长度：`randomBytes(32).toString('hex')`（逐字：`step-provider/index.ts:344`）。
 *
 * 32 字节 = 64 位十六进制字符。它是**本线路客户端侧唯一的凭据**：只出现在
 * `Authorization: Bearer` 头里，绝不进 URL、日志或磁盘（`login-client.ts:11-16`）。
 * `flow_id` 相反：它是公开标识，会进浏览器地址栏、历史与截图，单独一个兑不出凭据。
 */
export const POLL_TOKEN_ENTROPY_BYTES = 32

/** poll_token 的形状（64 位 hex，64 个字符）。 */
export const POLL_TOKEN_PATTERN = /^[0-9a-f]{64}$/

/**
 * `flow_id` 的形状（逐字：`login-client.ts:36`）。
 *
 * 它会被插进轮询请求的路径里，所以必须收成一个不透明令牌：只允许字母数字、点、下划线、
 * 连字符，长度 1-128。不合法时是 **protocol** 类错误（不重试）——形状不对说明对面不是
 * 我们以为的那个服务端，重发多少次都是一样的错。
 */
export const FLOW_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/** 开流响应字段（逐字：`login-client.ts:130-142` 的读取与校验）。 */
export const CLI_INIT_RESPONSE_FIELDS = {
  flowId: 'flow_id',
  pollIntervalSec: 'poll_interval_sec',
  /** Unix **秒**（不是毫秒）。 */
  expiresAt: 'expires_at',
} as const

/** 就绪载荷字段（逐字：`login-client.ts:180-197`）。 */
export const CLI_READY_FIELDS = {
  state: 'state',
  credential: 'credential',
  apiKey: 'api_key',
  uid: 'uid',
  reason: 'reason',
} as const

/** 轮询的三种合法 state（逐字：`login-client.ts:170-186`）。 */
export const CLI_POLL_STATE = {
  pending: 'pending',
  ready: 'ready',
  failed: 'failed',
} as const

/**
 * `state=failed` 时**只有字面量 `denied`** 归为「用户在浏览器里拒绝了授权。
 *
 * 其余 reason 一律归为「未知失败」（逐字：`login-client.ts:172-178`）。
 * 这样分是因为两者的下一步不同：denied 是用户明确拒绝，再点一次登录可能就对了；
 * 未知失败更可能是上游的问题或流程已过期，重试同样的动作多半还是同样的错。
 */
export const CLI_FAILURE_DENIED = 'denied'

/** 错误详情（`desc`）去控制字符之后的最大长度（逐字：`login-client.ts:39`）。 */
export const MAX_ERROR_DETAIL_LENGTH = 240

/**
 * `uid` 的形状与长度上限（逐字：`login-client.ts:330`）。
 *
 * 它会被写进本机的凭据存储，所以先在这里收窄再落盘；不合格的**整个丢弃**而不是截断——
 * 截断出来的 uid 有可能与另一个账号撞上，而撞上的后果是号池里两行指向同一个身份。
 */
export const UID_PATTERN = /^[\w.@:-]+$/
export const UID_MAX_LENGTH = 64

/**
 * 单次登录 HTTP 请求的超时：15 秒（逐字：`login-client.ts:27`）。
 *
 * 官方给的理由是：a stuck request must leave time for retries within the login deadline——
 * 卡住的单次请求必须给登录总时限里的重试留出余量。所以它是 15s 而不是「反正有总超时」。
 */
export const LOGIN_REQUEST_TIMEOUT_MS = 15_000

/**
 * 登录总超时：默认 10 分钟（逐字：`step-provider/index.ts:70`）。
 *
 * 它只是**外层上界**；真正决定轮询何时结束的是开流响应里的 `expires_at`
 * （`login-polling.ts:21`：the outer login owns the local timeout; this loop only
 * needs the server expiry）。两个都实现，取小的那个先到就停。
 * 可由 `STEP_OAUTH_TIMEOUT_MS` 覆盖（见本文件末尾的覆盖表）。
 */
export const LOGIN_FLOW_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 轮询间隔的客户端 clamp 上界：60 秒（逐字：`login-client.ts:39` 的 `MAX_POLL_INTERVAL_SEC`）。
 *
 * 下界 1 秒（`login-polling.ts:6` 的 `MIN_STEP_POLL_INTERVAL_MS`）来自上游自己
 * 只校验「不小于 1 秒」，它同时也是防打爆上游的底线。
 */
export const POLL_MIN_INTERVAL_MS = 1_000
export const POLL_MAX_INTERVAL_SEC = 60

/**
 * 本线路凭据的 refresh 哨兵。
 *
 * 逐字：官方 `STEP_STATIC_REFRESH_TOKEN = 'step-static-credential'`
 * （`step-provider/index.ts:81`），且 `refreshStepOAuth` 对任何不是它的 refresh 直接抛错。
 * 落盘时原样保留这个常量，是为了让这份凭据**能被别人认出来**——包括本插件自己的号池。
 */
export const STATIC_REFRESH_TOKEN = 'step-static-credential'

/**
 * 本线路凭据的 `expires`：`Number.MAX_SAFE_INTEGER`（逐字：`step-provider/index.ts:367`）。
 *
 * 为什么不是 `Infinity`：JSON 存不下 `Infinity`，而这份凭据要落盘。
 * 读回时**不得**把这个值当成「已过期的怪数据」——它是「永不过期」的写法。
 */
export const STATIC_EXPIRES_AT = Number.MAX_SAFE_INTEGER

// ---------------------------------------------------------------------------
// 模型面
// ---------------------------------------------------------------------------

/**
 * 四个 profile **全部**走 OpenAI Chat Completions。
 *
 * 逐字（`step-provider/index.ts:86-92`）：All Step profile URLs speak the OpenAI Chat
 * Completions API (`{baseUrl}/chat/completions`)，随包基线与从 `{base}/models` 发现的
 * 模型共用这一个方言。所以本线路没有「逐模型声明协议面」那一维——
 * 与 glm-coding-plan 不同，不要给它加一个选错的可能。
 */
export const CHAT_COMPLETIONS_PATH = '/v1/chat/completions'

/**
 * 模型列表路径：`GET {归一化 base}/v1/models`。
 *
 * 逐字（`step-provider/index.ts:406-411`）：`stepOpenAiBaseUrl` 在归一化后的 base 上
 * 补 `/v1`，而发现用的就是那个 base 的 `models`。
 */
export const MODELS_PATH = '/v1/models'

/**
 * 逐模型详情的 base：**域名根的 `/v1`**，不是 `{base}/v1`。
 *
 * 逐字（`step-provider/index.ts:414-420`）：The detail endpoint lives at the domain-root
 * `/v1`，即使 profile 是 `step_plan`（它的列表 base 是 `.../step_plan/v1`），
 * 带子路径的那个变体会 404。这是一个**反直觉但必须照抄**的端点位置。
 */
export const MODEL_DETAIL_BASE_PATH = '/v1'

/**
 * 目录里保留的 `model_type`。
 *
 * 逐字（`step-provider/index.ts:99-100`）：Step 是 coding agent，只保留可对话的类型——
 * 大语言模型与路由模型；网页搜索、TTS、ASR、实时语音、文生图等一律滤掉。
 * 这两个中文字面量**逐字照抄**，因为它们就是上游 `model_type` 的取值。
 */
export const USABLE_MODEL_TYPES: readonly string[] = ['大语言模型', '路由模型']

/**
 * 目录没给的字段的兜底值（逐字：`step-provider/index.ts:103-107`）。
 *
 * `cost` 四个键全 0 不是笔误：上游没填过这张表。所以本线路的用量卡片
 * **只展示 token，不展示金额**（见共享契约的 `STEP_CODE_PRICING_STATUS`）。
 */
export const MODEL_DEFAULTS = {
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 256_000,
} as const

/** 上下文窗口的兜底值：256000（逐字：`MODEL_DEFAULTS.contextWindow`）。 */
export const DEFAULT_CONTEXT_WINDOW = MODEL_DEFAULTS.contextWindow

/**
 * 目录没声明输出上限时的兜底：**等于上下文窗口**。
 *
 * 逐字（`step-provider/index.ts:124-126`）：The endpoint reports no max-output;
 * default it to the input window。所以「调用方不指定时的输出上限」不是一个独立常量，
 * 它是上下文窗口的派生值——本线路不给它写死一个数。
 */
export function defaultMaxTokens(contextWindow: number = DEFAULT_CONTEXT_WINDOW): number {
  return contextWindow
}

// ---------------------------------------------------------------------------
// 额度面（开发者中心，非公开接口）
// ---------------------------------------------------------------------------

/**
 * 开发者中心 Dashboard 的两个额度接口。
 *
 * ⚠ **这是非公开接口**（`/api/step.openapi.devcenter.Dashboard/…`，不属于任何公开契约），
 * 上游随时可能改路径或字段。所以它们与登录控制面分开放，且**每一段都要能单独降级**：
 * 额度失败（含上游改版）不得影响模型请求（计划 §5、§10 风险 1）。
 *
 * 逐字来源：计划 §5 的端点矩阵（第三方已实现的公开形态），与
 * `docs/step-integration.md` 里开发者中心的登录说明互相印证。
 */
export const QUOTA_PATHS = {
  /** 额度窗口 / Credit 池。 */
  rateLimit: '/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit',
  /** 套餐状态（套餐名与续费时刻）。 */
  planStatus: '/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus',
} as const

/**
 * 账号密码换 Oasis-Token 的三步。
 *
 * 逐字：`GET {auth}` 取 `INGRESSCOOKIE` → `POST …/RegisterDevice` 拿匿名 token →
 * `POST …/SignInByPassword` 换 Oasis-Token。
 *
 * ⚠ **账号密码过手是本线路唯一的合规/稳定性风险点**，必须在 README 与设置页明示（计划 §5）。
 * 自动登录失败一律降级到「手动粘贴 Oasis-Token」，不得反复重试密码。
 */
export const QUOTA_AUTH_PATHS = {
  /** 匿名设备注册（换匿名 token）。 */
  registerDevice: '/passport/proto.api.passport.v1.PassportService/RegisterDevice',
  /** 账号密码换 Oasis-Token。 */
  signInByPassword: '/passport/proto.api.passport.v1.PassportService/SignInByPassword',
} as const

/**
 * 额度面的鉴权 Cookie（逐字：计划 §5）。
 *
 * `Oasis-Webid` 必须与该 token 的 `device_id` claim 一致，否则服务端报
 * 「token is embezzled」（计划 §10 风险 5）。所以它**不是一个可以随便填的请求头**，
 * 而是一对必须一起读一起存的凭据。
 */
export const QUOTA_COOKIE_NAMES = {
  token: 'Oasis-Token',
  webid: 'Oasis-Webid',
} as const

/** 开发者中心额外要求的两个头（逐字：计划 §5）。 */
export const QUOTA_HEADERS = {
  appid: 'oasis-appid',
  platform: 'oasis-platform',
  /** `oasis-webid` 既作请求头也作 Cookie 名，两处同一个字符串。 */
  webid: 'oasis-webid',
} as const

/**
 * `oasis-appid` 的取值：Oasis 网关注册的应用 id，**不是** `'web'`。
 *
 * 这个值由实测确定，不是猜的（2026-10-12 用真实请求打
 * `POST {authBase}/passport/proto.api.passport.v1.PassportService/RegisterDevice`）：
 *
 * ```
 * oasis-appid: web     -> HTTP 500  {"code":"internal","message":"app configuration is missing"}
 * oasis-appid: 10300   -> HTTP 200  {"accessToken":{...},"refreshToken":{...},"registry":{"appId":10300,...}}
 * ```
 *
 * 服务端拿这个头去查应用配置，查不到就报 `app configuration is missing`；而
 * `10300` 是它认的 id（响应里的 `registry.appId` 会把这个值回显出来，可据此复核）。
 * 它与 `oasis-platform` 的 `'web'` 是**两个不同的头**，早期实现把两者填成同一个值，
 * 于是每一步都 500——错误信息里看不出是哪个头的问题，只有对照一个能登录的客户端
 * （CodexBar 的 StepFun 实现，`appID = "10300"`）才能定案。
 */
export const OASIS_APP_ID = '10300' as const

/** 少了它 `RegisterDevice` 只返回 500，所以它是额度凭据流程的必需头，不是可选装饰。 */
export const OASIS_PLATFORM = 'web' as const

/**
 * 额度面的两代载荷字段名。
 *
 * 逐字（计划 §5）：
 *
 * - **老式**：`five_hour_usage_left_rate` / `weekly_usage_left_rate` + 对应的 reset 时间。
 * - **新式**：`plan_family = 2` + `plan_credit_rate_limit.{subscription_credit_left_rate,
 *   topup_credit_left_rate, credit_buckets[]}`。
 *
 * 为什么逐条抄而不是抽象成一张表：这两代字段是**两份独立的上游事实**，
 * 它们之间的关系是「服务端换了一代」，不是「同一份数据的两种写法」。
 *
 * **判定规则**：按载荷形状判定，**不单信 `plan_family`**（计划 §5 的加粗句）。
 * `plan_family` 是一个可以先于载荷改版的字段，只认它就会把一份带
 * `credit_buckets` 但 `plan_family` 还没更新的新响应读成老式——
 * 代价是额度卡片显示「5 小时窗口」而用户实际在用 Credit 池。
 */
export const QUOTA_LEGACY_FIELDS = {
  fiveHour: 'five_hour_usage_left_rate',
  weekly: 'weekly_usage_left_rate',
} as const

export const QUOTA_CREDIT_FIELDS = {
  planFamily: 'plan_family',
  /** 新式套餐的 `plan_family` 取值。 */
  creditPlanFamily: 2,
  root: 'plan_credit_rate_limit',
  subscription: 'subscription_credit_left_rate',
  topup: 'topup_credit_left_rate',
  buckets: 'credit_buckets',
} as const

/**
 * 每个额度窗口的名义长度（分钟），键就是线路自己的窗口标识。
 *
 * W6 装配 `PoolAccountQuotaDto` 时用这张表：共享的 `PoolAccountQuotaWindowDto`
 * 只有 `label` / `usedPercent` / `windowDurationMins` / `resetsAt`，**没有窗口 key**，
 * 所以长度是线路自己的 `key` 映射过去的唯一一座桥（同一条先例见 glm-coding-plan 的
 * `QUOTA_WINDOW_MINUTES` 与 minimax-code 的 `WINDOW_MINUTES`）。
 *
 * 装配时另有三条规则，它们不在本文件实现，但必须照做（由
 * `src/host/common/account-quota.ts` 的 `quotaWindow()` / `poolQuota()` 实现）：
 *
 * 1. `label` 一律传空字符串——窗口名的规范在客户端字典里，host 没有资格下发展示文案。
 * 2. `usedPercent` 为 null 的窗口必须丢弃——null 不是 0%，是「未说明」。
 * 3. Credit 池**不是窗口**，它装进 `creditBuckets`，不要硬塞进 `windows` 画成进度条。
 *
 * 取值：
 *
 * - `five-hour` = 300。逐字：老式载荷的字段名就是 5 小时窗口。
 * - `weekly` = 10_080。逐字：字段名是周窗口。
 * - `credit` = 43_200。**未验证**：Credit 是按月失效的池，上游给的是每个桶自己的
 *   `expiresAt`，**没有**声明池的长度；43200（30 天）是按词义取的，
 *   缺一份真实 Credit 响应的样本。取错的后果只影响卡片上的窗口名文案，
 *   不影响额度数字本身，所以按词义取并在此标注。
 */
export const QUOTA_WINDOW_MINUTES: Readonly<Record<'five-hour' | 'weekly' | 'credit', number>> = {
  'five-hour': 300,
  weekly: 10_080,
  credit: 43_200,
}

// ---------------------------------------------------------------------------
// adopt：本机 stepcode 客户端的登录态（只读）
// ---------------------------------------------------------------------------

/** stepcode 客户端的配置目录名（逐字：`step/environment.ts:6` 的 `STEPCODE_CONFIG_DIR`）。 */
export const STEPCODE_CONFIG_DIR = '.stepcode'

/** 本机 stepcode 客户端的凭据文件名（逐字：`step/auth.ts:19` 的 `getStepAuthPath`）。 */
export const STEPCODE_AUTH_FILE = 'auth.json'

/**
 * adopt 要读的四个路径，按优先级排列（逐字：`step/auth.ts:29-45` 的 `getLegacyStepAuthPaths`）。
 *
 * 官方那条注释解释了顺序为什么这样：canonical root 那个文件排在最前，
 * 因为它是「需要就地归一化的旧 StepCode 凭据形状」，剩下的路径覆盖上一个版本
 * 写下的 Pi 形状文件。
 *
 * 本插件**只读**：只在用户显式点导入时读，绝不写入或删除 stepcode 的任何文件
 * （与 claude / codex / glm 的 adopt 语义一致）。
 */
export const STEPCODE_ADOPT_PATHS: readonly string[] = [
  `${STEPCODE_CONFIG_DIR}/${STEPCODE_AUTH_FILE}`,
  `${STEPCODE_CONFIG_DIR}/agent/${STEPCODE_AUTH_FILE}`,
  `${STEPCODE_CONFIG_DIR}/legacy-auth.json`,
]

/**
 * adopt 必须认出的两种旧形状。
 *
 * - `legacy-product-shape`：`{ apiKey, profile, uid }`——StepCode 自己写的老文件。
 * - `pi-shaped`：`{ step: { type: 'oauth', access, refresh, expires, profile, uid } }`——
 *   通用 coding-agent 的 auth.json 按 provider id 分条的形状。
 *
 * 官方把前者叫「product-owned `{ apiKey, ... }` object」，把后者归到 Pi 形状
 * （`step/auth.ts:75-77`）。本插件两种都读，但**只读**：官方的做法是就地改写成规范形状，
 * 本插件不做那一步——改写别人的文件是一次没有授权的写操作。
 */
export const STEPCODE_ADOPT_SHAPES = ['legacy-product-shape', 'pi-shaped'] as const

/** 本线路读 stepcode 登录态时的文件权限期望（`0600`）。 */
export const STEPCODE_AUTH_FILE_MODE = 0o600

// ---------------------------------------------------------------------------
// 超时与缓存
// ---------------------------------------------------------------------------

/** 单次上游业务 / 模型请求的超时。 */
export const CHAT_TIMEOUT_MS = 300_000

/** 模型目录 / 额度发现阶段的超时。 */
export const DISCOVERY_TIMEOUT_MS = 20_000

/** 额度快照的进程内缓存 TTL。 */
export const QUOTA_CACHE_TTL_MS = 2 * 60 * 1000

/** 模型目录的进程内缓存 TTL。 */
export const CATALOG_CACHE_TTL_MS = 30 * 60 * 1000

/**
 * Step 服务端的自动前缀缓存：**前缀 ≥ 256 token 即可命中**，LRU 淘汰
 * （计划 §4.1 的官方文档事实）。
 *
 * 这是**服务端行为**，不是请求参数：客户端既不能声明也不能延长它。
 * 它只在本线路内部的缓存诊断里当噪声地板使用（本波不落代码，波次 2B 实现）。
 */
export const CACHE_MIN_PREFIX_TOKENS = 256

/**
 * 本插件在 `User-Agent` 里报的身份。
 *
 * 如实报成这个第三方插件，不冒充官方客户端：base URL 与头部词汇是上游公开契约，
 * 而冒用官方客户端身份既不诚实也可能构成违约（同 glm 线路的 `USER_AGENT` 注释）。
 */
export const USER_AGENT =
  'dsh-chatgpt-subscription (+https://github.com/Aa728848/dsh-chatgpt-subscription)'

// ---------------------------------------------------------------------------
// 思考档位：词汇表之外还有「模型真实梯子」
// ---------------------------------------------------------------------------

/**
 * 两套词汇表的统一排名。
 *
 * DSH 的档位词汇比上游宽（本线路 6 档），而上游的 `reasoning_effort_support_list`
 * 是**逐模型**声明的：未列出的档位映射为「不支持」（含关闭值 `off`）。
 * 所以每个档位都要先落到**模型真实梯子**上再发出去，发一个模型不认的档位是必然失败的一次请求。
 *
 * 为什么要**跨两套词汇表排名**而不是只排上游那几档——这是本仓库历史记录下来的 bug：
 * 只排上游档位时，DSH 独有的 `minimal` 属于「未识别」，而未识别一律落在中档，
 * 于是 `minimal` 被发成 `medium`：模型想得比用户要求的长得多，**更慢而且更费额度**。
 * 把 `none`(0) 与 `minimal`(1) 也排进去，它们才有地方可落。
 */
const EFFORT_RANKS: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

/** 未识别档位的排名：中档，绝不取两端。 */
const UNKNOWN_EFFORT_RANK = 4

/**
 * 把一个档位收敛到某个模型真实梯子上的最近一档。
 *
 * 平手向上取，与其余各线路的收敛一致（宁可多想一点，也不要少想）。
 * 梯子为空（该模型不接受 `reasoning_effort`）时返回 null，调用方据此**不发**档位字段，
 * 而不是发一个模型不认的值。
 *
 * @param effort - DSH 侧的档位名（未知值按中档处理）。
 * @param ladder - 目录为该模型声明的真实档位；空数组表示「不发任何思考控制字段」。
 */
export function convergeStepCodeEffort(
  effort: string,
  ladder: readonly string[],
): StepCodeReasoningEffort | null {
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
  return best as StepCodeReasoningEffort
}

// ---------------------------------------------------------------------------
// 环境变量覆盖
// ---------------------------------------------------------------------------

/**
 * 覆盖表。理由是额度面与凭证的解析都是上游第一方 / 非公开接口，
 * 它们都可能在上游一次变更后整体失效（计划 §10）；覆盖让回滚变成改一个环境变量，
 * 而不是发一个版本。**命名照官方**，这样从官方那边搬过来的排障命令可以直接用。
 *
 * 优先级是**有意的**，照抄官方 `step-provider/index.ts:151-168` 的两个数组顺序：
 *
 * - api base：`STEP_PROVIDER_API_URL` > `STEP_API_URL` > `STEP_BASE_URL` >
 *   `STEPFUN_MESSAGES_ENDPOINT`。最后一位是历史 StepCode 用的端点覆盖，
 *   它**可能带完整的 `/v1/messages`**，所以它排在最后且必须经过归一化。
 * - auth base：`STEP_PROVIDER_AUTH_URL` > `STEP_AUTH_URL`。
 * - key：`STEP_API_KEY`；登录超时：`STEP_OAUTH_TIMEOUT_MS`。
 *
 * 读取一律发生在**调用时**（不是模块加载时），这样改环境变量立即生效、也便于测试注入。
 */
export const ENV_OVERRIDES = {
  apiBaseUrl: [
    'STEP_PROVIDER_API_URL',
    'STEP_API_URL',
    'STEP_BASE_URL',
    'STEPFUN_MESSAGES_ENDPOINT',
  ],
  authBaseUrl: ['STEP_PROVIDER_AUTH_URL', 'STEP_AUTH_URL'],
  apiKey: 'STEP_API_KEY',
  loginTimeoutMs: 'STEP_OAUTH_TIMEOUT_MS',
} as const

/** 读第一个非空的环境变量值；尾部斜杠一并剥掉（官方 `readEndpointOverride` 的语义）。 */
function readFirstEnv(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = (env[name] ?? '').trim()
    if (value !== '') return value.replace(/\/+$/, '')
  }
  return undefined
}

function textOverride(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = (env[name] ?? '').trim()
  return value === '' ? undefined : value
}

function positiveIntegerOverride(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = textOverride(env, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * 一条 profile 的模型面 base（**已归一化**，不带尾部斜杠、不带版本段）。
 *
 * 归一化在 host 侧就做掉，理由是官方的 `resolveStepProviderOptions` 也在注册时归一化
 * （`step-provider/index.ts:203`）：调用点拿到的一定是「路由前缀」，
 * 于是拼 `/v1/chat/completions`、`/v1/models` 时不会把版本段发两次。
 * 覆盖值原样接受，所以指向反代根的部署可以直接写反代地址。
 */
export function apiBaseForProfile(
  profile: StepCodeProfile,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = readFirstEnv(env, ENV_OVERRIDES.apiBaseUrl)
  return override ?? PROFILE_HOSTS[profile].api
}

/** 一条 profile 的授权 / 开发者中心源站（不带尾部斜杠）。 */
export function authBaseForProfile(
  profile: StepCodeProfile,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = readFirstEnv(env, ENV_OVERRIDES.authBaseUrl)
  return override ?? PROFILE_HOSTS[profile].auth
}

/** 用户拿 API Key 的页面（只用于卡片上的一个链接，不参与任何请求）。 */
export function keyPageForProfile(
  profile: StepCodeProfile,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return PROFILE_HOSTS[profile].keyPage
}

/** 环境变量里显式给出的 api key（`STEP_API_KEY`）；没有则 undefined。 */
export function apiKeyOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return textOverride(env, ENV_OVERRIDES.apiKey)
}

/** 登录总超时（`STEP_OAUTH_TIMEOUT_MS`）；未设置或非法时用出厂值。 */
export function loginTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerOverride(env, ENV_OVERRIDES.loginTimeoutMs) ?? LOGIN_FLOW_TIMEOUT_MS
}

// ---------------------------------------------------------------------------
// 区域解析
// ---------------------------------------------------------------------------

/**
 * 认不出区域时的默认 profile。
 *
 * 刻意取 `step_plan`（国区）而不是国际区：国内用户占绝大多数，而回落猜错的代价
 * 落在调用方身上——用错的端点会拿到明确的鉴权失败，而不是静默串区。
 *
 * 更重要的是这条回落**只出现在「凭据没自述 profile」时**。正常路径上区域永远由
 * `stepCodeRegionOf(profile)` 决定，不经过这里。
 */
export const DEFAULT_PROFILE: StepCodeProfile = 'step_plan'

/**
 * 一个 host 属于哪个区域。
 *
 * 判据分两层，是有意的：先按「整串等于（或以其为根）某个已知 host」匹配，
 * 覆盖值也参与这一步——部署把某区指到反代之后，host 上已经看不到原域名，
 * 只按域名片段判断会把反代地址错判成国际区；再退回按域名片段判断；
 * 两条都不命中才回落 `DEFAULT_PROFILE`。
 *
 * 同一条先例见 glm-coding-plan 的 `regionForHost`，注释里那句「猜错的代价落在调用方身上」
 * 在这里同样成立：本函数只回答「凭据没自述区域时猜一个」。
 */
export function regionForHost(host: string | undefined): StepCodeRegion {
  const value = (host ?? '').trim().toLowerCase()
  if (value === '') return stepCodeRegionOf(DEFAULT_PROFILE)
  if (value.includes('.ai')) return 'intl'
  if (value.includes('.com')) return 'cn'
  return stepCodeRegionOf(DEFAULT_PROFILE)
}

/** 把自由输入的 profile 名规整到本线路认识的四条；认不出来时返回 undefined。 */
export function normalizeProfile(value: unknown): StepCodeProfile | undefined {
  if (value === 'step_plan' || value === 'step_plan_oversea') return value
  if (value === 'platform_cn' || value === 'platform_oversea') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, '_')
    if (normalized === 'step_plan' || normalized === 'plan') return 'step_plan'
    if (normalized === 'step_plan_oversea' || normalized === 'plan_oversea') return 'step_plan_oversea'
    if (normalized === 'platform_cn') return 'platform_cn'
    if (normalized === 'platform_oversea' || normalized === 'platform_oversea') return 'platform_oversea'
  }
  return undefined
}
