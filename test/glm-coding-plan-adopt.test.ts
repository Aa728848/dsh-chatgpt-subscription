/**
 * W2：adopt —— 读本机 ZCode 登录态（计划 D6 / §3.7）。
 *
 * 全部离线：fixture 是这个文件自己造的假凭据（token 全是 `at-` / `bt-` / `zt-` 占位串，
 * 邮箱在 `.invalid` 域），凭据文件写在 `mkdtemp` 出来的临时目录里，
 * **从不读真实的 `~/.zcode`**；上游兑换链走注入的 fetch mock，一个真实请求都发不出去。
 *
 * 断言重点是三件事：
 *
 * 1. **两区不串**（最容易写错的地方）。fixture 里**两个区的令牌都在**，断言回来的
 *    是 `oauth:active_provider` 指定的那一个。两种序列化顺序都覆盖——
 *    一个「找到第一个 access_token」的扫法会对其中一种靠运气答对。
 * 2. **解密是照协议写的**，不是照想象写的。测试用**模块自己的** `deriveZcodeCredentialKey`
 *    与 `decryptZcodeCredentialValue` 这一对（加密端则用 `node:crypto` 的 cipher，
 *    与被测的解密端分开）造出真正的 `enc:v1:` 密文，再让 adopt 解它。
 * 3. **永不写入有可观测断言**：adopt 跑完后凭据文件的字节、大小、mtime 三者不变，
 *    所在目录没有新增条目；另有一条源码级守卫断言只按名导入了 `readFile` 与 `stat`。
 *
 * 冻结契约的六个 reason 里，本实现只可能产生五个：
 * `secret-unavailable` 在本线路里不成立（密钥永远能从 platform + homedir + username
 * 推出来，见 adopt.ts 的 `zcodeCredentialFallbackSecret`），测试直接断言这一点。
 */

import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ADOPT_REASON_HINTS,
  CREDENTIAL_CIPHER_IV_BYTES,
  ENCRYPTED_VALUE_PREFIX,
  ZCODE_CREDENTIAL_FILE,
  ZCODE_CREDENTIAL_SECRET_ENV,
  ZCODE_CREDENTIAL_SOURCE,
  ZCODE_DATA_BASE_DIR_ENV,
  adoptZcodeSignIn,
  decryptZcodeCredentialValue,
  deriveZcodeCredentialKey,
  isAdoptedZcodeCredential,
  readZcodeLocalSignIn,
  regionForActiveProvider,
  zcodeAccessTokenExpired,
  zcodeCredentialPaths,
  zcodeCredentialPresence,
  zcodeCredentialFallbackSecret,
  zcodeCredentialsPath,
  zcodeDataBaseDir,
} from '../src/host/glm-coding-plan/adopt.ts'
import { GLM_KEY_NAME } from '../src/host/glm-coding-plan/types.ts'

// ---------------------------------------------------------------------------
// 假凭据常量（没有一个是真值）
// ---------------------------------------------------------------------------

/** 国际区（zai）的 access_token。 */
const INTL_ACCESS_TOKEN = 'at-intl-placeholder'
/** 国区（bigmodel）的 access_token。**两个区的令牌同处一份文件，所以串区是可观察的。 */
const CN_ACCESS_TOKEN = 'at-cn-placeholder'
const INTL_REFRESH_TOKEN = 'rt-intl-placeholder'
const CN_REFRESH_TOKEN = 'rt-cn-placeholder'
const ZCODE_JWT_TOKEN = 'zt-placeholder'
const USER_EMAIL = 'user@example.invalid'
/** 上游 `saveZaiLoginCredentials` 写的 user_info 就是 `JSON.stringify(user)`。 */
const USER_INFO = JSON.stringify({
  user_id: 'u-placeholder',
  email: USER_EMAIL,
  name: 'Tester',
  avatar: 'https://example.invalid/a.png',
})
/** 一枚带 `exp` 的假 JWT，用来验证本地过期判定。签名是假的，本模块也从不校验它。 */
function jwtWithExp(expiresAtMs: number | null): string {
  const payload: Record<string, unknown> = { sub: 'u-placeholder' }
  if (expiresAtMs !== null) payload['exp'] = Math.floor(expiresAtMs / 1000)
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return 'header-placeholder.' + body + '.signature-placeholder'
}

/** 加密端。与被测的解密端刻意分开写，好让「照协议」这件事是可检验的。 */
function encryptLikeZcode(plaintext: string, key: Buffer): string {
  const iv = randomBytes(CREDENTIAL_CIPHER_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    ENCRYPTED_VALUE_PREFIX,
    iv.toString('base64url'),
    '.',
    cipher.getAuthTag().toString('base64url'),
    '.',
    encrypted.toString('base64url'),
  ].join('')
}

// ---------------------------------------------------------------------------
// 临时目录与 fixture
// ---------------------------------------------------------------------------

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

async function tempDir(prefix = 'dsh-glm-adopt-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

/** 写出 `<dir>/.zcode/v2/credentials.json`，答案就是凭据文件路径。 */
async function writeCredentialsFile(record: Record<string, string>, directory?: string): Promise<string> {
  const base = directory ?? await tempDir()
  const nested = join(base, '.zcode', 'v2')
  await import('node:fs/promises').then((fs) => fs.mkdir(nested, { recursive: true }))
  const file = join(nested, ZCODE_CREDENTIAL_FILE)
  await writeFile(file, JSON.stringify(record, null, 2) + '\n', 'utf8')
  return file
}

/** 凭据文件存在的目录，与文件同层（供「目录没有新增条目」那条断言使用）。 */
function credentialsDirOf(file: string): string {
  return dirname(file)
}

/** 一份两区都在、明文写下的凭据文档；`active` 决定谁是活跃区。 */
function plaintextRecord(active: 'zai' | 'bigmodel'): Record<string, string> {
  return {
    'oauth:active_provider': active,
    'oauth:zai:access_token': INTL_ACCESS_TOKEN,
    'oauth:zai:refresh_token': INTL_REFRESH_TOKEN,
    'oauth:zai:user_info': USER_INFO,
    'oauth:bigmodel:access_token': CN_ACCESS_TOKEN,
    'oauth:bigmodel:refresh_token': CN_REFRESH_TOKEN,
    'oauth:bigmodel:user_info': USER_INFO,
    zcodejwttoken: ZCODE_JWT_TOKEN,
  }
}

// ---------------------------------------------------------------------------
// 兑换链 mock（一个真实请求都发不出去）
// ---------------------------------------------------------------------------

interface Routed {
  fetchFn: typeof fetch
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }>
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 一条完整的国际区兑换链（计划 §3.2 的五个端点）。 */
function exchangeRoutes(overrides: { keys?: unknown[]; quota?: () => Response } = {}): Array<[RegExp, (init?: RequestInit) => Response]> {
  return [
    [/\/api\/auth\/z\/login$/, () => jsonResponse({ code: 0, data: { access_token: 'bt-placeholder', expires_in: 3600 } })],
    [/\/api\/biz\/customer\/getCustomerInfo$/, () => jsonResponse({ code: 0, data: {
      organizations: [{ organizationId: 'org-1', organizationName: '默认机构（个人）', projects: [{ projectId: 'p-1', projectName: '默认项目' }] }],
    } })],
    [/\/api_keys$/, (init) => (init?.method === 'POST'
      ? jsonResponse({ code: 0, data: { apiKey: 'dsh-created-placeholder' } })
      : jsonResponse({ code: 0, data: overrides.keys ?? [] }))],
    [/\/api_keys\/copy\//, () => jsonResponse({ code: 0, data: { secretKey: 'sk-placeholder' } })],
    [/\/api\/monitor\/usage\/quota\/limit$/, () => (overrides.quota?.() ?? jsonResponse({ code: 0, data: { level: 'pro' } }))],
  ]
}

function routedFetch(
  routes: Array<[RegExp, (init?: RequestInit) => Response]>,
  callLog?: Routed['calls'],
): Routed {
  const calls: Routed['calls'] = callLog ?? []
  const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url)
    calls.push({
      url: href,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    const route = routes.find(([pattern]) => pattern.test(href))
    if (route === undefined) throw new Error('unexpected request: ' + href)
    return route[1](init)
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

// ---------------------------------------------------------------------------
// 存在性与内容分成两个函数（规则 2）
// ---------------------------------------------------------------------------

describe('存在性探测：只 stat，不读内容', () => {
  it('没有凭据文件时 attempted=false 且 reason=no-credentials-file', async () => {
    const absent = join(await tempDir(), '.zcode', 'v2', ZCODE_CREDENTIAL_FILE)
    const { fetchFn, calls } = routedFetch(exchangeRoutes())

    const outcome = await adoptZcodeSignIn({ paths: [absent], env: {}, fetchFn })

    expect(outcome.result).toEqual({ attempted: false, adopted: false, reason: 'no-credentials-file' })
    expect(outcome.adopted).toBeNull()
    // 机器上什么都没装是最常见的状态，不该为它去打扰上游。
    expect(calls).toHaveLength(0)
  })

  it('presence 报告找到的文件与查过的候选，且从不 open', async () => {
    const file = await writeCredentialsFile(plaintextRecord('zai'))
    const absent = join(await tempDir(), '.zcode', 'v2', ZCODE_CREDENTIAL_FILE)

    const presence = await zcodeCredentialPresence([absent, file])

    expect(presence.present).toBe(true)
    expect(presence.path).toBe(file)
    // 每个候选都被报告，无论存不存在，卡片因此能打印确切地看过哪些地方。
    expect(presence.searched).toEqual([absent, file])
  })

  it('presence 对一个根本不是 JSON 的文件也回答「有」', async () => {
    // 兜底：答案不可能依赖内容，因为这里的内容连解析都过不了，答案仍是「有」。
    const directory = await tempDir()
    const nested = join(directory, '.zcode', 'v2')
    await import('node:fs/promises').then((fs) => fs.mkdir(nested, { recursive: true }))
    const file = join(nested, ZCODE_CREDENTIAL_FILE)
    await writeFile(file, 'this is not json {{{', 'utf8')

    const presence = await zcodeCredentialPresence([file])

    expect(presence.present).toBe(true)
    expect(presence.path).toBe(file)
  })

  it('presence 对缺失路径与目录形态都回答「没有」而不抛错', async () => {
    const missing = join(await tempDir(), 'nope.json')
    const asDirectory = await tempDir()

    expect((await zcodeCredentialPresence([missing])).present).toBe(false)
    expect((await zcodeCredentialPresence([asDirectory])).present).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

describe('候选路径：ZCODE_DATA_BASE_DIR 说了算', () => {
  it('拼出 <base>/.zcode/v2/credentials.json，且默认 base 是 home', () => {
    expect(zcodeDataBaseDir({})).toBe(homedir())
    expect(zcodeCredentialPaths({})).toEqual([join(homedir(), '.zcode', 'v2', ZCODE_CREDENTIAL_FILE)])
  })

  // 为什么这一块要这么写：实现把变量值交给**当前平台的 path 语义**去解析
  // （resolveUserPath 里的 resolve，再 join，见 adopt.ts:206-228），
  // 而「期望值」如果写死成某一条绝对路径，就等于把测试钉死在那一个平台上。
  // 例如旧的 `join('C:', 'profiles', ...)`：win32 下得到 `C:\\profiles\\...`，POSIX 下却得到
  // `C:/profiles/...`（join 把 `C:` 当一个普通相对段），而实现在 POSIX 上是把整串当相对路径
  // 拼在 CWD 之后——两边就此分道扬镳，CI（ubuntu-latest）就是这么红的。
  // 这里的期望值一律用「当前平台的语义」算，于是 Windows 与 Linux 跑的是同一段断言。
  const platformPath = process.platform === 'win32' ? win32 : posix

  it('变量非空时覆盖，且展开 ~/', async () => {
    // 覆盖的第一层：变量非空时确实盖掉了默认 base（默认是 homedir）。
    // 基准取 mkdtemp 的目录——它在两个平台上都是绝对且已归一的路径，resolve 对它恒等，
    // 所以「base 被换成了变量值」这条语义可以在两个平台上逐字断言，不依赖任何平台假设。
    const base = await tempDir()
    expect(zcodeDataBaseDir({ [ZCODE_DATA_BASE_DIR_ENV]: base })).toBe(base)
    expect(zcodeCredentialsPath({ [ZCODE_DATA_BASE_DIR_ENV]: base }))
      .toBe(join(base, '.zcode', 'v2', ZCODE_CREDENTIAL_FILE))
    // 关键：拿到的是变量里那个目录下的路径，而不是默认 homedir 下的路径。
    expect(zcodeCredentialsPath({ [ZCODE_DATA_BASE_DIR_ENV]: base }))
      .not.toBe(zcodeCredentialsPath({}))

    // 覆盖的第二层：一个 Windows 风格的绝对路径，在**每个**平台上都由该平台自己的语义解释——
    // win32 认出盘符、原样返回；POSIX 把它当普通相对段拼在 CWD 之后（就是 CI 失败的那条）。
    // 期望值用 platformPath 算，与实现走的是同一套语义。
    expect(zcodeDataBaseDir({ [ZCODE_DATA_BASE_DIR_ENV]: 'C:\\profiles\\zcode' }))
      .toBe(platformPath.resolve('C:\\profiles\\zcode'))
    expect(zcodeCredentialsPath({ [ZCODE_DATA_BASE_DIR_ENV]: 'C:\\profiles\\zcode' }))
      .toBe(platformPath.join(platformPath.resolve('C:\\profiles\\zcode'), '.zcode', 'v2', ZCODE_CREDENTIAL_FILE))

    // 两条语义的结论都在这里被写死钉住：不论这次跑在哪个平台，下两行都成立，
    // 也就是「win32 与 posix 各自会得到什么」是被断言写下来的，
    // 而不是碰巧在 Windows 上蒙对——任何平台跑都会对照到另一条语义。
    expect(win32.join(win32.resolve('C:\\profiles\\zcode'), '.zcode', 'v2', ZCODE_CREDENTIAL_FILE))
      .toBe('C:\\profiles\\zcode\\.zcode\\v2\\' + ZCODE_CREDENTIAL_FILE)
    expect(posix.join(posix.resolve('/C:\\profiles\\zcode'), '.zcode', 'v2', ZCODE_CREDENTIAL_FILE))
      .toBe('/C:\\profiles\\zcode/.zcode/v2/' + ZCODE_CREDENTIAL_FILE)

    // 上游允许写成 ~/zcode-data，不展开就会在 CWD 下建出一个字面叫 ~ 的目录。
    // 实现与期望用的是同一个 join(homedir(), ...)，两边同源，因此跨平台成立。
    expect(zcodeDataBaseDir({ [ZCODE_DATA_BASE_DIR_ENV]: '~/zcode-data' }))
      .toBe(join(homedir(), 'zcode-data'))
    expect(zcodeCredentialsPath({ [ZCODE_DATA_BASE_DIR_ENV]: '~/zcode-data' }))
      .toBe(join(homedir(), 'zcode-data', '.zcode', 'v2', ZCODE_CREDENTIAL_FILE))
  })

  it('空白变量按未设置处理（在 Windows 上它会解析成盘符相对路径）', () => {
    expect(zcodeDataBaseDir({ [ZCODE_DATA_BASE_DIR_ENV]: '   ' })).toBe(homedir())
  })

  it('在调用时读变量，不是模块加载时', async () => {
    const directory = await tempDir()
    await writeCredentialsFile(plaintextRecord('zai'), directory)
    // 变量是在模块导入之后才设的，仍然必须被看见。
    const paths = zcodeCredentialPaths({ [ZCODE_DATA_BASE_DIR_ENV]: directory })
    expect(paths).toEqual([join(directory, '.zcode', 'v2', ZCODE_CREDENTIAL_FILE)])
    const read = await readZcodeLocalSignIn(paths, {})
    expect(read.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 两区不串（这个文件最容易写错的地方）
// ---------------------------------------------------------------------------

describe('两区的凭据按区取，绝不扫描', () => {
  for (const active of ['zai', 'bigmodel'] as const) {
    it('active_provider=' + active + ' 时取回的是这一区的令牌（另一区的值同时在文件里）', async () => {
      const file = await writeCredentialsFile(plaintextRecord(active))
      const read = await readZcodeLocalSignIn([file], {})

      expect(read.ok).toBe(true)
      if (!read.ok) return
      expect(read.signIn.region).toBe(active === 'zai' ? 'intl' : 'cn')
      expect(read.signIn.accessToken).toBe(active === 'zai' ? INTL_ACCESS_TOKEN : CN_ACCESS_TOKEN)
      // 关键断言：绝不能是另一个部署的凭据。
      expect(read.signIn.accessToken).not.toBe(active === 'zai' ? CN_ACCESS_TOKEN : INTL_ACCESS_TOKEN)
      expect(read.signIn.refreshToken).toBe(active === 'zai' ? INTL_REFRESH_TOKEN : CN_REFRESH_TOKEN)
      expect(read.signIn.sourcePath).toBe(file)
    })
  }

  it('反序列化顺序换了也取同一个区的令牌（扫法会在这里露馅）', async () => {
    const reversed = Object.fromEntries(Object.entries(plaintextRecord('zai')).reverse())
    const file = await writeCredentialsFile(reversed)
    const read = await readZcodeLocalSignIn([file], {})

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.signIn.accessToken).toBe(INTL_ACCESS_TOKEN)
    expect(read.signIn.accessToken).not.toBe(CN_ACCESS_TOKEN)
  })

  it('只有一区有令牌、且没有 active_provider 时，按令牌所在的那一区判定', async () => {
    const only = { 'oauth:bigmodel:access_token': CN_ACCESS_TOKEN, zcodejwttoken: ZCODE_JWT_TOKEN }
    const file = await writeCredentialsFile(only)
    const read = await readZcodeLocalSignIn([file], {})

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.signIn.region).toBe('cn')
    expect(read.signIn.accessToken).toBe(CN_ACCESS_TOKEN)
  })

  it('两区都有而没有自述时退回 types.ts 的 DEFAULT_REGION（intl），不是新发明一个判断', async () => {
    const ambiguous = { 'oauth:zai:access_token': INTL_ACCESS_TOKEN, 'oauth:bigmodel:access_token': CN_ACCESS_TOKEN }
    const file = await writeCredentialsFile(ambiguous)
    const read = await readZcodeLocalSignIn([file], {})

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.signIn.region).toBe('intl')
  })

  it('active_provider 的字面量映射照 upstream 的 provider 名', () => {
    expect(regionForActiveProvider('zai')).toBe('intl')
    expect(regionForActiveProvider('bigmodel')).toBe('cn')
    expect(regionForActiveProvider(' ZAI ')).toBe('intl')
    expect(regionForActiveProvider('openai')).toBeUndefined()
    expect(regionForActiveProvider(undefined)).toBeUndefined()
  })

  it('身份信息来自 user_info，头像只留「有」而不落任何原始内容', async () => {
    const file = await writeCredentialsFile(plaintextRecord('zai'))
    const read = await readZcodeLocalSignIn([file], {})

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.signIn.userId).toBe('u-placeholder')
    expect(read.signIn.email).toBe(USER_EMAIL)
    expect(read.signIn.displayName).toBe('Tester')
    expect(read.signIn.hasAvatar).toBe(true)
    // 契约 GlmAccountDto 的注释：只保留是否已取到，绝不落原始字节。
    expect(Object.values(read.signIn)).not.toContain('https://example.invalid/a.png')
    expect(read.signIn.zcodeJwtToken).toBe(ZCODE_JWT_TOKEN)
  })
})

// ---------------------------------------------------------------------------
// 解密：明文与 enc:v1 密文
// ---------------------------------------------------------------------------

describe('值既可能是明文（旧值）也可能是 enc:v1 密文', () => {
  it('明文值原样可读', async () => {
    const file = await writeCredentialsFile(plaintextRecord('zai'))
    const read = await readZcodeLocalSignIn([file], {})

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.signIn.accessToken).toBe(INTL_ACCESS_TOKEN)
    expect(read.signIn.zcodeJwtToken).toBe(ZCODE_JWT_TOKEN)
  })

  it('enc:v1 密文可解（用模块自己的密钥推导造密文）', async () => {
    const key = deriveZcodeCredentialKey({})
    const file = await writeCredentialsFile({
      'oauth:active_provider': encryptLikeZcode('zai', key),
      'oauth:zai:access_token': encryptLikeZcode(INTL_ACCESS_TOKEN, key),
      'oauth:zai:refresh_token': encryptLikeZcode(INTL_REFRESH_TOKEN, key),
      'oauth:zai:user_info': encryptLikeZcode(USER_INFO, key),
      'oauth:bigmodel:access_token': encryptLikeZcode(CN_ACCESS_TOKEN, key),
      zcodejwttoken: encryptLikeZcode(ZCODE_JWT_TOKEN, key),
    })

    const read = await readZcodeLocalSignIn([file], {})

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.signIn.region).toBe('intl')
    expect(read.signIn.accessToken).toBe(INTL_ACCESS_TOKEN)
    expect(read.signIn.refreshToken).toBe(INTL_REFRESH_TOKEN)
    expect(read.signIn.email).toBe(USER_EMAIL)
    expect(read.signIn.zcodeJwtToken).toBe(ZCODE_JWT_TOKEN)
  })

  it('ZCODE_CREDENTIAL_SECRET 覆盖密钥，且覆盖后确实解得开', async () => {
    const secret = 'a-test-secret'
    const key = deriveZcodeCredentialKey({ [ZCODE_CREDENTIAL_SECRET_ENV]: secret })
    // 与不设变量时推出的密钥不同，否则这条断言什么也证明不了。
    expect(key.equals(deriveZcodeCredentialKey({}))).toBe(false)
    expect(decryptZcodeCredentialValue(encryptLikeZcode(INTL_ACCESS_TOKEN, key), deriveZcodeCredentialKey({ [ZCODE_CREDENTIAL_SECRET_ENV]: secret })))
      .toBe(INTL_ACCESS_TOKEN)

    const file = await writeCredentialsFile({
      'oauth:active_provider': encryptLikeZcode('zai', key),
      'oauth:zai:access_token': encryptLikeZcode(INTL_ACCESS_TOKEN, key),
    })
    const read = await readZcodeLocalSignIn([file], { [ZCODE_CREDENTIAL_SECRET_ENV]: secret })

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.signIn.accessToken).toBe(INTL_ACCESS_TOKEN)
  })

  it('解密失败给 decrypt-failed，而且不抛穿', async () => {
    // 用一把**不同的**密钥加密：模拟「客户端设了 ZCODE_CREDENTIAL_SECRET 而本进程没有」。
    const foreign = deriveZcodeCredentialKey({ [ZCODE_CREDENTIAL_SECRET_ENV]: 'someone-elses-secret' })
    const file = await writeCredentialsFile({
      'oauth:active_provider': encryptLikeZcode('zai', foreign),
      'oauth:zai:access_token': encryptLikeZcode(INTL_ACCESS_TOKEN, foreign),
    })

    const read = await readZcodeLocalSignIn([file], {})

    expect(read).toEqual({ ok: false, reason: 'decrypt-failed', sourcePath: file })
    const { fetchFn, calls } = routedFetch(exchangeRoutes())
    const outcome = await adoptZcodeSignIn({ paths: [file], env: {}, fetchFn })
    expect(outcome.result).toEqual({ attempted: true, adopted: false, reason: 'decrypt-failed' })
    // 解不开就别去打扰上游。
    expect(calls).toHaveLength(0)
  })

  it('畸形密文（段数、iv 长度、tag 长度不对）一律解不开而不抛错', () => {
    const key = deriveZcodeCredentialKey({})
    const iv = randomBytes(CREDENTIAL_CIPHER_IV_BYTES).toString('base64url')
    const tag = randomBytes(16).toString('base64url')
    const cipher = Buffer.from('whatever').toString('base64url')
    const bad = [
      ENCRYPTED_VALUE_PREFIX + iv + '.' + tag,
      ENCRYPTED_VALUE_PREFIX + iv + '.' + tag + '.' + cipher + '.extra',
      ENCRYPTED_VALUE_PREFIX + '',
      ENCRYPTED_VALUE_PREFIX + randomBytes(8).toString('base64url') + '.' + tag + '.' + cipher,
      ENCRYPTED_VALUE_PREFIX + iv + '.' + randomBytes(8).toString('base64url') + '.' + cipher,
      // 标签对不上（拿另一段密文拼过来）：GCM 会抛，必须被吃掉。
      ENCRYPTED_VALUE_PREFIX + iv + '.' + tag + '.' + Buffer.from('tampered').toString('base64url'),
    ]
    for (const value of bad) {
      expect(decryptZcodeCredentialValue(value, key), value).toBeUndefined()
    }
    // 没带前缀的值按明文原样返回（上游 decrypt 正是这么做的）。
    expect(decryptZcodeCredentialValue('plain-text', key)).toBe('plain-text')
  })

  it('可选字段解不开只降级为 null，不让整次 adopt 失败', async () => {
    const foreign = deriveZcodeCredentialKey({ [ZCODE_CREDENTIAL_SECRET_ENV]: 'someone-elses-secret' })
    const file = await writeCredentialsFile({
      'oauth:active_provider': 'zai',
      'oauth:zai:access_token': INTL_ACCESS_TOKEN,
      'oauth:zai:user_info': encryptLikeZcode(USER_INFO, foreign),
      zcodejwttoken: encryptLikeZcode(ZCODE_JWT_TOKEN, foreign),
    })

    const read = await readZcodeLocalSignIn([file], {})

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.signIn.accessToken).toBe(INTL_ACCESS_TOKEN)
    expect(read.signIn.zcodeJwtToken).toBeNull()
    expect(read.signIn.userId).toBeNull()
    expect(read.signIn.hasAvatar).toBe(false)
  })

  it('密钥永远推得出来：secret-unavailable 在本线路里不成立', () => {
    const secret = zcodeCredentialFallbackSecret()
    // 逐字格式来自 credential-cipher.ts 的 resolveCredentialSecret：
    // `zcode-credential-fallback:{platform}:{homedir}:{username}`。
    // 注意不能用 split(':').length === 4 来断言——Windows 上 homedir 本身就带一个冒号
    // （C:\Users\…），那是格式的一部分而不是错误。
    expect(secret.startsWith('zcode-credential-fallback:')).toBe(true)
    expect(secret).toContain(process.platform)
    expect(secret).toContain(homedir())
    // 密钥是 sha256(secret)，32 字节。
    expect(deriveZcodeCredentialKey({}).length).toBe(32)
    expect(deriveZcodeCredentialKey({}).equals(deriveZcodeCredentialKey({}))).toBe(true)
    // 契约冻结了六个 reason，这里给每个都留了一句可照做的下一步。
    expect(Object.keys(ADOPT_REASON_HINTS).sort()).toEqual([
      'decrypt-failed',
      'exchange-failed',
      'no-credentials-file',
      'not-a-zcode-login',
      'secret-unavailable',
      'token-expired',
    ])
    for (const [reason, hint] of Object.entries(ADOPT_REASON_HINTS)) expect(hint.length, reason).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 认不出来的形状
// ---------------------------------------------------------------------------

describe('认不出来的形状给一个值，从不给异常', () => {
  it('不是 JSON、空文件、数组、目录形态都判 not-a-zcode-login', async () => {
    const directory = await tempDir()
    const nested = join(directory, '.zcode', 'v2')
    await import('node:fs/promises').then((fs) => fs.mkdir(nested, { recursive: true }))
    const cases: Array<[string, string]> = [
      ['not json {{{', join(nested, 'a.json')],
      ['', join(nested, 'b.json')],
      ['[1,2,3]', join(nested, 'c.json')],
      ['"a string"', join(nested, 'd.json')],
      ['{}', join(nested, ZCODE_CREDENTIAL_FILE)],
    ]
    for (const [contents, file] of cases) {
      await writeFile(file, contents, 'utf8')
      const read = await readZcodeLocalSignIn([file], {})
      expect(read.ok, file).toBe(false)
      if (read.ok) return
      expect(read.reason, file).toBe('not-a-zcode-login')
    }
    // 一个目录占据凭据文件的位置：readFile 抛 EISDIR，被吃掉。
    const asDirectory = await tempDir()
    expect((await readZcodeLocalSignIn([asDirectory], {})).ok).toBe(false)
  })

  it('两个区的 access_token 都没有时判 not-a-zcode-login', async () => {
    const file = await writeCredentialsFile({ 'oauth:active_provider': 'zai', zcodejwttoken: ZCODE_JWT_TOKEN })
    const read = await readZcodeLocalSignIn([file], {})

    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.reason).toBe('not-a-zcode-login')
  })

  it('非字符串的条目被丢掉而不是让整份文档失败', async () => {
    // 上游的 parseCredentialRecord 遇到非字符串是抛错；本模块不抛。
    const file = await writeCredentialsFile(plaintextRecord('zai'))
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    parsed['oauth:active_provider'] = { not: 'a string' }
    parsed['oauth:zai:refresh_token'] = 42
    await writeFile(file, JSON.stringify(parsed), 'utf8')

    const read = await readZcodeLocalSignIn([file], {})

    expect(read.ok).toBe(true)
    if (!read.ok) return
    // 非字符串的 active_provider 被丢掉，于是退回「哪个区有令牌」：只有一个区有 → zai。
    expect(read.signIn.region).toBe('intl')
    expect(read.signIn.accessToken).toBe(INTL_ACCESS_TOKEN)
    expect(read.signIn.refreshToken).toBeNull()
  })

  it('user_info 是坏 JSON 时身份字段降级为 null，登录态本身仍然可用', async () => {
    const file = await writeCredentialsFile({
      'oauth:active_provider': 'zai',
      'oauth:zai:access_token': INTL_ACCESS_TOKEN,
      'oauth:zai:user_info': '{ not json',
    })
    const read = await readZcodeLocalSignIn([file], {})

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.signIn.userId).toBeNull()
    expect(read.signIn.email).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 过期判定
// ---------------------------------------------------------------------------

describe('过期：本地先判，判不出的交给上游', () => {
  it('exp 在过去判过期，在未来不判', () => {
    const now = 1_700_000_000_000
    expect(zcodeAccessTokenExpired(jwtWithExp(now - 1000), now)).toBe(true)
    expect(zcodeAccessTokenExpired(jwtWithExp(now + 60_000), now)).toBe(false)
    // 时刻本身算过期：宁可早判。
    expect(zcodeAccessTokenExpired(jwtWithExp(now), now)).toBe(true)
  })

  it('没有 exp、不是 JWT、exp 不成型时都不判过期', () => {
    // 计划 §3.6：上游没有 refresh 接口，而兑换链第一步
    // POST /api/auth/z/login {token} 本身就是「这枚 token 还行不行」的真判据。
    expect(zcodeAccessTokenExpired('not-a-jwt', Date.now())).toBe(false)
    expect(zcodeAccessTokenExpired(jwtWithExp(null), Date.now())).toBe(false)
    expect(zcodeAccessTokenExpired('h.' + Buffer.from(JSON.stringify({ exp: 'soon' })).toString('base64url') + '.s')).toBe(false)
    expect(zcodeAccessTokenExpired('h.@@@not-base64@@@.s')).toBe(false)
  })

  it('过期时不发任何上游请求，直接给 token-expired', async () => {
    const file = await writeCredentialsFile({
      'oauth:active_provider': 'zai',
      'oauth:zai:access_token': jwtWithExp(Date.now() - 60_000),
    })
    const { fetchFn, calls } = routedFetch(exchangeRoutes())

    const outcome = await adoptZcodeSignIn({ paths: [file], env: {}, fetchFn })

    expect(outcome.result).toEqual({ attempted: true, adopted: false, reason: 'token-expired', region: 'intl' })
    expect(outcome.adopted).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// adopt 全流程
// ---------------------------------------------------------------------------

describe('adopt 走的是与 oauth.ts 完全相同的那一套兑换', () => {
  it('成功时给出已验过活的 Coding Plan Key，且用的是本区那个 access_token', async () => {
    const file = await writeCredentialsFile(plaintextRecord('zai'))
    const { fetchFn, calls } = routedFetch(exchangeRoutes({
      keys: [{ name: GLM_KEY_NAME, apiKey: 'dsh-existing' }],
    }))

    const outcome = await adoptZcodeSignIn({ paths: [file], env: {}, fetchFn })

    expect(outcome.result).toEqual({ attempted: true, adopted: true, region: 'intl' })
    const adopted = outcome.adopted
    if (adopted === null) throw new Error('unreachable')
    expect(adopted.adopted).toBe(true)
    expect(adopted.source).toBe(ZCODE_CREDENTIAL_SOURCE)
    expect(adopted.sourcePath).toBe(file)
    expect(adopted.region).toBe('intl')
    expect(adopted.accessToken).toBe(INTL_ACCESS_TOKEN)
    expect(adopted.email).toBe(USER_EMAIL)
    expect(adopted.authenticatedAt).toBeGreaterThan(0)
    // 兑换链的产物与浏览器登录产出的是同一种东西。
    expect(adopted.codingPlan.codingPlanKey).toBe('dsh-existing.sk-placeholder')
    expect(adopted.codingPlan.organizationId).toBe('org-1')
    expect(adopted.codingPlan.planLevel).toBe('pro')
    // 五步端点逐字对齐，且业务登录把国际区那枚令牌放进体里。
    expect(calls[0]!.body).toEqual({ token: INTL_ACCESS_TOKEN })
    expect(calls[0]!.headers['authorization']).toBeUndefined()
    expect(calls.map((c) => c.url.replace('https://api.z.ai', ''))).toEqual([
      '/api/auth/z/login',
      '/api/biz/customer/getCustomerInfo',
      '/api/biz/v1/organization/org-1/projects/p-1/api_keys',
      '/api/biz/v1/organization/org-1/projects/p-1/api_keys/copy/dsh-existing',
      '/api/monitor/usage/quota/limit',
    ])
  })

  it('国区走 bigmodel.cn，且 /api/biz/* 带的是裸 access_token（exchange.ts 记录的两区差异）', async () => {
    const file = await writeCredentialsFile(plaintextRecord('bigmodel'))
    const calls: Routed['calls'] = []
    const { fetchFn } = routedFetch(exchangeRoutes(), calls)

    const outcome = await adoptZcodeSignIn({ paths: [file], env: {}, fetchFn })

    expect(outcome.result.region).toBe('cn')
    expect(outcome.adopted?.accessToken).toBe(CN_ACCESS_TOKEN)
    // 国区**跳过** z/login、直接拿 OAuth access_token 当 Authorization 裸值打 /api/biz/*。
    expect(calls.every((call) => call.url.startsWith('https://bigmodel.cn'))).toBe(true)
    expect(calls.some((call) => call.url.includes('/api/auth/z/login'))).toBe(false)
    expect(calls[0]!.url).toContain('/api/biz/customer/getCustomerInfo')
    for (const call of calls.filter((c) => c.url.includes('/api/biz/'))) {
      expect(call.headers['authorization']).toBe(CN_ACCESS_TOKEN)
      expect(call.headers['authorization']).not.toMatch(/^Bearer /)
    }
    // 国区没有业务 JWT 这一层，所以这一栏是 null（exchange.ts 的接口注释）。
    expect(outcome.adopted?.codingPlan.bizToken).toBeNull()
  })

  it('业务登录被拒（401）判 token-expired，因为凭证本身不行了', async () => {
    const file = await writeCredentialsFile(plaintextRecord('zai'))
    const { fetchFn } = routedFetch([[/\/api\/auth\/z\/login$/, () => jsonResponse({ code: 1003, msg: 'expired' }, 401)]])

    const outcome = await adoptZcodeSignIn({ paths: [file], env: {}, fetchFn })

    expect(outcome.result).toEqual({ attempted: true, adopted: false, reason: 'token-expired', region: 'intl' })
    expect(outcome.adopted).toBeNull()
  })

  it('链路走不通（500 / 网络错误 / 形状漂移）判 exchange-failed，永不抛穿', async () => {
    const file = await writeCredentialsFile(plaintextRecord('zai'))
    const broken: Array<Array<[RegExp, (init?: RequestInit) => Response]>> = [
      [[/\/api\/auth\/z\/login$/, () => jsonResponse({ msg: 'boom' }, 500)]],
      [[/\/api\/auth\/z\/login$/, () => { throw new TypeError('fetch failed') }]],
      [[/\/api\/auth\/z\/login$/, () => jsonResponse({ code: 0, data: { expires_in: 3600 } })]],
    ]
    for (const routes of broken) {
      const { fetchFn } = routedFetch(routes)
      const outcome = await adoptZcodeSignIn({ paths: [file], env: {}, fetchFn })
      expect(outcome.result, JSON.stringify(routes.map(([p]) => String(p)))).toEqual({
        attempted: true,
        adopted: false,
        reason: 'exchange-failed',
        region: 'intl',
      })
      expect(outcome.adopted).toBeNull()
    }
  })

  it('账号只有免费体验额度（兑换通、验活按套餐维度被拒）时 adopt **成功**', async () => {
    // 这条断言原来验的是「没有 Coding Plan 就导入失败」——那是本次改动要改掉的错行为：
    // 官方文档写明新用户注册即有 5 天、每天 800 万 token 的体验额度，把它拒在门外
    // 等于把免费额度的新用户挡在线路之外。正确处置是导入成功并标出 free-trial。
    const file = await writeCredentialsFile(plaintextRecord('zai'))
    const { fetchFn } = routedFetch(exchangeRoutes({
      quota: () => jsonResponse({ code: 1220, msg: 'no permission' }, 403),
    }))

    const outcome = await adoptZcodeSignIn({ paths: [file], env: {}, fetchFn })

    expect(outcome.result).toEqual({ attempted: true, adopted: true, region: 'intl' })
    expect(outcome.adopted?.codingPlan.allowance).toBe('free-trial')
  })

  it('Coding Plan Key 本身无效时判 exchange-failed，而不是 token-expired', async () => {
    // 保留原用例的**意图**（别把「Key 无效」说成「登录态过期」，那会把用户引到错误的操作上），
    // 但触发条件换成真正表示凭据无效的业务码 1000（AUTH_INVALID）。
    const file = await writeCredentialsFile(plaintextRecord('zai'))
    const { fetchFn } = routedFetch(exchangeRoutes({
      quota: () => jsonResponse({ code: 1000, msg: 'invalid api key' }, 401),
    }))

    const outcome = await adoptZcodeSignIn({ paths: [file], env: {}, fetchFn })

    expect(outcome.result.reason).toBe('exchange-failed')
    expect(outcome.result.reason).not.toBe('token-expired')
  })

  it('调用方自己发起的取消原样抛出，不被吞成 exchange-failed', async () => {
    const file = await writeCredentialsFile(plaintextRecord('zai'))
    const controller = new AbortController()
    const { fetchFn } = routedFetch([[/\/api\/auth\/z\/login$/, () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }]])

    await expect(
      adoptZcodeSignIn({ paths: [file], env: {}, fetchFn, signal: controller.signal }),
    ).rejects.toThrow(/abort/i)
  })

  it('adopt 标记只认本模块的快照，不把本插件登出来的凭据当成可丢弃的外来物', async () => {
    const file = await writeCredentialsFile(plaintextRecord('zai'))
    const { fetchFn } = routedFetch(exchangeRoutes())
    const outcome = await adoptZcodeSignIn({ paths: [file], env: {}, fetchFn })

    expect(isAdoptedZcodeCredential(outcome.adopted)).toBe(true)
    expect(isAdoptedZcodeCredential({ adopted: true, source: 'somewhere-else', codingPlan: {} })).toBe(false)
    expect(isAdoptedZcodeCredential({ adopted: true, source: ZCODE_CREDENTIAL_SOURCE })).toBe(false)
    expect(isAdoptedZcodeCredential({ accessToken: 'a', region: 'intl' })).toBe(false)
    expect(isAdoptedZcodeCredential(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 规则 1：永不写入
// ---------------------------------------------------------------------------

describe('adopt 永不写入 ZCode 的文件', () => {
  it('跑完之后凭据文件的字节、大小、mtime 三者不变，目录没有新增条目', async () => {
    const file = await writeCredentialsFile(plaintextRecord('zai'))
    const directory = credentialsDirOf(file)
    const before = {
      bytes: await readFile(file),
      stats: await stat(file),
      entries: (await readdir(directory)).sort(),
    }

    // 两个入口都跑：启动期的存在性探测，与 opt in 之后的完整读取。
    await zcodeCredentialPresence([file])
    const { fetchFn } = routedFetch(exchangeRoutes())
    const outcome = await adoptZcodeSignIn({ paths: [file], env: {}, fetchFn })
    expect(outcome.adopted).not.toBeNull()

    const after = {
      bytes: await readFile(file),
      stats: await stat(file),
      entries: (await readdir(directory)).sort(),
    }
    expect(after.bytes.equals(before.bytes)).toBe(true)
    expect(after.stats.size).toBe(before.stats.size)
    expect(after.stats.mtimeMs).toBe(before.stats.mtimeMs)
    // 没有临时文件、没有备份、没有标记文件被留下来。
    expect(after.entries).toEqual(before.entries)
    expect(after.entries).toEqual([ZCODE_CREDENTIAL_FILE])
  })

  it('失败路径同样不改文件（解密失败、兑换失败各来一次）', async () => {
    const foreign = deriveZcodeCredentialKey({ [ZCODE_CREDENTIAL_SECRET_ENV]: 'someone-elses-secret' })
    const locked = await writeCredentialsFile({
      'oauth:active_provider': encryptLikeZcode('zai', foreign),
      'oauth:zai:access_token': encryptLikeZcode(INTL_ACCESS_TOKEN, foreign),
    })
    const plain = await writeCredentialsFile(plaintextRecord('zai'))
    const snapshot = async (f: string) => ({ bytes: await readFile(f), stats: await stat(f) })
    const beforeLocked = await snapshot(locked)
    const beforePlain = await snapshot(plain)

    const { fetchFn } = routedFetch([[/\/api\/auth\/z\/login$/, () => jsonResponse({ msg: 'boom' }, 500)]])
    await adoptZcodeSignIn({ paths: [locked], env: {}, fetchFn })
    await adoptZcodeSignIn({ paths: [plain], env: {}, fetchFn })

    for (const [file, before] of [[locked, beforeLocked], [plain, beforePlain]] as const) {
      const after = await snapshot(file)
      expect(after.bytes.equals(before.bytes), file).toBe(true)
      expect(after.stats.mtimeMs, file).toBe(before.stats.mtimeMs)
    }
  })

  it('只按名导入 readFile 与 stat，且源码里没有任何写调用', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../src/host/glm-coding-plan/adopt.ts', import.meta.url)),
      'utf8',
    )

    // 按名导入是模块的结构性保证：这里根本没有 fs 命名空间对象可供穿透去写。
    expect(source).toContain("import { readFile, stat } from 'node:fs/promises'")
    expect(source).not.toContain("from 'node:fs'")
    expect(source).not.toContain('* as fs')
    // 词边界匹配的是**调用**，所以散文里恰好含写动词的词（"renamed"、"unlinked"）不会误伤。
    const writeCall = /\b(?:writeFile|appendFile|mkdir|rm|rmdir|unlink|rename|copyFile|createWriteStream|truncate|chmod|link|symlink|utimes)\s*\(/
    expect(source).not.toMatch(writeCall)
  })

  it('导出的东西没有一样会写：全是 reader、谓词、常量或类型', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../src/host/glm-coding-plan/adopt.ts', import.meta.url)),
      'utf8',
    )
    const exportNames = [...source.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1])
    expect(exportNames).toEqual([
      'regionForActiveProvider',
      'zcodeDataBaseDir',
      'zcodeCredentialsPath',
      'zcodeCredentialPaths',
      'zcodeCredentialPresence',
      'zcodeCredentialFallbackSecret',
      'deriveZcodeCredentialKey',
      'decryptZcodeCredentialValue',
      'zcodeAccessTokenExpired',
      'readZcodeLocalSignIn',
      'adoptZcodeSignIn',
      'isAdoptedZcodeCredential',
    ])
  })
})
