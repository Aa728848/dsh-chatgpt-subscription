/**
 * The catalogue reader against a scripted ACP server.
 *
 * The shape that matters here is the server's own nesting: the tier-suffixed ids
 * live under `models.availableModels`, while `session/set_config_option` takes
 * the base ids from `configOptions[model].options`. Reading the wrong one is not
 * an error anywhere - it just produces models with an empty thinking ladder,
 * which is exactly the failure this test pins.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCatalogFrom } from '../src/host/antigravity-acp/catalog.ts'
import { AcpClient } from '../src/host/antigravity-acp/acp-client.ts'

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
    if (request.method === 'session/new') {
      reply(request.id, {
        sessionId: 's1',
        models: { availableModels: [
          { modelId: 'gemini-4-carbon-low', name: 'Gemini 4 Carbon (Low)' },
          { modelId: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
          { modelId: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' },
          { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
        ] },
        configOptions: [
          { id: 'model', type: 'select', options: [
            { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
            { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
          ] },
          { id: 'thought_level', type: 'select', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
        ],
        _meta: { antigravity: { tier: { id: 't', name: 'Google AI Ultra' } } },
      })
      continue
    }
    reply(request.id, {})
  }
})
`

describe('readCatalogFrom', () => {
  it('reads the nested tier list and collapses it against the model option', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-catalog-read-'))
    const server = join(dir, 'server.mjs')
    writeFileSync(server, SERVER, 'utf8')
    const client = new AcpClient({ command: process.execPath, args: [server], cwd: process.cwd() })
    try {
      const read = await readCatalogFrom(client)
      expect(read.models).toEqual([
        { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', efforts: ['low', 'medium', 'high'] },
        { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', efforts: [] },
      ])
      expect(read.tier).toEqual({ id: 't', name: 'Google AI Ultra' })
    } finally {
      await client.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
