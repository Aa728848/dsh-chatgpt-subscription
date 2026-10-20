/**
 * Qoder（订阅）线路的 COSY 签名与请求 codec。
 *
 * 本文件是整条线路协议风险最高的部分，所以它的每一步都被一份**全合成 frozen
 * fixture** 锁成 byte-exact（`test/qoder-cosy.test.ts`，fixture 来自
 * Liki4/qodercli2api `testdata/protocol/1.1.34/`，逐字算法见它的
 * `docs/oauth.md` §5 与 `docs/inference-protocol.md` §2-§4）：
 *
 * - {@link generateQoderRuntimeAuthFields} —— runtime-fields.json；
 * - {@link decryptQoderAdoptPayload} —— credential.json；
 * - {@link encodeQoderBody} —— infer-user-no-org.json 的 `body_string`；
 * - {@link buildQoderCosyHeaders} —— infer-user-no-org.json 的 18 头集合与签名。
 *
 * 与 pi-provider-qoder `src/cosy.ts` 的分歧（它多发 `Cosy-Machineos` /
 * `Cosy-Clientip` / `Cosy-Bodyhash` / `Cosy-Bodylength` / `Cosy-Sigpath` /
 * `X-Request-Id` 六个头）以 **fixture 为准**：那是官方 pinned WASM 的头集合，
 * pi 的超集只是「被服务端容忍」，不是协议的一部分（计划 §9 风险 3）。
 *
 * 本文件不做任何网络 I/O，也不持有凭据：它吃的是调用方递进来的材料，吐出的是
 * 头与 body。machine id 的读取顺序（qodercli 原配 → 本线路自己的文件 → 内存生成）
 * 见 {@link resolveQoderMachineId}。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, publicEncrypt, constants } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  COSY_CLIENT_TYPE,
  COSY_LOGIN_VERSION,
  COSY_MACHINE_TYPE,
  COSY_SCENE,
  QODER_BODY_ALPHABET,
  QODER_BODY_PADDING_CHAR,
  QODER_CONFIG_DIR,
  QODER_MACHINE_ID_FILE,
  QODER_STD_ALPHABET,
} from './types.ts'
import { machineIdPath } from './token-store.ts'

// ---------------------------------------------------------------------------
// 密钥材料
// ---------------------------------------------------------------------------

/**
 * runtime RSA-1024 SPKI 公钥（**非秘密公钥**）。
 *
 * 逐字来源：qodercli2api `docs/oauth.md` §5（从 pinned v1.1.34 WASM 提取，
 * SPKI DER 162 bytes，SHA-256 `a6a4aa468d90c618966e38122abfb06e566c18c9b21090d61f3e9b796b33e569`），
 * 与 pi-provider `cosy.ts` 内嵌的那把逐字相同。用途只有一个：PKCS#1 v1.5 加密
 * 每次请求的 runtime AES key（16 个 ASCII 字符），产物是 `Cosy-Key` 头与签名的
 * `key` 分量。**不要**与同一 WASM 里另一把 2048-bit profile RSA 公钥混淆。
 */
export const QODER_RUNTIME_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

// ---------------------------------------------------------------------------
// 熵 → UUID / runtime key（官方算法，fixture 锁定）
// ---------------------------------------------------------------------------

/**
 * 官方的字节变换（逐字 docs/oauth.md §5.1 与 inference-protocol.md §3.1）：
 * RNG bytes `R[16]` 逐字节反转为 `U[i]=R[15-i]`，再置 UUID 版本/变体位
 * `U[6]=(U[6]&0x0f)|0x40`、`U[8]=(U[8]&0x3f)|0x80`。
 *
 * 同一段变换服务两个产物：runtime AES key（hex 的前 16 个字符）与
 * COSY request UUID（完整 hex 按 8-4-4-4-12 格式化）。
 */
export function qoderMaskedBytes(entropy: Buffer): Buffer {
  if (entropy.length !== 16) throw new Error('Qoder COSY 熵必须是 16 字节')
  const u = Buffer.from(entropy).reverse()
  u[6] = (u[6]! & 0x0f) | 0x40
  u[8] = (u[8]! & 0x3f) | 0x80
  return u
}

/**
 * 熵 → COSY request UUID。
 *
 * 逐字 inference-protocol.md §3.1：完整 masked U 按 lowercase `8-4-4-4-12` 格式化，
 * 不再反转字段内部字节。每次 prepare 重新生成且不得复用（服务端对重复 `request_id`
 * 返回 code 103）。
 */
export function qoderRequestUuid(entropy: Buffer): string {
  const hex = qoderMaskedBytes(entropy).toString('hex')
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16)
    + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32)
}

/** 默认熵源；测试用固定 tape 注入。 */
function defaultEntropy(): Buffer {
  return randomBytes(16)
}

// ---------------------------------------------------------------------------
// runtime auth fields
// ---------------------------------------------------------------------------

/**
 * 一次请求的 runtime 凭据材料。
 *
 * 逐字 docs/oauth.md §5（frozen fixture `runtime-fields.json` 锁定）：
 *
 * 1. `K` = {@link qoderMaskedBytes} 的 lowercase hex 的前 16 个字符，作为
 *    **16 个 ASCII 字节**使用（绝不再做 hex decode）；
 * 2. `encryptUserInfo` = AES-128-CBC（key=IV=K 的原始字节，PKCS#7）加密
 *    调用方给的 **raw UTF-8 字符串原样**（不 parse / 不 re-marshal——字段顺序、
 *    空白和转义都进 AES 明文），输出 strict standard padded Base64；
 * 3. `key` = 用 {@link QODER_RUNTIME_RSA_PUBLIC_KEY}（PKCS#1 v1.5）加密 `K`
 *    的 standard padded Base64。
 *
 * @param rawUserInfo - UserInfo 的原始 JSON 串（原样加密，不规范化）。
 * @param entropy - 测试缝：16 字节熵的供应处（fixture 用固定 tape 驱动）。
 */
export function generateQoderRuntimeAuthFields(
  rawUserInfo: string,
  entropy: () => Buffer = defaultEntropy,
): { encryptUserInfo: string; key: string } {
  const keyText = qoderMaskedBytes(entropy()).toString('hex').slice(0, 16)
  const keyBytes = Buffer.from(keyText, 'utf8')
  const cipher = createCipheriv('aes-128-cbc', keyBytes, keyBytes)
  const encryptUserInfo = Buffer.concat([cipher.update(rawUserInfo, 'utf8'), cipher.final()]).toString('base64')
  const key = publicEncrypt(
    { key: QODER_RUNTIME_RSA_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING },
    keyBytes,
  ).toString('base64')
  return { encryptUserInfo, key }
}

// ---------------------------------------------------------------------------
// adopt 文件的 AES 格式（docs/oauth.md §4，fixture credential.json 锁定）
// ---------------------------------------------------------------------------

/**
 * 解密一份 qodercli 的凭据文件内容。
 *
 * 格式（逐字 docs/oauth.md §4）：strict standard padded Base64 信封 →
 * AES-128-CBC（key=IV=`machineId` 前 16 个字符的 raw UTF-8 字节，PKCS#7 严格校验）。
 * 官方加载兼容：去除外围空白后以 `{` 开头的内容按明文 JSON 解析——本函数同一行为。
 *
 * 解密失败（格式不对、padding 坏了、key 不对）抛错；调用方（adopt.ts）把它归到
 * `invalid-credentials`，**绝不在这里猜第二把 key**。
 */
export function decryptQoderAdoptPayload(content: string, machineId: string): string {
  const trimmed = content.trim()
  // 官方兼容：明文 JSON 直接放行（docs/oauth.md §4 的加载兼容行为）。
  if (trimmed.startsWith('{')) return trimmed
  const keyText = machineId.slice(0, 16)
  if (keyText.length !== 16) throw new Error('machine_id 不足 16 字符，无法解密 qodercli 凭据')
  const keyBytes = Buffer.from(keyText, 'utf8')
  const decipher = createDecipheriv('aes-128-cbc', keyBytes, keyBytes)
  // PKCS#7 严格校验（默认即严格；显式写出来是为了让「改了它的人会看到这条注释」）。
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(Buffer.from(trimmed, 'base64')), decipher.final()]).toString('utf8')
}

// ---------------------------------------------------------------------------
// 请求 body codec（inference-protocol.md §4，fixture body_string 锁定）
// ---------------------------------------------------------------------------

const ENCODE_TABLE: readonly string[] = (() => {
  const table: string[] = new Array(128).fill('')
  for (let i = 0; i < QODER_STD_ALPHABET.length; i++) {
    table[QODER_STD_ALPHABET.charCodeAt(i)] = QODER_BODY_ALPHABET[i]!
  }
  table['='.charCodeAt(0)] = QODER_BODY_PADDING_CHAR
  return table
})()

/**
 * 请求体编码：raw bytes → standard padded Base64 → alphabet 逐位置映射（`=`→`$`）
 * → 外三段交换（`k=floor(len/3)`，输出 `s[len-k:] + s[k:len-k] + s[:k]`）。
 *
 * 它是**可逆的确定性编码，不是加密**（inference-protocol.md §4 原话）；算法不依赖
 * user、model、clock 或 randomness，输入的每个字节（含字段顺序与空白）都进输出——
 * 所以调用方一旦拼好 JSON 就不要再经任何一轮 parse/re-marshal。
 *
 * @returns ASCII 字符串（签名参与的就是这串字符的 UTF-8 字节，两者相同）。
 */
export function encodeQoderBody(raw: string | Buffer): string {
  const std = Buffer.isBuffer(raw) ? raw.toString('base64') : Buffer.from(raw, 'utf8').toString('base64')
  const n = std.length
  const third = Math.floor(n / 3)
  const reordered = std.slice(n - third) + std.slice(third, n - third) + std.slice(0, third)
  let out = ''
  for (let i = 0; i < reordered.length; i++) {
    out += ENCODE_TABLE[reordered.charCodeAt(i)] ?? reordered[i]
  }
  return out
}

// ---------------------------------------------------------------------------
// COSY 请求头
// ---------------------------------------------------------------------------

/** COSY 签名身份材料（一次请求一份）。 */
export interface QoderCosyIdentity {
  /** `Cosy-User`：上游账号 id。 */
  uid: string
  /** UserInfo 的原始 JSON 串（被 AES 进 payload 的 `info`）。 */
  rawUserInfo: string
  /** `Cosy-MachineId` / `Cosy-MachineToken`（同一个 36 字符 UUID）。 */
  machineId: string
  /** `Cosy-Version`：当前生效的 COSY 版本（跟随 CLI release，client.ts 管）。 */
  cosyVersion: string
  /** `Cosy-Data-Policy`：true → `agree`，否则 `disagree`。 */
  dataPolicyAgreed: boolean
  /** 组织 id；非空才出现在头里（presence 矩阵，docs/inference-protocol.md §2）。 */
  organizationId?: string | null
  /** 组织 tags；长度大于零才出现在头里（逗号连接）。 */
  organizationTags?: readonly string[]
}

/**
 * COSY 签名（inference-protocol.md §3.3，fixture 锁定）。
 *
 * canonical bytes 精确为 `payloadB64 LF key LF unixSeconds LF encodedBody LF signedPath`
 * ——五段、四个 `\n`，**末尾没有 LF**；签名是小写 hex MD5。
 */
export function qoderCosySignature(input: {
  payloadB64: string
  key: string
  unixSeconds: string
  encodedBody: string
  signedPath: string
}): string {
  return createHash('md5')
    .update(input.payloadB64).update('\n')
    .update(input.key).update('\n')
    .update(input.unixSeconds).update('\n')
    .update(input.encodedBody).update('\n')
    .update(input.signedPath)
    .digest('hex')
}

/**
 * 一个 URL 的签名路径：pathname 剥掉 `/algo` 前缀，不含 query
 * （inference-protocol.md §1：签名 path 固定为 `/api/v2/service/pro/sse/agent_chat_generation`；
 * pi-provider `computeSigPath` 把它泛化成逐 URL 计算，模型列表 GET 的签名照同一规则）。
 */
export function cosySignedPath(url: string): string {
  try {
    const pathname = new URL(url).pathname
    return pathname.startsWith('/algo') ? pathname.slice('/algo'.length) : pathname
  } catch {
    return url
  }
}

export interface QoderCosyHeadersOptions {
  /** 已编码的 body（GET 无 body 时为空串）。 */
  encodedBody: string
  /** 完整请求 URL（签名路径从这里剥）。 */
  url: string
  /** Accept 头：对话是 `text/event-stream`，模型列表是 `application/json`。 */
  accept: string
  /** 是否带 `Content-Type: application/json`（有 body 的 POST 才带）。 */
  withContentType: boolean
  /** 上行模型 key（`X-Model-Key`）；空/缺省时连同 `X-Model-Source` 一起省略。 */
  modelKey?: string
  /** 模型来源（`X-Model-Source`，通常 `system` 或 `custom`）。 */
  modelSource?: string
  /** 测试缝：时钟（Unix 毫秒）。 */
  now?: number
  /** 测试缝：runtime fields 的熵（fixture 驱动）。 */
  entropy?: () => Buffer
  /** 测试缝：request UUID 的熵（fixture 驱动）。缺省与 runtime fields 共用一段。 */
  requestEntropy?: () => Buffer
}

/**
 * 一套完整的 COSY 请求头（条件 presence 逐字 inference-protocol.md §2 的矩阵）。
 *
 * payload 的字段顺序固定（`version, requestId, info, cosyVersion, ideVersion`——
 * 它参与签名，散装键序就是一次签名漂移），所以这里按字面量顺序写键而不是用 Map。
 */
export function buildQoderCosyHeaders(
  identity: QoderCosyIdentity,
  options: QoderCosyHeadersOptions,
): Record<string, string> {
  if (identity.uid.trim() === '') throw new Error('Qoder COSY：uid 不能为空')
  const runtime = generateQoderRuntimeAuthFields(identity.rawUserInfo, options.entropy ?? defaultEntropy)
  const requestId = qoderRequestUuid((options.requestEntropy ?? options.entropy ?? defaultEntropy)())
  const unixSeconds = Math.floor((options.now ?? Date.now()) / 1000).toString()

  // 字段顺序是签名输入的一部分：version, requestId, info, cosyVersion, ideVersion。
  const payloadB64 = Buffer.from(
    '{"version":"v1","requestId":' + JSON.stringify(requestId)
      + ',"info":' + JSON.stringify(runtime.encryptUserInfo)
      + ',"cosyVersion":' + JSON.stringify(identity.cosyVersion)
      + ',"ideVersion":""}',
    'utf8',
  ).toString('base64')
  const signedPath = cosySignedPath(options.url)
  const signature = qoderCosySignature({
    payloadB64,
    key: runtime.key,
    unixSeconds,
    encodedBody: options.encodedBody,
    signedPath,
  })

  const headers: Record<string, string> = {
    Accept: options.accept,
    Authorization: 'Bearer COSY.' + payloadB64 + '.' + signature,
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Cosy-Business-Product': COSY_SCENE.businessProduct,
    'Cosy-Business-Type': COSY_SCENE.businessType,
    'Cosy-ClientType': COSY_SCENE.clientType,
    'Cosy-Data-Policy': identity.dataPolicyAgreed ? 'agree' : 'disagree',
    'Cosy-Date': unixSeconds,
    'Cosy-Key': runtime.key,
    'Cosy-MachineId': identity.machineId,
    'Cosy-MachineToken': identity.machineId,
    'Cosy-MachineType': COSY_MACHINE_TYPE,
    'Cosy-Scene': COSY_SCENE.scene,
    'Cosy-User': identity.uid,
    'Cosy-Version': identity.cosyVersion,
    'Login-Version': COSY_LOGIN_VERSION,
  }
  // 条件 presence（inference-protocol.md §2 的矩阵）：空值的头**省略**而不是发空串。
  if (options.withContentType) headers['Content-Type'] = 'application/json'
  const organizationId = identity.organizationId ?? ''
  if (organizationId !== '') headers['Cosy-Organization-Id'] = organizationId
  const tags = identity.organizationTags ?? []
  if (tags.length > 0) headers['Cosy-Organization-Tags'] = tags.join(',')
  if (options.modelKey !== undefined && options.modelKey !== '') {
    headers['X-Model-Key'] = options.modelKey
    headers['X-Model-Source'] = options.modelSource ?? 'system'
  }
  return headers
}

// ---------------------------------------------------------------------------
// machine id
// ---------------------------------------------------------------------------

/** qodercli 的 machine_id 文件路径（本插件**只读**它，理由见 adopt.ts 的文件头）。 */
export function qoderCliMachineIdPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = (env.HOME ?? '').trim() || (env.USERPROFILE ?? '').trim() || os.homedir()
  return path.join(home, QODER_CONFIG_DIR, '.auth', QODER_MACHINE_ID_FILE)
}

/** 读取qodercli 原配的 machine id（不存在时 null；只读）。 */
export function readQoderCliMachineId(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const candidate = qoderCliMachineIdPath(env)
    if (!existsSync(candidate)) return null
    const value = readFileSync(candidate, 'utf8').trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

// 进程内记住一份，免得每个请求都碰一次盘。
let machineIdMemo: string | null = null

/**
 * 本线路发请求用的 machine id。
 *
 * 读取顺序（逐字 pi-provider `cosy.ts` `getMachineId` 的同一决定）：
 *
 * 1. qodercli 的原配 `~/.qoder/.auth/machine_id`（**只读**）——adopt 来的凭据
 *    与它配套，同一个 id 让账号在两边的审计记录里是同一条；
 * 2. 本线路自己持久化的那份（`storages/qoder-machine-id`）；
 * 3. 都没有时生成一个并尽力落盘（落不了盘就用内存里的那份——身份在一次
 *   进程内一致即可，持久化失败不值得让请求失败）。
 */
export function resolveQoderMachineId(env: NodeJS.ProcessEnv = process.env): string {
  if (machineIdMemo !== null) return machineIdMemo
  const fromCli = readQoderCliMachineId(env)
  if (fromCli !== null) {
    machineIdMemo = fromCli
    return fromCli
  }
  const own = machineIdPath()
  try {
    if (existsSync(own)) {
      const value = readFileSync(own, 'utf8').trim()
      if (value !== '') {
        machineIdMemo = value
        return value
      }
    }
  } catch {
    // 读不了就重新生成。
  }
  const generated = randomUUID()
  machineIdMemo = generated
  void (async () => {
    try {
      await mkdir(path.dirname(own), { recursive: true })
      await writeFile(own, generated + '\n', { encoding: 'utf8', mode: 0o600 })
    } catch {
      // 尽力而为：内存里的那份仍然一致。
    }
  })()
  return generated
}

/** 测试用：清掉进程内记忆。 */
export function clearQoderMachineIdMemo(): void {
  machineIdMemo = null
}
