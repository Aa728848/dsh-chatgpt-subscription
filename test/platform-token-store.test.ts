import { describe, expect, it } from 'vitest'
import { MacKeychainTokenStore } from '../src/host/token-store-macos.ts'
import { LinuxFileTokenStore } from '../src/host/token-store-linux.ts'
import { WindowsDpapiTokenStore } from '../src/host/token-store-windows.ts'
import { createPlatformTokenStore } from '../src/host/platform-token-store.ts'

describe('createPlatformTokenStore', () => {
  it.skipIf(process.platform !== 'linux')('selects the Linux store', () => {
    expect(createPlatformTokenStore('linux')).toBeInstanceOf(LinuxFileTokenStore)
  })

  it.skipIf(process.platform !== 'win32')('selects the Windows DPAPI store', () => {
    expect(createPlatformTokenStore('win32')).toBeInstanceOf(WindowsDpapiTokenStore)
  })

  it.skipIf(process.platform !== 'darwin')('selects the macOS Keychain store', () => {
    expect(createPlatformTokenStore('darwin')).toBeInstanceOf(MacKeychainTokenStore)
  })

  it('rejects unsupported platforms', () => {
    expect(() => createPlatformTokenStore('freebsd')).toThrow('supports Windows, macOS, and Linux')
  })
})
