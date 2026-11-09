/**
 * Bounded, incremental defence for tool-call argument streams.
 *
 * The scanner only interprets a string followed by `:` as a JSON member key.
 * Similar text inside a string value is never counted. All state lives in one
 * tool call, so deltas may split escape sequences, keys, or UTF-16 surrogates.
 */

import type { KimiCodeRequestDiagnostic } from '../../shared/kimi-code-contracts.ts'

export type KimiToolGuardViolation = NonNullable<KimiCodeRequestDiagnostic['toolGuard']>

export const TOOL_ARGUMENT_BYTES_EXCEEDED_CODE = 'KIMI_TOOL_ARGUMENT_BYTES_EXCEEDED'
export const TOOL_ARGUMENT_REPEATED_KEY_CODE = 'KIMI_TOOL_ARGUMENT_REPEATED_KEY'
export type KimiToolArgumentGuardCode = typeof TOOL_ARGUMENT_BYTES_EXCEEDED_CODE | typeof TOOL_ARGUMENT_REPEATED_KEY_CODE

/** Whether one adapter failure belongs to the recoverable argument guard. */
export function isKimiToolArgumentGuardCode(code: unknown): code is KimiToolArgumentGuardCode {
  return code === TOOL_ARGUMENT_BYTES_EXCEEDED_CODE || code === TOOL_ARGUMENT_REPEATED_KEY_CODE
}

const ASK_USER_ARGUMENT_LIMIT = 32 * 1024
const LARGE_PROGRAM_ARGUMENT_LIMIT = 1024 * 1024
const DEFAULT_ARGUMENT_LIMIT = 256 * 1024
const REPEATED_KEY_LIMIT = 8
const MAX_TRACKED_KEY_GROUPS = 64
const MAX_SCANNED_KEY_CHARS = 1024

/** Large source/file payloads need a different ceiling from coordination cards. */
export function toolArgumentLimit(toolName: string): number {
  if (toolName === 'ask_user_question') return ASK_USER_ARGUMENT_LIMIT
  if (toolName === 'write' || toolName === 'edit' || toolName === 'code_run' || toolName === 'run_code') {
    return LARGE_PROGRAM_ARGUMENT_LIMIT
  }
  return DEFAULT_ARGUMENT_LIMIT
}

interface KeyGroup {
  count: number
  sawVariant: boolean
}

/** Split `header_comment`, `header_unused`, and `header___` into one family. */
function keyFamily(key: string): { stem: string; variant: boolean } {
  const suffix = /_(?:comment|unused)$|_+$/.exec(key)
  if (suffix === null || suffix.index === 0) return { stem: key, variant: false }
  return { stem: key.slice(0, suffix.index), variant: true }
}

export class KimiToolArgumentGuard {
  private bytes = 0
  private inString = false
  private escaped = false
  private afterString = false
  private stringRaw = ''
  private stringTooLong = false
  private highSurrogate = ''
  private readonly keyGroups = new Map<string, KeyGroup>()
  private violation: KimiToolGuardViolation | undefined

  constructor(private readonly toolName: string) {}

  observe(delta: string): KimiToolGuardViolation | undefined {
    if (this.violation !== undefined) return this.violation
    const text = this.highSurrogate + delta
    this.highSurrogate = ''
    if (text === '') return undefined
    const last = text.charCodeAt(text.length - 1)
    const complete = last >= 0xD800 && last <= 0xDBFF ? text.slice(0, -1) : text
    if (complete.length !== text.length) this.highSurrogate = text.at(-1) ?? ''
    this.bytes += Buffer.byteLength(complete, 'utf8')
    if (this.bytes > toolArgumentLimit(this.toolName)) {
      return this.fail('argument-bytes')
    }
    for (const char of complete) {
      const violation = this.observeChar(char)
      if (violation !== undefined) return violation
    }
    return undefined
  }

  /** Account for a trailing unmatched surrogate without leaving it unbudgeted. */
  finish(): KimiToolGuardViolation | undefined {
    if (this.highSurrogate !== '') {
      this.highSurrogate = ''
      this.bytes += Buffer.byteLength('\uD800', 'utf8')
      if (this.bytes > toolArgumentLimit(this.toolName)) return this.fail('argument-bytes')
    }
    return this.violation
  }

  private fail(rule: KimiToolGuardViolation['rule']): KimiToolGuardViolation {
    this.violation = { toolName: this.toolName || 'unknown', rule, bytes: this.bytes }
    return this.violation
  }

  private observeChar(char: string): KimiToolGuardViolation | undefined {
    if (this.inString) {
      if (this.escaped) {
        this.escaped = false
        if (!this.stringTooLong) this.stringRaw += char
        return undefined
      }
      if (char === '\\') {
        this.escaped = true
        if (!this.stringTooLong) this.stringRaw += char
        return undefined
      }
      if (char === '"') {
        this.inString = false
        this.afterString = true
        return undefined
      }
      if (!this.stringTooLong) {
        this.stringRaw += char
        if (this.stringRaw.length > MAX_SCANNED_KEY_CHARS) {
          this.stringTooLong = true
          this.stringRaw = ''
        }
      }
      return undefined
    }

    if (this.afterString) {
      if (/\s/.test(char)) return undefined
      this.afterString = false
      if (char === ':') {
        this.observeKey()
        return this.violation
      }
      this.stringRaw = ''
      this.stringTooLong = false
    }
    if (char === '"') {
      this.inString = true
      this.escaped = false
      this.stringRaw = ''
      this.stringTooLong = false
    }
    return undefined
  }

  private observeKey(): void {
    if (this.stringTooLong || this.stringRaw === '') return
    try {
      const key = JSON.parse('"' + this.stringRaw + '"') as unknown
      if (typeof key !== 'string' || key === '') return
      const family = keyFamily(key)
      if (family.stem === '') return
      const group = this.keyGroups.get(family.stem) ?? { count: 0, sawVariant: false }
      group.count += 1
      group.sawVariant ||= family.variant
      this.keyGroups.delete(family.stem)
      this.keyGroups.set(family.stem, group)
      while (this.keyGroups.size > MAX_TRACKED_KEY_GROUPS) {
        const oldest = this.keyGroups.keys().next()
        if (oldest.done !== true) this.keyGroups.delete(oldest.value)
      }
      if (group.sawVariant && group.count >= REPEATED_KEY_LIMIT) this.fail('repeated-key')
    } catch {
      // Malformed escape sequences remain the host parser's responsibility.
    }
  }
}
