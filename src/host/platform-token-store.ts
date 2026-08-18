import type { TokenStore } from './token-store.ts'
import { LinuxFileTokenStore } from './token-store-linux.ts'
import { WindowsDpapiTokenStore } from './token-store-windows.ts'

export function createPlatformTokenStore(
  platform: NodeJS.Platform = process.platform,
  namespace: 'codex' | 'providers' = 'codex',
): TokenStore {
  if (platform === 'win32') return new WindowsDpapiTokenStore(undefined, namespace)
  if (platform === 'linux') return new LinuxFileTokenStore(undefined, namespace)
  throw new Error(`Unsupported platform ${platform}; dsh-chatgpt-subscription supports Windows and Linux.`)
}
