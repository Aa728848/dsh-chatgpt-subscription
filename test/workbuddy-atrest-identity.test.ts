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
  DEFAULT_OUTBOUND_SETTING,
  LEGACY_OUTBOUND_IDENTITY_VERSION,
  OUTBOUND_IDENTITY_VERSION,
  deriveMachineId,
  migrateOutboundSettingDocument,
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
  it('keeps the pinned cli identity free of overrides', () => {
    const identity = outboundIdentity('cli', 'intl', 'uid-1')
    expect(identity.userAgent).toBe('CLI/2.63.2 CodeBuddy/2.63.2')
    expect(identity.headers({ 'X-Conversation-Request-ID': 'abc' })).toEqual({})
  })

  it('ships an identity whose user agent upstream still accepts', () => {
    // Upstream refuses any agent that is not `WorkBuddy/<version>` with 10085
    // (magpie-community/plugins@1e7122e1 L8-9), which is why the default moved
    // off `cli`. This pins the property, not just the string, so a future
    // re-capture cannot silently reintroduce a refused default.
    expect(DEFAULT_OUTBOUND_SETTING).toBe('workbuddy')
    for (const region of ['cn', 'intl'] as const) {
      const agent = outboundIdentity(DEFAULT_OUTBOUND_SETTING, region, 'uid-1').userAgent
      expect(agent.startsWith('WorkBuddy/')).toBe(true)
      expect(agent.split(' ').length).toBeGreaterThanOrEqual(3)
    }
    expect(outboundIdentity('cli', 'cn', 'uid-1').userAgent.startsWith('WorkBuddy/')).toBe(false)
  })

  it('gives the desktop identity the 5.9.3 build, its bundled CLI and headers', () => {
    const intl = outboundIdentity('workbuddy', 'intl', 'uid-1')
    // Source: magpie-community/plugins@1e7122e1 packages/workbuddy/index.mjs
    // L88-103 (app 5.9.3 / cli 2.165.0 / appName workbuddy-ai) and L344-351
    // (`cliAgent` builds `WorkBuddy/<app> <appName>/<app> CLI/<cli>`).
    expect(intl.userAgent).toBe('WorkBuddy/5.9.3 workbuddy-ai/5.9.3 CLI/2.165.0')
    const cn = outboundIdentity('workbuddy', 'cn', 'uid-1')
    expect(cn.userAgent).toBe('WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0')

    const headers = intl.headers({ 'X-Conversation-Request-ID': 'abc' })
    expect(headers['X-IDE-Type']).toBe('WorkBuddy')
    expect(headers['X-IDE-Name']).toBe('WorkBuddy')
    expect(headers['X-IDE-Version']).toBe('5.9.3')
    expect(headers['X-Agent-Intent']).toBe('craft')
    expect(headers['X-Agent-Purpose']).toBe('conversation')
    expect(headers['X-Agent-Type']).toBe('main')
    // 5.9 says where the agent runs; 5.8 sent no such header at all.
    expect(headers['X-Agent-Runtime']).toBe('local-agent')
    expect(headers['X-Root-Request-ID']).toBe('abc')
    expect(headers['X-Machine-ID']).toBe(deriveMachineId('uid-1'))
    // The OpenAI SDK fingerprint the bundled CLI's fetch passes on (L353-380).
    expect(headers['X-Stainless-Package-Version']).toBe('6.25.0')
    expect(headers['X-Stainless-Runtime-Version']).toBe('v22.21.1')
    expect(headers['X-Stainless-Retry-Count']).toBe('0')
    // Nothing here may ever claim a device token: that half of the identity is
    // the desktop client's own secret and this route does not forge it.
    const claimed = Object.keys(headers).map((key) => key.toLowerCase())
    expect(claimed.filter((key) => key.includes('device-token'))).toEqual([])
  })

  it('assigns auto stably per account and scatters across products', () => {
    expect(resolveOutboundProduct('auto', 'uid-1')).toBe(resolveOutboundProduct('auto', 'uid-1'))
    const seen = new Set(['uid-1', 'uid-2', 'uid-3', 'uid-4', 'uid-5', 'uid-6'].map((uid) => resolveOutboundProduct('auto', uid)))
    expect(seen.size).toBeGreaterThan(1)
    expect(resolveOutboundProduct('vscode', 'uid-1')).toBe('vscode')
  })

  it('normalises an unknown preference back to the shipped default', () => {
    expect(normalizeOutboundSetting('workbuddy')).toBe('workbuddy')
    expect(normalizeOutboundSetting('vscode')).toBe('vscode')
    expect(normalizeOutboundSetting('nope')).toBe(DEFAULT_OUTBOUND_SETTING)
    expect(normalizeOutboundSetting(undefined)).toBe(DEFAULT_OUTBOUND_SETTING)
  })

  it('derives a stable UUID-shaped machine id per account', () => {
    expect(deriveMachineId('uid-1')).toBe(deriveMachineId('uid-1'))
    expect(deriveMachineId('uid-1')).not.toBe(deriveMachineId('uid-2'))
    expect(deriveMachineId('uid-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('outbound identity migration', () => {
  it('moves a pre-marker document off the refused cli default', () => {
    const migrated = migrateOutboundSettingDocument({ outboundIdentity: 'cli' })
    expect(migrated.outboundIdentity).toBe('workbuddy')
    expect(migrated.outboundIdentityVersion).toBe(OUTBOUND_IDENTITY_VERSION)
    expect(migrated.migrated).toBe(true)
  })

  it('treats an absent preference as the same legacy default', () => {
    const migrated = migrateOutboundSettingDocument({})
    expect(migrated.outboundIdentity).toBe(DEFAULT_OUTBOUND_SETTING)
    expect(migrated.migrated).toBe(true)
  })

  it('keeps an explicit identity and only stamps the marker', () => {
    for (const value of ['auto', 'workbuddy', 'vscode']) {
      const migrated = migrateOutboundSettingDocument({ outboundIdentity: value })
      expect(migrated.outboundIdentity).toBe(value)
      expect(migrated.outboundIdentityVersion).toBe(OUTBOUND_IDENTITY_VERSION)
      expect(migrated.migrated).toBe(true)
    }
  })

  it('is idempotent over its own output', () => {
    const once = migrateOutboundSettingDocument({ outboundIdentity: 'cli' })
    const twice = migrateOutboundSettingDocument({
      outboundIdentity: once.outboundIdentity,
      outboundIdentityVersion: once.outboundIdentityVersion,
    })
    expect(twice.outboundIdentity).toBe(once.outboundIdentity)
    expect(twice.migrated).toBe(false)
    expect(twice.outboundIdentityVersion).toBe(OUTBOUND_IDENTITY_VERSION)
  })

  it('never flips a cli pinned after the migration', () => {
    // The marker is what distinguishes "the old default" from "a choice made
    // since". Without this, every read would migrate a deliberate pin again.
    const pinned = migrateOutboundSettingDocument({
      outboundIdentity: 'cli',
      outboundIdentityVersion: OUTBOUND_IDENTITY_VERSION,
    })
    expect(pinned.outboundIdentity).toBe('cli')
    expect(pinned.migrated).toBe(false)
  })

  it('reads an absent marker as the legacy version, never the current one', () => {
    // A schema that defaulted the marker to the CURRENT version would declare
    // every stale document already migrated; this pins the direction.
    expect(LEGACY_OUTBOUND_IDENTITY_VERSION).toBeLessThan(OUTBOUND_IDENTITY_VERSION)
    expect(migrateOutboundSettingDocument({ outboundIdentity: 'cli', outboundIdentityVersion: undefined }).outboundIdentity)
      .toBe('workbuddy')
  })

  it('normalises an unreadable preference to the shipped default', () => {
    expect(migrateOutboundSettingDocument({ outboundIdentity: 'nonsense' }).outboundIdentity)
      .toBe(DEFAULT_OUTBOUND_SETTING)
  })
})
