import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

export interface ResponsesPayload extends Record<string, unknown> {
  model: string
  input: Array<Record<string, unknown>>
  stream: true
  store: false
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface LocalRawImageOptions {
  baseUrl?: string
  fetchFn?: FetchLike
}

interface LocalRawImageStats {
  attempted: number
  resolved: number
  failed: number
}

export function hiddenSandboxControlToolNames(options: GenerateOptions): Set<string> {
  const retryTools = recentSandboxRetryToolNames(options.messages)
  return new Set(options.tools
    ?.filter((tool) => hasSandboxControls(tool.parameters) && !retryTools.has(tool.name))
    .map((tool) => tool.name) ?? [])
}

export async function buildResponsesPayload(
  options: GenerateOptions,
  attachments: Pick<AttachmentStore, 'readImage'> & Partial<Pick<AttachmentStore, 'imageLimits'>>,
  localRawImages: LocalRawImageOptions = {},
): Promise<ResponsesPayload> {
  const sandboxRetryTools = recentSandboxRetryToolNames(options.messages)
  const resolveLocalRawImages = supportsImageInput(options)
  const instructionParts = [
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
  const localImageStats: LocalRawImageStats = { attempted: 0, resolved: 0, failed: 0 }
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
        const content = await mapContent(message, attachments, options.signal, localRawImages, localImageStats, resolveLocalRawImages)
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
    const content = await mapContent(message, attachments, options.signal, localRawImages, localImageStats, resolveLocalRawImages)
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
  const instructions = [
    ...instructionParts,
    localRawImageInstruction(localImageStats),
  ].filter((value): value is string => Boolean(value))
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
  return 'run_code compatibility rule: its code is parsed as strict JavaScript/TypeScript before execution. Shell commands are nested string data: JavaScript template literals may consume ${...}, backticks, backslashes, and escape sequences before PowerShell, Bash, or POSIX sh sees them. On Windows, avoid embedding PowerShell containing $, ${...}, backslashes, or here-strings in template literals; String.raw does not disable ${...} interpolation. On Linux, prefer ordinary quoted strings or write a script file before invoking bash/sh, especially for commands containing backticks or ${...}. Prefer arrays of ordinary quoted strings joined with "\\n", escaping backslashes, or use a file-write tool for large scripts.'
}

function localRawImageInstruction(stats: LocalRawImageStats): string | undefined {
  if (stats.failed === 0) return undefined
  return 'Image attachment rule: a user message contains a markdown image link to a local/raw session URL but no structured image attachment. That link is not accessible image bytes for the provider. Do not claim to see the image; ask the user to resend it as an actual image attachment if visual inspection is required.'
}

function supportsImageInput(options: GenerateOptions): boolean {
  return options.provider === 'codex-chatgpt' && options.model.toLowerCase().startsWith('gpt-')
}

function toolDescriptionForCodex(name: string, description: string): string {
  if (name === 'run_code') {
    return `${description}\n\nCompatibility: code is strict JavaScript/TypeScript and nested shell commands are string data. Template literals may consume \${...}, backticks, backslashes, and escape sequences before PowerShell, Bash, or POSIX sh sees them. Prefer ordinary quoted string arrays joined with "\\n", or write a script file with a dedicated file tool before invoking the shell.`
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
  const uniqueNames = [...new Set(names)]
  const normalized = uniqueNames.map((name) => name.toLowerCase())
  const shellGuidance = [
    normalized.some((name) => name === 'pwsh' || name.includes('powershell'))
      ? 'For pwsh/PowerShell, use native PowerShell syntax and native Windows paths.'
      : undefined,
    normalized.includes('bash')
      ? 'For bash, use native POSIX paths and Bash syntax in a fresh non-interactive process.'
      : undefined,
    normalized.some((name) => name === 'sh' || name === 'shell')
      ? 'For sh/generic shell, prefer portable POSIX syntax and avoid Bash-only arrays, [[ ... ]], process substitution, and source.'
      : undefined,
  ].filter((value): value is string => value !== undefined).join(' ')
  return `Command tool compatibility rule (${uniqueNames.join(', ')}): each command call runs in a fresh process, so do not rely on cd, aliases, functions, or variables from previous calls; set workdir when the tool supports it. ${shellGuidance} For deletion or move operations, first resolve and verify exact absolute target paths, then operate on those literal paths only; avoid dynamically deleting paths built from home-directory expansion, wildcards, command substitution, or another shell's output. Treat [auto-mode hard deny] and similar policy denials as non-retriable; choose a safer non-destructive inspection or report the limitation instead of repeating the same command or adding sandbox escalation. If downloads fail with TLS credential or connection-closed errors, treat that as an environment/network failure and use local sources or report the limitation instead of cycling through equivalent download commands.`
}

function commandToolCompatibilityText(name: string): string {
  const shell = name.toLowerCase()
  const syntax = shell === 'pwsh' || shell.includes('powershell')
    ? ' Use native PowerShell syntax and native Windows paths.'
    : shell === 'bash'
      ? ' Use Bash syntax and native POSIX paths.'
      : ' Use portable POSIX syntax and native POSIX paths; avoid Bash-only arrays, [[ ... ]], process substitution, and source.'
  return `Compatibility: command execution is stateless between calls.${syntax} Prefer workdir over cd because every call starts a fresh process. For destructive operations, verify exact absolute targets first and use literal paths; policy hard-deny results require a safer command shape, not sandbox escalation.`
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
      const compatibility = 'Strict JavaScript/TypeScript source. Nested shell commands are string data: template literals may consume ${...}, backticks, backslashes, and escape sequences before PowerShell, Bash, or POSIX sh sees them; String.raw still performs ${...} interpolation. Prefer ordinary quoted string arrays joined with "\\n", or write a script file with a dedicated file tool.'
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
    || normalized === 'sh'
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
  return `${output}\n\nCompatibility hint: run_code failed while parsing strict JavaScript/TypeScript, before the nested tool ran. Shell commands are nested string data; template literals can consume \${...}, backticks, backslashes, and escape sequences before PowerShell, Bash, or POSIX sh sees them, and String.raw does not prevent \${...} interpolation. Build the script from ordinary quoted strings joined with "\\n", or write a script file with a dedicated file tool and then invoke the shell.`
}

function isRunCodeParserError(output: string): boolean {
  return /(?:Legacy octal escape is not permitted in strict mode|Unexpected token|Invalid or unexpected token|Unterminated template|Expected ['"]?\}['"]?)/i.test(output)
}

async function mapContent(
  message: Message,
  attachments: Pick<AttachmentStore, 'readImage'> & Partial<Pick<AttachmentStore, 'imageLimits'>>,
  signal: AbortSignal | undefined,
  localRawImages: LocalRawImageOptions,
  localImageStats: LocalRawImageStats,
  resolveLocalRawImages: boolean,
): Promise<Array<Record<string, unknown>>> {
  const result: Array<Record<string, unknown>> = []
  for (const block of message.content) {
    if (block.type === 'text') {
      if (message.role === 'user') {
        result.push(...await mapUserText(block.text, attachments, signal, localRawImages, localImageStats, resolveLocalRawImages))
      } else {
        result.push({ type: 'output_text', text: block.text })
      }
    } else if (block.type === 'image') {
      if (message.role !== 'user') continue
      result.push({ type: 'input_image', image_url: await imageDataUrl(block.attachment, attachments, signal) })
    }
  }
  return result
}

async function mapUserText(
  text: string,
  attachments: Partial<Pick<AttachmentStore, 'imageLimits'>>,
  signal: AbortSignal | undefined,
  localRawImages: LocalRawImageOptions,
  localImageStats: LocalRawImageStats,
  resolveLocalRawImages: boolean,
): Promise<Array<Record<string, unknown>>> {
  const links = markdownImageLinks(text)
  if (links.length === 0) return [{ type: 'input_text', text }]
  if (!resolveLocalRawImages) {
    localImageStats.failed += links.length
    return [{ type: 'input_text', text }]
  }
  const result: Array<Record<string, unknown>> = []
  let cursor = 0
  for (const match of links) {
    if (match.start > cursor) {
      pushInputText(result, text.slice(cursor, match.start))
    }
    localImageStats.attempted++
    const image = await localRawImageDataUrl(
      match.url,
      localRawImages,
      attachments.imageLimits?.maxImageBytes,
      signal,
    )
    if (image === null) {
      localImageStats.failed++
      pushInputText(result, text.slice(match.start, match.end))
    } else {
      localImageStats.resolved++
      result.push({ type: 'input_image', image_url: image })
    }
    cursor = match.end
  }
  if (cursor < text.length) {
    pushInputText(result, text.slice(cursor))
  }
  return result.length > 0 ? result : [{ type: 'input_text', text }]
}

function pushInputText(content: Array<Record<string, unknown>>, text: string): void {
  if (text === '') return
  const previous = content.at(-1)
  if (previous?.type === 'input_text' && typeof previous.text === 'string') {
    previous.text += text
  } else {
    content.push({ type: 'input_text', text })
  }
}

function markdownImageLinks(text: string): Array<{ start: number; end: number; url: string }> {
  const links: Array<{ start: number; end: number; url: string }> = []
  const pattern = /!\[[^\]]*\]\(([^)\s]+)\)/gi
  for (const match of text.matchAll(pattern)) {
    const url = match[1]
    if (match.index === undefined || !isLocalRawImageReference(url)) continue
    links.push({ start: match.index, end: match.index + match[0].length, url })
  }
  return links
}

async function localRawImageDataUrl(
  rawUrl: string,
  options: LocalRawImageOptions,
  maxBytes: number | undefined,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const url = localRawImageUrl(rawUrl, options.baseUrl)
  if (url === null) return null
  let response: Response
  try {
    response = await (options.fetchFn ?? fetch)(url, { signal, redirect: 'error' })
  } catch {
    return null
  }
  if (!response.ok) return null
  const contentLength = Number(response.headers.get('content-length') ?? NaN)
  if (maxBytes !== undefined && Number.isFinite(contentLength) && contentLength > maxBytes) return null
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch {
    return null
  }
  if (maxBytes !== undefined && bytes.byteLength > maxBytes) return null
  const mediaType = supportedImageMediaType(response.headers.get('content-type')) ?? sniffImageMediaType(bytes)
  if (mediaType === null) return null
  return bytesToDataUrl(mediaType, bytes)
}

function localRawImageUrl(rawUrl: string, baseUrl: string | undefined): string | null {
  if (!isLocalRawImageReference(rawUrl)) return null
  try {
    const url = rawUrl.startsWith('/')
      ? (baseUrl === undefined ? null : new URL(rawUrl, baseUrl))
      : new URL(rawUrl)
    if (url === null || !isLoopbackHost(url.hostname)) return null
    return url.toString()
  } catch {
    return null
  }
}

function isLocalRawImageReference(url: string): boolean {
  return /(?:^|\/)raw\/sha256:[a-f0-9]{32,}/i.test(url)
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

function supportedImageMediaType(value: string | null): ImageMediaType | null {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType === 'image/png'
    || mediaType === 'image/jpeg'
    || mediaType === 'image/webp'
    || mediaType === 'image/gif') {
    return mediaType
  }
  return null
}

function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12
    && ascii(bytes, 0, 4) === 'RIFF'
    && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'image/gif'
  return null
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end))
}

async function imageDataUrl(
  ref: ImageAttachmentRef,
  attachments: Pick<AttachmentStore, 'readImage'>,
  signal?: AbortSignal,
): Promise<string> {
  const stored = await attachments.readImage(ref, signal)
  return bytesToDataUrl(stored.ref.mediaType, stored.data)
}

function bytesToDataUrl(mediaType: ImageMediaType, data: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`
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
  const envelope = replay as Record<string, unknown>
  const items = Array.isArray(envelope.outputItems)
    ? envelope.outputItems
    : Array.isArray(record(envelope.response)?.outputItems)
      ? record(envelope.response)!.outputItems as unknown[]
      : null
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
