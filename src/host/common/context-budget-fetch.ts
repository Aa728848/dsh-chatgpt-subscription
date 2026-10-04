/**
 * Recover a rejected input+output budget without dropping model-visible history.
 * Only explicit wire output controls and provider-confirmed counts qualify.
 * HTTP success/SSE, auth, quota, and byte-limit failures retain their old paths.
 */
export function fetchWithContextBudgetRecovery(fetchFn: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchFn(input, init)
    if (response.status !== 400 && response.status !== 422) return response
    if (typeof init?.body !== 'string') return response
    let body: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(init.body)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return response
      body = parsed as Record<string, unknown>
    } catch { return response }
    const keys = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'].filter(key => key in body)
    if (keys.length !== 1) return response
    const key = keys[0]!
    const requested = body[key]
    if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested <= 0) return response
    const detail = await boundedDiagnostic(response)
    const reduced = reducedOutputBudget(detail, requested)
    if (reduced === undefined) return response
    // Explicit Anthropic thinking budgets must remain strictly below max_tokens.
    // Do not invent a new thinking mode or modify the user's reasoning preference.
    const thinking = body.thinking
    if (typeof thinking === 'object' && thinking !== null) {
      const budget = (thinking as Record<string, unknown>).budget_tokens
      if (typeof budget === 'number' && reduced <= budget) return response
    }
    init.signal?.throwIfAborted()
    await response.body?.cancel().catch(() => undefined)
    return fetchFn(input, { ...init, body: JSON.stringify({ ...body, [key]: reduced }) })
  }
}

/** Read a bounded clone so a non-recoverable refusal remains readable by its owner. */
async function boundedDiagnostic(response: Response): Promise<string> {
  const reader = response.clone().body?.getReader()
  if (reader === undefined) return ''
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > 16_384) return ''
      text += decoder.decode(value, { stream: true })
    }
  } catch { return '' } finally { void reader.cancel().catch(() => undefined) }
}

function diagnosticMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  return diagnosticMessage(fields.error, depth + 1) ?? diagnosticMessage(fields.message, depth + 1)
}

/** Never infer capacity from a model name or from an echoed request. */
function reducedOutputBudget(detail: string, requested: number): number | undefined {
  let message: string | undefined
  try { message = diagnosticMessage(JSON.parse(detail)) } catch { message = detail }
  if (message === undefined) return undefined
  const match = /maximum context length is ([\d,]+) tokens[\s\S]*?requested ([\d,]+) tokens[\s\S]*?\(([\d,]+) in the messages, ([\d,]+) in the completion\)/i.exec(message)
  if (match === null) return undefined
  const [window, total, prompt, completion] = match.slice(1).map(value => Number(value.replaceAll(',', '')))
  if (![window, total, prompt, completion].every(value => Number.isSafeInteger(value) && value! > 0)) return undefined
  if (completion !== requested || prompt! + completion! !== total || total! <= window!) return undefined
  const available = window! - prompt! - 1024
  // Keep a useful output budget; a nearly full prompt belongs to host compaction.
  return available >= 1024 && available < requested ? available : undefined
}
