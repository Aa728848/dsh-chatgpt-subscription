/**
 * The MCP bridge: the trust boundary between an ACP agent and this harness.
 *
 * Each test talks to the real HTTP server the bridge starts, because the
 * properties that matter here are transport-level: which requests are admitted,
 * what a refusal looks like, and whether a parked call really stays open until
 * the harness answers it.
 */
import { describe, expect, it } from 'vitest'
import { McpBridge } from '../src/host/antigravity-acp/mcp-bridge.ts'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

const TOOLS: ToolSchema[] = [
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'weird name with spaces', description: 'Needs renaming', parameters: { type: 'object', properties: {} } },
]

/** One MCP JSON-RPC round trip against a descriptor. */
async function rpc(
  url: string,
  authorization: string,
  body: unknown,
  init: RpcInit = {},
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: init.method ?? 'POST',
    headers: { 'content-type': 'application/json', authorization, ...(init.headers ?? {}) },
    ...(init.method === 'GET' ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, json: text === '' ? null : JSON.parse(text) }
}

interface RpcInit {
  method?: string
  headers?: Record<string, string>
}

describe('McpBridge', () => {
  it('advertises the request\'s tools, renaming only what MCP cannot carry', async () => {
    const bridge = new McpBridge(TOOLS)
    const descriptor = await bridge.start()
    try {
      const token = descriptor.headers[0]!.value
      const listed = await rpc(descriptor.url, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
      const tools = (listed.json as { result: { tools: { name: string }[] } }).result.tools
      expect(tools[0]!.name).toBe('read_file')
      // A name MCP cannot carry is replaced by a stable hash rather than dropped.
      expect(tools[1]!.name).toMatch(/^dsh_[0-9a-f]{16}$/)
    } finally {
      await bridge.close()
    }
  })

  it('refuses a request without the bearer token', async () => {
    const bridge = new McpBridge(TOOLS)
    const descriptor = await bridge.start()
    try {
      const denied = await rpc(descriptor.url, 'Bearer wrong', { jsonrpc: '2.0', id: 1, method: 'tools/list' })
      expect(denied.status).toBe(403)
    } finally {
      await bridge.close()
    }
  })

  it('refuses a browser origin even with the right token', async () => {
    const bridge = new McpBridge(TOOLS)
    const descriptor = await bridge.start()
    try {
      const token = descriptor.headers[0]!.value
      const denied = await rpc(
        descriptor.url,
        token,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { headers: { origin: 'https://evil.example' } },
      )
      expect(denied.status).toBe(403)
    } finally {
      await bridge.close()
    }
  })

  it('parks a tool call until the harness answers it, then returns the real result', async () => {
    const bridge = new McpBridge(TOOLS)
    const descriptor = await bridge.start()
    try {
      const token = descriptor.headers[0]!.value
      const call = rpc(descriptor.url, token, {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/tmp/x' } },
      })
      await bridge.waitForWork()
      const parked = bridge.takeParked()
      expect(parked).toHaveLength(1)
      expect(parked[0]!.name).toBe('read_file')
      expect(parked[0]!.argumentsText).toBe('{"path":"/tmp/x"}')
      expect(bridge.settle(parked[0]!.callId, { text: 'file bytes', isError: false })).toBe(true)
      const answered = await call
      expect(answered.json).toMatchObject({ result: { content: [{ type: 'text', text: 'file bytes' }] } })
    } finally {
      await bridge.close()
    }
  })

  it('answers a denial as isError rather than as an empty success', async () => {
    const bridge = new McpBridge(TOOLS)
    const descriptor = await bridge.start()
    try {
      const token = descriptor.headers[0]!.value
      const call = rpc(descriptor.url, token, {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'read_file', arguments: {} },
      })
      await bridge.waitForWork()
      const parked = bridge.takeParked()
      bridge.settle(parked[0]!.callId, { text: 'The user denied this action.', isError: true })
      const answered = await call
      expect(answered.json).toMatchObject({ result: { isError: true } })
    } finally {
      await bridge.close()
    }
  })

  it('answers an unknown tool with an MCP error result, not a thrown request', async () => {
    const bridge = new McpBridge(TOOLS)
    const descriptor = await bridge.start()
    try {
      const token = descriptor.headers[0]!.value
      const answered = await rpc(descriptor.url, token, {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'not_a_tool', arguments: {} },
      })
      expect(answered.json).toMatchObject({ result: { isError: true } })
    } finally {
      await bridge.close()
    }
  })

  it('accepts only POST on the MCP endpoint', async () => {
    const bridge = new McpBridge(TOOLS)
    const descriptor = await bridge.start()
    try {
      const token = descriptor.headers[0]!.value
      const denied = await rpc(descriptor.url, token, null, { method: 'GET' })
      expect(denied.status).toBe(405)
    } finally {
      await bridge.close()
    }
  })
})
