import { spawn } from 'node:child_process'
import type { TokenStore, StoredOAuthCredentials } from './token-store.ts'
import { parseStoredCredentials } from './token-store.ts'

const DEFAULT_SERVICE = 'dsh-chatgpt-subscription'
const DEFAULT_ACCOUNT = 'oauth'

/**
 * macOS credential storage backed by the login Keychain through the built-in
 * `security` command-line tool. The payload is encrypted at rest by the
 * Keychain, so this store reports itself as encrypted like Windows DPAPI.
 */
export class MacKeychainTokenStore implements TokenStore {
  readonly storage = { kind: 'macos-keychain', encrypted: true } as const

  constructor(
    private readonly service = DEFAULT_SERVICE,
    private readonly account = DEFAULT_ACCOUNT,
  ) {
    if (process.platform !== 'darwin') throw new Error('macOS Keychain storage requires macOS')
  }

  async load(): Promise<StoredOAuthCredentials | null> {
    const result = await runSecurity(['find-generic-password', '-a', this.account, '-s', this.service, '-w'])
    if (result.code === 44) return null
    if (result.code !== 0) throw new Error('Keychain credential read failed')
    try {
      const payload = result.stdout.replace(/\r?\n$/, '')
      return parseStoredCredentials(JSON.parse(payload) as unknown)
    } catch {
      throw new Error('Keychain credential payload is invalid')
    }
  }

  async save(value: StoredOAuthCredentials): Promise<void> {
    const result = await runSecurity(['add-generic-password', '-a', this.account, '-s', this.service, '-w', JSON.stringify(value), '-U'])
    if (result.code !== 0) throw new Error('Keychain credential write failed')
  }

  async clear(): Promise<void> {
    const result = await runSecurity(['delete-generic-password', '-a', this.account, '-s', this.service])
    if (result.code !== 0 && result.code !== 44) throw new Error('Keychain credential deletion failed')
  }
}

interface ProcessResult {
  code: number
  stdout: string
}

function runSecurity(args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('security', args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderrLength = 0
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Keychain helper timed out'))
    }, 10_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 1 << 20) child.kill()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrLength += chunk.length
      if (stderrLength > 1 << 20) child.kill()
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout })
    })
  })
}
