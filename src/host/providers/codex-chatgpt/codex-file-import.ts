import { inflateRawSync } from 'node:zlib'
import type { StoredOAuthCredentials } from '../../infra/storage/token-store.ts'
import { extractIdentity, parseJwtClaims } from './codex-identity.ts'

export const MAX_CREDENTIAL_IMPORT_BYTES = 16 * 1024 * 1024
const MAX_JSON_ACCOUNTS = 1_000
const MAX_ZIP_ENTRIES = 1_000
const MAX_ZIP_ENTRY_BYTES = 2 * 1024 * 1024
const MAX_ZIP_TOTAL_BYTES = 32 * 1024 * 1024

export interface ParsedCodexCredentialFile {
  format: 'cpa' | 'sub2api'
  credentials: StoredOAuthCredentials[]
  skipped: number
}

export class CodexCredentialImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexCredentialImportError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function expiry(accessToken: string, record: Record<string, unknown>): number | undefined {
  const exp = parseJwtClaims(accessToken)?.exp
  if (typeof exp === 'number' && Number.isFinite(exp) && exp >= 0) return Math.round(exp * 1000)
  for (const candidate of [record.expires_at, record.expiresAt, record.expired]) {
    if (typeof candidate !== 'string') continue
    const parsed = Date.parse(candidate)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return undefined
}

function parseCredential(record: Record<string, unknown>): StoredOAuthCredentials | undefined {
  if (record.type !== 'codex' || record.disabled === true) return undefined
  const accessToken = text(record.access_token)
  const refreshToken = text(record.refresh_token)
  if (accessToken === undefined || refreshToken === undefined) return undefined
  const expiresAt = expiry(accessToken, record)
  if (expiresAt === undefined) return undefined

  const idToken = text(record.id_token)
  const identity = extractIdentity({ accessToken, ...(idToken === undefined ? {} : { idToken }) })
  const live = isRecord(record.live_identity) ? record.live_identity : {}
  const credentials: StoredOAuthCredentials = {
    accessToken,
    refreshToken,
    expiresAt,
    accountId: text(record.account_id) ?? text(record.chatgpt_account_id) ?? text(live.account_id) ?? identity.accountId,
    userId: text(record.chatgpt_user_id) ?? text(live.user_id) ?? identity.userId,
    email: text(record.email) ?? text(live.email) ?? identity.email,
    planType: text(record.plan_type) ?? text(record.chatgpt_plan_type)
      ?? text(live.plan) ?? text(live.official_plan) ?? identity.planType,
  }
  if (idToken !== undefined) credentials.idToken = idToken
  return credentials
}

function parseSub2Api(value: unknown): ParsedCodexCredentialFile {
  if (!isRecord(value) || value.type !== 'sub2api-data' || !Array.isArray(value.accounts)) {
    throw new CodexCredentialImportError('The file is not a sub2api account export.')
  }
  if (value.accounts.length > MAX_JSON_ACCOUNTS) {
    throw new CodexCredentialImportError(`The export exceeds the ${MAX_JSON_ACCOUNTS}-account import limit.`)
  }
  const credentials: StoredOAuthCredentials[] = []
  let skipped = 0
  for (const account of value.accounts) {
    const parsed = isRecord(account) && account.platform === 'openai' && account.type === 'oauth'
      && account.disabled !== true && isRecord(account.credentials)
      ? parseCredential(account.credentials)
      : undefined
    if (parsed === undefined) skipped += 1
    else credentials.push(parsed)
  }
  return { format: 'sub2api', credentials, skipped }
}

function assertRange(buffer: Buffer, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
    || offset + length > buffer.length) {
    throw new CodexCredentialImportError('The CPA ZIP directory is malformed.')
  }
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zipEntries(buffer: Buffer): Array<{ name: string; data: Buffer }> {
  if (buffer.length < 22) throw new CodexCredentialImportError('The CPA ZIP file is malformed.')
  let end = -1
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      end = offset
      break
    }
  }
  if (end < 0) throw new CodexCredentialImportError('The CPA ZIP directory is missing.')
  const count = buffer.readUInt16LE(end + 10)
  const directorySize = buffer.readUInt32LE(end + 12)
  const directoryOffset = buffer.readUInt32LE(end + 16)
  if (count > MAX_ZIP_ENTRIES || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    throw new CodexCredentialImportError('The CPA ZIP file is too large or uses an unsupported directory.')
  }
  assertRange(buffer, directoryOffset, directorySize)

  const entries: Array<{ name: string; data: Buffer }> = []
  let cursor = directoryOffset
  let totalBytes = 0
  for (let index = 0; index < count; index += 1) {
    assertRange(buffer, cursor, 46)
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new CodexCredentialImportError('The CPA ZIP directory is malformed.')
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const expectedCrc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    assertRange(buffer, cursor + 46, nameLength + extraLength + commentLength)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength
    if (!name.toLowerCase().endsWith('.json')) continue
    if ((flags & 1) !== 0 || (method !== 0 && method !== 8)
      || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
      || uncompressedSize > MAX_ZIP_ENTRY_BYTES || totalBytes + uncompressedSize > MAX_ZIP_TOTAL_BYTES) {
      throw new CodexCredentialImportError('The CPA ZIP contains an encrypted, oversized, or unsupported JSON entry.')
    }
    assertRange(buffer, localOffset, 30)
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new CodexCredentialImportError('The CPA ZIP entry is malformed.')
    }
    const dataOffset = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28)
    assertRange(buffer, dataOffset, compressedSize)
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize)
    let data: Buffer
    try {
      data = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: MAX_ZIP_ENTRY_BYTES + 1 })
    } catch {
      throw new CodexCredentialImportError('A CPA ZIP JSON entry cannot be decompressed.')
    }
    if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) {
      throw new CodexCredentialImportError('A CPA ZIP JSON entry failed its integrity check.')
    }
    totalBytes += data.length
    entries.push({ name, data })
  }
  return entries
}

function parseCpa(buffer: Buffer): ParsedCodexCredentialFile {
  const entries = zipEntries(buffer)
  const credentials: StoredOAuthCredentials[] = []
  let skipped = 0
  for (const entry of entries) {
    try {
      const value = JSON.parse(entry.data.toString('utf8')) as unknown
      const parsed = isRecord(value) ? parseCredential(value) : undefined
      if (parsed === undefined) skipped += 1
      else credentials.push(parsed)
    } catch {
      skipped += 1
    }
    if (credentials.length + skipped > MAX_JSON_ACCOUNTS) {
      throw new CodexCredentialImportError(`The archive exceeds the ${MAX_JSON_ACCOUNTS}-account import limit.`)
    }
  }
  return { format: 'cpa', credentials, skipped }
}

export function parseCodexCredentialFile(buffer: Buffer): ParsedCodexCredentialFile {
  if (buffer.length === 0 || buffer.length > MAX_CREDENTIAL_IMPORT_BYTES) {
    throw new CodexCredentialImportError('The import file is empty or exceeds the 16 MB limit.')
  }
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) return parseCpa(buffer)
  try {
    return parseSub2Api(JSON.parse(buffer.toString('utf8')) as unknown)
  } catch (error) {
    if (error instanceof CodexCredentialImportError) throw error
    throw new CodexCredentialImportError('The file is neither a sub2api JSON export nor a CPA ZIP archive.')
  }
}
