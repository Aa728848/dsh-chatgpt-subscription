import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ContentBlock, GenerateOptions, Message } from '../../../src/host/common/llm-compat.ts'
import { NO_RESOLVED_IMAGES } from '../../../src/host/common/request-images.ts'
import { resolveClaudeApiModel } from '../../../src/host/providers/claude-api/model-catalog.ts'
import { defaultClaudeApiSettings } from '../../../src/host/providers/claude-api/token-store.ts'
import { buildClaudeApiRequest, deriveClaudeApiBetas, type ClaudeApiRequestContext } from '../../../src/host/providers/claude-api/mapper.ts'
import {
  buildClaudeApiCompactionRequest,
  extractCheckpointSummary,
  isClaudeApiCompactionBlockInvalid,
  isClaudeApiCompactionRequest,
  isClaudeApiCompactionUnsupported,
  stripClaudeApiCompactionDirective,
} from '../../../src/host/providers/claude-api/compaction.ts'
import {
  CLAUDE_API_COMPACTION_MAX_ENTRIES,
  ClaudeApiCompactionStore,
  compactionBlockKey,
  parseClaudeApiCompactionBlocks,
  serializeClaudeApiCompactionBlocks,
  type StoredBlock,
} from '../../../src/host/providers/claude-api/compaction-store.ts'
import { COMPACTION_INSTRUCTION, SHIPPED_INSTRUCTION_OPENING } from '../../../src/host/infra/hub/compaction-prompt.ts'
import { CLAUDE_API_BETA_COMPACT } from '../../../src/host/providers/claude-api/types.ts'
import { TEST_FIRST_PARTY_CONTEXT } from './claude-api-fixtures.ts'

function msg(role: Message['role'], content: ContentBlock[], source?: Message['source']): Message {
  return { role, content, ...(source !== undefined ? { source } : {}) }
}
function userText(text: string, source?: Message['source']): Message {
  return msg('user', [{ type: 'text', text }], source)
}
function options(messages: Message[], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'claude-api', model: 'claude-fable-5-2', messages, ...extra }
}
function contextFor(extra: Partial<ClaudeApiRequestContext> = {}): ClaudeApiRequestContext {
  return { entry: resolveClaudeApiModel('claude-fable-5-2'), settings: defaultClaudeApiSettings(), version: '2.1.330', deviceId: 'a'.repeat(64), sessionUuid: '11111111-2222-4333-8444-555555555555', firstParty: TEST_FIRST_PARTY_CONTEXT, ...extra }
}
const tool = { name: 'Bash', description: 'Bash tool', parameters: { type: 'object', properties: {} } }
const SCOPE = 'f'.repeat(64)

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})
async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-api-compaction-'))
  dirs.push(dir)
  return path.join(dir, 'blocks.json')
}

describe('claude-api compaction request', () => {
  it('detects the compaction purpose', () => {
    expect(isClaudeApiCompactionRequest(options([], { purpose: 'compaction' }))).toBe(true)
    expect(isClaudeApiCompactionRequest(options([]))).toBe(false)
    expect(isClaudeApiCompactionRequest(options([], { purpose: 'other' }))).toBe(false)
  })

  it('strips the trailing directive message, shipped or replacement', () => {
    const shipped = options([userText('task'), userText(SHIPPED_INSTRUCTION_OPENING + '\nrest of the shipped directive')])
    const stripped = stripClaudeApiCompactionDirective(shipped)
    expect(stripped?.messages).toHaveLength(1)
    expect(shipped.messages).toHaveLength(2)
    const replacement = options([userText('task'), userText(COMPACTION_INSTRUCTION)])
    expect(stripClaudeApiCompactionDirective(replacement)?.messages).toHaveLength(1)
    expect(stripClaudeApiCompactionDirective(options([userText('task'), userText('plain question')]))).toBeNull()
    expect(stripClaudeApiCompactionDirective(options([userText('task'), msg('assistant', [{ type: 'text', text: COMPACTION_INSTRUCTION }])]))).toBeNull()
  })

  it('builds system and tools byte-identical to the main turn, then adjusts the compaction fields', () => {
    const history = [userText('task'), msg('assistant', [{ type: 'text', text: 'work' }])]
    const opts = options([...history, userText(COMPACTION_INSTRUCTION)], { purpose: 'compaction', system: 'prompt', tools: [tool], stop: ['STOP'], maxTokens: 4096 })
    const comp = buildClaudeApiCompactionRequest(opts, NO_RESOLVED_IMAGES, contextFor())
    const main = buildClaudeApiRequest(options(history, { system: 'prompt', tools: [tool], stop: ['STOP'], maxTokens: 4096 }), NO_RESOLVED_IMAGES, contextFor())
    expect(comp.system).toEqual(main.system)
    expect(comp.tools).toEqual(main.tools)
    expect(comp.thinking).toEqual(main.thinking)
    expect(comp.metadata).toEqual(main.metadata)
    expect(comp.context_management).toBeUndefined()
    expect(comp.stop_sequences).toBeUndefined()
    expect(comp.tool_choice).toBeUndefined()
    expect(comp.response_format).toBeUndefined()
    expect(comp.compaction).toEqual({ type: 'summarize', instructions: COMPACTION_INSTRUCTION })
    expect(comp.max_tokens as number).toBeGreaterThanOrEqual(8192)
    expect(JSON.stringify(comp.messages)).not.toContain('handoff summary')
    expect(deriveClaudeApiBetas(comp, contextFor().entry)).toContain(CLAUDE_API_BETA_COMPACT)
  })

  it('recognizes only real not-supported signals as unsupported', () => {
    const official = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'compaction: Extra inputs are not permitted', details: { error_code: 'invalid_request' } }, request_id: 'r' })
    expect(isClaudeApiCompactionUnsupported(400, official)).toBe(true)
    const gateway = JSON.stringify({ error: { message: 'unsupported beta: compact-2026-09-04', type: 'invalid_request_error' }, type: 'error' })
    expect(isClaudeApiCompactionUnsupported(400, gateway)).toBe(true)
    const betaUnexpected = JSON.stringify({ error: { message: 'Unexpected value(s) `compact-2026-09-04` for the `anthropic-beta` header' } })
    expect(isClaudeApiCompactionUnsupported(400, betaUnexpected)).toBe(true)
    expect(isClaudeApiCompactionUnsupported(400, JSON.stringify({ error: { message: 'this model does not support compaction' } }))).toBe(true)
    const bare = JSON.stringify({ code: 'compaction_unsupported', message: 'this endpoint cannot compact' })
    expect(isClaudeApiCompactionUnsupported(400, bare)).toBe(true)
    expect(isClaudeApiCompactionUnsupported(400, 'compaction parameter is not supported here')).toBe(true)
    // Block-validity errors are stale-block problems, NOT a missing capability.
    expect(isClaudeApiCompactionUnsupported(400, JSON.stringify({ error: { message: 'compaction block content does not match its signature' } }))).toBe(false)
    expect(isClaudeApiCompactionUnsupported(400, JSON.stringify({ code: 'compaction_block_misplaced', message: 'the compaction block must be the first message' }))).toBe(false)
    expect(isClaudeApiCompactionUnsupported(400, JSON.stringify({ error: { message: 'compaction block signature mismatch' } }))).toBe(false)
    expect(isClaudeApiCompactionUnsupported(400, JSON.stringify({ error: { message: 'compaction and context_management cannot be used in the same request' } }))).toBe(false)
    expect(isClaudeApiCompactionUnsupported(400, JSON.stringify({ code: 'quota_exhausted', message: 'no credit left' }))).toBe(false)
    expect(isClaudeApiCompactionUnsupported(400, JSON.stringify({ error: { message: 'temperature: not supported', type: 'invalid_request_error' } }))).toBe(false)
    expect(isClaudeApiCompactionUnsupported(500, official)).toBe(false)
  })

  it('recognizes block-validity errors with the second predicate', () => {
    expect(isClaudeApiCompactionBlockInvalid(400, JSON.stringify({ error: { message: 'compaction block content does not match its signature' } }))).toBe(true)
    expect(isClaudeApiCompactionBlockInvalid(400, JSON.stringify({ code: 'compaction_block_misplaced', message: 'misplaced' }))).toBe(true)
    expect(isClaudeApiCompactionBlockInvalid(400, 'compaction block signature mismatch')).toBe(true)
    expect(isClaudeApiCompactionBlockInvalid(400, JSON.stringify({ error: { message: 'compaction: Extra inputs are not permitted' } }))).toBe(false)
    expect(isClaudeApiCompactionBlockInvalid(400, JSON.stringify({ error: { message: 'compaction and context_management cannot be used in the same request' } }))).toBe(false)
    expect(isClaudeApiCompactionBlockInvalid(400, JSON.stringify({ error: { message: 'this model does not support compaction' } }))).toBe(false)
    expect(isClaudeApiCompactionBlockInvalid(500, 'compaction block signature mismatch')).toBe(false)
  })

  it('extracts the trimmed summary between the checkpoint tags', () => {
    expect(extractCheckpointSummary('preamble\n\n<compacted-summary>\n summary body \n</compacted-summary>')).toBe('summary body')
    expect(extractCheckpointSummary('no tags here')).toBeNull()
    expect(extractCheckpointSummary('<compacted-summary></compacted-summary>')).toBe('')
  })
})

describe('claude-api compaction store', () => {
  it('round-trips through the production writer and finds the block by trimmed summary', async () => {
    const file = await tmpFile()
    let current = 1_000_000
    const store = new ClaudeApiCompactionStore(file, () => current)
    await store.remember({ content: '  summary body  ', signature: 'sig', toolChanges: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'Bash' } }], model: 'claude-fable-5-2', scope: SCOPE })
    const raw = await fs.readFile(file, 'utf8')
    const parsed = parseClaudeApiCompactionBlocks(JSON.parse(raw) as unknown)
    const key = compactionBlockKey('summary body')
    expect(parsed[key]).toEqual({ content: '  summary body  ', signature: 'sig', toolChanges: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'Bash' } }], model: 'claude-fable-5-2', createdAt: 1_000_000, scope: SCOPE })
    const reopened = new ClaudeApiCompactionStore(file, () => current)
    await reopened.warm()
    expect(reopened.lookup('summary body', SCOPE)?.signature).toBe('sig')
    expect(reopened.lookup('  summary body  ', SCOPE)?.signature).toBe('sig')
    expect(reopened.lookup('summary body edited', SCOPE)).toBeUndefined()
    expect(reopened.lookup('unknown summary', SCOPE)).toBeUndefined()
    expect(reopened.path()).toBe(file)
  })

  it('serialize and parse are inverses', () => {
    const table: Record<string, StoredBlock> = {
      [compactionBlockKey('one')]: { content: 'one', signature: 's1', model: 'm', createdAt: 1, scope: SCOPE },
      [compactionBlockKey('two')]: { content: 'two', signature: 's2', toolChanges: { a: [1, 2] }, model: 'm', createdAt: 2, scope: SCOPE },
    }
    expect(parseClaudeApiCompactionBlocks(JSON.parse(serializeClaudeApiCompactionBlocks(table)) as unknown)).toEqual(table)
  })

  it('forgets a block and persists the removal', async () => {
    const file = await tmpFile()
    const store = new ClaudeApiCompactionStore(file, () => 1)
    await store.remember({ content: 'gone', signature: 's', model: 'm', scope: SCOPE })
    await store.forget('gone', SCOPE)
    expect(store.lookup('gone', SCOPE)).toBeUndefined()
    const reopened = new ClaudeApiCompactionStore(file, () => 1)
    await reopened.warm()
    expect(reopened.lookup('gone', SCOPE)).toBeUndefined()
  })

  it('caps the table at 200 entries, evicting the oldest', async () => {
    const file = await tmpFile()
    let tick = 0
    const store = new ClaudeApiCompactionStore(file, () => 1_000_000 + (tick += 1))
    for (let index = 0; index < CLAUDE_API_COMPACTION_MAX_ENTRIES + 5; index += 1) {
      await store.remember({ content: 's' + index, signature: 'sig', model: 'm', scope: SCOPE })
    }
    const parsed = parseClaudeApiCompactionBlocks(JSON.parse(await fs.readFile(file, 'utf8')) as unknown)
    expect(Object.keys(parsed)).toHaveLength(CLAUDE_API_COMPACTION_MAX_ENTRIES)
    expect(parsed[compactionBlockKey('s0')]).toBeUndefined()
    expect(parsed[compactionBlockKey('s4')]).toBeUndefined()
    expect(parsed[compactionBlockKey('s5')]).toBeDefined()
    expect(parsed[compactionBlockKey('s204')]).toBeDefined()
  })

  it('drops entries older than 30 days', async () => {
    const file = await tmpFile()
    let current = 1_000_000
    const store = new ClaudeApiCompactionStore(file, () => current)
    await store.remember({ content: 'old', signature: 's', model: 'm', scope: SCOPE })
    current += 31 * 24 * 60 * 60 * 1000
    await store.remember({ content: 'new', signature: 's', model: 'm', scope: SCOPE })
    expect(store.lookup('old', SCOPE)).toBeUndefined()
    expect(store.lookup('new', SCOPE)).toBeDefined()
    const reopened = new ClaudeApiCompactionStore(file, () => current)
    await reopened.warm()
    expect(reopened.lookup('old', SCOPE)).toBeUndefined()
  })

  it('replaces a leading checkpoint from the store and falls back to text when absent', async () => {
    const file = await tmpFile()
    const store = new ClaudeApiCompactionStore(file, () => 1)
    await store.remember({ content: 'summary body', signature: 'sig', model: 'claude-haiku-5-5', scope: SCOPE })
    const checkpoint = userText('preamble\n\n<compacted-summary>summary body</compacted-summary>', { kind: 'compact-checkpoint' })
    // Found even though it was stored under another model: the scope is credential+endpoint, not model.
    const found = buildClaudeApiRequest(options([checkpoint, userText('next')]), NO_RESOLVED_IMAGES, contextFor({ compactionBlocks: { lookup: summary => store.lookup(summary, SCOPE) } }))
    expect((found.messages as Array<Record<string, unknown>>)[0]).toEqual({ role: 'assistant', content: [{ type: 'compaction', content: 'summary body', signature: 'sig' }] })
    expect(deriveClaudeApiBetas(found, contextFor().entry)).toContain(CLAUDE_API_BETA_COMPACT)
    const empty = new ClaudeApiCompactionStore(await tmpFile(), () => 1)
    await empty.warm()
    const missed = buildClaudeApiRequest(options([checkpoint, userText('next')]), NO_RESOLVED_IMAGES, contextFor({ compactionBlocks: { lookup: summary => empty.lookup(summary, SCOPE) } }))
    expect((missed.messages as Array<Record<string, unknown>>)[0]?.role).toBe('user')
    expect(deriveClaudeApiBetas(missed, contextFor().entry)).not.toContain(CLAUDE_API_BETA_COMPACT)
  })

  it('survives a damaged file and drops entries whose key does not match the content', async () => {
    const file = await tmpFile()
    await fs.writeFile(file, '{invalid json', 'utf8')
    const store = new ClaudeApiCompactionStore(file, () => 1)
    await store.warm()
    expect(store.lookup('anything', SCOPE)).toBeUndefined()
    const tampered = { version: 1, blocks: { ['0'.repeat(64)]: { content: 'x', signature: 's', model: 'm', createdAt: 1 } } }
    expect(parseClaudeApiCompactionBlocks(tampered)).toEqual({})
    expect(parseClaudeApiCompactionBlocks(null)).toEqual({})
  })

  it('returns a block only for its own scope and forgets only that scope', async () => {
    const file = await tmpFile()
    const store = new ClaudeApiCompactionStore(file, () => 1)
    await store.remember({ content: 'scoped', signature: 's', model: 'm', scope: 'scope-a' })
    expect(store.lookup('scoped', 'scope-a')?.signature).toBe('s')
    expect(store.lookup('scoped', 'scope-b')).toBeUndefined()
    await store.forget('scoped', 'scope-b')
    expect(store.lookup('scoped', 'scope-a')).toBeDefined()
    await store.forget('scoped', 'scope-a')
    expect(store.lookup('scoped', 'scope-a')).toBeUndefined()
    const reopened = new ClaudeApiCompactionStore(file, () => 1)
    await reopened.warm()
    expect(reopened.lookup('scoped', 'scope-a')).toBeUndefined()
  })

  it('never returns a legacy entry without a scope', async () => {
    const file = await tmpFile()
    const legacy = { version: 1, blocks: { [compactionBlockKey('old')]: { content: 'old', signature: 's', model: 'm', createdAt: 1 } } }
    await fs.writeFile(file, JSON.stringify(legacy), 'utf8')
    const store = new ClaudeApiCompactionStore(file, () => 1)
    await store.warm()
    expect(store.lookup('old', 'any-scope')).toBeUndefined()
    expect(parseClaudeApiCompactionBlocks(legacy)[compactionBlockKey('old')]?.content).toBe('old')
  })
})
