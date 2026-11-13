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
 * The process is spawned detached and its stdout/stderr are drained: on a desktop
 * it opens the browser and exits once the callback lands, on a headless host it
 * prints the URL it would have opened. Either way this call returns as soon as
 * the process exists - it never waits for the user.
 *
 * @param launch - The resolved executable.
 * @returns whether a process was started.
 */
export function startLogin(launch: AcpLaunch): LoginStartResult {
  try {
    const child = spawn(launch.command, [...launch.args.slice(0, -1), 'acp', '--login'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    child.stderr?.resume()
    child.unref()
    return { started: true }
  } catch (error) {
    return { started: false, error: error instanceof Error ? error.message : String(error) }
  }
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
