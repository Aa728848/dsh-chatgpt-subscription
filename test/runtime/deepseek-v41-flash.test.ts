import { describe, expect, it, vi } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  DEEPSEEK_V41_FLASH_ANCHOR_PREFIX,
  DEEPSEEK_V41_FLASH_ANCHOR_SOURCE_KIND,
  DEEPSEEK_V41_FLASH_DISCIPLINE_ORDER,
  DEEPSEEK_V41_FLASH_DISCIPLINE_SECTION,
  DEEPSEEK_V41_FLASH_DISCIPLINE_TEXT,
  DEEPSEEK_V41_FLASH_RUNAWAY_SOURCE_KIND,
  OBSERVATION_HEADER_PREFIX,
  installDeepSeekV41FlashDiscipline,
  installDeepSeekV41FlashObservationTagger,
  installDeepSeekV41FlashOptimizations,
  installDeepSeekV41FlashStateAnchor,
  isDeepSeekV41Flash,
  renderStateAnchorText,
  resolveDeepSeekV41FlashOptimizationEnabled,
} from '../../src/host/runtime/deepseek-v41-flash/index.ts'
import { shouldSkipPruningForSession } from '../../src/entries/tool-result-pruner.ts'
import { installToolResultPrunerGuard } from '../../src/host/runtime/guards/tool-result-pruner-guard.ts'
import { installPtcSdkCacheGuard, PTC_SDK_SECTION_NAME } from '../../src/host/runtime/guards/ptc-sdk-cache-guard.ts'
import { installTimelineCacheGuard, TIMELINE_SECTION } from '../../src/host/runtime/guards/timeline-cache-guard.ts'
import { installCompactionPolicyGuard } from '../../src/host/runtime/guards/compaction-policy-guard.ts'
import { cacheWarmupNavigationIntentOf } from '../../src/host/runtime/cache-warmup/retrieval-intent.ts'
import { createCacheWarmupResultTool } from '../../src/host/runtime/cache-warmup/result-tool.ts'

type Listener = (...args: unknown[]) => unknown

function createEventHost() {
  const listeners = new Map<string, Listener[]>()
  const warnings: string[] = []
  const agents = new Map<string, unknown>()
  const ctx = {
    on(event: string, fn: Listener) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {
        const cur = listeners.get(event)
        if (!cur) return
        const idx = cur.indexOf(fn)
        if (idx >= 0) cur.splice(idx, 1)
      }
    },
    get(name: string) {
      if (name === 'agents') return agents
      return undefined
    },
    logger: {
      warn(message: string) {
        warnings.push(message)
      },
    },
  }
  const emitWaterfall = async <T>(event: string, args: unknown[], terminal: () => T | Promise<T>): Promise<T> => {
    const list = [...(listeners.get(event) ?? [])]
    let idx = 0
    const next = (): T | Promise<T> => {
      if (idx >= list.length) return terminal()
      const fn = list[idx++]!
      return fn(...args, next) as T | Promise<T>
    }
    return await next()
  }
  const emitStream = (request: Record<string, unknown>, chunks: Array<{ type: string; text?: string }>) => {
    const list = [...(listeners.get(eventNameStream) ?? [])]
    let idx = 0
    const next = (): AsyncIterable<{ type: string; text?: string }> => {
      if (idx >= list.length) {
        return (async function* () {
          for (const chunk of chunks) yield chunk
        })()
      }
      const fn = list[idx++]!
      return fn(request, next) as AsyncIterable<{ type: string; text?: string }>
    }
    return next()
  }
  const eventNameStream = 'llm/stream'
  return { ctx, listeners, warnings, agents, emitWaterfall, emitStream }
}

function makeAgent(provider: string, model: string, sessionId = 'sess-1', reasoningEffort?: string) {
  return {
    id: sessionId,
    session: {
      header: { id: sessionId },
      requestHeader: () => ({
        config: {
          provider,
          model,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        },
      }),
    },
    model: {
      current: () => ({
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      }),
    },
    options: { provider, model },
  }
}

describe('DeepSeek V4.1 Flash exact model matching & isolation', () => {
  it('matches all DeepSeek V4.1 Flash variants and official deepseek-flash alias only', () => {
    const positive: Array<[string, string | undefined]> = [
      ['deepseek-v4.1-flash', undefined],
      ['deepseek-v4.1-flash-1017', 'cline-pass'],
      ['cline-pass/deepseek-v4.1-flash-1017', 'cline-pass'],
      ['deepseek-v4.1-flash-eco', 'opendesign'],
      ['deepseek/deepseek-v4.1-flash', 'command-code'],
      ['deepseek/deepseek-v4.1-flash-fast', 'command-code'],
      ['deepseek-ai/DeepSeek-V4.1-Flash-1017', 'ollama'],
      ['deepseek-v4p1-flash-1017', 'relayone'],
      ['public_model_deepseek_v4_1_flash', 'opendesign'],
      ['deepseek-flash', 'deepseek-official'],
      ['deepseek-flash', 'deepseek-account'],
      ['deepseek/deepseek-flash', 'deepseek'],
    ]
    for (const [model, provider] of positive) {
      expect(isDeepSeekV41Flash(model, provider), `${provider ?? '*'}:${model}`).toBe(true)
    }

    const negative: Array<[string, string | undefined]> = [
      ['deepseek-v4-pro', 'deepseek-official'],
      ['deepseek-v4-pro', 'deepseek-account'],
      ['deepseek-v4-flash', 'opendesign'],
      ['deepseek-v4-flash-vision-exp', 'opendesign'],
      ['cline-pass/deepseek-v4-flash', 'cline-pass'],
      ['DeepSeek-Flash', 'qoder'],
      ['deepseek-flash', 'opendesign'],
      ['deepseek-flash', undefined],
      ['deepseek-chat', 'deepseek-official'],
      ['deepseek-reasoner', 'deepseek-official'],
      ['deepseek-r1', 'ollama'],
      ['gpt-6.1-sol', 'opendesign'],
      ['claude-opus-5', 'claude-api'],
      ['k3.1-pro', 'kimi-code'],
      ['MiniMax-M2.5', 'minimax-code'],
      ['gpt-5.4', 'codex-chatgpt'],
    ]
    for (const [model, provider] of negative) {
      expect(isDeepSeekV41Flash(model, provider), `${provider ?? '*'}:${model}`).toBe(false)
    }
  })

  it('resolves volatile and plain config switches with default true', () => {
    expect(resolveDeepSeekV41FlashOptimizationEnabled(undefined)).toBe(true)
    expect(resolveDeepSeekV41FlashOptimizationEnabled({})).toBe(true)
    expect(resolveDeepSeekV41FlashOptimizationEnabled({ deepseekV41FlashOptimization: false })).toBe(false)
    let live = true
    const cfg = { deepseekV41FlashOptimization: { get: () => live } }
    expect(resolveDeepSeekV41FlashOptimizationEnabled(cfg)).toBe(true)
    live = false
    expect(resolveDeepSeekV41FlashOptimizationEnabled(cfg)).toBe(false)
  })
})

describe('DeepSeek V4.1 Flash discipline section', () => {
  it('injects static constant discipline only for V4.1 Flash and leaves other models untouched by reference', async () => {
    const { ctx, emitWaterfall } = createEventHost()
    let enabled = true
    const dispose = installDeepSeekV41FlashDiscipline(ctx, { enabled: () => enabled })

    const base = {
      sections: [
        { name: 'persona', text: 'base persona' },
        { name: 'plugin:cache-warmup', text: 'warmup guidance' },
        { name: 'tools:sdk', text: 'sdk declarations' },
      ],
    }

    // 1. 官方 deepseek-flash 命中，始终追加到系统提示词最末尾（在 tools:sdk 之后）且 interpolate: false
    const flashAgent = makeAgent('deepseek-official', 'deepseek-flash')
    const out1 = await emitWaterfall('system-prompt/assemble', [base, { scope: flashAgent }], () => base)
    const out2 = await emitWaterfall('system-prompt/assemble', [base, { scope: flashAgent }], () => base)
    expect(out1.sections.map(s => s.name)).toEqual([
      'persona',
      'plugin:cache-warmup',
      'tools:sdk',
      DEEPSEEK_V41_FLASH_DISCIPLINE_SECTION,
    ])
    expect(out1.sections[3]).toEqual({
      name: DEEPSEEK_V41_FLASH_DISCIPLINE_SECTION,
      order: DEEPSEEK_V41_FLASH_DISCIPLINE_ORDER,
      text: DEEPSEEK_V41_FLASH_DISCIPLINE_TEXT,
      interpolate: false,
    })
    expect(Number.isFinite((out1.sections[3] as { order?: unknown })?.order)).toBe(true)
    // 前缀稳定性：连续装配结果逐字节一致
    expect(out2.sections[3]?.text).toBe(out1.sections[3]?.text)
    // 包含面向人类的输出可读性指导，且示范清爽排版（不使用密集加粗列表腔，避免模型格式镜像）
    expect(DEEPSEEK_V41_FLASH_DISCIPLINE_TEXT).toContain('### Readable final responses')
    expect(DEEPSEEK_V41_FLASH_DISCIPLINE_TEXT).toContain('without reducing internal reasoning depth')
    expect(DEEPSEEK_V41_FLASH_DISCIPLINE_TEXT).not.toMatch(/^- \*\*[^*]+\*\*:/m)

    // 2. 同线路非 V4.1 Flash 模型（deepseek-v4-pro）与其他线路模型：零改动，原引用返回
    for (const other of [
      makeAgent('deepseek-official', 'deepseek-v4-pro'),
      makeAgent('opendesign', 'gpt-6.1-sol'),
      makeAgent('qoder', 'DeepSeek-Flash'),
      makeAgent('kimi-code', 'k3.1-pro'),
    ]) {
      const untouched = await emitWaterfall('system-prompt/assemble', [base, { scope: other }], () => base)
      expect(untouched).toBe(base)
    }

    // 3. 热关闭后立即旁路
    enabled = false
    const disabledOut = await emitWaterfall('system-prompt/assemble', [base, { scope: flashAgent }], () => base)
    expect(disabledOut).toBe(base)

    dispose()
  })
})

describe('DeepSeek V4.1 Flash Append-Only SWA-128 state anchor & effort drift guard', () => {
  it('appends compact anchors on step interval, context watermark, and consecutive tool errors — never for other models', async () => {
    const { ctx, warnings, emitWaterfall } = createEventHost()
    let mockTokens = 50_000
    const dispose = installDeepSeekV41FlashStateAnchor(ctx, {
      stepInterval: 3,
      contextWatermarks: [180_000, 350_000],
      consecutiveErrorThreshold: 2,
      estimateContextTokens: () => mockTokens,
    })

    const flashAgent = makeAgent('opendesign', 'deepseek-v4.1-flash-1017', 'sess-flash', 'high')
    const baseUserMsg = { role: 'user', content: [{ type: 'text', text: 'Fix the race condition in stream parser without breaking old harnesses.' }] }

    // Turn start: captures immutable goal, does not append anchor
    const d0 = await emitWaterfall(
      'agent/pre-step',
      [{ agent: flashAgent, messages: [baseUserMsg] }],
      () => ({ kind: 'enter', messages: [baseUserMsg] }),
    )
    expect(d0.messages).toHaveLength(1)

    // Record an active file via root tool execution
    await emitWaterfall(
      'tools/post-execute',
      [
        { name: 'read', arguments: { path: 'src/host/stream-parser.ts' }, agent: flashAgent },
        { isError: false, content: [] },
      ],
      () => ({ kind: 'accept' }),
    )

    // Steps 1 & 2: no anchor yet
    const d1 = await emitWaterfall('agent/pre-step', [{ agent: flashAgent, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    const d2 = await emitWaterfall('agent/pre-step', [{ agent: flashAgent, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    expect(d1.messages).toHaveLength(0)
    expect(d2.messages).toHaveLength(0)

    // Step 3: periodic anchor fires
    const d3 = await emitWaterfall('agent/pre-step', [{ agent: flashAgent, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    expect(d3.messages).toHaveLength(1)
    const anchor3 = d3.messages[0] as { content: Array<{ text: string }>; source: { kind: string; form: string } }
    expect(anchor3.source.kind).toBe(DEEPSEEK_V41_FLASH_ANCHOR_SOURCE_KIND)
    expect(anchor3.source.form).toBe('notice')
    expect(anchor3.content[0]!.text).toContain(DEEPSEEK_V41_FLASH_ANCHOR_PREFIX)
    expect(anchor3.content[0]!.text).toContain('trigger=periodic')
    expect(anchor3.content[0]!.text).toContain('Fix the race condition')
    expect(anchor3.content[0]!.text).toContain('src/host/stream-parser.ts')
    // Must stay compact so it sits cleanly inside SWA n_win = 128 tokens
    expect(anchor3.content[0]!.text.length).toBeLessThan(480)

    // Context crosses 180k watermark -> watermark anchor fires immediately
    mockTokens = 210_000
    const d4 = await emitWaterfall('agent/pre-step', [{ agent: flashAgent, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    expect(d4.messages).toHaveLength(1)
    expect((d4.messages[0] as { content: Array<{ text: string }> }).content[0]!.text).toContain('trigger=watermark')

    // Consecutive tool errors >= 2 -> anti-loop anchor fires
    for (let i = 0; i < 2; i++) {
      await emitWaterfall(
        'tools/post-execute',
        [
          { name: 'bash', arguments: { command: 'npm test' }, agent: flashAgent },
          { isError: true, content: [{ type: 'text', text: 'failed' }] },
        ],
        () => ({ kind: 'accept' }),
      )
    }
    const d5 = await emitWaterfall('agent/pre-step', [{ agent: flashAgent, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    expect(d5.messages).toHaveLength(1)
    expect((d5.messages[0] as { content: Array<{ text: string }> }).content[0]!.text).toContain('trigger=consecutive-errors')

    // Changing reasoningEffort mid-session above 32k tokens logs diagnostic warning without blocking
    const switchedAgent = makeAgent('opendesign', 'deepseek-v4.1-flash-1017', 'sess-flash', 'low')
    await emitWaterfall('agent/pre-step', [{ agent: switchedAgent, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    expect(warnings.some(w => w.includes('reasoningEffort changed (high->low)'))).toBe(true)

    // Non-V4.1 Flash models: zero anchors, zero effort warnings
    const warnCountBefore = warnings.length
    const otherAgent = makeAgent('deepseek-official', 'deepseek-v4-pro', 'sess-pro', 'high')
    await emitWaterfall('agent/pre-step', [{ agent: otherAgent, messages: [baseUserMsg] }], () => ({ kind: 'enter', messages: [baseUserMsg] }))
    for (let i = 0; i < 5; i++) {
      const decision = { kind: 'enter', messages: [] as unknown[] }
      const out = await emitWaterfall(
        'agent/pre-step',
        [{ agent: makeAgent('deepseek-official', 'deepseek-v4-pro', 'sess-pro', i === 4 ? 'low' : 'high'), messages: [] }],
        () => decision,
      )
      expect(out).toBe(decision)
    }
    expect(warnings.length).toBe(warnCountBefore)

    dispose()
  })

  it('merges same-turn steering and retains only the latest three user turns', async () => {
    const { ctx, emitWaterfall } = createEventHost()
    const dispose = installDeepSeekV41FlashStateAnchor(ctx, {
      stepInterval: 1,
      contextWatermarks: [],
      estimateContextTokens: () => 0,
    })
    const flashAgent = makeAgent('opendesign', 'deepseek-v4.1-flash-1017', 'sess-goal-history', 'high')
    const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
    const run = async (turn: number, messages: unknown[]) => await emitWaterfall(
      'agent/pre-step',
      [{ agent: flashAgent, turn, messages }],
      () => ({ kind: 'enter', messages }),
    ) as { messages: Array<{ content: Array<{ text: string }> }> }
    const anchorText = (result: { messages: Array<{ content: Array<{ text: string }> }> }) => result.messages[0]?.content[0]?.text ?? ''

    await run(1, [user('Fix stream parser races')])
    await run(1, [user('Keep legacy adapters working')])
    await run(2, [user('Add regression coverage')])
    await run(3, [user('Update migration notes')])
    const thirdTurn = await run(3, [])
    const thirdTurnText = anchorText(thirdTurn)
    expect(thirdTurnText).toContain('GOAL: Update migration notes\n')
    expect(thirdTurnText).toContain('EARLIER (context only): Fix stream parser races | Keep legacy adapters working | Add regression coverage')
    expect(thirdTurnText).toContain('EARLIER is context only and loses on any conflict')
    expect(thirdTurnText).not.toContain('Stay locked')
    expect(thirdTurnText.length).toBeLessThan(480)

    await run(4, [
      user('Refresh compatibility matrix'),
      { role: 'user', content: 'ignored notice', source: { kind: 'runtime-context', form: 'notice' } },
    ])
    const fourthTurn = await run(4, [])
    const fourthTurnText = anchorText(fourthTurn)
    expect(fourthTurnText).toContain('GOAL: Refresh compatibility matrix\n')
    expect(fourthTurnText).toContain('EARLIER (context only): Add regression coverage | Update migration notes')
    expect(fourthTurnText).not.toContain('Fix stream parser races')
    expect(fourthTurnText).not.toContain('Keep legacy adapters working')
    expect(fourthTurnText).not.toContain('ignored notice')

    dispose()
  })

  it('lets the latest turn override a contradicting earlier one, and drops EARLIER once tasks exist', async () => {
    const { ctx, emitWaterfall } = createEventHost()
    const dispose = installDeepSeekV41FlashStateAnchor(ctx, { stepInterval: 1, contextWatermarks: [], estimateContextTokens: () => 0 })
    const flashAgent = makeAgent('opendesign', 'deepseek-v4.1-flash-1017', 'sess-override', 'high')
    const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
    const run = async (turn: number, messages: unknown[]) => await emitWaterfall(
      'agent/pre-step',
      [{ agent: flashAgent, turn, messages }],
      () => ({ kind: 'enter', messages }),
    ) as { messages: Array<{ content: Array<{ text: string }> }> }
    await run(1, [user('Refactor the parser with approach A')])
    await run(2, [user('Do not use approach A; switch to approach B')])
    const text = (await run(2, [])).messages[0]!.content[0]!.text
    expect(text).toContain('GOAL: Do not use approach A; switch to approach B\n')
    expect(text).toContain('EARLIER (context only): Refactor the parser with approach A')
    expect(text).toContain('loses on any conflict')

    await emitWaterfall(
      'tools/post-execute',
      [{ name: 'todo_write', agent: flashAgent, arguments: { todos: [{ content: 'Port parser to approach B', status: 'in_progress' }] } }, { isError: false, content: [] }],
      () => ({ kind: 'accept' }),
    )
    const withTasks = (await run(2, [])).messages[0]!.content[0]!.text
    expect(withTasks).toContain('TASKS: 0/1 done | NOW: Port parser to approach B')
    expect(withTasks).not.toContain('EARLIER')
    expect(withTasks).not.toContain('approach A\n')
    dispose()
  })

  it('re-anchors right after compaction with task progress, including nested todo_write calls', async () => {
    const { ctx, listeners, emitWaterfall } = createEventHost()
    const dispose = installDeepSeekV41FlashStateAnchor(ctx, { stepInterval: 100, contextWatermarks: [], estimateContextTokens: () => 0 })
    const flashAgent = makeAgent('opendesign', 'deepseek-v4.1-flash-1017', 'sess-tasks', 'high')
    const step = async () => await emitWaterfall('agent/pre-step', [{ agent: flashAgent, messages: [] }], () => ({ kind: 'enter', messages: [] as unknown[] }))
    const goal = { role: 'user', content: [{ type: 'text', text: 'Migrate settings storage' }] }
    await emitWaterfall('agent/pre-step', [{ agent: flashAgent, messages: [goal] }], () => ({ kind: 'enter', messages: [goal] }))
    await emitWaterfall(
      'tools/post-execute',
      [
        { name: 'todo_write', parent: 'code_run', agent: flashAgent, arguments: { todos: [
          { content: 'Read legacy store', status: 'completed' },
          { content: 'Write migration', status: 'in_progress' },
          { content: 'Add regression tests', status: 'pending' },
        ] } },
        { isError: false, content: [] },
      ],
      () => ({ kind: 'accept' }),
    )
    expect((await step()).messages).toHaveLength(0)

    for (const listener of listeners.get('session/event') ?? []) listener({ id: 'sess-tasks' }, { type: 'compaction/end' })
    const anchored = await step()
    const text = (anchored.messages[0] as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain('trigger=compaction')
    expect(text).toContain('GOAL: Migrate settings storage')
    expect(text).toContain('TASKS: 1/3 done | NOW: Write migration | NEXT: Add regression tests')
    expect((await step()).messages).toHaveLength(0)
    dispose()
  })

  it('keeps the whole anchor within budget, dropping files before tasks and never the alert or goal', () => {
    const text = renderStateAnchorText({
      step: 12,
      approxTokens: 400_000,
      reason: 'consecutive-errors',
      goal: 'g'.repeat(120),
      tasks: `3/9 done | NOW: ${'n'.repeat(48)} | NEXT: ${'p'.repeat(48)}`,
      activeFiles: ['src/a/'.padEnd(36, 'a'), 'src/b/'.padEnd(36, 'b'), 'src/c/'.padEnd(36, 'c'), 'src/d/'.padEnd(36, 'd')],
      consecutiveErrors: 3,
      lastErrorTool: 'bash',
    })
    expect(text.length).toBeLessThanOrEqual(640)
    expect(text).toContain(`GOAL: ${'g'.repeat(120)}`)
    expect(text).toContain('ALERT: 3 consecutive tool failures (bash)')
    expect(text).toContain('TASKS: 3/9 done')
    expect(text).toContain('RULE:')
    // 空间不足时优先保留最新的文件。
    if (text.includes('FILES:')) expect(text).toContain('src/d/')
  })

  it('anchor messages are ignored by cache-warmup navigation intent classifier', () => {
    const agent = {
      session: {
        events: [
          { type: 'user/message', data: { content: '请查找所有定义 promptCachePolicy 的文件' } },
          { type: 'user/message', data: { content: `${DEEPSEEK_V41_FLASH_ANCHOR_PREFIX} | step=10 | ctx~200k]\nGOAL: find files\nRULE: fix or edit nothing` } },
        ],
      },
    }
    expect(cacheWarmupNavigationIntentOf(agent)).toBe(true)
  })
})

describe('DeepSeek V4.1 Flash pre-write observation tagger & official runaway reminder', () => {
  it('prepends [OBS] header to large root text outputs for V4.1 Flash only, preserving nested/value calls and other models', async () => {
    const { ctx, emitWaterfall } = createEventHost()
    const dispose = installDeepSeekV41FlashObservationTagger(ctx, { minChars: 50 })

    const largeBody = 'x'.repeat(120)
    const flashAgent = makeAgent('deepseek-official', 'deepseek-flash', 'sess-obs-1')
    const exec = {
      name: 'read',
      callId: 'c1',
      rootCallId: 'c1',
      arguments: { path: 'src/host/adapter.ts' },
      agent: flashAgent,
    } as unknown as ToolExecution
    const result = {
      isError: false,
      content: [{ type: 'text', text: largeBody }] as ContentBlock[],
    } as unknown as Readonly<ToolExecutionResult>

    const out = await emitWaterfall<PostToolDecision>(
      'tools/post-execute',
      [exec, result],
      () => ({ kind: 'accept' }),
    )
    expect(out.kind).toBe('accept')
    const firstText = (out as { content?: ContentBlock[] }).content?.[0]
    expect(firstText?.type === 'text' ? firstText.text : '').toBe(
      `${OBSERVATION_HEADER_PREFIX}tool=read | target=src/host/adapter.ts | status=ok]\n${largeBody}`,
    )

    // Nested PTC sub-call must stay untouched
    const nestedExec = { ...exec, parent: { id: 'ptc-parent' } } as unknown as ToolExecution
    const nestedDecision: PostToolDecision = { kind: 'accept' }
    const nestedOut = await emitWaterfall<PostToolDecision>('tools/post-execute', [nestedExec, result], () => nestedDecision)
    expect(nestedOut).toBe(nestedDecision)

    // Structured value decision must stay untouched (mutually exclusive with content)
    const valueDecision: PostToolDecision = { kind: 'accept', value: { lines: [1, 2, 3] } }
    const valueOut = await emitWaterfall<PostToolDecision>('tools/post-execute', [exec, result], () => valueDecision)
    expect(valueOut).toBe(valueDecision)

    // Non-V4.1 Flash model (same provider, different model) must stay untouched
    const proExec = { ...exec, agent: makeAgent('deepseek-official', 'deepseek-v4-pro', 'sess-pro') } as unknown as ToolExecution
    const proDecision: PostToolDecision = { kind: 'accept' }
    const proOut = await emitWaterfall<PostToolDecision>('tools/post-execute', [proExec, result], () => proDecision)
    expect(proOut).toBe(proDecision)

    // Official V4.1 Flash repeated identical tool calls trigger gentle runaway reminder; third-party lines do not double-remind
    let reminded = false
    for (let i = 0; i < 4; i++) {
      const r = await emitWaterfall<PostToolDecision>(
        'tools/post-execute',
        [
          { name: 'bash', callId: `b${i}`, arguments: { command: 'npm test' }, agent: flashAgent } as unknown as ToolExecution,
          { isError: false, content: [{ type: 'text', text: 'short' }] } as unknown as Readonly<ToolExecutionResult>,
        ],
        () => ({ kind: 'accept' }),
      )
      if (r.additionalContexts?.some(m => (m.source as { kind?: string } | undefined)?.kind === DEEPSEEK_V41_FLASH_RUNAWAY_SOURCE_KIND)) {
        reminded = true
      }
    }
    expect(reminded).toBe(true)

    const opendesignFlash = makeAgent('opendesign', 'deepseek-v4.1-flash', 'sess-od-1')
    let opendesignReminded = false
    for (let i = 0; i < 5; i++) {
      const r = await emitWaterfall<PostToolDecision>(
        'tools/post-execute',
        [
          { name: 'bash', callId: `od${i}`, arguments: { command: 'npm test' }, agent: opendesignFlash } as unknown as ToolExecution,
          { isError: false, content: [{ type: 'text', text: 'short' }] } as unknown as Readonly<ToolExecutionResult>,
        ],
        () => ({ kind: 'accept' }),
      )
      if (r.additionalContexts?.some(m => (m.source as { kind?: string } | undefined)?.kind === DEEPSEEK_V41_FLASH_RUNAWAY_SOURCE_KIND)) {
        opendesignReminded = true
      }
    }
    expect(opendesignReminded).toBe(false)

    dispose()
  })

  it('does not reset official V4.1 Flash runaway counter on todo-reminder or runtime-context snapshot messages', async () => {
    const { ctx, emitWaterfall } = createEventHost()
    const dispose = installDeepSeekV41FlashObservationTagger(ctx)
    const officialFlash = makeAgent('deepseek-official', 'deepseek-flash', 'sess-snapshot-reset')

    const callOnce = async (i: number) => await emitWaterfall<PostToolDecision>(
      'tools/post-execute',
      [
        { name: 'bash', callId: `s${i}`, arguments: { command: 'npm test' }, agent: officialFlash } as unknown as ToolExecution,
        { isError: false, content: [{ type: 'text', text: 'short' }] } as unknown as Readonly<ToolExecutionResult>,
      ],
      () => ({ kind: 'accept' }),
    )

    // 先累计 2 次相同工具调用
    await callOnce(1)
    await callOnce(2)

    // 注入 DSH 0.2.3-alpha.3 todo-reminder（form: 'snapshot'）与 runtime-context：不应重置计数器
    const snapshotMsgs = [
      {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>\nCurrent todo list:\n1. [in_progress] "fix"\n</system-reminder>' }],
        source: { kind: 'todo-reminder', form: 'snapshot' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>\nCurrent time: 2026-11-28\n</system-reminder>' }],
        source: { kind: 'runtime-context', form: 'snapshot' },
      },
    ]
    await emitWaterfall('agent/pre-step', [{ agent: officialFlash, messages: snapshotMsgs }], () => ({ kind: 'enter', messages: snapshotMsgs }))

    // 再连续调用 2 次仍触发失控提醒（证明没有被 snapshot 重置）
    let reminded = false
    for (let i = 3; i <= 5; i++) {
      const r = await callOnce(i)
      if (r.additionalContexts?.some(m => (m.source as { kind?: string } | undefined)?.kind === DEEPSEEK_V41_FLASH_RUNAWAY_SOURCE_KIND)) {
        reminded = true
      }
    }
    expect(reminded).toBe(true)

    dispose()
  })
})

describe('DeepSeek V4.1 Flash scoped reasoning-collapse guard', () => {
  it('cuts runaway repetition on V4.1 Flash without ever touching non-V4.1 Flash streams', async () => {
    const { ctx, agents, emitStream } = createEventHost()
    const cancelled: string[] = []
    const steered: unknown[] = []
    const flashAgent = {
      ...makeAgent('deepseek-official', 'deepseek-flash', 'sess-collapse-flash'),
      cancel: () => cancelled.push('flash'),
      steer: (msg: unknown) => steered.push(msg),
    }
    const proAgent = {
      ...makeAgent('deepseek-official', 'deepseek-v4-pro', 'sess-collapse-pro'),
      cancel: () => cancelled.push('pro'),
      steer: (msg: unknown) => steered.push(msg),
    }
    agents.set('sess-collapse-flash', flashAgent)
    agents.set('sess-collapse-pro', proAgent)

    const handle = installDeepSeekV41FlashOptimizations(ctx, {
      collapseGuardOptions: { cooldownMs: 0 },
    })

    const degenerateSentence = 'Wait let me double check the exact same step again right now. '
    const chunks = Array.from({ length: 60 }, () => ({ type: 'reasoning-delta', text: degenerateSentence }))

    // V4.1 Flash (even when request.provider is omitted on older harnesses, resolved from agent registry)
    const flashReceived: unknown[] = []
    for await (const chunk of emitStream({ model: 'deepseek-flash', sessionId: 'sess-collapse-flash', signal: new AbortController().signal }, chunks)) {
      flashReceived.push(chunk)
    }
    expect(flashReceived.length).toBeLessThan(chunks.length)
    expect(cancelled).toEqual(['flash'])

    // Non-V4.1 Flash (deepseek-v4-pro) receives every chunk untouched
    const proReceived: unknown[] = []
    for await (const chunk of emitStream({ provider: 'deepseek-official', model: 'deepseek-v4-pro', sessionId: 'sess-collapse-pro', signal: new AbortController().signal }, chunks)) {
      proReceived.push(chunk)
    }
    expect(proReceived.length).toBe(chunks.length)
    expect(cancelled).toEqual(['flash'])

    handle.dispose()
  })
})

describe('Existing prefix-cache & compaction guards isolated to DeepSeek V4.1 Flash', () => {
  it('skips post-hoc tool result pruning for V4.1 Flash without skipping sibling models on the same provider', () => {
    const mkSession = (provider: string, model: string) => ({
      requestHeader: () => ({ config: { provider, model } }),
    })
    expect(shouldSkipPruningForSession(mkSession('deepseek-official', 'deepseek-flash'))).toBe(true)
    expect(shouldSkipPruningForSession(mkSession('opendesign', 'deepseek-v4.1-flash-1017'))).toBe(true)
    // 单独考察 V4.1 Flash 门控（关闭 open-models 门控）时，兄弟模型 deepseek-v4-pro 不被 V4.1 Flash 误匹配
    expect(shouldSkipPruningForSession(mkSession('deepseek-official', 'deepseek-v4-pro'), undefined, true, false)).toBe(false)
    expect(shouldSkipPruningForSession(mkSession('deepseek-official', 'deepseek-chat'))).toBe(false)
    expect(shouldSkipPruningForSession(mkSession('opendesign', 'gpt-6.1-sol'))).toBe(false)
    expect(shouldSkipPruningForSession(mkSession('qoder', 'DeepSeek-Flash'))).toBe(false)

    // Explicit empty skip list still forces pruning everywhere
    expect(shouldSkipPruningForSession(mkSession('opendesign', 'deepseek-v4.1-flash'), new Set())).toBe(false)

    // Host guard honors live skipDeepSeekV41Flash switch
    let enabled = true
    const prunerCalls: unknown[] = []
    const fakePruner = {
      pruneSession(session: unknown) {
        prunerCalls.push(session)
        return { pruned: [{ originalSeq: 1 }], charsRemoved: 100 }
      },
    }
    const guard = installToolResultPrunerGuard({}, { skipDeepSeekV41Flash: () => enabled })
    expect(guard.wrapPruner(fakePruner)).toBe(true)
    expect(fakePruner.pruneSession(mkSession('opendesign', 'deepseek-v4.1-flash'))).toEqual({ pruned: [], charsRemoved: 0 })
    expect(prunerCalls).toHaveLength(0)
    // Sibling model on opendesign is NOT skipped
    expect(fakePruner.pruneSession(mkSession('opendesign', 'gpt-6.1-sol'))).toEqual({ pruned: [{ originalSeq: 1 }], charsRemoved: 100 })
    expect(prunerCalls).toHaveLength(1)
    enabled = false
    expect(fakePruner.pruneSession(mkSession('opendesign', 'deepseek-v4.1-flash'))).toEqual({ pruned: [{ originalSeq: 1 }], charsRemoved: 100 })
    guard.dispose()
  })

  it('freezes PTC tools:sdk and Timeline planning sections for V4.1 Flash while leaving sibling models untouched', async () => {
    const { ctx, emitWaterfall } = createEventHost()
    const ptcGuard = installPtcSdkCacheGuard(ctx)
    const timelineGuard = installTimelineCacheGuard(ctx)

    const flashAgent = makeAgent('opendesign', 'deepseek-v4.1-flash')
    const gptAgent = makeAgent('opendesign', 'gpt-6.1-sol')

    // PTC tools:sdk frozen for V4.1 Flash, dynamic for GPT on same provider
    const sdkV1 = { sections: [{ name: PTC_SDK_SECTION_NAME, text: 'SDK_V1' }] }
    const sdkV2 = { sections: [{ name: PTC_SDK_SECTION_NAME, text: 'SDK_V2' }] }
    await emitWaterfall('system-prompt/assemble', [sdkV1, { scope: flashAgent }], () => sdkV1)
    const flashSdkSecond = await emitWaterfall('system-prompt/assemble', [sdkV2, { scope: flashAgent }], () => sdkV2)
    expect(flashSdkSecond.sections[0]?.text).toBe('SDK_V1')

    await emitWaterfall('system-prompt/assemble', [sdkV1, { scope: gptAgent }], () => sdkV1)
    const gptSdkSecond = await emitWaterfall('system-prompt/assemble', [sdkV2, { scope: gptAgent }], () => sdkV2)
    expect(gptSdkSecond.sections[0]?.text).toBe('SDK_V2')

    // Timeline section frozen for V4.1 Flash, dynamic for GPT on same provider
    const tl1 = { sections: [{ name: TIMELINE_SECTION, text: 'TL_ZH' }] }
    const tl2 = { sections: [{ name: TIMELINE_SECTION, text: 'TL_EN' }] }
    await emitWaterfall('system-prompt/assemble', [tl1, { scope: flashAgent }], () => tl1)
    const flashTlSecond = await emitWaterfall('system-prompt/assemble', [tl2, { scope: flashAgent }], () => tl2)
    expect(flashTlSecond.sections[0]?.text).toBe('TL_ZH')

    await emitWaterfall('system-prompt/assemble', [tl1, { scope: gptAgent }], () => tl1)
    const gptTlSecond = await emitWaterfall('system-prompt/assemble', [tl2, { scope: gptAgent }], () => tl2)
    expect(gptTlSecond.sections[0]?.text).toBe('TL_EN')

    ptcGuard.dispose()
    timelineGuard.dispose()
  })

  it('leaves DeepSeek V4.1 Flash on DSH default compaction policy without injecting overrides', () => {
    const engine = {
      config: {
        modelPolicies: [] as Array<{ provider: string; model: string }>,
      },
      compactIfNeeded(_agent: unknown) {
        return null
      },
    }
    const guard = installCompactionPolicyGuard({})
    expect(guard.patchEngine(engine)).toBe(true)

    engine.compactIfNeeded(makeAgent('deepseek-official', 'deepseek-flash'))
    engine.compactIfNeeded(makeAgent('opendesign', 'deepseek-v4.1-flash-1017'))

    expect(engine.config.modelPolicies.find(
      p => p.provider === 'deepseek-official' && p.model === 'deepseek-flash',
    )).toBeUndefined()
    expect(engine.config.modelPolicies.find(
      p => p.provider === 'opendesign' && p.model === 'deepseek-v4.1-flash-1017',
    )).toBeUndefined()

    guard.dispose()
  })

  it('allows cache_warmup_result readback on official DeepSeek V4.1 Flash while rejecting official deepseek-v4-pro', async () => {
    const store = {
      put: vi.fn(),
      page: vi.fn(async () => ({ content: 'slice', complete: true, offset: 0, totalChars: 5, omitted: 0 })),
      release: vi.fn(async () => true),
    }
    const tool = createCacheWarmupResultTool({
      provider: 'kimi-code',
      allowProvider: provider => provider === 'kimi-code',
      allowRoute: route => isDeepSeekV41Flash(route.model, route.provider),
      routeOf: exec => {
        const agent = (exec as { agent: { provider: string; model: string; id: string } }).agent
        return { provider: agent.provider, model: agent.model, sessionId: agent.id }
      },
      store: () => store as never,
    })

    const flashOk = await (tool.execute as (args: unknown, exec: unknown) => Promise<{ ok: boolean; text?: string }>)({
      action: 'page',
      refId: 'ref://s1/abc',
    }, { agent: { provider: 'deepseek-official', model: 'deepseek-flash', id: 's1' } })
    expect(flashOk.ok).toBe(true)
    expect(flashOk.text).toBe('slice')

    const proDenied = await (tool.execute as (args: unknown, exec: unknown) => Promise<{ ok: boolean; error?: { code: string } }>)({
      action: 'page',
      refId: 'ref://s2/abc',
    }, { agent: { provider: 'deepseek-official', model: 'deepseek-v4-pro', id: 's2' } })
    expect(proDenied.ok).toBe(false)
    expect(proDenied.error?.code).toBe('WRONG_PROVIDER')
  })

  it('recovers unfinished todos from sessionProjections (todos -> todoReminder -> todo/write events) for V4.1 Flash state anchor', async () => {
    let projectedTodos: unknown = null
    let projectedReminder: unknown = {
      unfinishedTodos: [
        { content: 'Run full test suite', status: 'in_progress' },
        { content: 'Update changelog', status: 'pending' },
      ],
      assistantMessagesSinceAnchor: 5,
    }
    const { ctx, emitWaterfall } = createEventHost()
    ;(ctx as Record<string, unknown>)['get'] = (name: string) => name === 'sessionProjections'
      ? {
          stateOf: (_session: unknown, key: string) => {
            if (key === 'todos') return projectedTodos
            if (key === 'todoReminder') return projectedReminder
            return undefined
          },
        }
      : undefined

    const dispose = installDeepSeekV41FlashStateAnchor(ctx, {
      stepInterval: 2,
      contextWatermarks: [],
      estimateContextTokens: () => 0,
    })
    const agent = makeAgent('opendesign', 'deepseek-v4.1-flash-1017', 'sess-todo-proj', 'high')
    // 冷恢复场景：没有经历过 todo_write 内存事件，第 1 步目标 + 2 步后触发周期锚
    const goal = { role: 'user', content: [{ type: 'text', text: 'Ship release safely' }] }
    await emitWaterfall('agent/pre-step', [{ agent, messages: [goal] }], () => ({ kind: 'enter', messages: [goal] }))
    await emitWaterfall('agent/pre-step', [{ agent, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    const anchored = await emitWaterfall('agent/pre-step', [{ agent, messages: [] }], () => ({ kind: 'enter', messages: [] })) as {
      messages: Array<{ content: Array<{ text: string }> }>
    }
    expect(anchored.messages).toHaveLength(1)
    expect(anchored.messages[0]!.content[0]!.text).toContain('TASKS: 0/2 done | NOW: Run full test suite | NEXT: Update changelog')

    // 当 todos 投影本身有更新时优先于 todoReminder
    projectedTodos = [
      { content: 'Run full test suite', status: 'completed' },
      { content: 'Update changelog', status: 'in_progress' },
    ]
    await emitWaterfall('agent/pre-step', [{ agent, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    const updated = await emitWaterfall('agent/pre-step', [{ agent, messages: [] }], () => ({ kind: 'enter', messages: [] })) as {
      messages: Array<{ content: Array<{ text: string }> }>
    }
    expect(updated.messages[0]!.content[0]!.text).toContain('TASKS: 1/2 done | NOW: Update changelog')

    // 清空投影后若历史事件仍有 todo/write，老代无投影路径也能从 events 恢复
    projectedTodos = undefined
    projectedReminder = undefined
    const eventAgent = {
      id: 'sess-todo-events',
      options: { provider: 'opendesign', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
      session: {
        header: { id: 'sess-todo-events' },
        events: [
          { type: 'todo/write', data: { todos: [{ content: 'Verify build', status: 'pending' }] } },
        ],
      },
    }
    await emitWaterfall('agent/pre-step', [{ agent: eventAgent, messages: [goal] }], () => ({ kind: 'enter', messages: [goal] }))
    await emitWaterfall('agent/pre-step', [{ agent: eventAgent, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    const fromEvents = await emitWaterfall('agent/pre-step', [{ agent: eventAgent, messages: [] }], () => ({ kind: 'enter', messages: [] })) as {
      messages: Array<{ content: Array<{ text: string }> }>
    }
    expect(fromEvents.messages[0]!.content[0]!.text).toContain('TASKS: 0/1 done | NEXT: Verify build')
    dispose()
  })
})
