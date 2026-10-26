/**
 * Does a message-level tool declaration keep Kimi's prefix cache?
 *
 * The one thing the public measurements do not answer (pi-provider-kimi-code's
 * caching.md states it explicitly: "system/tools invalidation on the
 * OpenAI-compat endpoint is not yet directly measured"). This probe answers it
 * on this account with four real requests.
 *
 * Method
 *  - A: system + tools[A] + one user turn.            writes the cache
 *  - B: A + two more turns.                            must read A back
 *  - C: A + a message-level tool declaration + turns.  must ALSO read A back
 *  - D: control, same history as B but tools[A,B].     must lose A
 *
 * Run:
 *   npx vitest run --config vitest.probe.config.ts scripts/probe-kimi-tool-declaration.probe.ts
 *
 * Cost: four small requests. Nothing is uploaded and no file is touched.
 */
import { expect, test } from 'vitest'
import { ensureAccessToken, kimiIdentityHeaders } from '../src/host/kimi-code/oauth.ts'
import { FileCredentialStore, resolveRegion } from '../src/host/kimi-code/token-store.ts'
import { openAIUrl } from '../src/host/kimi-code/types.ts'

/** Unique prefix per run, so a previous run can neither warm nor poison this one. */
const SALT = 'probe-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

/** Padding pushes the prompt well past the 256-token alignment the cache uses. */
const FILLER = Array.from({ length: 120 }, (_, index) => 'Filler sentence number ' + index + ' for the prefix probe.').join(' ')

const MODEL = process.env.PROBE_MODEL ?? 'kimi-for-coding'

function toolSchema(name: string) {
  return {
    type: 'function',
    function: {
      name,
      description: 'Probe tool ' + name + '. Never call it.',
      parameters: { type: 'object', properties: {} },
    },
  }
}

interface ProbeResult {
  cached: number
  prompt: number
}

async function send(
  token: string,
  region: Awaited<ReturnType<typeof resolveRegion>>,
  body: Record<string, unknown>,
): Promise<ProbeResult> {
  const response = await fetch(openAIUrl('/chat/completions', region), {
    method: 'POST',
    headers: {
      ...(await kimiIdentityHeaders({ authorization: 'Bearer ' + token, accept: 'application/json' })),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, stream: true, stream_options: { include_usage: true }, ...body }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error('HTTP ' + String(response.status) + ': ' + text.slice(0, 500))
  let usage: Record<string, unknown> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      if (parsed.usage !== undefined && parsed.usage !== null) usage = parsed.usage as Record<string, unknown>
    } catch {
      // A partial or keep-alive frame: the usage frame is the last one that parses.
    }
  }
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined
  return {
    cached: Number(details?.cached_tokens ?? 0),
    prompt: Number(usage.prompt_tokens ?? 0),
  }
}

interface ToolCallResult extends ProbeResult {
  calls: string[]
}

/**
 * Send one request and collect the tool names the model actually invoked.
 *
 * The first probe proves a declaration does not break the prefix; this one
 * proves the model ACTS on a tool that was declared that way. Without it the
 * whole feature would be a well-cached no-op.
 */
async function sendForCalls(
  token: string,
  region: Awaited<ReturnType<typeof resolveRegion>>,
  body: Record<string, unknown>,
): Promise<ToolCallResult> {
  const response = await fetch(openAIUrl('/chat/completions', region), {
    method: 'POST',
    headers: {
      ...(await kimiIdentityHeaders({ authorization: 'Bearer ' + token, accept: 'application/json' })),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, stream: true, stream_options: { include_usage: true }, ...body }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error('HTTP ' + String(response.status) + ': ' + text.slice(0, 500))
  const calls: string[] = []
  let usage: Record<string, unknown> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as {
        usage?: Record<string, unknown>
        choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { name?: string } }> } }>
      }
      if (parsed.usage !== undefined && parsed.usage !== null) usage = parsed.usage
      for (const choice of parsed.choices ?? []) {
        for (const call of choice.delta?.tool_calls ?? []) {
          const name = call.function?.name
          if (typeof name === 'string' && name !== '' && !calls.includes(name)) calls.push(name)
        }
      }
    } catch {
      // Keep-alive or partial frame.
    }
  }
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined
  return { calls, cached: Number(details?.cached_tokens ?? 0), prompt: Number(usage.prompt_tokens ?? 0) }
}

const SYSTEM = 'You are a probe. Answer with the single word OK and nothing else. ' + SALT + ' ' + FILLER
const FIRST = 'Probe turn one (' + SALT + '). Reply OK.'
const SECOND = 'Probe turn two. Reply OK.'
const THIRD = 'Probe turn three. Reply OK.'
const FOURTH = 'Probe turn four. Reply OK.'
const FIFTH = 'Probe turn five. Reply OK.'

function turns(extra: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: FIRST },
    ...extra,
  ]
}

test('a message-level tool declaration keeps the prefix cache', async () => {
  const store = new FileCredentialStore()
  const region = await resolveRegion()
  const credentials = await ensureAccessToken(store)

  const toolsA = [toolSchema('probe_alpha')]
  const toolsAB = [toolSchema('probe_alpha'), toolSchema('probe_beta')]

  const cold = await send(credentials.accessToken, region, { messages: turns(), tools: toolsA })
  console.log('[probe] A cold            prompt=' + cold.prompt + ' cached=' + cold.cached)

  const grown = await send(credentials.accessToken, region, {
    messages: turns([
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: SECOND },
    ]),
    tools: toolsA,
  })
  console.log('[probe] B grow tail       prompt=' + grown.prompt + ' cached=' + grown.cached)

  const declared = await send(credentials.accessToken, region, {
    messages: turns([
      { role: 'assistant', content: 'OK' },
      { role: 'system', tools: [toolSchema('probe_beta')] },
      { role: 'user', content: THIRD },
    ]),
    tools: toolsA,
  })
  console.log('[probe] C declaration     prompt=' + declared.prompt + ' cached=' + declared.cached)

  // in-history expresses a removal by appending a note while the declaration
  // list stays exactly as it was — the shape this route now sends.
  const revoked = await send(credentials.accessToken, region, {
    messages: turns([
      { role: 'assistant', content: 'OK' },
      { role: 'system', content: '["probe_beta" is no longer available. Do not call it again: any call will fail.]' },
      { role: 'user', content: FIFTH },
    ]),
    tools: toolsA,
  })
  console.log('[probe] E revocation      prompt=' + revoked.prompt + ' cached=' + revoked.cached)

  const rewritten = await send(credentials.accessToken, region, {
    messages: turns([
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: FOURTH },
    ]),
    tools: toolsAB,
  })
  console.log('[probe] D tools rewritten prompt=' + rewritten.prompt + ' cached=' + rewritten.cached)

  // The prefix A wrote must be read back by a plain extension of it. The
  // absolute number is 256-token aligned, so it can sit a chunk below the
  // written prompt; what matters is that it is not zero.
  expect(grown.cached).toBeGreaterThan(cold.prompt * 0.7)
  // The claim under test: a declaration appended at the tail loses nothing
  // relative to a plain extension of the same prefix.
  expect(declared.cached).toBeGreaterThanOrEqual(grown.cached)
  // A revocation note, with the declaration list untouched, costs nothing either.
  expect(revoked.cached).toBeGreaterThanOrEqual(grown.cached)
  // Control: rewriting the top-level list is what loses the prefix.
  expect(rewritten.cached).toBeLessThan(cold.prompt * 0.5)
}, 180_000)

test('the model calls a tool declared through messages[].tools', async () => {
  const store = new FileCredentialStore()
  const region = await resolveRegion()
  const credentials = await ensureAccessToken(store)

  const echo = {
    type: 'function',
    function: {
      name: 'probe_echo',
      description: 'Echo one value back. Call it whenever the user asks you to echo something.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string', description: 'The value to echo.' } },
        required: ['value'],
        additionalProperties: false,
      },
    },
  }

  const result = await sendForCalls(credentials.accessToken, region, {
    messages: [
      { role: 'system', content: 'You are a probe. Use a tool when one fits. You have no tools except those declared in this conversation.' },
      // The only place probe_echo exists: a message-level declaration, which is
      // exactly what the harness will append when a tool is added mid-session.
      { role: 'system', tools: [echo] },
      { role: 'user', content: 'Call probe_echo with value "42". Do not answer from memory.' },
    ],
    tools: [toolSchema('probe_alpha')],
  })

  console.log('[probe] declared-tool call  tools=' + JSON.stringify(result.calls) + ' prompt=' + result.prompt + ' cached=' + result.cached)
  expect(result.calls).toContain('probe_echo')
}, 180_000)
