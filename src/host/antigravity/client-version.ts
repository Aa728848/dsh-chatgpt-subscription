import { DEFAULT_ANTIGRAVITY_VERSION } from './types.ts'

/**
 * The Hub release this process reports to Cloud Code.
 *
 * The service gates its model catalogue and its Gemini quota buckets on the
 * client version in `User-Agent`, so a pinned constant silently ages into a
 * worse client: the same account sees fewer models and fewer quota buckets than
 * the official app on the same day. The Hub publishes the release it currently
 * ships in its updater manifest, which is what this module reads.
 *
 * The read is deliberately non-blocking. `defaultUserAgent()` is synchronous
 * and is called while a request is being built, so the process always has a
 * usable version to report: the built-in one until a manifest has been read,
 * the last known release after that. A manifest that cannot be read is not a
 * failure -- the reference reimplementations treat it the same way, because a
 * release that is one version old still serves requests.
 *
 * @see https://github.com/router-for-me/CLIProxyAPI — `internal/misc/antigravity_version.go`
 */

/** The Hub updater manifest for the arm64 macOS build. */
export const HUB_MANIFEST_URL =
  'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml'

/**
 * The updater is an electron-builder client, and it says so when it reads its
 * own manifest. Sending the Hub User-Agent here would be this plugin's invention.
 */
const HUB_MANIFEST_USER_AGENT = 'electron-builder'

/**
 * Build changelists of known Hub releases: the `cl=` field of the User-Agent.
 *
 * A release with no entry here omits `cl=` instead of claiming another build's
 * changelist, which is what the official app does for a build it does not know.
 * `2.24.0` was read out of the official darwin-arm archive's build metadata; keep
 * the newest entry and {@link DEFAULT_ANTIGRAVITY_VERSION} in step.
 */
export const HUB_RELEASE_CHANGELISTS: Readonly<Record<string, string>> = {
  '2.23.0': '998057262',
  '2.24.0': '1000335682',
  '2.29.0': '1013060670',
}

const MANIFEST_TIMEOUT_MS = 5_000
/** How long a read manifest is trusted before another read is attempted. */
const MANIFEST_TTL_MS = 6 * 60 * 60 * 1000
/** Retry cadence while no manifest has ever been read. */
const MANIFEST_RETRY_MS = 30 * 60 * 1000

let discoveredVersion: string | undefined
let lastAttempt = 0
let inFlight: Promise<void> | undefined

/**
 * The Hub release to report right now.
 *
 * `DSH_ANTIGRAVITY_VERSION` still wins: pinning a version is how a user works
 * around a Hub release that misbehaves, and discovery must not override it.
 */
export function currentHubVersion(): string {
  const pinned = process.env.DSH_ANTIGRAVITY_VERSION?.trim()
  return pinned || discoveredVersion || DEFAULT_ANTIGRAVITY_VERSION
}

/**
 * The changelist that belongs to a release, or undefined when it is unknown.
 *
 * `DSH_ANTIGRAVITY_CL` wins for the same reason the version pin does.
 */
export function hubChangelist(version: string = currentHubVersion()): string | undefined {
  const pinned = process.env.DSH_ANTIGRAVITY_CL?.trim()
  return pinned || HUB_RELEASE_CHANGELISTS[version]
}

/** The release an electron-builder manifest declares, e.g. `version: 2.24.0`. */
export function parseHubManifestVersion(text: string): string | undefined {
  const match = /^\s*version:\s*['"]?(\d+\.\d+\.\d+)['"]?\s*$/m.exec(text)
  return match?.[1]
}

/**
 * Read the Hub release the updater manifest currently publishes.
 *
 * Single-flight and TTL-gated, so calling it on every request costs a `Date.now()`
 * most of the time. Never throws: the caller is a request path, and a manifest
 * that does not answer must not turn into a failed request.
 */
export function refreshHubVersion(fetchFn: typeof fetch = fetch, now = Date.now()): Promise<void> {
  if (process.env.DSH_ANTIGRAVITY_VERSION?.trim()) return Promise.resolve()
  if (inFlight) return inFlight
  const interval = discoveredVersion === undefined ? MANIFEST_RETRY_MS : MANIFEST_TTL_MS
  if (lastAttempt !== 0 && now - lastAttempt < interval) return Promise.resolve()
  lastAttempt = now
  inFlight = (async () => {
    try {
      const response = await fetchFn(HUB_MANIFEST_URL, {
        headers: { 'User-Agent': HUB_MANIFEST_USER_AGENT },
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      })
      if (!response.ok) return
      const version = parseHubManifestVersion(await response.text())
      if (version) discoveredVersion = version
    } catch {
      // Keep reporting the release already known; the next call retries.
    } finally {
      inFlight = undefined
    }
  })()
  return inFlight
}

/** Drops the cached release. Tests only; production has one process-lifetime read. */
export function resetHubVersionCache(): void {
  discoveredVersion = undefined
  lastAttempt = 0
  inFlight = undefined
}
