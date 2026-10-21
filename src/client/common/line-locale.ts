/**
 * Locale plumbing shared by the provider detail pages.
 *
 * Every card used to render its `zh` dictionary object directly, which pinned
 * the whole page to Chinese whatever the active locale was: the dictionaries
 * carry a complete English half, but nothing ever asked the locale service for
 * it. A card now renders a dictionary-shaped view of the registered namespace
 * instead — same property access (`t.signIn`), but each read goes through the
 * registry, so the active locale (and any language pack registered later)
 * decides the text.
 *
 * The view keeps the fallback's own keys, in its own order, and resolves every
 * value lazily on read: the object identity is stable per namespace + fallback,
 * so a card can keep passing `t` into helpers, while the strings still follow a
 * locale switch without remounting.
 */
import { useMemo, useSyncExternalStore } from 'react'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'

/** Translate one key through a bound namespace; `{name}` placeholders are filled. */
type BoundTranslate = (key: string, params?: Record<string, unknown>) => string

const NOOP_SUBSCRIBE = (): (() => void) => () => {}
const ZERO_REVISION = (): number => 0

let runtime: LocaleRuntime | undefined
let subscribe: (listener: () => void) => () => void = NOOP_SUBSCRIBE
let revision: () => number = ZERO_REVISION
const bound = new Map<string, BoundTranslate>()

/**
 * Hand the client locale runtime to this module.
 *
 * Called once from the plugin entry, before any card mounts. Rendering without
 * it (unit tests that mount a card bare) keeps the dictionary's own values,
 * which is what those tests assert against.
 *
 * @param locale - the plugin context's locale runtime.
 */
export function installLineLocale(locale: LocaleRuntime): void {
  runtime = locale
  // `register`/`bind` are the whole contract a dictionary needs; the
  // getSnapshot/subscribe pair is what makes a locale SWITCH reach a mounted
  // card. A harness or a test double that installs only the first half still
  // renders — the card just keeps the text it has until something else
  // re-renders it, which is the pre-existing behaviour.
  subscribe = typeof locale.subscribe === 'function' ? (listener) => locale.subscribe(listener) : NOOP_SUBSCRIBE
  revision = typeof locale.getSnapshot === 'function' ? () => locale.getSnapshot().revision : ZERO_REVISION
  bound.clear()
}

/** Bound translator of one namespace, or `undefined` when no locale service exists. */
function translatorOf(ns: string): BoundTranslate | undefined {
  if (runtime === undefined) return undefined
  const cached = bound.get(ns)
  if (cached !== undefined) return cached
  let translate: BoundTranslate
  try {
    translate = runtime.bind(ns) as BoundTranslate
  } catch {
    // An older harness without the locale service: fall back to the dictionary.
    return undefined
  }
  bound.set(ns, translate)
  return translate
}

/**
 * Dictionary-shaped view of one namespace, resolved through the active locale.
 *
 * @param ns - the namespace the card registered its dictionaries under.
 * @param fallback - the card's own `zh` dictionary: source of the key set and
 * of the value used when no locale service is installed.
 * @returns the same key shape as `fallback`, with values read at render time.
 */
export function useLineDict<D extends Record<string, string>>(ns: string, fallback: D): D {
  // A locale switch or a late dictionary registration bumps the revision; a
  // card outside a slot outlet would otherwise keep rendering the old strings
  // until something else re-rendered it.
  useSyncExternalStore(subscribe, revision, revision)
  return useMemo(() => liveDict(ns, fallback) as D, [ns, fallback])
}

/** Build the lazy dictionary view: one enumerable getter per fallback key. */
function liveDict<D extends Record<string, string>>(ns: string, fallback: D): Record<string, string> {
  const translate = translatorOf(ns)
  const view: Record<string, string> = {}
  for (const key of Object.keys(fallback)) {
    Object.defineProperty(view, key, {
      enumerable: true,
      configurable: false,
      get: () => translate === undefined ? fallback[key] : translate(key),
    })
  }
  return view
}
