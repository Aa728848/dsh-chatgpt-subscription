/**
 * Finding, and when necessary fetching, the official Antigravity CLI executable.
 *
 * Three rules shape this module:
 *
 * 1. **A usable local CLI wins.** Most people who want this line already have
 *    Antigravity installed, and running their own signed binary is both more
 *    honest and more current than a copy this plugin fetched. The download is a
 *    fallback, not the default.
 * 2. **The published archive is verified, never trusted.** The `sha256` comes
 *    from the official ACP Registry entry and is pinned in this file; a byte that
 *    does not match is deleted, not executed. Redirects are refused so a moved
 *    archive cannot redirect the fetch somewhere else.
 * 3. **Nothing is installed system-wide.** The extracted files live under
 *    `<DSH_HOME>/cache/antigravity-acp/<version>/`, are never copied into PATH,
 *    and are removed by name on failure - this repository forbids recursive
 *    deletion, and a cache directory is exactly where a stray recursive delete
 *    would do the most damage.
 *
 * @module dsh-chatgpt-subscription/host/antigravity-acp/binary
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { dshHomeDir } from '../common/home.ts'
import { BINARY_CACHE_DIR, BINARY_ENV_VAR } from './types.ts'

/** One downloadable archive for one platform, transcribed from the official ACP Registry. */
export interface AcpBinaryRelease {
  /** Registry version this entry describes. */
  version: string
  /** Archive URL. */
  url: string
  /** sha256 of the archive, as the registry publishes it. */
  sha256: string
  /** Executable inside the extracted archive, relative to the extraction root. */
  executable: string
}

/**
 * The registry entry this build was verified against.
 *
 * Source: `https://github.com/agentclientprotocol/registry` →
 * `antigravity-acp/agent.json`, fetched 2026-11-12. `license: proprietary`;
 * the archive is fetched from `dl.google.com` at install time and is never
 * redistributed with this package.
 */
export const ACP_BINARY_VERSION = '1.5.0'

/** Platform archives, keyed by `process.platform` + `process.arch`. */
export const ACP_BINARY_RELEASES: Readonly<Record<string, AcpBinaryRelease>> = {
  'win32-x64': {
    version: ACP_BINARY_VERSION,
    url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.5.0-windows-x86_64.zip',
    sha256: '6163f6b59b381bae419652dbae167bc8cda0ef29d665c0ba8af3d8c7fddd8867',
    executable: 'agy_acp_server.exe',
  },
  'win32-arm64': {
    version: ACP_BINARY_VERSION,
    url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.5.0-windows-arm64.zip',
    sha256: '340092b8af6dafc71eb15f4a8ec54b4d1f0bce16d1fa4d163b562c50b905f8f4',
    executable: 'agy_acp_server.exe',
  },
  'darwin-arm64': {
    version: ACP_BINARY_VERSION,
    url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.0-darwin-arm64.zip',
    sha256: 'c82ecb4ef476bfc35cbe5b2745cdddef873b99c9f5bd7fd11e5ca1fc1667a3fc',
    executable: 'agy_acp_server.par',
  },
  'darwin-x64': {
    version: ACP_BINARY_VERSION,
    url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.0-darwin-x86_64.zip',
    sha256: '86a94e33b25d4a38ff30526ad844546860aa9ed98698498d9e87d30eb794426e',
    executable: 'agy_acp_server.par',
  },
  'linux-x64': {
    version: ACP_BINARY_VERSION,
    url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.0-linux-x86_64.zip',
    sha256: '36f373e8948edf1727b39c7d62b5722d6a4474bdfd72b04ad3d6def571808c9f',
    executable: 'agy_acp_server.par',
  },
  'linux-arm64': {
    version: ACP_BINARY_VERSION,
    url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.0-linux-arm64.zip',
    sha256: '1e184f439477b54138e94440056b26a78c0a8075a8fd2ffda637ec31267c6459',
    executable: 'agy_acp_server.par',
  },
}

/** Largest archive this line will download; the Windows build is ~80 MB. */
export const ACP_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

/** A resolved executable. */
export interface ResolvedAcpBinary {
  /** Absolute path to the executable. */
  path: string
  /** How it was found. */
  kind: 'configured' | 'local-cli' | 'downloaded'
  /** The CLI version when it could be read. */
  version?: string
}

/**
 * Arguments for the resolved executable.
 * The registry's standalone server already speaks ACP on stdio and rejects the
 * full CLI's acp and disable-telemetry flags. Detect configured paths too.
 */
export function acpLaunchArgs(binary: ResolvedAcpBinary): string[] {
  const executable = path.basename(binary.path).toLowerCase()
  const standalone = binary.kind === 'downloaded'
    || executable === 'agy_acp_server.exe'
    || executable === 'agy_acp_server.par'
  return standalone ? [] : ['acp', '--disable-telemetry']
}

/** Where a resolution attempt looked and what it found, for the status card. */
export interface AcpBinaryDiagnostics {
  /** Every candidate path tried, in order. */
  tried: string[]
  /** The failure that ended the search, when nothing usable was found. */
  error?: string
  /**
   * True when the search stopped short of installing: nothing local was found and
   * this read was not allowed to download. The card says so instead of claiming
   * the download failed - it was never attempted.
   */
  deferred?: boolean
}

/** Test seams so this module can be exercised with no network and no home directory. */
export interface AcpBinaryOptions {
  /** Platform key; defaults to the running platform. */
  platform?: string
  /** Directory the download cache lives in. */
  cacheRoot?(): string
  /** `fetch` implementation. */
  fetchFn?: typeof fetch
  /** Environment the `DSH_ANTIGRAVITY_ACP_BIN` override is read from. */
  env?: NodeJS.ProcessEnv
  /** Home directory used to find `~/.gemini/bin/agy`. */
  home?(): string
  /** Reads the CLI version; returns undefined when the binary does not answer. */
  readVersion?(command: string): Promise<string | undefined>
  /**
   * Whether a missing executable may be downloaded.
   *
   * A *passive* read (the settings card rendering, the composer badge polling) may
   * not: downloading a ~100 MB archive is an action, and it used to happen behind
   * a page render for a user who had not asked for anything. Only an explicit
   * action - a refresh click, the self-check, or an actual turn - sets this true.
   * Defaults to true so every existing caller keeps the active behaviour.
   */
  download?: boolean
}

/** How long a resolved executable is reused before the disk is read again. */
export const BINARY_CACHE_TTL_MS = 5 * 60_000

/** One resolution result, exactly as the resolver returned it. */
export interface AcpBinaryResolution {
  binary?: ResolvedAcpBinary
  diagnostics: AcpBinaryDiagnostics
}

/** Candidate paths the local CLI may live at, most specific first. */
export function localCliCandidates(home: string, platform: string): string[] {
  const names = platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy'] : ['agy']
  return names.map((name) => path.join(home, '.gemini', 'bin', name))
}

/** Absolute path of the cached executable for one release. */
export function cachedExecutablePath(root: string, release: AcpBinaryRelease): string {
  return path.join(root, release.version, release.executable)
}

/**
 * Resolve the executable this line should run.
 *
 * Order: an explicit setting, the environment override, the local Antigravity
 * CLI, then the verified download. A candidate that exists but does not answer
 * `--version` is skipped rather than reported as usable - a broken shim on PATH
 * is the commonest way this goes wrong, and failing at resolution is a far better
 * error than failing mid-turn.
 *
 * @param configured - An absolute path the user set, or `null`.
 * @param options - Test seams.
 * @returns The executable and how it was found, plus what was tried.
 */
export async function resolveAcpBinary(
  configured: string | null,
  options: AcpBinaryOptions = {},
): Promise<{ binary?: ResolvedAcpBinary; diagnostics: AcpBinaryDiagnostics }> {
  const platform = options.platform ?? `${process.platform}-${process.arch}`
  const env = options.env ?? process.env
  const home = options.home?.() ?? os.homedir()
  const tried: string[] = []
  const readVersion = options.readVersion ?? readCliVersion

  const candidates: Array<{ path: string; kind: ResolvedAcpBinary['kind'] }> = []
  if (configured !== null && configured !== '') candidates.push({ path: configured, kind: 'configured' })
  const fromEnv = env[BINARY_ENV_VAR]?.trim()
  if (fromEnv !== undefined && fromEnv !== '') candidates.push({ path: fromEnv, kind: 'configured' })
  for (const candidate of localCliCandidates(home, platform.split('-')[0] ?? process.platform)) {
    candidates.push({ path: candidate, kind: 'local-cli' })
  }

  for (const candidate of candidates) {
    tried.push(candidate.path)
    if (!(await exists(candidate.path))) continue
    const version = await readVersion(candidate.path).catch(() => undefined)
    // A file that exists but does not answer is not this line's executable.
    if (version === undefined) continue
    return { binary: { path: candidate.path, kind: candidate.kind, version }, diagnostics: { tried } }
  }

  const release = ACP_BINARY_RELEASES[platform]
  if (release === undefined) {
    return {
      diagnostics: { tried, error: `No official Antigravity ACP archive is published for ${platform}.` },
    }
  }
  const root = options.cacheRoot?.() ?? path.join(dshHomeDir(), 'cache', BINARY_CACHE_DIR)
  const cachedPath = cachedExecutablePath(root, release)
  tried.push(cachedPath)
  if (await exists(cachedPath)) {
    return { binary: { path: cachedPath, kind: 'downloaded', version: release.version }, diagnostics: { tried } }
  }
  if (options.download === false) {
    // A passive read stops here. The sentence is composed for the card directly -
    // it is not a "download failed" detail, because no download was attempted -
    // and that is what the `deferred` flag tells the route about it.
    return {
      diagnostics: {
        tried,
        deferred: true,
        error: 'No Antigravity CLI (agy) is installed yet. This line downloads the official ACP server the first time you start a turn, run the self-check, or press refresh.',
      },
    }
  }
  try {
    const downloaded = await downloadRelease(release, root, options.fetchFn ?? fetch)
    return { binary: { path: downloaded, kind: 'downloaded', version: release.version }, diagnostics: { tried } }
  } catch (error) {
    return {
      diagnostics: {
        tried,
        error: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/**
 * A cached answer to "which executable may this line run?".
 *
 * Resolution touches the disk once per candidate and spawns `agy --version` to
 * prove the file answers, which is not something a page render should do. The
 * answer is therefore reused for a few minutes; a change of `binaryPath` and the
 * refresh click invalidate or force it.
 *
 * A cached *passive* answer is never served to an active caller: if the reading
 * was taken without permission to download and found nothing, a turn asking the
 * same question must still be allowed to fetch the release.
 */
export class AcpBinaryCache {
  private value: AcpBinaryResolution | undefined
  private fetchedAt = 0
  private withDownload = false
  private inflight: Promise<AcpBinaryResolution> | undefined
  /** Whether the in-flight read is allowed to install. */
  private inflightDownload = false

  /**
   * @param resolve - Reads the real answer; called at most once per window.
   * @param now - Clock seam.
   * @param ttlMs - How long one answer stays valid.
   */
  constructor(
    private readonly resolve: (options: { download?: boolean }) => Promise<AcpBinaryResolution>,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = BINARY_CACHE_TTL_MS,
  ) {}

  /** The cached answer, when one is still valid. */
  peek(): AcpBinaryResolution | undefined {
    if (this.value === undefined) return undefined
    return this.now() - this.fetchedAt < this.ttlMs ? this.value : undefined
  }

  /**
   * Read the resolution, reusing a valid answer or one in-flight read.
   *
   * @param options - `force` re-reads the disk; `download` allows fetching a release.
   * @returns The executable (when one was found) and what was tried.
   */
  async read(options: { force?: boolean; download?: boolean } = {}): Promise<AcpBinaryResolution> {
    if (options.force !== true) {
      const cached = this.peek()
      // A passive reading that found nothing must not hide the download from an
      // active caller asking the same question moments later.
      const usable = cached !== undefined
        && (options.download !== true || this.withDownload || cached.binary !== undefined)
      if (usable) return cached
    }
    const download = options.download !== false
    if (this.inflight !== undefined) {
      // Same rule as a cached answer: a read that may not install cannot answer a
      // caller that may. Waiting for it to settle and then resolving again is what
      // keeps a turn from reporting "not installed" because a page render happened
      // to be reading the disk at that moment.
      if (!(download && !this.inflightDownload)) return this.inflight
      await this.inflight.catch(() => undefined)
    }
    const promise = this.resolve({ download })
      .then((value) => {
        this.value = value
        this.fetchedAt = this.now()
        this.withDownload = download
        return value
      })
      .finally(() => {
        if (this.inflight === promise) this.inflight = undefined
      })
    this.inflight = promise
    this.inflightDownload = download
    return promise
  }

  /** Forget the answer, e.g. because the configured path just changed. */
  invalidate(): void {
    this.value = undefined
    this.fetchedAt = 0
    this.withDownload = false
  }
}

/**
 * Download and extract one release.
 *
 * The archive is fetched whole (bounded), hashed, and only then extracted; an
 * entry whose path escapes the extraction root is skipped, and a mismatched hash
 * deletes the archive by name and throws.
 *
 * @param release - Registry entry to fetch.
 * @param root - Cache root.
 * @param fetchFn - `fetch` implementation.
 * @returns Absolute path of the extracted executable.
 */
export async function downloadRelease(release: AcpBinaryRelease, root: string, fetchFn: typeof fetch): Promise<string> {
  const directory = path.join(root, release.version)
  const archivePath = path.join(directory, path.basename(new URL(release.url).pathname))
  await fs.mkdir(directory, { recursive: true })
  try {
    const response = await fetchFn(release.url, { redirect: 'error' })
    if (!response.ok) throw new Error(`The Antigravity ACP archive answered HTTP ${response.status}.`)
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > ACP_MAX_ARCHIVE_BYTES) {
      throw new Error('The Antigravity ACP archive is larger than this line will download.')
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > ACP_MAX_ARCHIVE_BYTES) {
      throw new Error('The Antigravity ACP archive is larger than this line will download.')
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== release.sha256) {
      throw new Error(`The Antigravity ACP archive does not match the published sha256 (expected ${release.sha256}, got ${digest}).`)
    }
    await fs.writeFile(archivePath, bytes)
    await extractZipEntries(archivePath, directory)
    const executable = path.join(directory, release.executable)
    if (!(await exists(executable))) throw new Error(`The Antigravity ACP archive did not contain ${release.executable}.`)
    if (process.platform !== 'win32') await fs.chmod(executable, 0o755).catch(() => undefined)
    return executable
  } catch (error) {
    // Remove the partial archive by name. A recursive delete of the cache root is
    // exactly what this repository forbids - and the archive is the only file this
    // function is responsible for.
    await fs.rm(archivePath, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Whether one path exists and is a file. */
async function exists(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate)
    return stat.isFile()
  } catch {
    return false
  }
}

/** Read `agy --version`, or undefined when the executable does not answer. */
async function readCliVersion(command: string): Promise<string | undefined> {
  const { execFile } = await import('node:child_process')
  return new Promise<string | undefined>((resolve) => {
    execFile(command, ['--version'], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      if (error !== null) {
        resolve(undefined)
        return
      }
      const text = stdout.trim().split(/\r?\n/)[0]?.trim()
      resolve(text === undefined || text === '' ? undefined : text)
    })
  })
}

/**
 * Extract the entries of a ZIP this line downloaded itself.
 *
 * Deliberately narrow: stored or deflated entries only, no encryption, no path
 * outside the destination. The archive comes from a pinned URL with a verified
 * hash, so this is defence in depth rather than the only barrier.
 *
 * @param archivePath - The verified archive.
 * @param destination - Extraction root.
 */
export async function extractZipEntries(archivePath: string, destination: string): Promise<void> {
  const { inflateRawSync } = await import('node:zlib')
  const bytes = await fs.readFile(archivePath)
  const eocd = findEndOfCentralDirectory(bytes)
  if (eocd === undefined) throw new Error('The Antigravity ACP archive is not a readable ZIP file.')
  const entryCount = bytes.readUInt16LE(eocd + 10)
  let offset = bytes.readUInt32LE(eocd + 16)
  for (let index = 0; index < entryCount; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) break
    const method = bytes.readUInt16LE(offset + 10)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const localOffset = bytes.readUInt32LE(offset + 42)
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength
    const name = rawName.replace(/\\/g, '/')
    if (name.endsWith('/')) continue
    // A path that climbs out of the destination is never written.
    if (name.startsWith('../') || name.includes('/../') || path.isAbsolute(name)) continue
    const target = path.join(destination, name)
    if (!target.startsWith(destination)) continue
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) continue
    const localNameLength = bytes.readUInt16LE(localOffset + 26)
    const localExtraLength = bytes.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const data = bytes.subarray(dataStart, dataStart + compressedSize)
    const content = method === 0 ? data : method === 8 ? inflateRawSync(data) : undefined
    if (content === undefined) continue
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
}

/** Locate the ZIP end-of-central-directory record. */
function findEndOfCentralDirectory(bytes: Buffer): number | undefined {
  const minimum = Math.max(0, bytes.length - 65_557)
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return undefined
}
