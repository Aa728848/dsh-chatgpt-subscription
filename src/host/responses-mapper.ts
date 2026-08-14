import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

export interface ResponsesPayload extends Record<string, unknown> {
  model: string
  input: Array<Record<string, unknown>>
  stream: true
  store: false
}

export function hiddenSandboxControlToolNames(options: GenerateOptions): Set<string> {
  const retryTools = recentSandboxRetryToolNames(options.messages)
  return new Set(options.tools
    ?.filter((tool) => hasSandboxControls(tool.parameters) && !retryTools.has(tool.name))
    .map((tool) => tool.name) ?? [])
}

export async function buildResponsesPayload(
  options: GenerateOptions,
  attachments: Pick<AttachmentStore, 'readImage'>,
): Promise<ResponsesPayload> {
  const sandboxRetryTools = recentSandboxRetryToolNames(options.messages)
  const instructions = [
    options.system?.trim(),
    ...options.messages
      .filter((message) => message.role === 'system')
      .map((message) => blocksToText(message.content).trim()),
    sandboxToolInstruction(options.tools, sandboxRetryTools),
  ].filter((value): value is string => Boolean(value))

  const input: Array<Record<string, unknown>> = []
  const knownToolCalls = new Set<string>()
  for (const message of options.messages) {
    if (message.role === 'system') continue
    const replayItems = replayOutputItems(message)
    if (message.role === 'assistant' && replayItems !== null) {
      input.push(...replayItems)
      for (const item of replayItems) {
        if (item.type === 'function_call' && typeof item.call_id === 'string') {
          knownToolCalls.add(item.call_id)
        }
      }
      if (!replayItems.some((item) => item.type === 'message')) {
        const content = await mapContent(message, attachments, options.signal)
        if (content.length > 0) input.push({ role: message.role, content })
      }
      appendMissingToolCalls(input, knownToolCalls, message)
      continue
    }
    const toolResult = message.content.find((block) => block.type === 'tool-result')
    if (toolResult?.type === 'tool-result') {
      const callId = String(toolResult.toolCallId)
      const output = blocksToText(toolResult.content)
      if (knownToolCalls.has(callId)) {
        input.push({ type: 'function_call_output', call_id: callId, output })
      } else {
        // A compacted or interrupted history can retain a tool result after its
        // call was dropped. Preserve the useful result as text instead of
        // sending an invalid orphan function_call_output that the API rejects.
        input.push({
          role: 'user',
          content: [{
            type: 'input_text',
            text: `Tool result for unavailable call ${callId}${toolResult.isError ? ' (error)' : ''}:\n${output}`,
          }],
        })
      }
      continue
    }
    const content = await mapContent(message, attachments, options.signal)
    if (content.length > 0) input.push({ role: message.role, content })
    if (message.role === 'assistant') {
      appendMissingToolCalls(input, knownToolCalls, message)
    }
  }

  const payload: ResponsesPayload = {
    model: options.model,
    input,
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
  }
  if (instructions.length > 0) payload.instructions = instructions.join('\n\n')
  if (options.tools?.length) {
    payload.tools = options.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: toolParametersForCodex(tool.parameters, sandboxRetryTools.has(tool.name)),
    }))
    payload.tool_choice = 'auto'
    payload.parallel_tool_calls = true
  }
  if (options.reasoningEffort !== undefined) {
    payload.reasoning = { effort: options.reasoningEffort, summary: 'auto' }
  }
  return payload
}

function sandboxToolInstruction(
  tools: GenerateOptions['tools'],
  sandboxRetryTools: ReadonlySet<string>,
): string | undefined {
  if (!tools?.some((tool) => hasSandboxControls(tool.parameters))) return undefined
  if (sandboxRetryTools.size === 0) {
    return 'Tool sandbox rule: this is not a sandbox-escalation retry. Omit sandbox_permissions and justification from every tool call. First run the tool with the session\'s current access.'
  }
  return `Tool sandbox rule: sandbox_permissions and justification may only be used to retry the exact denied call for: ${[...sandboxRetryTools].join(', ')}. Omit both fields from every other tool call, and request a strictly wider mode with a non-empty justification sentence.`
}

function toolParametersForCodex(
  parameters: Record<string, unknown>,
  allowSandboxRetry: boolean,
): Record<string, unknown> {
  if (allowSandboxRetry || !hasSandboxControls(parameters)) return parameters
  const cloned = structuredClone(parameters)
  const properties = record(cloned.properties)
  if (properties !== null) {
    delete properties.sandbox_permissions
    delete properties.justification
  }
  if (Array.isArray(cloned.required)) {
    cloned.required = cloned.required.filter((name) => (
      name !== 'sandbox_permissions' && name !== 'justification'
    ))
  }
  return cloned
}

function hasSandboxControls(parameters: Record<string, unknown>): boolean {
  const properties = record(parameters.properties)
  return properties !== null
    && ('sandbox_permissions' in properties || 'justification' in properties)
}

function recentSandboxRetryToolNames(messages: readonly Message[]): Set<string> {
  const deniedCallIds = new Set<string>()
  let assistant: Message | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'assistant') {
      assistant = message
      break
    }
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      const output = blocksToText(block.content)
      if (isSandboxDenial(output)) deniedCallIds.add(String(block.toolCallId))
    }
  }
  const result = new Set<string>()
  if (assistant === undefined || deniedCallIds.size === 0) return result
  for (const block of assistant.content) {
    if (block.type === 'tool-call' && deniedCallIds.has(String(block.id))) {
      result.add(block.name)
    }
  }
  return result
}

function isSandboxDenial(output: string): boolean {
  return /\[sandbox:\s*file access denied\b/i.test(output)
    || /\bsandbox\b.*\b(?:access denied|denied access|EPERM)\b/i.test(output)
}

function appendMissingToolCalls(
  input: Array<Record<string, unknown>>,
  knownToolCalls: Set<string>,
  message: Message,
): void {
  for (const block of message.content) {
    if (block.type !== 'tool-call') continue
    const callId = String(block.id)
    if (knownToolCalls.has(callId)) continue
    input.push({
      type: 'function_call',
      call_id: callId,
      name: block.name,
      arguments: block.arguments,
    })
    knownToolCalls.add(callId)
  }
}

async function mapContent(
  message: Message,
  attachments: Pick<AttachmentStore, 'readImage'>,
  signal: AbortSignal | undefined,
): Promise<Array<Record<string, unknown>>> {
  const result: Array<Record<string, unknown>> = []
  for (const block of message.content) {
    if (block.type === 'text') {
      result.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: block.text })
    } else if (block.type === 'image') {
      if (message.role !== 'user') continue
      result.push({ type: 'input_image', image_url: await imageDataUrl(block.attachment, attachments, signal) })
    }
  }
  return result
}

async function imageDataUrl(
  ref: ImageAttachmentRef,
  attachments: Pick<AttachmentStore, 'readImage'>,
  signal?: AbortSignal,
): Promise<string> {
  const stored = await attachments.readImage(ref, signal)
  return `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
}

function blocksToText(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return block.text
    if (block.type === 'image') return `[image: ${block.attachment.name ?? block.attachment.attachmentId}]`
    if (block.type === 'tool-result') return blocksToText(block.content)
    return ''
  }).filter(Boolean).join('\n')
}

function replayOutputItems(message: Message): Array<Record<string, unknown>> | null {
  if (message.source.kind !== 'model') return null
  const replay = message.source.replayState
  if (typeof replay !== 'object' || replay === null || Array.isArray(replay)) return null
  const items = (replay as Record<string, unknown>).outputItems
  if (!Array.isArray(items)) return null
  return structuredClone(items.filter((item): item is Record<string, unknown> => (
    typeof item === 'object' && item !== null && !Array.isArray(item)
  )))
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
