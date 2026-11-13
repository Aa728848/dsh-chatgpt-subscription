/**
 * A cached answer to "is the agent signed in?".
 *
 * The only truthful way to answer that question is to ask the agent - there is
 * no local state this plugin may read - and asking costs a whole process spawn
 * plus a session creation. The settings card polls, the hub overview polls, and
 * every one of those reads used to spawn its own process: three cards on one
 * screen meant three `agy` launches, and the slowest one decided when the page
 * rendered.
 *
 * So the answer is cached for a short window. The window is short because a user
 * who just signed in must not have to wait a minute to see it; it is non-zero
 * because a poll must not be a process launch. `login/start` and the explicit
 * refresh route invalidate it, which is exactly when the answer is known to have
 * changed.
 *
 * @module dsh-chatgpt-subscription/host/antigravity-acp/auth-cache
 */

import type { AntigravityAcpAuthDto } from '../../shared/antigravity-acp-contracts.ts'

/** How long one probe answers for. */
export const AUTH_CACHE_TTL_MS = 60_000

/** The cache itself. */
export class AcpAuthCache {
  private value: AntigravityAcpAuthDto | undefined
  private fetchedAt = 0
  private inflight: Promise<AntigravityAcpAuthDto> | undefined

  /**
   * @param probe - Reads the real state; called at most once per window.
   * @param now - Clock seam.
   * @param ttlMs - How long one answer stays valid.
   */
  constructor(
    private readonly probe: () => Promise<AntigravityAcpAuthDto>,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = AUTH_CACHE_TTL_MS,
  ) {}

  /** The cached answer, when one is still valid. */
  peek(): AntigravityAcpAuthDto | undefined {
    if (this.value === undefined) return undefined
    return this.now() - this.fetchedAt < this.ttlMs ? this.value : undefined
  }

  /**
   * Read the state, reusing a valid answer or one in-flight probe.
   *
   * @param options - `force` bypasses the window (after a sign-in, after a refresh click).
   * @returns The auth state; a failed probe answers "not signed in" rather than throwing.
   */
  async read(options: { force?: boolean } = {}): Promise<AntigravityAcpAuthDto> {
    if (options.force !== true) {
      const cached = this.peek()
      if (cached !== undefined) return cached
    }
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.probe()
      .catch((): AntigravityAcpAuthDto => ({ authenticated: false }))
      .then((value) => {
        this.value = value
        this.fetchedAt = this.now()
        return value
      })
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /** Forget the answer, e.g. because a sign-in was just started. */
  invalidate(): void {
    this.value = undefined
    this.fetchedAt = 0
  }
}
