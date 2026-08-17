import { describe, expect, it } from 'vitest'
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

  it('rejects unsupported platforms', () => {
    expect(() => createPlatformTokenStore('darwin')).toThrow('supports Windows and Linux')
  })
})
