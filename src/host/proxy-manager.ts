import { execSync } from 'node:child_process'
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

export function parseEnvProxy(env: Record<string, string | undefined> = process.env): string | null {
  const proxy =
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    env.all_proxy

  if (!proxy || !proxy.trim()) return null
  return normalizeProxyUrl(proxy)
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
    this.lastSystemProxyCheck = now
    try {
      this.cachedSystemProxy = this.systemProxyDetector()
    } catch (error) {
      this.cachedSystemProxy = null
      this.logger?.warn?.(`[dsh-chatgpt-subscription] Failed to detect system proxy: ${error instanceof Error ? error.message : String(error)}`)
    }
    return this.cachedSystemProxy
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
    for (const agent of this.agents.values()) {
      void agent.destroy().catch(() => undefined)
    }
    this.agents.clear()
  }
}
