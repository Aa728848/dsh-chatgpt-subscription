/**
 * The local MCP bridge: the one place where the ACP agent's tool calls become
 * this harness's tool calls.
 *
 * WHY A BRIDGE AT ALL
 *
 * ACP gives an agent its own tools. That is fine for an editor, and wrong for a
 * subscription line inside DSH: a `write_file` performed by the agent process
 * would bypass this harness's permission presets, its sandbox policy, its tool
 * wrappers and its durable tool-result records. So the session is created with a
 * loopback MCP server descriptor whose catalogue is *this request's* tool
 * schemas; the agent asks the bridge to call one, the bridge parks that request
 * and surfaces it to the adapter as an ordinary DSH tool call, and the harness
 * executes it. When the next generation arrives with the result, the parked MCP
 * request is answered with the real bytes (or `isError` for a denial).
 *
 * TRUST BOUNDARY
 *
 * The bridge is reachable by anything on this machine that learns its port and
 * token, so both are minted per session: a fresh 256-bit bearer token, bound to
 * 127.0.0.1 only, `Host` validated, browser `Origin` refused, `POST /mcp` only,
 * and a 1 MiB body cap. A caller that fails any of those is answered 403/413 and
 * never reaches a tool.
 *
 * @module dsh-chatgpt-subscription/host/antigravity-acp/mcp-bridge
 */

import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/** One tool call the agent asked the bridge to perform, parked until DSH answers. */
export interface ParkedToolCall {
  /** Bridge-internal id, also the MCP request id that must be answered. */
  callId: string
  /** The DSH tool name (unmapped). */
  name: string
  /** Raw JSON argument text exactly as the agent produced it. */
  argumentsText: string
}

/** What DSH produced for one parked call. */
export interface ToolCallOutcome {
  /** Text handed back to the agent. */
  text: string
  /** True when the harness refused or the tool failed; the agent must see an error, not a blank success. */
  isError: boolean
}

/** MCP descriptor the ACP session receives. */
export interface BridgeDescriptor {
  name: string
  type: 'http'
  url: string
  headers: { name: string; value: string }[]
}

/** Largest body the bridge accepts; a tool result is bounded by the harness, an argument object is small. */
export const BRIDGE_MAX_BODY_BYTES = 1_048_576

/** Largest tool catalogue the bridge exposes. */
export const BRIDGE_MAX_TOOLS = 256

/** Largest single tool definition the bridge accepts. */
export const BRIDGE_MAX_TOOL_BYTES = 131_072

/** Largest number of calls that may be parked at once. */
export const BRIDGE_MAX_PENDING = 64

/** MCP server name advertised to the agent; the reference implementation's own clients key on it. */
export const BRIDGE_SERVER_NAME = 'dsh-bridge'

/**
 * One bridge, valid for exactly one ACP session and one tool catalogue.
 *
 * A bridge is not reusable across sessions: the catalogue is captured here, and
 * reusing it would let a stale schema reach the agent after the harness's tool
 * set changed.
 */
export class McpBridge {
  private server: http.Server | undefined
  private descriptor: BridgeDescriptor | undefined
  private readonly token = randomBytes(32).toString('base64url')
  private readonly exposed: ExposedTool[]
  private readonly withdrawn = new Map<string, ExposedTool>()
  private readonly parked = new Map<string, ParkedToolCall>()
  private readonly waiters = new Set<() => void>()
  private closed = false

  /**
   * @param tools - The exact tool schemas this DSH request carries.
   */
  constructor(tools: readonly ToolSchema[]) {
    this.exposed = exposeTools(tools)
  }

  /** Bind the loopback listener and return the descriptor an ACP session accepts. */
  async start(): Promise<BridgeDescriptor> {
    if (this.descriptor !== undefined) return this.descriptor
    const server = http.createServer((request, response) => {
      void this.handle(request, response)
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address() as AddressInfo
    this.descriptor = {
      name: BRIDGE_SERVER_NAME,
      type: 'http',
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: [{ name: 'Authorization', value: `Bearer ${this.token}` }],
    }
    return this.descriptor
  }

  /** Calls parked since the last read, in arrival order. */
  takeParked(): ParkedToolCall[] {
    if (this.parked.size === 0) return []
    const calls = [...this.parked.values()]
    this.parked.clear()
    return calls
  }

  /** How many calls are currently waiting for an answer. */
  get pendingCount(): number {
    return this.parked.size
  }

  /**
   * Resolve one parked call with what the harness produced.
   *
   * @param callId - The id {@link takeParked} handed out.
   * @param outcome - Result text and whether it is an error.
   * @returns whether a parked call answered this id.
   */
  settle(callId: string, outcome: ToolCallOutcome): boolean {
    const pending = this.pendingResponses.get(callId)
    if (pending === undefined) return false
    this.pendingResponses.delete(callId)
    pending(outcome)
    return true
  }

  /**
   * Wait until at least one call is parked or the bridge closes.
   *
   * @param signal - Caller cancellation.
   * @returns true when work is available, false when the wait ended without any.
   */
  waitForWork(signal?: AbortSignal): Promise<boolean> {
    if (this.parked.size > 0) return Promise.resolve(true)
    if (this.closed) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const wake = (): void => {
        cleanup()
        resolve(this.parked.size > 0)
      }
      const onAbort = (): void => {
        cleanup()
        resolve(false)
      }
      const cleanup = (): void => {
        this.waiters.delete(wake)
        signal?.removeEventListener('abort', onAbort)
      }
      this.waiters.add(wake)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Close the listener and refuse every outstanding call. */
  async close(): Promise<void> {
    this.closed = true
    for (const wake of [...this.waiters]) wake()
    this.waiters.clear()
    for (const [callId, pending] of [...this.pendingResponses]) {
      this.pendingResponses.delete(callId)
      pending({ text: 'The tool bridge was closed before the call was answered.', isError: true })
    }
    const server = this.server
    this.server = undefined
    if (server === undefined) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Responses parked on their MCP request, keyed by call id. */
  private readonly pendingResponses = new Map<string, (outcome: ToolCallOutcome) => void>()

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      respond(response, 405, { error: 'Method not allowed.' })
      return
    }
    if (!this.authorized(request)) {
      respond(response, 403, { error: 'Forbidden.' })
      return
    }
    let size = 0
    const chunks: Buffer[] = []
    try {
      for await (const chunk of request) {
        const buffer = chunk as Buffer
        size += buffer.length
        if (size > BRIDGE_MAX_BODY_BYTES) {
          respond(response, 413, { error: 'Request body is too large.' })
          return
        }
        chunks.push(buffer)
      }
    } catch {
      respond(response, 400, { error: 'Request body could not be read.' })
      return
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (text === '') {
      respond(response, 202, undefined)
      return
    }
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
      message = parsed as Record<string, unknown>
    } catch {
      respond(response, 400, { error: 'Request body must be a JSON-RPC object.' })
      return
    }
    const id = message.id
    const method = typeof message.method === 'string' ? message.method : undefined
    if (id === undefined || id === null) {
      // A notification: `notifications/initialized`, `notifications/roots/list_changed`.
      respond(response, 202, undefined)
      return
    }
    if (method === undefined) {
      respond(response, 400, jsonRpcError(id, -32600, 'Missing method.'))
      return
    }
    if (method === 'tools/call') {
      await this.handleToolCall(id, message.params, response)
      return
    }
    respond(response, 200, jsonRpcResult(id, this.answer(method)))
  }

  /** Answer the methods the agent asks before it can call anything. */
  private answer(method: string): unknown {
    switch (method) {
      case 'server/discover':
        return {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: BRIDGE_SERVER_NAME, version: '1.0.0' },
        }
      case 'initialize':
        return {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: BRIDGE_SERVER_NAME, version: '1.0.0' },
        }
      case 'tools/list':
        return {
          tools: this.exposed.map((tool) => ({
            name: tool.exposedName,
            description: tool.definition.description,
            inputSchema: tool.definition.parameters,
          })),
        }
      case 'ping':
        return {}
      default:
        return {}
    }
  }

  private async handleToolCall(id: unknown, params: unknown, response: ServerResponse): Promise<void> {
    const record = typeof params === 'object' && params !== null && !Array.isArray(params)
      ? params as Record<string, unknown>
      : {}
    const exposedName = typeof record.name === 'string' ? record.name : ''
    const tool = this.exposed.find((entry) => entry.exposedName === exposedName)
      ?? this.withdrawn.get(exposedName)
    if (tool === undefined) {
      respond(response, 200, jsonRpcResult(id, {
        content: [{ type: 'text', text: `Unknown tool: ${exposedName}` }],
        isError: true,
      }))
      return
    }
    if (this.parked.size >= BRIDGE_MAX_PENDING) {
      respond(response, 200, jsonRpcResult(id, {
        content: [{ type: 'text', text: 'Too many pending tool calls; wait for the running ones to finish.' }],
        isError: true,
      }))
      return
    }
    const callId = `acp-${randomBytes(8).toString('hex')}`
    const args = record.arguments
    const argumentsText = typeof args === 'string' ? args : JSON.stringify(args ?? {})
    this.parked.set(callId, { callId, name: tool.name, argumentsText })
    for (const wake of [...this.waiters]) wake()
    this.waiters.clear()
    // The MCP request stays open until the harness answers. `settle` is called from
    // the next generation's adapter run, so the agent's turn is genuinely paused
    // while the tool executes - not racing it.
    await new Promise<ToolCallOutcome>((resolve) => {
      this.pendingResponses.set(callId, resolve)
    }).then((outcome) => {
      respond(response, 200, jsonRpcResult(id, {
        content: [{ type: 'text', text: outcome.text }],
        ...(outcome.isError ? { isError: true } : {}),
      }))
    })
  }

  private authorized(request: IncomingMessage): boolean {
    const host = request.headers.host
    if (typeof host !== 'string') return false
    let hostname: string
    try {
      hostname = new URL(`http://${host}`).hostname.toLowerCase()
    } catch {
      return false
    }
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]' && hostname !== '::1') return false
    const origin = request.headers.origin
    // A browser always states Origin; the agent's MCP client does not. Refusing a
    // stated origin is what keeps a web page from driving this port.
    if (typeof origin === 'string' && origin !== '') return false
    const authorization = request.headers.authorization
    return typeof authorization === 'string' && authorization === `Bearer ${this.token}`
  }
}

interface ExposedTool {
  name: string
  exposedName: string
  definition: ToolSchema
}

/**
 * Map this request's tool schemas onto MCP-legal names.
 *
 * MCP tool names are restricted to a small character set and 64 bytes. A DSH tool
 * name that already fits keeps its own name - the harness's tool names are what a
 * user sees in a permission prompt, so renaming one that did not need it would
 * only make the record harder to read. One that does not fit is replaced by a
 * stable hash, and the mapping is retained so the reverse direction is exact.
 */
function exposeTools(tools: readonly ToolSchema[]): ExposedTool[] {
  const seen = new Set<string>()
  const exposed: ExposedTool[] = []
  for (const definition of tools.slice(0, BRIDGE_MAX_TOOLS)) {
    const encoded = JSON.stringify(definition.parameters ?? {})
    if (Buffer.byteLength(encoded, 'utf8') > BRIDGE_MAX_TOOL_BYTES) continue
    let exposedName = /^[A-Za-z0-9_-]{1,64}$/.test(definition.name)
      ? definition.name
      : `dsh_${createHash('sha256').update(definition.name).digest('hex').slice(0, 16)}`
    let collision = 0
    while (seen.has(exposedName)) {
      collision += 1
      exposedName = `${exposedName.slice(0, 56)}_${collision}`
    }
    seen.add(exposedName)
    exposed.push({ name: definition.name, exposedName, definition })
  }
  return exposed
}

function jsonRpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.end()
    return
  }
  if (body === undefined) {
    response.writeHead(status)
    response.end()
    return
  }
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(payload)
}
