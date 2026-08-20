import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { MacKeychainTokenStore } from '../src/host/token-store-macos.ts'

const clearedServices: Array<[string, string]> = []

afterEach(async () => {
  for (const [service, account] of clearedServices.splice(0)) {
    await new MacKeychainTokenStore(service, account).clear().catch(() => undefined)
  }
})

describe.skipIf(process.platform !== 'darwin')('MacKeychainTokenStore', () => {
  it('round-trips credentials through the login Keychain and clears them', async () => {
    const service = `dsh-codex-test-${randomUUID()}`
    const account = `account-${randomUUID()}`
    clearedServices.push([service, account])
    const store = new MacKeychainTokenStore(service, account)
    const credentials = {
      accessToken: 'access-super-secret',
      refreshToken: 'refresh-super-secret',
      expiresAt: Date.now() + 60_000,
      accountId: 'account-id',
    }

    await store.clear()
    expect(await store.load()).toBeNull()
    await store.save(credentials)
    expect(await store.load()).toEqual(credentials)
    await store.clear()
    expect(await store.load()).toBeNull()
  })
})

describe.skipIf(process.platform === 'darwin')('MacKeychainTokenStore on other hosts', () => {
  it('rejects non-macOS hosts', () => {
    expect(() => new MacKeychainTokenStore()).toThrow('requires macOS')
  })
})
