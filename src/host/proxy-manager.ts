import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { ProxyMode, SubscriptionPreferencesDto } from '../shared/contracts.ts'

export type FetchLike = typeof fetch

const SYSTEM_PROXY_CACHE_TTL_MS = 5_000

/**
 * How long a proxied connection may take to establish.
 *
 * undici's default is 10 seconds, and it covers the TLS handshake with the
 * ORIGIN, not merely the hop to the proxy: a proxy whose route to
 * chatgpt.com goes through a slow node measured 1.2s to 18s for that
 * handshake alone, and the request after it took 31s end to end. The default
 * therefore killed requests that would have succeeded seconds later, and it
 * killed them as an opaque `fetch failed` - the underlying
 * `UND_ERR_CONNECT_TIMEOUT` never named the proxy, so the failure read as
 * "the search is broken" rather than "the line was slow".
 *
 * 60 seconds covers the measured worst case with room to spare. It bounds the
 * CONNECT phase only; the request itself keeps undici's own timeouts.
 */
const PROXY_CONNECT_TIMEOUT_MS = 60_000

export function normalizeProxyUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed) || /^socks5?:\/\//i.test(trimmed)) {
    return trimmed
  }
  return `http://${trimmed}`
}

export function parseWindowsProxyRegistry(stdout: string): string | null {
  const enableMatch = stdout.match(/ProxyEnable\s+REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)/i)
  if (!enableMatch) return null

  const enableVal = enableMatch[1].startsWith('0x')
    ? parseInt(enableMatch[1], 16)
    : parseInt(enableMatch[1], 10)

  if (enableVal !== 1) return null

  const serverMatch = stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)
  if (!serverMatch) return null

  const rawServer = serverMatch[1].trim()
  if (!rawServer) return null

  // Format might be "http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7891" or "127.0.0.1:7890"
  if (rawServer.includes('=')) {
    const pairs = rawServer.split(';')
    const map: Record<string, string> = {}
    for (const pair of pairs) {
      const [proto, addr] = pair.split('=').map(s => s.trim())
      if (proto && addr) {
        map[proto.toLowerCase()] = addr
      }
    }
    const target = map.https || map.http || map.socks
    if (target) {
      if (map.socks && !map.https && !map.http) {
        return normalizeProxyUrl(target.startsWith('socks') ? target : `socks5://${target}`)
      }
      return normalizeProxyUrl(target)
    }
    return null
  }

  return normalizeProxyUrl(rawServer)
}

export function parseMacOsScutilProxy(stdout: string): string | null {
  const httpsEnable = /HTTPSEnable\s*:\s*1/i.test(stdout)
  const httpEnable = /HTTPEnable\s*:\s*1/i.test(stdout)
  const socksEnable = /SOCKSEnable\s*:\s*1/i.test(stdout)

  if (httpsEnable) {
    const host = stdout.match(/HTTPSProxy\s*:\s*([^\s\r\n]+)/i)?.[1]
    const port = stdout.match(/HTTPSPort\s*:\s*(\d+)/i)?.[1]
    if (host && port) return normalizeProxyUrl(`${host}:${port}`)
  }

  if (httpEnable) {
    const host = stdout.match(/HTTPProxy\s*:\s*([^\s\r\n]+)/i)?.[1]
    const port = stdout.match(/HTTPPort\s*:\s*(\d+)/i)?.[1]
    if (host && port) return normalizeProxyUrl(`${host}:${port}`)
  }

  if (socksEnable) {
    const host = stdout.match(/SOCKSProxy\s*:\s*([^\s\r\n]+)/i)?.[1]
    const port = stdout.match(/SOCKSPort\s*:\s*(\d+)/i)?.[1]
    if (host && port) return normalizeProxyUrl(`socks5://${host}:${port}`)
  }

  return null
}

export interface ParseEnvProxyOptions {
  /**
   * `$DSH_HOME/.env` consulted after the process environment; `null` disables
   * the file fallback so a caller (or a test) never reads configuration behind
   * the injected environment's back.
   */
  envFile?: string | null
}

export function parseEnvProxy(
  env: Record<string, string | undefined> = process.env,
  options: ParseEnvProxyOptions = {},
): string | null {
  const proxy =
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    env.all_proxy

  if (proxy && proxy.trim()) return normalizeProxyUrl(proxy)
  if (options.envFile === null) return null

  try {
    const dshHome = env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const envFile = options.envFile ?? path.join(dshHome, '.env')
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, 'utf8')
      const match = content.match(/^(?:export\s+)?(?:HTTPS_PROXY|https_proxy|HTTP_PROXY|http_proxy|ALL_PROXY|all_proxy)\s*=\s*["']?([^"'\r\n]+)["']?/m)
      if (match && match[1]?.trim()) {
        return normalizeProxyUrl(match[1].trim())
      }
    }
  } catch {
    // best-effort fallback
  }

  return null
}

export interface ParseNoProxyOptions {
  /**
   * `$DSH_HOME/.env`, consulted after the process environment; `null` disables
   * the file fallback, exactly like {@link ParseEnvProxyOptions}.
   */
  envFile?: string | null
}

/**
 * The raw `NO_PROXY` list, or an empty string when none is configured.
 *
 * Read next to the proxy itself on purpose: a proxy that a line is *told* to use
 * and a bypass list that lives somewhere else are how "the local gateway
 * suddenly goes through Clash" happens.
 */
export function parseNoProxy(
  env: Record<string, string | undefined> = process.env,
  options: ParseNoProxyOptions = {},
): string {
  const direct = env.NO_PROXY ?? env.no_proxy
  if (direct && direct.trim()) return direct.trim()
  if (options.envFile === null) return ''

  try {
    const dshHome = env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const envFile = options.envFile ?? path.join(dshHome, '.env')
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, 'utf8')
      const match = content.match(/^(?:export\s+)?(?:NO_PROXY|no_proxy)\s*=\s*["']?([^"'\r\n]*)["']?/m)
      if (match) return (match[1] ?? '').trim()
    }
  } catch {
    // best-effort fallback
  }

  return ''
}

/** {@link shouldBypassProxy} needs a port to honor a `host:port` entry. */
function defaultPortFor(protocol: string): string {
  if (protocol === 'http:') return '80'
  if (protocol === 'https:') return '443'
  return ''
}

function normalizeHostForMatch(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

/**
 * Whether a host is loopback, and therefore never worth a proxy hop.
 *
 * The whole `127.0.0.0/8` block, not just `127.0.0.1`: a second loopback alias
 * is a normal way to run a local gateway, and a proxy cannot reach it any
 * better than the process itself can.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = normalizeHostForMatch(hostname)
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1') return true
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  return v4 !== null && v4[1] === '127'
}

/**
 * Standard `NO_PROXY` matching: `*`, exact hosts, domain suffixes, `host:port`.
 *
 * Deliberately not CIDR: a proxy configured for this plugin is a local GUI
 * proxy, and the entries that matter are the ones a user types.
 */
export function noProxyBypasses(hostname: string, port: string, list: string): boolean {
  const host = normalizeHostForMatch(hostname)
  for (const raw of list.split(',')) {
    const entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true

    const withoutScheme = entry.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/.*$/, '')
    let entryHost = withoutScheme
    let entryPort = ''
    const bracketed = withoutScheme.match(/^\[([^\]]+)\](?::(\d+))?$/)
    if (bracketed) {
      entryHost = bracketed[1]
      entryPort = bracketed[2] ?? ''
    } else if (withoutScheme.split(':').length === 2) {
      const [name, candidate] = withoutScheme.split(':')
      if (/^\d+$/.test(candidate)) {
        entryHost = name
        entryPort = candidate
      }
    }

    const suffix = entryHost.replace(/^\./, '').replace(/\.$/, '')
    if (!suffix) continue
    if (entryPort && entryPort !== port) continue
    if (host === suffix || host.endsWith('.' + suffix)) return true
  }
  return false
}

/**
 * Whether a request target must skip the proxy.
 *
 * Loopback first: a local gateway behind a proxy hop is a request the proxy has
 * to refuse (or worse, forwards to itself), and the plugin's own loopback reads
 * already use a bare fetch for the same reason.
 */
export function shouldBypassProxy(target: URL | string, noProxyList = ''): boolean {
  let url: URL
  try {
    url = typeof target === 'string' ? new URL(target) : target
  } catch {
    return false
  }
  if (isLoopbackHostname(url.hostname)) return true
  if (!noProxyList) return false
  return noProxyBypasses(url.hostname, url.port || defaultPortFor(url.protocol), noProxyList)
}

/**
 * Read one GNOME proxy setting; `null` when `gsettings` is absent or the key is
 * unreadable (headless box, no dconf session).
 */
function readGsettings(key: string): string | null {
  try {
    const stdout = execSync(`gsettings get ${key}`, { timeout: 1500, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    return stdout.trim()
  } catch {
    return null
  }
}

/** gsettings prints strings single-quoted, ports bare, and absent keys as ''. */
function gsettingsString(value: string | null): string {
  if (value === null) return ''
  return value.replace(/^['"]|['"]$/g, '').trim()
}

/**
 * GNOME's manual proxy, the Linux equivalent of the Windows registry read.
 *
 * `auto` is a PAC URL, which cannot be applied by posting through an agent, and
 * `none` means no system proxy; both fall through to the environment.
 */
export function parseLinuxSystemProxy(read: (key: string) => string | null): string | null {
  if (gsettingsString(read('org.gnome.system.proxy mode')).toLowerCase() !== 'manual') return null

  const scheme = (name: 'https' | 'http' | 'socks'): string | null => {
    const host = gsettingsString(read(`org.gnome.system.proxy.${name} host`))
    const port = Number(gsettingsString(read(`org.gnome.system.proxy.${name} port`)))
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null
    const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    return `${name === 'socks' ? 'socks5' : 'http'}://${authority}:${port}`
  }

  return scheme('https') ?? scheme('http') ?? scheme('socks')
}

export function detectSystemProxy(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  readSettings: (key: string) => string | null = readGsettings,
): string | null {
  try {
    if (platform === 'win32') {
      const stdout = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"',
        { timeout: 1500, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
      const detected = parseWindowsProxyRegistry(stdout)
      if (detected) return detected
    } else if (platform === 'darwin') {
      const stdout = execSync('scutil --proxy', {
        timeout: 1500,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const detected = parseMacOsScutilProxy(stdout)
      if (detected) return detected
    } else if (platform === 'linux') {
      const detected = parseLinuxSystemProxy(readSettings)
      if (detected) return detected
    }
  } catch {
    // If system registry or scutil fails (e.g. restricted sandbox/permission), fall through to environment variables
  }

  return parseEnvProxy(env)
}

/**
 * The URL a fetch call targets, for the bypass decision.
 *
 * A `Request` exposes its URL without consuming the body, so reading it here
 * costs the request nothing.
 */
function requestTarget(input: Parameters<FetchLike>[0]): string | URL {
  if (typeof input === 'string' || input instanceof URL) return input
  return (input as Request).url
}

/**
 * Whether an error is undici saying the pooled client under this request was
 * destroyed — the host surfaces it as `terminated: The client is destroyed`.
 *
 * Only that family qualifies: an ordinary connect failure belongs to the other
 * decision (the agent is healthy, the path is not), so it must not be replayed
 * here.
 */
function isDestroyedClientError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current === 'string') return /client is destroyed/i.test(current)
    if (!(current instanceof Error)) return false
    if (/client is destroyed|UND_ERR_DESTROYED/i.test(current.name + ': ' + current.message)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/** Called with the proxy URL the first time detection reports one after a `null`. */
export type SystemProxyListener = (proxyUrl: string) => void

export interface ProxyFetchOptions {
  getPreferences: () => Pick<SubscriptionPreferencesDto, 'proxyMode' | 'customProxyUrl'>
  baseFetch?: FetchLike
  systemProxyDetector?: () => string | null
  /**
   * The `NO_PROXY` list, read per request (subject to the same TTL as the system
   * proxy) so an edit takes effect without a restart. A test injects this rather
   * than inheriting the machine's own bypass list.
   */
  noProxyReader?: () => string
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
  /**
   * The proxied transport. Defaults to undici's own `fetch`; a test injects one
   * so the "destroyed client" recovery below can be exercised without a proxy.
   */
  proxyFetchFn?: FetchLike
}

export class ProxyManager {
  private readonly getPreferences: () => Pick<SubscriptionPreferencesDto, 'proxyMode' | 'customProxyUrl'>
  private readonly baseFetch: FetchLike
  private readonly proxyFetchFn: FetchLike
  private readonly systemProxyDetector: () => string | null
  private readonly noProxyReader: () => string
  private readonly logger?: Pick<Console, 'info' | 'warn' | 'error'>

  private cachedSystemProxy: string | null = null
  private lastSystemProxyCheck = 0
  private cachedNoProxy = ''
  private lastNoProxyCheck = 0
  private detected = false
  private readonly proxyListeners = new Set<SystemProxyListener>()
  private readonly agents = new Map<string, ProxyAgent>()

  constructor(options: ProxyFetchOptions) {
    this.getPreferences = options.getPreferences
    this.baseFetch = options.baseFetch ?? fetch
    this.proxyFetchFn = options.proxyFetchFn ?? (undiciFetch as unknown as FetchLike)
    this.systemProxyDetector = options.systemProxyDetector ?? (() => detectSystemProxy())
    this.noProxyReader = options.noProxyReader ?? (() => parseNoProxy())
    this.logger = options.logger
  }

  getSystemProxy(force = false): string | null {
    const now = Date.now()
    if (!force && now - this.lastSystemProxyCheck < SYSTEM_PROXY_CACHE_TTL_MS) {
      return this.cachedSystemProxy
    }
    const previous = this.cachedSystemProxy
    const hadDetected = this.detected
    this.lastSystemProxyCheck = now
    this.detected = true
    try {
      this.cachedSystemProxy = this.systemProxyDetector()
    } catch (error) {
      this.cachedSystemProxy = null
      this.logger?.warn?.(`[dsh-chatgpt-subscription] Failed to detect system proxy: ${error instanceof Error ? error.message : String(error)}`)
    }
    // Only the transition to a KNOWN proxy is announced. An absent proxy and a failed detection
    // both read as `null`, so a listener acting on `null` would tear down a working route over one
    // transient registry or `scutil` failure; the first detection is the caller's own result.
    if (hadDetected && previous === null && this.cachedSystemProxy !== null) {
      for (const listener of [...this.proxyListeners]) {
        try {
          listener(this.cachedSystemProxy)
        } catch {
          // An observing listener must never break detection for the request that triggered it.
        }
      }
    }
    return this.cachedSystemProxy
  }

  /**
   * The active `NO_PROXY` list, re-read at most once per TTL.
   *
   * A reader that throws (an unreadable `$DSH_HOME/.env`) reads as "no bypass
   * list", never as "bypass everything": the wrong guess in that direction would
   * take an active proxy away from every line at once.
   */
  getNoProxyList(force = false): string {
    const now = Date.now()
    if (!force && now - this.lastNoProxyCheck < SYSTEM_PROXY_CACHE_TTL_MS) return this.cachedNoProxy
    this.lastNoProxyCheck = now
    try {
      this.cachedNoProxy = this.noProxyReader().trim()
    } catch {
      this.cachedNoProxy = ''
    }
    return this.cachedNoProxy
  }

  /**
   * Observe the system proxy becoming known.
   *
   * A proxy that appears after startup — or a first detection that failed — otherwise leaves every
   * consumer on the decision it made at load, because `null` reads the same for "no proxy" and for
   * "detection failed".
   *
   * @param listener - called with the detected proxy URL; a throw from it is ignored.
   * @returns the disposer that stops observing.
   */
  onSystemProxyDetected(listener: SystemProxyListener): () => void {
    this.proxyListeners.add(listener)
    return () => { this.proxyListeners.delete(listener) }
  }

  resolveActiveProxyUrl(): string | null {
    const prefs = this.getPreferences()
    const mode: ProxyMode = prefs.proxyMode ?? 'auto'

    if (mode === 'direct') {
      return null
    }

    if (mode === 'custom') {
      return prefs.customProxyUrl ? normalizeProxyUrl(prefs.customProxyUrl) : null
    }

    // Auto mode
    return this.getSystemProxy()
  }

  private getOrCreateAgent(proxyUrl: string): ProxyAgent {
    let agent = this.agents.get(proxyUrl)
    if (!agent) {
      // The options-object form, and deliberately not `new ProxyAgent(url, options)`:
      // undici's ProxyAgent constructor takes ONE argument, so a second one is
      // dropped silently and the connect timeout would never be applied - the
      // agent would fall back to the 10s default and fail the same way it
      // always did, with nothing in the code to show why.
      agent = new ProxyAgent({ uri: proxyUrl, connectTimeout: PROXY_CONNECT_TIMEOUT_MS })
      this.agents.set(proxyUrl, agent)
    }
    return agent
  }

  createFetch(): FetchLike {
    return async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]): Promise<Response> => {
      const activeProxy = this.resolveActiveProxyUrl()

      if (!activeProxy) {
        return this.baseFetch(input, init)
      }

      // A loopback target or a `NO_PROXY` host is reached better by this process
      // than through a proxy hop: the plugin's own loopback reads already use a
      // bare fetch for that reason, and a proxy whose DNS answers with its own
      // fake-ip range (Clash/Mihomo) cannot be used to reach its own host at all.
      if (shouldBypassProxy(requestTarget(input), this.getNoProxyList())) {
        return this.baseFetch(input, init)
      }

      // One retry, and only for a client undici has already destroyed: the
      // per-URL cache then holds a dead client, so every later request through
      // this proxy fails instantly with "terminated: The client is destroyed".
      // Evicting it and opening a fresh connection is the difference between a
      // recovered answer and a line that stays broken until the process restarts.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const agent = this.getOrCreateAgent(activeProxy)
          // undiciFetch supports dispatcher option
          return (await this.proxyFetchFn(input, {
            ...(init as any),
            dispatcher: agent,
          } as any)) as unknown as Response
        } catch (error) {
          if (attempt === 0 && isDestroyedClientError(error)) {
            this.agents.delete(activeProxy)
            continue
          }
          throw error
        }
      }
    }
  }

  dispose(): void {
    this.proxyListeners.clear()
    for (const agent of this.agents.values()) {
      // close(), not destroy(): destroy() tears the pooled connection out from
      // under any answer still streaming through it, and the host reports that
      // as "terminated: The client is destroyed" mid-thinking. close() lets the
      // in-flight request finish and then releases the sockets.
      void agent.close().catch(() => undefined)
    }
    this.agents.clear()
  }
}
