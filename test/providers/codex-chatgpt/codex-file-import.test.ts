import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { CodexCredentialImportError, parseCodexCredentialFile } from '../../../src/host/providers/codex-chatgpt/codex-file-import.ts'

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.test-signature`
}

function credential(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'codex',
    access_token: jwt({
      exp: 2_000_000_000,
      email: 'token@example.com',
      'https://api.openai.com/auth': { chatgpt_user_id: 'token-user' },
    }),
    refresh_token: 'refresh-token',
    id_token: jwt({ sub: 'id-user', email: 'id@example.com' }),
    account_id: 'workspace-1',
    chatgpt_user_id: 'user-1',
    email: 'person@example.com',
    plan_type: 'plus',
    disabled: false,
    ...overrides,
  }
}

function sub2api(accounts: unknown[]): Buffer {
  return Buffer.from(JSON.stringify({ type: 'sub2api-data', version: 1, accounts }))
}

function wrapper(value: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'account', platform: 'openai', type: 'oauth', credentials: value, ...overrides }
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const compressed = deflateRawSync(entry.data)
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += local.length + name.length + compressed.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

describe('parseCodexCredentialFile', () => {
  it('maps sub2api OAuth credentials and skips unusable accounts', () => {
    const parsed = parseCodexCredentialFile(sub2api([
      wrapper(credential()),
      wrapper(credential({ disabled: true })),
      wrapper(credential(), { platform: 'anthropic' }),
      wrapper({ type: 'codex', access_token: 'missing-refresh' }),
    ]))
    expect(parsed.format).toBe('sub2api')
    expect(parsed.skipped).toBe(3)
    expect(parsed.credentials).toHaveLength(1)
    expect(parsed.credentials[0]).toMatchObject({
      accessToken: credential().access_token,
      refreshToken: 'refresh-token',
      expiresAt: 2_000_000_000_000,
      accountId: 'workspace-1',
      userId: 'user-1',
      email: 'person@example.com',
      planType: 'plus',
    })
    expect(parsed.credentials[0]?.adopted).toBeUndefined()
  })

  it('uses the export expiry when an access token is opaque', () => {
    const expired = '2033-05-18T03:33:20.000Z'
    const parsed = parseCodexCredentialFile(sub2api([
      wrapper(credential({ access_token: 'opaque', id_token: '', expired: expired })),
    ]))
    expect(parsed.credentials[0]?.expiresAt).toBe(Date.parse(expired))
  })

  it('reads deflated CPA JSON entries and skips damaged or disabled records', () => {
    const archive = zip([
      { name: 'one-cpa.json', data: Buffer.from(JSON.stringify(credential())) },
      { name: 'disabled-cpa.json', data: Buffer.from(JSON.stringify(credential({ disabled: true }))) },
      { name: 'broken-cpa.json', data: Buffer.from('{') },
      { name: 'notes.txt', data: Buffer.from('not an account') },
    ])
    const parsed = parseCodexCredentialFile(archive)
    expect(parsed).toMatchObject({ format: 'cpa', skipped: 2 })
    expect(parsed.credentials).toHaveLength(1)
    expect(parsed.credentials[0]).toMatchObject({ accountId: 'workspace-1', userId: 'user-1' })
  })

  it('rejects unknown files and ZIP entries with a bad integrity check', () => {
    expect(() => parseCodexCredentialFile(Buffer.from('{"json":true}'))).toThrow(CodexCredentialImportError)
    const archive = zip([{ name: 'one-cpa.json', data: Buffer.from(JSON.stringify(credential())) }])
    archive[42] = (archive[42] ?? 0) ^ 0xff
    expect(() => parseCodexCredentialFile(archive)).toThrow(/integrity|decompressed/)
  })
})
