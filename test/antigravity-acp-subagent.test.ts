/**
 * The subagent backend: a whole agent in a child process, and the degradation
 * that has to happen on a harness without a `subagents` service.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvider, registerAntigravityAcpSubagent } from '../src/host/antigravity-acp/subagent.ts'
import { AntigravityAcpSettingsStore } from '../src/host/antigravity-acp/settings.ts'

const SERVER = `
let buffer = ''
process.stdin.setEncoding('utf8')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.method === 'initialize') { reply(request.id, { protocolVersion: 1, authMethods: [] }); continue }
    if (request.method === 'session/new') { reply(request.id, { sessionId: 's1' }); continue }
    if (request.method === 'session/prompt') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child answer' } } },
      }) + '\\n')
      reply(request.id, { stopReason: 'end_turn' })
      continue
    }
    reply(request.id, {})
  }
})
`

function harness(): { options: never; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'acp-subagent-test-'))
  const server = join(dir, 'server.mjs')
  writeFileSync(server, SERVER, 'utf8')
  const settings = new AntigravityAcpSettingsStore(join(dir, 'settings.json'))
  return {
    options: {
      resolveLaunch: async () => ({ command: process.execPath, args: [server] }),
      settings,
    } as never,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('Antigravity subagent provider', () => {
  it('advertises no start-time capabilities it cannot honour', () => {
    const space = harness()
    try {
      const provider = createProvider(space.options)
      expect(provider.name).toBe('antigravity-acp')
      expect(provider.capabilities).toEqual({ agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false })
      expect(provider.inheritsParentContext).toBe(false)
    } finally {
      space.dispose()
    }
  })

  it('runs one prompt in a child process and returns its text', async () => {
    const space = harness()
    try {
      const provider = createProvider(space.options)
      const run = await provider.start({ cwd: process.cwd(), prompt: [{ type: 'text', text: 'do the thing' }] } as never)
      const result = await run.result
      expect(result.stopReason).toBe('completed')
      expect(result.output.map((block) => (block.type === 'text' ? block.text : '')).join('')).toContain('child answer')
      await run.dispose()
    } finally {
      space.dispose()
    }
  })

  it('reports a start failure as an error result rather than rejecting the run', async () => {
    const space = harness()
    try {
      const provider = createProvider({
        resolveLaunch: async () => { throw new Error('no agy') },
        settings: (space.options as { settings: AntigravityAcpSettingsStore }).settings,
      } as never)
      await expect(provider.start({ cwd: process.cwd(), prompt: [{ type: 'text', text: 'x' }] } as never)).rejects.toThrow('no agy')
    } finally {
      space.dispose()
    }
  })
})

describe('registerAntigravityAcpSubagent', () => {
  it('registers when the host has a subagents service', () => {
    const registered: string[] = []
    const ctx = {
      get: (name: string) => (name === 'subagents'
        ? { registerProvider: (provider: { name: string }) => { registered.push(provider.name); return () => undefined } }
        : undefined),
      logger: { warn: vi.fn() },
    }
    const space = harness()
    try {
      const dispose = registerAntigravityAcpSubagent(ctx as never, space.options)
      expect(registered).toEqual(['antigravity-acp'])
      expect(typeof dispose).toBe('function')
    } finally {
      space.dispose()
    }
  })

  it('is a no-op on a host without a subagents service', () => {
    const ctx = { get: () => undefined, logger: { warn: vi.fn() } }
    const space = harness()
    try {
      expect(registerAntigravityAcpSubagent(ctx as never, space.options)).toBeUndefined()
    } finally {
      space.dispose()
    }
  })

  it('does not take the plugin down when registration throws', () => {
    const ctx = {
      get: () => ({ registerProvider: () => { throw new Error('duplicate provider') } }),
      logger: { warn: vi.fn() },
    }
    const space = harness()
    try {
      expect(registerAntigravityAcpSubagent(ctx as never, space.options)).toBeUndefined()
    } finally {
      space.dispose()
    }
  })
})
