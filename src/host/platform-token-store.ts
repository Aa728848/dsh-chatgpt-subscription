import type { TokenStore } from './token-store.ts'
import { MacKeychainTokenStore } from './token-store-macos.ts'
import { LinuxFileTokenStore } from './token-store-linux.ts'
import { WindowsDpapiTokenStore } from './token-store-windows.ts'

export function createPlatformTokenStore(platform: NodeJS.Platform = process.platform): TokenStore {
  if (platform === 'win32') return new WindowsDpapiTokenStore()
  if (platform === 'darwin') return new MacKeychainTokenStore()
  if (platform === 'linux') return new LinuxFileTokenStore()
  throw new Error(`Unsupported platform ${platform}; dsh-chatgpt-subscription supports Windows, macOS, and Linux.`)
}
