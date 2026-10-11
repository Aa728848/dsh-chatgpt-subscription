/**
 * W4：GLM（ZCode 账号）线路的 Client Request Signing V4。
 *
 * 全部离线：`fetch` 一律走测试内的 mock 桩，凭据是明显的占位串
 * （`testkeyid.testsecret123456`），Ed25519 私钥与 privateCipher 都在测试里现造，
 * 不联网、不要任何真实凭据、不依赖真实时钟。
 *
 * 三条最重要的断言，对应计划 §8.2 与任务书：
 *
 * 1. **默认关闭时一个签名头都不产生**（门控关闭 → 空表 → 零网络请求）；
 * 2. PoW 解出的 nonce 其 `digest[0] === 0`（前导 8 位 0）；
 * 3. `clientVersion` 与握手 origin 的环境变量覆盖真的生效（这两处是相对参考实现的必改项，
 *    参考实现的版本号是 3.4.0、origin 是 open.bigmodel.cn）。
 *
 * 协议细节与「为什么默认关闭」见 `src/host/glm-coding-plan/signing.ts` 的文件头。
 */

import crypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  CLIENT_SIGNING_DEFAULT_ENABLED,
  clientSigningEnabled,
} from '../src/host/glm-coding-plan/types.ts'
import {
  GlmClientSigner,
  GlmSigningError,
  SIGNING_APP_ID,
  SIGNING_CLIENT_VERSION_DEFAULT,
  SIGNING_HANDSHAKE_PATH,
  SIGNING_KDF_SALT,
  SIGNING_POW_SEED_HEX_LENGTH,
  SIGNING_INFO_PRIV,
  applyGlmClientSigning,
  parseGlmCodingPlanApiKey,
  signingClientVersion,
  signingHandshakeOrigin,
  signingHandshakeUrl,
  signingPowSeed,
  solveSigningProofOfWork,
} from '../src/host/glm-coding-plan/signing.ts'

/** 全部 fixture 共用的假凭据（占位串，非真值）。 */
const API_KEY_ID = 'testkeyid'
const API_KEY_SECRET = 'testsecret123456'
const API_KEY = `${API_KEY_ID}.${API_KEY_SECRET}`

/**
 * 按参考实现的协议造一份 privateCipher：
 * HKDF(salt=KDF_SALT, info='ed25519_priv') 导出 AES-GCM 密钥，iv 12 字节、
 * tag 16 字节、AAD = apiKeyId，明文是 **base64 后的** PKCS#8 DER（双层编码）。
 */
function makePrivateCipher(
  apiKeyId = API_KEY_ID,
  apiKeySecret = API_KEY_SECRET,
): { privateCipher: string; publicKey: crypto.KeyObject } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const pkcs8Der = privateKey.export({ format: 'der', type: 'pkcs8' })
  const aesKey = crypto.hkdfSync('sha256', apiKeySecret, SIGNING_KDF_SALT, SIGNING_INFO_PRIV, 32)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(aesKey), iv)
  cipher.setAAD(Buffer.from(apiKeyId, 'utf8'))
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(pkcs8Der.toString('base64'), 'utf8')),
    cipher.final(),
  ])
  return {
    privateCipher: Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64'),
    publicKey,
  }
}

/** 一份合法的握手应答。 */
function handshakeBody(privateCipher: string, code: unknown = 200): Record<string, unknown> {
  return { code, msg: 'OK', data: { privateCipher } }
}

/** 造一个只记调用、不发网络的 fetch 桩。 */
function fetchStub(
  privateCipher: string,
  init: { code?: unknown } = {},
): ReturnType<typeof vi.fn> & { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = vi.fn(async (url: unknown, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit })
    return new Response(JSON.stringify(handshakeBody(privateCipher, init.code ?? 200)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return Object.assign(fn, { calls })
}

describe('GLM Client Signing V4', () => {
  describe('parseGlmCodingPlanApiKey', () => {
    it('拆出 id / secret / 裸凭据', () => {
      expect(parseGlmCodingPlanApiKey('57271768622479063.abcdef123456')).toEqual({
        apiKeyId: '57271768622479063',
        apiKeySecret: 'abcdef123456',
        credential: '57271768622479063.abcdef123456',
      })
    })

    it('去掉首尾空白', () => {
      expect(parseGlmCodingPlanApiKey('  myid.mysecret  \n')).toEqual({
        apiKeyId: 'myid',
        apiKeySecret: 'mysecret',
        credential: 'myid.mysecret',
      })
    })

    it('拒绝畸形 Key（无点、首尾空、多个点）', () => {
      expect(parseGlmCodingPlanApiKey('')).toBeUndefined()
      expect(parseGlmCodingPlanApiKey('nodot')).toBeUndefined()
      expect(parseGlmCodingPlanApiKey('.secret')).toBeUndefined()
      expect(parseGlmCodingPlanApiKey('id.')).toBeUndefined()
      expect(parseGlmCodingPlanApiKey('id.secret.extra')).toBeUndefined()
    })
  })

  describe('proof of work', () => {
    it('解出的 nonce 其摘要首字节为 0（前导 8 位 0）', () => {
      const sessionId = 'test-session-123'
      const ts = '1700000000000'
      const answer = solveSigningProofOfWork({ apiKeyId: 'test-id', sessionId, ts, powBits: 8 })

      expect(answer).toMatch(/^[0-9a-f]{32}$/)

      const seed = crypto
        .createHash('sha256')
        .update(`test-id\n${SIGNING_APP_ID}\n${sessionId}\n${ts}`)
        .digest('hex')
        .slice(0, SIGNING_POW_SEED_HEX_LENGTH)
      const digest = crypto.createHash('sha256').update(`${seed}\n${answer}`).digest()
      expect(digest[0]).toBe(0)
    })

    it('seed 是 sha256 hex 的前 32 个字符（按 appId 变化）', () => {
      const base = { apiKeyId: 'k', sessionId: 's', ts: '1700000000000' }
      expect(signingPowSeed(base)).toHaveLength(SIGNING_POW_SEED_HEX_LENGTH)
      expect(signingPowSeed({ ...base, appId: 'other' })).not.toBe(signingPowSeed(base))
      expect(signingPowSeed(base)).toBe(
        crypto.createHash('sha256').update('k\nzcode\ns\n1700000000000').digest('hex').slice(0, 32),
      )
    })

    it('难度提高时仍能解出，且前导位更多', () => {
      const answer = solveSigningProofOfWork({
        apiKeyId: 'k',
        sessionId: 's',
        ts: '1700000000000',
        powBits: 12,
      })
      const seed = signingPowSeed({ apiKeyId: 'k', sessionId: 's', ts: '1700000000000' })
      const digest = crypto.createHash('sha256').update(`${seed}\n${answer}`).digest()
      // 12 位 = 首字节全 0 + 次字节高 4 位为 0（协议按字节+余位判定，不要求次字节整字节为 0）
      expect(digest[0]).toBe(0)
      expect(digest[1]! & 0xf0).toBe(0)
    })
  })

  describe('握手与签名（门控显式打开）', () => {
    it('解私钥 -> 签名，crypto.verify 验得过；握手结果被缓存', async () => {
      const { privateCipher, publicKey } = makePrivateCipher()
      const fetchFn = fetchStub(privateCipher)
      const signer = new GlmClientSigner({
        fetchFn: fetchFn as unknown as typeof fetch,
        env: { DSH_GLM_CLIENT_SIGNING: '1' },
      })

      const headers = await signer.buildSigningHeaders({ apiKey: API_KEY, sessionId: 'sess-1' })

      // ---- 握手请求形状：URL / Authorization / body 四字段 ----
      expect(fetchFn.calls).toHaveLength(1)
      const call = fetchFn.calls[0]!
      expect(call.url).toBe('https://api.z.ai' + SIGNING_HANDSHAKE_PATH)
      const headers0 = call.init?.headers as Record<string, string>
      // 裸凭据，不加 Bearer
      expect(headers0['authorization']).toBe(API_KEY)
      expect(headers0['authorization']).not.toMatch(/^Bearer /)
      expect(call.init?.method).toBe('POST')
      const body = JSON.parse(String(call.init?.body)) as Record<string, string>
      expect(Object.keys(body).sort()).toEqual(['apiKey', 'nonce', 'sig', 'ts'])
      expect(body['apiKey']).toBe(API_KEY)
      expect(body['ts']).toMatch(/^\d{13}$/)
      expect(body['nonce']).toMatch(/^[0-9a-f]{24}$/)
      // sig 是 base64 且非空（HMAC-SHA256 → 32 字节 → 44 字符 base64）
      expect(Buffer.from(body['sig'] ?? '', 'base64')).toHaveLength(32)
      expect(body['sig']).toBe(
        (() => {
          const hmacKey = crypto.hkdfSync('sha256', API_KEY_SECRET, SIGNING_KDF_SALT, 'getSignKey_hmac', 32)
          const hmac = crypto.createHmac('sha256', Buffer.from(hmacKey))
          // 换行分隔，不是空格分隔
          hmac.update(`get_sign_key\n${API_KEY_ID}\n${body['ts']}\n${body['nonce']}`)
          return hmac.digest('base64')
        })(),
      )

      // ---- 头表：版本号 >= 3.15.1，且不越权写 Authorization ----
      const version = SIGNING_CLIENT_VERSION_DEFAULT
      expect(version).toBe('3.15.1')
      expect(headers['X-Client-Version']).toBe(version)
      expect(headers['X-ZCode-App-Version']).toBe(version)
      expect(headers['User-Agent']).toBe(`ZCode/${version}`)
      expect(headers['X-App-Id']).toBe('zcode')
      expect(headers['X-Title']).toBe('Z Code@cli')
      expect(headers['X-Release-Channel']).toBe('stable')
      expect(headers['X-ZCode-Agent']).toBe('glm')
      expect(headers['X-Session-Id']).toBe('sess-1')
      expect(headers['X-Client-Ts']).toMatch(/^\d{13}$/)
      expect(headers['X-Client-Nonce']).toMatch(/^[0-9a-f]{32}$/)
      // 签名层不写 Authorization：模型面的认证头归 W5/W6 装配
      expect(headers['Authorization']).toBeUndefined()

      // ---- Ed25519 签名可被公钥验证（消息是五段换行分隔） ----
      const signedMessage = [
        API_KEY_ID,
        headers['X-Client-Ts'],
        version,
        headers['X-Session-Id'],
        headers['X-Client-Nonce'],
      ].join('\n')
      const verified = crypto.verify(
        null,
        Buffer.from(signedMessage, 'utf8'),
        publicKey,
        Buffer.from(String(headers['X-Client-Sig']), 'base64'),
      )
      expect(verified).toBe(true)
      // base64 而不是 hex（64 字节签名 → 88 字符 base64）
      expect(Buffer.from(String(headers['X-Client-Sig']), 'base64')).toHaveLength(64)
      expect(String(headers['X-Client-Sig'])).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)

      // ---- 缓存：同一凭据只握手一次 ----
      await signer.buildSigningHeaders({ apiKey: API_KEY, sessionId: 'sess-2' })
      await signer.buildSigningHeaders({ apiKey: API_KEY, sessionId: 'sess-3' })
      expect(fetchFn.calls).toHaveLength(1)

      // ---- 并发只打一次（在飞登记在 await 之前） ----
      const other = makePrivateCipher('other-id', 'other-secret')
      const otherFetch = fetchStub(other.privateCipher)
      const otherSigner = new GlmClientSigner({
        fetchFn: otherFetch as unknown as typeof fetch,
        env: { DSH_GLM_CLIENT_SIGNING: '1' },
      })
      const concurrent = await Promise.all([
        otherSigner.buildSigningHeaders({ apiKey: 'other-id.other-secret' }),
        otherSigner.buildSigningHeaders({ apiKey: 'other-id.other-secret' }),
        otherSigner.buildSigningHeaders({ apiKey: 'other-id.other-secret' }),
      ])
      expect(otherFetch.calls).toHaveLength(1)
      expect(new Set(concurrent.map((h) => h['X-Client-Sig'])).size).toBe(3)
    })

    it('并发握手下不同凭据各自独立握手（不会串号）', async () => {
      const a = makePrivateCipher('ida', 'secreta')
      const b = makePrivateCipher('idb', 'secretb')
      const fetchFn = vi.fn(async (url: unknown, requestInit?: RequestInit) => {
        const body = JSON.parse(String(requestInit?.body)) as { apiKey: string }
        const cipher = body.apiKey === 'ida.secreta' ? a.privateCipher : b.privateCipher
        return new Response(JSON.stringify(handshakeBody(cipher)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      })
      const signer = new GlmClientSigner({
        fetchFn: fetchFn as unknown as typeof fetch,
        env: { DSH_GLM_CLIENT_SIGNING: '1' },
      })
      const [ha, hb] = await Promise.all([
        signer.buildSigningHeaders({ apiKey: 'ida.secreta' }),
        signer.buildSigningHeaders({ apiKey: 'idb.secretb' }),
      ])
      expect(fetchFn).toHaveBeenCalledTimes(2)
      // 各自用自己的私钥签名，互不通用
      expect(crypto.verify(
        null,
        Buffer.from(`ida\n${ha['X-Client-Ts']}\n${SIGNING_CLIENT_VERSION_DEFAULT}\n${ha['X-Session-Id']}\n${ha['X-Client-Nonce']}`, 'utf8'),
        a.publicKey,
        Buffer.from(String(ha['X-Client-Sig']), 'base64'),
      )).toBe(true)
      expect(crypto.verify(
        null,
        Buffer.from(`idb\n${hb['X-Client-Ts']}\n${SIGNING_CLIENT_VERSION_DEFAULT}\n${hb['X-Session-Id']}\n${hb['X-Client-Nonce']}`, 'utf8'),
        b.publicKey,
        Buffer.from(String(hb['X-Client-Sig']), 'base64'),
      )).toBe(true)
    })

    it('握手被拒 / 密文太短 / 请求失败，都抛 GlmSigningError 且不缓存', async () => {
      const signer = new GlmClientSigner({
        fetchFn: vi.fn(async () => new Response(JSON.stringify({ code: 1000, msg: 'nope' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
        env: { DSH_GLM_CLIENT_SIGNING: '1' },
      })
      await expect(signer.buildSigningHeaders({ apiKey: API_KEY })).rejects.toBeInstanceOf(GlmSigningError)
      await expect(signer.buildSigningHeaders({ apiKey: API_KEY })).rejects.toThrow(/code=1000/)

      const shortSigner = new GlmClientSigner({
        fetchFn: vi.fn(async () => new Response(JSON.stringify(handshakeBody(Buffer.alloc(8).toString('base64'))), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
        env: { DSH_GLM_CLIENT_SIGNING: '1' },
      })
      await expect(shortSigner.buildSigningHeaders({ apiKey: API_KEY })).rejects.toThrow(/privateCipher 太短/)

      const failingSigner = new GlmClientSigner({
        fetchFn: vi.fn(async () => {
          throw new Error('socket hang up')
        }) as unknown as typeof fetch,
        env: { DSH_GLM_CLIENT_SIGNING: '1' },
      })
      await expect(failingSigner.buildSigningHeaders({ apiKey: API_KEY })).rejects.toThrow(/socket hang up/)
    })

    it('code=0 也算成功（与业务面信封同口径）', async () => {
      const { privateCipher } = makePrivateCipher()
      const fetchFn = fetchStub(privateCipher, { code: 0 })
      const signer = new GlmClientSigner({
        fetchFn: fetchFn as unknown as typeof fetch,
        env: { DSH_GLM_CLIENT_SIGNING: '1' },
      })
      const headers = await signer.buildSigningHeaders({ apiKey: API_KEY })
      expect(typeof headers['X-Client-Sig']).toBe('string')
    })

    it('握手挂死时自己超时，不把整条请求挂住', async () => {
      const signer = new GlmClientSigner({
        fetchFn: vi.fn((_url: unknown, requestInit?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            requestInit?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
        ) as unknown as typeof fetch,
        env: { DSH_GLM_CLIENT_SIGNING: '1' },
        handshakeTimeoutMs: 20,
      })
      await expect(signer.buildSigningHeaders({ apiKey: API_KEY })).rejects.toThrow(/aborted|握手/)
    })
  })

  describe('默认关闭（证据等级 C，D5）', () => {
    it('默认常量就是关闭', () => {
      expect(CLIENT_SIGNING_DEFAULT_ENABLED).toBe(false)
      expect(clientSigningEnabled({})).toBe(false)
      expect(clientSigningEnabled({ DSH_GLM_CLIENT_SIGNING: '0' })).toBe(false)
      expect(clientSigningEnabled({ DSH_GLM_CLIENT_SIGNING: '1' })).toBe(true)
    })

    it('默认关闭时一个签名头都不产生，且一次网络请求都不发', async () => {
      const fetchFn = fetchStub('irrelevant')
      const signer = new GlmClientSigner({
        fetchFn: fetchFn as unknown as typeof fetch,
        env: {},
      })

      const headers = await signer.buildSigningHeaders({ apiKey: API_KEY })
      expect(headers).toEqual({})
      expect(Object.keys(headers)).toHaveLength(0)
      expect(headers['X-Client-Sig']).toBeUndefined()
      expect(headers['X-Client-Pow']).toBeUndefined()
      expect(headers['X-Client-Version']).toBeUndefined()
      expect(headers['X-App-Id']).toBeUndefined()
      // 门控在网络之前：一个字节都没发出去
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('默认关闭时 applyGlmClientSigning 不改动调用方请求头一个键', async () => {
      const fetchFn = fetchStub('irrelevant')
      const original: Record<string, string> = {
        'x-api-key': API_KEY,
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
      }
      const merged = await applyGlmClientSigning(
        original,
        { apiKey: API_KEY },
        { fetchFn: fetchFn as unknown as typeof fetch, env: {} },
      )

      expect(merged).toBe(original)
      expect(Object.keys(merged)).toEqual(['x-api-key', 'authorization', 'content-type'])
      expect(merged['authorization']).toBe(`Bearer ${API_KEY}`)
      expect(Object.keys(merged).some((k) => k.toLowerCase().startsWith('x-client'))).toBe(false)
      expect(merged['X-Title']).toBeUndefined()
      expect(fetchFn).not.toHaveBeenCalled()
    })
  })

  describe('applyGlmClientSigning（门控打开）', () => {
    it('就地合并签名头，不覆盖调用方的 Authorization；默认保留其 User-Agent', async () => {
      const { privateCipher } = makePrivateCipher()
      const fetchFn = fetchStub(privateCipher)
      const original: Record<string, string> = {
        'x-api-key': API_KEY,
        authorization: `Bearer ${API_KEY}`,
        'user-agent': 'dsh-chatgpt-subscription',
      }
      const merged = await applyGlmClientSigning(
        original,
        { apiKey: API_KEY },
        { fetchFn: fetchFn as unknown as typeof fetch, env: { DSH_GLM_CLIENT_SIGNING: '1' } },
      )

      expect(merged).toBe(original)
      expect(merged['authorization']).toBe(`Bearer ${API_KEY}`) // 认证头归装配层
      expect(merged['user-agent']).toBe('dsh-chatgpt-subscription') // 默认不冒充官方客户端
      expect(merged['X-Client-Version']).toBe(SIGNING_CLIENT_VERSION_DEFAULT)
      expect(merged['X-Client-Sig']).toBeTypeOf('string')
      expect(merged['X-Client-Pow']).toBeTypeOf('string')
    })

    it('overrideUserAgent 显式打开时替换 User-Agent', async () => {
      const { privateCipher } = makePrivateCipher()
      const merged = await applyGlmClientSigning(
        { 'user-agent': 'dsh-chatgpt-subscription' },
        { apiKey: API_KEY },
        {
          fetchFn: fetchStub(privateCipher) as unknown as typeof fetch,
          env: { DSH_GLM_CLIENT_SIGNING: '1' },
          overrideUserAgent: true,
        },
      )
      // 键名统一写成签名器的规范大小写（同名不同大小写只保留一条，避免 fetch 收到重复头）
      expect(Object.keys(merged).filter((k) => k.toLowerCase() === 'user-agent')).toEqual(['User-Agent'])
      expect(merged['User-Agent']).toBe(`ZCode/${SIGNING_CLIENT_VERSION_DEFAULT}`)
      expect(merged['user-agent']).toBeUndefined()
    })

    it('大小写不敏感地覆盖同名头，不留下重复键', async () => {
      const { privateCipher } = makePrivateCipher()
      const merged = await applyGlmClientSigning(
        { 'x-client-version': '0.0.1', 'x-client-nonce': 'stale' },
        { apiKey: API_KEY },
        {
          fetchFn: fetchStub(privateCipher) as unknown as typeof fetch,
          env: { DSH_GLM_CLIENT_SIGNING: '1' },
        },
      )
      const versionKeys = Object.keys(merged).filter((k) => k.toLowerCase() === 'x-client-version')
      expect(versionKeys).toEqual(['X-Client-Version'])
      expect(merged['X-Client-Version']).toBe(SIGNING_CLIENT_VERSION_DEFAULT)
      expect(merged['x-client-version']).toBeUndefined()
      expect(merged['x-client-nonce']).toBeUndefined()
      expect(merged['X-Client-Nonce']).toMatch(/^[0-9a-f]{32}$/)
    })
  })

  describe('环境变量覆盖', () => {
    it('握手 origin 默认 api.z.ai，可被 DSH_GLM_SIGN_HANDSHAKE_BASE 覆盖', () => {
      expect(signingHandshakeOrigin({})).toBe('https://api.z.ai')
      expect(signingHandshakeUrl({})).toBe('https://api.z.ai' + SIGNING_HANDSHAKE_PATH)

      const env = { DSH_GLM_SIGN_HANDSHAKE_BASE: 'https://open.bigmodel.cn/' }
      expect(signingHandshakeOrigin(env)).toBe('https://open.bigmodel.cn') // 尾部斜杠被去掉
      expect(signingHandshakeUrl(env)).toBe('https://open.bigmodel.cn' + SIGNING_HANDSHAKE_PATH)

      // 整串覆盖优先于 origin 覆盖（路径 c1f3a7e2 若轮换用得着）
      const whole = { DSH_GLM_SIGN_HANDSHAKE_BASE: 'https://a.test', DSH_GLM_SIGN_HANDSHAKE_URL: 'https://b.test/handshake' }
      expect(signingHandshakeUrl(whole)).toBe('https://b.test/handshake')
      // 空串视作未设置
      expect(signingHandshakeUrl({ DSH_GLM_SIGN_HANDSHAKE_BASE: '  ' })).toBe('https://api.z.ai' + SIGNING_HANDSHAKE_PATH)
    })

    it('握手真的打到被覆盖的 origin', async () => {
      const { privateCipher } = makePrivateCipher()
      const fetchFn = fetchStub(privateCipher)
      const signer = new GlmClientSigner({
        fetchFn: fetchFn as unknown as typeof fetch,
        env: {
          DSH_GLM_CLIENT_SIGNING: '1',
          DSH_GLM_SIGN_HANDSHAKE_BASE: 'https://mirror.example.test',
        },
      })
      expect(signer.handshakeUrl).toBe('https://mirror.example.test' + SIGNING_HANDSHAKE_PATH)
      await signer.buildSigningHeaders({ apiKey: API_KEY })
      expect(fetchFn.calls[0]?.url).toBe('https://mirror.example.test' + SIGNING_HANDSHAKE_PATH)
    })

    it('clientVersion 默认 3.15.1，可被 DSH_GLM_SIGN_CLIENT_VERSION 覆盖，且三个头同步', () => {
      expect(signingClientVersion({})).toBe('3.15.1')
      expect(signingClientVersion({ DSH_GLM_SIGN_CLIENT_VERSION: '3.20.0' })).toBe('3.20.0')

      // 显式入参优先于环境变量
      expect(signingClientVersion({ DSH_GLM_SIGN_CLIENT_VERSION: '3.20.0' })).not.toBe('')
    })

    it('clientVersion 覆盖后同时进签名串与三个版本头', async () => {
      const { privateCipher, publicKey } = makePrivateCipher()
      const signer = new GlmClientSigner({
        fetchFn: fetchStub(privateCipher) as unknown as typeof fetch,
        env: { DSH_GLM_CLIENT_SIGNING: '1', DSH_GLM_SIGN_CLIENT_VERSION: '3.20.0' },
      })
      const headers = await signer.buildSigningHeaders({ apiKey: API_KEY, sessionId: 'sess-v' })
      expect(headers['X-Client-Version']).toBe('3.20.0')
      expect(headers['X-ZCode-App-Version']).toBe('3.20.0')
      expect(headers['User-Agent']).toBe('ZCode/3.20.0')
      const signed = [
        API_KEY_ID,
        headers['X-Client-Ts'],
        '3.20.0',
        headers['X-Session-Id'],
        headers['X-Client-Nonce'],
      ].join('\n')
      expect(crypto.verify(
        null,
        Buffer.from(signed, 'utf8'),
        publicKey,
        Buffer.from(String(headers['X-Client-Sig']), 'base64'),
      )).toBe(true)
    })
  })
})
