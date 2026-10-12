/**
 * adopt：只读导入本机已登录的 stepcode 客户端登录态。
 *
 * 上游落盘事实全部来自官方源码：`step/auth.ts`（路径、两代形状、占位符）、
 * `step/environment.ts`（home / 配置根目录的解析），路径清单的骨架来自 `types.ts` 的
 * STEPCODE_ADOPT_PATHS 与 STEPCODE_ADOPT_SHAPES。
 *
 * ---------------------------------------------------------------------------
 * 规则 1 —— 本模块永不写入。它是 reader，而且只是 reader。
 * ---------------------------------------------------------------------------
 * 不得创建、修改、移动或删除任何属于 stepcode 客户端的文件：不以写方式打开任何文件、
 * 不建目录、不改名、不 unlink。保证是**结构性**的而不是散文里的承诺——本模块从
 * node:fs/promises **按名**只导入 readFile 与 stat 两个函数，不导入整个命名空间，
 * 于是引入任何写操作都必须改动 import 列表，而那正是复审者第一行会看的地方。
 *
 * 官方自己的做法是**就地归一化**（`migrateLegacyStepCredential` 会改写 auth.json，
 * `writeCanonicalCredentialFile` 还会 chmod 0600）。本插件明确不做那一步：
 * 改写别人的文件是一次没有授权的写操作。
 *
 * ---------------------------------------------------------------------------
 * 规则 2 —— 存在性与内容分成两个函数。
 * ---------------------------------------------------------------------------
 * `stepCodeAdoptPresence()` 便宜到可以在插件启动时调用，只 stat、从不 open：
 * 没 opt in 的用户，他的令牌内容根本不会被读过。`adoptStepCodeSignIn()` 才是完整读取，
 * 且只在用户显式选择之后才被调用。分开是全部意义所在：一个「顺手先读一下以防万一」
 * 的启动路径会让 opt in 变成装饰。
 *
 * ---------------------------------------------------------------------------
 * 规则 3 —— 认不出来的形状永远给一个**值**，永远不给异常。
 * ---------------------------------------------------------------------------
 * 没有文件、读不了、不是 JSON、形状不认识、解不出 profile、里面根本没有 Step 的条目——
 * 全部落在 StepCodeAdoptResultDto 的 reason 枚举里。一个异常逃进设置路由只会变成 500，
 * 而「没找到本机登录态」不是错误，是正常状态。
 *
 * ---------------------------------------------------------------------------
 * 规则 4 —— **profile 缺失时不猜区域**。
 * ---------------------------------------------------------------------------
 * 区域是凭据的属性，而凭据里唯一说出区域的地方就是 profile（计划 §1、§10 风险 6）。
 * 猜错的代价落在调用方身上：国区凭据打国际区端点会被拒，而国际区凭据打国区端点同样会，
 * 且两次都是「鉴权失败」而不是「串区了」。所以缺 profile 的文件被判为 unsupported-shape，
 * 让用户自己说这条登录态属于哪一区，而不是替他决定。
 *
 * ---------------------------------------------------------------------------
 * 规则 5 —— 快照，不是活凭据。
 * ---------------------------------------------------------------------------
 * adopt 进来的是一份**快照**：用户在 Step 侧撤销之后它立刻失效，而本插件既不能刷新它
 * （Step 的凭据没有刷新链）也不该改它。
 */

// 绝不要把这一行放宽成 fs 命名空间对象，也不要用 star-import 引入 node:fs/promises：
// 「按名导入」正是上面「永不写入」那条规则可被一眼看出的形式。
import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  isStepCodeProfile,
  stepCodeRegionOf,
  type StepCodeAdoptResultDto,
  type StepCodeProfile,
} from '../../shared/step-code-contracts.ts'
import {
  STEPCODE_ADOPT_PATHS,
  STEPCODE_AUTH_FILE,
  STEPCODE_CONFIG_DIR,
  normalizeProfile,
} from './types.ts'
import {
  STATIC_EXPIRES_AT,
  STATIC_REFRESH_TOKEN,
  UID_MAX_LENGTH,
  UID_PATTERN,
} from './types.ts'
import { stepCodeCredentialFromLogin, type StepCodeStoredCredential } from './oauth.ts'

// ---------------------------------------------------------------------------
// 路径（逐字 step/environment.ts 与 step/auth.ts）
// ---------------------------------------------------------------------------

/** stepcode 客户端改名前用的配置目录（逐字 LEGACY_RENAMED_CONFIG_DIR，environment.ts:9）。 */
export const LEGACY_RENAMED_CONFIG_DIR = '.step-harness'

/**
 * 显式指定 auth.json 路径的环境变量（逐字 `getStepAuthPath`，auth.ts:18-20）。
 *
 * 有了它，本模块（以及测试）不必碰开发者的真实 profile 就能被驱动；
 * 它也是官方自己给「嵌入式宿主」留的口子。
 */
export const STEPCODE_AUTH_PATH_ENV = 'STEPCODE_AUTH_PATH'

/** 显式指定旧登录态路径的环境变量（逐字 getLegacyStepAuthPaths，auth.ts:29-32）。 */
export const STEPCODE_LEGACY_AUTH_PATH_ENV = 'STEPCODE_LEGACY_AUTH_PATH'

/** 配置目录名的环境覆盖（逐字 resolveStepConfigDir，environment.ts:30-32）。 */
export const STEPCODE_CONFIG_DIR_ENV = 'STEPCODE_CONFIG_DIR'

/** agent 目录名的环境覆盖（逐字 resolveStepConfigRoot，environment.ts:48-57）。 */
export const STEP_CODING_AGENT_DIR_ENV = 'STEP_CODING_AGENT_DIR'

/**
 * stepcode 客户端的家目录（逐字 resolveStepHomeDir，environment.ts:25-27）。
 *
 * 读的是 HOME / USERPROFILE 再退到 os.homedir()——与官方同一口径，所以 Windows 上
 * 拿到的是 %USERPROFILE%、POSIX 上是 ~。
 */
export function stepCodeHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = (env.HOME ?? '').trim() || (env.USERPROFILE ?? '').trim()
  return home === '' ? os.homedir() : home
}

/**
 * stepcode 配置根目录（auth.json 与它同级放着，逐字 resolveStepConfigRoot）。
 *
 * 环境覆盖优先：官方把 `STEP_CODING_AGENT_DIR` 解析成绝对路径再取父目录，
 * 因为「textual 的 ..」会落到进程工作目录旁边。本文件照抄那个顺序。
 */
export function stepCodeConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env[STEP_CODING_AGENT_DIR_ENV] ?? '').trim()
  if (override !== '') {
    const agentDir = path.resolve(override)
    const parent = path.dirname(agentDir)
    // 文件系统根没有兄弟目录可放凭据；此时留在 agent 目录内，而不是写到命名空间之外。
    return parent === agentDir ? agentDir : parent
  }
  const configDir = (env[STEPCODE_CONFIG_DIR_ENV] ?? '').trim() || STEPCODE_CONFIG_DIR
  return path.join(stepCodeHomeDir(env), configDir)
}

/**
 * adopt 会读的每一个路径，按优先级排列。
 *
 * 顺序逐字照抄官方 `getLegacyStepAuthPaths`（auth.ts:29-44）给的理由：canonical root
 * 那个文件排在最前，因为它是「需要就地归一化的旧形状」；剩下的覆盖上一个版本写下的文件。
 *
 * 前三条来自 `types.ts` 的 STEPCODE_ADOPT_PATHS（相对配置根目录的片段）；后两条是
 * 改名前的 `.step-harness` 根，官方仍在扫，本插件也扫——多看一个只读文件没有代价。
 *
 * 纯函数、不碰文件系统：只为渲染卡片调它也是安全的，优先级因此可以脱离磁盘被测试。
 */
export function stepCodeAdoptPaths(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const explicitLegacy = (env[STEPCODE_LEGACY_AUTH_PATH_ENV] ?? '').trim()
  if (explicitLegacy !== '') return [explicitLegacy]
  const explicit = (env[STEPCODE_AUTH_PATH_ENV] ?? '').trim()
  const root = stepCodeConfigRoot(env)
  const canonical = STEPCODE_ADOPT_PATHS.map((relative) => path.join(root, relative))
  if (explicit !== '') return [explicit, ...canonical]
  const retiredRoot = path.join(stepCodeHomeDir(env), LEGACY_RENAMED_CONFIG_DIR)
  return [
    ...canonical,
    path.join(retiredRoot, 'agent', STEPCODE_AUTH_FILE),
    path.join(retiredRoot, STEPCODE_AUTH_FILE),
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 客户端模板文件里的占位符（逐字 auth.ts:203,220）。
 *
 * 它是一个**看起来像凭据**的字符串：不排除它，`{ "apiKey": "<your_api_key>" }`
 * 会被当成一次成功的 adopt，然后把一个 401 发到上游。
 */
export const STEPCODE_PLACEHOLDER_KEY = '<your_api_key>'

/** uid 的收窄：长度 <= UID_MAX_LENGTH 且 /^[\w.@:-]+$/，不合格整个丢弃。 */
function readBoundedUid(value: unknown): string | undefined {
  const text = nonEmptyString(value)
  if (text === undefined) return undefined
  return text.length > UID_MAX_LENGTH || !UID_PATTERN.test(text) ? undefined : text
}

// ---------------------------------------------------------------------------
// 两代形状
// ---------------------------------------------------------------------------

/** adopt 成功时带走的凭据：凭据 + 它是从哪儿、哪个文件捡来的。 */
export interface StepCodeAdoptedCredential {
  /**
   * 池里的判别式，恒为 true。
   *
   * 一个可被测试的布尔，好过一句需要人去读的注释：adopt 快照永不可刷新、且它的删除
   * 语义与本插件自己登出来的账号不同（后者只删本插件自己的文件）。
   */
  readonly adopted: true
  /** 来源标识，供卡片与池记录。 */
  readonly source: typeof STEPCODE_ADOPT_SOURCE
  /** 读到的确切路径，卡片可以把它显示给用户。 */
  readonly sourcePath: string
  /** 本线路的凭据形态（oauth + 静态哨兵 + MAX_SAFE_INTEGER）。 */
  readonly credentials: StepCodeStoredCredential
}

/** adopt 快照的来源标识。 */
export const STEPCODE_ADOPT_SOURCE = 'stepcode-client'

/** adopt 失败原因，直接取自冻结契约的 StepCodeAdoptResultDto['reason']，不另立一套。 */
export type StepCodeAdoptReason = NonNullable<StepCodeAdoptResultDto['reason']>

/**
 * 每个失败原因对应的一句可照做的下一步（给路由层与设置卡片用）。
 *
 * 四个取值各自的下一步不同，所以分开写而不是拼一句「导入失败」：
 * 前两个是「本机没有 / 读不懂」，第三个是「这份登录态没有说自己是哪一区」，
 * 第四个是「这个文件里根本没有 Step 的条目」。
 */
export const ADOPT_REASON_HINTS: Readonly<Record<StepCodeAdoptReason, string>> = {
  'no-credentials-file':
    '本机没有找到 stepcode 的登录态文件。请先在 stepcode 客户端登录一次，或改用浏览器登录本线路。',
  'invalid-credentials':
    'stepcode 的登录态文件读不出来（可能是空的、写坏了，或还是模板里的占位符）。请改用浏览器登录本线路。',
  'unsupported-shape':
    '这份登录态没有写明它属于国区还是国际区，而 Step 的两个区互不通用。'
    + '请改用浏览器登录本线路，并在登录时选择区域。',
  'not-a-stepcode-login':
    '这个文件里没有 stepcode 的登录态（可能是同一份 auth.json 里别的工具的条目）。'
    + '请改用浏览器登录本线路。',
}

/** 解析一份已读入的 JSON 的结论：要么带凭据，要么带一个 reason。 */
export type StepCodeAdoptParse =
  | { readonly ok: true; readonly adopted: StepCodeAdoptedCredential }
  | { readonly ok: false; readonly reason: StepCodeAdoptReason }

/** pi 形状里本线路的条目键（逐字 auth.ts:211 的 `record[STEP_PROVIDER_ID]`）。 */
const PI_CREDENTIAL_KEY = 'step'

/**
 * 认出一个 api_key：非空、且不是模板占位符。
 *
 * 官方两处都判了 `<your_api_key>`（auth.ts:203,220），本插件照抄：不判它就会把一份
 * 没登录过的客户端文件当成有效登录态。
 */
function readApiKey(value: unknown): string | undefined {
  const text = nonEmptyString(value)
  if (text === undefined || text === STEPCODE_PLACEHOLDER_KEY) return undefined
  return text
}

/**
 * 把一份已读入的登录态文档解析成本线路的 adopt 结果。
 *
 * 纯函数、导出：两代形状的规则可以脱离文件系统被测试（测试用夹具驱动它）。
 *
 * 顺序照抄官方 `readLegacyStepCredential`（auth.ts:193-235）：
 *
 * 1. 顶层 `{ apiKey, profile?, uid? }`（StepCode 自己写的老文件）；
 * 2. `{ step: { type:'oauth', access|refresh|expires|profile|uid } }`（pi 形状；
 *    官方在那里也认 `key`，auth.ts:214-220）；
 * 3. 都不匹配时：有别的 provider 条目 → `not-a-stepcode-login`（契约给的那个例子），
 *    否则 → `invalid-credentials`。
 *
 * 认出形状但**没有 profile** 时是 `unsupported-shape`：见模块头的规则 4。
 * uid 不合格只丢弃 uid，不丢掉整份登录态（uid 只影响账号显示与去重）。
 */
export function parseAdoptedStepCodeCredential(value: unknown, sourcePath: string): StepCodeAdoptParse {
  if (!isRecord(value)) return { ok: false, reason: 'invalid-credentials' }

  const legacyKey = readApiKey(value.apiKey)
  if (legacyKey !== undefined) {
    const profile = normalizeProfile(value.profile)
    if (profile === undefined) return { ok: false, reason: 'unsupported-shape' }
    const uid = readBoundedUid(value.uid)
    return {
      ok: true,
      adopted: {
        adopted: true,
        source: STEPCODE_ADOPT_SOURCE,
        sourcePath,
        credentials: stepCodeCredentialFromLogin(profile, { apiKey: legacyKey, ...(uid === undefined ? {} : { uid }) }),
      },
    }
  }

  const stored = value[PI_CREDENTIAL_KEY]
  if (isRecord(stored)) {
    // pi 形状：access 优先，key 是官方也认的另一种写法（auth.ts:214-220）。
    const apiKey = readApiKey(stored.access) ?? readApiKey(stored.key)
    if (apiKey === undefined) return { ok: false, reason: 'invalid-credentials' }
    const profile = normalizeProfile(stored.profile)
    if (profile === undefined) return { ok: false, reason: 'unsupported-shape' }
    const uid = readBoundedUid(stored.uid)
    return {
      ok: true,
      adopted: {
        adopted: true,
        source: STEPCODE_ADOPT_SOURCE,
        sourcePath,
        credentials: stepCodeCredentialFromLogin(profile, { apiKey, ...(uid === undefined ? {} : { uid }) }),
      },
    }
  }

  // 一份 pi auth.json 可以装着好几个 provider 的条目；里面有别的条目而没有 step，
  // 说明「这个文件在，但它不是一份 Step 登录态」——与「读不懂」是两种下一步。
  const hasOtherProvider = Object.values(value).some((entry) => isRecord(entry))
  return { ok: false, reason: hasOtherProvider ? 'not-a-stepcode-login' : 'invalid-credentials' }
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

/** 一个路径上是否存在普通文件（stat，不是 lstat：符号链接是合法布局）。 */
async function existsAsFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile()
  } catch {
    return false
  }
}

/**
 * 本机有没有可导入的 stepcode 登录态文件。
 *
 * 启动路径安全：它**从不**打开候选文件去读，所以没 opt in 的用户，令牌内容根本没被碰过——
 * 既不被它读，也不被渲染卡片的路由读。只 stat，透露的是存在与时间戳，没有别的。
 *
 * 刻意**不**在这里回答「有效 / 过期 / 是不是 JSON」：那需要它存在的目的就是避免的那次读。
 */
export async function stepCodeAdoptPresence(
  paths: readonly string[] = stepCodeAdoptPaths(),
): Promise<boolean> {
  for (const candidate of paths) {
    if (await existsAsFile(candidate)) return true
  }
  return false
}

/**
 * 一次 adopt 的结论：给卡片的切片 + （成功时）真正要落盘的凭据。
 *
 * 两者**刻意分开**：凭据只在这里，绝不进 StepCodeAdoptResultDto（那个类型要下发到客户端，
 * 契约里的一切都是公开信息）。
 */
export interface StepCodeAdoptOutcome {
  /** 卡片渲染用；不含任何凭据。 */
  readonly result: StepCodeAdoptResultDto
  /** 成功时才有：带来源标记的凭据，交给号池或凭据存储落盘。 */
  readonly adopted?: StepCodeAdoptedCredential
  /** 实际读到的文件（设置卡片要把它显示出来）。 */
  readonly sourcePath?: string
}

/** 没找到文件时的结论：attempted 为 false——我们根本没有尝试读任何东西。 */
function absence(paths: readonly string[]): StepCodeAdoptOutcome {
  return {
    result: { attempted: false, adopted: false, reason: 'no-credentials-file' },
    ...(paths[0] === undefined ? {} : { sourcePath: paths[0] }),
  }
}

export interface StepCodeAdoptOptions {
  /** 候选路径；缺省 stepCodeAdoptPaths()（测试注入夹具路径）。 */
  paths?: readonly string[]
  /** 环境变量读取处；缺省 process.env，且**调用时**读取。 */
  env?: NodeJS.ProcessEnv
}

/**
 * 只读导入本机 stepcode 登录态；第一个可用候选获胜。
 *
 * **只在用户显式 opt in 之后调用**（见模块头规则 2）。
 *
 * 永不抛出、永不拒绝：文件不存在、读不了、不是 JSON、形状不认识、解不出 profile——
 * 全部是一个带 reason 的值。设置路由不能因为用户文件正在被写就整个失败。
 *
 * 两个候选路径的失败被区分开：一个文件读不出来（invalid-credentials）会继续看下一个，
 * 而**全部**候选都失败时，返回的是第一个真实失败的原因——「有文件但读不出来」
 * 与「根本没有文件」给用户的下一步不同。
 */
export async function adoptStepCodeSignIn(
  options: StepCodeAdoptOptions = {},
): Promise<StepCodeAdoptOutcome> {
  const paths = options.paths ?? stepCodeAdoptPaths(options.env ?? process.env)
  let sawFile = false
  let firstFailure: StepCodeAdoptReason = 'invalid-credentials'
  let firstFailurePath: string | undefined

  for (const candidate of paths) {
    if (!await existsAsFile(candidate)) continue
    sawFile = true
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(candidate, 'utf8')) as unknown
    } catch {
      // ENOENT / EACCES / EISDIR / 半写文件的 SyntaxError：对调用方全是良性的。
      if (firstFailurePath === undefined) {
        firstFailure = 'invalid-credentials'
        firstFailurePath = candidate
      }
      continue
    }
    const result = parseAdoptedStepCodeCredential(parsed, candidate)
    if (result.ok) {
      return {
        result: {
          attempted: true,
          adopted: true,
          profile: result.adopted.credentials.profile,
          region: stepCodeRegionOf(result.adopted.credentials.profile),
        },
        adopted: result.adopted,
        sourcePath: candidate,
      }
    }
    if (firstFailurePath === undefined) {
      firstFailure = result.reason
      firstFailurePath = candidate
    }
  }

  if (!sawFile) return absence(paths)
  return {
    result: { attempted: true, adopted: false, reason: firstFailure },
    ...(firstFailurePath === undefined ? {} : { sourcePath: firstFailurePath }),
  }
}

/**
 * 只要那张给卡片的切片（不带走凭据）。
 *
 * 渲染「本机有没有可导入的东西」时用这个：它仍要读文件（所以仍要显式 opt in），
 * 但把凭据留在本模块的返回值之外。
 */
export async function readStepCodeAdoptResult(
  options: StepCodeAdoptOptions = {},
): Promise<StepCodeAdoptResultDto> {
  return (await adoptStepCodeSignIn(options)).result
}