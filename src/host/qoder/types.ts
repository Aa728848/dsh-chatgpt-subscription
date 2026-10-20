/**
 * Qoder（订阅）线路的静态事实（host 侧）。
 *
 * 本文件里的每个取值都来自 `docs/qoder-line-plan.md` 的逐字证据（官方文档 /
 * pi-provider-qoder / qodercli2api 的 frozen fixtures），注释写明「是什么、为什么、
 * 证据来自哪」；凡是猜出来的值都在注释里标了「未验证」。**不另创事实**：
 * 本线路不发明端点、不发明字段、不发明档位。
 *
 * 四条必须记住的上游事实：
 *
 * 1. **区域由凭据唯一决定。** qoder.sh 与 qoder.com.cn 两套部署互不通用，
 *    一个区铸造的凭据打另一个区的端点会被拒。端点永远从区域表里取，
 *    不在调用处按「当前设置」拼。
 * 2. **凭据会过期、可刷新。** job token 有 `expires_at`/`expires_in`；这与
 *    step-code 的静态凭据相反——号池钩子是活的，提前 1 小时刷新
 *    （逐字 qodercli2api `docs/oauth.md` §3：`expire_time - 3600 < now` 时提前刷新）。
 * 3. **对话协议是 COSY 签名 + 自定义 body codec + 信封 SSE。** 签名的每一步都有
 *    frozen fixture 锁定（`test/qoder-cosy.test.ts`），改任何一步都会红。
 * 4. **COSY 版本落后会拿到缩减的模型目录。** 版本必须跟随 Qoder CLI 最新 release
 *    （pi-provider `cosy-version.ts` 注释：the gateway hands out a reduced model
 *    catalog to clients whose COSY version lags）。
 */

import type { QoderReasoningEffort, QoderRegion } from '../../shared/qoder-contracts.ts'
import { QODER_PROVIDER_ID, QODER_PROVIDER_NAME, QODER_REASONING_EFFORTS } from '../../shared/qoder-contracts.ts'

export const PROVIDER_ID = QODER_PROVIDER_ID
export const PROVIDER_NAME = QODER_PROVIDER_NAME

/** 本线路在 host 侧使用的档位名，等于共享契约的线路级词汇表（同一份数组，不另建一份）。 */
export const QODER_EFFORTS = QODER_REASONING_EFFORTS

// ---------------------------------------------------------------------------
// 两个区域的端点表（逐字 pi-provider-qoder src/region.ts）
// ---------------------------------------------------------------------------

/** 一个区域的全部 host 侧事实。 */
export interface QoderRegionHosts {
  /** 推理面 base（**不带尾部斜杠**）：模型列表与对话都打这里。 */
  inference: string
  /** OpenAPI 源站：PAT 兑换、userinfo、额度、设备轮询。 */
  openapi: string
  /** center 源站：令牌刷新。CN 与推理面同源（逐字 region.ts）。 */
  center: string
  /** 用户管理页（PAT 入口、套餐页；只用于卡片上的链接）。 */
  manage: string
  /** 用户拿 PAT 的页面（只用于卡片上给一个「去这里拿」的链接）。 */
  patPage: string
  /** 浏览器设备流的授权页；CN 没有（`supportsBrowserLogin: false`）。 */
  deviceAuthorizePage: string | null
  /** 设置卡片上这一行的标题。 */
  title: string
}

/**
 * 区域表。
 *
 * 逐字证据：pi-provider-qoder `src/region.ts` 的 `QODER_REGIONS`（Global 全部六个字段、
 * CN 的 baseUrl/openApiUrl/centerUrl/manageUrl；CN 没有 deviceLoginUrl，且
 * `supportsBrowserLogin: false`——官方 CLI 的中国版是另一个二进制 qoderclicn，
 * 它只接受 PAT 与本机登录态）。
 */
export const REGION_HOSTS: Readonly<Record<QoderRegion, QoderRegionHosts>> = {
  global: {
    inference: 'https://api3.qoder.sh',
    openapi: 'https://openapi.qoder.sh',
    center: 'https://center.qoder.sh',
    manage: 'https://qoder.com',
    patPage: 'https://qoder.com/account/integrations',
    deviceAuthorizePage: 'https://qoder.com/device/selectAccounts',
    title: 'Qoder 全球区（qoder.com）',
  },
  cn: {
    inference: 'https://gateway.qoder.com.cn',
    openapi: 'https://openapi.qoder.com.cn',
    center: 'https://gateway.qoder.com.cn',
    manage: 'https://qoder.com.cn',
    patPage: 'https://qoder.com.cn/account/integrations',
    deviceAuthorizePage: null,
    title: 'Qoder 中国站（qoder.com.cn）',
  },
}

/** 一个区域是否支持浏览器设备流登录（CN 只接受 PAT 与 adopt）。 */
export function regionSupportsDeviceLogin(region: QoderRegion): boolean {
  return REGION_HOSTS[region].deviceAuthorizePage !== null
}

// ---------------------------------------------------------------------------
// 对话面协议常量（逐字 qodercli2api docs/inference-protocol.md，fixture 锁定）
// ---------------------------------------------------------------------------

/**
 * 对话请求路径：`POST {inference}/algo{CHAT_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`。
 *
 * 逐字（inference-protocol.md §1，frozen fixture `infer-user-no-org.json` 的
 * `expected.url` 逐字节锁定）。`AgentId=agent_common` 是 URL 构造的固定常量，
 * **不读取 body 的 `agent_id`**。
 */
export const CHAT_PATH = '/api/v2/service/pro/sse/agent_chat_generation'

/** 对话 URL 的固定 query（顺序逐字，它参与 URL 但不参与签名）。 */
export const CHAT_QUERY = 'FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'

/**
 * COSY 签名用的固定路径：**不含 `/algo` 前缀、不含 query、不含尾随换行**
 * （逐字 inference-protocol.md §3.3）。
 */
export const COSY_SIGNED_PATH = '/api/v2/service/pro/sse/agent_chat_generation'

/** 模型列表路径：`GET {inference}/algo{MODEL_LIST_PATH}?Encode=1`（pi-provider region.ts）。 */
export const MODEL_LIST_PATH = '/algo/api/v2/model/list'

/** 模型列表 URL 的固定 query。 `Encode=1` 表示应答也走编码信封（pi-provider region.ts）。 */
export const MODEL_LIST_QUERY = 'Encode=1'

/** PAT 兑换路径（docs.qoder.com/cli/authentication + pi-provider pat.ts）。 */
export const JOB_TOKEN_EXCHANGE_PATH = '/api/v1/jobToken/exchange'

/** 用户信息路径（Bearer job token；pi-provider pat.ts `fetchUserInfo`）。 */
export const USERINFO_PATH = '/api/v1/userinfo'

/**
 * 额度路径（Bearer job token）。
 *
 * ⚠ **非公开个人端点**：不在 docs.qoder.com 的公开 OpenAPI 里，由 pi-provider
 * live 验证（其 README 的 Endpoints 表）。额度失败绝不影响模型请求（计划 §5）。
 */
export const QUOTA_USAGE_PATH = '/api/v2/quota/usage'

/** 令牌刷新路径（pi-provider oauth.ts `refreshQoderTokenForMode`，live 验证）。 */
export const REFRESH_TOKEN_PATH = '/algo/api/v3/user/refresh_token'

// ---------------------------------------------------------------------------
// COSY 签名常量
// ---------------------------------------------------------------------------

/**
 * 推理面 COSY 身份的随包回落版本。
 *
 * 逐字 pi-provider `cosy-version.ts` 的 `BUNDLED_GATEWAY_COSY_VERSION`（2026-06 抓取时
 * 的最新 Qoder CLI release）。生效值由 `client.ts` 的每日 release 跟随决定，
 * 这个常量只是「包刚装上、还没跟随过」时的兜底。
 */
export const QODER_BUNDLED_COSY_VERSION = '1.1.72'

/**
 * OpenAPI 面的 COSY 版本头（逐字 pi-provider `cosy.ts` 的 `QODER_OPENAPI_COSY_VERSION`：
 * PAT 兑换与 userinfo 用它，与推理面的版本是两份独立事实）。
 */
export const QODER_OPENAPI_COSY_VERSION = '1.0.1'

/** `Cosy-ClientType` / `Cosy-MachineType` 的取值（逐字 fixture 的 18 头集合）。 */
export const COSY_CLIENT_TYPE = '5'
export const COSY_MACHINE_TYPE = '5'

/** 场景四元组（逐字 inference-protocol.md §2 的默认值与 fixture 的 scene 块）。 */
export const COSY_SCENE = {
  businessProduct: 'cli',
  businessType: 'agent',
  clientType: COSY_CLIENT_TYPE,
  scene: 'assistant',
} as const

/** `Login-Version` 头（逐字 fixture）。 */
export const COSY_LOGIN_VERSION = 'v2'

/**
 * COSY 载荷的固定字段顺序（inference-protocol.md §3.2：字段顺序是签名敏感的）。
 * 装配 payload 时按这个顺序写键，不散装。
 */
export const COSY_PAYLOAD_KEYS = ['version', 'requestId', 'info', 'cosyVersion', 'ideVersion'] as const

/**
 * 请求体 codec 的自定义 alphabet（逐字 inference-protocol.md §4，与 pi-provider
 * `protocol/encoding.ts` 逐字相同）。索引 i 处的字符替换标准 Base64 alphabet 的第 i 个字符。
 */
export const QODER_BODY_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'

/** 标准 Base64 alphabet（codec 的另一半映射）。 */
export const QODER_STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** `=` padding 在编码后写成 `$`（逐字同上）。 */
export const QODER_BODY_PADDING_CHAR = '$'

/**
 * COSY 签名里参与 MD5 的五段（inference-protocol.md §3.3）：
 * payloadB64 LF key LF unixSeconds LF encodedBody LF signedPath，**末尾没有 LF**。
 */
export const COSY_SIGNATURE_SEGMENTS = 5

// ---------------------------------------------------------------------------
// 设备流登录（仅全球区；逐字 qodercli2api docs/oauth.md §2）
// ---------------------------------------------------------------------------

/** 官方 CLI 的固定 client_id（逐字 docs/oauth.md §2.1 的授权页 URL）。 */
export const QODER_DEVICE_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb'

/** 设备轮询路径：`GET {openapi}/api/v1/deviceToken/poll?nonce=…&verifier=…&challenge_method=S256`。 */
export const DEVICE_TOKEN_POLL_PATH = '/api/v1/deviceToken/poll'

/**
 * PKCE 风格参数（逐字 docs/oauth.md §2.1）：
 * verifier 43..128 字符（A-Z a-z 0-9 -._~），challenge = base64url_nopad(SHA256(verifier))，
 * nonce = random UUID，machine_id = 36 字符 UUID。
 */
export const DEVICE_VERIFIER_BYTES = 32

/**
 * 轮询节奏：404 = pending，每 1 秒重试（docs/oauth.md §2：CLI 每 1 秒重试，总超时 300 秒）。
 * pi-provider 用 2 秒 × 90 次（3 分钟）。本线路取 2 秒：比官方慢一倍，对上游更客气，
 * 而本地总超时给了 10 分钟，用户来得及。
 */
export const DEVICE_POLL_INTERVAL_MS = 2_000

/** 单次登录 HTTP 请求的超时（与 step-code 同值：卡住的请求必须给重试留余量）。 */
export const LOGIN_REQUEST_TIMEOUT_MS = 15_000

/** 登录总超时（本地外层上界；服务端 poll 的硬截止另行遵循）。 */
export const LOGIN_FLOW_TIMEOUT_MS = 10 * 60 * 1000

// ---------------------------------------------------------------------------
// 凭据刷新
// ---------------------------------------------------------------------------

/**
 * 提前刷新量：`expiresAt - 3600_000 < now` 时刷新（逐字 docs/oauth.md §3
 * 「`expire_time - 3600 < now` 时提前刷新」）。
 */
export const QODER_REFRESH_AHEAD_MS = 3_600_000

/**
 * 兑换响应缺 `expires_at`/`expires_in` 时的兜底寿命：24 小时
 * （pi-provider `exchangeJobToken` 的缺省值）。
 */
export const QODER_DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/** 写回前的安全边：过期时刻提前 5 分钟落盘（pi-provider 的 5 min buffer）。 */
export const QODER_EXPIRY_SAFETY_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// adopt：本机 qodercli 客户端的登录态（只读；逐字 docs/oauth.md §4）
// ---------------------------------------------------------------------------

/** qodercli 的配置目录名（官方文档 `QODER_CONFIG_DIR` 的默认值 `~/.qoder`）。 */
export const QODER_CONFIG_DIR = '.qoder'

/** qodercli 凭据文件名（`~/.qoder/.auth/user`；多 profile 是 `user.{name}`，本线路只读 canonical）。 */
export const QODER_AUTH_FILE = 'user'

/** qodercli 的 machine id 文件（36 字符 UUID；同时也是 adopt 文件的解密钥源）。 */
export const QODER_MACHINE_ID_FILE = 'machine_id'

/**
 * adopt 文件的加密格式（逐字 docs/oauth.md §4，frozen fixture `credential.json` 锁定）：
 *
 * - 明文：UserInfo 的 UTF-8 JSON；
 * - key：`machine_id` 前 16 个字符，作为 **raw 16-byte UTF-8 key**（不是 hex/base64 解码值）；
 * - cipher：AES-128-CBC，IV 与 key 完全相同的 16 bytes，PKCS#7 严格校验；
 * - envelope：strict standard padded Base64（必须有 `=` padding，不接受 URL-safe）。
 *
 * 官方加载兼容：去除外围空白后以 `{` 开头的内容按明文 JSON 解析。
 */
export const QODER_ADOPT_KEY_LENGTH = 16

// ---------------------------------------------------------------------------
// 模型面常量
// ---------------------------------------------------------------------------

/**
 * 输出上限兜底：131072。
 *
 * 目录不报输出上限；逐字 pi-provider `catalog.ts` 的 `MAX_OUTPUT_TOKENS`（依据：
 * Aliyun Model Studio——Qoder CN 目录背后的上游——文档对 qwen3.8/3.7 全系给出
 * Max Output Length = 131072；qodercli 自带的 32K 默认过于保守）。
 */
export const QODER_MAX_OUTPUT_TOKENS = 131_072

/**
 * 上下文窗口兜底（目录缺 `context_config` 时）。
 *
 * 逐字 pi-provider `catalog.ts`：global 1_000_000（对 global `lite` 实测 1000K 可过），
 * CN 200_000（保守值，CN 目录未在 1M 实测过）。
 * `max_input_tokens` 字段是陈旧的 180K 地板，**不可信**（pi-provider 注释逐字）。
 */
export const QODER_DEFAULT_CONTEXT_WINDOW: Readonly<Record<QoderRegion, number>> = {
  global: 1_000_000,
  cn: 200_000,
}

/** 单次上游业务 / 模型请求的超时（空闲看门狗拥有真实 deadline，这只是一个上限）。 */
export const CHAT_TIMEOUT_MS = 300_000

/** 模型目录 / 额度 / userinfo 等发现阶段请求的超时。 */
export const DISCOVERY_TIMEOUT_MS = 20_000

/** 额度快照的进程内缓存 TTL。 */
export const QUOTA_CACHE_TTL_MS = 2 * 60 * 1000

/** 模型目录的进程内缓存 TTL（pi-provider 用 1 小时；这里与 step-code 同取 30 分钟）。 */
export const CATALOG_CACHE_TTL_MS = 30 * 60 * 1000

/**
 * COSY 版本磁盘缓存的刷新间隔（逐字 pi-provider `cosy-version.ts`：一天一次）。
 */
export const COSY_VERSION_REFRESH_MS = 24 * 60 * 60 * 1000

/**
 * Qoder CLI release feed（逐字 pi-provider `cosy-version.ts` 的 `QODER_CLI_RELEASES_URL`）：
 * GitHub 形状的 API，服务于公开的 changelog 页（qoder.com/changelog?type=cli）。
 */
export const QODER_CLI_RELEASES_URL = 'https://repo.qoder.com/repos/QoderAI/changelog-CLI/releases?per_page=5&page=1'

/**
 * 本插件在 `User-Agent` 里报的身份。
 *
 * 如实报成这个第三方插件，不冒充官方客户端（同 glm 线路的 USER_AGENT 注释）。
 * COSY 头里的 `Cosy-Version` 是另一回事：它是协议身份，必须跟随官方 CLI
 * （否则拿到缩减目录），那不构成冒充——它是互操作协议的一部分。
 */
export const USER_AGENT =
  'dsh-chatgpt-subscription (+https://github.com/Aa728848/dsh-chatgpt-subscription)'

// ---------------------------------------------------------------------------
// 思考档位：词汇表之外还有「模型真实梯子」
// ---------------------------------------------------------------------------

/**
 * 两套词汇表的统一排名（与 step-code 同一套，理由逐字见它的注释：
 * 本仓库历史 bug——只排上游档位时 DSH 独有的 `minimal` 会落到中档，
 * 模型想得比用户要求的长得多，更慢而且更费额度）。
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
 * 平手向上取（宁可多想一点，也不要少想）。梯子为空（该模型不接受 `reasoning_effort`）
 * 时返回 null，调用方据此**不发**档位字段，而不是发一个模型不认的值。
 * 梯子里的 `none` 是关闭值：收敛到它时调用方发 `enable_thinking:false`。
 */
export function convergeQoderEffort(
  effort: string,
  ladder: readonly string[],
): QoderReasoningEffort | 'none' | null {
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
  // 梯子是模型自己声明的，所以命中的一定是它认识的值。
  return best as QoderReasoningEffort | 'none'
}

// ---------------------------------------------------------------------------
// 环境变量覆盖
// ---------------------------------------------------------------------------

/**
 * 覆盖表。COSY 签名、额度与设备流都是上游第一方 / 非公开接口，它们都可能在上游
 * 一次变更后整体失效（计划 §9）；覆盖让回滚变成改一个环境变量，而不是发一个版本。
 * 读取一律发生在**调用时**（不是模块加载时），便于测试注入。
 */
export const ENV_OVERRIDES = {
  /** 推理面 base 覆盖（按区域各一个）。 */
  inferenceBaseUrl: { global: 'QODER_API_BASE_URL', cn: 'QODER_CN_API_BASE_URL' },
  /** OpenAPI 源站覆盖。 */
  openapiBaseUrl: { global: 'QODER_OPENAPI_BASE_URL', cn: 'QODER_CN_OPENAPI_BASE_URL' },
  /** 登录总超时。 */
  loginTimeoutMs: 'QODER_LOGIN_TIMEOUT_MS',
} as const

function textOverride(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = (env[name] ?? '').trim()
  return value === '' ? undefined : value.replace(/\/+$/u, '')
}

/** 一个区域的推理面 base（调用时读环境变量；覆盖值剥掉尾部斜杠）。 */
export function inferenceBaseForRegion(region: QoderRegion, env: NodeJS.ProcessEnv = process.env): string {
  return textOverride(env, ENV_OVERRIDES.inferenceBaseUrl[region]) ?? REGION_HOSTS[region].inference
}

/** 一个区域的 OpenAPI 源站（调用时读环境变量）。 */
export function openapiBaseForRegion(region: QoderRegion, env: NodeJS.ProcessEnv = process.env): string {
  return textOverride(env, ENV_OVERRIDES.openapiBaseUrl[region]) ?? REGION_HOSTS[region].openapi
}

/** 一个区域的 center 源站（刷新端点打这里；随 OpenAPI 覆盖走，因为两者同区共生）。 */
export function centerBaseForRegion(region: QoderRegion, env: NodeJS.ProcessEnv = process.env): string {
  return textOverride(env, ENV_OVERRIDES.openapiBaseUrl[region]) ?? REGION_HOSTS[region].center
}

/** 登录总超时（`QODER_LOGIN_TIMEOUT_MS`）；未设置或非法时用出厂值。 */
export function loginTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = textOverride(env, ENV_OVERRIDES.loginTimeoutMs)
  if (value === undefined) return LOGIN_FLOW_TIMEOUT_MS
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : LOGIN_FLOW_TIMEOUT_MS
}
