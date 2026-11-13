/**
 * Binary resolution and download.
 *
 * No test here touches the network: the archive is either already a fixture file
 * or fetched through an injected `fetch`. What is asserted is the order in which
 * candidates are tried, and the two safety properties that make the download
 * acceptable at all - a redirect is refused, and a hash mismatch deletes the
 * bytes instead of executing them.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import {
  ACP_BINARY_RELEASES,
  cachedExecutablePath,
  downloadRelease,
  localCliCandidates,
  resolveAcpBinary,
} from '../src/host/antigravity-acp/binary.ts'

/** Build a ZIP with one deflated entry. */
function zipOf(name: string, content: string): Buffer {
  const nameBytes = Buffer.from(name, 'utf8')
  const raw = Buffer.from(content, 'utf8')
  const compressed = deflateRawSync(raw)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(raw.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(raw.length, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt32LE(0, 42)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + nameBytes.length, 12)
  end.writeUInt32LE(local.length + nameBytes.length + compressed.length, 16)
  return Buffer.concat([local, nameBytes, compressed, central, nameBytes, end])
}

function workspace(): { dir: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'acp-binary-test-'))
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('candidate discovery', () => {
  it('looks for the local CLI under ~/.gemini/bin, Windows extension first', () => {
    expect(localCliCandidates('C:/Users/a', 'win32')).toEqual([
      join('C:/Users/a', '.gemini', 'bin', 'agy.exe'),
      join('C:/Users/a', '.gemini', 'bin', 'agy.cmd'),
      join('C:/Users/a', '.gemini', 'bin', 'agy'),
    ])
    expect(localCliCandidates('C:/Users/a', 'linux')).toEqual([join('C:/Users/a', '.gemini', 'bin', 'agy')])
  })

  it('prefers a usable local CLI over the download', async () => {
    const space = workspace()
    const binDir = join(space.dir, '.gemini', 'bin')
    mkdirSync(binDir, { recursive: true })
    const local = join(binDir, 'agy')
    writeFileSync(local, 'binary', 'utf8')
    try {
      const resolved = await resolveAcpBinary(null, {
        platform: 'linux-x64',
        home: () => space.dir,
        env: {},
        cacheRoot: () => join(space.dir, 'cache'),
        readVersion: async (command) => (command === local ? '1.5.3' : undefined),
      })
      expect(resolved.binary).toMatchObject({ path: local, kind: 'local-cli', version: '1.5.3' })
    } finally {
      space.dispose()
    }
  })

  it('skips a file that exists but does not answer --version', async () => {
    const space = workspace()
    const broken = join(space.dir, '.gemini', 'bin', 'agy')
    mkdirSync(join(space.dir, '.gemini', 'bin'), { recursive: true })
    writeFileSync(broken, 'not really a binary', 'utf8')
    try {
      const resolved = await resolveAcpBinary(null, {
        platform: 'linux-x64',
        home: () => space.dir,
        env: {},
        cacheRoot: () => join(space.dir, 'cache'),
        readVersion: async () => undefined,
        fetchFn: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
      })
      // A broken shim must not be reported as usable; the resolution reports why
      // nothing was found instead.
      expect(resolved.binary).toBeUndefined()
      expect(resolved.diagnostics.error).toContain('500')
    } finally {
      space.dispose()
    }
  })
})

describe('downloadRelease', () => {
  const release = {
    version: '9.9.9',
    url: 'https://example.invalid/archive.zip',
    sha256: '',
    executable: 'agy_acp_server.exe',
  }

  it('extracts a verified archive into the cache and returns the executable', async () => {
    const space = workspace()
    const archive = zipOf(release.executable, 'MZ fake binary')
    const withHash = { ...release, sha256: (await import('node:crypto')).createHash('sha256').update(archive).digest('hex') }
    try {
      const path = await downloadRelease(withHash, space.dir, (async () => new Response(archive)) as unknown as typeof fetch)
      expect(path).toBe(cachedExecutablePath(space.dir, withHash))
      expect(readFileSync(path, 'utf8')).toBe('MZ fake binary')
    } finally {
      space.dispose()
    }
  })

  it('deletes the bytes and refuses when the hash does not match', async () => {
    const space = workspace()
    const archive = zipOf(release.executable, 'MZ fake binary')
    try {
      await expect(
        downloadRelease({ ...release, sha256: 'deadbeef' }, space.dir, (async () => new Response(archive)) as unknown as typeof fetch),
      ).rejects.toThrow(/sha256/)
      expect(() => readFileSync(cachedExecutablePath(space.dir, release), 'utf8')).toThrow()
    } finally {
      space.dispose()
    }
  })

  it('refuses a redirect instead of following it', async () => {
    const space = workspace()
    try {
      await expect(
        downloadRelease({ ...release, sha256: 'x' }, space.dir, (async () => new Response('moved', { status: 302, headers: { location: 'https://elsewhere.invalid/x.zip' } })) as unknown as typeof fetch),
      ).rejects.toThrow(/302/)
    } finally {
      space.dispose()
    }
  })
})

describe('the pinned registry entry', () => {
  it('publishes an archive for the six platforms the registry lists', () => {
    expect(Object.keys(ACP_BINARY_RELEASES).sort()).toEqual([
      'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64',
    ])
    for (const release of Object.values(ACP_BINARY_RELEASES)) {
      expect(release.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(release.url.startsWith('https://dl.google.com/')).toBe(true)
    }
  })
})
