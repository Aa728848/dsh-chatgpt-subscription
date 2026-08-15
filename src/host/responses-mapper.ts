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
    commandToolInstruction(options.tools),
    runCodeInstruction(options.tools),
  ].filter((value): value is string => Boolean(value))

  const input: Array<Record<string, unknown>> = []
  const knownToolCalls = new Map<string, string | undefined>()
  for (const message of options.messages) {
    if (message.role === 'system') continue
    const replayItems = replayOutputItems(message)
    if (message.role === 'assistant' && replayItems !== null) {
      input.push(...replayItems)
      for (const item of replayItems) {
        if (item.type === 'function_call' && typeof item.call_id === 'string') {
          knownToolCalls.set(item.call_id, typeof item.name === 'string' ? item.name : undefined)
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
      const rawOutput = blocksToText(toolResult.content)
      if (knownToolCalls.has(callId)) {
        const output = toolResult.isError && knownToolCalls.get(callId) === 'run_code'
          ? runCodeErrorOutput(rawOutput)
          : rawOutput
        input.push({ type: 'function_call_output', call_id: callId, output })
      } else {
        // A compacted or interrupted history can retain a tool result after its
        // call was dropped. Preserve the useful result as text instead of
        // sending an invalid orphan function_call_output that the API rejects.
        input.push({
          role: 'user',
          content: [{
            type: 'input_text',
            text: `Tool result for unavailable call ${callId}${toolResult.isError ? ' (error)' : ''}:\n${rawOutput}`,
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
      description: toolDescriptionForCodex(tool.name, tool.description),
      parameters: toolParametersForCodex(
        tool.name,
        tool.parameters,
        sandboxRetryTools.has(tool.name),
      ),
    }))
    payload.tool_choice = 'auto'
    payload.parallel_tool_calls = true
  }
  if (options.reasoningEffort !== undefined) {
    payload.reasoning = { effort: options.reasoningEffort, summary: 'auto' }
  }
  return payload
}

function runCodeInstruction(tools: GenerateOptions['tools']): string | undefined {
  if (!tools?.some((tool) => tool.name === 'run_code')) return undefined
  return 'run_code compatibility rule: its code is parsed as strict JavaScript/TypeScript before execution. On Windows, do not embed PowerShell containing $, ${...}, backslashes, or here-strings in JavaScript template literals; String.raw does not disable ${...} interpolation. Prefer arrays of ordinary quoted strings joined with "\\n", escaping backslashes, or use a file-write tool for large scripts and then invoke pwsh.'
}

function toolDescriptionForCodex(name: string, description: string): string {
  if (name === 'run_code') {
    return `${description}\n\nCompatibility: code is strict JavaScript/TypeScript. When composing PowerShell, avoid JavaScript template literals containing $, \${...}, Windows backslashes, or PowerShell here-strings. Prefer ordinary quoted string arrays joined with "\\n", or write a script file with a dedicated file tool before invoking pwsh.`
  }
  if (isCommandTool(name)) {
    return `${description}\n\n${commandToolCompatibilityText(name)}`
  }
  return description
}

function commandToolInstruction(tools: GenerateOptions['tools']): string | undefined {
  const names = tools
    ?.filter((tool) => isCommandTool(tool.name))
    .map((tool) => tool.name)
  if (!names?.length) return undefined
  return `Command tool compatibility rule (${[...new Set(names)].join(', ')}): each command call runs in a fresh process, so do not rely on cd, aliases, functions, or variables from previous calls; set workdir when the tool supports it. On Windows/pwsh, keep commands in native PowerShell syntax and native Windows paths. For deletion or move operations, first resolve and verify exact absolute target paths, then operate on those literal paths only; avoid dynamically deleting paths built from $HOME, wildcards, command substitution, or another shell's output. Treat [auto-mode hard deny] and similar policy denials as non-retriable; choose a safer non-destructive inspection or report the limitation instead of repeating the same command or adding sandbox escalation. If downloads fail with TLS credential or connection-closed errors, treat that as an environment/network failure and use local sources or report the limitation instead of cycling through equivalent download commands.`
}

function commandToolCompatibilityText(name: string): string {
  const shell = name.toLowerCase()
  const windows = shell === 'pwsh' || shell.includes('powershell')
    ? ' Use native PowerShell syntax and native Windows paths; prefer workdir over cd because every call starts a fresh process.'
    : ' Prefer workdir over cd because every call starts a fresh process.'
  return `Compatibility: command execution is stateless between calls.${windows} For destructive operations, verify exact absolute targets first and use literal paths; policy hard-deny results require a safer command shape, not sandbox escalation.`
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
  toolName: string,
  parameters: Record<string, unknown>,
  allowSandboxRetry: boolean,
): Record<string, unknown> {
  const hideSandboxControls = !allowSandboxRetry && hasSandboxControls(parameters)
  const augmentCommandTool = isCommandTool(toolName)
  if (!hideSandboxControls && toolName !== 'run_code' && !augmentCommandTool) return parameters
  const cloned = structuredClone(parameters)
  const properties = record(cloned.properties)
  if (properties !== null && hideSandboxControls) {
    delete properties.sandbox_permissions
    delete properties.justification
  }
  if (hideSandboxControls && Array.isArray(cloned.required)) {
    cloned.required = cloned.required.filter((name) => (
      name !== 'sandbox_permissions' && name !== 'justification'
    ))
  }
  if (toolName === 'run_code' && properties !== null) {
    const code = record(properties.code)
    if (code !== null) {
      const current = typeof code.description === 'string' ? code.description.trim() : ''
      const compatibility = 'Strict JavaScript/TypeScript source. For PowerShell on Windows, avoid JavaScript template literals containing $, ${...}, backslashes, or here-strings; String.raw still performs ${...} interpolation. Prefer ordinary quoted string arrays joined with "\\n" and escape backslashes, or write a script file with a dedicated file tool.'
      code.description = current ? `${current}\n\n${compatibility}` : compatibility
    }
  }
  if (augmentCommandTool && properties !== null) {
    appendPropertyDescription(properties.command, 'Single command for a fresh process; do not rely on state from earlier calls.')
    appendPropertyDescription(properties.workdir, 'Use a native absolute working directory instead of embedding cd in the command.')
    appendPropertyDescription(properties.timeoutMs, 'Positive finite timeout in milliseconds for bounded commands.')
    appendPropertyDescription(properties.run_in_background, 'Use only for long-running servers or watchers whose output will be checked later.')
    appendPropertyDescription(properties.sandbox_permissions, 'Only set when retrying the exact previous sandbox-denied call; it does not bypass hard-deny policy results.')
    appendPropertyDescription(properties.justification, 'Required only for an allowed sandbox retry; explain why the wider access is needed.')
  }
  return cloned
}

function appendPropertyDescription(value: unknown, addition: string): void {
  const property = record(value)
  if (property === null) return
  const current = typeof property.description === 'string' ? property.description.trim() : ''
  if (current.includes(addition)) return
  property.description = current ? `${current}\n\n${addition}` : addition
}

function isCommandTool(name: string): boolean {
  const normalized = name.toLowerCase()
  return normalized === 'pwsh'
    || normalized === 'powershell'
    || normalized === 'bash'
    || normalized === 'shell'
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
  knownToolCalls: Map<string, string | undefined>,
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
    knownToolCalls.set(callId, block.name)
  }
}

function runCodeErrorOutput(output: string): string {
  if (!isRunCodeParserError(output)) return output
  return `${output}\n\nCompatibility hint: run_code failed while parsing strict JavaScript/TypeScript, before the nested tool ran. Avoid JavaScript template literals for PowerShell containing $, \${...}, Windows backslashes, or here-strings; String.raw does not prevent \${...} interpolation. Build the script from ordinary quoted strings joined with "\\n" (escaping backslashes), or write a script file with a dedicated file tool and then invoke pwsh.`
}

function isRunCodeParserError(output: string): boolean {
  return /(?:Legacy octal escape is not permitted in strict mode|Unexpected token|Invalid or unexpected token|Unterminated template|Expected ['"]?\}['"]?)/i.test(output)
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
