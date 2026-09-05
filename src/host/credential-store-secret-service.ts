import { spawn } from 'node:child_process'
import type { CredentialStore } from './token-store.ts'

const UNAVAILABLE = 'Linux encrypted credential storage requires secret-tool (libsecret) and an unlocked Secret Service keyring.'

/** Secrets travel over stdin/stdout; command arguments contain only lookup attributes. */
export class SecretServiceCredentialStore<T> implements CredentialStore<T> {
  constructor(
    private readonly service: string,
    private readonly account: string,
    private readonly parse: (value: unknown) => T,
  ) {}

  private attributes(): string[] {
    return ['service', this.service, 'account', this.account]
  }

  async load(): Promise<T | null> {
    const result = await runSecretTool(['lookup', ...this.attributes()])
    if (result.code === 1 && !result.hasStderr && result.stdout === '') return null
    if (result.code !== 0) throw new Error(UNAVAILABLE)
    try {
      return this.parse(JSON.parse(result.stdout) as unknown)
    } catch {
      throw new Error('Secret Service credential payload is invalid')
    }
  }

  async save(value: T): Promise<void> {
    const payload = JSON.stringify(value)
    // secret-tool's stdin reader is limited to 8192 bytes.
    if (Buffer.byteLength(payload, 'utf8') >= 8192) throw new Error('Secret Service credential payload is too large')
    const result = await runSecretTool(['store', '--label=DSH Antigravity OAuth', ...this.attributes()], payload)
    if (result.code !== 0) throw new Error(UNAVAILABLE)
  }

  async clear(): Promise<void> {
    const result = await runSecretTool(['clear', ...this.attributes()])
    if (result.code !== 0 && !(result.code === 1 && !result.hasStderr)) throw new Error(UNAVAILABLE)
  }
}

function runSecretTool(args: string[], stdin = ''): Promise<{ code: number; stdout: string; hasStderr: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('secret-tool', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderrLength = 0
    let settled = false
    const fail = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      reject(new Error(UNAVAILABLE))
    }
    const timer = setTimeout(fail, 10_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 1 << 20) fail()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrLength += chunk.length
      if (stderrLength > 1 << 20) fail()
    })
    child.once('error', fail)
    child.stdin.once('error', fail)
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, hasStderr: stderrLength > 0 })
    })
    child.stdin.end(stdin)
  })
}
