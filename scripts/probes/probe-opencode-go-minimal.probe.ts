import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * Minimal live OpenCode Go validation. This is deliberately not a Provider:
 * streaming, tools, a continued session and quota are checked with three
 * low-output requests. Run explicitly with OPENCODE_API_KEY; never log the key.
 */
const BASE = 'https://opencode.ai/inference/go'
const CHAT_URL = BASE + '/openai/v1/chat/completions'
const apiKey = (process.env.OPENCODE_API_KEY ?? '').trim()
const offline = process.env.OPENCODE_PROBE_OFFLINE === '1'

type Obj = Record<string, unknown>
type ToolCall = { id: string; name: string; arguments: string }
type ChatResult = {
  text: string
  reasoning: string
  textDeltas: number
  reasoningDeltas: number
  toolCalls: ToolCall[]
  usage: Obj | null
  chunks: number
  done: boolean
}

function obj(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function redact(value: string): string {
  return apiKey === '' ? value : value.split(apiKey).join('[redacted]')
}

async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  const detail = redact((await response.text().catch(() => '')).slice(0, 1200))
  throw new Error('HTTP ' + response.status + (detail === '' ? '' : ': ' + detail))
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(BASE + path, {
    headers: { authorization: 'Bearer ' + apiKey, 'user-agent': 'dsh-opencode-go-minimal-probe/0.1.0' },
    signal: AbortSignal.timeout(60_000),
  })
  await ensureOk(response)
  return response.json()
}

async function readEvents(response: Response): Promise<{ events: Obj[]; chunks: number; done: boolean }> {
  if (response.body === null) throw new Error('empty streaming response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events: Obj[] = []
  let chunks = 0
  let done = false
  let pending = ''
  const consume = (line: string): void => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '') return
    if (data === '[DONE]') {
      done = true
      return
    }
    events.push(obj(JSON.parse(data)))
  }
  while (true) {
    const part = await reader.read()
    if (part.done) break
    chunks += 1
    pending += decoder.decode(part.value, { stream: true })
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) consume(line)
  }
  pending += decoder.decode()
  if (pending !== '') consume(pending)
  return { events, chunks, done }
}

function chatResult(events: Obj[], chunks: number, done: boolean): ChatResult {
  let text = ''
  let reasoning = ''
  let textDeltas = 0
  let reasoningDeltas = 0
  let usage: Obj | null = null
  const tools = new Map<number, ToolCall>()
  for (const event of events) {
    if (Object.keys(obj(event.usage)).length > 0) usage = obj(event.usage)
    for (const rawChoice of list(event.choices)) {
      const delta = obj(obj(rawChoice).delta)
      if (typeof delta.content === 'string' && delta.content !== '') {
        text += delta.content
        textDeltas += 1
      }
      const thought = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : delta.reasoning
      if (typeof thought === 'string' && thought !== '') {
        reasoning += thought
        reasoningDeltas += 1
      }
      for (const rawTool of list(delta.tool_calls)) {
        const item = obj(rawTool)
        const index = typeof item.index === 'number' ? item.index : 0
        const current = tools.get(index) ?? { id: '', name: '', arguments: '' }
        if (typeof item.id === 'string') current.id += item.id
        const fn = obj(item.function)
        if (typeof fn.name === 'string') current.name += fn.name
        if (typeof fn.arguments === 'string') current.arguments += fn.arguments
        tools.set(index, current)
      }
    }
  }
  return { text, reasoning, textDeltas, reasoningDeltas, toolCalls: [...tools.values()], usage, chunks, done }
}

test('offline SSE parser sanity', async () => {
  const fixture = [
    'data: {"choices":[{"delta":{"reasoning_content":"think","content":"OK"}}]}',
    '',
    'data: {"choices":[],"usage":{"cost":0}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const result = await readEvents(new Response(fixture))
  const chat = chatResult(result.events, result.chunks, result.done)
  assert.equal(chat.text, 'OK')
  assert.equal(chat.reasoning, 'think')
  assert.equal(chat.done, true)
})

test('OpenCode Go minimal live validation', { skip: offline, timeout: 300_000 }, async () => {
  if (apiKey === '') throw new Error('OPENCODE_API_KEY is required; no live request was attempted')
  const catalog = obj(await getJson('/v1/models'))
  const models = list(catalog.data).map(obj)
  const requested = (process.env.OPENCODE_GO_MODEL ?? '').trim()
  const candidates = requested !== '' ? [requested] : ['deepseek-v4.1-flash', 'deepseek-v4-pro']
  let selected = models.find(model => candidates.includes(String(model.id)))
  if (selected === undefined && requested === '') {
    selected = models.find(model => model.type === 'chat' && obj(model.capabilities).tools !== undefined && model.recommended_api === 'chat-completions')
  }
  if (selected === undefined) throw new Error('no usable Go chat model found; check workspace privacy/model access')
  const model = String(selected.id)
  const canonicalId = typeof selected.canonical_id === 'string' ? selected.canonical_id : null
  const efforts = list(obj(obj(selected.capabilities).reasoning).effort).map(String)
  const reasoningEffort = efforts.includes('low') ? 'low' : undefined
  console.log('[probe] model ' + JSON.stringify({ id: model, canonicalId, fallback: !candidates.includes(model), reasoningEffort: reasoningEffort ?? 'upstream-default' }))

  const usageBefore = obj(obj(await getJson('/v1/usage')).usage)
  for (const name of ['rolling', 'weekly', 'monthly']) {
    const meter = obj(usageBefore[name])
    assert.equal(typeof meter.percent, 'number')
    assert.ok(Number(meter.percent) >= 0)
    assert.ok(Number(meter.percent) <= 100)
    assert.ok(['ok', 'rate-limited'].includes(String(meter.status)))
    assert.equal(Number.isNaN(Date.parse(String(meter.resetsAt))), false)
  }
  console.log('[probe] PASS quota ' + JSON.stringify(usageBefore))
  if (Object.values(usageBefore).some(value => obj(value).status === 'rate-limited')) {
    throw new Error('a Go allowance is exhausted; inference stopped to avoid Extra Usage charges')
  }

  const sessionId = 'ses_dsh_probe_' + randomUUID()
  const sessionHeaders: string[] = []
  const tool = {
    type: 'function',
    function: {
      name: 'probe_echo',
      description: 'Return the supplied probe value.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
    },
  }
  const postChat = async (messages: unknown[], tools: unknown[] | null, toolChoice: unknown): Promise<ChatResult> => {
    sessionHeaders.push(sessionId)
    const response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + apiKey,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'user-agent': 'dsh-opencode-go-minimal-probe/0.1.0',
        'x-opencode-session': sessionId,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 768,
        ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
        ...(tools === null ? {} : { tools, tool_choice: toolChoice }),
      }),
      signal: AbortSignal.timeout(90_000),
    })
    await ensureOk(response)
    assert.ok((response.headers.get('content-type') ?? '').includes('text/event-stream'))
    const stream = await readEvents(response)
    const result = chatResult(stream.events, stream.chunks, stream.done)
    assert.equal(result.done, true)
    assert.notEqual(result.usage, null)
    assert.equal(Number(obj(result.usage).cost ?? 0), 0)
    return result
  }

  const system = { role: 'system', content: 'You are a precise API compatibility probe. Follow instructions exactly.' }
  const first = await postChat([system, { role: 'user', content: 'Reply with exactly OK and nothing else.' }], null, null)
  assert.ok(first.textDeltas > 0)
  assert.match(first.text, /OK/i)
  console.log('[probe] PASS streaming ' + JSON.stringify({ text: first.text, textDeltas: first.textDeltas, reasoningDeltas: first.reasoningDeltas, chunks: first.chunks }))

  const toolMessages = [system, { role: 'user', content: 'Call probe_echo exactly once with value opencode-go-ok. After its tool result arrives, reply with exactly TOOL_OK and nothing else.' }]
  const called = await postChat(toolMessages, [tool], 'auto')
  assert.equal(called.toolCalls.length, 1)
  const call = called.toolCalls[0]
  assert.equal(call.name, 'probe_echo')
  assert.notEqual(call.id, '')
  assert.deepEqual(JSON.parse(call.arguments), { value: 'opencode-go-ok' })
  console.log('[probe] PASS tool call ' + JSON.stringify({ name: call.name, arguments: call.arguments }))

  const continued = await postChat([
    ...toolMessages,
    { role: 'assistant', content: called.text || null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] },
    { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ echo: 'opencode-go-ok' }) },
  ], [tool], 'none')
  assert.match(continued.text, /TOOL_OK/i)
  assert.equal(sessionHeaders.length, 3)
  assert.equal(new Set(sessionHeaders).size, 1)
  console.log('[probe] PASS continued session ' + JSON.stringify({ requests: sessionHeaders.length, stableHeader: true, text: continued.text }))
  console.log('[probe] RESULT ' + JSON.stringify({ verdict: 'PASS', model, canonicalId, checks: ['quota', 'streaming', 'tool-call', 'continued-session'], note: 'Same session header accepted; cache-hit behavior was not asserted.' }))
})
