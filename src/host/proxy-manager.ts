import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import tls from 'node:tls'
import { Agent, ProxyAgent, buildConnector, fetch as undiciFetch } from 'undici'
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

/**
 * The ProxyAgent constructor options for one proxy URL.
 *
 * `allowH2` is stated only when a caller asks to pin HTTP/1.1: ProxyAgent
 * forwards whatever it is given into the per-origin Agent, and `allowH2: false`
 * is what keeps h2 out of the tunnel's ALPN offer. Every other caller gets the
 * option object it had before, byte for byte.
 */
export function proxyAgentOptions(
  uri: string,
  allowH2?: boolean,
): { uri: string; connectTimeout: number; allowH2?: false } {
  return { uri, connectTimeout: PROXY_CONNECT_TIMEOUT_MS, ...(allowH2 === false ? { allowH2: false as const } : {}) }
}

/** One pool per (proxy, protocol policy, credential): neither policy nor identity may be shared. */
function agentCacheKey(proxyUrl: string, allowH2?: boolean, poolKey?: string): string {
  return `${poolKey ?? 'shared'}:${allowH2 === false ? 'h1' : 'auto'}:${proxyUrl}`
}

/** The key of the dispatcher that serves one credential's unproxied traffic. */
function directAgentKey(poolKey: string, allowH2?: boolean, omitAlpn?: boolean): string {
  return `direct:${poolKey}:${allowH2 === true ? 'auto' : 'h1'}:${omitAlpn === true ? 'noalpn' : 'alpn'}`
}

/**
 * How many pooled dispatchers may exist at once.
 *
 * A pool is per credential, so the bound has to clear the largest account pool
 * this plugin supports with room for a rotation or two. The oldest pool is
 * closed (not destroyed) when it is exceeded, so an evicted pool still finishes
 * the request it is serving.
 */
const DISPATCHER_POOL_CAPACITY = 64

/**
 * The pool a request belongs to, derived from its credential.
 *
 * Two accounts must never share one TLS connection: the native client is one
 * credential per process, so a server watching a connection that carries several
 * different `Authorization` values is watching a rotating pool, which no real
 * client does. The token is hashed, so the map never holds a raw credential.
 *
 * A request with no `Authorization` header is not credentialed (project
 * discovery before a token exists, the Hub release manifest) and keeps the
 * shared pool.
 */
function credentialPoolKey(init: Parameters<FetchLike>[1]): string | undefined {
  const headers = init?.headers
  if (headers === undefined) return undefined
  // The host tsconfig has no DOM lib, so the fetch types arrive through
  // `typeof fetch` while `Headers` is a runtime/undici global: the cast bridges
  // the two without naming a DOM-only type in this file.
  const authorization = new Headers(headers as never).get('authorization')
  if (!authorization) return undefined
  return createHash('sha256').update(authorization).digest('hex').slice(0, 16)
}

/** The connector contract undici's Client accepts for its `connect` option. */
type Connector = ReturnType<typeof buildConnector>

/** Timeout for establishing an origin connection on the native connector. */
const NATIVE_CONNECT_TIMEOUT_MS = 30_000

/** One connector instance serves every direct agent: it holds no state of its own. */
const NATIVE_CONNECTOR = buildNativeConnector()

/**
 * A connector that offers no ALPN at all.
 *
 * The native Antigravity client is a Go HTTP/1.1 client and sends no ALPN
 * extension; undici's built-in connector always advertises `http/1.1`. Offering
 * nothing does not change the protocol that ends up being spoken (the server
 * falls back to HTTP/1.1 either way) but it removes one extension the client this
 * route imitates does not have.
 *
 * SNI is set explicitly: undici hands the connector an empty `servername`, and a
 * hello without SNI is refused by Cloud Code (measured: a bare
 * `SSL_ALERT_HANDSHAKE_FAILURE`).
 *
 * HTTP targets keep a plain TCP connect -- the ALPN question only exists for TLS.
 * `connectTls` / `connectTcp` are the seams that keep the shape testable.
 */
export function buildNativeConnector(options: {
  connectTls?: typeof tls.connect
  connectTcp?: typeof net.connect
  timeoutMs?: number
} = {}): Connector {
  const connectTls = options.connectTls ?? tls.connect
  const connectTcp = options.connectTcp ?? net.connect
  const timeoutMs = options.timeoutMs ?? NATIVE_CONNECT_TIMEOUT_MS
  return (connectorOptions, callback) => {
    const protocol = String(connectorOptions.protocol ?? 'https:')
    // undici hands the authority over as `host` and leaves `port` empty for a
    // default port; for plain HTTP the port can also arrive glued to the host.
    const rawHost = String(connectorOptions.hostname || connectorOptions.host || '')
    const glued = /^\[?([^\]]+)\]?:(\d+)$/.exec(rawHost)
    const host = glued === null ? rawHost : glued[1]
    const port = Number(connectorOptions.port) || Number(glued?.[2] ?? '') || (protocol === 'http:' ? 80 : 443)
    if (protocol === 'http:') {
      const socket = connectTcp({ host, port })
      socket.setTimeout(timeoutMs, () => { socket.destroy(); callback(new Error('connect timeout'), null) })
      socket.once('error', (error) => { socket.destroy(); callback(error, null) })
      socket.once('connect', () => { socket.setTimeout(0); callback(null, socket) })
      return
    }
    const socket = connectTls({
      host,
      port,
      servername: connectorOptions.servername || host,
    })
    socket.setTimeout(timeoutMs, () => { socket.destroy(); callback(new Error('connect timeout'), null) })
    socket.once('error', (error) => { socket.destroy(); callback(error, null) })
    socket.once('secureConnect', () => { socket.setTimeout(0); callback(null, socket) })
  }
}

/**
 * Drop headers before the request is written.
 *
 * `fetch` adds `sec-fetch-mode: cors` and `accept-language: *` to every request
 * and offers no way to suppress a header it adds itself. The dispatcher is the
 * seam it hands the header list to, so a consumer that imitates a non-browser
 * client can remove them there. The wrapped dispatcher keeps the inner agent's
 * pool: this is a filter, not a new connection pool.
 */
export function stripDispatchHeaders<T extends object>(dispatcher: T, headers: readonly string[]): T {
  const banned = new Set(headers.map((name) => name.toLowerCase()))
  const strip = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.filter((entry) => !banned.has(String((entry as unknown[])[0]).toLowerCase()))
    }
    if (input !== null && typeof input === 'object') {
      const kept: Record<string, unknown> = {}
      for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
        if (!banned.has(name.toLowerCase())) kept[name] = value
      }
      return kept
    }
    return input
  }
  const inner = dispatcher as unknown as {
    dispatch: (options: Record<string, unknown>, handler: unknown) => boolean
    close: (...args: unknown[]) => unknown
    destroy: (...args: unknown[]) => unknown
  }
  const shaped = {
    dispatch(options: Record<string, unknown>, handler: unknown) {
      return inner.dispatch({ ...options, headers: strip(options.headers) }, handler)
    },
    close: (...args: unknown[]) => inner.close(...args),
    destroy: (...args: unknown[]) => inner.destroy(...args),
  }
  // Non-enumerable: the wrapped dispatcher stays reachable for diagnostics and
  // tests without becoming part of the object's visible surface.
  Object.defineProperty(shaped, 'wrapped', { value: dispatcher, enumerable: false })
  return shaped as unknown as T
}

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
 * Run one system probe with no console window and no shell layer.
 *
 * `windowsHide` is not cosmetic here. `execSync` runs through `cmd.exe /d /s /c`,
 * and a host that has no console of its own (a detached `dsh web` host on Windows,
 * or any GUI-launched parent) gets a NEW VISIBLE console allocated for that
 * short-lived shell — the black window that flashed on every re-detection, because
 * the proxy cache TTL is only 5 seconds (#19, #91). `execFileSync` additionally
 * drops the shell hop, so one probe is one process instead of two and its argument
 * needs no quoting. `windowsHide` is a no-op on macOS and Linux, but it states the
 * intent once for every platform.
 */
function runSystemProbe(file: string, args: string[]): string {
  return execFileSync(file, args, {
    timeout: 1500,
    encoding: 'utf-8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/**
 * Read one GNOME proxy setting; `null` when `gsettings` is absent or the key is
 * unreadable (headless box, no dconf session).
 */
function readGsettings(key: string): string | null {
  try {
    const stdout = runSystemProbe('gsettings', ['get', key])
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
      const stdout = runSystemProbe('reg.exe', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      ])
      const detected = parseWindowsProxyRegistry(stdout)
      if (detected) return detected
    } else if (platform === 'darwin') {
      const stdout = runSystemProbe('scutil', ['--proxy'])
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
  private readonly agents = new Map<string, ProxyAgent | Agent>()
  /** One shaping wrapper per pooled dispatcher, so a pool keeps a stable identity. */
  private readonly shaped = new WeakMap<object, object>()

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

  private getOrCreateAgent(proxyUrl: string, allowH2?: boolean, poolKey?: string): ProxyAgent {
    const key = agentCacheKey(proxyUrl, allowH2, poolKey)
    const existing = this.agents.get(key)
    if (existing instanceof ProxyAgent) return existing
    // The options-object form, and deliberately not `new ProxyAgent(url, options)`:
    // undici's ProxyAgent constructor takes ONE argument, so a second one is
    // dropped silently and the connect timeout would never be applied - the
    // agent would fall back to the 10s default and fail the same way it
    // always did, with nothing in the code to show why.
    const agent = new ProxyAgent(proxyAgentOptions(proxyUrl, allowH2))
    this.remember(key, agent)
    return agent
  }

  /**
   * The dispatcher for one credential's direct (unproxied) traffic.
   *
   * Node's global fetch pools every origin in one process-wide agent, so a
   * credentialed request cannot be given a private connection through it. The
   * pooled path therefore dispatches through undici's own fetch with an agent of
   * its own; HTTP/1.1 stays the default, because that is what the global fetch
   * this replaces would have spoken.
   */
  private getOrCreateDirectAgent(
    poolKey: string,
    overrides?: { allowH2?: boolean; omitAlpn?: boolean },
  ): Agent {
    const key = directAgentKey(poolKey, overrides?.allowH2, overrides?.omitAlpn)
    const existing = this.agents.get(key)
    if (existing instanceof Agent) return existing
    const agent = new Agent({
      allowH2: overrides?.allowH2 === true,
      ...(overrides?.omitAlpn === true ? { connect: NATIVE_CONNECTOR } : {}),
    })
    this.remember(key, agent)
    return agent
  }

  /** Store a dispatcher, retiring the oldest pool once the bound is reached. */
  private remember(key: string, agent: ProxyAgent | Agent): void {
    if (this.agents.size >= DISPATCHER_POOL_CAPACITY) {
      const oldest = this.agents.keys().next()
      if (!oldest.done) {
        const evicted = this.agents.get(oldest.value)
        this.agents.delete(oldest.value)
        // close(), not destroy(): an evicted pool may still be answering.
        void evicted?.close().catch(() => undefined)
      }
    }
    this.agents.set(key, agent)
  }

  /** Hand one request to a specific dispatcher through undici's fetch. */
  private dispatchWith(
    input: Parameters<FetchLike>[0],
    init: Parameters<FetchLike>[1],
    dispatcher: ProxyAgent | Agent,
  ): Promise<Response> {
    return this.proxyFetchFn(input, { ...(init as any), dispatcher } as any) as unknown as Promise<Response>
  }

  /**
   * A fetch that follows this manager's proxy policy, with optional protocol and
   * credential pins for one consumer.
   *
   * `allowH2: false` keeps TLS at HTTP/1.1. Antigravity asks for it: the native
   * `language_server` speaks HTTP/1.1, and the direct path this manager falls
   * back to is Node's global fetch, which offers http/1.1 only - without the pin
   * the same route would speak h2 behind a proxy and HTTP/1.1 without one.
   *
   * `credentialPools: true` gives every distinct credential its own connection
   * pool on both paths, which is what keeps a multi-account rotation from being
   * visible as one connection carrying several identities.
   */
  createFetch(overrides?: {
    allowH2?: boolean
    credentialPools?: boolean
    /** Header names to drop before the request is written; see {@link stripDispatchHeaders}. */
    stripHeaders?: readonly string[]
    /** Offer no ALPN on unproxied connections. Proxied ones cannot: ProxyAgent owns their connector. */
    omitAlpn?: boolean
  }): FetchLike {
    const shape = <T extends object>(dispatcher: T): T => {
      const headers = overrides?.stripHeaders
      if (headers === undefined || headers.length === 0) return dispatcher
      const cached = this.shaped.get(dispatcher)
      if (cached !== undefined) return cached as T
      const shaped = stripDispatchHeaders(dispatcher, headers)
      this.shaped.set(dispatcher, shaped)
      return shaped
    }
    return async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]): Promise<Response> => {
      const poolKey = overrides?.credentialPools === true ? credentialPoolKey(init) : undefined
      const activeProxy = this.resolveActiveProxyUrl()

      if (!activeProxy) {
        return poolKey === undefined
          ? this.baseFetch(input, init)
          : this.dispatchWith(input, init, shape(this.getOrCreateDirectAgent(poolKey, overrides)))
      }

      // A loopback target or a `NO_PROXY` host is reached better by this process
      // than through a proxy hop: the plugin's own loopback reads already use a
      // bare fetch for that reason, and a proxy whose DNS answers with its own
      // fake-ip range (Clash/Mihomo) cannot be used to reach its own host at all.
      if (shouldBypassProxy(requestTarget(input), this.getNoProxyList())) {
        return poolKey === undefined
          ? this.baseFetch(input, init)
          : this.dispatchWith(input, init, shape(this.getOrCreateDirectAgent(poolKey, overrides)))
      }

      // One retry, and only for a client undici has already destroyed: the
      // per-URL cache then holds a dead client, so every later request through
      // this proxy fails instantly with "terminated: The client is destroyed".
      // Evicting it and opening a fresh connection is the difference between a
      // recovered answer and a line that stays broken until the process restarts.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const agent = shape(this.getOrCreateAgent(activeProxy, overrides?.allowH2, poolKey))
          // undiciFetch supports dispatcher option
          return await this.dispatchWith(input, init, agent)
        } catch (error) {
          if (attempt === 0 && isDestroyedClientError(error)) {
            this.agents.delete(agentCacheKey(activeProxy, overrides?.allowH2, poolKey))
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
