/**
 * adopt：只读导入本机已登录的 qodercli 客户端登录态。
 *
 * 上游落盘事实全部来自 qodercli2api \`docs/oauth.md\` §4（格式由它的 frozen fixture
 * \`credential.json\` 逐字节锁定，\`test/qoder-adopt.test.ts\` 用同一 fixture 驱动）：
 *
 * - 路径：\`~/.qoder/.auth/machine_id\`（36 字符 UUID）与 \`~/.qoder/.auth/user\`；
 * - 信封：strict standard padded Base64；明文是 UserInfo 的 UTF-8 JSON；
 * - key：\`machine_id\` 前 16 个字符的 **raw UTF-8 字节**（不是 hex/base64 解码值）；
 * - cipher：AES-128-CBC，IV 与 key 相同，PKCS#7 严格校验；
 * - 兼容：去除外围空白后以 \`{\` 开头的内容按明文 JSON 解析。
 *
 * ---------------------------------------------------------------------------
 * 规则 1 —— 本模块永不写入。它是 reader，而且只是 reader。
 * ---------------------------------------------------------------------------
 * 不得创建、修改、移动或删除任何属于 qodercli 的文件。保证是**结构性**的：
 * 本模块从 node:fs/promises **按名**只导入 readFile 与 stat 两个函数
 * （与 step-code 的 adopt.ts 同一条规则、同一个理由）。
 *
 * ---------------------------------------------------------------------------
 * 规则 2 —— 存在性与内容分成两个函数。
 * ---------------------------------------------------------------------------
 * \`qoderAdoptPresence()\` 便宜到可以在插件启动时调用，只 stat、从不 open；
 * \`adoptQoderSignIn()\` 才是完整读取，且只在用户显式选择之后才被调用。
 *
 * ---------------------------------------------------------------------------
 * 规则 3 —— 认不出来的形状永远给一个**值**，永远不给异常。
 * ---------------------------------------------------------------------------
 * 没有文件、读不了、解密失败、不是 JSON、里面没有 token、两区都不认——全部落在
 * QoderAdoptResultDto 的 reason 枚举里。
 *
 * ---------------------------------------------------------------------------
 * 规则 4 —— **区域不猜，是探出来的**。
 * ---------------------------------------------------------------------------
 * 区域是凭据的属性，而 qodercli 的凭据文件**不记录区域**（格式里没有这个字段）。
 * 所以 adopt 拿解密后的 token 对两区的 userinfo 各探一次（只读 GET），哪区认
 * 就是哪区；两区都不认（token 已失效或被撤销）归为 \`region-unresolved\`——
 * 让用户重新登录，而不是替他决定一个必然 401 的区域（计划 §9 风险 5）。
 *
 * ---------------------------------------------------------------------------
 * 规则 5 —— 快照，不是活凭据。
 * ---------------------------------------------------------------------------
 * adopt 进来的是一份**快照**：qodercli 那边之后的刷新不会流回来；本插件拿着
 * 快照里的 refresh_token 走自己的刷新链，两边从此各刷各的。
 */

// 绝不要把这一行放宽成 fs 命名空间对象：「按名导入」正是「永不写入」可被一眼看出的形式。
import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  QODER_REGIONS,
  type QoderAdoptResultDto,
  type QoderRegion,
} from '../../shared/qoder-contracts.ts'
import {
  QODER_AUTH_FILE,
  QODER_CONFIG_DIR,
  QODER_MACHINE_ID_FILE,
} from './types.ts'
import { decryptQoderAdoptPayload } from './cosy.ts'
import { fetchQoderUserInfo, type QoderRequestOptions } from './client.ts'
import { qoderExpiresAtFrom, QODER_CLI_CREDENTIAL_SOURCE, type QoderCredentials } from './token-store.ts'

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/** 显式指定 qodercli 凭据文件路径的环境变量（测试与嵌入式宿主的口子；非官方变量）。 */
export const QODER_AUTH_PATH_ENV = 'QODER_CLI_AUTH_PATH'

/** 显式指定 qodercli machine_id 路径的环境变量（同上）。 */
export const QODER_MACHINE_ID_PATH_ENV = 'QODER_CLI_MACHINE_ID_PATH'

/** qodercli 的家目录（HOME / USERPROFILE 再退到 os.homedir()，与兄弟线路同一口径）。 */
export function qoderCliHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = (env.HOME ?? '').trim() || (env.USERPROFILE ?? '').trim()
  return home === '' ? os.homedir() : home
}

/** qodercli 的凭据文件路径。 */
export function qoderCliAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env[QODER_AUTH_PATH_ENV] ?? '').trim()
  if (explicit !== '') return explicit
  return path.join(qoderCliHomeDir(env), QODER_CONFIG_DIR, '.auth', QODER_AUTH_FILE)
}

/** qodercli 的 machine_id 文件路径。 */
export function qoderCliMachineIdFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env[QODER_MACHINE_ID_PATH_ENV] ?? '').trim()
  if (explicit !== '') return explicit
  return path.join(qoderCliHomeDir(env), QODER_CONFIG_DIR, '.auth', QODER_MACHINE_ID_FILE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value !== 'string' ? undefined : value.trim() === '' ? undefined : value.trim()
}

// ---------------------------------------------------------------------------
// 解密后的 UserInfo → 凭据
// ---------------------------------------------------------------------------

/** adopt 成功时带走的凭据：凭据 + 它是从哪个文件捡来的。 */
export interface QoderAdoptedCredential {
  /** 池里的判别式，恒为 true。 */
  readonly adopted: true
  /** 来源标识，供卡片与池记录。 */
  readonly source: typeof QODER_CLI_CREDENTIAL_SOURCE
  /** 读到的确切路径，卡片可以把它显示给用户。 */
  readonly sourcePath: string
  /** 本线路的凭据形态。 */
  readonly credentials: QoderCredentials
}

/** adopt 失败原因，直接取自冻结契约的 QoderAdoptResultDto['reason']，不另立一套。 */
export type QoderAdoptReason = NonNullable<QoderAdoptResultDto['reason']>

/**
 * 每个失败原因对应的一句可照做的下一步。
 *
 * 五个取值各自的下一步不同，所以分开写而不是拼一句「导入失败」。
 */
export const ADOPT_REASON_HINTS: Readonly<Record<QoderAdoptReason, string>> = {
  'no-credentials-file':
    '本机没有找到 qodercli 的登录态文件。请先在 Qoder CLI 里登录一次（qoder 然后 /login），或改用浏览器/PAT 登录本线路。',
  'invalid-credentials':
    'qodercli 的登录态文件读不出来（可能是空的、写坏了，或解密失败）。请改用浏览器/PAT 登录本线路。',
  'unsupported-shape':
    '这份登录态读懂了，但字段组合不认识（上游可能改版）。请改用浏览器/PAT 登录本线路。',
  'not-a-qoder-login':
    '这个文件里没有可用的 Qoder 登录态（没有 access_token）。请改用浏览器/PAT 登录本线路。',
  'region-unresolved':
    '登录态解密成功，但全球区与中国站的 userinfo 都不认这把 token（它可能已过期或被撤销）。请重新登录。',
}

/** 解析一份已解密的 UserInfo 的结论：要么带凭据材料，要么带一个 reason。 */
export type QoderAdoptParse =
  | { readonly ok: true; readonly material: QoderAdoptMaterial }
  | { readonly ok: false; readonly reason: QoderAdoptReason }

/**
 * 从 UserInfo 里读出的凭据材料（区域还没定：格式里没有这个字段，见规则 4）。
 */
export interface QoderAdoptMaterial {
  accessToken: string
  refreshToken: string | null
  expiresAt: number
  uid: string | null
  email: string | null
  accountName: string | null
  organizationId: string | null
  organizationTags: string[]
  dataPolicyAgreed: boolean
}

/**
 * 把一份已解密的 UserInfo JSON 解析成凭据材料。
 *
 * 纯函数、导出：格式规则可以脱离文件系统与网络被测试。
 *
 * 字段逐字按 qodercli2api 的 fixture 与 pi-provider 的 UserInfo 形状读取，全部按
 * 「可能缺失」处理（计划 §9 风险 5：这份载荷没有逐字 schema）：
 *
 * - \`access_token\`（fixture 明文里有）优先，\`security_oauth_token\` 兜底
 *   （docs/oauth.md §6：OpenAPI 鉴权用 \`security_oauth_token ?? access_token\`）；
 * - \`refresh_token\`、\`uid\`、\`name\`、\`email\`、\`organization_id\`、
 *   \`organization_tags\`、\`data_policy_agreed\`、\`expire_time\` 都可能没有。
 */
export function parseQoderAdoptedUserInfo(value: unknown): QoderAdoptParse {
  if (!isRecord(value)) return { ok: false, reason: 'invalid-credentials' }
  const accessToken = nonEmptyString(value.access_token) ?? nonEmptyString(value.security_oauth_token)
  if (accessToken === undefined) return { ok: false, reason: 'not-a-qoder-login' }
  const tags = Array.isArray(value.organization_tags)
    ? value.organization_tags.filter((tag): tag is string => typeof tag === 'string' && tag !== '')
    : []
  return {
    ok: true,
    material: {
      accessToken,
      refreshToken: nonEmptyString(value.refresh_token) ?? null,
      expiresAt: qoderExpiresAtFrom(value.expire_time ?? value.expires_at, value.expires_in),
      uid: nonEmptyString(value.uid) ?? null,
      email: nonEmptyString(value.email) ?? null,
      accountName: nonEmptyString(value.name) ?? nonEmptyString(value.username) ?? null,
      organizationId: nonEmptyString(value.organization_id) ?? null,
      organizationTags: tags,
      dataPolicyAgreed: value.data_policy_agreed === true,
    },
  }
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
 * 本机有没有可导入的 qodercli 登录态（凭据文件 + machine_id 都在才算）。
 *
 * 启动路径安全：它**从不**打开候选文件去读（同 step-code adopt 的那条规则）。
 */
export async function qoderAdoptPresence(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return await existsAsFile(qoderCliAuthPath(env)) && await existsAsFile(qoderCliMachineIdFilePath(env))
}

/** 一次 adopt 的结论：给卡片的切片 + （成功时）真正要落盘的凭据。 */
export interface QoderAdoptOutcome {
  /** 卡片渲染用；不含任何凭据。 */
  readonly result: QoderAdoptResultDto
  /** 成功时才有：带来源标记的凭据，交给号池或凭据存储落盘。 */
  readonly adopted?: QoderAdoptedCredential
  /** 实际读到的文件（设置卡片要把它显示出来）。 */
  readonly sourcePath?: string
}

export interface QoderAdoptOptions {
  /** 环境变量读取处；缺省 process.env，且**调用时**读取。 */
  env?: NodeJS.ProcessEnv
  /** 区域探测的请求缝（测试注入 mock fetch）。 */
  fetchFn?: typeof fetch
}

/**
 * 只读导入本机 qodercli 登录态。
 *
 * **只在用户显式 opt in 之后调用**（见模块头规则 2）。永不抛出、永不拒绝。
 *
 * 区域探测（规则 4）：拿解密后的 token 依次对 global、cn 的 userinfo 发只读 GET，
 * 第一个认账的区域获胜；两区都不认 → \`region-unresolved\`。探测只认「请求成功」，
 * 任何网络/鉴权失败都记为不认账——探测的目的是定位，不是诊断。
 */
export async function adoptQoderSignIn(
  options: QoderAdoptOptions = {},
): Promise<QoderAdoptOutcome> {
  const env = options.env ?? process.env
  const authPath = qoderCliAuthPath(env)
  const machineIdFile = qoderCliMachineIdFilePath(env)

  if (!await existsAsFile(authPath) || !await existsAsFile(machineIdFile)) {
    return {
      result: { attempted: false, adopted: false, reason: 'no-credentials-file' },
      sourcePath: authPath,
    }
  }

  let machineId: string
  let content: string
  try {
    machineId = (await readFile(machineIdFile, 'utf8')).trim()
    content = await readFile(authPath, 'utf8')
    if (machineId === '') throw new Error('empty machine_id')
  } catch {
    return { result: { attempted: true, adopted: false, reason: 'invalid-credentials' }, sourcePath: authPath }
  }

  let plaintext: string
  try {
    plaintext = decryptQoderAdoptPayload(content, machineId)
  } catch {
    return { result: { attempted: true, adopted: false, reason: 'invalid-credentials' }, sourcePath: authPath }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext) as unknown
  } catch {
    return { result: { attempted: true, adopted: false, reason: 'invalid-credentials' }, sourcePath: authPath }
  }

  const result = parseQoderAdoptedUserInfo(parsed)
  if (!result.ok) {
    return { result: { attempted: true, adopted: false, reason: result.reason }, sourcePath: authPath }
  }
  const material = result.material

  // 区域探测：global → cn，第一个 userinfo 认账的获胜。
  let region: QoderRegion | null = null
  let probedName: string | null = null
  let probedEmail: string | null = null
  for (const candidate of QODER_REGIONS) {
    try {
      const info = await fetchQoderUserInfo(material.accessToken, candidate, {
        ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
        env,
      })
      region = candidate
      probedName = info.name === '' ? null : info.name
      probedEmail = info.email === '' ? null : info.email
      break
    } catch {
      // 这区不认：试下一区。
    }
  }
  if (region === null) {
    return { result: { attempted: true, adopted: false, reason: 'region-unresolved' }, sourcePath: authPath }
  }

  const credentials: QoderCredentials = {
    accessToken: material.accessToken,
    refreshToken: material.refreshToken,
    expiresAt: material.expiresAt,
    region,
    origin: 'adopt',
    uid: material.uid,
    email: probedEmail ?? material.email,
    accountName: probedName ?? material.accountName,
    personalToken: null,
    organizationId: material.organizationId,
    organizationTags: material.organizationTags,
    dataPolicyAgreed: material.dataPolicyAgreed,
    authenticatedAt: Date.now(),
    adopted: true,
    source: QODER_CLI_CREDENTIAL_SOURCE,
    sourcePath: authPath,
  }
  return {
    result: { attempted: true, adopted: true, region },
    adopted: { adopted: true, source: QODER_CLI_CREDENTIAL_SOURCE, sourcePath: authPath, credentials },
    sourcePath: authPath,
  }
}

/** 只要那张给卡片的切片（不带走凭据）。 */
export async function readQoderAdoptResult(
  options: QoderAdoptOptions = {},
): Promise<QoderAdoptResultDto> {
  return (await adoptQoderSignIn(options)).result
}
