/**
 * Qoder COSY 签名与 body codec 的 byte-exact 已知答案测试。
 *
 * 期望值全部来自 Liki4/qodercli2api 的全合成 frozen fixtures（qodercli v1.1.34
 * 互操作基线），本仓库 vendored 在 test/fixtures/qoder/ 下：
 *
 * - credential.json：adopt 文件的 AES-128-CBC 信封（key=IV=machine_id 前 16 字符）；
 * - runtime-fields.json：runtime auth fields（熵 tape → AES key → encrypt_user_info）；
 * - infer-user-no-org.json：完整请求的 URL、18 个头、编码 body 与签名。
 *
 * fixture 是合成的（仓库明说没有任何真实凭据），所以这里跑的是算法一致性，
 * 不是凭据有效性。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildQoderCosyHeaders,
  cosySignedPath,
  decryptQoderAdoptPayload,
  encodeQoderBody,
  generateQoderRuntimeAuthFields,
  qoderCosySignature,
  qoderMaskedBytes,
  qoderRequestUuid,
} from '../src/host/qoder/cosy.ts'

const fixtures = path.join(__dirname, 'fixtures', 'qoder')

function fixture(name: string): {
  input: Record<string, never>
  expected: Record<string, never>
  transcript?: { unix_milli?: unknown; entropy_reads?: Array<{ length: number; bytes: string }> }
} {
  return JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'))
}

describe('qoder cosy: frozen fixture vectors', () => {
  it('adopt 文件的 AES-128-CBC 解密（credential.json）', () => {
    const f = fixture('credential.json') as unknown as {
      input: { machine_key: string; plain: string }
      expected: { decrypted: string; encrypted: string }
    }
    // machine_id 前 16 个字符的 raw UTF-8 字节 = key = IV。
    const decrypted = decryptQoderAdoptPayload(f.expected.encrypted, f.input.machine_key)
    expect(decrypted).toBe(f.input.plain)
    expect(decrypted).toBe(f.expected.decrypted)
    // 明文 JSON 兼容（官方加载行为：{ 开头按明文解析）。
    expect(decryptQoderAdoptPayload('  ' + f.input.plain + ' ', f.input.machine_key)).toBe(f.input.plain)
    // 错的 key 必须失败而不是给一份垃圾（PKCS#7 严格校验）。
    expect(() => decryptQoderAdoptPayload(f.expected.encrypted, 'ffffffff-ffff-4f')).toThrow()
  })

  it('runtime auth fields（runtime-fields.json 的熵 tape → AES 密文逐字节相等）', () => {
    const f = fixture('runtime-fields.json') as unknown as {
      input: { raw: string }
      transcript: { entropy_reads: Array<{ length: number; bytes: string }> }
      expected: { encrypt_user_info: string; key: string }
    }
    const tape = f.transcript.entropy_reads.map((read) => Buffer.from(read.bytes, 'base64'))
    let cursor = 0
    const fields = generateQoderRuntimeAuthFields(f.input.raw, () => tape[cursor++]!)
    // AES 是确定性的：同 key 同明文必同密文。
    expect(fields.encryptUserInfo).toBe(f.expected.encrypt_user_info)
    // RSA PKCS#1 v1.5 的 PS 是不可注入的随机（Node 不接受 tape），所以 key 只能断言
    // 形状：128 字节（RSA-1024）的 strict padded Base64。逐字节的期望值在 fixture 里，
    // 它只能由持有同一 RNG tape 的 oracle 复现。
    expect(Buffer.from(fields.key, 'base64')).toHaveLength(128)
  })

  it('masked bytes 与 request UUID 的官方变换', () => {
    // 熵 01..10 反转+掩码后 hex 前 16 字符是 runtime key（runtime-fields.json 的输入）。
    const masked = qoderMaskedBytes(Buffer.from('AQIDBAUGBwgJCgsMDQ4PEA==', 'base64'))
    expect(masked.toString('hex').slice(0, 16)).toBe('100f0e0d0c0b4a09')
    // infer-user-no-org.json 的第三次熵读是 COSY request UUID 的原料。
    const f = fixture('infer-user-no-org.json') as unknown as {
      transcript: { entropy_reads: Array<{ bytes: string }> }
      expected: { header: Record<string, string[]> }
    }
    const uuid = qoderRequestUuid(Buffer.from(f.transcript.entropy_reads[2]!.bytes, 'base64'))
    // Authorization payload 里的 requestId 就是它。
    const authorization = f.expected.header['Authorization']![0]!
    const payloadB64 = authorization.slice('Bearer COSY.'.length, authorization.lastIndexOf('.'))
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8')) as { requestId: string }
    expect(payload.requestId).toBe(uuid)
  })

  it('body codec（infer-user-no-org.json 的 body_string 逐字节相等）', () => {
    const f = fixture('infer-user-no-org.json') as unknown as {
      input: { body_raw: string }
      expected: { body_string: string; body_bytes: string }
    }
    const encoded = encodeQoderBody(f.input.body_raw)
    expect(encoded).toBe(f.expected.body_string)
    expect(Buffer.from(encoded, 'utf8').toString('base64')).toBe(f.expected.body_bytes)
  })

  it('canonical MD5 签名（infer-user-no-org.json 的 Authorization 逐字相等）', () => {
    const f = fixture('infer-user-no-org.json') as unknown as {
      input: { body_raw: string; machine_id: string; version: string; user: { uid: string; encrypt_user_info: string; key: string; organization_id: string; organization_tags: string[]; data_policy_agreed: boolean } }
      transcript: { unix_milli: number[] }
      expected: { url: string; header: Record<string, string[]>; body_string: string }
    }
    // fixture 语义（docs/oauth.md §6 / inference-protocol.md §3.0）：context 保留调用方的
    // encrypt_user_info / key，它们直接进 payload 与签名。所以这里按官方五段 canonical 形
    // 直接对照签名；buildQoderCosyHeaders 的对应路径由「头的条件 presence 矩阵」用例覆盖。
    const encoded = encodeQoderBody(f.input.body_raw)
    const payloadB64 = Buffer.from(
      '{"version":"v1","requestId":"8d8c8b8a-8988-4786-8584-838281807f7e","info":"synthetic-caller-info-not-effective","cosyVersion":"1.1.34","ideVersion":""}',
      'utf8',
    ).toString('base64')
    const authorization = f.expected.header['Authorization']![0]!
    const [prefix, expectedSig] = authorization.split('.').slice(1) as [string, string]
    expect(payloadB64).toBe(prefix)
    const sig = qoderCosySignature({
      payloadB64,
      key: f.input.user.key,
      unixSeconds: String(Math.floor(f.transcript.unix_milli[0]! / 1000)),
      encodedBody: encoded,
      signedPath: '/api/v2/service/pro/sse/agent_chat_generation',
    })
    expect(sig).toBe(expectedSig)
    expect('Bearer COSY.' + payloadB64 + '.' + sig).toBe(authorization)
  })
})

describe('qoder cosy: 头的条件 presence 矩阵', () => {
  const identity = {
    uid: 'u-1',
    rawUserInfo: '{"uid":"u-1"}',
    machineId: '00000000-1111-4222-8333-444444444444',
    cosyVersion: '1.1.72',
    dataPolicyAgreed: false,
  }
  const base = {
    encodedBody: 'x',
    url: 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1',
    accept: 'text/event-stream',
    withContentType: true,
  } as const

  it('组织字段为空时省略对应的头（fixture 的 18 头形态）', () => {
    const headers = buildQoderCosyHeaders(identity, base)
    expect(headers['Cosy-Organization-Id']).toBeUndefined()
    expect(headers['Cosy-Organization-Tags']).toBeUndefined()
    expect(headers['X-Model-Key']).toBeUndefined()
    expect(headers['X-Model-Source']).toBeUndefined()
    // 18 个固定头 + Content-Type（本函数对带 body 的 POST 补上它）。
    expect(Object.keys(headers)).toHaveLength(18)
    expect(headers['Cosy-Data-Policy']).toBe('disagree')
    expect(headers['Cosy-User']).toBe('u-1')
    expect(headers['Authorization']).toMatch(/^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/)
  })

  it('组织与模型字段非空时各补两个头（22 头形态）', () => {
    const headers = buildQoderCosyHeaders(
      { ...identity, organizationId: 'org-1', organizationTags: ['a', 'b'], dataPolicyAgreed: true },
      { ...base, modelKey: 'qmodel', modelSource: 'system' },
    )
    expect(headers['Cosy-Organization-Id']).toBe('org-1')
    expect(headers['Cosy-Organization-Tags']).toBe('a,b')
    expect(headers['X-Model-Key']).toBe('qmodel')
    expect(headers['X-Model-Source']).toBe('system')
    expect(headers['Cosy-Data-Policy']).toBe('agree')
    expect(Object.keys(headers)).toHaveLength(22)
  })

  it('签名路径剥掉 /algo 前缀且不含 query', () => {
    expect(cosySignedPath('https://api3.qoder.sh/algo/api/v2/model/list?Encode=1')).toBe('/api/v2/model/list')
    expect(cosySignedPath('https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'))
      .toBe('/api/v2/service/pro/sse/agent_chat_generation')
  })
})
