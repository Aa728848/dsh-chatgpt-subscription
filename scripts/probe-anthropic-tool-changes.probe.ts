/**
 * One-shot probe: does an Anthropic-shaped subscription line accept a
 * mid-conversation `tool_addition` block, and which beta marker does it want?
 *
 * The question this answers is not "is the field documented" — it is "does THIS
 * upstream implement it". GLM's Anthropic-compatible face already refuses it in
 * this repo's own code, which is exactly why a probe is needed per line instead
 * of an inference from the protocol shape.
 *
 * Wired today: minimax-code (its own `probeRequestHeaders` + `messagesUrl`, so
 * the probe cannot drift from the line's real Bearer rule). The other
 * Anthropic-shaped lines need their own auth path before they can run here; the
 * request body below is identical for all of them.
 *
 * Each marker is tried separately, because the two betas license different
 * shapes: `mid-conversation-tool-changes-2026-07-01` covers a change that names a
 * declared tool, `inline-tools-2026-09-15` adds defining one by value. This body
 * names a declared tool, so the narrow marker should be the one that works.
 *
 * Run: npx vitest run --config vitest.probe.config.ts scripts/probe-anthropic-tool-changes.probe.ts
 *
 * Reads real `~/.dsh` credentials and never prints a token: only status codes,
 * error text and whether the tool was called.
 */
import { test } from 'vitest'
import { MinimaxCodeCredentialStore } from '../src/host/minimax-code/token-store.ts'
import { MinimaxCodeAccountPool } from '../src/host/minimax-code/account-pool.ts'
import { ensureAccessToken } from '../src/host/minimax-code/oauth.ts'
import { PROBE_MODEL, probeRequestHeaders } from '../src/host/minimax-code/client.ts'
import { messagesUrl } from '../src/host/minimax-code/types.ts'
import { GlmCodingPlanCredentialStore } from '../src/host/glm-coding-plan/token-store.ts'
import { glmAnthropicUrl } from '../src/host/glm-coding-plan/mapper-anthropic.ts'
import { glmAnthropicProbeHeaders } from '../src/host/glm-coding-plan/client.ts'
import { FileCredentialStore as CommandCodeCredentialStore } from '../src/host/command-code/token-store.ts'
import { providerUrl } from '../src/host/command-code/types.ts'
import { commandCodeHeaders } from '../src/host/command-code/client.ts'

const NARROW_BETA = 'mid-conversation-tool-changes-2026-07-01'
const WIDE_BETA = 'inline-tools-2026-09-15'

const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: 'Look up a probe value by key.',
  input_schema: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
  },
  ...extra,
})

/**
 * The canonical change shape: the added tool is DECLARED at the head with
 * `defer_loading` and the block names it. Both halves matter — the declaration
 * is what keeps the head stable, the block is what makes the tool callable.
 */
const body = {
  model: PROBE_MODEL,
  max_tokens: 64,
  stream: false,
  tools: [tool('probe_lookup'), tool('probe_extra', { defer_loading: true })],
  messages: [
    { role: 'user', content: 'Reply with the single word OK.' },
    {
      role: 'system',
      content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'probe_extra' } }],
    },
    { role: 'user', content: 'Now call probe_extra with key "x". Do not explain.' },
  ],
}

/**
 * Command Code's Anthropic face, asked the same three questions.
 *
 * This line routes per MODEL, not per request: a `claude-*` id goes to
 * `/messages`, everything else to `/chat/completions`. So the model id is part of
 * the probe, not a detail of it.
 */
test('command-code: does the Anthropic face accept a tool_addition block', async () => {
  const store = new CommandCodeCredentialStore()
  const credentials = await store.read().catch(() => null)
  if (credentials === null || typeof credentials.apiKey !== 'string' || credentials.apiKey.trim() === '') {
    console.log('[probe] command-code: no credential on disk, skipped')
    return
  }
  const model = process.env.PROBE_COMMAND_CODE_MODEL ?? 'claude-sonnet-5-5'
  const url = providerUrl() + '/messages'
  console.log('[probe] command-code url =', url, 'model =', model)

  const headers = commandCodeHeaders(credentials.apiKey)
  const ask = async (label: string, payload: Record<string, unknown>, beta?: string): Promise<void> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: beta === undefined ? headers : { ...headers, 'anthropic-beta': beta },
      body: JSON.stringify(payload),
    })
    const text = await response.text()
    if (!response.ok) {
      console.log(`[probe] ${label}: HTTP ${response.status} body=${text.slice(0, 220)}`)
      return
    }
    let called: string[] = []
    try {
      const parsed = JSON.parse(text) as { content?: { type?: string; name?: string }[] }
      called = (parsed.content ?? []).filter((block) => block.type === 'tool_use').map((block) => String(block.name))
    } catch {
      /* status alone is enough */
    }
    console.log(`[probe] ${label}: HTTP ${response.status} calls=[${called.join(',')}]`)
  }

  await ask('defer_loading only (no block, no beta)', {
    model,
    max_tokens: 32,
    stream: false,
    tools: [tool('probe_lookup'), tool('probe_extra', { defer_loading: true })],
    messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
  })
  for (const beta of [NARROW_BETA, WIDE_BETA]) {
    await ask(`beta=${beta}`, { ...body, model }, beta)
  }
})

/**
 * GLM's Anthropic face, asked the same three questions.
 *
 * The line already refuses `tool-addition` in its own mapper, so this probe is
 * the outer check: does the upstream refuse it too, or does it accept the block
 * while the plugin declines to send one? Either answer is worth knowing, because
 * they need different fixes.
 */
test('glm-coding-plan: does the Anthropic face accept a tool_addition block', async () => {
  const store = new GlmCodingPlanCredentialStore()
  const credentials = await store.read()
  if (credentials === null) {
    console.log('[probe] glm-coding-plan: no credential on disk, skipped')
    return
  }
  const region = credentials.codingPlan.region
  const rawKey = credentials.codingPlan.codingPlanKey as unknown
  const key = typeof rawKey === 'string' ? rawKey : ''
  if (key === '') {
    console.log('[probe] glm-coding-plan: credential carries no usable plan key, skipped')
    return
  }
  const model = process.env.PROBE_GLM_MODEL ?? 'GLM-5.3'
  const url = glmAnthropicUrl(region)
  console.log('[probe] glm-coding-plan url =', url, 'model =', model, 'region =', region)

  const headers = { ...glmAnthropicProbeHeaders(key), 'content-type': 'application/json' }
  const ask = async (label: string, payload: Record<string, unknown>, beta?: string): Promise<void> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: beta === undefined ? headers : { ...headers, 'anthropic-beta': beta },
      body: JSON.stringify(payload),
    })
    const text = await response.text()
    if (!response.ok) {
      console.log(`[probe] ${label}: HTTP ${response.status} body=${text.slice(0, 220)}`)
      return
    }
    let called: string[] = []
    try {
      const parsed = JSON.parse(text) as { content?: { type?: string; name?: string }[] }
      called = (parsed.content ?? []).filter((block) => block.type === 'tool_use').map((block) => String(block.name))
    } catch {
      /* status alone is enough */
    }
    console.log(`[probe] ${label}: HTTP ${response.status} calls=[${called.join(',')}]`)
  }

  // Deferral alone: accepted means the field travels, refused means it does not.
  await ask('defer_loading only (no block, no beta)', {
    model,
    max_tokens: 32,
    stream: false,
    tools: [tool('probe_lookup'), tool('probe_extra', { defer_loading: true })],
    messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
  })

  for (const beta of [NARROW_BETA, WIDE_BETA]) {
    await ask(`beta=${beta}`, body, beta)
  }
})

test('minimax-code: does the Anthropic face accept a tool_addition block', async () => {
  // The account lives in the POOL, not in the single-account store: the settings
  // card signs in through the pool, and a store-only read reports "not signed in"
  // for a subscription that is in fact signed in. Ask the same object the adapter
  // asks.
  const store = new MinimaxCodeCredentialStore()
  let credentials
  try {
    const pool = new MinimaxCodeAccountPool({ store })
    const effective = await pool.getEffectiveCredential()
    credentials = effective.credentials
    console.log('[probe] minimax-code account =', effective.account.id.slice(0, 12) + '…', 'region =', credentials.region)
  } catch (error) {
    // A store with no pool account still answers through the single-account path.
    try {
      credentials = await ensureAccessToken(store, {})
    } catch (fallback) {
      console.log('[probe] minimax-code: no usable credential, skipped:',
        fallback instanceof Error ? fallback.message : String(fallback))
      return
    }
  }
  const url = messagesUrl(credentials.region)
  console.log('[probe] minimax-code url =', url, 'model =', PROBE_MODEL)

  // The deferral half on its own: if `defer_loading` is accepted but the block
  // that activates a tool is refused, a deferred tool can never become callable,
  // so the line has no usable update channel either way.
  const withoutChange = {
    model: PROBE_MODEL,
    max_tokens: 32,
    stream: false,
    tools: [tool('probe_lookup'), tool('probe_extra', { defer_loading: true })],
    messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
  }
  {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...probeRequestHeaders(credentials.accessToken), 'content-type': 'application/json' },
      body: JSON.stringify(withoutChange),
    })
    const text = await response.text()
    console.log(`[probe] defer_loading only (no block, no beta): HTTP ${response.status} ${response.ok ? '' : text.slice(0, 200)}`)
  }

  for (const beta of [NARROW_BETA, WIDE_BETA]) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...probeRequestHeaders(credentials.accessToken),
        'content-type': 'application/json',
        'anthropic-beta': beta,
      },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) {
      console.log(`[probe] beta=${beta}: HTTP ${response.status} body=${text.slice(0, 240)}`)
      continue
    }
    let called: string[] = []
    let blocks: string[] = []
    try {
      const parsed = JSON.parse(text) as { content?: { type?: string; name?: string }[] }
      const content = Array.isArray(parsed.content) ? parsed.content : []
      blocks = content.map((block) => String(block.type ?? '?'))
      called = content.filter((block) => block.type === 'tool_use').map((block) => String(block.name))
    } catch {
      /* a non-JSON body is reported only by status */
    }
    console.log(`[probe] beta=${beta}: HTTP ${response.status} blocks=[${blocks.join(',')}] calls=[${called.join(',')}]`)
  }
})
