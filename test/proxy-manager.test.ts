import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agent, ProxyAgent, fetch as realUndiciFetch } from 'undici'
import {
  ProxyManager,
  buildNativeConnector,
  detectSystemProxy,
  normalizeProxyUrl,
  parseEnvProxy,
  parseLinuxSystemProxy,
  parseMacOsScutilProxy,
  parseNoProxy,
  parseWindowsProxyRegistry,
  proxyAgentOptions,
  shouldBypassProxy,
  stripDispatchHeaders,
} from '../src/host/proxy-manager.ts'

/**
 * 本文件不许真的跑系统探测命令。
 *
 * `detectSystemProxy()` 的 win32 分支跑 `reg query`、macOS 分支跑 `scutil`、Linux 分支跑
 * `gsettings`；放任它们真跑，等于让每次 `npm test` 在跑测试的机器上 fork 真实进程。
 * 这里换成「记录 + 固定回显」的替身：#19 / #91 的回归点（探测必须带 `windowsHide`，
 * 且不再经过 `cmd.exe`）于是变成一条可以断言的调用记录。
 *
 * 夹具只能写死在这里：`vi.mock` 的工厂会被提升到全部 import 之前求值，引用外面的
 * `const` 会撞上 TDZ。
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const fixtures: Record<string, string> = {
    'reg.exe': '    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    127.0.0.1:7890\n',
    scutil: '  HTTPSEnable : 1\n  HTTPSPort : 8443\n  HTTPSProxy : 127.0.0.1\n',
    gsettings: "'manual'",
  }
  const execFileSync = vi.fn((file: string, _args: readonly string[], _options: Record<string, unknown>) => fixtures[file] ?? '')
  return { ...actual, execFileSync }
})

const childProcess = await import('node:child_process')
const probeSpy = vi.mocked(childProcess.execFileSync)

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

describe('System probe launch shape (#19 / #91)', () => {
  beforeEach(() => {
    probeSpy.mockClear()
  })

  function probeCall(index = 0): { file: string; args: readonly string[]; options: Record<string, unknown> } {
    const [file, args, options] = probeSpy.mock.calls[index] as unknown as [
      string,
      readonly string[],
      Record<string, unknown>,
    ]
    return { file, args, options }
  }

  it('runs reg.exe directly and hides its console window', () => {
    expect(detectSystemProxy('win32', {})).toBe('http://127.0.0.1:7890')

    const probe = probeCall()
    // 直接起 reg.exe：中间那层 `cmd.exe /d /s /c` 正是 Windows 给无控制台宿主新分配可见控制台的那一层。
    expect(probe.file).toBe('reg.exe')
    expect(probe.args).toEqual(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'])
    expect(probe.options).toMatchObject({ windowsHide: true })
  })

  it('hides the console window of the macOS scutil probe', () => {
    expect(detectSystemProxy('darwin', {})).toBe('http://127.0.0.1:8443')

    const probe = probeCall()
    expect(probe.file).toBe('scutil')
    expect(probe.args).toEqual(['--proxy'])
    expect(probe.options).toMatchObject({ windowsHide: true })
  })

  it('hides the console window of the Linux gsettings probe', () => {
    // 替身对每个键都回同一个值，于是解析不出可用代理，探测按设计回落到环境变量。
    expect(detectSystemProxy('linux', { HTTPS_PROXY: 'http://127.0.0.1:9999' })).toBe('http://127.0.0.1:9999')

    const probe = probeCall()
    expect(probe.file).toBe('gsettings')
    expect(probe.args).toEqual(['get', 'org.gnome.system.proxy mode'])
    expect(probe.options).toMatchObject({ windowsHide: true })
  })

  it('falls back to the environment when the probe itself fails', () => {
    // 沙箱里没有 reg.exe、或权限不足时，探测失败不能变成「这条线路没代理可用」。
    probeSpy.mockImplementationOnce(() => {
      throw new Error('spawn reg.exe ENOENT')
    })
    expect(detectSystemProxy('win32', { HTTPS_PROXY: 'http://127.0.0.1:9999' })).toBe('http://127.0.0.1:9999')
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

describe('ProxyManager protocol pinning', () => {
  const PROXY = 'http://127.0.0.1:7890'

  function pinnedManager(proxyFetchFn: unknown): ProxyManager {
    return new ProxyManager({
      getPreferences: () => ({ proxyMode: 'custom', customProxyUrl: PROXY }),
      baseFetch: (async () => new Response('direct', { status: 200 })) as never,
      proxyFetchFn: proxyFetchFn as never,
      noProxyReader: () => '',
    })
  }

  it('states allowH2 only when HTTP/1.1 is pinned', () => {
    // An absent key leaves undici's negotiation exactly as it was; only the
    // explicit `false` takes h2 out of the tunnel's ALPN offer.
    expect(proxyAgentOptions(PROXY)).toEqual({ uri: PROXY, connectTimeout: 60_000 })
    expect(proxyAgentOptions(PROXY, true)).toEqual({ uri: PROXY, connectTimeout: 60_000 })
    expect(proxyAgentOptions(PROXY, false)).toEqual({ uri: PROXY, connectTimeout: 60_000, allowH2: false })
  })

  it('keeps one pool per protocol policy and never reuses across them', async () => {
    const dispatchers: unknown[] = []
    const proxyFetchFn = vi.fn(async (_input: unknown, init?: { dispatcher?: unknown }) => {
      dispatchers.push(init?.dispatcher)
      return new Response('ok', { status: 200 })
    })
    const manager = pinnedManager(proxyFetchFn)
    const negotiate = manager.createFetch()
    const pinned = manager.createFetch({ allowH2: false })

    await negotiate('https://api.example.com/v1')
    await negotiate('https://api.example.com/v1')
    await pinned('https://api.example.com/v1')
    await pinned('https://api.example.com/v1')

    // Same policy reuses its agent; the h1 pin must never land on the h2 pool.
    expect(dispatchers[0]).toBe(dispatchers[1])
    expect(dispatchers[2]).toBe(dispatchers[3])
    expect(dispatchers[0]).not.toBe(dispatchers[2])
    manager.dispose()
  })
})

describe('ProxyManager credential pools', () => {
  const PROXY = 'http://127.0.0.1:7890'
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

  function capturingManager(
    proxyMode: 'custom' | 'direct',
    dispatchers: unknown[],
    baseFetch?: unknown,
  ): ProxyManager {
    return new ProxyManager({
      getPreferences: () => ({ proxyMode, customProxyUrl: PROXY }),
      baseFetch: (baseFetch ?? (async () => new Response('direct', { status: 200 }))) as never,
      proxyFetchFn: (async (_input: unknown, init?: { dispatcher?: unknown }) => {
        dispatchers.push(init?.dispatcher)
        return new Response('ok', { status: 200 })
      }) as never,
      noProxyReader: () => '',
    })
  }

  it('gives every credential its own pool and reuses it for that credential alone', async () => {
    const dispatchers: unknown[] = []
    const manager = capturingManager('custom', dispatchers)
    const fetchWith = manager.createFetch({ allowH2: false, credentialPools: true })

    await fetchWith('https://api.example.com/v1', { headers: bearer('token-a') })
    await fetchWith('https://api.example.com/v1', { headers: bearer('token-a') })
    await fetchWith('https://api.example.com/v1', { headers: bearer('token-b') })

    expect(dispatchers[0]).toBeInstanceOf(ProxyAgent)
    expect(dispatchers[0]).toBe(dispatchers[1])
    // A second account must not ride the first account's connection: one
    // connection carrying several `Authorization` values is a rotation, which no
    // native client ever produces.
    expect(dispatchers[2]).not.toBe(dispatchers[0])
    manager.dispose()
  })

  it('pools direct traffic per credential instead of using the process-wide fetch', async () => {
    const dispatchers: unknown[] = []
    const baseFetch = vi.fn(async () => new Response('shared', { status: 200 }))
    const manager = capturingManager('direct', dispatchers, baseFetch)
    const fetchWith = manager.createFetch({ allowH2: false, credentialPools: true })

    await fetchWith('https://api.example.com/v1', { headers: bearer('token-a') })
    await fetchWith('https://api.example.com/v1', { headers: bearer('token-a') })
    await fetchWith('https://api.example.com/v1', { headers: bearer('token-b') })

    // Node's global fetch has one process-wide pool, so a credentialed request
    // cannot be given a private connection through it.
    expect(baseFetch).not.toHaveBeenCalled()
    expect(dispatchers[0]).toBeInstanceOf(Agent)
    expect(dispatchers[0]).not.toBeInstanceOf(ProxyAgent)
    expect(dispatchers[0]).toBe(dispatchers[1])
    expect(dispatchers[2]).not.toBe(dispatchers[0])
    manager.dispose()
  })

  it('keeps uncredentialed calls on the shared pool', async () => {
    const dispatchers: unknown[] = []
    const baseFetch = vi.fn(async () => new Response('shared', { status: 200 }))
    const manager = capturingManager('direct', dispatchers, baseFetch)
    const fetchWith = manager.createFetch({ allowH2: false, credentialPools: true })

    const response = await fetchWith('https://api.example.com/manifest.yml', {
      headers: { 'User-Agent': 'electron-builder' },
    })

    // The Hub manifest read carries no credential, so it belongs to no account
    // and must not mint a pool per install.
    expect(await response.text()).toBe('shared')
    expect(baseFetch).toHaveBeenCalledTimes(1)
    expect(dispatchers).toHaveLength(0)
    manager.dispose()
  })
})

describe('ProxyManager native request shape', () => {
  const PROXY = 'http://127.0.0.1:7890'

  it('drops the headers fetch adds on its own, in both header shapes', () => {
    const received: unknown[] = []
    const inner = {
      dispatch: (options: Record<string, unknown>, _handler?: unknown) => { received.push(options.headers); return true },
      close: () => undefined,
      destroy: () => undefined,
    }
    const shaped = stripDispatchHeaders(inner, ['sec-fetch-mode', 'accept-language'])

    shaped.dispatch({ headers: { authorization: 'Bearer t', 'sec-fetch-mode': 'cors', 'accept-language': '*', 'user-agent': 'ua' } }, {})
    shaped.dispatch({ headers: [['sec-fetch-mode', 'cors'], ['authorization', 'Bearer t']] }, {})

    expect(received[0]).toEqual({ authorization: 'Bearer t', 'user-agent': 'ua' })
    expect(received[1]).toEqual([['authorization', 'Bearer t']])
  })

  it('offers no ALPN on the native connector, and still sends SNI', () => {
    const seen: Array<Record<string, unknown>> = []
    const connectTls = ((options: Record<string, unknown>) => {
      seen.push(options)
      return { setTimeout: () => undefined, once: () => undefined, destroy: () => undefined } as never
    }) as never

    const connector = buildNativeConnector({ connectTls, timeoutMs: 1_000 })
    connector({ hostname: 'cloudcode-pa.googleapis.com', protocol: 'https:', port: '' } as never, () => {})

    expect(seen[0]).toMatchObject({
      host: 'cloudcode-pa.googleapis.com',
      port: 443,
      servername: 'cloudcode-pa.googleapis.com',
    })
    // The whole point: no ALPN extension is offered at all.
    expect('ALPNProtocols' in seen[0]).toBe(false)
  })

  it('keeps sec-fetch-mode and accept-language off the wire', async () => {
    const raw: string[][] = []
    const server = http.createServer((request, response) => {
      raw.push(request.rawHeaders)
      response.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const manager = new ProxyManager({
      getPreferences: () => ({ proxyMode: 'direct', customProxyUrl: '' }),
      baseFetch: (async () => new Response('shared')) as never,
      proxyFetchFn: realUndiciFetch as never,
      noProxyReader: () => '',
    })
    try {
      const fetchWith = manager.createFetch({
        allowH2: false,
        credentialPools: true,
        stripHeaders: ['sec-fetch-mode', 'accept-language'],
        omitAlpn: true,
      })
      const response = await fetchWith(`http://127.0.0.1:${port}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: '{}',
      })
      expect(await response.text()).toBe('ok')
    } finally {
      manager.dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    const names = raw[0].filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase())
    expect(names).not.toContain('sec-fetch-mode')
    expect(names).not.toContain('accept-language')
    expect(names).toContain('authorization')
  })

  it('uses its own dispatcher once a header shape is requested', async () => {
    const dispatchers: unknown[] = []
    const baseFetch = vi.fn(async () => new Response('shared', { status: 200 }))
    const manager = new ProxyManager({
      getPreferences: () => ({ proxyMode: 'custom', customProxyUrl: PROXY }),
      baseFetch: baseFetch as never,
      proxyFetchFn: (async (_input: unknown, init?: { dispatcher?: unknown }) => {
        dispatchers.push(init?.dispatcher)
        return new Response('ok', { status: 200 })
      }) as never,
      noProxyReader: () => '',
    })
    const fetchWith = manager.createFetch({
      allowH2: false,
      credentialPools: true,
      stripHeaders: ['sec-fetch-mode'],
      omitAlpn: true,
    })
    await fetchWith('https://api.example.com/v1', { headers: { Authorization: 'Bearer t' } })

    expect(baseFetch).not.toHaveBeenCalled()
    const shaped = dispatchers[0] as { dispatch?: unknown; wrapped?: unknown }
    expect(typeof shaped.dispatch).toBe('function')
    // The wrapper filters headers; the pooled agent underneath is what connects.
    expect(shaped.wrapped).toBeInstanceOf(ProxyAgent)
    manager.dispose()
  })
})
