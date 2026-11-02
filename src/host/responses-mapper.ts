import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, GenerateOptions, Message } from './common/llm-compat.ts'
import { createHash } from 'node:crypto'
import { codexDefaultOutputVerbosity, codexModelSupportsImageInput, codexModelSupportsReasoningSummary, codexModelUsesResponsesLite, codexWireReasoningEffort } from '../shared/model-catalog.ts'
import type { CodexOutputVerbosity, CodexReasoningSummary } from '../shared/contracts.ts'

/**
 * The Responses request body, in the field order the official client sends.
 *
 * The order is not cosmetic: the official client keeps the routing fields
 * first because a gateway may inspect the body incrementally before a
 * multi-megabyte `input` arrives, so `model` and `stream` have to be readable
 * without reading the whole document.
 */
export interface ResponsesPayload extends Record<string, unknown> {
  model: string
  stream: true
  service_tier?: string
  input: Array<Record<string, unknown>>
  /** Tool declarations; absent on a Lite request, which carries them in `input`. */
  tools?: Array<Record<string, unknown>>
  tool_choice?: string
  parallel_tool_calls?: boolean
  reasoning?: Record<string, unknown>
  store: false
  include?: string[]
  /** Stable per-conversation cache key; lets the backend reuse prompt prefix. */
  prompt_cache_key?: string
  text?: { verbosity: CodexOutputVerbosity }
}

/**
 * Wire options for one request.
 */
export interface ResponsesWireOptions {
  /**
   * Whether the model speaks the Responses Lite protocol.
   *
   * Optional on purpose: without it the model's own catalog decides, and a
   * model no catalog states a protocol for is not Lite - the Lite body is a
   * different request, not a different spelling of this one. A caller that
   * knows more than the shipped table (the live listing, say) states it here.
   */
  useResponsesLite?: boolean
  /**
   * Stable per-conversation identity the official client derives its item ids
   * from.
   *
   * The official client namespaces its item ids by the conversation thread, so
   * the same instructions carry the same id inside one conversation and a
   * different one in another. Without a namespace the id is still stable, but
   * it is stable across conversations too.
   */
  idNamespace?: string
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

/**
 * Base64 image payload one Codex request may carry.
 *
 * THIS ROUTE HAD NO BOUND AT ALL, which is what made a long session fail
 * intermittently (issue #50). Every turn re-inlines every image still in
 * history, so the request body grew with the number of images ever read and
 * nothing ever trimmed it. Past roughly 4 MB the transport itself gives up: the
 * report's field logs show 18/18 successes in the 3–4 MB band and 3/10 in the
 * 4–5 MB band, and a synthetic probe against the subscription endpoint returned
 * `NGHTTP2_ENHANCE_YOUR_CALM` / `NGHTTP2_INTERNAL_ERROR` on every ≥4 MB body
 * while ≤3 MB always passed.
 *
 * The NUMBER is this route's own, derived from those measurements rather than
 * borrowed. Kimi's 1.5 MB figure is sized for Kimi's 2 MB request limit and
 * would silently drop images this endpoint accepts; MiniMax's 16 MB is sized
 * for a 64 MB body ceiling this route does not have. 2 MiB of image data keeps
 * the whole body inside the band that never failed, even after the
 * conversation text, tool schemas and system prompt are added. It is a
 * transport property of this deployment, not a documented API limit, so
 * `DSH_CODEX_MAX_IMAGE_BYTES` overrides it.
 *
 * It bounds the IMAGE contribution only. A request whose text alone exceeds the
 * transport is still refused by the transport, and no image budget can fix that.
 */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 2 * 1024 * 1024

/**
 * Image budget this process enforces, honouring the deployment override.
 *
 * Parsed as bytes and ignored when it is not a positive finite number, so a
 * typo cannot silently disable the guard by producing `NaN`.
 */
export function maxRequestImageBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.DSH_CODEX_MAX_IMAGE_BYTES ?? '').trim()
  if (raw === '') return DEFAULT_MAX_REQUEST_IMAGE_BYTES
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_REQUEST_IMAGE_BYTES
  return Math.floor(parsed)
}

/**
 * Placeholder left where an over-budget image was removed. It says the picture
 * is gone rather than leaving a blank the model would answer about anyway.
 */
const OMITTED_IMAGE_TEXT =
  '[image omitted to keep the request within its size limit; older images are omitted first. '
  + 'If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]'

/**
 * Replace the oldest images with that placeholder once the built request would
 * carry more than `maxBytes` of base64 image data.
 *
 * WHY THIS RUNS ON THE BUILT INPUT rather than on `options.messages` like the
 * other routes. Two image forms reach this wire and only one of them is a
 * message block: a pasted attachment arrives as `{ type: 'image', attachment }`,
 * but the tool-read images in issue #50 arrive as local markdown links
 * (`![](/describe-image/raw/sha256:…)`) that `mapUserText` fetches and inlines
 * while building. A message-level pass cannot see the second form at all, and
 * the shared `offloadOldestRequestImages` additionally does not recurse into
 * `tool-result` content — so measuring here, after every form has become an
 * `input_image` item, is the one place that bounds what actually goes out.
 *
 * The oldest occurrences go first and durable history is untouched; only the
 * request about to be sent changes. A retry after a model fallback reuses the
 * bounded input instead of re-inflating it.
 *
 * @param input - the payload's `input` items, mutated in place.
 * @param maxBytes - base64 image budget for the whole request.
 * @returns how many images were replaced.
 */
export function offloadOldestInputImages(
  input: Array<Record<string, unknown>>,
  maxBytes: number = maxRequestImageBytes(),
): number {
  const retained: Array<{ content: Array<Record<string, unknown>>; index: number; bytes: number }> = []
  for (const item of input) {
    if (!Array.isArray(item.content)) continue
    for (const [index, block] of item.content.entries()) {
      if (record(block) === null || (block as Record<string, unknown>).type !== 'input_image') continue
      const url = (block as Record<string, unknown>).image_url
      if (typeof url !== 'string') continue
      retained.push({ content: item.content as Array<Record<string, unknown>>, index, bytes: url.length })
    }
  }
  let total = retained.reduce((sum, entry) => sum + entry.bytes, 0)
  if (total <= maxBytes) return 0

  let omitted = 0
  for (const entry of retained) {
    if (total <= maxBytes) break
    entry.content[entry.index] = { type: 'input_text', text: OMITTED_IMAGE_TEXT }
    total -= entry.bytes
    omitted += 1
  }
  return omitted
}

function createCallIdNormalizer(): (value: unknown) => string {
  const normalizedByOriginal = new Map<string, string>()
  const originalByNormalized = new Map<string, string>()

  return (value) => {
    const original = String(value)
    const existing = normalizedByOriginal.get(original)
    if (existing !== undefined) return existing

    const claim = (candidate: string): boolean => {
      const owner = originalByNormalized.get(candidate)
      if (owner !== undefined && owner !== original) return false
      normalizedByOriginal.set(original, candidate)
      originalByNormalized.set(candidate, original)
      return true
    }

    if (original.length <= 64 && claim(original)) return original
    for (let attempt = 0; ; attempt++) {
      const material = attempt === 0 ? original : `${original}\0${attempt}`
      const candidate = `dsh_${createHash('sha256').update(material).digest('hex').slice(0, 60)}`
      if (claim(candidate)) return candidate
    }
  }
}

function normalizeReplayCallIds(
  items: Array<Record<string, unknown>> | null,
  normalizeCallId: (value: unknown) => string,
): Array<Record<string, unknown>> | null {
  if (items === null) return null
  return items.map((item) => typeof item.call_id === 'string'
    ? { ...item, call_id: normalizeCallId(item.call_id) }
    : item)
}

export async function buildResponsesPayload(
  options: GenerateOptions,
  attachments: Pick<AttachmentStore, 'readImage'> & Partial<Pick<AttachmentStore, 'imageLimits'>>,
  localRawImages: LocalRawImageOptions = {},
  outputVerbosity: CodexOutputVerbosity | null = null,
  fastMode: boolean = false,
  reasoningSummary: CodexReasoningSummary | null = null,
  promptCacheKey?: string,
  wire: ResponsesWireOptions = {},
): Promise<ResponsesPayload> {
  // The caller's answer wins; without one the model's own catalog decides, and
  // a model no catalog states a protocol for is not Lite.
  const useResponsesLite = wire.useResponsesLite ?? codexModelUsesResponsesLite(options.model)
  const resolveLocalRawImages = supportsImageInput(options)
  const normalizeCallId = createCallIdNormalizer()
  const instructionParts = [
    options.system?.trim(),
    latestSystemPrompt(options.messages),
    progressExplanationInstruction(options.tools),
    commandToolInstruction(options.tools),
    runCodeInstruction(options.tools),
  ].filter((value): value is string => Boolean(value))

  const input: Array<Record<string, unknown>> = []
  const knownToolCalls = new Map<string, string | undefined>()
  const localImageStats: LocalRawImageStats = { attempted: 0, resolved: 0, failed: 0 }
  for (const message of options.messages) {
    if (message.role === 'system') continue
    const replayItems = normalizeReplayCallIds(replayOutputItems(message), normalizeCallId)
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
      appendMissingToolCalls(input, knownToolCalls, message, normalizeCallId)
      continue
    }
    const toolResult = message.content.find((block) => block.type === 'tool-result')
    if (toolResult?.type === 'tool-result') {
      const originalCallId = String(toolResult.toolCallId)
      const callId = normalizeCallId(originalCallId)
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
            text: `Tool result for unavailable call ${originalCallId}${toolResult.isError ? ' (error)' : ''}:\n${rawOutput}`,
          }],
        })
      }
      continue
    }
    const content = await mapContent(message, attachments, options.signal, localRawImages, localImageStats, resolveLocalRawImages)
    if (content.length > 0) input.push({ role: message.role, content })
    if (message.role === 'assistant') {
      appendMissingToolCalls(input, knownToolCalls, message, normalizeCallId)
    }
  }

  // Bound the image payload HERE, on the built input, because this is the only
  // point where every image form is visible: pasted attachments, tool-read
  // images inlined from local markdown links, and tool-result images have all
  // become `input_image` items by now. See offloadOldestInputImages.
  offloadOldestInputImages(input)

  const instructions = [
    ...instructionParts,
    localRawImageInstruction(localImageStats),
  ].filter((value): value is string => Boolean(value))
  const instructionText = instructions.join('\n\n')

  // The two items the official client puts at the HEAD of `input`, in this
  // order: the tool declarations (Lite only) and the base instructions.
  //
  // The instructions travel as a developer MESSAGE rather than in the top-level
  // `instructions` field, because the official request no longer has that field:
  // the base instructions are an ordinary input item, so the backend attributes
  // them like any other part of the conversation.
  const prefix: Array<Record<string, unknown>> = []
  const tools = options.tools ?? []
  if (useResponsesLite && tools.length > 0) {
    prefix.push(additionalToolsItem(tools, wire.idNamespace))
  }
  // No instructions means no message: an empty developer item would be a
  // conversation turn that says nothing.
  if (instructionText !== '') {
    prefix.push(developerMessageItem(instructionText, wire.idNamespace, useResponsesLite))
  }
  input.unshift(...prefix)

  const toolDeclarations = tools.length > 0 ? tools.map(toolDeclaration) : undefined
  const reasoning = reasoningBlock(options, reasoningSummary, useResponsesLite)
  // "Follow the provider" is the user's default, and the provider's own client
  // sends the catalog's `default_verbosity` (low) on every request. Omitting the
  // field is NOT the same thing: the server then applies its own implicit
  // medium, so a user who never opened this setting was getting answers more
  // verbose — and more expensive — than the official client does.
  //
  // The field is still omitted for a model whose support this table cannot
  // establish, because the official catalog gates it per model and an
  // unsupported verbosity is a request the model may reject.
  const providerVerbosity = codexDefaultOutputVerbosity(options.model)
  const text = providerVerbosity !== undefined
    ? { verbosity: outputVerbosity ?? providerVerbosity }
    : undefined
  // NO `max_output_tokens`, and that is deliberate.
  //
  // This is the Responses path, and the subscription backend rejects the field
  // outright on some accounts and models: every turn fails with
  // `400 {"detail":"Unsupported parameter: max_output_tokens"}` (issue #29,
  // reported on gpt-6-sol and gpt-6.1-sol; the same account is fine once the
  // field is gone). The official CLI never sends it either — the Rust
  // `ResponsesApiRequest` struct in codex-rs has no such field — so the
  // service applies its own default and the whole idea of pinning a ceiling
  // from here is out of step with the wire contract.
  //
  // A caller's `maxTokens` is therefore not transmitted. The adapter still
  // declares `defaultMaxTokens` in its model info, which DSH uses as a LOCAL
  // reservation when it plans compaction — that number never reaches the wire.
  // Truncation is still reported: the backend ends such a turn with
  // `response.incomplete`, which `parseResponsesStream` maps to `max-tokens`
  // when the provider names a budget reason (`max_output_tokens`,
  // `max_messages`) or names none at all. A steered turn is an ordinary stop
  // and a content filter is the provider's own refusal, so neither is a
  // truncation.
  //
  // Do not reintroduce it, not even clamped to the model ceiling: that is
  // exactly the request the accounts in #29 reject.
  // The field order below is the official client's: routing fields first, then
  // the input, then the tool declarations, then the reasoning block, then the
  // store/include/cache keys and the text controls.
  const payload: ResponsesPayload = {
    model: options.model,
    stream: true,
    ...(fastMode ? { service_tier: 'priority' } : {}),
    input,
    // A Lite request declares its tools inside `input`; the standard shape keeps
    // them at the top level.
    ...(toolDeclarations !== undefined && !useResponsesLite ? { tools: toolDeclarations } : {}),
    // The official request always states both controls, including a request
    // with no tools. Lite runs one tool call at a time, so its flag is false.
    tool_choice: 'auto',
    parallel_tool_calls: !useResponsesLite,
    ...(reasoning !== undefined ? { reasoning } : {}),
    store: false,
    include: ['reasoning.encrypted_content'],
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    ...(text !== undefined ? { text } : {}),
  }
  return payload
}


/**
 * One tool declaration, in the shape the Responses API expects.
 *
 * `strict` is false because DSH's tool schemas are not strict-compatible: a
 * strict declaration demands that every property be required and that extra
 * properties be rejected, which these schemas are not written for. The official
 * client declares its own tools the same way.
 */
function toolDeclaration(tool: NonNullable<GenerateOptions['tools']>[number]): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    strict: false,
    // A deferred definition stays deferred on the wire: the backend decides when
    // to load it, so the flag has to travel with the declaration.
    ...(tool.deferLoading === true ? { defer_loading: true } : {}),
    parameters: tool.parameters,
  }
}

/**
 * The Lite tool declaration: every tool inside one `functions` namespace.
 *
 * Lite does not send loose function tools. It sends a namespace, and the model
 * calls into it, so the call keeps the plain tool name and carries the
 * namespace beside it.
 */
function liteToolsNamespace(tools: NonNullable<GenerateOptions['tools']>): Record<string, unknown> {
  return {
    type: 'namespace',
    name: 'functions',
    description: '',
    tools: tools.map(toolDeclaration),
  }
}

/**
 * The `additional_tools` item a Lite request carries.
 *
 * It is an input item, not a top-level field, so the tool declarations travel
 * with the conversation instead of beside it. No tools means no item at all: an
 * empty declaration would announce a namespace with nothing in it.
 */
function additionalToolsItem(
  tools: NonNullable<GenerateOptions['tools']>,
  idNamespace: string | undefined,
): Record<string, unknown> {
  const declarations = [liteToolsNamespace(tools)]
  return {
    type: 'additional_tools',
    id: stableItemId('at', idNamespace, JSON.stringify(declarations)),
    role: 'developer',
    tools: declarations,
  }
}

/**
 * The base instructions as a developer message.
 *
 * The official client marks the item with the `model.base_instructions` kind, so
 * the backend can tell the base instructions apart from any other developer
 * message in the conversation. Only Lite keeps the per-content attribution: the
 * standard shape has no room for it.
 */
function developerMessageItem(
  text: string,
  idNamespace: string | undefined,
  useResponsesLite: boolean,
): Record<string, unknown> {
  return {
    type: 'message',
    id: stableItemId('msg', idNamespace, text),
    role: 'developer',
    content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: {
      content_item_kinds: ['model.base_instructions'],
      ...(useResponsesLite
        ? { content_item_metadata: [{ provenance: { type: 'harness', hook: false } }] }
        : {}),
    },
  }
}

/**
 * The reasoning block for one request.
 *
 * A Lite request asks for the WHOLE conversation as reasoning context, because
 * Lite replays the conversation itself rather than sending the reasoning of the
 * current turn only. The standard shape omits the field, which is how the
 * backend is told to use the current turn.
 *
 * No summary is ever sent unless the user chose one: the provider's own catalog
 * default is `none`, and asking for a summary the caller will discard spends
 * billed tokens on output the backend is told to throw away.
 */
function reasoningBlock(
  options: GenerateOptions,
  reasoningSummary: CodexReasoningSummary | null,
  useResponsesLite: boolean,
): Record<string, unknown> | undefined {
  const context = useResponsesLite ? { context: 'all_turns' } : {}
  if (options.reasoningEffort === undefined) {
    // Lite still needs the block: it carries the context the request asks for.
    return useResponsesLite ? context : undefined
  }
  const effort = codexWireReasoningEffort(options.model, options.reasoningEffort)
  const summary = reasoningSummary === null || reasoningSummary === 'none' ? undefined : reasoningSummary
  return summary !== undefined && codexModelSupportsReasoningSummary(options.model)
    ? { effort, summary, ...context }
    : { effort, ...context }
}

/**
 * RFC 4122 namespace OID, the namespace the official client derives its item
 * ids from.
 */
const UUID_NAMESPACE_OID = Buffer.from('6ba7b8129dad11d180b400c04fd430c8', 'hex')

/**
 * Namespace used when the caller named no conversation.
 *
 * The ids stay stable, but they are stable across conversations too - the price
 * of a request that arrived without a conversation identity.
 */
const DEFAULT_ID_NAMESPACE = 'dsh-chatgpt-subscription'

/**
 * A stable item id, in the official client's `msg_`/`at_` shape.
 *
 * The official client namespaces the id by the conversation thread and then by
 * the item's own content, so the same instructions carry the same id in the
 * same conversation - which is what lets the backend recognise a retried
 * request - and a different one in another conversation.
 *
 * @param prefix - `msg` for a message item, `at` for the tool declarations.
 * @param idNamespace - the conversation identity, when the caller supplied one.
 * @param material - the item content the id is derived from.
 * @returns the item id.
 */
function stableItemId(prefix: 'msg' | 'at', idNamespace: string | undefined, material: string): string {
  const namespace = uuidV5Bytes(UUID_NAMESPACE_OID, Buffer.from(idNamespace ?? DEFAULT_ID_NAMESPACE, 'utf8'))
  return `${prefix}_${formatUuid(uuidV5Bytes(namespace, Buffer.from(material, 'utf8')))}`
}

/**
 * RFC 4122 version 5 UUID (SHA-1) as raw bytes.
 */
function uuidV5Bytes(namespace: Buffer, name: Buffer): Buffer {
  const digest = createHash('sha1').update(namespace).update(name).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return bytes
}

/**
 * Format raw UUID bytes as the canonical 8-4-4-4-12 text form.
 */
function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
function progressExplanationInstruction(tools: GenerateOptions['tools']): string | undefined {
  if (!tools?.length) return undefined
  return 'Progress and tool execution rule: when executing multi-step tasks or invoking tools, output 1-2 concise sentences of progress, intent, or intermediate findings before each tool call. Keep progress text brief, professional, and factual. Only present the comprehensive final answer and summary in the final turn after all tool operations are completed.'
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
  return options.provider === 'codex-chatgpt' && codexModelSupportsImageInput(options.model)
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
  return `Command tool compatibility rule (${uniqueNames.join(', ')}): each command call runs in a fresh process, so do not rely on cd, aliases, functions, or variables from previous calls; set workdir when the tool supports it. ${shellGuidance} For deletion or move operations, first resolve and verify exact absolute target paths, then operate on those literal paths only; avoid dynamically deleting paths built from home-directory expansion, wildcards, command substitution, or another shell's output. If downloads fail with TLS credential or connection-closed errors, treat that as an environment/network failure and use local sources or report the limitation instead of cycling through equivalent download commands.`
}

function isCommandTool(name: string): boolean {
  const normalized = name.toLowerCase()
  return normalized === 'pwsh'
    || normalized === 'powershell'
    || normalized === 'bash'
    || normalized === 'sh'
    || normalized === 'shell'
}

function appendMissingToolCalls(
  input: Array<Record<string, unknown>>,
  knownToolCalls: Map<string, string | undefined>,
  message: Message,
  normalizeCallId: (value: unknown) => string,
): void {
  for (const block of message.content) {
    if (block.type !== 'tool-call') continue
    const callId = normalizeCallId(block.id)
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

/**
 * The effective system prompt of a loop-built request. DSH keeps an earlier
 * `system` node as cached history whenever the rendered prompt changes, so only
 * the newest non-empty node is the complete prompt; concatenating every node
 * would resend superseded instructions.
 */
function latestSystemPrompt(messages: readonly Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.role !== 'system') continue
    const text = blocksToText(message.content).trim()
    if (text) return text
  }
  return undefined
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
  if (message.source?.kind !== 'model') return null
  const replay = message.source?.replayState
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
