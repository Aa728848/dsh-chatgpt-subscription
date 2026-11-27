/**
 * Claude Code first-party request attestation.
 *
 * The signature covers a plain-text hash view of the final serialized body while
 * its billing block still carries the five-character cch=00000 placeholder.
 * This implementation follows the capture-backed 2.1.330 reference in
 * docs/2026-11-21_cch-attestation-report.md.
 */

export const CLAUDE_CODE_CCH_SEED = 0x4d659218e32a3268n
export const CLAUDE_CODE_CCH_MASK = 0xfffffn
export const CLAUDE_CODE_CCH_PATTERN = /\bcch=([0-9a-f]{5});/

const P1 = 0x9e3779b185ebca87n
const P2 = 0xc2b2ae3d27d4eb4fn
const P3 = 0x165667b19e3779f9n
const P4 = 0x85ebca77c2b2ae63n
const P5 = 0x27d4eb2f165667c5n
const M64 = 0xffffffffffffffffn

function rotl(value: bigint, shift: bigint): bigint {
  return ((value << shift) | (value >> (64n - shift))) & M64
}

function round(accumulator: bigint, input: bigint): bigint {
  let value = (accumulator + input * P2) & M64
  value = rotl(value, 31n)
  return (value * P1) & M64
}

function mergeRound(accumulator: bigint, value: bigint): bigint {
  let result = (accumulator ^ round(0n, value)) & M64
  result = (result * P1 + P4) & M64
  return result
}

/** Standard xxHash64 over UTF-8 text or raw bytes. */
export function claudeCodeXxHash64(value: string | Uint8Array, seed = 0n): bigint {
  const bytes = typeof value === 'string'
    ? Buffer.from(value, 'utf8')
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  const length = bytes.length
  let offset = 0
  let hash: bigint

  if (length >= 32) {
    let v1 = (seed + P1 + P2) & M64
    let v2 = (seed + P2) & M64
    let v3 = seed & M64
    let v4 = (seed - P1) & M64
    while (offset <= length - 32) {
      v1 = round(v1, bytes.readBigUInt64LE(offset))
      v2 = round(v2, bytes.readBigUInt64LE(offset + 8))
      v3 = round(v3, bytes.readBigUInt64LE(offset + 16))
      v4 = round(v4, bytes.readBigUInt64LE(offset + 24))
      offset += 32
    }
    hash = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & M64
    hash = mergeRound(hash, v1)
    hash = mergeRound(hash, v2)
    hash = mergeRound(hash, v3)
    hash = mergeRound(hash, v4)
  } else {
    hash = (seed + P5) & M64
  }

  hash = (hash + BigInt(length)) & M64
  while (offset + 8 <= length) {
    hash = (hash ^ round(0n, bytes.readBigUInt64LE(offset))) & M64
    hash = (rotl(hash, 27n) * P1 + P4) & M64
    offset += 8
  }
  if (offset + 4 <= length) {
    hash = (hash ^ ((BigInt(bytes.readUInt32LE(offset)) * P1) & M64)) & M64
    hash = (rotl(hash, 23n) * P2 + P3) & M64
    offset += 4
  }
  while (offset < length) {
    const byte = bytes[offset] as number
    hash = (hash ^ ((BigInt(byte) * P5) & M64)) & M64
    hash = (rotl(hash, 11n) * P1) & M64
    offset += 1
  }

  hash ^= hash >> 33n
  hash = (hash * P2) & M64
  hash ^= hash >> 29n
  hash = (hash * P3) & M64
  hash ^= hash >> 32n
  return hash
}

/** The client's two ordered, deliberately textual rewrites. */
export function claudeCodeCchHashView(body: string): string {
  return body
    .replace(/"model":"[^"]*"/g, '"model":""')
    .replace(/"max_tokens":\d+,|,?"max_tokens":\d+/g, '')
}

/** Compute the five-hex token for a body that still contains cch=00000. */
export function claudeCodeCchToken(body: string, seed = CLAUDE_CODE_CCH_SEED): string {
  return (claudeCodeXxHash64(claudeCodeCchHashView(body), seed) & CLAUDE_CODE_CCH_MASK)
    .toString(16)
    .padStart(5, '0')
}

const CCH_PLACEHOLDER = 'cch=00000;'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The billing block's text when it still carries the placeholder. Only
 * system[0] is the billing block: the same characters quoted in history (a tool
 * result showing this file, a pasted header) must reach the wire unchanged, or
 * every later request rewrites that message and the prompt cache stops matching.
 */
function billingText(payload: unknown): string | undefined {
  const system = isRecord(payload) ? payload.system : undefined
  const first = Array.isArray(system) ? system[0] : undefined
  const text = isRecord(first) && first.type === 'text' && typeof first.text === 'string' ? first.text : undefined
  return text !== undefined && text.includes(CCH_PLACEHOLDER) ? text : undefined
}

/**
 * Serialize and sign a request payload. The token is computed over the whole
 * serialized body, as before, and written into the billing block only.
 */
export function signClaudeCodeRequest(payload: unknown, seed = CLAUDE_CODE_CCH_SEED): string {
  const body = JSON.stringify(payload)
  const text = billingText(payload)
  if (text === undefined || !isRecord(payload) || !Array.isArray(payload.system)) return body
  const [first, ...rest] = payload.system as unknown[]
  const signed = text.replace(CCH_PLACEHOLDER, `cch=${claudeCodeCchToken(body, seed)};`)
  // Same keys in the same order: the result differs from `body` only in the token.
  return JSON.stringify({ ...payload, system: [{ ...(first as Record<string, unknown>), text: signed }, ...rest] })
}

/**
 * Sign an already serialized body by the same rule. A body without a billing
 * placeholder, or whose billing text occurs more than once, is returned verbatim.
 */
export function signClaudeCodeCch(body: string, seed = CLAUDE_CODE_CCH_SEED): string {
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return body
  }
  const text = billingText(payload)
  if (text === undefined) return body
  const literal = JSON.stringify(text)
  const start = body.indexOf(literal)
  if (start < 0 || body.indexOf(literal, start + 1) >= 0) return body
  const at = start + literal.indexOf(CCH_PLACEHOLDER)
  return body.slice(0, at + 4) + claudeCodeCchToken(body, seed) + body.slice(at + 9)
}
