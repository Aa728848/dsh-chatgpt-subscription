/**
 * Sign-in for the Antigravity (ACP) line.
 *
 * This line owns no credentials. The official `agy` process signs itself in,
 * stores its own token in its own store, and refreshes it on its own schedule;
 * what this module can do is *start* that sign-in and *ask* whether it worked.
 *
 * Two consequences follow, and they are the whole design:
 *
 * - **The browser is opened exactly once.** `agy acp --login` opens it. A host
 *   that also opened the authorize URL would show two identical Google pages for
 *   one click - the bug this repository has already paid for once on three other
 *   lines. So nothing here calls `openBrowser`.
 * - **"Signed in" is a probe, not a flag.** There is no local state to read: the
 *   only truthful answer comes from asking the agent to create a session, which
 *   is what {@link probeAuth} does. A failed probe is reported as "not signed in",
 *   never as a stale cached "yes".
 *
 * @module dsh-chatgpt-subscription/host/antigravity-acp/login
 */

import { spawn } from 'node:child_process'
import type { AcpClient } from './acp-client.ts'
import type { AcpLaunch } from './adapter.ts'
import type { AntigravityAcpAuthDto } from '../../shared/antigravity-acp-contracts.ts'

/** How long the login launcher may run before it is considered detached. */
export const LOGIN_LAUNCH_BUDGET_MS = 10_000

/**
 * How long a launcher is watched for a start-up failure before it is left alone.
 *
 * A successful sign-in keeps the process alive until the browser callback lands,
 * so this may not wait for the exit: it only has to catch the failures that
 * happen before the CLI ever gets going - an executable that cannot be spawned,
 * or a command line the CLI rejects.
 */
export const LOGIN_FAILURE_WINDOW_MS = 1_000

/** Most stderr kept for that failure sentence; a login banner is not a diagnostic. */
const LOGIN_STDERR_CAP = 2_000

/** Budget for one auth probe. */
export const AUTH_PROBE_BUDGET_MS = 30_000

/** What starting a sign-in produced. */
export interface LoginStartResult {
  /** True when a sign-in process was started. */
  started: boolean
  /** Why it could not start, when it could not. */
  error?: string
}

/**
 * Start the official sign-in.
 *
 * The process is spawned detached: on a desktop it opens the browser and exits
 * once the callback lands, on a headless host it prints the URL it would have
 * opened. Either way this call never waits for the user.
 *
 * What it *does* wait for is the failure that happens before the CLI gets going.
 * The command line is `agy acp --login`, and a rejected command line, a
 * misconfigured path or a binary that cannot be spawned all exit (or error)
 * within milliseconds - and the previous version reported "sign-in started" for
 * every one of them while discarding the only sentence that explained it. The
 * launcher is therefore watched for {@link LOGIN_FAILURE_WINDOW_MS}: a spawn
 * error, or a non-zero exit that left stderr behind, is returned as the reason.
 *
 * @param launch - The resolved executable.
 * @returns whether a process was started, and why it was not.
 */
export function startLogin(launch: AcpLaunch): Promise<LoginStartResult> {
  let child: ReturnType<typeof spawn>
  try {
    // `launch.args` already selects ACP stdio mode (`acp`, plus any flags), and
    // `--login` is a flag of that same subcommand: appending it to the args is the
    // whole command. Building it by slicing the last arg and re-adding `acp` sent
    // `acp acp --login`, which the CLI rejects.
    child = spawn(launch.command, [...launch.args, '--login'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    return Promise.resolve({ started: false, error: error instanceof Error ? error.message : String(error) })
  }
  return watchLauncher(child)
}

/**
 * Watch one launcher through its start-up window.
 *
 * @param child - The detached sign-in process.
 * @returns whether it started, and the CLI's own explanation when it did not.
 */
function watchLauncher(child: ReturnType<typeof spawn>): Promise<LoginStartResult> {
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < LOGIN_STDERR_CAP) stderr += chunk.slice(0, LOGIN_STDERR_CAP - stderr.length)
  })
  // The buffer is bounded above; this keeps a chatty launcher from holding the
  // event loop open once the answer has already been given.
  child.unref()

  return new Promise<LoginStartResult>((resolve) => {
    let settled = false
    const settle = (result: LoginStartResult): void => {
      if (settled) return
      settled = true
      clearTimeout(windowTimer)
      clearTimeout(detachTimer)
      resolve(result)
    }
    const detail = (): string => stderr.trim().split(/\r?\n/u).filter((line) => line !== '').slice(-3).join(' ')
    const failed = (reason: string): LoginStartResult => ({
      started: false,
      error: detail() === '' ? reason : reason + ': ' + detail(),
    })

    const windowTimer = setTimeout(() => settle({ started: true }), LOGIN_FAILURE_WINDOW_MS)
    windowTimer.unref?.()
    // Whatever happens after the window belongs to the CLI: it may sit there
    // waiting for the browser for as long as the user takes.
    const detachTimer = setTimeout(() => {
      child.stderr?.removeAllListeners('data')
      child.removeAllListeners()
    }, LOGIN_LAUNCH_BUDGET_MS)
    detachTimer.unref?.()

    child.once('error', (error: Error) => settle(failed(error.message)))
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0 || signal !== null) {
        // A launcher that exited cleanly (headless hosts print the URL and stop)
        // or was killed by the user did what it was asked to do.
        settle({ started: true })
        return
      }
      settle(failed(`The Antigravity CLI exited with code ${String(code ?? 'null')} before sign-in began.`))
    })
  })
}

/**
 * Ask the agent whether it currently holds usable credentials.
 *
 * A session is created and immediately abandoned: that is the smallest request
 * that exercises the whole credential path (the server needs the account to build
 * a session, including its model list and tier).
 *
 * @param client - A freshly spawned client.
 * @param signal - Cancellation.
 * @returns The auth state and, when signed in, the tier the server reported.
 */
export async function probeAuth(client: AcpClient, signal?: AbortSignal): Promise<AntigravityAcpAuthDto> {
  try {
    const init = asRecord(await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'dsh-chatgpt-subscription', version: '1.0.0' },
    }, signal))
    const authMethods = Array.isArray(init?.authMethods)
      ? init.authMethods
        .map((entry) => String((entry as Record<string, unknown>).id ?? ''))
        .filter((id) => id !== '')
      : []
    const session = asRecord(await client.request('session/new', { cwd: process.cwd(), mcpServers: [] }, signal))
    if (session === undefined) return { authenticated: false }
    const tier = readTier(session._meta)
    return {
      authenticated: true,
      ...(authMethods.includes('oauth-personal') ? { method: 'oauth-personal' } : {}),
      ...(tier === undefined ? {} : { tier }),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/authentication required/i.test(message) || (error as { code?: number }).code === -32000) {
      return { authenticated: false }
    }
    // A transport failure is not evidence about credentials at all.
    return { authenticated: false }
  }
}

function readTier(meta: unknown): { id: string; name: string } | undefined {
  const antigravity = asRecord(asRecord(meta)?.antigravity)
  const tier = asRecord(antigravity?.tier)
  if (tier === undefined) return undefined
  const id = typeof tier.id === 'string' ? tier.id : undefined
  const name = typeof tier.name === 'string' ? tier.name : undefined
  if (id === undefined || name === undefined) return undefined
  return { id, name }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
