import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import type { TokenStore, StoredOAuthCredentials } from './token-store.ts'
import { parseStoredCredentials } from './token-store.ts'

const PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$path = $env:DSH_CODEX_TOKEN_PATH
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$cipher = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
$directory = [IO.Path]::GetDirectoryName($path)
[IO.Directory]::CreateDirectory($directory) | Out-Null
$temporary = $path + '.tmp-' + [Guid]::NewGuid().ToString('N')
[IO.File]::WriteAllBytes($temporary, $cipher)
if ([IO.File]::Exists($path)) { [IO.File]::Replace($temporary, $path, $null) } else { [IO.File]::Move($temporary, $path) }
`

const UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$path = $env:DSH_CODEX_TOKEN_PATH
if (-not [IO.File]::Exists($path)) { exit 3 }
$cipher = [IO.File]::ReadAllBytes($path)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`

const CLEAR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:DSH_CODEX_TOKEN_PATH
if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
`

export function defaultDpapiCredentialPath(): string {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(dshHome, 'storages', 'dsh-chatgpt-subscription', 'oauth.dpapi')
}

export class WindowsDpapiTokenStore implements TokenStore {
  readonly storage = { kind: 'windows-dpapi', encrypted: true } as const

  constructor(private readonly path = defaultDpapiCredentialPath()) {
    if (process.platform !== 'win32') throw new Error('Windows DPAPI storage requires Windows')
    if (dirname(path) === path) throw new Error('invalid DPAPI credential path')
  }

  async load(): Promise<StoredOAuthCredentials | null> {
    const result = await runPowerShell(UNPROTECT_SCRIPT, this.path, '')
    if (result.code === 3) return null
    if (result.code !== 0) throw new Error('DPAPI credential read failed')
    try {
      return parseStoredCredentials(JSON.parse(result.stdout) as unknown)
    } catch {
      throw new Error('DPAPI credential payload is invalid')
    }
  }

  async save(value: StoredOAuthCredentials): Promise<void> {
    const result = await runPowerShell(PROTECT_SCRIPT, this.path, JSON.stringify(value))
    if (result.code !== 0) throw new Error('DPAPI credential write failed')
  }

  async clear(): Promise<void> {
    const result = await runPowerShell(CLEAR_SCRIPT, this.path, '')
    if (result.code !== 0) throw new Error('DPAPI credential deletion failed')
  }
}

interface ProcessResult {
  code: number
  stdout: string
}

function runPowerShell(script: string, path: string, stdin: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, DSH_CODEX_TOKEN_PATH: path },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderrLength = 0
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('DPAPI helper timed out'))
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
    child.stdin.end(stdin)
  })
}
