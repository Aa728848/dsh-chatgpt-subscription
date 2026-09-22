/**
 * One-time import of the preferences earlier releases kept in the harness's own
 * settings document.
 *
 * Before harness 0.1.7 the plugin registered the `dsh-chatgpt-subscription`
 * namespace, so the harness persisted these preferences into
 * `$DSH_HOME/settings.yaml`. That document no longer exists from 0.1.7 on — the
 * plugin owns its storage there — so a generation without the register seam reads
 * the old section once and seeds the plugin document from it. A harness that
 * moved the document itself renames it to `settings.yaml.imported`, which is why
 * both names are read.
 *
 * The section is read from text rather than through a YAML dependency: this
 * package ships no YAML parser, and only its own four shapes ever appear under
 * that key — scalars, one nested map (`contextWindowOverrides`), block sequences
 * (`visibleModelIds`), and inline flow arrays. Anything the reader cannot make
 * sense of is left out, and the schema that validates the document decides what
 * the values mean.
 * @module dsh-chatgpt-subscription/legacy-preferences
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { PREFERENCES_NAMESPACE } from '../../shared/preferences.ts'
import { dshHomeDir } from '../antigravity/token-store.ts'

/** Documents earlier harness releases may still hold the section in, in read order. */
const LEGACY_DOCUMENTS = ['settings.yaml', 'settings.yaml.imported'] as const

/**
 * Read the plugin's preferences out of the settings documents of earlier releases.
 *
 * @param homeDir - Harness home holding the documents; defaults to the live one.
 * @returns The stored preference values, or `undefined` when no document carries
 * a non-empty section for this plugin.
 */
export async function readLegacyPreferences(homeDir = dshHomeDir()): Promise<Record<string, unknown> | undefined> {
  for (const name of LEGACY_DOCUMENTS) {
    const document = await fs.readFile(path.join(homeDir, name), 'utf8').catch(() => undefined)
    if (document === undefined) continue
    const section = sectionOf(document, PREFERENCES_NAMESPACE)
    if (section !== undefined && Object.keys(section).length > 0) return section
  }
  return undefined
}

/** Lines that carry content: blank and comment-only lines never do. */
function contentLines(document: string): string[] {
  return document.split(/\r?\n/).filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
}

/** Indentation width of one line. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** The `key: value` split of one mapping entry, or `undefined` for a line that is not one. */
function entryOf(line: string): { key: string; inline: string } | undefined {
  const match = /^\s*("[^"]*"|'[^']*'|[^:\s][^:]*):(?:\s+(.*))?$/.exec(line)
  if (match === null) return undefined
  const rawKey = match[1]!.trim()
  const quoted = /^(["']).*\1$/.test(rawKey)
  return { key: quoted ? rawKey.slice(1, -1) : rawKey, inline: (match[2] ?? '').trim() }
}

/** Parse one indented mapping block. */
function parseMap(lines: readonly string[], indent: number): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    const own = indentOf(line)
    if (own < indent) break
    index += 1
    if (own > indent) continue
    const entry = entryOf(line)
    if (entry === undefined) continue
    if (entry.inline !== '') {
      result[entry.key] = parseScalar(entry.inline)
      continue
    }
    const body: string[] = []
    while (index < lines.length && indentOf(lines[index]!) > own) body.push(lines[index++]!)
    if (body.length === 0) continue
    const childIndent = indentOf(body[0]!)
    const nested = body[0]!.trimStart().startsWith('-')
      ? parseSequence(body, childIndent)
      : parseMap(body, childIndent)
    if (nested !== undefined) result[entry.key] = nested
  }
  return result
}

/** Parse one block sequence; entries that are not plain scalars make the whole key unusable. */
function parseSequence(lines: readonly string[], indent: number): unknown[] | undefined {
  const result: unknown[] = []
  for (const line of lines) {
    const text = line.trimStart()
    if (indentOf(line) < indent) break
    if (!text.startsWith('-')) return undefined
    const item = text.slice(1).trim()
    if (item === '' || entryOf(item) !== undefined) return undefined
    result.push(parseScalar(item))
  }
  return result
}

/** A trailing ` # comment`, kept out of plain scalars and ignored inside quotes. */
function stripComment(raw: string): string {
  if (raw.startsWith('"') || raw.startsWith("'")) return raw
  const index = raw.search(/\s#/)
  return index === -1 ? raw : raw.slice(0, index).trimEnd()
}

/** Index of the quote closing a scalar that opens at index 0. */
function closingQuoteIndex(text: string, quote: string): number | undefined {
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index]
    if (quote === '"' && char === '\\') {
      index += 1
      continue
    }
    if (char !== quote) continue
    if (quote === "'" && text[index + 1] === "'") {
      index += 1
      continue
    }
    return index
  }
  return undefined
}

/** A quoted scalar; anything after its closing quote is a trailing comment. */
function parseQuoted(text: string): unknown | undefined {
  const quote = text[0]
  if (quote !== '"' && quote !== "'") return undefined
  const end = closingQuoteIndex(text, quote)
  if (end === undefined) return undefined
  const value = text.slice(1, end)
  if (quote === "'") return value.replace(/''/g, "'")
  try {
    return JSON.parse(text.slice(0, end + 1)) as unknown
  } catch {
    return value
  }
}

/** One scalar, flow array, or quoted string. */
function parseScalar(raw: string): unknown {
  const text = stripComment(raw)
  const quoted = parseQuoted(text)
  if (quoted !== undefined) return quoted
  if (text.startsWith('[') && text.endsWith(']')) {
    return text.slice(1, -1).split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
      .map((item) => parseScalar(item))
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === '' || text === 'null' || text === '~') return null
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  return text
}

/** The block nested under one top-level `id:` key. */
function sectionOf(document: string, id: string): Record<string, unknown> | undefined {
  const lines = contentLines(document)
  const start = lines.findIndex((line) => indentOf(line) === 0 && entryOf(line)?.key === id)
  if (start === -1) return undefined
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (indentOf(line) === 0) break
    body.push(line)
  }
  if (body.length === 0) return undefined
  return parseMap(body, indentOf(body[0]!))
}
