import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { CorruptStoredDocumentError } from './token-store.ts'
import { CredentialReadCache, keyringCredentialIdentity } from './common/credential-read-cache.ts'
import type { CredentialStore } from './token-store.ts'

const UNAVAILABLE = 'Linux encrypted credential storage requires secret-tool (libsecret) and an unlocked Secret Service keyring.'
const INVALID = 'Secret Service credential payload is invalid'

/** The verdict of {@link SecretServiceCredentialStore.ping}: usable, or why not. */
export interface SecretServiceAvailability {
  available: boolean
  /** Why the keyring cannot be used, present exactly when `available` is false. */
  reason?: string
}

/**
 * How long one Secret Service read may stand in for the stored value.
 *
 * `secret-tool` is a process launch per lookup and one settings request performs
 * several, so the snapshot is what keeps a tab switch from costing seconds. A
 * keyring has no mtime to compare, so this bounded bucket is the substitute; it
 * is far below the 60 s polling interval of the surfaces that read these
 * credentials.
 */
const KEYRING_READ_CACHE_TTL_MS = 15_000

/**
 * secret-tool reads the secret from stdin into a fixed 8192-byte buffer
 * (`tool/secret-tool.c` `read_password_stdin()`) and, past the limit, prints
 * `password is too long` yet still stores the truncated bytes with exit 0 —
 * a silent corruption the caller cannot detect from the exit code. Payloads
 * that do not fit are therefore split into shard entries that each stay well
 * under the limit.
 */
const SECRET_TOOL_STDIN_LIMIT = 8192

/**
 * Base64 characters per shard entry. Base64 is ASCII, so characters equal
 * bytes and any split point is safe; 7000 leaves the shard comfortably below
 * the stdin limit.
 */
const SHARD_PAYLOAD_SIZE = 7000

/**
 * Upper bound on the shard count one value may occupy. A corrupt or hostile
 * envelope cannot ask for unbounded lookups; 128 shards still hold ~650 KiB,
 * far past any plausible credential or account pool.
 */
const MAX_SHARDS = 128

/** Property that marks a primary entry as the envelope of a chunked value. */
const ENVELOPE_KEY = '__dshChunked'

/**
 * Commit record of a chunked value, stored in the primary entry. `gen` tags
 * the shard entries this envelope points at, so an interrupted save leaves the
 * previous envelope and its shards untouched.
 */
interface ChunkEnvelope {
  gen: string
  chunks: number
  /** UTF-8 byte length of the JSON payload, verified after decoding. */
  bytes: number
}

/**
 * Read the envelope of a stored primary entry, or null when the entry holds a
 * plain value. A malformed envelope is invalid stored data, not a plain value.
 */
function envelopeFrom(parsed: unknown): ChunkEnvelope | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const marker = (parsed as Record<string, unknown>)[ENVELOPE_KEY]
  if (marker === undefined) return null
  if (typeof marker !== 'object' || marker === null) throw new CorruptStoredDocumentError(INVALID)
  const { gen, chunks, bytes } = marker as Record<string, unknown>
  if (typeof gen !== 'string' || gen === ''
    || typeof chunks !== 'number' || !Number.isInteger(chunks) || chunks < 1 || chunks > MAX_SHARDS
    || typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
    throw new CorruptStoredDocumentError(INVALID)
  }
  return { gen, chunks, bytes }
}

/** Secrets travel over stdin/stdout; command arguments contain only lookup attributes. */
export class SecretServiceCredentialStore<T> implements CredentialStore<T> {
  private readonly cache = new CredentialReadCache<T>(
    () => keyringCredentialIdentity(KEYRING_READ_CACHE_TTL_MS),
  )

  constructor(
    private readonly service: string,
    private readonly account: string,
    private readonly parse: (value: unknown) => T,
  ) {}

  /**
   * Label the desktop keyring manager shows for this entry.
   *
   * Derived from the entry's own `service` attribute: it used to be a hardcoded
   * 'DSH Antigravity OAuth' for every caller, so the ChatGPT, Claude, Qoder and
   * Minimax pools all appeared in seahorse under Antigravity's name and a user
   * could not tell which secret they were looking at. The label is display-only,
   * so entries stored under the old one keep working.
   */
  private get label(): string {
    return `DSH ${this.service}`
  }

  private attributes(): string[] {
    return ['service', this.service, 'account', this.account]
  }

  /**
   * Lookup attributes of one shard entry. Secret Service matching is exact on
   * every given attribute pair, so the primary account value never matches a
   * shard and vice versa.
   */
  private shardAttributes(gen: string, index: number): string[] {
    return ['service', this.service, 'account', `${this.account}#${gen}#${index}`]
  }

  /**
   * Whether this host has a usable Secret Service at all.
   *
   * One lookup is the whole question, and its ANSWER is not the point: an entry
   * that is not there exits 1 with empty stderr, which still proves the daemon
   * answered. A host with no `secret-tool`, no session bus, no
   * `org.freedesktop.secrets` or a locked keyring fails instead — by refusing the
   * spawn, or by exiting non-zero with a message. Never throws, because it is
   * asked by a fallback chain whose next step is the answer to "no".
   */
  async ping(): Promise<SecretServiceAvailability> {
    try {
      const result = await runSecretTool(['lookup', ...this.attributes()])
      if (result.code === 0 || (result.code === 1 && !result.hasStderr)) return { available: true }
      return { available: false, reason: UNAVAILABLE }
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async load(): Promise<T | null> {
    return this.cache.load(async () => {
      const result = await runSecretTool(['lookup', ...this.attributes()])
      if (result.code === 1 && !result.hasStderr && result.stdout === '') return null
      if (result.code !== 0) throw new Error(UNAVAILABLE)
      let parsed: unknown
      try {
        parsed = JSON.parse(result.stdout) as unknown
      } catch {
        throw new CorruptStoredDocumentError(INVALID)
      }
      const envelope = envelopeFrom(parsed)
      if (envelope === null) {
        try {
          return this.parse(parsed)
        } catch {
          throw new CorruptStoredDocumentError(INVALID)
        }
      }
      const pieces: string[] = []
      for (let index = 0; index < envelope.chunks; index += 1) {
        const shard = await runSecretTool(['lookup', ...this.shardAttributes(envelope.gen, index)])
        if (shard.code !== 0) throw new CorruptStoredDocumentError(INVALID)
        pieces.push(shard.stdout)
      }
      try {
        // The decoder skips stray whitespace, so the byte count is what proves
        // the reassembled payload is the one that was stored.
        const decoded = Buffer.from(pieces.join(''), 'base64')
        if (decoded.length !== envelope.bytes) throw new Error('shard byte count mismatch')
        return this.parse(JSON.parse(decoded.toString('utf8')) as unknown)
      } catch {
        throw new CorruptStoredDocumentError(INVALID)
      }
    })
  }

  async save(value: T): Promise<void> {
    const payload = JSON.stringify(value)
    const bytes = Buffer.byteLength(payload, 'utf8')
    // The previous primary entry names the shard generation that becomes stale
    // the moment the new content lands; read it before overwriting anything.
    const stale = await this.storedEnvelope()
    if (bytes < SECRET_TOOL_STDIN_LIMIT) {
      const result = await runSecretTool(['store', '--label=' + this.label, ...this.attributes()], payload)
      if (result.code !== 0) throw new Error(UNAVAILABLE)
    } else {
      await this.saveChunked(payload, bytes)
    }
    if (stale !== null) await this.clearShards(stale.gen, stale.chunks)
    this.cache.invalidate()
  }

  /**
   * Store an oversized payload as shard entries plus an envelope. The shards
   * are written under a fresh generation tag first and the primary entry last:
   * that entry is the commit point, so an interrupted save leaves the previous
   * envelope and its shards fully intact and the new generation is either
   * committed whole or cleaned up.
   */
  private async saveChunked(payload: string, bytes: number): Promise<void> {
    const encoded = Buffer.from(payload, 'utf8').toString('base64')
    const chunks = Math.ceil(encoded.length / SHARD_PAYLOAD_SIZE)
    if (chunks > MAX_SHARDS) throw new Error('Secret Service credential payload is too large')
    const gen = randomBytes(6).toString('hex')
    for (let index = 0; index < chunks; index += 1) {
      const piece = encoded.slice(index * SHARD_PAYLOAD_SIZE, (index + 1) * SHARD_PAYLOAD_SIZE)
      const shard = await runSecretTool(
        ['store', '--label=' + this.label, ...this.shardAttributes(gen, index)],
        piece,
      )
      if (shard.code !== 0) {
        await this.clearShards(gen, index)
        throw new Error(UNAVAILABLE)
      }
    }
    const envelope: ChunkEnvelope = { gen, chunks, bytes }
    const commit = await runSecretTool(
      ['store', '--label=' + this.label, ...this.attributes()],
      JSON.stringify({ [ENVELOPE_KEY]: envelope }),
    )
    if (commit.code !== 0) {
      await this.clearShards(gen, chunks)
      throw new Error(UNAVAILABLE)
    }
  }

  /**
   * Envelope of the currently stored value, or null when the entry is missing,
   * holds a plain value, or cannot be read at all. A save that goes on to fail
   * surfaces its own error, so a probe failure must not fail the save first.
   */
  private async storedEnvelope(): Promise<ChunkEnvelope | null> {
    const probe = await runSecretTool(['lookup', ...this.attributes()])
    if (probe.code !== 0) return null
    try {
      return envelopeFrom(JSON.parse(probe.stdout) as unknown)
    } catch {
      return null
    }
  }

  /**
   * Remove shard entries, tolerating the ones that are already gone. A missing
   * entry exits 1 with empty stderr — the same shape a segfaulting secret-tool
   * takes through the close event (Ubuntu libsecret-tools 0.20.4 crashes on
   * clearing an entry that does not exist) — so that answer is never an error.
   */
  private async clearShards(gen: string, chunks: number): Promise<void> {
    for (let index = 0; index < chunks; index += 1) {
      const result = await runSecretTool(['clear', ...this.shardAttributes(gen, index)])
      if (result.code !== 0 && !(result.code === 1 && !result.hasStderr)) {
        // Cleanup is best-effort: an orphaned shard costs keyring space but
        // never answers a lookup, since no envelope names it.
        return
      }
    }
  }

  async clear(): Promise<void> {
    // Probe before clearing: the probe names the shard generation to remove,
    // and a missing entry needs no clear at all (which also sidesteps the
    // secret-tool clear segfault noted above).
    const probe = await runSecretTool(['lookup', ...this.attributes()])
    if (probe.code !== 0 && !(probe.code === 1 && !probe.hasStderr)) throw new Error(UNAVAILABLE)
    if (probe.code === 0) {
      let envelope: ChunkEnvelope | null = null
      try {
        envelope = envelopeFrom(JSON.parse(probe.stdout) as unknown)
      } catch {
        envelope = null
      }
      if (envelope !== null) await this.clearShards(envelope.gen, envelope.chunks)
      const result = await runSecretTool(['clear', ...this.attributes()])
      if (result.code !== 0 && !(result.code === 1 && !result.hasStderr)) throw new Error(UNAVAILABLE)
    }
    this.cache.invalidate()
  }
}

function runSecretTool(args: string[], stdin = ''): Promise<{ code: number; stdout: string; hasStderr: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('secret-tool', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderrLength = 0
    let settled = false
    const fail = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      reject(new Error(UNAVAILABLE))
    }
    const timer = setTimeout(fail, 10_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 1 << 20) fail()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrLength += chunk.length
      if (stderrLength > 1 << 20) fail()
    })
    child.once('error', fail)
    child.stdin.once('error', fail)
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, hasStderr: stderrLength > 0 })
    })
    child.stdin.end(stdin)
  })
}
