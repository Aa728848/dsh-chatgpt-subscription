/**
 * W2：adopt —— 读取本机已登录的 ZCode 客户端登录态，免除二次登录（计划 D6）。
 *
 * 上游落盘事实全部来自官方开源源码，逐字证据在每条常量的注释里（计划 §3.7，证据等级 A）：
 *
 * - `shared-credentials.ts`（`SHARED_ZCODE_CREDENTIAL_KEYS`、`resolveSharedZCodeCredentialsPath`、
 *   `saveZaiLoginCredentials`）：路径、键名、以及 `oauth:bigmodel:*` 与 `oauth:zai:*` 是**两区各自的**凭据。
 * - `credential-cipher.ts`：`enc:v1:` 前缀、AES-256-GCM、iv 12B / tag 16B、
 *   密钥 `sha256(secret)`，secret 取 `ZCODE_CREDENTIAL_SECRET`，否则
 *   `zcode-credential-fallback:{platform}:{homedir}:{username}`。
 *
 * 两条必须照搬的规则（与 `src/host/claude/adopt.ts`、`src/host/codex-adopt.ts` 同一份纪律）：
 *
 * ---------------------------------------------------------------------------
 * 规则 1 —— 本模块永不写入。它是 reader，而且只是 reader。
 * ---------------------------------------------------------------------------
 * 不得创建、修改、移动或删除任何属于 ZCode 客户端的文件：不以写方式打开任何文件、
 * 不建目录、不改名、不 unlink。保证是**结构性**的而不是散文里的承诺——本模块从
 * `node:fs/promises` **按名**只导入 `readFile` 与 `stat` 两个函数，不导入整个命名空间，
 * 于是引入任何写操作都必须改动 import 列表，而那正是复审者第一行会看的地方。
 * 测试断言的是这条规则**可观测**的更强形式：adopt 跑完后凭据文件的字节、大小、mtime
 * 三者不变，所在目录没有新增条目。
 *
 * ---------------------------------------------------------------------------
 * 规则 2 —— 存在性与内容分成两个函数。
 * ---------------------------------------------------------------------------
 * `zcodeCredentialPresence()` 便宜到可以在插件启动时调用，只 `stat`、从不 open：
 * 没 opt in 的用户，他的令牌内容根本不会被读过——既不被它读，也不被渲染卡片的
 * 路由读。`readZcodeLocalSignIn()` 才是完整读取，且只在用户显式选择之后才被调用。
 * 分开是全部意义所在：一个「顺手先读一下以防万一」的启动路径会让 opt in 变成装饰。
 *
 * ---------------------------------------------------------------------------
 * 规则 3 —— 本模块不持有凭据存储，也不刷新。
 * ---------------------------------------------------------------------------
 * 上游**没有** refresh_token 交换接口（计划 §3.6：官方 `oauthService.ts:972-975` 直接抛错），
 * 所以「刷新」在这里不存在可做的事——adopt 到手的 OAuth access_token 是一次性快照。
 * 落盘与号池是 W6 的活，本模块只把兑换链的产物交出去。
 *
 * ---------------------------------------------------------------------------
 * 规则 4 —— 认不出来的形状永远给一个**值**，永远不给异常。
 * ---------------------------------------------------------------------------
 * adopt 是「省一次登录」的快捷路径，**失败永不阻断**（计划 D6、R6）：没有文件、
 * 读不了、不是 JSON、形状不认识、解不开、以及**上游兑换失败**，全部落在
 * `GlmAdoptResultDto` 的 `reason` 枚举里，卡片据此给出不同的下一步。
 * 一个异常逃进设置路由只会变成 500，而「没找到本机登录态」不是错误，是正常状态。
 *
 * 唯一原样抛出的是**调用方自己发起的取消**（`options.signal` 已 aborted）：那不是
 * 「上游没结论」，把取消吞成 `exchange-failed` 会让 W6 以为上游真的拒绝了。
 * 这条与 `oauth.ts` 的 `pollCliFlow` 同规则。
 *
 * ---------------------------------------------------------------------------
 * 这份文件里最容易写错的地方：两区的令牌必须**按区取**，绝不能扫
 * ---------------------------------------------------------------------------
 * `credentials.json` 是**平铺**的一包字符串，而且同时装着 `oauth:zai:access_token` 与
 * `oauth:bigmodel:access_token`——这是**两个部署各自独立的凭据**（计划 §1、§3.3）。
 * 「在 JSON 里找到第一个 access_token」这种扫法会按序列化顺序挑中其中一个，
 * 于是另一个部署的凭据被当成用户当前的订阅凭据送进兑换链——**串区**。
 * 所以读取是对 `oauth:{区}:access_token` 的直接、定址查找，永远不是树遍历；
 * 测试里放一份**两个区的令牌都在**的 fixture，并断言回来的是哪一个（两种取值顺序都覆盖：
 * 一个懒惰的实现对其中一种会靠运气答对）。
 */

import { createDecipheriv, createHash } from 'node:crypto'
// 绝不要把这一行放宽成 fs 命名空间对象，也不要用 star-import 引入 node:fs/promises：
// 「按名导入」正是上面「永不写入」那条规则可被一眼看出的形式，而测试正是按这份源码文本断言它。
import { readFile, stat } from 'node:fs/promises'
import { homedir, platform, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import type { GlmAdoptResultDto, GlmRegion } from '../../shared/glm-coding-plan-contracts.ts'
import type { GlmCodingPlanKey } from './exchange.ts'
import {
  GlmCodingPlanUnavailableError,
  exchangeForCodingPlanKey,
} from './exchange.ts'
import { DEFAULT_REGION } from './types.ts'

// ---------------------------------------------------------------------------
// 上游常量（逐字：credential-cipher.ts / shared-credentials.ts）
// ---------------------------------------------------------------------------

/**
 * 改写 ZCode 数据根目录的环境变量（逐字：`resolveSharedZCodeCredentialsPath` 里的
 * `ZCODE_DATA_BASE_DIR_ENV_KEY`）。客户端自己的优先级是 `baseDir ?? env ?? homedir()`，
 * 这里照抄同一个口径。
 */
export const ZCODE_DATA_BASE_DIR_ENV = 'ZCODE_DATA_BASE_DIR'

/**
 * 覆盖凭据加密密钥的环境变量（逐字：`credential-cipher.ts` 的 `CREDENTIAL_SECRET_ENV_KEY`）。
 *
 * **未设也能解密**：没有它时密钥由 `{platform}:{homedir}:{username}` 推导，
 * 所以普通用户的 adopt 走得通（计划 §3.7 的最后一行）。
 */
export const ZCODE_CREDENTIAL_SECRET_ENV = 'ZCODE_CREDENTIAL_SECRET'

/** 凭据文件在数据根下的两段目录名（逐字：`join(base, ".zcode", "v2", "credentials.json")`）。 */
const ZCODE_CREDENTIAL_DIR_SEGMENTS = ['.zcode', 'v2'] as const

/** 凭据文件名（逐字：`shared-credentials.ts` 的 `resolveSharedZCodeCredentialsPath`）。 */
export const ZCODE_CREDENTIAL_FILE = 'credentials.json'

/**
 * 凭据文档里的八个键（逐字：`SHARED_ZCODE_CREDENTIAL_KEYS`）。
 *
 * `oauth:{zai|bigmodel}:*` 是**两个部署各自的**令牌，`oauth:active_provider` 说明
 * 哪一区是当前活跃登录态。上游 `clearZaiLoginCredentials` 还透露了一件事：这个键
 * 只在活跃区是 zai 时才存在（它会连同 zai 的三个键一起删掉）。
 */
export const ZCODE_CREDENTIAL_KEYS = {
  activeProvider: 'oauth:active_provider',
  zaiAccessToken: 'oauth:zai:access_token',
  zaiRefreshToken: 'oauth:zai:refresh_token',
  zaiUserInfo: 'oauth:zai:user_info',
  bigmodelAccessToken: 'oauth:bigmodel:access_token',
  bigmodelRefreshToken: 'oauth:bigmodel:refresh_token',
  bigmodelUserInfo: 'oauth:bigmodel:user_info',
  zcodeJwtToken: 'zcodejwttoken',
} as const

/** 上游 `active_provider` 的字面量 → 本线路的区域。反向映射见 `types.ts` 的 `CLI_PROVIDER_BY_REGION`。 */
const REGION_BY_ACTIVE_PROVIDER: Readonly<Partial<Record<string, GlmRegion>>> = {
  zai: 'intl',
  bigmodel: 'cn',
}

/** 一个区自己的三个键；读取永远按区定位，不扫整份文档。 */
function providerKeys(provider: 'zai' | 'bigmodel'): {
  accessToken: string
  refreshToken: string
  userInfo: string
} {
  const prefix = 'oauth:' + provider + ':'
  return {
    accessToken: prefix + 'access_token',
    refreshToken: prefix + 'refresh_token',
    userInfo: prefix + 'user_info',
  }
}

/** 活跃区字面量 → 本线路的区域（`zai` → 国际区，`bigmodel` → 国区，计划 §3.1）。 */
export function regionForActiveProvider(value: string | undefined): GlmRegion | undefined {
  if (value === undefined) return undefined
  return REGION_BY_ACTIVE_PROVIDER[value.trim().toLowerCase()]
}

/** 加密值前缀（逐字：`credential-cipher.ts` 的 `ENCRYPTED_VALUE_PREFIX`）。 */
export const ENCRYPTED_VALUE_PREFIX = 'enc:v1:'

/** 加密算法（逐字：`CREDENTIAL_CIPHER_ALGORITHM`）。 */
export const CREDENTIAL_CIPHER_ALGORITHM = 'aes-256-gcm'

/** iv 字节数（逐字：`CREDENTIAL_CIPHER_IV_BYTES`）。 */
export const CREDENTIAL_CIPHER_IV_BYTES = 12

/** GCM 认证标签字节数（逐字：`CREDENTIAL_CIPHER_AUTH_TAG_BYTES`）。 */
export const CREDENTIAL_CIPHER_AUTH_TAG_BYTES = 16

/** 一份 adopt 成功的凭据来自哪里，供卡片与号池记录。 */
export const ZCODE_CREDENTIAL_SOURCE = 'zcode-client'

/** adopt 失败原因，直接取自冻结契约的 `GlmAdoptResultDto['reason']`，不另立一套。 */
export type GlmAdoptReason = NonNullable<GlmAdoptResultDto['reason']>

/**
 * 每个失败原因对应的一句可照做的下一步（给 W6 的 route 层与 W7 的设置卡片用）。
 *
 * 六个取值里 `secret-unavailable` 在本实现中**不会产生**，但契约已冻结了它，
 * 这里仍给它一句文案：判据见 `zcodeCredentialFallbackSecret` 的注释——
 * 密钥永远能从 platform + homedir + username 推出来，所以「拿不到密钥」
 * 这个状态在本线路里根本不成立，它是为将来某个要求显式 secret 的变体预留的。
 */
export const ADOPT_REASON_HINTS: Readonly<Record<GlmAdoptReason, string>> = {
  'no-credentials-file': '本机没有找到 ZCode 的凭据文件。请先在 ZCode 客户端登录一次，或改用浏览器登录本线路。',
  'secret-unavailable': '无法确定凭据文件的解密密钥（当前实现不会出现，预留给将来要求显式密钥的变体）。请改用浏览器登录。',
  'decrypt-failed': '凭据文件用的密钥本插件算不出来（多半是 ZCODE_CREDENTIAL_SECRET 与本进程不一致）。请改用浏览器登录。',
  'token-expired': 'ZCode 客户端里的这份登录态已经过期。请在 ZCode 客户端重新登录后再试一次，或改用浏览器登录。',
  'exchange-failed': '用这份登录态换取 Coding Plan Key 失败。请改用浏览器登录，以便看到完整原因。',
  'not-a-zcode-login': '凭据文件里没有可用的 ZCode 登录态。请在 ZCode 客户端登录一次，或改用浏览器登录。',
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 一段去空白后非空的字符串，或 undefined。 */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/**
 * 展开用户路径：`~` 与 `~/x` 走 home，其余按绝对路径解析。
 *
 * 逐字照 `shared-credentials.ts` 的 `resolveUserPath`：ZCODE_DATA_BASE_DIR 允许写成
 * `~/zcode-data`，不展开就会在 CWD 下建出一个字面叫 `~` 的目录。
 */
function resolveUserPath(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return resolve(value)
}

/**
 * ZCode 的数据根目录。
 *
 * 变量优先级与客户端一致：非空的 `ZCODE_DATA_BASE_DIR` 说了算，空白值按未设置处理
 * （否则在 Windows 上会解析成一个盘符相对路径），否则是 `os.homedir()`。
 *
 * 在**调用时**读，不是模块加载时：设完变量再导入本模块的测试也必须看得见。
 */
export function zcodeDataBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env[ZCODE_DATA_BASE_DIR_ENV] ?? '').trim()
  return resolveUserPath(override === '' ? homedir() : override)
}

/** 本模块会看的那一个凭据文件路径。 */
export function zcodeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(zcodeDataBaseDir(env), ...ZCODE_CREDENTIAL_DIR_SEGMENTS, ZCODE_CREDENTIAL_FILE)
}

/**
 * 候选路径，优先级最高的一个在前。
 *
 * 刻意**只有一条**候选，这是个明说的判断：这里的环境变量正是**客户端自己的**判定口径
 * （客户端也是 `baseDir ?? env ?? homedir()`），多查一个常规路径等于去猜一个客户端
 * 当前并未使用的配置，把另一个配置的凭据当成现在的登录态（照 `codex-adopt.ts` 同一条理由）。
 * 实际查过的那条路径由 `zcodeCredentialPresence` 一并返回并由卡片打印，
 * 所以「没找到」永远伴随着确切的位置。
 *
 * 纯函数，不碰文件系统，只为渲染卡片也可以安全调用。
 */
export function zcodeCredentialPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  return [zcodeCredentialsPath(env)]
}

/** stat 到的一个候选文件，带上它的 mtime。 */
interface ExistingFile {
  path: string
  modifiedAt: number | null
}

/**
 * 找出第一个存在的**普通文件**，只 stat。
 *
 * 用 stat 而不是 lstat：经由符号链接到达的凭据文件是一种合法布局（用户可能把配置放在
 * 链接后面），这里问的是「客户端在那里有没有一个文件」，不是「怎么到达的」。
 *
 * 任何错误（ENOENT / EACCES / ENOTDIR / 路径形状不支持）都回答「没有」：没能确认存在
 * 并不等于存在，而这条路径跑在启动阶段，为一个缺失的文件把插件拖垮是不可接受的。
 */
async function firstExistingFile(paths: readonly string[]): Promise<ExistingFile | null> {
  for (const candidate of paths) {
    try {
      const info = await stat(candidate)
      if (info.isFile()) return { path: candidate, modifiedAt: info.mtimeMs }
    } catch {
      // 见上方注释。
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 规则 2 的前半：存在性探测（只 stat）
// ---------------------------------------------------------------------------

/** 启动阶段那个问题的答案：有没有东西可以 adopt。 */
export interface ZcodeCredentialPresence {
  /** 有没有候选存在。它**不**对「能不能用」发表任何意见。 */
  present: boolean
  /** 第一个存在的候选，或 null。 */
  path: string | null
  /**
   * 查过的每一个候选，按优先级，无论存不存在。
   *
   * 一起返回是为了让卡片打印它确切地看过哪些地方：只告诉用户第一个路径，
   * 「没装 ZCode」与「你的 ZCode 存在别处」这两件事看起来完全一样。
   */
  searched: string[]
}

/**
 * 本机有没有一份 ZCode 登录态可以提供。
 *
 * 可以在插件启动时安全调用：它**从不**以读方式打开任何候选，所以没 opt in 的用户，
 * 他的令牌内容根本不会被读到。只有 stat 跑起来，它泄露的只是存在性与时间戳。
 *
 * 刻意**不**在这里回答「文件有效吗 / 过期吗 / 是不是 JSON」——那需要本模块存在的理由
 * 之外的那次读取，而卡片不需要它：有效性由读取（opt in 之后）回答，并以
 * 「凭据」或一个 `reason` 的形式落回卡片。
 *
 * paths 可注入，所以测试跑在 fixture 上而不是真实用户目录上；生产调用方取默认值。
 */
export async function zcodeCredentialPresence(
  paths: readonly string[] = zcodeCredentialPaths(),
): Promise<ZcodeCredentialPresence> {
  const searched = [...paths]
  const found = await firstExistingFile(searched)
  return found === null
    ? { present: false, path: null, searched }
    : { present: true, path: found.path, searched }
}

// ---------------------------------------------------------------------------
// credential-cipher 的解密
// ---------------------------------------------------------------------------

/**
 * 没有显式 secret 时用来推导密钥的那段字符串（逐字：`resolveCredentialSecret`）。
 *
 * 逐字格式是 `zcode-credential-fallback:{platform}:{homedir}:{username}`。
 * 三段都由**本进程**取，所以「设了 `ZCODE_CREDENTIAL_SECRET` 的用户 adopt 会失败」
 * （计划 R6）只在两种情况下发生：DSH host 与 ZCode 客户端跑在不同用户账号下，
 * 或者客户端被显式配置了 secret 而 host 没有。这两种都表现为 `decrypt-failed`，
 * 不是 `secret-unavailable`——密钥永远推得出来，推出来的那个解不开才是真实情况。
 *
 * `userInfo()` 抛错时退回 `unknown`，与上游逐字一致（它的注释写着：某些打包或沙箱
 * 运行时解析不出系统用户名）。所以本函数**永不抛错**。
 */
export function zcodeCredentialFallbackSecret(): string {
  let username = 'unknown'
  try {
    username = userInfo().username
  } catch {
    // 同上：上游也在这里退回 unknown。
  }
  return 'zcode-credential-fallback:' + platform() + ':' + homedir() + ':' + username
}

/**
 * 凭据密钥：`sha256(secret)`，32 字节（逐字：`deriveCipherKey`）。
 *
 * `ZCODE_CREDENTIAL_SECRET` 去空白后非空才作数，否则用 `zcodeCredentialFallbackSecret()`。
 */
export function deriveZcodeCredentialKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const configured = (env[ZCODE_CREDENTIAL_SECRET_ENV] ?? '').trim()
  const secret = configured === '' ? zcodeCredentialFallbackSecret() : configured
  return createHash('sha256').update(secret).digest()
}

/**
 * 解一个凭据值，**永不抛错**：解不开就是 undefined。
 *
 * 没带 `enc:v1:` 前缀的值按**明文**原样返回——上游 `decrypt` 正是这么做的，
 * 旧版本客户端写下的明文值仍然可读（计划 §3.7 的「值可能是明文（旧值）」）。
 *
 * 带前缀时逐字复刻上游的校验顺序：正好三段、每段非空、iv 12 字节、tag 16 字节，
 * 然后 `aes-256-gcm` 解密。**任何**一步不满足都返回 undefined 而不是异常——
 * 上游抛的是 Error，但本模块的契约是一个值（规则 4）。
 *
 * 密钥由调用方传进来而不是在这里读 env：读取一次文件只该推导一次密钥，
 * 而把这个纯函数原样暴露出去，测试就能用**同一套推导**造出真密文来验它。
 */
export function decryptZcodeCredentialValue(value: string, key: Buffer): string | undefined {
  if (!value.startsWith(ENCRYPTED_VALUE_PREFIX)) return value
  const parts = value.slice(ENCRYPTED_VALUE_PREFIX.length).split('.')
  if (parts.length !== 3) return undefined
  const [ivRaw, tagRaw, cipherRaw] = parts
  if (!ivRaw || !tagRaw || !cipherRaw) return undefined

  try {
    const iv = Buffer.from(ivRaw, 'base64url')
    const authTag = Buffer.from(tagRaw, 'base64url')
    const cipherText = Buffer.from(cipherRaw, 'base64url')
    if (iv.length !== CREDENTIAL_CIPHER_IV_BYTES) return undefined
    if (authTag.length !== CREDENTIAL_CIPHER_AUTH_TAG_BYTES) return undefined
    const decipher = createDecipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8')
  } catch {
    // 密钥不匹配、密文被截断、认证标签对不上：上游把它们都归成一句
    // 「key mismatch or corrupted ciphertext」，这里同样只给一个「解不开」。
    return undefined
  }
}

/**
 * 只解码不校验地读一个 JWT 的 claims。
 *
 * 第二段是 payload；签名不碰，结果只用于下面那个 `exp`。
 * **不做任何校验，也不可能在这里校验**——签名密钥是签发方的，本插件没有也不该持有。
 * 所以它拒绝的是「凭空发明」：解不开就当这份令牌什么都没说。
 */
function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const value = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 这枚 access_token 自己说过它过期了吗？
 *
 * RFC 7519 的 `exp` 以**秒**计，所以这里换算成毫秒再与 `now` 比——一千倍的单位差在
 * 方向错的时候是静默的，而本模块的方向正是「宁可早判过期」。
 * 只认有限且为正的数字；字符串、null、NaN、缺字段一律当「这份令牌没说过」= 没过期。
 *
 * **为什么「没说过」不判过期**，与 `codex-adopt.ts` 的做法相反、且是有意的：
 * 那边的凭据要靠 `expiresAt` 维持可识别性，所以宁可拒收整份文档；这边没有这层需要——
 * 计划 §3.6 记明上游**没有** refresh 接口，access_token 是一次性快照，而兑换链的第一步
 * `POST {business}/api/auth/z/login {token}` 本身就是「这个 token 还有效吗」的真判据。
 * 先判死只会把 adopt 从「省一次登录」变成「令牌不是 JWT 的机器上永远失败」。
 * 不成立的代价由 `adoptZcodeSignIn` 里的 `token-expired` 兜住，而那一条的证据更强。
 */
export function zcodeAccessTokenExpired(accessToken: string, now: number = Date.now()): boolean {
  const claims = decodeJwtClaims(accessToken)
  if (claims === undefined) return false
  const exp = claims['exp']
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return false
  return exp * 1000 <= now
}

// ---------------------------------------------------------------------------
// 规则 2 的后半：完整读取（只在 opt in 之后）
// ---------------------------------------------------------------------------

/** 从文件里读到的那一份登录态。不含兑换产物——那是 `adoptZcodeSignIn` 的事。 */
export interface ZcodeLocalSignIn {
  /** 确切读的是哪个文件，卡片照它显示。 */
  readonly sourcePath: string
  readonly region: GlmRegion
  /** 兑换链的输入（计划 §3.2）：它是 `POST /api/auth/z/login` 的 `token`。 */
  readonly accessToken: string
  /**
   * 同包里的 refresh_token。**只做留档与诊断**：计划 §3.6 记明上游没有刷新接口，
   * 不要据此实现任何刷新路径。
   */
  readonly refreshToken: string | null
  /**
   * ZCode 平台自己的 JWT（控制台口径 `zcodejwttoken`）。本线路不拿它做任何鉴权：
   * 计划 §9 明确记录它的完整 payload 字段未验证，缺一份真实解码样本。
   */
  readonly zcodeJwtToken: string | null
  readonly userId: string | null
  readonly email: string | null
  readonly displayName: string | null
  /**
   * 上游给了头像时只记「有」。
   *
   * 刻意**不取**原始字节：冻结契约 `GlmAccountDto` 的注释写明了这一点
   * （「本插件不落 `user.avatar` 的原始字节，只保留是否已取到」）。
   * 顺带说明一个容易误解的地方：上游 `ZaiLoginCredentialUser.avatar` 是**字符串**（头像地址），
   * 不是字节流，所以这里连它都不往外带，只带一个布尔。
   */
  readonly hasAvatar: boolean
  /** 凭据文件最后被写入的时刻（Unix 毫秒）。它是 mtime，**不是**登录时刻，仅供诊断。 */
  readonly sourceModifiedAt: number | null
  /** 本次读取的时刻（Unix 毫秒）。 */
  readonly readAt: number
}

/** 读取失败的三种形状，对应 `GlmAdoptResultDto` 里同样三个 reason。 */
export type ZcodeLocalReadFailure = 'no-credentials-file' | 'not-a-zcode-login' | 'decrypt-failed'

/** 读取的结果，永远是一个值（规则 4）。 */
export type ZcodeLocalRead =
  | { readonly ok: true; readonly signIn: ZcodeLocalSignIn }
  | { readonly ok: false; readonly reason: ZcodeLocalReadFailure; readonly sourcePath: string | null }

/** 从键上读一个值的三种结局。区分「没有」与「有但解不开」，否则两种失败会混成一个 reason。 */
type Slot =
  | { readonly kind: 'absent' }
  | { readonly kind: 'plain'; readonly value: string }
  | { readonly kind: 'locked' }

/**
 * 读本机 ZCode 的登录态；第一个能用的候选获胜。
 *
 * **只在用户显式 opt in 之后调用**（见文件头的规则 2）。
 *
 * 永不抛出、永不 reject：文件缺失、读不了、不是 JSON、形状不认识、解不开，
 * 全部落成上面那个失败值。设置路由不该因为用户的文件正被写到一半而失败。
 *
 * 解不开的值一律判 `decrypt-failed` 而不是「不是 ZCode 登录」：那份文件**确实**是
 * 一份 ZCode 登录态，只是本进程算不出它的密钥——这两个原因给用户的下一步不同。
 */
export async function readZcodeLocalSignIn(
  paths: readonly string[] = zcodeCredentialPaths(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ZcodeLocalRead> {
  const found = await firstExistingFile(paths)
  if (found === null) return { ok: false, reason: 'no-credentials-file', sourcePath: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(found.path, 'utf8')) as unknown
  } catch {
    // 可枚举且对调用方都无害：ENOENT / EACCES / EISDIR，以及被写到一半的文件上的 SyntaxError。
    return { ok: false, reason: 'not-a-zcode-login', sourcePath: found.path }
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'not-a-zcode-login', sourcePath: found.path }

  // 上游的 parseCredentialRecord 遇到非字符串的值是**抛错**（"Credential record value
  // must be a string"）。本模块不抛：非字符串的条目被丢掉，剩下的照常读。
  const raw: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') raw[key] = value
  }

  const key = deriveZcodeCredentialKey(env)
  const slot = (name: string): Slot => {
    const value = raw[name]
    if (value === undefined) return { kind: 'absent' }
    if (!value.startsWith(ENCRYPTED_VALUE_PREFIX)) return { kind: 'plain', value }
    const decrypted = decryptZcodeCredentialValue(value, key)
    return decrypted === undefined ? { kind: 'locked' } : { kind: 'plain', value: decrypted }
  }
  /** 可选字段：解不开或没有都只是「没有」，绝不让整次 adopt 失败。 */
  const optional = (name: string): string | null => {
    const foundSlot = slot(name)
    return foundSlot.kind === 'plain' ? nonEmptyString(foundSlot.value) ?? null : null
  }

  const activeSlot = slot(ZCODE_CREDENTIAL_KEYS.activeProvider)
  if (activeSlot.kind === 'locked') return { ok: false, reason: 'decrypt-failed', sourcePath: found.path }
  const marker = activeSlot.kind === 'plain' ? activeSlot.value : undefined

  const zaiKeys = providerKeys('zai')
  const bigmodelKeys = providerKeys('bigmodel')
  const region = resolveRegion(marker, (name: string): boolean => (raw[name] ?? '') !== '')
  if (region === undefined) return { ok: false, reason: 'not-a-zcode-login', sourcePath: found.path }
  const keys = region === 'intl' ? zaiKeys : bigmodelKeys

  const accessSlot = slot(keys.accessToken)
  if (accessSlot.kind === 'locked') return { ok: false, reason: 'decrypt-failed', sourcePath: found.path }
  const accessToken = accessSlot.kind === 'plain' ? nonEmptyString(accessSlot.value) : undefined
  // 两个区的 access_token 都没有：这份文件不是一份可用的 ZCode 登录态。
  if (accessToken === undefined) return { ok: false, reason: 'not-a-zcode-login', sourcePath: found.path }

  const user = readUserInfo(optional(keys.userInfo))
  return {
    ok: true,
    signIn: {
      sourcePath: found.path,
      region,
      accessToken,
      refreshToken: optional(keys.refreshToken),
      zcodeJwtToken: optional(ZCODE_CREDENTIAL_KEYS.zcodeJwtToken),
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
      hasAvatar: user.hasAvatar,
      sourceModifiedAt: found.modifiedAt,
      readAt: Date.now(),
    },
  }
}

/**
 * 这次 adopt 用的是哪个区。
 *
 * 三级判据，每一级都是「证据更硬」的顺序：
 *
 * 1. `oauth:active_provider` 自述了就用它。上游 `clearZaiLoginCredentials` 证明这个键
 *    确实承担「哪一区当前活跃」的职责，它是最硬的证据。
 * 2. 它没自述，就看两个区的 access_token 谁在。只有一个区有令牌时答案没有歧义。
 * 3. 两个区都有而没有自述 —— 退回 `DEFAULT_REGION`（intl）。这是**复用** `types.ts` 里
 *    已经写下的判断，不是新发明：那个常量回答的正是「凭据没自述区域时猜一个」，
 *    而猜错的代价落在调用方身上（用错的 host 会拿到明确的鉴权失败，不是静默串区）。
 *
 * 两个区的令牌都没有时返回 undefined，交给调用方判成「不是 ZCode 登录」。
 */
function resolveRegion(
  marker: string | undefined,
  hasValue: (key: string) => boolean,
): GlmRegion | undefined {
  const declared = regionForActiveProvider(marker)
  if (declared !== undefined) return declared
  const zaiKeys = providerKeys('zai')
  const bigmodelKeys = providerKeys('bigmodel')
  const hasZai = hasValue(zaiKeys.accessToken)
  const hasBigmodel = hasValue(bigmodelKeys.accessToken)
  if (hasZai && !hasBigmodel) return 'intl'
  if (hasBigmodel && !hasZai) return 'cn'
  if (hasZai && hasBigmodel) return DEFAULT_REGION
  return undefined
}

/**
 * `oauth:{区}:user_info` 解出来的那一小块身份信息。
 *
 * 上游 `saveZaiLoginCredentials` 写进去的是 `JSON.stringify(payload.user)`，
 * 即一段 JSON 文本，形状是 `ZaiLoginCredentialUser`：`{user_id?, email?, name?, avatar?}`。
 * 解不开或不是对象时全部降级为 null —— 身份信息是装饰，缺了它不该毁掉一次可用的登录态。
 */
function readUserInfo(raw: string | null): {
  userId: string | null
  email: string | null
  displayName: string | null
  hasAvatar: boolean
} {
  if (raw === null) return { userId: null, email: null, displayName: null, hasAvatar: false }
  try {
    const value = JSON.parse(raw) as unknown
    if (!isRecord(value)) return { userId: null, email: null, displayName: null, hasAvatar: false }
    return {
      userId: nonEmptyString(value['user_id']) ?? null,
      email: nonEmptyString(value['email']) ?? null,
      displayName: nonEmptyString(value['name']) ?? null,
      hasAvatar: nonEmptyString(value['avatar']) !== undefined,
    }
  } catch {
    return { userId: null, email: null, displayName: null, hasAvatar: false }
  }
}

// ---------------------------------------------------------------------------
// adopt：读完就换，走与 oauth.ts 完全相同的那一套兑换
// ---------------------------------------------------------------------------

/** adopt 成功时交出去的那份凭据。host 侧专用，凭据不过共享契约边界。 */
export interface GlmAdoptedCredential {
  /**
   * 号池标记，每一次快照上都是字面量 `true`。
   *
   * 是一个**判别式**而不是一句描述：存了这个记录的号池必须拒绝刷新它，
   * 而一个能拿来判断的布尔比一句能被读过去的注释更难被忽略。
   */
  readonly adopted: true
  /** 这份快照来自哪一处本地登录态。 */
  readonly source: typeof ZCODE_CREDENTIAL_SOURCE
  /** 读的是哪个文件，卡片照它显示。 */
  readonly sourcePath: string
  readonly region: GlmRegion
  /** 兑换链的输入，只做留档与诊断。 */
  readonly accessToken: string
  /** 见 `ZcodeLocalSignIn.refreshToken`：没有刷新接口，不要据此实现刷新。 */
  readonly refreshToken: string | null
  readonly zcodeJwtToken: string | null
  readonly userId: string | null
  readonly email: string | null
  readonly displayName: string | null
  readonly hasAvatar: boolean
  /**
   * 本插件接管这份登录态的时刻（Unix 毫秒）。
   *
   * 它**不是**上游的登录时刻——那份文件里没有这个信息，凭据文件的 mtime 也只是
   * 「最后一次写盘」而不是「最后一次登录」。宁可给一个诚实的口径，
   * 也不要让一个看起来更精确、其实是猜的数被卡片显示出来。
   */
  readonly authenticatedAt: number
  /**
   * 兑换链的产物，与浏览器登录产出的是**同一种东西**（计划 D4）。
   *
   * 里面已经包含验活结果：拿不到 Coding Plan 套餐的账号在这一步就报错，
   * 而不是带着一把「能创建但不能用」的 Key 进对话。
   */
  readonly codingPlan: GlmCodingPlanKey
}

/** adopt 一次的结果：契约 DTO（给 route 与客户端）加上 host 侧的凭据（只给 W6）。 */
export interface GlmAdoptOutcome {
  readonly result: GlmAdoptResultDto
  readonly adopted: GlmAdoptedCredential | null
}

export interface GlmAdoptOptions {
  /** 注入的候选路径；测试跑在 fixture 上，生产调用方取默认值。 */
  paths?: readonly string[]
  /** 环境变量（含 `ZCODE_DATA_BASE_DIR` / `ZCODE_CREDENTIAL_SECRET` 与 `DSH_GLM_*`）。 */
  env?: NodeJS.ProcessEnv
  /** 注入的 fetch；测试全部走它，所以本文件离网。 */
  fetchFn?: typeof fetch
  signal?: AbortSignal
  /** 单次上游请求超时；缺省走 `exchange.ts` 的 `DISCOVERY_TIMEOUT_MS`。 */
  timeoutMs?: number
}

/**
 * 把兑换链的一次失败归到契约的两个 reason 之一。
 *
 * - 链路通、但这把 Key 不能服务 Coding Plan（`GlmCodingPlanUnavailableError`）→
 *   `exchange-failed`：处置是「这个账号没有套餐」，说成 token 过期会把用户引到错误的操作上。
 * - 业务登录那一步回 401/403 → `token-expired`：凭证本身不行了，正确处置是
 *   「回 ZCode 客户端重新登录」。
 * - 其余（网络错误、5xx、形状漂移）→ `exchange-failed`。
 *
 * **未验证**：`exchange.ts` 是已交付的兄弟文件，它的异常只带一句可读消息、不带 status
 * 字段，而本工作包不改它，所以这里只能从消息里判读 `HTTP <三位数>`。
 * 这是一处刻意的耦合，上游文案一变就失配——失配方向是安全的一侧：
 * 判不出 401 就归 `exchange-failed`，用户仍然能改用浏览器登录。
 */
function classifyExchangeFailure(error: unknown): 'token-expired' | 'exchange-failed' {
  if (error instanceof GlmCodingPlanUnavailableError) return 'exchange-failed'
  const message = error instanceof Error ? error.message : String(error)
  const status = /HTTP\s+(\d{3})/.exec(message)?.[1]
  return status === '401' || status === '403' ? 'token-expired' : 'exchange-failed'
}

/**
 * adopt：读本机 ZCode 的登录态，解出 access_token，走**与浏览器登录完全相同**的那一套兑换。
 *
 * 「完全相同」是硬要求（计划 D4、D6）：兑换链只写在 `exchange.ts` 一处，
 * adopt 不另写一份。两者的产物都是一把**已经验过活**的 Coding Plan Key，
 * 下游（W6 的 token-store / account-pool）因此完全不需要区分凭据是登进来的还是捡回来的。
 *
 * 失败**永不阻断**（计划 D6、R6）：每一种失败都变成 `GlmAdoptResultDto` 的一个 reason，
 * 卡片据此引导用户回落浏览器登录。唯一的例外是调用方自己发起的取消，原样抛出
 * （见文件头的规则 4）。
 *
 * `attempted` 的口径：**找到凭据文件并进入了读取之后**为 true。
 * 只有 `no-credentials-file` 是 false —— 那时候根本没有 adopt 可谈，
 * 机器上什么都没装是最常见也最不需要打扰用户的状态。
 */
export async function adoptZcodeSignIn(options: GlmAdoptOptions = {}): Promise<GlmAdoptOutcome> {
  const env = options.env ?? process.env
  const paths = options.paths ?? zcodeCredentialPaths(env)
  const read = await readZcodeLocalSignIn(paths, env)

  if (!read.ok) {
    return {
      result: {
        attempted: read.reason !== 'no-credentials-file',
        adopted: false,
        reason: read.reason,
      },
      adopted: null,
    }
  }
  const signIn = read.signIn

  // 本地就能判定的过期先判掉：省掉一整条兑换链，也省掉一次对上游的打扰。
  if (zcodeAccessTokenExpired(signIn.accessToken)) {
    return {
      result: { attempted: true, adopted: false, reason: 'token-expired', region: signIn.region },
      adopted: null,
    }
  }

  let codingPlan: GlmCodingPlanKey
  try {
    codingPlan = await exchangeForCodingPlanKey(signIn.accessToken, signIn.region, {
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      env,
    })
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    return {
      result: {
        attempted: true,
        adopted: false,
        reason: classifyExchangeFailure(error),
        region: signIn.region,
      },
      adopted: null,
    }
  }

  return {
    result: { attempted: true, adopted: true, region: signIn.region },
    adopted: {
      adopted: true,
      source: ZCODE_CREDENTIAL_SOURCE,
      sourcePath: signIn.sourcePath,
      region: signIn.region,
      accessToken: signIn.accessToken,
      refreshToken: signIn.refreshToken,
      zcodeJwtToken: signIn.zcodeJwtToken,
      userId: signIn.userId,
      email: signIn.email,
      displayName: signIn.displayName,
      hasAvatar: signIn.hasAvatar,
      authenticatedAt: signIn.readAt,
      codingPlan,
    },
  }
}

/**
 * 一份值是不是本模块产出的 adopt 快照。
 *
 * 号池用它判断一条已存记录是否**永远**不得刷新（本线路上游本来也没有刷新接口，
 * 所以「不得刷新」正是 adopt 账号的正确处置）。它只认本模块的快照：
 * 一份本插件自己登出来的凭据没有 `adopted` 字段，绝不能被误认成可丢弃的快照，
 * 否则用户在设置里登的号会被当成外来物丢掉。
 */
export function isAdoptedZcodeCredential(value: unknown): value is GlmAdoptedCredential {
  if (!isRecord(value)) return false
  return value.adopted === true
    && value.source === ZCODE_CREDENTIAL_SOURCE
    && isRecord(value.codingPlan)
}
