/**
 * Real Kimi cache smoke for retrieval projection.
 *
 * Exactly four model requests, with no retry:
 * A/C create two independent prefixes, B appends a raw file result, and D appends
 * its projected outline. Both continuations must read their own prefix back;
 * D's uncached suffix must be smaller than B's. No credentials or result bodies
 * are printed.
 *
 * Run:
 *   npx vitest run --config vitest.probe.config.ts scripts/probe-cache-warmup-retrieval.probe.ts
 */
import { expect, test } from 'vitest'
import { ensureAccessToken, kimiIdentityHeaders } from '../src/host/kimi-code/oauth.ts'
import { FileCredentialStore, resolveRegion } from '../src/host/kimi-code/token-store.ts'
import { openAIUrl } from '../src/host/kimi-code/types.ts'
import { projectToolResult } from '../src/host/cache-warmup/projection.ts'
import type { ResultReferenceStore } from '../src/host/cache-warmup/contracts.ts'

const NL = String.fromCharCode(10)
const MODEL = process.env.PROBE_MODEL ?? 'k3.1-pro'
const FILLER = Array.from({ length: 80 }, (_, index) => 'Cache smoke filler sentence ' + index + '.').join(' ')
const SALT = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

function rawSource(): string {
  const lines = ['1: import fs from "node:fs"']
  for (let line = 2; line <= 80; line += 1) {
    if (line === 20) lines.push('20: export function locateTarget() {')
    else if (line === 50) lines.push('50: export class TargetIndex {')
    else lines.push(line + ':   doWorkWithSomeLongOperationName(' + line + ')')
  }
  lines.push('81: }')
  return lines.join(NL)
}

const store = {
  put: async (input: { sessionId: string, content: string }) => ({
    refId: 'ref://' + input.sessionId + '/' + '0'.repeat(64),
    sessionId: input.sessionId,
    digest: '0'.repeat(64),
    bytes: Buffer.byteLength(input.content),
    chars: input.content.length,
    at: Date.now(),
    created: true,
  }),
  page: async () => { throw new Error('not used') },
  release: async () => { throw new Error('not used') },
} as unknown as ResultReferenceStore

interface Usage {
  prompt: number
  cached: number
  fresh: number
}

async function send(
  token: string,
  region: Awaited<ReturnType<typeof resolveRegion>>,
  salt: string,
  suffix?: string,
): Promise<Usage> {
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: 'You are a cache probe. Reply with the single word OK. ' + salt + ' ' + FILLER },
    { role: 'user', content: 'Create this probe prefix. Reply OK.' },
  ]
  if (suffix !== undefined) {
    messages.push(
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'A new tool result follows. Read it and reply OK.' + NL + suffix },
    )
  }
  const response = await fetch(openAIUrl('/chat/completions', region), {
    method: 'POST',
    headers: {
      ...(await kimiIdentityHeaders({ authorization: 'Bearer ' + token, accept: 'application/json' })),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 32,
      messages,
    }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error('HTTP ' + String(response.status) + ': ' + text.slice(0, 500))
  let usage: Record<string, unknown> = {}
  for (const line of text.split(NL)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      if (parsed.usage !== undefined && parsed.usage !== null) usage = parsed.usage as Record<string, unknown>
    } catch {
      // Keep-alive frame.
    }
  }
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined
  const prompt = Number(usage.prompt_tokens ?? 0)
  const cached = Number(details?.cached_tokens ?? 0)
  return { prompt, cached, fresh: Math.max(0, prompt - cached) }
}

test('retrieval projection preserves prefix reuse and reduces uncached suffix', async () => {
  const credentials = await ensureAccessToken(new FileCredentialStore())
  const region = await resolveRegion()
  const raw = rawSource()
  const projected = await projectToolResult({
    toolName: 'read',
    sessionId: 'probe-retrieval',
    content: raw,
    navigation: true,
    budget: { maxChars: 1200, warmup: true, consecutiveHits: 0, hitRatio: 0 },
    store,
  })
  expect(projected.changed).toBe(true)
  expect(projected.preview).toBeDefined()

  const rawCold = await send(credentials.accessToken, region, 'raw-' + SALT)
  console.log('[probe] A raw cold       prompt=' + rawCold.prompt + ' cached=' + rawCold.cached + ' fresh=' + rawCold.fresh)
  const rawNext = await send(credentials.accessToken, region, 'raw-' + SALT, raw)
  console.log('[probe] B raw result     prompt=' + rawNext.prompt + ' cached=' + rawNext.cached + ' fresh=' + rawNext.fresh)

  const projectedCold = await send(credentials.accessToken, region, 'outline-' + SALT)
  console.log('[probe] C outline cold   prompt=' + projectedCold.prompt + ' cached=' + projectedCold.cached + ' fresh=' + projectedCold.fresh)
  const projectedNext = await send(credentials.accessToken, region, 'outline-' + SALT, projected.preview!)
  console.log('[probe] D outline result prompt=' + projectedNext.prompt + ' cached=' + projectedNext.cached + ' fresh=' + projectedNext.fresh)

  expect(rawNext.cached).toBeGreaterThan(0)
  expect(projectedNext.cached).toBeGreaterThan(0)
  expect(projectedNext.fresh).toBeLessThan(rawNext.fresh)
}, 240_000)
