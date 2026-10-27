import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProxyManager,
  detectSystemProxy,
  normalizeProxyUrl,
  parseEnvProxy,
  parseLinuxSystemProxy,
  parseMacOsScutilProxy,
  parseNoProxy,
  parseWindowsProxyRegistry,
  shouldBypassProxy,
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
    // envFile: null keeps this assertion independent of the machine's $DSH_HOME/.env
    expect(parseEnvProxy({}, { envFile: null })).toBeNull()
    expect(parseEnvProxy({ HTTPS_PROXY: '   ' }, { envFile: null })).toBeNull()
  })
})

describe('$DSH_HOME/.env Proxy Fallback', () => {
  const dirs: string[] = []

  function envFileWith(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proxy-'))
    dirs.push(dir)
    const file = path.join(dir, '.env')
    fs.writeFileSync(file, content, 'utf8')
    return file
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads a plain assignment from the injected env file', () => {
    const envFile = envFileWith('OPENAI_API_KEY=secret\nHTTPS_PROXY=http://127.0.0.1:7890\n')
    expect(parseEnvProxy({}, { envFile })).toBe('http://127.0.0.1:7890')
  })

  it('accepts export prefixes and quoted values', () => {
    expect(parseEnvProxy({}, { envFile: envFileWith('export https_proxy="127.0.0.1:7890"\n') })).toBe('http://127.0.0.1:7890')
    expect(parseEnvProxy({}, { envFile: envFileWith("all_proxy='socks5://127.0.0.1:1080'\n") })).toBe('socks5://127.0.0.1:1080')
  })

  it('ignores commented lines and returns null for an empty assignment', () => {
    expect(parseEnvProxy({}, { envFile: envFileWith('# HTTPS_PROXY=http://127.0.0.1:7890\n') })).toBeNull()
    expect(parseEnvProxy({}, { envFile: envFileWith('HTTPS_PROXY=\n') })).toBeNull()
  })

  it('returns null for a missing file and never reads one when disabled', () => {
    expect(parseEnvProxy({}, { envFile: path.join(os.tmpdir(), 'dsh-proxy-missing', '.env') })).toBeNull()
    expect(parseEnvProxy({ DSH_HOME: os.tmpdir() }, { envFile: null })).toBeNull()
  })

  it('prefers the process environment over the file', () => {
    const envFile = envFileWith('HTTPS_PROXY=http://127.0.0.1:7890\n')
    expect(parseEnvProxy({ HTTPS_PROXY: 'http://127.0.0.1:9999' }, { envFile })).toBe('http://127.0.0.1:9999')
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

  it('announces the system proxy only once a later detection finds one', () => {
    let detected: string | null = null
    const manager = new ProxyManager({
      getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }),
      systemProxyDetector: () => detected,
    })
    const seen: string[] = []
    const stop = manager.onSystemProxyDetected(proxy => seen.push(proxy))

    // A detection that finds nothing is indistinguishable from one that failed, so it announces
    // nothing and no consumer tears down the route it already chose.
    expect(manager.getSystemProxy()).toBeNull()
    expect(seen).toEqual([])

    detected = 'http://127.0.0.1:7890'
    expect(manager.getSystemProxy(true)).toBe('http://127.0.0.1:7890')
    expect(seen).toEqual(['http://127.0.0.1:7890'])

    // The same proxy on every later detection is not news: consumers already acted on it.
    expect(manager.getSystemProxy(true)).toBe('http://127.0.0.1:7890')
    expect(seen).toEqual(['http://127.0.0.1:7890'])

    stop()
    detected = null
    manager.getSystemProxy(true)
    detected = 'http://127.0.0.1:9999'
    manager.getSystemProxy(true)
    expect(seen).toEqual(['http://127.0.0.1:7890'])

    manager.dispose()
  })

  it('never announces the first detection, which is the caller\'s own result', () => {
    const manager = new ProxyManager({
      getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }),
      systemProxyDetector: () => 'http://127.0.0.1:7890',
    })
    const seen: string[] = []
    manager.onSystemProxyDetected(proxy => seen.push(proxy))

    expect(manager.getSystemProxy()).toBe('http://127.0.0.1:7890')
    expect(seen).toEqual([])

    manager.dispose()
  })

  it('keeps detecting when an observing listener throws', () => {
    let detected: string | null = null
    const manager = new ProxyManager({
      getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }),
      systemProxyDetector: () => detected,
    })
    manager.getSystemProxy()
    manager.onSystemProxyDetected(() => { throw new Error('listener exploded') })
    detected = 'http://127.0.0.1:7890'

    expect(manager.getSystemProxy(true)).toBe('http://127.0.0.1:7890')

    manager.dispose()
  })

  it('waits out a slow TLS handshake to the origin behind the proxy', async () => {
    // A proxy that opens the tunnel and then stalls, so the TLS handshake
    // with the origin never completes.
    //
    // undici's default connect budget is 10s, and it covers that handshake,
    // not merely the hop to the proxy: a proxy whose route to chatgpt.com
    // went through a slow node measured 1.2s to 18s for it, so the default
    // killed requests that would have succeeded seconds later - and killed
    // them as an opaque 'fetch failed' that never named the proxy.
    const sockets: net.Socket[] = []
    const server = net.createServer((socket) => {
      sockets.push(socket)
      let tunnelled = false
      socket.on('data', () => {
        if (tunnelled) return
        tunnelled = true
        // Answer the CONNECT, then go silent so the handshake stalls.
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
        setTimeout(() => socket.destroy(), 11_500)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port

    const manager = new ProxyManager({
      getPreferences: () => ({ proxyMode: 'custom', customProxyUrl: 'http://127.0.0.1:' + port }),
    })

    const started = Date.now()
    const error = await manager.createFetch()('https://example.com/').then(() => null, (caught: unknown) => caught)
    const elapsed = Date.now() - started

    manager.dispose()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))

    expect(error).toBeTruthy()
    // The stall, not a timeout: the budget outlived undici's 10s default, so
    // the handshake was still in flight when the proxy tore the tunnel down.
    expect(elapsed).toBeGreaterThan(10_000)
    const code = (error as { cause?: { code?: string } }).cause?.code
    expect(code).not.toBe('UND_ERR_CONNECT_TIMEOUT')
  })
})

describe('Linux GNOME Proxy Parser', () => {
  function reader(values: Record<string, string>) {
    return (key: string): string | null => values[key] ?? null
  }

  it('reads the manual https proxy, the way gsettings prints it', () => {
    expect(parseLinuxSystemProxy(reader({
      'org.gnome.system.proxy mode': "'manual'",
      'org.gnome.system.proxy.https host': "'127.0.0.1'",
      'org.gnome.system.proxy.https port': '7890',
    }))).toBe('http://127.0.0.1:7890')
  })

  it('prefers https over http over socks', () => {
    const values = {
      'org.gnome.system.proxy mode': "'manual'",
      'org.gnome.system.proxy.https host': "'127.0.0.1'",
      'org.gnome.system.proxy.https port': '8443',
      'org.gnome.system.proxy.http host': "'127.0.0.1'",
      'org.gnome.system.proxy.http port': '8080',
      'org.gnome.system.proxy.socks host': "'127.0.0.1'",
      'org.gnome.system.proxy.socks port': '1080',
    }
    expect(parseLinuxSystemProxy(reader(values))).toBe('http://127.0.0.1:8443')
    expect(parseLinuxSystemProxy(reader({ ...values, 'org.gnome.system.proxy.https host': "''" }))).toBe('http://127.0.0.1:8080')
    expect(parseLinuxSystemProxy(reader({
      'org.gnome.system.proxy mode': "'manual'",
      'org.gnome.system.proxy.socks host': "'127.0.0.1'",
      'org.gnome.system.proxy.socks port': '1080',
    }))).toBe('socks5://127.0.0.1:1080')
  })

  it('ignores a PAC URL, a disabled proxy, and an unreadable gsettings', () => {
    expect(parseLinuxSystemProxy(reader({ 'org.gnome.system.proxy mode': "'auto'" }))).toBeNull()
    expect(parseLinuxSystemProxy(reader({ 'org.gnome.system.proxy mode': "'none'" }))).toBeNull()
    // The headless case: no dconf session to ask, and gsettings is not installed.
    expect(parseLinuxSystemProxy(() => null)).toBeNull()
  })

  it('refuses a host without a usable port, and brackets an IPv6 host', () => {
    expect(parseLinuxSystemProxy(reader({
      'org.gnome.system.proxy mode': "'manual'",
      'org.gnome.system.proxy.https host': "'127.0.0.1'",
      'org.gnome.system.proxy.https port': '0',
    }))).toBeNull()
    expect(parseLinuxSystemProxy(reader({
      'org.gnome.system.proxy mode': "'manual'",
      'org.gnome.system.proxy.https host': "''",
      'org.gnome.system.proxy.https port': '7890',
    }))).toBeNull()
    expect(parseLinuxSystemProxy(reader({
      'org.gnome.system.proxy mode': "'manual'",
      'org.gnome.system.proxy.https host': "'::1'",
      'org.gnome.system.proxy.https port': '7890',
    }))).toBe('http://[::1]:7890')
  })
})

describe('Linux system proxy detection', () => {
  it('asks gsettings before the environment on linux', () => {
    const detected = detectSystemProxy('linux', { HTTPS_PROXY: 'http://127.0.0.1:9999' }, (key) => ({
      'org.gnome.system.proxy mode': "'manual'",
      'org.gnome.system.proxy.https host': "'127.0.0.1'",
      'org.gnome.system.proxy.https port': '7890',
    } as Record<string, string>)[key] ?? null)
    expect(detected).toBe('http://127.0.0.1:7890')
  })

  it('falls back to the environment when the desktop reports nothing', () => {
    expect(detectSystemProxy('linux', { HTTPS_PROXY: 'http://127.0.0.1:8888' }, () => null)).toBe('http://127.0.0.1:8888')
  })
})

describe('NO_PROXY reading and matching', () => {
  it('reads either spelling from the environment', () => {
    expect(parseNoProxy({ NO_PROXY: ' .corp.example ' }, { envFile: null })).toBe('.corp.example')
    expect(parseNoProxy({ no_proxy: '*' }, { envFile: null })).toBe('*')
    expect(parseNoProxy({}, { envFile: null })).toBe('')
  })

  it('reads the list from $DSH_HOME/.env when the environment has none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-noproxy-'))
    const envFile = path.join(dir, '.env')
    fs.writeFileSync(envFile, "export NO_PROXY='.corp.example,localhost:9090'\n", 'utf8')
    try {
      expect(parseNoProxy({}, { envFile })).toBe('.corp.example,localhost:9090')
      // An empty assignment is not a list, and neither is a commented one.
      fs.writeFileSync(envFile, '# NO_PROXY=everything\nNO_PROXY=\n', 'utf8')
      expect(parseNoProxy({}, { envFile })).toBe('')
    } finally {
      fs.rmSync(envFile, { force: true })
      fs.rmdirSync(dir)
    }
  })

  it('bypasses loopback whatever the list says', () => {
    expect(shouldBypassProxy('http://127.0.0.1:9090/v1/messages')).toBe(true)
    expect(shouldBypassProxy('http://127.42.0.9:8080/')).toBe(true)
    expect(shouldBypassProxy('http://localhost:11434/api/chat')).toBe(true)
    expect(shouldBypassProxy('http://[::1]:3000/')).toBe(true)
    // A public host keeps the proxy: cline / ollama / opendesign all live there.
    expect(shouldBypassProxy('https://api.cline.bot/api/v1')).toBe(false)
    expect(shouldBypassProxy('https://ollama.com/api/tags')).toBe(false)
  })

  it('matches *, suffixes, exact hosts and host:port entries', () => {
    expect(shouldBypassProxy('https://api.corp.example/v1', '*')).toBe(true)
    expect(shouldBypassProxy('https://api.corp.example/v1', '.corp.example')).toBe(true)
    expect(shouldBypassProxy('https://corp.example/v1', 'corp.example')).toBe(true)
    expect(shouldBypassProxy('https://api.corp.example/v1', 'other.example')).toBe(false)
    expect(shouldBypassProxy('http://gateway.lan:8080/', 'gateway.lan:8080')).toBe(true)
    expect(shouldBypassProxy('http://gateway.lan:9090/', 'gateway.lan:8080')).toBe(false)
    expect(shouldBypassProxy('https://api.openai.com/', 'http://api.openai.com/')).toBe(true)
    expect(shouldBypassProxy('https://api.openai.com/', ' not-a-host , \napi.openai.com')).toBe(true)
  })

  it('does not bypass a target it cannot parse', () => {
    expect(shouldBypassProxy('/relative/path')).toBe(false)
  })
})

describe('ProxyManager bypass path', () => {
  it('sends a loopback request straight to baseFetch while a proxy is active', async () => {
    const baseFetch = vi.fn(async () => new Response('local', { status: 200 }))
    const manager = new ProxyManager({
      getPreferences: () => ({ proxyMode: 'custom', customProxyUrl: 'http://127.0.0.1:1' }),
      baseFetch: baseFetch as any,
      noProxyReader: () => '',
    })

    const response = await manager.createFetch()('http://127.0.0.1:9090/admin', { method: 'POST' })
    expect(await response.text()).toBe('local')
    expect(baseFetch).toHaveBeenCalledTimes(1)

    // A Request carries the same URL and must bypass just the same.
    await manager.createFetch()(new Request('http://localhost:11434/api/chat'))
    expect(baseFetch).toHaveBeenCalledTimes(2)

    manager.dispose()
  })

  it('honors NO_PROXY for a host that would otherwise be proxied', async () => {
    const baseFetch = vi.fn(async () => new Response('direct', { status: 200 }))
    const manager = new ProxyManager({
      getPreferences: () => ({ proxyMode: 'custom', customProxyUrl: 'http://127.0.0.1:1' }),
      baseFetch: baseFetch as any,
      noProxyReader: () => ' .corp.example ,gateway.lan:8080 ',
    })

    expect(await (await manager.createFetch()('https://api.corp.example/v1')).text()).toBe('direct')
    expect(baseFetch).toHaveBeenCalledTimes(1)

    manager.dispose()
  })

  it('keeps the proxy for a host the list does not name', async () => {
    const baseFetch = vi.fn(async () => new Response('should not run', { status: 200 }))
    const manager = new ProxyManager({
      getPreferences: () => ({ proxyMode: 'custom', customProxyUrl: 'http://127.0.0.1:1' }),
      baseFetch: baseFetch as any,
      noProxyReader: () => 'corp.example',
    })

    await expect(manager.createFetch()('https://api.example.com/v1')).rejects.toThrow()
    expect(baseFetch).not.toHaveBeenCalled()

    manager.dispose()
  })

  it('re-reads the list after the TTL and treats a throwing reader as empty', () => {
    let list = 'corp.example'
    const manager = new ProxyManager({
      getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }),
      systemProxyDetector: () => 'http://127.0.0.1:7890',
      noProxyReader: () => list,
    })
    expect(manager.getNoProxyList()).toBe('corp.example')
    list = 'other.example'
    // Cached for the TTL, so the new value is invisible until a forced read.
    expect(manager.getNoProxyList()).toBe('corp.example')
    expect(manager.getNoProxyList(true)).toBe('other.example')

    const broken = new ProxyManager({
      getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }),
      noProxyReader: () => { throw new Error('unreadable') },
    })
    expect(broken.getNoProxyList()).toBe('')
    broken.dispose()
    manager.dispose()
  })
})

describe('ProxyManager destroyed-client recovery', () => {
  const destroyedError = () => new TypeError('terminated', { cause: new Error('The client is destroyed') })

  function managerWith(proxyFetchFn: unknown): ProxyManager {
    return new ProxyManager({
      getPreferences: () => ({ proxyMode: 'custom', customProxyUrl: 'http://127.0.0.1:7890' }),
      baseFetch: (async () => new Response('direct', { status: 200 })) as never,
      proxyFetchFn: proxyFetchFn as never,
      noProxyReader: () => '',
    })
  }

  it('evicts a destroyed client and retries once on a fresh connection', async () => {
    const dispatchers: unknown[] = []
    const proxyFetchFn = vi.fn(async (_input: unknown, init?: { dispatcher?: unknown }) => {
      dispatchers.push(init?.dispatcher)
      if (dispatchers.length === 1) throw destroyedError()
      return new Response('ok', { status: 200 })
    })
    const manager = managerWith(proxyFetchFn)
    const response = await manager.createFetch()('https://api.example.com/v1/chat/completions')
    expect(await response.text()).toBe('ok')
    // One replay, on a NEW agent: reusing the cached one is what would keep the
    // line broken until a restart.
    expect(proxyFetchFn).toHaveBeenCalledTimes(2)
    expect(dispatchers[0]).not.toBe(dispatchers[1])
    manager.dispose()
  })

  it('does not replay an ordinary transport failure', async () => {
    const proxyFetchFn = vi.fn(async () => { throw new TypeError('fetch failed') })
    const manager = managerWith(proxyFetchFn)
    await expect(manager.createFetch()('https://api.example.com/v1')).rejects.toThrow('fetch failed')
    expect(proxyFetchFn).toHaveBeenCalledTimes(1)
    manager.dispose()
  })
})
