import { describe, expect, it, vi } from 'vitest'
import {
  ProxyManager,
  normalizeProxyUrl,
  parseEnvProxy,
  parseMacOsScutilProxy,
  parseWindowsProxyRegistry,
} from '../src/host/proxy-manager.ts'

describe('Proxy URL Normalization', () => {
  it('normalizes host:port to http:// URL', () => {
    expect(normalizeProxyUrl('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(normalizeProxyUrl('localhost:8080')).toBe('http://localhost:8080')
  })

  it('preserves existing schemes', () => {
    expect(normalizeProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(normalizeProxyUrl('https://proxy.example.com:8443')).toBe('https://proxy.example.com:8443')
    expect(normalizeProxyUrl('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080')
    expect(normalizeProxyUrl('socks://127.0.0.1:1080')).toBe('socks://127.0.0.1:1080')
  })

  it('returns empty string for blank input', () => {
    expect(normalizeProxyUrl('')).toBe('')
    expect(normalizeProxyUrl('   ')).toBe('')
  })
})

describe('Windows Registry Proxy Parser', () => {
  it('parses enabled simple proxy server', () => {
    const stdout = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
`
    expect(parseWindowsProxyRegistry(stdout)).toBe('http://127.0.0.1:7890')
  })

  it('parses decimal REG_DWORD', () => {
    const stdout = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    1
    ProxyServer    REG_SZ    http://127.0.0.1:7890
`
    expect(parseWindowsProxyRegistry(stdout)).toBe('http://127.0.0.1:7890')
  })

  it('returns null when ProxyEnable is 0', () => {
    const stdout = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ    127.0.0.1:7890
`
    expect(parseWindowsProxyRegistry(stdout)).toBeNull()
  })

  it('parses protocol-specific proxy strings prioritizing https over http over socks', () => {
    const stdout = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    ftp=127.0.0.1:21;http=127.0.0.1:8080;https=127.0.0.1:8443;socks=127.0.0.1:1080
`
    expect(parseWindowsProxyRegistry(stdout)).toBe('http://127.0.0.1:8443')
  })

  it('parses socks-only proxy string', () => {
    const stdout = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    socks=127.0.0.1:1080
`
    expect(parseWindowsProxyRegistry(stdout)).toBe('socks5://127.0.0.1:1080')
  })

  it('returns null on invalid or missing data', () => {
    expect(parseWindowsProxyRegistry('')).toBeNull()
    expect(parseWindowsProxyRegistry('ProxyEnable REG_DWORD 0x1')).toBeNull()
  })
})

describe('macOS Scutil Proxy Parser', () => {
  it('parses HTTPS proxy', () => {
    const stdout = `
<dictionary> {
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
}
`
    expect(parseMacOsScutilProxy(stdout)).toBe('http://127.0.0.1:7890')
  })

  it('parses HTTP proxy if HTTPS is not enabled', () => {
    const stdout = `
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 0
}
`
    expect(parseMacOsScutilProxy(stdout)).toBe('http://127.0.0.1:8080')
  })

  it('parses SOCKS proxy if HTTP/HTTPS is not enabled', () => {
    const stdout = `
<dictionary> {
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 127.0.0.1
}
`
    expect(parseMacOsScutilProxy(stdout)).toBe('socks5://127.0.0.1:1080')
  })

  it('returns null when proxies are disabled', () => {
    const stdout = `
<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
}
`
    expect(parseMacOsScutilProxy(stdout)).toBeNull()
  })
})

describe('Environment Variable Proxy Parser', () => {
  it('reads HTTPS_PROXY and https_proxy', () => {
    expect(parseEnvProxy({ HTTPS_PROXY: 'http://127.0.0.1:7890' })).toBe('http://127.0.0.1:7890')
    expect(parseEnvProxy({ https_proxy: '127.0.0.1:7890' })).toBe('http://127.0.0.1:7890')
  })

  it('reads HTTP_PROXY and ALL_PROXY', () => {
    expect(parseEnvProxy({ HTTP_PROXY: 'http://127.0.0.1:8080' })).toBe('http://127.0.0.1:8080')
    expect(parseEnvProxy({ ALL_PROXY: 'socks5://127.0.0.1:1080' })).toBe('socks5://127.0.0.1:1080')
  })

  it('returns null when no proxy variables are set', () => {
    expect(parseEnvProxy({})).toBeNull()
    expect(parseEnvProxy({ HTTPS_PROXY: '   ' })).toBeNull()
  })
})

describe('ProxyManager', () => {
  it('resolves active proxy based on mode', () => {
    let mode: 'auto' | 'custom' | 'direct' = 'auto'
    let customUrl: string | null = null

    const manager = new ProxyManager({
      getPreferences: () => ({ proxyMode: mode, customProxyUrl: customUrl }),
      systemProxyDetector: () => 'http://127.0.0.1:7890',
    })

    // Auto mode returns detected system proxy
    expect(manager.resolveActiveProxyUrl()).toBe('http://127.0.0.1:7890')

    // Direct mode returns null
    mode = 'direct'
    expect(manager.resolveActiveProxyUrl()).toBeNull()

    // Custom mode returns customProxyUrl
    mode = 'custom'
    customUrl = '127.0.0.1:8888'
    expect(manager.resolveActiveProxyUrl()).toBe('http://127.0.0.1:8888')

    // Custom mode with empty URL returns null
    customUrl = ''
    expect(manager.resolveActiveProxyUrl()).toBeNull()

    manager.dispose()
  })

  it('delegates to baseFetch when proxy is not active', async () => {
    const mockBaseFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const manager = new ProxyManager({
      getPreferences: () => ({ proxyMode: 'direct', customProxyUrl: null }),
      baseFetch: mockBaseFetch as any,
    })

    const fetchFn = manager.createFetch()
    const res = await fetchFn('https://api.openai.com/test')
    expect(mockBaseFetch).toHaveBeenCalledTimes(1)
    expect(await res.text()).toBe('ok')

    manager.dispose()
  })
})
