import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

export interface ResponsesPayload extends Record<string, unknown> {
  model: string
  input: Array<Record<string, unknown>>
  stream: true
  store: false
}

export async function buildResponsesPayload(
  options: GenerateOptions,
  attachments: Pick<AttachmentStore, 'readImage'>,
): Promise<ResponsesPayload> {
  const instructions = [
    options.system?.trim(),
    ...options.messages
      .filter((message) => message.role === 'system')
      .map((message) => blocksToText(message.content).trim()),
  ].filter((value): value is string => Boolean(value))

  const input: Array<Record<string, unknown>> = []
  for (const message of options.messages) {
    if (message.role === 'system') continue
    const replayItems = replayOutputItems(message)
    if (message.role === 'assistant' && replayItems !== null) {
      input.push(...replayItems)
      continue
    }
    const toolResult = message.content.find((block) => block.type === 'tool-result')
    if (toolResult?.type === 'tool-result') {
      input.push({
        type: 'function_call_output',
        call_id: toolResult.toolCallId,
        output: blocksToText(toolResult.content),
      })
      continue
    }
    const content = await mapContent(message, attachments, options.signal)
    if (content.length > 0) input.push({ role: message.role, content })
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: block.arguments,
        })
      }
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
      parameters: tool.parameters,
    }))
    payload.tool_choice = 'auto'
    payload.parallel_tool_calls = true
  }
  if (options.reasoningEffort !== undefined) {
    payload.reasoning = { effort: options.reasoningEffort, summary: 'auto' }
  }
  return payload
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
