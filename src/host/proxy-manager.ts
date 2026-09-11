import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { ProxyMode, SubscriptionPreferencesDto } from '../shared/contracts.ts'

export type FetchLike = typeof fetch

const SYSTEM_PROXY_CACHE_TTL_MS = 5_000

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

export function detectSystemProxy(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): string | null {
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
    }
  } catch {
    // If system registry or scutil fails (e.g. restricted sandbox/permission), fall through to environment variables
  }

  return parseEnvProxy(env)
}

/** Called with the proxy URL the first time detection reports one after a `null`. */
export type SystemProxyListener = (proxyUrl: string) => void

export interface ProxyFetchOptions {
  getPreferences: () => Pick<SubscriptionPreferencesDto, 'proxyMode' | 'customProxyUrl'>
  baseFetch?: FetchLike
  systemProxyDetector?: () => string | null
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
}

export class ProxyManager {
  private readonly getPreferences: () => Pick<SubscriptionPreferencesDto, 'proxyMode' | 'customProxyUrl'>
  private readonly baseFetch: FetchLike
  private readonly systemProxyDetector: () => string | null
  private readonly logger?: Pick<Console, 'info' | 'warn' | 'error'>

  private cachedSystemProxy: string | null = null
  private lastSystemProxyCheck = 0
  private detected = false
  private readonly proxyListeners = new Set<SystemProxyListener>()
  private readonly agents = new Map<string, ProxyAgent>()

  constructor(options: ProxyFetchOptions) {
    this.getPreferences = options.getPreferences
    this.baseFetch = options.baseFetch ?? fetch
    this.systemProxyDetector = options.systemProxyDetector ?? (() => detectSystemProxy())
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
      agent = new ProxyAgent(proxyUrl)
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

      try {
        const agent = this.getOrCreateAgent(activeProxy)
        // undiciFetch supports dispatcher option
        return (await undiciFetch(input as any, {
          ...(init as any),
          dispatcher: agent,
        })) as unknown as Response
      } catch (error) {
        // Fall back to base fetch if undici fetch encounters an unexpected error
        throw error
      }
    }
  }

  dispose(): void {
    this.proxyListeners.clear()
    for (const agent of this.agents.values()) {
      void agent.destroy().catch(() => undefined)
    }
    this.agents.clear()
  }
}
