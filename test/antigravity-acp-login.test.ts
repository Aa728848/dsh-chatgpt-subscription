/**
 * Starting the official sign-in.
 *
 * Two things are pinned here, and both were silently wrong before:
 *
 * - the command line. `launch.args` already selects ACP stdio mode, so the login
 *   flag is appended to it; the old code rebuilt the array as `slice(0, -1) + acp
 *   + --login`, which sent `acp acp --login` to a CLI that accepts one.
 * - the failure. The launcher used to answer "started" for a rejected command
 *   line, a missing executable and a crashed CLI alike, with stderr discarded.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLogin } from '../src/host/antigravity-acp/login.ts'

function workspace(): { dir: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'acp-login-test-'))
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A launcher that records the arguments the CLI was actually given, then exits. */
const ECHO_ARGS = [
  "import { writeFileSync } from 'node:fs'",
  "writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))",
].join('\n')

/** A launcher that fails the way a rejected command line does. */
const REJECT_ARGS = [
  "process.stderr.write('error: unexpected argument acp')",
  'process.exit(3)',
].join('\n')

describe('startLogin', () => {
  it('passes exactly one ACP selector and appends the login flag', async () => {
    const space = workspace()
    try {
      const script = join(space.dir, 'launcher.mjs')
      const log = join(space.dir, 'args.json')
      writeFileSync(script, ECHO_ARGS, 'utf8')
      const result = await startLogin({
        command: process.execPath,
        args: [script, log, 'acp', '--disable-telemetry'],
      })
      expect(result.started).toBe(true)
      const args = JSON.parse(readFileSync(log, 'utf8')) as string[]
      expect(args.filter((arg) => arg === 'acp')).toHaveLength(1)
      expect(args.at(-1)).toBe('--login')
      expect(args).toEqual(['acp', '--disable-telemetry', '--login'])
    } finally {
      space.dispose()
    }
  })

  it('reports why a launcher failed instead of claiming it started', async () => {
    const space = workspace()
    try {
      const script = join(space.dir, 'launcher.mjs')
      writeFileSync(script, REJECT_ARGS, 'utf8')
      const result = await startLogin({ command: process.execPath, args: [script] })
      expect(result.started).toBe(false)
      expect(result.error).toContain('unexpected argument acp')
      expect(result.error).toContain('exited with code 3')
    } finally {
      space.dispose()
    }
  })

  it('returns as soon as the launcher is up rather than waiting for the browser', async () => {
    const space = workspace()
    try {
      const script = join(space.dir, 'launcher.mjs')
      // A real sign-in sits here until the browser callback lands.
      writeFileSync(script, 'setTimeout(() => process.exit(0), 2500)', 'utf8')
      const startedAt = Date.now()
      const result = await startLogin({ command: process.execPath, args: [script] })
      expect(result.started).toBe(true)
      expect(Date.now() - startedAt).toBeLessThan(2_000)
    } finally {
      space.dispose()
    }
  })
})
