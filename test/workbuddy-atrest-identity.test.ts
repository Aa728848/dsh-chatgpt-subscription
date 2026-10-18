import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AtRestError,
  associatedData,
  deriveKeyId,
  isSealedValue,
  openSealedField,
  parseKeyText,
  setActiveAtRestKey,
  verifyKeyAgainstKeyBlob,
} from '../src/host/workbuddy/atrest.ts'
import {
  parseCredentialFile,
  unsealCredentials,
} from '../src/host/workbuddy/token-store.ts'
import {
  parseDsmlToolCalls,
  parseLeakedToolCalls,
  printedCallHoldIndex,
  printedCallLooksComplete,
  recoverPrintedToolCalls,
} from '../src/host/workbuddy/dsml.ts'
import {
  deriveMachineId,
  normalizeOutboundSetting,
  outboundIdentity,
  resolveOutboundProduct,
} from '../src/host/workbuddy/outbound-identity.ts'

/** Seal one value exactly the way the desktop client does. */
function seal(key: Buffer, plaintext: string | Buffer, framing: 'file' | 'field' = 'field'): unknown {
  const keyId = deriveKeyId(key)
  const suite = 1
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(associatedData(keyId, suite, framing))
  const ciphertext = Buffer.concat([
    cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  const envelope = JSON.stringify({
    suite,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  })
  return { $wbEncrypted: 1, envelope: Buffer.from(envelope, 'utf8').toString('base64') }
}

const SECRET = 'A'.repeat(43) + '='
const KEY = createHash('sha256').update(SECRET, 'ascii').digest()

afterEach(() => {
  setActiveAtRestKey(null)
})

describe('at-rest envelope', () => {
  it('opens a sealed field with the protector key', () => {
    const sealed = seal(KEY, 'token-abc')
    expect(isSealedValue(sealed)).toBe(true)
    expect(openSealedField(KEY, sealed)).toBe('token-abc')
  })

  it('leaves a plaintext value alone', () => {
    expect(openSealedField(KEY, 'plain')).toBe('plain')
    expect(isSealedValue('plain')).toBe(false)
  })

  it('refuses a different key by its key id before any GCM work', () => {
    const sealed = seal(KEY, 'token-abc')
    const other = createHash('sha256').update('B'.repeat(43) + '=', 'ascii').digest()
    expect(() => openSealedField(other, sealed)).toThrow(AtRestError)
  })

  it('accepts both pasted spellings of the same key', () => {
    expect(parseKeyText(SECRET).toString('hex')).toBe(KEY.toString('hex'))
    expect(parseKeyText(KEY.toString('hex')).toString('hex')).toBe(KEY.toString('hex'))
    expect(() => parseKeyText('nonsense')).toThrow(AtRestError)
  })

  it('rejects a key the client keyblob does not own', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wb-atrest-'))
    try {
      const master = randomBytes(32)
      const blob = {
        keyId: deriveKeyId(master),
        slots: [{ type: 'static-v1', protectorKeyId: deriveKeyId(KEY), wrapped: seal(KEY, master, 'file') }],
      }
      await writeFile(path.join(dir, 'keyblob'), JSON.stringify(blob), 'utf8')
      process.env.WORKBUDDY_CONFIG_DIR = dir
      await expect(verifyKeyAgainstKeyBlob(KEY)).resolves.toBe(true)
      const other = createHash('sha256').update('C'.repeat(43) + '=', 'ascii').digest()
      await expect(verifyKeyAgainstKeyBlob(other)).rejects.toThrow(AtRestError)
    } finally {
      delete process.env.WORKBUDDY_CONFIG_DIR
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('sealed credential adoption', () => {
  const file = (): unknown => ({
    auth: {
      accessToken: seal(KEY, 'access-1'),
      refreshToken: seal(KEY, 'refresh-1'),
      domain: 'www.workbuddy.ai',
      expiresAt: Date.now() + 86_400_000,
    },
    account: { uid: 'uid-1', nickname: 'tester' },
  })

  it('parses a sealed file instead of rejecting it', () => {
    const parsed = parseCredentialFile(file(), '/tmp/workbuddy-desktop.info')
    expect(parsed.accessToken).toBe('')
    expect(parsed.sealed?.accessToken).toBeDefined()
    expect(parsed.uid).toBe('uid-1')
  })

  it('skips a sealed credential while no key is held', () => {
    setActiveAtRestKey(null)
    expect(unsealCredentials(parseCredentialFile(file(), '/tmp/a.info'))).toBeNull()
  })

  it('opens a sealed credential once the key is installed', () => {
    setActiveAtRestKey(KEY)
    const opened = unsealCredentials(parseCredentialFile(file(), '/tmp/a.info'))
    expect(opened?.accessToken).toBe('access-1')
    expect(opened?.refreshToken).toBe('refresh-1')
    expect(opened?.sealed).toBeUndefined()
  })
})

describe('printed tool-call recovery', () => {
  const fullWidth = '<||DSML|| calls><||DSML|| invoke name="run_code"><||DSML|| parameter name="code">print(1)</||DSML|| parameter></||DSML|| invoke></||DSML|| calls>'

  it('recovers the full-width DSML spelling', () => {
    const recovered = parseDsmlToolCalls(`before ${fullWidth} after`)
    expect(recovered?.calls).toHaveLength(1)
    expect(recovered?.calls[0]?.name).toBe('run_code')
    expect(JSON.parse(recovered!.calls[0]!.arguments)).toEqual({ code: 'print(1)' })
    expect(recovered?.clean).toBe('before after')
  })

  it('recovers the hybrid spelling the model mixes on its own', () => {
    const hybrid = '<run_code><parameter name="code">1+1</parameter>'
      + '<parameter name="description">adds</|DSML| parameter></run_code></invoke></|DSML| calls>'
    const recovered = parseLeakedToolCalls(hybrid)
    expect(recovered?.calls).toHaveLength(1)
    expect(recovered?.calls[0]?.name).toBe('run_code')
    expect(JSON.parse(recovered!.calls[0]!.arguments)).toEqual({ code: '1+1', description: 'adds' })
    expect(recovered?.clean).toBe('')
  })

  it('leaves ordinary prose alone', () => {
    expect(recoverPrintedToolCalls('hello <world>')).toBeNull()
    expect(recoverPrintedToolCalls('no markup here')).toBeNull()
  })

  it('holds text back only from a tag that could still become a call', () => {
    expect(printedCallHoldIndex('plain prose')).toBe(-1)
    expect(printedCallHoldIndex('ok <par')).toBe(3)
    expect(printedCallHoldIndex('ok <run_code>')).toBe(3)
    expect(printedCallHoldIndex('a < b')).toBe(-1)
    expect(printedCallLooksComplete('<run_code><parameter name="x">1</parameter></run_code>')).toBe(true)
    expect(printedCallLooksComplete('<run_code><parameter name="x">1')).toBe(false)
  })
})

describe('outbound identity', () => {
  it('keeps the shipped cli identity free of overrides', () => {
    const identity = outboundIdentity('cli', 'intl', 'uid-1')
    expect(identity.userAgent).toBe('CLI/2.63.2 CodeBuddy/2.63.2')
    expect(identity.headers({ 'X-Conversation-Request-ID': 'abc' })).toEqual({})
  })

  it('gives the desktop identity its captured user agent and headers', () => {
    const identity = outboundIdentity('workbuddy', 'intl', 'uid-1')
    expect(identity.userAgent).toBe('WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0')
    const headers = identity.headers({ 'X-Conversation-Request-ID': 'abc' })
    expect(headers['X-IDE-Type']).toBe('WorkBuddy')
    expect(headers['X-Root-Request-ID']).toBe('abc')
    expect(headers['X-Machine-ID']).toBe(deriveMachineId('uid-1'))
  })

  it('assigns auto stably per account and scatters across products', () => {
    expect(resolveOutboundProduct('auto', 'uid-1')).toBe(resolveOutboundProduct('auto', 'uid-1'))
    const seen = new Set(['uid-1', 'uid-2', 'uid-3', 'uid-4', 'uid-5', 'uid-6'].map((uid) => resolveOutboundProduct('auto', uid)))
    expect(seen.size).toBeGreaterThan(1)
    expect(resolveOutboundProduct('vscode', 'uid-1')).toBe('vscode')
  })

  it('normalises an unknown preference back to the shipped default', () => {
    expect(normalizeOutboundSetting('workbuddy')).toBe('workbuddy')
    expect(normalizeOutboundSetting('nope')).toBe('cli')
    expect(normalizeOutboundSetting(undefined)).toBe('cli')
  })

  it('derives a stable UUID-shaped machine id per account', () => {
    expect(deriveMachineId('uid-1')).toBe(deriveMachineId('uid-1'))
    expect(deriveMachineId('uid-1')).not.toBe(deriveMachineId('uid-2'))
    expect(deriveMachineId('uid-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
