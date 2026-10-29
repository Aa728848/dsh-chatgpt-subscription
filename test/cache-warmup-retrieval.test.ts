import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PreviewBudget, ResultReferenceStore } from '../src/host/cache-warmup/contracts.ts'
import { projectToolResult } from '../src/host/cache-warmup/projection.ts'
import { cacheWarmupNavigationIntentOf } from '../src/host/cache-warmup/retrieval-intent.ts'
import { resolveCacheWarmupSettings } from '../src/host/cache-warmup/settings.ts'

const NL = String.fromCharCode(10)
const BUDGET: PreviewBudget = { maxChars: 1200, warmup: true, consecutiveHits: 0, hitRatio: 0 }

function memoryStore() {
  const originals = new Map<string, string>()
  let sequence = 0
  const store = {
    put: async (input: { sessionId: string, content: string, at?: number }) => {
      sequence += 1
      const digest = createHash('sha256').update(input.content).digest('hex')
      const refId = 'ref://' + input.sessionId + '/' + digest + '-' + sequence
      originals.set(refId, input.content)
      return {
        refId,
        sessionId: input.sessionId,
        digest,
        bytes: Buffer.byteLength(input.content),
        chars: input.content.length,
        at: input.at ?? Date.now(),
        created: true,
      }
    },
    page: async () => { throw new Error('not used') },
    release: async () => { throw new Error('not used') },
  } as unknown as ResultReferenceStore
  return { store, originals }
}

function numberedSource(): string {
  const lines = ['1: import fs from "node:fs"']
  for (let line = 2; line <= 80; line += 1) {
    if (line === 20) lines.push('20: export function locateTarget() {')
    else if (line === 50) lines.push('50: export class TargetIndex {')
    else lines.push(line + ':   doWorkWithSomeLongOperationName(' + line + ')')
  }
  lines.push('81: }')
  return lines.join(NL)
}

function readEnvelope(source: string, path = 'C:/repo/src/example.ts'): string {
  const lines = source.split(NL).map((raw) => {
    const matched = /^(\d+):\s?(.*)$/.exec(raw)
    if (matched === null) throw new Error('bad fixture line: ' + raw)
    return { number: Number(matched[1]), text: matched[2] }
  })
  return JSON.stringify({ path, offset: 1, totalLines: lines.length, lines }, null, 2)
}

function agentWith(text: string, snapshot = false) {
  const event = { type: 'user/message', data: { content: [{ type: 'text', text }] } }
  return {
    session: snapshot
      ? { snapshotEvents: () => [event] }
      : { events: [event] },
  }
}

describe('retrieval projection', () => {
  it('keeps a direct file read verbatim when intent is not navigation', async () => {
    const { store, originals } = memoryStore()
    const content = numberedSource()
    const result = await projectToolResult({ toolName: 'read', sessionId: 's', content, navigation: false, budget: BUDGET, store })
    expect(result.changed).toBe(false)
    expect(result.metrics.strategy).toBe('verbatim-intent')
    expect(result.content).toBe(content)
    expect(originals.size).toBe(0)
  })

  it('projects a complete declaration outline for navigation and stores the original', async () => {
    const { store, originals } = memoryStore()
    const content = numberedSource()
    const result = await projectToolResult({ toolName: 'read', sessionId: 's', content, navigation: true, budget: BUDGET, store })
    expect(result.changed, JSON.stringify(result.metrics)).toBe(true)
    expect(result.metrics.strategy).toBe('file-outline')
    expect(result.preview).toContain('declarations: 2 (recognized set; complete)')
    expect(result.preview).toContain('L20 export function locateTarget()')
    expect(result.preview).toContain('L50 export class TargetIndex')
    expect(result.preview).not.toContain('const value79')
    expect(originals.get(result.refId!)).toBe(content)
  })

  it('keeps contracts verbatim even during navigation', async () => {
    const { store } = memoryStore()
    const lines = []
    for (let line = 1; line <= 100; line += 1) lines.push(line + ': ' + (line === 1 ? 'interface First { id: string }' : line === 2 ? 'type Second = First' : 'const x' + line + ' = ' + line))
    const result = await projectToolResult({ toolName: 'read', sessionId: 's', content: lines.join(NL), navigation: true, budget: BUDGET, store })
    expect(result.changed).toBe(false)
    expect(result.metrics.strategy).toBe('verbatim-contract')
  })

  it('projects a complete web title and heading outline without selecting facts', async () => {
    const { store, originals } = memoryStore()
    const content = [
      '<html><head><title>Cache &amp; Retrieval</title><style>hidden</style></head>',
      '<body><h1>Guide</h1><p>' + 'long paragraph '.repeat(100) + '</p>',
      '<h2>First section</h2><h3>Detail</h3><script>hidden()</script></body></html>',
    ].join(NL)
    const result = await projectToolResult({ toolName: 'web_fetch', sessionId: 's', content, navigation: true, budget: BUDGET, store })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('web-outline')
    expect(result.preview).toContain('title: Cache & Retrieval')
    expect(result.preview).toContain('H1 Guide')
    expect(result.preview).toContain('H2 First section')
    expect(result.preview).toContain('H3 Detail')
    expect(result.preview).not.toContain('hidden()')
    expect(originals.get(result.refId!)).toBe(content)
  })

  it('keeps an unstructured web document verbatim', async () => {
    const { store } = memoryStore()
    const content = 'plain prose without headings '.repeat(150)
    const result = await projectToolResult({ toolName: 'web_fetch', sessionId: 's', content, navigation: true, budget: BUDGET, store })
    expect(result.changed).toBe(false)
    expect(result.content).toBe(content)
  })

  it('projects a strict PTC numbered file and rejects mixed PTC output', async () => {
    const { store } = memoryStore()
    const content = numberedSource()
    const projected = await projectToolResult({ toolName: 'run_code', sessionId: 's', content, navigation: true, retrievalOnly: true, budget: BUDGET, store })
    expect(projected.changed).toBe(true)
    expect(projected.metrics.strategy).toBe('file-outline')
    const mixed = await projectToolResult({ toolName: 'run_code', sessionId: 's', content: '--- READ RESULT ---' + NL + content, navigation: true, retrievalOnly: true, budget: BUDGET, store })
    expect(mixed.changed).toBe(false)
    expect(mixed.metrics.strategy).toBe('verbatim-intent')
    expect(mixed.content).toBe('--- READ RESULT ---' + NL + content)
  })

  it('projects the canonical Read JSON Envelope used by PTC and stores the original', async () => {
    const { store, originals } = memoryStore()
    const content = readEnvelope(numberedSource())
    const result = await projectToolResult({ toolName: 'run_code', sessionId: 's', content, navigation: true, retrievalOnly: true, budget: BUDGET, store })
    expect(result.changed, JSON.stringify(result.metrics)).toBe(true)
    expect(result.metrics.strategy).toBe('file-outline')
    expect(result.preview).toContain('path: C:/repo/src/example.ts')
    expect(result.preview).toContain('L20 export function locateTarget()')
    expect(originals.get(result.refId!)).toBe(content)
  })

  it('keeps a Read JSON Envelope verbatim when its source is a contract', async () => {
    const { store } = memoryStore()
    const lines = ['1: interface First { id: string }', '2: type Second = First']
    for (let line = 3; line <= 80; line += 1) lines.push(line + ': doWork(' + line + ')')
    const content = readEnvelope(lines.join(NL))
    const result = await projectToolResult({ toolName: 'run_code', sessionId: 's', content, navigation: true, retrievalOnly: true, budget: BUDGET, store })
    expect(result.changed).toBe(false)
    expect(result.content).toBe(content)
  })

  it('projects the real probe file with its absolute path within warmup budget', async () => {
    const { store } = memoryStore()
    const probePath = path.resolve('scripts/probe-cache-warmup-retrieval.probe.ts')
    const lines = fs.readFileSync(probePath, 'utf8').split(/\r?\n/).map((text, index) => ({ number: index + 1, text }))
    const content = JSON.stringify({ path: probePath, offset: 1, totalLines: lines.length, lines }, null, 2)
    const result = await projectToolResult({ toolName: 'run_code', sessionId: 's', content, navigation: true, retrievalOnly: true, budget: BUDGET, store })
    expect(result.changed, JSON.stringify(result.metrics)).toBe(true)
    expect(result.metrics.strategy).toBe('file-outline')
  })

  it('reuses the existing grep and glob projections only after navigation admission', async () => {
    const { store } = memoryStore()
    const grep = []
    for (let file = 0; file < 12; file += 1) {
      for (let hit = 0; hit < 5; hit += 1) grep.push('src/f' + file + '.ts:' + (hit + 1) + ': export const hit = ' + hit)
    }
    const projected = await projectToolResult({ toolName: 'grep', sessionId: 's', content: grep.join(NL), navigation: true, budget: BUDGET, store })
    expect(projected.changed, JSON.stringify(projected.metrics)).toBe(true)
    expect(projected.metrics.strategy).toBe('grep-results')
    expect(projected.preview).toContain('matches: 60 across 12 files')
  })
})

describe('task-level cost baseline', () => {
  it('navigation previews reduce total input while raw fallbacks require no extra read', async () => {
    const { store } = memoryStore()
    const source = numberedSource()
    const file = await projectToolResult({ toolName: 'read', sessionId: 's', content: source, navigation: true, budget: BUDGET, store })
    expect(file.changed).toBe(true)
    expect(file.preview!.length).toBeLessThan(source.length)
    const web = await projectToolResult({ toolName: 'web_fetch', sessionId: 's', content: '<html><head><title>Guide</title></head><body><h1>Section</h1><p>' + 'facts '.repeat(500) + '</p></body></html>', navigation: true, budget: BUDGET, store })
    expect(web.changed).toBe(true)
    expect(web.preview!.length).toBeLessThan(3000)
    const editing = await projectToolResult({ toolName: 'read', sessionId: 's', content: source, navigation: false, budget: BUDGET, store })
    expect(editing.changed).toBe(false)
    expect(editing.content).toBe(source)
    // 编辑/审查没有先预览再补读的第 2 次工具轮次，总输入与旧实现一致。
    expect(editing.metrics.inputChars).toBe(editing.metrics.outputChars)
  })
})

describe('cache warmup settings', () => {
  it('defaults retrieval on unless explicitly disabled', () => {
    expect(resolveCacheWarmupSettings().retrievalEnabled).toBe(true)
    expect(resolveCacheWarmupSettings({ cacheWarmupRetrieval: true }).retrievalEnabled).toBe(true)
    expect(resolveCacheWarmupSettings({ cacheWarmupRetrieval: false }).retrievalEnabled).toBe(false)
    expect(resolveCacheWarmupSettings({ cacheWarmupRetrieval: { get: () => false } }).retrievalEnabled).toBe(false)
  })
})

describe('navigation intent', () => {
  it('accepts explicit navigation from events or snapshotEvents', () => {
    expect(cacheWarmupNavigationIntentOf(agentWith('请定位并列出相关函数'))).toBe(true)
    expect(cacheWarmupNavigationIntentOf(agentWith('find the relevant symbols', true))).toBe(true)
    expect(cacheWarmupNavigationIntentOf(agentWith('请定位相关函数<system-reminder>Run tests and update files</system-reminder>'))).toBe(true)
    expect(cacheWarmupNavigationIntentOf(agentWith('请定位相关函数\nCurrent runtime context. Run test and update tooling.'))).toBe(true)
  })

  it('rejects editing, review, verification, and mixed intent', () => {
    expect(cacheWarmupNavigationIntentOf(agentWith('查找并修复这个函数'))).toBe(false)
    expect(cacheWarmupNavigationIntentOf(agentWith('review all matching files'))).toBe(false)
    expect(cacheWarmupNavigationIntentOf(agentWith('请解释这个项目'))).toBe(false)
  })

  it('skips reminder-only user events and uses the latest real request', () => {
    const session = {
      events: [
        { type: 'user/message', data: { text: '请使用 read 并列出函数大纲' } },
        { type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder>Run tests and update files</system-reminder>' }] } },
      ],
    }
    expect(cacheWarmupNavigationIntentOf({ session })).toBe(true)
  })

  it('uses only the latest user message and fails closed without events', () => {
    const session = {
      events: [
        { type: 'user/message', data: { text: 'list files' } },
        { type: 'user/message', data: { text: 'implement the change' } },
      ],
    }
    expect(cacheWarmupNavigationIntentOf({ session })).toBe(false)
    expect(cacheWarmupNavigationIntentOf({})).toBe(false)
    expect(cacheWarmupNavigationIntentOf({ session: { snapshotEvents: () => { throw new Error('closed') } } })).toBe(false)
  })
})
