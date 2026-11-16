import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLogin } from '../src/host/antigravity-acp/login.ts'

function workspace(): { dir: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'acp-login-test-'))
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

const OAUTH_SERVER = [
  "import { appendFileSync } from 'node:fs'",
  'const log = process.argv[2]',
  "let buffer = ''",
  "process.stdin.on('data', (chunk) => {",
  '  buffer += chunk.toString()',
  '  let index',
  "  while ((index = buffer.indexOf('\\n')) >= 0) {",
  '    const line = buffer.slice(0, index)',
  '    buffer = buffer.slice(index + 1)',
  "    if (line === '') continue",
  '    const message = JSON.parse(line)',
  "    appendFileSync(log, JSON.stringify(message) + '\\n')",
  "    if (message.method === 'initialize') {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal' }] } }) + '\\n')",
  "    } else if (message.method === 'authenticate') {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n')",
  '    }',
  '  }',
  '})',
  "process.stdin.on('end', () => process.exit(0))",
].join('\n')

const PENDING_OAUTH_SERVER = OAUTH_SERVER.replace(
  "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n')",
  "setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n'), 2500)",
)

const TERMINAL_SERVER = [
  "import { writeFileSync } from 'node:fs'",
  "if (process.argv.includes('--login')) {",
  "  writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))",
  '  process.exit(0)',
  '}',
  OAUTH_SERVER.replace("authMethods: [{ id: 'oauth-personal' }]", "authMethods: [{ id: 'terminal-login', type: 'terminal' }]"),
].join('\n')

describe('startLogin', () => {
  it('uses the advertised OAuth method over ACP', async () => {
    const space = workspace()
    try {
      const script = join(space.dir, 'server.mjs')
      const log = join(space.dir, 'requests.ndjson')
      writeFileSync(script, OAUTH_SERVER, 'utf8')
      const result = await startLogin({ command: process.execPath, args: [script, log] })
      expect(result).toEqual({ started: true })
      const requests = readFileSync(log, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line))
      expect(requests.map((request) => request.method)).toEqual(['initialize', 'authenticate'])
      expect(requests[1].params).toEqual({ methodId: 'oauth-personal' })
    } finally {
      space.dispose()
    }
  })

  it('returns while the browser authorization is still pending', async () => {
    const space = workspace()
    try {
      const script = join(space.dir, 'server.mjs')
      const log = join(space.dir, 'requests.ndjson')
      writeFileSync(script, PENDING_OAUTH_SERVER, 'utf8')
      const startedAt = Date.now()
      const result = await startLogin({ command: process.execPath, args: [script, log] })
      expect(result.started).toBe(true)
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      await new Promise((resolve) => setTimeout(resolve, 1_800))
    } finally {
      space.dispose()
    }
  }, 10_000)

  it('falls back to agy acp --login only for terminal authentication', async () => {
    const space = workspace()
    try {
      const script = join(space.dir, 'server.mjs')
      const log = join(space.dir, 'args.json')
      writeFileSync(script, TERMINAL_SERVER, 'utf8')
      const result = await startLogin({
        command: process.execPath,
        args: [script, log, 'acp', '--disable-telemetry'],
      })
      expect(result.started).toBe(true)
      const args = JSON.parse(readFileSync(log, 'utf8')) as string[]
      expect(args).toEqual(['acp', '--disable-telemetry', '--login'])
    } finally {
      space.dispose()
    }
  })

  it('reports why the server failed instead of claiming sign-in started', async () => {
    const space = workspace()
    try {
      const script = join(space.dir, 'server.mjs')
      writeFileSync(script, "process.stderr.write('unsupported flag'); process.exit(3)", 'utf8')
      const result = await startLogin({ command: process.execPath, args: [script] })
      expect(result.started).toBe(false)
      expect(result.error).toContain('code 3')
    } finally {
      space.dispose()
    }
  })
})
