/**
 * One follow-up poll after a status answer that carried a background refresh.
 *
 * The host answers a status card from the snapshot it already has and refreshes
 * the quota behind that answer, so a tab renders immediately instead of waiting
 * on the upstream request. The refreshed numbers would otherwise only appear on
 * the next 60 s poll, so an answer that reports a refresh in flight schedules
 * one short follow-up.
 *
 * The chain is bounded. A refresh that keeps failing leaves the snapshot aged,
 * so every answer would keep asking for a follow-up; after a few consecutive
 * attempts the surface falls back to its ordinary polling and stops hammering
 * the host.
 */

const FOLLOW_UP_DELAY_MS = 1_500
const MAX_ATTEMPTS = 3

export interface QuotaFollowUp {
  /**
   * Record one status answer.
   *
   * @param refreshing - whether the host reported a refresh behind this answer.
   * @param reload - how to ask again; used only when a follow-up is owed.
   */
  observe(refreshing: boolean, reload: () => void): void
  /** Drop any pending follow-up; call when the surface unmounts. */
  cancel(): void
}

export function createQuotaFollowUp(
  options: { delayMs?: number; maxAttempts?: number } = {},
): QuotaFollowUp {
  const delayMs = options.delayMs ?? FOLLOW_UP_DELAY_MS
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  return {
    observe(refreshing: boolean, reload: () => void): void {
      if (!refreshing) {
        // A settled answer ends the chain, so the next stale answer starts fresh.
        attempts = 0
        return
      }
      // One follow-up at a time: a poll landing while one is pending must not
      // stack another.
      if (timer !== undefined || attempts >= maxAttempts) return
      attempts += 1
      timer = setTimeout(() => {
        timer = undefined
        reload()
      }, delayMs)
    },
    cancel(): void {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      attempts = 0
    },
  }
}