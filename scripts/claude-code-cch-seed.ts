/**
 * Capture and re-derive Claude Code's version-bound cch seed without credentials.
 *
 * Node 22.19+ runs this file directly. The default scanner reads x86-64 movabs
 * immediates; --range is the deliberate byte-by-byte fallback for new compilers.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CLAUDE_CODE_CCH_MASK,
  claudeCodeCchHashView,
  claudeCodeXxHash64,
  signClaudeCodeCch,
} from '../src/host/common/claude-code-cch.ts'

const CCH_PATTERN = /\bcch=([0-9a-f]{5});/
const MAX_CAPTURE_BYTES = 20 * 1024 * 1024

export interface CchCapture {
  readonly url: string
  readonly raw: string
  readonly cch: string
}

export interface CchSample extends CchCapture {
  readonly file: string
  readonly placeholder: string
  readonly view: Buffer
}

export interface SeedCandidate {
  readonly seed: bigint
  readonly offset: number
  readonly source: 'x64-movabs' | 'range' | 'file'
}

export interface SeedSelection {
  readonly seed: bigint
  readonly candidate: SeedCandidate
  readonly roundTrips: readonly boolean[]
}

function cchFromBody(raw: string): string | null {
  try {
    const body = JSON.parse(raw) as { system?: Array<{ text?: unknown }> }
    const text = body.system?.[0]?.text
    return typeof text === 'string' ? CCH_PATTERN.exec(text)?.[1] ?? null : null
  } catch {
    return null
  }
}

export function sampleFromCapture(capture: CchCapture, file: string): CchSample {
  const match = CCH_PATTERN.exec(capture.raw)
  if (match === null || match[1] !== capture.cch) {
    throw new Error(`No matching cch token in ${file}`)
  }
  const placeholder = capture.raw.slice(0, match.index) + 'cch=00000;' + capture.raw.slice(match.index + match[0].length)
  return { ...capture, file, placeholder, view: Buffer.from(claudeCodeCchHashView(placeholder), 'utf8') }
}

export function loadCchSamples(directory: string): CchSample[] {
  const files = fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort()
  const samples = files.map((file) => {
    const loaded = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) as Partial<CchCapture>
    if (typeof loaded.raw !== 'string' || typeof loaded.url !== 'string') {
      throw new Error(`Invalid capture shape: ${file}`)
    }
    const cch = typeof loaded.cch === 'string' ? loaded.cch : cchFromBody(loaded.raw)
    if (cch === null) throw new Error(`Capture has no cch token: ${file}`)
    return sampleFromCapture({ url: loaded.url, raw: loaded.raw, cch }, file)
  })
  if (samples.length < 2) throw new Error('At least two captures are required')
  if (new Set(samples.map((sample) => sample.placeholder)).size !== samples.length) {
    throw new Error('Captures must contain distinct request bodies')
  }
  return samples
}

/** Read every x86-64 REX.W movabs immediate, regardless of instruction alignment. */
export function x64MovabsSeedCandidates(binary: Buffer): SeedCandidate[] {
  const candidates: SeedCandidate[] = []
  for (let index = 0; index + 10 <= binary.length; index += 1) {
    const rex = binary[index]!
    const opcode = binary[index + 1]!
    if (rex < 0x48 || rex > 0x4f || opcode < 0xb8 || opcode > 0xbf) continue
    candidates.push({ seed: binary.readBigUInt64LE(index + 2), offset: index + 2, source: 'x64-movabs' })
  }
  return candidates
}

export function selectCchSeed(
  candidates: readonly SeedCandidate[],
  samples: readonly CchSample[],
): SeedSelection[] {
  if (samples.length < 2) throw new Error('At least two distinct captures are required')
  const unique = new Map<string, SeedCandidate>()
  for (const candidate of candidates) {
    if (candidate.seed < 0n || candidate.seed > 0xffffffffffffffffn) {
      throw new Error(`Seed outside uint64: ${candidate.seed.toString()}`)
    }
    unique.set(candidate.seed.toString(16), candidate)
  }
  const hits: SeedSelection[] = []
  let checked = 0
  for (const candidate of unique.values()) {
    checked += 1
    if (checked % 25_000 === 0) console.error(`  checked ${checked}/${unique.size} candidates`)
    const matches = samples.every((sample) => {
      const actual = claudeCodeXxHash64(sample.view, candidate.seed) & CLAUDE_CODE_CCH_MASK
      return actual === BigInt('0x' + sample.cch)
    })
    if (!matches) continue
    const roundTrips = samples.map((sample) =>
      signClaudeCodeCch(sample.placeholder, candidate.seed) === sample.raw)
    if (roundTrips.every(Boolean)) hits.push({ seed: candidate.seed, candidate, roundTrips })
  }
  return hits
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  await Promise.race([once(child, 'exit'), delay(2_000)])
}

/** Capture only loopback requests. Isolated config directories are left to OS temp cleanup. */
export async function captureClaudeCode(options: {
  binary: string
  out: string
  runs: number
  prompt: string
  model: string
  timeoutMs: number
}): Promise<string[]> {
  fs.mkdirSync(options.out, { recursive: true })
  let active: ((capture: CchCapture) => void) | null = null
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_CAPTURE_BYTES) chunks.push(chunk)
      else request.destroy(new Error('Capture exceeds 20 MiB'))
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const cch = cchFromBody(raw)
      response.writeHead(500, { 'content-type': 'application/json' }).end('{}')
      if (cch !== null && active !== null) {
        const resolve = active
        active = null
        resolve({ url: request.url ?? '', raw, cch })
      }
    })
    request.on('error', () => undefined)
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No loopback listener address')
  const files: string[] = []
  try {
    for (let run = 1; run <= options.runs; run += 1) {
      const config = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cch-capture-'))
      const env: NodeJS.ProcessEnv = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('ANTHROPIC_')) env[key] = value
      }
      Object.assign(env, {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        ANTHROPIC_API_KEY: 'sk-ant-api03-loopback-dummy',
        CLAUDE_CONFIG_DIR: config,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_BUG_COMMAND: '1',
        DISABLE_COST_WARNINGS: '1',
        API_TIMEOUT_MS: '15000',
        _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
      })
      const child = spawn(options.binary, ['-p', options.prompt, '--model', options.model], {
        cwd: config,
        env,
        stdio: 'ignore',
        windowsHide: true,
      })
      let timeout: NodeJS.Timeout | undefined
      try {
        const captured = new Promise<CchCapture>((resolve) => { active = resolve })
        const exited = once(child, 'exit').then(([code, signal]) => {
          throw new Error(`Claude exited before a cch request (code=${String(code)}, signal=${String(signal)})`)
        })
        const expired = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`Capture timed out after ${options.timeoutMs}ms`)), options.timeoutMs)
        })
        const capture = await Promise.race([captured, exited, expired])
        const file = path.join(options.out, `run-${run}.json`)
        fs.writeFileSync(file, JSON.stringify(capture, null, 2) + '\n', { mode: 0o600 })
        files.push(file)
        console.log(`run ${run}: ${Buffer.byteLength(capture.raw)} bytes, cch=${capture.cch}`)
      } finally {
        active = null
        if (timeout !== undefined) clearTimeout(timeout)
        await stopProcess(child)
      }
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return files
}

function argument(args: readonly string[], name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}

function requiredArgument(args: readonly string[], name: string): string {
  const value = argument(args, name)
  if (value === undefined || value === '') throw new Error(`Missing ${name}`)
  return value
}

function writeResult(file: string | undefined, result: unknown): void {
  const serialized = JSON.stringify(result, null, 2) + '\n'
  if (file !== undefined) fs.writeFileSync(file, serialized, { mode: 0o600 })
  console.log(serialized)
}

function seedHex(seed: bigint): string {
  return '0x' + seed.toString(16).padStart(16, '0')
}

function captureEvidence(samples: readonly CchSample[], roundTrip: boolean): unknown {
  return samples.map((sample) => ({
    file: sample.file,
    bytes: Buffer.byteLength(sample.raw),
    cch: sample.cch,
    roundTrip,
  }))
}

async function main(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args
  if (command === 'capture') {
    await captureClaudeCode({
      binary: requiredArgument(rest, '--binary'),
      out: requiredArgument(rest, '--out'),
      runs: Number(argument(rest, '--runs', '3')),
      prompt: argument(rest, '--prompt', 'Reply with exactly: OK')!,
      model: argument(rest, '--model', 'claude-opus-5-5')!,
      timeoutMs: Number(argument(rest, '--timeout-ms', '90000')),
    })
    return
  }
  if (command === 'verify' || command === 'find') {
    const samples = loadCchSamples(requiredArgument(rest, '--captures'))
    const output = argument(rest, '--output')
    const version = argument(rest, '--version') ?? null
    if (command === 'verify') {
      const seed = BigInt(requiredArgument(rest, '--seed'))
      const candidate = { seed, offset: -1, source: 'file' } as const
      const hits = selectCchSeed([candidate], samples)
      if (hits.length !== 1) throw new Error('The supplied seed does not reproduce every capture')
      writeResult(output, { status: 'verified', version, seed: seedHex(seed), captures: captureEvidence(samples, true) })
      return
    }
    const binaryPath = requiredArgument(rest, '--binary')
    const binary = fs.readFileSync(binaryPath)
    let candidates = x64MovabsSeedCandidates(binary)
    const seedsFile = argument(rest, '--seeds')
    if (seedsFile !== undefined) {
      const extra = fs.readFileSync(seedsFile, 'utf8').split(/\r?\n/)
        .map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
        .map((line) => ({ seed: BigInt(line), offset: -1, source: 'file' }) as const)
      candidates = candidates.concat(extra)
    }
    const range = argument(rest, '--range')
    if (range !== undefined) {
      const [from, to] = range.split(':').map((value) => Number(BigInt(value)))
      if (from === undefined || to === undefined || from < 0 || to > binary.length || from >= to) {
        throw new Error('Invalid --range')
      }
      const extra: SeedCandidate[] = []
      for (let offset = from; offset + 8 <= to; offset += 1) {
        extra.push({ seed: binary.readBigUInt64LE(offset), offset, source: 'range' })
      }
      candidates = candidates.concat(extra)
    }
    console.error(`samples: ${samples.length}; candidates: ${candidates.length}`)
    const hits = selectCchSeed(candidates, samples)
    const common = {
      version,
      binary: { file: path.basename(binaryPath), bytes: binary.length, sha256: createHash('sha256').update(binary).digest('hex') },
      candidates: new Set(candidates.map((candidate) => candidate.seed.toString(16))).size,
      captures: captureEvidence(samples, hits.length === 1),
      hits: hits.map((hit) => ({ seed: seedHex(hit.seed), offset: hit.candidate.offset, source: hit.candidate.source })),
    }
    if (hits.length !== 1) {
      writeResult(output, { status: 'failed', ...common })
      throw new Error(`Expected one seed reproducing every capture, found ${hits.length}`)
    }
    writeResult(output, { status: 'verified', seed: seedHex(hits[0]!.seed), ...common })
    return
  }
  throw new Error('Usage: claude-code-cch-seed.ts capture|find|verify [options]')
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
