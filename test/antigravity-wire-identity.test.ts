import { describe, expect, it } from 'vitest'
import {
  antigravityHeaders,
  jsonHeaders,
  legacyIdentityHeadersEnabled,
} from '../src/host/antigravity/client.ts'
import { buildImageRequest } from '../src/host/antigravity/image-tool.ts'
import { buildRequest } from '../src/host/antigravity/mapper.ts'
import {
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  FALLBACK_PROJECT_ID,
  MODELS,
} from '../src/host/antigravity/types.ts'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'

/**
 * What this route's requests actually look like on the wire.
 *
 * Everything here is a claim about the bytes an upstream sees, so each case
 * names the captured client behaviour it keeps: the header set the native
 * `language_server` sends, the persona it states, and the envelope identifiers
 * it generates. A regression that reintroduces a plugin-only marker belongs
 * here rather than in a mapper detail test.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** The two headers a captured Antigravity request does not carry. */
const IDE_HEADERS = ['X-Goog-Api-Client', 'Client-Metadata']

const NATIVE_HEADERS = ['Accept', 'Authorization', 'Content-Type', 'User-Agent']

function withLegacyFlag<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.DSH_ANTIGRAVITY_LEGACY_HEADERS
  try {
    if (value === undefined) delete process.env.DSH_ANTIGRAVITY_LEGACY_HEADERS
    else process.env.DSH_ANTIGRAVITY_LEGACY_HEADERS = value
    return run()
  } finally {
    if (previous === undefined) delete process.env.DSH_ANTIGRAVITY_LEGACY_HEADERS
    else process.env.DSH_ANTIGRAVITY_LEGACY_HEADERS = previous
  }
}

function chatRequest(system?: string): Record<string, unknown> {
  const options = {
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    ...(system === undefined ? {} : { system }),
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  } as unknown as GenerateOptions
  const model = MODELS.find((m) => m.id === 'gemini-3.8-flash')!
  return buildRequest(options, model, FALLBACK_PROJECT_ID, 'gemini-3.8-flash-tiered', 'medium')
}

function partsOf(request: Record<string, unknown>): Array<{ text: string }> {
  const body = request.request as { systemInstruction: { parts: Array<{ text: string }> } }
  return body.systemInstruction.parts
}

describe('Antigravity wire identity', () => {
  it('sends only the headers a captured request carries', () => {
    withLegacyFlag(undefined, () => {
      const headers = antigravityHeaders('tok')
      expect(Object.keys(headers).sort()).toEqual(NATIVE_HEADERS)
      expect(headers.Authorization).toBe('Bearer tok')
      expect(headers['Content-Type']).toBe('application/json')
      expect(headers.Accept).toBe('text/event-stream')
      // The version tuple is the measured one: the service gates its model
      // catalogue on it, so the shape is as load-bearing as the value.
      expect(headers['User-Agent']).toContain('antigravity/hub/')
      expect(headers['User-Agent']).toContain('aidev_client')
      for (const name of IDE_HEADERS) expect(headers[name]).toBeUndefined()
    })
  })

  it('restores the legacy identity headers behind the documented switch', () => {
    for (const on of ['1', 'true', 'yes', 'on', ' TRUE ']) {
      withLegacyFlag(on, () => {
        expect(legacyIdentityHeadersEnabled()).toBe(true)
        const headers = antigravityHeaders('tok')
        expect(headers['X-Goog-Api-Client']).toBe('google-cloud-sdk vscode_cloudshelleditor/0.1')
        const metadata = JSON.parse(headers['Client-Metadata'] as string) as Record<string, unknown>
        expect(metadata.ideType).toBe('ANTIGRAVITY')
        expect(metadata.pluginType).toBe('GEMINI')
        expect(['MACOS', 'WINDOWS', 'LINUX']).toContain(metadata.platform as string)
      })
    }
    for (const off of [undefined, '', '  ', '0', 'false', 'no']) {
      withLegacyFlag(off, () => {
        expect(legacyIdentityHeadersEnabled()).toBe(false)
        expect(Object.keys(antigravityHeaders('tok')).sort()).toEqual(NATIVE_HEADERS)
      })
    }
  })

  it('keeps the JSON calls on that same header set, swapping only Accept', () => {
    withLegacyFlag(undefined, () => {
      const headers = jsonHeaders('tok')
      expect(headers.Accept).toBe('application/json')
      expect(Object.keys(headers).sort()).toEqual(NATIVE_HEADERS)
      for (const name of IDE_HEADERS) expect(headers[name]).toBeUndefined()
    })
  })

  it('carries the attested persona alone in systemInstruction', () => {
    const request = chatRequest()
    expect(partsOf(request)).toEqual([{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }])
    expect(ANTIGRAVITY_SYSTEM_INSTRUCTION).toContain(
      'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team',
    )
    const serialized = JSON.stringify(request)
    // The three strings this route used to invent. Two were instructions; the
    // third was its own paraphrase of the persona.
    expect(serialized).not.toContain('[ignore]')
    expect(serialized).not.toContain('NEVER output rule checks')
    expect(serialized).not.toContain('Be concise, practical')
  })

  it('keeps the caller system prompt as its own part', () => {
    const request = chatRequest('Project rules')
    expect(partsOf(request)).toEqual([
      { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
      { text: 'Project rules' },
    ])
  })

  it('identifies both envelopes with the Hub request-id form', () => {
    const chat = chatRequest()
    const image = buildImageRequest('a cat', FALLBACK_PROJECT_ID)
    const chatId = String(chat.requestId)
    const imageId = String(image.requestId)
    // The Hub's own ids are `agent-<unique>`; the unique half is an opaque UUID.
    expect(chatId).toMatch(/^agent-[0-9a-f-]{36}$/i)
    expect(imageId).toMatch(/^agent-[0-9a-f-]{36}$/i)
    expect(chatId.slice('agent-'.length)).toMatch(UUID_V4)
    expect(imageId.slice('agent-'.length)).toMatch(UUID_V4)
    expect(chatId).not.toBe(imageId)
    // The millisecond-stamped forms these replaced leaked both a clock and the
    // route's own prefix vocabulary.
    expect(chatId.startsWith('req_')).toBe(false)
    expect(imageId.startsWith('img_')).toBe(false)
  })

  it('names the ecosystem fallback project instead of an invented placeholder', () => {
    expect(FALLBACK_PROJECT_ID).toBe('rising-fact-p41fc')
    expect(chatRequest().project).toBe(FALLBACK_PROJECT_ID)
    expect(buildImageRequest('a cat', FALLBACK_PROJECT_ID).project).toBe(FALLBACK_PROJECT_ID)
    expect(JSON.stringify(chatRequest())).not.toContain('antigravity-default')
  })
})
