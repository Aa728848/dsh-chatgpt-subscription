/**
 * Publish the browser's resolved language to the Host.
 *
 * The Host cannot see the browser: the active language is resolved on this side
 * (an explicit preference, else the browser's own languages) and exists only in
 * the locale runtime. Everything the Host says on its own — a provider name in
 * the model picker, a quota failure, a progress update — is composed far from
 * here, so the resolved value is mirrored once on install and again on every
 * switch.
 *
 * A failed mirror is silent on purpose: an older harness without the route, or
 * a Host that is restarting, must not break a settings page that otherwise
 * renders fine in the default language.
 * @module dsh-chatgpt-subscription/client/host-locale-mirror
 */
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { ROUTE_PREFIX } from '../../compat.ts'
import { normalizeLocale } from '../../shared/i18n-contracts.ts'

/** How long a switch is coalesced for; one locale change can emit more than once. */
const DEBOUNCE_MS = 200

/**
 * Mirror the active locale into the Host, now and on every later switch.
 *
 * @param locale - The plugin context's locale runtime, when the harness has one.
 * @returns Teardown for the subscription; a no-op when there is no runtime.
 */
export function installHostLocaleMirror(locale: LocaleRuntime | undefined): () => void {
  if (locale === undefined || typeof locale.getSnapshot !== 'function') return () => {}

  const activeOf = (): string => {
    try {
      return String(locale.getSnapshot().active ?? '')
    } catch {
      return ''
    }
  }

  let sent: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const push = (): void => {
    if (disposed) return
    const next = normalizeLocale(activeOf())
    // One request per distinct language: a switch that lands on the value the
    // Host already holds would only cost a round trip.
    if (next === sent) return
    sent = next
    void fetch(`${ROUTE_PREFIX}/i18n/locale`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale: next }),
    }).catch(() => {
      // Cleared so the next switch (or the next page load) tries again rather
      // than believing the Host already knows.
      sent = undefined
    })
  }

  const schedule = (): void => {
    if (disposed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; push() }, DEBOUNCE_MS)
  }

  push()
  const unsubscribe = typeof locale.subscribe === 'function' ? locale.subscribe(schedule) : () => {}
  return () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    unsubscribe()
  }
}
