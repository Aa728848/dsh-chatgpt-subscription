/**
 * Live probe: one real Antigravity (ACP) turn through this line's adapter.
 *
 * Skipped by default, like every other probe in this directory: it needs the
 * official `agy` CLI installed and signed in, and the offline suite must stay
 * free of network and credentials. Run it with:
 *
 *   npx vitest run --config vitest.config.ts test/antigravity-acp.probe.test.ts
 *
 * It prints what the agent actually answered and asserts only what must hold for
 * ANY answer: the protocol negotiated, a session was created, and the turn
 * settled with a finish reason. A refusal or an auth wall is a legitimate live
 * result; a crash is not.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AntigravityAcpAdapter } from '../src/host/antigravity-acp/adapter.ts'
import { AntigravityAcpSettingsStore } from '../src/host/antigravity-acp/settings.ts'
import { AcpCatalog } from '../src/host/antigravity-acp/catalog.ts'
import { AcpClient } from '../src/host/antigravity-acp/acp-client.ts'
import { resolveAcpBinary } from '../src/host/antigravity-acp/binary.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const ENABLED = process.env.ANTIGRAVITY_ACP_PROBE === '1'

describe.skipIf(!ENABLED)('Antigravity (ACP) live probe', () => {
  it('runs one real turn and reports what came back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-live-probe-'))
    const settings = new AntigravityAcpSettingsStore(join(dir, 'settings.json'))
    const launch = async () => {
      const resolved = await resolveAcpBinary(null)
      if (resolved.binary === undefined) throw new Error(resolved.diagnostics.error ?? 'no agy')
      return { command: resolved.binary.path, args: ['acp', '--disable-telemetry'], version: resolved.binary.version }
    }
    const catalog = new AcpCatalog(launch, (entry) => new AcpClient({ command: entry.command, args: entry.args, cwd: process.cwd() }))
    const adapter = new AntigravityAcpAdapter({
      settings,
      resolveLaunch: launch,
      loadCatalog: async (options) => {
        const read = await catalog.read(options)
        return read === undefined ? undefined : { models: read.models, synced: !read.fromSnapshot }
      },
    })
    try {
      const models = await adapter.listModels('antigravity-acp')
      console.log('MODELS', models.map((model) => model.id).join(','))
      expect(models.length).toBeGreaterThan(0)
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({
        provider: 'antigravity-acp',
        model: models[0]!.id,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly ACP_OK and nothing else.' }] }],
      } as never)) {
        chunks.push(chunk)
      }
      const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => (chunk as { text: string }).text).join('')
      console.log('ANSWER', text)
      expect(chunks.at(-1)?.type).toBe('finish')
    } finally {
      await adapter.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})
