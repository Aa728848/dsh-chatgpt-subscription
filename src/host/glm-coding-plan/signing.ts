/**
 * GLM（ZCode 账号）线路的 Client Request Signing V4（计划 §6.1 的 `signing.ts`，工作包 W4）。
 *
 * ## 一句话说清它的地位：这一层**默认关闭**，而且它不进入默认路径
 *
 * 唯一有真实调用记录的实现（hj01857655/ZCode）做过 A/B 对照：**带签名与不带签名的响应
 * 归一化后完全一致**（都是 HTTP 429 / 业务码 1113「没有余额也没有可用的资源包」）。
 * 也就是说：
 *
 * - 没有人观察到服务端因为**缺**签名而拒绝请求；
 * - 也没有一份证据能证明带签名能换到额外额度（参考实现注释里说的「150% 额度 / 夜间免费
 *   Flash」是它的**声称**，不是实测结论）。
 *
 * 按计划的证据分级（§2）这属于 **C 级 = 社区经验或架构推断，无实测**，实施规则是
 * 「**实现但默认不启用**，做对照实验」。所以：
 *
 * 1. `CLIENT_SIGNING_DEFAULT_ENABLED = false`（`types.ts`，冻结），本文件不重定义它；
 * 2. `buildSigningHeaders()` 是**唯一对外的签名入口**，它在门控关闭时返回空表并且
 *    **一次网络请求都不发**——这是结构性保证，不是靠调用方自觉；
 * 3. 门控由 `types.ts` 的 `clientSigningEnabled(env)` 读 `DSH_GLM_CLIENT_SIGNING=1` 打开。
 *
 * 门控关掉之后，`applyGlmClientSigning()` 拿到一个空表，调用方的请求头**一个键都不会变**。
 *
 * ## 实现来源与许可
 *
 * 移植自 MIT 许可的现成实现（本身就是 DSH 插件里的 TS 文件，纯 `node:crypto` 零依赖）：
 *
 * - 来源：<https://raw.githubusercontent.com/ShanWuYinShe/dsh-plugins/main/packages/dsh-any-connect/src/zcode-signer.ts>
 *   （仓库 ShanWuYinShe/dsh-plugins，路径 `packages/dsh-any-connect/src/zcode-signer.ts`，219 行）
 * - 许可：**MIT**（计划 R7：只有 MIT 仓库可以复制代码；bacnh85/pi-extensions 与
 *   TriDefender/zcode-api 的许可为 null，只读协议、照协议重写）
 * - 随附参考测试：同仓库 `test/zcode-signer.test.ts`
 *
 * 协议逐字要点（与上实现一致，本文件未改动算法）：
 *
 * - 握手：`POST {握手 origin}/api/paas/c1f3a7e2/v2/client`，头 `Authorization: {apiKeyId}.{apiKeySecret}`
 *   （**裸 Key，不加 Bearer**），体四字段 `{apiKey, nonce, sig, ts}`
 * - 密钥派生：HKDF-SHA256，`salt = 'WD_CLIENT_SIGN_KDF_SALT'`，`info = 'getSignKey_hmac'`（导出
 *   HMAC 密钥）/ `'ed25519_priv'`（导出解私钥用的 AES-GCM 密钥），长度均为 32 字节
 * - HMAC 消息：`"get_sign_key\n{apiKeyId}\n{ts}\n{nonce}"`，**换行分隔**（空格分隔会被拒），
 *   结果 base64
 * - 响应 `data.privateCipher` → AES-256-GCM 解密，iv 取前 12 字节、tag 取末 16 字节、
 *   AAD = apiKeyId；解密出的明文**又是 base64** 的 PKCS#8 Ed25519 私钥（双层编码）
 * - 业务签名消息：`"{apiKeyId}\n{ts}\n{clientVersion}\n{sessionId}\n{nonce}"`，Ed25519 签名后
 *   **base64**（不是 hex）
 * - PoW：`sha256("{apiKeyId}\n{appId}\n{sessionId}\n{ts}")` 的 hex 取**前 32 字符**作 seed，
 *   在 `sha256("{seed}\n{nonce}{counter hex 8 位}")` 上找前导 0 位 >= 8 的解
 * - App id = `'zcode'`
 *
 * ## 相对参考实现改掉的三处（计划 R2 / 任务书，逐条对应）
 *
 * 1. **握手 origin 改成 `https://api.z.ai`。**
 *    参考实现硬编码 `open.bigmodel.cn`，但实测记录逐字写着「`/api/paas/*` 在 zcode.z.ai 上
 *    404，get_sign_key 端点回应在 api.z.ai 这个 origin」（计划 R2）。本线路默认用 api.z.ai，
 *    并按 `types.ts` 的覆盖写法接受 `DSH_GLM_SIGN_HANDSHAKE_BASE` /
 *    `DSH_GLM_SIGN_HANDSHAKE_URL` 覆盖（读取发生在调用时，不是模块加载时）。
 * 2. **clientVersion 默认提到 `3.15.1`**（参考实现是 `3.4.0`）。这个值同时进签名串与
 *    `X-Client-Version` / `X-ZCode-App-Version` / `User-Agent` 三个头，写错签名直接失效；
 *    TriDefender 的测试注释称 3.15.1 起 `/api/v1/agent/configs` 这个 gate 已移除。
 *    默认值可被 `DSH_GLM_SIGN_CLIENT_VERSION` 覆盖。
 * 3. **不移植 gate 逻辑。** 第二参考实现（pi-extensions，许可 null，只读协议）里有
 *    「先探 `/api/v1/agent/configs` 决定要不要签名」的门控，本线路**不做这个探测**：
 *    计划已把门控收敛成「默认关闭 + `DSH_GLM_CLIENT_SIGNING` 显式打开」，
 *    多一次探测就多一个会失败的上游依赖。
 *
 * ## 另外三处刻意偏离参考实现（理由随代码给出）
 *
 * - **不发 `Authorization`。** 参考实现返回的表里带 `Authorization: Bearer {id}.{secret}`，
 *   但本线路模型面的认证头是 W5/W6 的活，且 Anthropic 面要求**双头**
 *   （`x-api-key` + `Authorization: Bearer` 同值，计划 §3.3 逐字引用官方注释）。
 *   签名器若顺手覆盖 `Authorization`，会把装配层算好的认证头顶掉，所以这一行不归它。
 * - **默认不覆盖调用方的 `User-Agent`。** `types.ts` 的 `USER_AGENT` 明写「如实报成这个
 *   第三方插件，不冒充官方客户端」。`buildSigningHeaders()` 作为原样移植仍然返回
 *   `ZCode/{version}`，但 `applyGlmClientSigning()` 默认保留调用方已有的 `User-Agent`，
 *   要替换得显式传 `overrideUserAgent: true`。签名层本身整层都是「假装成官方客户端」，
 *   这道默认值让「开签名」不必等于「改身份」。
 * - **成功码同时认 `0` 与 `200`。** 参考实现只认 `code === 200`；本线路业务面信封把两者都
 *   当成功（见 `exchange.ts` 的 `isBizSuccessCode`），握手面在同一个 origin 上，只认一个会
 *   凭空制造一次失败。
 *
 * ## 未验证（缺什么证据）
 *
 * - 握手路径里的 `c1f3a7e2` 是否会轮换（计划 §9 明确未验证第 2 条）。缺一份上游变更通告，
 *   所以路径做成常量 + URL 覆盖。
 * - 私钥是否长期稳定：没有任何证据说服务端会为同一把 Coding Plan Key 重新下发私钥，
 *   因此这里按「一把凭据一把私钥」缓存到进程结束，W6 换凭据时应调 `clearPrivateKey()`。
 * - 明文**直接是 DER**（不做 base64）的形状没有证据；这里按 ASN.1 首字节做一次形状判定，
 *   两种形状都能解开，但只有 base64 双层那一种是参考实现实测过的。
 * - `X-Title: 'Z Code@cli'` / `X-Release-Channel: 'stable'` / `X-ZCode-Agent: 'glm'` 三个头
 *   是否参与签名校验无从判断；它们原样保留参考实现的取值，未做删减实验。
 * - 服务端是否真的因缺签名返回 `VERIFY_SIGNATURE_INVALID`：**从未被观察到**（计划 §9 末条）。
 */

import crypto from 'node:crypto'
import os from 'node:os'
import { clientSigningEnabled } from './types.ts'

// ---------------------------------------------------------------------------
// 协议常量（全部来自参考实现，注释逐条写明出处）
// ---------------------------------------------------------------------------

/** HKDF 的 salt，逐字来自参考实现的 `KDF_SALT`。 */
export const SIGNING_KDF_SALT = 'WD_CLIENT_SIGN_KDF_SALT'

/** 导出 HMAC 密钥的 HKDF info，逐字来自参考实现的 `INFO_HMAC`。 */
export const SIGNING_INFO_HMAC = 'getSignKey_hmac'

/** 导出「解私钥用的 AES-GCM 密钥」的 HKDF info，逐字来自参考实现的 `INFO_PRIV`。 */
export const SIGNING_INFO_PRIV = 'ed25519_priv'

/** HMAC 消息的第一行，逐字来自参考实现。**换行分隔**，空格分隔会被服务端拒。 */
export const SIGNING_HMAC_PREFIX = 'get_sign_key'

/** App id。国区授权入口的 `appId` 与这里同值（`bigmodelProviderConfig.ts:19-20,24`）。 */
export const SIGNING_APP_ID = 'zcode'

/**
 * 默认 clientVersion：`3.15.1`。
 *
 * 参考实现用的是 `3.4.0`，必须提上来——这个值同时进签名串与三个版本头，写错签名直接失效。
 * 取 `3.15.1` 的依据是 TriDefender 测试注释里那条「3.15.1 起 `/api/v1/agent/configs`
 * gate 已移除」，它是证据里出现过的唯一版本号。
 *
 * **未验证**：更大的版本号是否被接受、上游当前的实际版本是多少，都没有任何实测样本。
 * 缺一份真实请求的版本头观测。
 */
export const SIGNING_CLIENT_VERSION_DEFAULT = '3.15.1'

/**
 * 握手 origin 默认值：**api.z.ai**。
 *
 * 参考实现硬编码 `open.bigmodel.cn`，但实测记录逐字写着「`/api/paas/*` 在 zcode.z.ai 上 404，
 * get_sign_key 端点回应在 api.z.ai 这个 origin」（计划 R2）。本线路默认用 api.z.ai。
 *
 * **未验证**：国区（open.bigmodel.cn）是否也提供这个握手端点，没有实测样本。
 * 部署在国区时用 `DSH_GLM_SIGN_HANDSHAKE_BASE` 指过去。
 */
export const SIGNING_HANDSHAKE_ORIGIN_DEFAULT = 'https://api.z.ai'

/** 握手路径（逐字来自参考实现）。**未验证**：`c1f3a7e2` 是否会轮换（计划 §9 第 2 条）。 */
export const SIGNING_HANDSHAKE_PATH = '/api/paas/c1f3a7e2/v2/client'

/** PoW 默认难度：要求答案摘要前导 0 位 >= 8（即 `digest[0] === 0`）。 */
export const SIGNING_POW_BITS_DEFAULT = 8

/** PoW 的 seed 取 sha256 hex 的前 32 个字符（不是前 16 字节，这是原样的十六进制字符切片）。 */
export const SIGNING_POW_SEED_HEX_LENGTH = 32

/**
 * 握手超时。与其余上游端点「响应头 30s」同口径（沿用参考实现的 `HANDSHAKE_TIMEOUT_MS`，
 * 与 `types.ts` 的 `OAUTH_REQUEST_TIMEOUT_MS` 同为 30s）。
 *
 * 握手必须自己兜超时：它发生在一次模型请求之前，调用方传下来的 `signal` 与业务超时口径
 * 未必覆盖到这里；不设上界时握手端点挂死会把整条请求挂到 undici 的默认 headersTimeout。
 */
export const SIGNING_HANDSHAKE_TIMEOUT_MS = 30_000

/** PoW 计数器能取到的最大值（含）：答案的末 8 位十六进制就是它。 */
const POW_MAX_COUNTER = 0xffffffff

/** 一次握手请求体里的 nonce 字节数（12 字节 → 24 个十六进制字符）。 */
const HANDSHAKE_NONCE_BYTES = 12

/** 一次业务请求头里的 nonce 字节数（16 字节 → 32 个十六进制字符）。 */
const REQUEST_NONCE_BYTES = 16

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 签名层的任何失败都抛这一类，调用方按「签名不可用」降级（关闭该功能，而不是让请求整体失败）。 */
export class GlmSigningError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options === undefined ? undefined : { cause: options.cause })
    this.name = 'GlmSigningError'
  }
}

// ---------------------------------------------------------------------------
// 凭据解析
// ---------------------------------------------------------------------------

/** 一把 Coding Plan Key 拆开后的三份东西：id、secret、以及拼回去的裸值。 */
export interface GlmCodingPlanApiKey {
  apiKeyId: string
  apiKeySecret: string
  /** `{apiKeyId}.{apiKeySecret}`，即 Authorization 头与体 `apiKey` 字段要用的原值。 */
  credential: string
}

/**
 * 拆 `{apiKeyId}.{apiKeySecret}`。
 *
 * 严格只允许**一个**点：secret 里再有点会被判为非法，而不是悄悄把后面的部分截掉——
 * 上游对畸形 Key 的处置是 401（`ERROR_CODE.AUTH_INVALID`），本地早失败比发一次注定失败的
 * 握手请求好。返回值里没有 secret 之外的东西，日志里不要打印它。
 */
export function parseGlmCodingPlanApiKey(raw: string): GlmCodingPlanApiKey | undefined {
  const trimmed = raw.trim()
  const dot = trimmed.indexOf('.')
  if (dot <= 0 || dot !== trimmed.lastIndexOf('.')) return undefined
  const apiKeyId = trimmed.slice(0, dot).trim()
  const apiKeySecret = trimmed.slice(dot + 1).trim()
  if (apiKeyId === '' || apiKeySecret === '') return undefined
  return { apiKeyId, apiKeySecret, credential: trimmed }
}

function requireApiKey(raw: string): GlmCodingPlanApiKey {
  const parsed = parseGlmCodingPlanApiKey(raw)
  if (parsed === undefined) {
    throw new GlmSigningError('Coding Plan Key 格式非法（应为 apiKeyId.apiKeySecret）')
  }
  return parsed
}

// ---------------------------------------------------------------------------
// 环境变量覆盖（DSH_GLM_SIGN_*，读取一律发生在调用时）
// ---------------------------------------------------------------------------

/**
 * 覆盖读取方式照抄 `types.ts` 末尾那两个函数：调用时读 `env`、空串视作未设置、host 值去掉尾部斜杠。
 *
 * 不复用 `types.ts` 的 `hostOverride` 是因为它是模块私有的；这里复制的是**写法**而不是常量，
 * 覆盖表本身是本文件独有的（见文件头「实现来源」一节）。
 */
function signHostOverride(env: NodeJS.ProcessEnv, name: string): string {
  const value = (env[name] ?? '').trim()
  return value === '' ? '' : value.replace(/\/+$/, '')
}

function signTextOverride(env: NodeJS.ProcessEnv, name: string): string {
  const value = (env[name] ?? '').trim()
  return value === '' ? '' : value
}

/**
 * 握手 origin：`DSH_GLM_SIGN_HANDSHAKE_BASE` 覆盖，默认 `https://api.z.ai`。
 *
 * 做成 origin 而不是整串 URL，是为了让「换个部署/反代根」这件事与 `types.ts` 里
 * `businessHost` / `apiBaseForRegion` 的形状一致；路径部分是常量。
 */
export function signingHandshakeOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return signHostOverride(env, 'DSH_GLM_SIGN_HANDSHAKE_BASE') || SIGNING_HANDSHAKE_ORIGIN_DEFAULT
}

/**
 * 握手完整 URL。
 *
 * `DSH_GLM_SIGN_HANDSHAKE_URL`（整串覆盖）优先于 `DSH_GLM_SIGN_HANDSHAKE_BASE`。
 * 单独留一个整串覆盖是因为 `c1f3a7e2` 这段路径**是否会轮换没有验证**（计划 §9 第 2 条），
 * 上游一旦换路径，只改环境变量就能救，不必发一个版本。
 */
export function signingHandshakeUrl(env: NodeJS.ProcessEnv = process.env): string {
  const whole = signHostOverride(env, 'DSH_GLM_SIGN_HANDSHAKE_URL')
  if (whole !== '') return whole
  return signingHandshakeOrigin(env) + SIGNING_HANDSHAKE_PATH
}

/** 签名用的 clientVersion：`DSH_GLM_SIGN_CLIENT_VERSION` 覆盖，默认 `3.15.1`。 */
export function signingClientVersion(env: NodeJS.ProcessEnv = process.env): string {
  return signTextOverride(env, 'DSH_GLM_SIGN_CLIENT_VERSION') || SIGNING_CLIENT_VERSION_DEFAULT
}

// ---------------------------------------------------------------------------
// Proof of Work
// ---------------------------------------------------------------------------

export interface GlmSigningPowInput {
  apiKeyId: string
  /** 缺省 `'zcode'`。 */
  appId?: string
  sessionId: string
  ts: string
  /** 前导 0 位个数，缺省 8。 */
  powBits?: number
  /** 测试缝：固定 nonce 前缀（生产不传，用 12 字节随机）。 */
  noncePrefix?: string
}

/**
 * PoW 的 seed：`sha256("{apiKeyId}\n{appId}\n{sessionId}\n{ts}")` 的 hex 前 32 个字符。
 *
 * 单独抽出来是因为它同时是**签名前的诊断信息**：seed 算错时 PoW 必然解不出，
 * 而解不出与「难度太高」是两种完全不同的故障。
 */
export function signingPowSeed(input: {
  apiKeyId: string
  appId?: string
  sessionId: string
  ts: string
}): string {
  const appId = input.appId ?? SIGNING_APP_ID
  const message = `${input.apiKeyId}\n${appId}\n${input.sessionId}\n${input.ts}`
  return crypto.createHash('sha256').update(message).digest('hex').slice(0, SIGNING_POW_SEED_HEX_LENGTH)
}

/**
 * 解 PoW：找一个让 `sha256("{seed}\n{nonce}{counter}")` 前导 0 位 >= powBits 的 `{nonce}{counter}`。
 *
 * 答案的形状是 24 个字符的随机 nonce + 8 位十六进制计数器（原样照抄参考实现）。
 * 8 位难度平均 256 次尝试、12 位平均 4096 次，都是纯 CPU 的小量级，不构成请求路径上的负担；
 * 上游要更高难度时改 `powBits` 即可，本文件不做「自适应难度」。
 */
export function solveSigningProofOfWork(input: GlmSigningPowInput): string {
  const powBits = input.powBits ?? SIGNING_POW_BITS_DEFAULT
  const seed = signingPowSeed(input)
  const nonce = input.noncePrefix ?? crypto.randomBytes(HANDSHAKE_NONCE_BYTES).toString('hex')

  const fullBytes = Math.floor(powBits / 8)
  const remBits = powBits % 8
  const remMask = remBits === 0 ? 0 : (0xff << (8 - remBits)) & 0xff

  for (let counter = 0; counter <= POW_MAX_COUNTER; counter += 1) {
    const candidate = nonce + counter.toString(16).padStart(8, '0')
    const digest = crypto.createHash('sha256').update(`${seed}\n${candidate}`).digest()

    let matched = true
    for (let i = 0; i < fullBytes; i += 1) {
      if (digest[i] !== 0) {
        matched = false
        break
      }
    }
    if (matched && (remBits === 0 || ((digest[fullBytes] ?? 0xff) & remMask) === 0)) {
      return candidate
    }
  }
  throw new GlmSigningError('解不开签名用的 proof-of-work（counter 空间已耗尽）')
}

// ---------------------------------------------------------------------------
// 签名器
// ---------------------------------------------------------------------------

export interface GlmClientSignerOptions {
  /** 缺省 `fetch`。测试注入 mock。 */
  fetchFn?: typeof fetch
  /** 缺省 `process.env`。测试注入 `{}` / 自造环境。 */
  env?: NodeJS.ProcessEnv
  /** 握手超时，缺省 `SIGNING_HANDSHAKE_TIMEOUT_MS`。 */
  handshakeTimeoutMs?: number
}

export interface GlmSigningInput {
  /** `{apiKeyId}.{apiKeySecret}`。 */
  apiKey: string
  /** 缺省 `crypto.randomUUID()`。同一会话内多次调用应当复用同一个 sessionId。 */
  sessionId?: string
  /** 缺省读 `signingClientVersion(env)`。 */
  clientVersion?: string
  /** 缺省 `'zcode'`。 */
  appId?: string
  /** PoW 难度，缺省 8。 */
  powBits?: number
  /** 透传给握手 fetch 的取消信号。 */
  signal?: AbortSignal
}

/** 签名头表。空表 = 签名层关闭（门控的唯一对外表现）。 */
export type GlmSigningHeaders = Record<string, string>

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** 大小写不敏感地写一个头：同名不同大小写的两个键会被 `fetch` 合并成一条，后者覆盖前者。 */
function putHeader(target: GlmSigningHeaders, name: string, value: string): void {
  const lower = name.toLowerCase()
  for (const key of Object.keys(target)) {
    if (key.toLowerCase() === lower && key !== name) delete target[key]
  }
  target[name] = value
}

/**
 * 一把 Coding Plan Key 的签名器。
 *
 * **实例化而不是模块级单例**：一个号池可以同时持有两区多个账号（计划 §1、§8.2），
 * 而握手结果与私钥都是**按凭据**缓存的，单例会把第二个账号的私钥混进第一个账号的缓存。
 *
 * 但缓存只在实例内：模块级表会让 `{id}.{secret}` 这种含密的值在进程里长期驻留，
 * 而它并不需要跨实例复用——W6 建一个签名器用到底即可（同 `biz-token-cache.ts` 的取舍理由）。
 *
 * W5/W6 不应直接构造本类，请走 `applyGlmClientSigning()`（受门控）。
 */
export class GlmClientSigner {
  private readonly env: NodeJS.ProcessEnv
  private readonly fetchFn: typeof fetch
  private readonly handshakeTimeoutMs: number
  /** 已解出的私钥（PKCS#8 DER），按裸凭据分桶。 */
  private readonly privateKeys = new Map<string, Buffer>()
  /** 在飞的握手，按裸凭据分桶：并发调用只打一次上游。 */
  private readonly handshakes = new Map<string, Promise<Buffer>>()

  constructor(options: GlmClientSignerOptions = {}) {
    this.env = options.env ?? process.env
    this.fetchFn = options.fetchFn ?? fetch
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? SIGNING_HANDSHAKE_TIMEOUT_MS
  }

  /** 本实例当前会打的握手 URL（诊断用，设置卡片展示「签名会打到哪里」）。 */
  get handshakeUrl(): string {
    return signingHandshakeUrl(this.env)
  }

  /**
   * 拿到这把凭据的 Ed25519 私钥（PKCS#8 DER），必要时先握手一次。
   *
   * 缓存策略是「一把凭据一把私钥，直到 `clearPrivateKey()`」。
   * **未验证**：服务端会不会为同一把 Coding Plan Key 重新下发私钥，没有任何证据；
   * 若上游轮换私钥，症状会是「签名被拒」，处置是调 `clearPrivateKey()` 让它重握手。
   *
   * 这是低层原语，**不受门控**——门控在唯一对外的 `buildSigningHeaders()` 上。
   */
  async ensurePrivateKey(apiKey: string, signal?: AbortSignal): Promise<Buffer> {
    const parsed = requireApiKey(apiKey)

    const cached = this.privateKeys.get(parsed.credential)
    if (cached !== undefined) return cached

    // 在飞登记必须在第一个 await 之前完成，否则并发调用会各打一次握手。
    const joined = this.handshakes.get(parsed.credential)
    if (joined !== undefined) return joined

    const pending = this.performHandshake(parsed, signal)
      .then((key) => {
        this.privateKeys.set(parsed.credential, key)
        return key
      })
      .finally(() => {
        if (this.handshakes.get(parsed.credential) === pending) this.handshakes.delete(parsed.credential)
      })

    this.handshakes.set(parsed.credential, pending)
    return pending
  }

  /** 丢掉缓存的私钥（换凭据、怀疑上游轮换私钥时调用）；不给参数则全丢。 */
  clearPrivateKey(apiKey?: string): void {
    if (apiKey === undefined) {
      this.privateKeys.clear()
      return
    }
    const parsed = parseGlmCodingPlanApiKey(apiKey)
    if (parsed !== undefined) this.privateKeys.delete(parsed.credential)
  }

  /**
   * 握手一次并解出私钥。
   *
   * 步骤逐字照参考实现：HKDF 导出 HMAC 密钥 → 用 `"get_sign_key\n{id}\n{ts}\n{nonce}"`
   * （换行分隔）算 base64 签名 → POST → 取 `data.privateCipher` → HKDF 导出 AES-GCM 密钥解密。
   */
  private async performHandshake(parsed: GlmCodingPlanApiKey, signal?: AbortSignal): Promise<Buffer> {
    const ts = String(Date.now())
    const nonce = crypto.randomBytes(HANDSHAKE_NONCE_BYTES).toString('hex')
    const url = signingHandshakeUrl(this.env)

    const hmacKey = crypto.hkdfSync('sha256', parsed.apiKeySecret, SIGNING_KDF_SALT, SIGNING_INFO_HMAC, 32)
    const hmac = crypto.createHmac('sha256', Buffer.from(hmacKey))
    hmac.update(`${SIGNING_HMAC_PREFIX}\n${parsed.apiKeyId}\n${ts}\n${nonce}`)
    const sig = hmac.digest('base64')

    let payload: unknown
    let status = 0
    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          // 裸凭据，不加 Bearer（与配额接口同口径；参考实现逐字如此）。
          authorization: parsed.credential,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ apiKey: parsed.credential, nonce, sig, ts }),
        signal: withTimeout(signal, this.handshakeTimeoutMs),
      })
      status = response.status
      payload = await response.json().catch(() => undefined)
    } catch (error) {
      throw new GlmSigningError(
        `签名握手（${url}）请求失败（HTTP ${status || '—'}）：`
        + (error instanceof Error ? error.message : String(error)),
        { cause: error },
      )
    }

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new GlmSigningError(`签名握手（${url}）响应不是 JSON 对象（HTTP ${status}）`)
    }
    const envelope = payload as { code?: unknown; msg?: unknown; data?: { privateCipher?: unknown } }
    // 参考实现只认 200；本线路业务面信封 0 与 200 都算成功（exchange.ts 的 isBizSuccessCode），
    // 握手面在同一个 origin 上，只认一个会凭空制造一次失败。
    if (envelope.code !== 200 && envelope.code !== 0) {
      const msg = typeof envelope.msg === 'string' ? envelope.msg : 'unknown'
      throw new GlmSigningError(`签名握手被拒（HTTP ${status}）：code=${String(envelope.code)} msg=${msg}`)
    }
    const privateCipher = envelope.data?.privateCipher
    if (typeof privateCipher !== 'string' || privateCipher === '') {
      throw new GlmSigningError(`签名握手响应里没有 data.privateCipher（HTTP ${status}）`)
    }

    return this.decryptPrivateKey(parsed, privateCipher)
  }

  /**
   * 解 `privateCipher`：base64 → iv(12) ‖ ciphertext ‖ tag(16) → AES-256-GCM。
   *
   * AAD 是 apiKeyId（逐字来自参考实现）。解密出的明文按形状判定：
   *
   * - 明文**首字节是 0x30**（ASN.1 SEQUENCE）→ 明文本身就是 PKCS#8 DER；
   * - 否则按参考实现的实测口径再解一层 base64（双层编码）。
   *
   * **未验证**：第一种形状没有任何证据，只是为了上游哪天改掉这层 base64 时不至于整体失败。
   */
  private decryptPrivateKey(parsed: GlmCodingPlanApiKey, privateCipher: string): Buffer {
    const cipherBytes = Buffer.from(privateCipher, 'base64')
    const IV_BYTES = 12
    const TAG_BYTES = 16
    if (cipherBytes.length <= IV_BYTES + TAG_BYTES) {
      throw new GlmSigningError(`签名握手返回的 privateCipher 太短（${cipherBytes.length} 字节）`)
    }

    const aesKey = crypto.hkdfSync('sha256', parsed.apiKeySecret, SIGNING_KDF_SALT, SIGNING_INFO_PRIV, 32)
    const iv = cipherBytes.subarray(0, IV_BYTES)
    const ciphertextWithTag = cipherBytes.subarray(IV_BYTES)
    const ciphertext = ciphertextWithTag.subarray(0, -TAG_BYTES)
    const tag = ciphertextWithTag.subarray(-TAG_BYTES)

    let plaintext: Buffer
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(aesKey), iv)
      decipher.setAuthTag(tag)
      decipher.setAAD(Buffer.from(parsed.apiKeyId, 'utf8'))
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    } catch (error) {
      throw new GlmSigningError('签名握手返回的 privateCipher 解不开（密钥、AAD 或密文长度不对）', {
        cause: error,
      })
    }

    if (plaintext.length > 0 && plaintext[0] === 0x30) return plaintext
    return Buffer.from(plaintext.toString('utf8').trim(), 'base64')
  }

  /**
   * 生成本次请求的签名头表。**这是签名层唯一对外的入口，受门控。**
   *
   * 门控关闭（默认）时：返回**空表**，并且一次网络请求都不发——所以「默认路径不产生
   * 任何 X-Client-* 头」不是一句约定，而是这条分支的必然结果。
   *
   * 返回的表里**没有 `Authorization`**：本线路模型面的认证头由 W5/W6 装配，
   * Anthropic 面要求 `x-api-key` 与 `Authorization: Bearer` 双头同值（计划 §3.3），
   * 签名器越权写那一行会把装配层算好的头顶掉。
   */
  async buildSigningHeaders(input: GlmSigningInput): Promise<GlmSigningHeaders> {
    if (!clientSigningEnabled(this.env)) return {}

    const parsed = requireApiKey(input.apiKey)
    const privateKeyDer = await this.ensurePrivateKey(input.apiKey, input.signal)
    const sessionId = input.sessionId ?? crypto.randomUUID()
    const clientVersion = input.clientVersion ?? signingClientVersion(this.env)
    const ts = String(Date.now())
    const clientNonce = crypto.randomBytes(REQUEST_NONCE_BYTES).toString('hex')
    const pow = solveSigningProofOfWork({
      apiKeyId: parsed.apiKeyId,
      appId: input.appId,
      sessionId,
      ts,
      powBits: input.powBits,
    })

    // 签的是**换行分隔**的五段，版本号在第三段——写错版本签名直接失效。
    const signData = `${parsed.apiKeyId}\n${ts}\n${clientVersion}\n${sessionId}\n${clientNonce}`
    const privateKey = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' })
    const clientSig = crypto.sign(null, Buffer.from(signData, 'utf8'), privateKey).toString('base64')

    const platform = os.platform()
    const osCategory = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux'

    return {
      'User-Agent': `ZCode/${clientVersion}`,
      'X-App-Id': input.appId ?? SIGNING_APP_ID,
      'X-Client-Version': clientVersion,
      'X-ZCode-App-Version': clientVersion,
      'X-Session-Id': sessionId,
      'X-Client-Ts': ts,
      'X-Client-Nonce': clientNonce,
      'X-Client-Pow': pow,
      'X-Client-Sig': clientSig,
      'X-Title': 'Z Code@cli',
      'X-Release-Channel': 'stable',
      'X-ZCode-Agent': 'glm',
      'X-Platform': `${platform}-${os.arch()}`,
      'X-Os-Category': osCategory,
    }
  }
}

export interface GlmApplySigningOptions extends GlmClientSignerOptions {
  /** 复用已有签名器（跨请求复用它的握手缓存与私钥缓存）。 */
  signer?: GlmClientSigner
  sessionId?: string
  clientVersion?: string
  powBits?: number
  /**
   * 是否用 `ZCode/{version}` 覆盖调用方已有的 `User-Agent`。
   *
   * 默认 **false**：`types.ts` 的 `USER_AGENT` 明写「如实报成这个第三方插件，不冒充官方
   * 客户端」，开签名不必等于改身份。签名串与两个 `X-Client-Version` 头用的仍是同一个版本号，
   * 所以不覆盖 `User-Agent` 不会让签名失效。
   */
  overrideUserAgent?: boolean
}

/**
 * 把签名头合并进调用方的请求头表，**就地写入并返回同一对象**。
 *
 * 门控关闭时返回原对象且**一个键都不动**——这是计划 §8.2「断言默认路径不产生 X-Client-* 头」
 * 对装配层（W5/W6）的保证：不调用方需要写任何 `if`。
 *
 * 合并时大小写不敏感地覆盖同名头，避免调用方已经写了 `x-client-version` 时
 * `fetch` 拿到两条同名头、取值取决于键的插入顺序。
 */
export async function applyGlmClientSigning(
  headers: GlmSigningHeaders,
  input: { apiKey: string; signal?: AbortSignal },
  options: GlmApplySigningOptions = {},
): Promise<GlmSigningHeaders> {
  const env = options.env ?? process.env
  if (!clientSigningEnabled(env)) return headers

  const signer = options.signer ?? new GlmClientSigner(options)
  const signing = await signer.buildSigningHeaders({
    apiKey: input.apiKey,
    sessionId: options.sessionId,
    clientVersion: options.clientVersion,
    powBits: options.powBits,
    signal: input.signal,
  })

  const overrideUserAgent = options.overrideUserAgent === true
  for (const [name, value] of Object.entries(signing)) {
    if (!overrideUserAgent && name.toLowerCase() === 'user-agent') continue
    putHeader(headers, name, value)
  }
  return headers
}
