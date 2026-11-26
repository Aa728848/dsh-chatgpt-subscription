/**
 * A compaction summary follows the session's own effort on AWS Quick.
 *
 * The harness names no effort on a compaction request; this line carries the
 * effort as the fourth argument of `QuickConnection.sendUser`, so an unnamed
 * compaction must reuse the main turn's effort instead of the settings default.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { AwsQuickAdapter } from '../../../src/host/providers/aws-quick/adapter.ts'
import { AwsQuickSettingsStore } from '../../../src/host/providers/aws-quick/settings.ts'
import type { AwsQuickOutpost } from '../../../src/host/providers/aws-quick/outpost.ts'
import type { QuickConnection, QuickStreamEvent } from '../../../src/host/providers/aws-quick/client.ts'

const outpost = { dispose: async () => undefined } as unknown as AwsQuickOutpost

async function cleanup(file: string): Promise<void> {
  await fs.unlink(file).catch(() => undefined)
  await fs.rmdir(path.dirname(file)).catch(() => undefined)
}

function quickConnection(): { connection: QuickConnection; efforts: unknown[] } {
  const efforts: unknown[] = []
  const connection = {
    sendUser: (_text: string, _mode: unknown, effort?: unknown) => { efforts.push(effort) },
    setSignal: () => undefined,
    setActivity: () => undefined,
    events: async function* (): AsyncGenerator<QuickStreamEvent> {
      yield { kind: 'text', delta: 'ok' }
      yield { kind: 'done', reason: 'stop' }
    },
    answerTool: () => undefined,
    close: () => undefined,
  } as unknown as QuickConnection
  return { connection, efforts }
}

function request(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'quick-balanced',
    sessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...extra,
  }
}

async function collect(adapter: AwsQuickAdapter, opts: Record<string, unknown>): Promise<void> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(opts as never)) chunks.push(chunk)
  expect(chunks.length).toBeGreaterThan(0)
}

describe('AWS Quick auxiliary request effort', () => {
  it('carries a compaction at the session main-turn effort', async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-aws-quick-effort-')), 'settings.json')
    try {
      const opened: Array<{ efforts: unknown[] }> = []
      const adapter = new AwsQuickAdapter({
        settings: new AwsQuickSettingsStore(file),
        outpost,
        openConnection: async () => {
          const fake = quickConnection()
          opened.push(fake)
          return fake.connection
        },
      })
      // Each call opens its own connection (an auxiliary purpose never reuses the
      // live thread), so each carries its own effort record.
      await collect(adapter, request('sess-a', { reasoningEffort: 'high' }))
      await collect(adapter, request('sess-a', { purpose: 'compaction' }))
      expect(opened.map((entry) => entry.efforts[0])).toEqual(['high', 'high'])
      await adapter.dispose()
    } finally {
      await cleanup(file)
    }
  })

  it('keeps an effort the auxiliary request names itself', async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-aws-quick-effort-')), 'settings.json')
    try {
      const opened: Array<{ efforts: unknown[] }> = []
      const adapter = new AwsQuickAdapter({
        settings: new AwsQuickSettingsStore(file),
        outpost,
        openConnection: async () => {
          const fake = quickConnection()
          opened.push(fake)
          return fake.connection
        },
      })
      await collect(adapter, request('sess-b', { reasoningEffort: 'high' }))
      await collect(adapter, request('sess-b', { purpose: 'compaction', reasoningEffort: 'low' }))
      expect(opened.map((entry) => entry.efforts[0])).toEqual(['high', 'low'])
      await adapter.dispose()
    } finally {
      await cleanup(file)
    }
  })
})
