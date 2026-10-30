/**
 * 工具结果修剪器（fork 版）与宿主级守卫的行为锁定。
 *
 * 断言按两条线组织：
 *
 * 1. **与官方实现一致的部分** —— 配置校验、码点切片、代理对不劈开、非文本块不计价、
 *    `compaction/prune` 与替换事件的先后顺序，全部逐字对照
 *    `@deepseek-ai/dsh-compaction-tool-result-pruner` 的规格测试；
 * 2. **fork 自己的部分** —— provider 感知的整场跳过，以及宿主平面上的跨 preset 守卫
 *    （它必须在 `ctx.reflect.store` 与 `agent.ctx.get` 两处都找到实例，且
 *    `dispose()` 之后一切复原）。
 *
 * 会话与事件全部用本地结构替身，不 import 任何 harness 的 session / token-meter 包：
 * 本包不依赖它们，测试也不该替它们做保证。
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import ToolResultPruner, {
  DEFAULT_SKIP_PROVIDERS,
  DEFAULTS,
  PRUNE_MARKER,
  PRUNER_SERVICE_NAME,
  codePointLength,
  readSessionProvider,
  resolveConfig,
  resolveSkipProviders,
  shouldSkipPruningForSession,
} from '../src/entry-tool-result-pruner.ts'
import type { ToolResultPruneConfig } from '../src/entry-tool-result-pruner.ts'
import { installToolResultPrunerGuard } from '../src/host/tool-result-pruner-guard.ts'

/** 小预算配置：头部 4 + 标记 + 尾部 3，阈值 50。 */
const SMALL: ToolResultPruneConfig = {
  thresholdChars: 50,
  headChars: 4,
  tailChars: 3,
}

/** 计价替身返回的 token 数，用来断言 shadow-price 事件读的是 meter。 */
const METER_TOKENS = 77

/** 一条工具结果的结构描述。 */
interface ToolResultSpec {
  /** 工具调用 id。 */
  readonly callId: string
  /** 内容块。 */
  readonly content: ContentBlock[]
}

/** 被 append 拦截下来的一条事件。 */
interface AppendedEvent {
  /** 事件类型。 */
  readonly type: string
  /** 落点序号。 */
  readonly seq: number
  /** 事件负载。 */
  readonly data: Record<string, unknown>
  /** append 的第三个参数（surfaceOp / sourceEventSeqs）。 */
  readonly options: unknown
}

/** 会话替身。 */
interface MockSession {
  /** 表层节点。 */
  readonly nodes: number[]
  /** 当前日志里的事件。 */
  readonly events: Map<number, { type: string; seq: number; data: Record<string, unknown> }>
  /** append 记录。 */
  readonly appended: AppendedEvent[]
  /** 被读取过的事件序号（用来断言"整场跳过时一次都没读"）。 */
  readonly reads: number[]
  /** 传给被修剪方的会话对象。 */
  readonly session: {
    surface: { nodes: number[] }
    requestHeader?: () => { config: { provider: string } }
    provider?: string
    eventAt(seq: number): { type: string; seq: number; data: Record<string, unknown> } | undefined
    deriveEventMessage(event: { data?: unknown }): unknown
    append(type: string, data: unknown, options?: unknown): { seq: number }
  }
}

/**
 * Apply a `surfaceOp` the way the harness's own `Session.append` does.
 *
 * A `replace` op takes the surface nodes the range covers out of the surface
 * and puts the new node in their place, so the surface keeps naming the
 * *replacement* event instead of the one it superseded. Without this the mock's
 * surface still names the original event, and a second pruning pass reads the
 * unpruned text again — which is exactly what the convergence assertion below
 * is about.
 *
 * @param nodes - the surface's node list, mutated in place.
 * @param options - `append`'s third argument.
 * @param seq - the sequence number of the event just appended.
 */
function applySurfaceOp(nodes: number[], options: unknown, seq: number): void {
  const surfaceOp = (options as { surfaceOp?: { op?: string; startSeq?: number; endSeq?: number } } | undefined)?.surfaceOp
  if (surfaceOp?.op !== 'replace' || typeof surfaceOp.startSeq !== 'number') return
  const start = nodes.indexOf(surfaceOp.startSeq)
  if (start < 0) return
  const endSeq = typeof surfaceOp.endSeq === 'number' ? surfaceOp.endSeq : surfaceOp.startSeq
  let end = start
  while (end + 1 < nodes.length && (nodes[end + 1] as number) <= endSeq) end++
  nodes.splice(start, end - start + 1, seq)
}

/**
 * 建一个会话替身。
 *
 * @param spec - provider 形状与工具结果列表。
 * @returns 替身句柄。
 */
function createMockSession(spec: {
  /** requestHeader().config.provider 的值。 */
  provider?: string
  /** 扁平 session.provider 的值。 */
  flatProvider?: string
  /** 工具结果列表。 */
  results: ToolResultSpec[]
}): MockSession {
  const events = new Map<number, { type: string; seq: number; data: Record<string, unknown> }>()
  const nodes: number[] = []
  const appended: AppendedEvent[] = []
  const reads: number[] = []
  let nextSeq = 1
  for (const result of spec.results) {
    const seq = nextSeq++
    events.set(seq, {
      type: 'tool/result',
      seq,
      data: {
        turn: 1,
        step: 1,
        meta: { source: 'test-fixture' },
        message: {
          role: 'tool',
          content: result.content,
          isError: false,
          toolCallId: result.callId,
          source: { kind: 'tool', callId: result.callId },
        },
      },
    })
    nodes.push(seq)
  }
  const session: MockSession['session'] = {
    surface: { nodes },
    ...(spec.provider === undefined
      ? {}
      : { requestHeader: () => ({ config: { provider: spec.provider as string } }) }),
    ...(spec.flatProvider === undefined ? {} : { provider: spec.flatProvider }),
    eventAt(seq: number) {
      reads.push(seq)
      return events.get(seq)
    },
    deriveEventMessage(event: { data?: unknown }) {
      return (event.data as { message: unknown }).message
    },
    append(type: string, data: unknown, options?: unknown) {
      const seq = nextSeq++
      const record = { type, seq, data: data as Record<string, unknown>, options }
      appended.push(record)
      events.set(seq, { type, seq, data: record.data })
      applySurfaceOp(nodes, options, seq)
      return { seq }
    },
  }
  return { nodes, events, appended, reads, session }
}

/**
 * 建一个带计价替身的修剪器。
 *
 * @param config - 配置。
 * @returns 修剪器实例。
 */
function createPruner(config: ToolResultPruneConfig = SMALL): ToolResultPruner {
  const ctx = new Context()
  // 计价能力是声明注入的依赖；这里塞一个替身，让 shadow-price 事件的价格可断言。
  // 宿主没有这个服务时实现按 0 计，所以塞不进去也不影响别的断言。
  try {
    ctx.provide('tokenMeter', { estimateMessage: () => METER_TOKENS })
  } catch {
    // 该代不允许在根上下文注册：实现走 "按 0 计" 的回退分支。
  }
  return new ToolResultPruner(ctx, config)
}

/** 宿主上下文替身（守卫只用到 on/off/get/reflect.store）。 */
interface FakeHost {
  /** reflect.store：symbol → 服务记录。 */
  readonly store: Record<symbol, { name?: string; value?: unknown }>
  /** 事件监听表。 */
  readonly listeners: Map<string, Array<{ listener: (...args: unknown[]) => void; options: unknown }>>
  /** 交给守卫的上下文对象。 */
  readonly ctx: Record<string, unknown>
  /** 派发一个事件。 */
  emit(name: string, ...args: unknown[]): void
  /** 某事件的监听器数量。 */
  listenerCount(name: string): number
}

/**
 * 建一个宿主上下文替身。
 *
 * @returns 替身句柄。
 */
function createFakeHost(): FakeHost {
  const store: Record<symbol, { name?: string; value?: unknown }> = {}
  const listeners = new Map<string, Array<{ listener: (...args: unknown[]) => void; options: unknown }>>()
  const ctx: Record<string, unknown> = {
    reflect: { store },
    on(name: string, listener: (...args: unknown[]) => void, options: unknown) {
      const bucket = listeners.get(name) ?? []
      bucket.push({ listener, options })
      listeners.set(name, bucket)
      return () => {
        const list = listeners.get(name) ?? []
        const index = list.findIndex(entry => entry.listener === listener)
        if (index >= 0) list.splice(index, 1)
        return true
      }
    },
    off(name: string, listener: (...args: unknown[]) => void) {
      const list = listeners.get(name) ?? []
      const index = list.findIndex(entry => entry.listener === listener)
      if (index >= 0) list.splice(index, 1)
    },
    get(name: string) {
      for (const key of Object.getOwnPropertySymbols(store)) {
        const entry = store[key]
        if (entry !== undefined && entry.name === name) return entry.value
      }
      return undefined
    },
    emit(name: string, ...args: unknown[]) {
      for (const entry of [...(listeners.get(name) ?? [])]) entry.listener(...args)
    },
  }
  return {
    store,
    listeners,
    ctx,
    emit(name: string, ...args: unknown[]) {
      const dispatcher = ctx.emit as (event: string, ...rest: unknown[]) => void
      dispatcher(name, ...args)
    },
    listenerCount(name: string) {
      return (listeners.get(name) ?? []).length
    },
  }
}

describe('修剪配置', () => {
  it('默认值与官方实现逐字一致，且已深冻结', () => {
    expect(PRUNE_MARKER).toBe('\n\n[... tool result middle pruned ...]\n\n')
    expect(DEFAULTS).toEqual({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
    expect(Object.isFrozen(DEFAULTS)).toBe(true)
    expect(DEFAULT_SKIP_PROVIDERS).toEqual(['kimi-code'])
    expect(Object.isFrozen(DEFAULT_SKIP_PROVIDERS)).toBe(true)
    expect(PRUNER_SERVICE_NAME).toBe('toolResultPruner')
  })

  it('解析出的部分覆盖会脱离原对象并冻结', () => {
    const raw: ToolResultPruneConfig = { thresholdChars: 100, headChars: 20, tailChars: 10 }
    const resolved = resolveConfig(raw)
    raw.headChars = 1
    expect(resolved).toEqual({ thresholdChars: 100, headChars: 20, tailChars: 10 })
    expect(resolved.headChars).toBe(20)
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(resolveConfig()).toEqual(DEFAULTS)
  })

  it('接受 skipProviders 键，并拒绝任何别的键', () => {
    expect(resolveSkipProviders(['kimi-code']).has('kimi-code')).toBe(true)
    expect(resolveSkipProviders().has('kimi-code')).toBe(true)
    expect(resolveSkipProviders([]).size).toBe(0)
    expect(() => resolveConfig({ skipProviders: ['kimi-code'] })).not.toThrow()
    expect(() => resolveConfig({ threshold: 10 } as unknown as ToolResultPruneConfig))
      .toThrow(/unknown key "threshold"/)
    expect(() => resolveConfig({ skipProvider: ['kimi-code'] } as unknown as ToolResultPruneConfig))
      .toThrow(/unknown key "skipProvider"/)
  })

  it('拒绝非法标量与超出阈值的输出预算', () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ thresholdChars: 0 }, /thresholdChars .* positive integer/],
      [{ thresholdChars: 1.5 }, /thresholdChars .* positive integer/],
      [{ headChars: -1 }, /headChars .* non-negative integer/],
      [{ tailChars: 1.5 }, /tailChars .* non-negative integer/],
      [{ thresholdChars: 50, headChars: 20, tailChars: 20 }, /headChars \+ marker \+ tailChars/],
    ]
    for (const [config, pattern] of bad) {
      expect(() => resolveConfig(config as ToolResultPruneConfig)).toThrow(pattern)
    }
  })
})

describe('内容变换', () => {
  it('按码点计数，代理对只算一个', () => {
    expect(codePointLength('a😀b')).toBe(3)
    expect(codePointLength('😀')).toBe(1)
    expect(codePointLength('')).toBe(0)
  })

  it('只度量文本块，且预算内返回 null', () => {
    const pruner = createPruner()
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'a😀b' },
      { type: 'reasoning', text: 'not measured' },
    ]
    expect(pruner.measureContent(blocks)).toBe(3)
    expect(pruner.pruneContent(blocks)).toBeNull()
  })

  it('保留配置的头部与尾部，且不劈开代理对', () => {
    const pruner = createPruner()
    const pruned = pruner.pruneContent([{ type: 'text', text: '😀'.repeat(60) }])
    expect(pruned).toEqual([{
      type: 'text',
      text: `${'😀'.repeat(4)}${PRUNE_MARKER}${'😀'.repeat(3)}`,
    }])
    expect(pruner.measureContent(pruned ?? [])).toBeLessThanOrEqual(SMALL.thresholdChars as number)
    expect((pruned?.[0] as { text: string }).text).not.toContain('\uFFFD')
  })

  it('保留非文本块与它们的相对顺序', () => {
    const pruner = createPruner()
    const reasoning: ContentBlock = { type: 'reasoning', text: 'private-rich-block' }
    const pruned = pruner.pruneContent([
      { type: 'text', text: 'A'.repeat(40) },
      reasoning,
      { type: 'text', text: 'B'.repeat(30) },
      { type: 'text', text: 'C'.repeat(30) },
    ])
    expect(pruned).toEqual([
      { type: 'text', text: `AAAA${PRUNE_MARKER}` },
      reasoning,
      { type: 'text', text: 'CCC' },
    ])
    expect(pruner.measureContent(pruned ?? [])).toBeLessThanOrEqual(SMALL.thresholdChars as number)
  })

  it('零头零尾也能收敛到只剩标记', () => {
    const pruner = createPruner({
      thresholdChars: codePointLength(PRUNE_MARKER),
      headChars: 0,
      tailChars: 0,
    })
    const pruned = pruner.pruneContent([{ type: 'text', text: 'x'.repeat(100) }])
    expect(pruned).toEqual([{ type: 'text', text: PRUNE_MARKER }])
    expect(pruner.measureContent(pruned ?? [])).toBe(pruner.config.thresholdChars)
  })
})

describe('provider 感知的会话修剪', () => {
  it('kimi-code 会话整场跳过：不读事件、不写事件、表原样', () => {
    const pruner = createPruner()
    const mock = createMockSession({
      provider: 'kimi-code',
      results: [{ callId: 'call-one', content: [{ type: 'text', text: 'x'.repeat(200) }] }],
    })
    const nodesBefore = [...mock.nodes]

    expect(pruner.pruneSession(mock.session)).toEqual({ pruned: [], charsRemoved: 0 })
    expect(mock.reads).toEqual([])
    expect(mock.appended).toEqual([])
    expect(mock.nodes).toEqual(nodesBefore)
  })

  it('扁平 provider 字段同样能识别 kimi-code', () => {
    const pruner = createPruner()
    const mock = createMockSession({
      flatProvider: 'kimi-code',
      results: [{ callId: 'call-flat', content: [{ type: 'text', text: 'y'.repeat(200) }] }],
    })
    expect(pruner.pruneSession(mock.session)).toEqual({ pruned: [], charsRemoved: 0 })
    expect(mock.appended).toEqual([])
  })

  it('自定义 skipProviders 覆盖默认名单', () => {
    const pruner = createPruner({ ...SMALL, skipProviders: ['opendesign'] })
    const skipped = createMockSession({
      provider: 'opendesign',
      results: [{ callId: 'call-two', content: [{ type: 'text', text: 'z'.repeat(200) }] }],
    })
    expect(pruner.pruneSession(skipped.session)).toEqual({ pruned: [], charsRemoved: 0 })

    const pruned = createMockSession({
      provider: 'kimi-code',
      results: [{ callId: 'call-three', content: [{ type: 'text', text: 'z'.repeat(200) }] }],
    })
    expect(pruner.pruneSession(pruned.session).pruned).toHaveLength(1)
  })

  it('codex-chatgpt 会话做头/中/尾修剪，并紧挨着写计价与替换事件', () => {
    const pruner = createPruner()
    const mock = createMockSession({
      provider: 'codex-chatgpt',
      results: [{ callId: 'call-codex', content: [{ type: 'text', text: 'x'.repeat(200) }] }],
    })
    const originalSeq = mock.nodes[0] as number

    const result = pruner.pruneSession(mock.session)
    expect(result.pruned).toHaveLength(1)
    expect(result.charsRemoved).toBeGreaterThan(0)

    const entry = result.pruned[0]
    expect(entry).toMatchObject({
      originalSeq,
      callId: 'call-codex',
      charsBefore: 200,
    })
    expect(entry?.charsAfter).toBeLessThanOrEqual(SMALL.thresholdChars as number)
    expect(entry?.replacementSeq).toBeGreaterThan(originalSeq)

    // 计价事件先落地，价格来自注入的 meter。
    expect(mock.appended).toHaveLength(2)
    const metering = mock.appended[0]
    expect(metering?.type).toBe('compaction/prune')
    expect(metering?.data).toMatchObject({
      shadowedRange: { start: originalSeq, end: originalSeq },
      shadowedSeqs: [originalSeq],
      shadowedTokenCount: METER_TOKENS,
    })

    // 替换事件带 surfaceOp: replace 与引用，其余数据原样保留，内容已修剪。
    const replacement = mock.appended[1]
    expect(replacement?.type).toBe('tool/result')
    expect(replacement?.options).toEqual({
      surfaceOp: { op: 'replace', startSeq: originalSeq, endSeq: originalSeq },
      sourceEventSeqs: [originalSeq],
    })
    expect(replacement?.data['meta']).toEqual({ source: 'test-fixture' })
    const message = replacement?.data['message'] as {
      content: ContentBlock[]
      source: { callId: string }
    }
    expect(message.source.callId).toBe('call-codex')
    expect(message.content).toEqual([{
      type: 'text',
      text: `${'x'.repeat(4)}${PRUNE_MARKER}${'x'.repeat(3)}`,
    }])
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content)).toBe(true)
  })

  it.each(['opendesign', 'anthropic', 'claude'])('%s provider 也会照常修剪', (provider) => {
    const pruner = createPruner()
    const mock = createMockSession({
      provider,
      results: [{
        callId: `call-${provider}`,
        content: [{ type: 'text', text: 'q'.repeat(120) }],
      }],
    })
    expect(pruner.pruneSession(mock.session).pruned).toHaveLength(1)
    expect(mock.appended.map(event => event.type)).toEqual(['compaction/prune', 'tool/result'])
  })

  it('跳过短结果，并在第二遍收敛', () => {
    const pruner = createPruner()
    const mock = createMockSession({
      provider: 'codex-chatgpt',
      results: [
        { callId: 'long-a', content: [{ type: 'text', text: 'A'.repeat(100) }] },
        { callId: 'short-b', content: [{ type: 'text', text: 'short' }] },
        { callId: 'long-c', content: [{ type: 'text', text: 'C'.repeat(80) }] },
      ],
    })
    const first = pruner.pruneSession(mock.session)
    expect(first.pruned.map(entry => entry.callId)).toEqual(['long-a', 'long-c'])
    expect(first.charsRemoved).toBe(
      first.pruned.reduce((sum, entry) => sum + entry.charsBefore - entry.charsAfter, 0),
    )
    // 第二遍读到的是替换后的内容：已在预算内，不再改写，也不再省字符。
    const second = pruner.pruneSession(mock.session)
    expect(second.pruned).toHaveLength(0)
    expect(second.charsRemoved).toBe(0)
  })

  it('会话没有 provider 信息时按"不跳过"处理', () => {
    expect(readSessionProvider({})).toBeUndefined()
    expect(readSessionProvider(null)).toBeUndefined()
    expect(shouldSkipPruningForSession({})).toBe(false)
    expect(shouldSkipPruningForSession({ requestHeader: () => ({ config: {} }) })).toBe(false)
    expect(shouldSkipPruningForSession({
      requestHeader: () => {
        throw new Error('gone')
      },
      provider: 'kimi-code',
    })).toBe(true)
  })
})

describe('宿主级跨 preset 守卫', () => {
  it('安装时包装已存在的实例，事件到来时包装新挂的实例', () => {
    const host = createFakeHost()
    const existing = createPruner()
    const existingSpy = vi.spyOn(existing, 'pruneSession')
    host.store[Symbol('first')] = { name: PRUNER_SERVICE_NAME, value: existing }

    const guard = installToolResultPrunerGuard(host.ctx)
    expect(existing.pruneSession).not.toBe(existingSpy)
    // 幂等：同一个实例不会再叠一层。
    expect(guard.wrapPruner(existing)).toBe(false)

    const late = createPruner()
    const lateSpy = vi.spyOn(late, 'pruneSession')
    host.store[Symbol('second')] = { name: PRUNER_SERVICE_NAME, value: late }
    expect(late.pruneSession).toBe(lateSpy)

    host.emit('agent/pre-step', { ctx: { reflect: { store: {} }, get: () => undefined } })
    expect(late.pruneSession).not.toBe(lateSpy)

    // 名字明确是别的服务时一律不碰。
    const foreignPrune = (): { pruned: never[]; charsRemoved: number } => ({
      pruned: [],
      charsRemoved: 0,
    })
    const foreign = { pruneSession: foreignPrune }
    host.store[Symbol('foreign')] = { name: 'someOtherService', value: foreign }
    host.emit('agent/request-error', { ctx: { reflect: { store: {} } } })
    expect(foreign.pruneSession).toBe(foreignPrune)

    guard.dispose()
  })

  it('kimi-code 会话被短路，非 kimi 会话原样转给底层实现', () => {
    const host = createFakeHost()
    const pruner = createPruner()
    const spy = vi.spyOn(pruner, 'pruneSession')
    host.store[Symbol('pruner')] = { name: PRUNER_SERVICE_NAME, value: pruner }
    const guard = installToolResultPrunerGuard(host.ctx)

    const kimi = createMockSession({
      provider: 'kimi-code',
      results: [{ callId: 'kimi-call', content: [{ type: 'text', text: 'k'.repeat(200) }] }],
    })
    expect(pruner.pruneSession(kimi.session)).toEqual({ pruned: [], charsRemoved: 0 })
    expect(spy).not.toHaveBeenCalled()
    expect(kimi.appended).toEqual([])

    const codex = createMockSession({
      provider: 'codex-chatgpt',
      results: [{ callId: 'codex-call', content: [{ type: 'text', text: 'c'.repeat(200) }] }],
    })
    const result = pruner.pruneSession(codex.session)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(result.pruned).toHaveLength(1)
    expect(codex.appended.map(event => event.type)).toEqual(['compaction/prune', 'tool/result'])

    guard.dispose()
  })

  it('dispose 还原原方法并摘掉监听器', () => {
    const host = createFakeHost()
    const pruner = createPruner()
    const spy = vi.spyOn(pruner, 'pruneSession')
    host.store[Symbol('pruner')] = { name: PRUNER_SERVICE_NAME, value: pruner }

    const guard = installToolResultPrunerGuard(host.ctx, { skipProviders: ['kimi-code'] })
    expect(host.listenerCount('agent/pre-step')).toBe(1)
    expect(host.listenerCount('agent/request-error')).toBe(1)
    expect(pruner.pruneSession).not.toBe(spy)

    guard.dispose()
    expect(pruner.pruneSession).toBe(spy)
    expect(host.listenerCount('agent/pre-step')).toBe(0)
    expect(host.listenerCount('agent/request-error')).toBe(0)

    // 销毁后再派发事件也不会重新包装。
    const latePruner = createPruner()
    const lateSpy = vi.spyOn(latePruner, 'pruneSession')
    host.store[Symbol('late')] = { name: PRUNER_SERVICE_NAME, value: latePruner }
    host.emit('agent/pre-step', { ctx: { reflect: { store: {} } } })
    expect(latePruner.pruneSession).toBe(lateSpy)

    // 还原之后 kimi 会话重新走底层实现（短路已经被摘掉）。
    const kimi = createMockSession({
      provider: 'kimi-code',
      results: [{ callId: 'kimi-again', content: [{ type: 'text', text: 'k'.repeat(200) }] }],
    })
    pruner.pruneSession(kimi.session)
    expect(spy).toHaveBeenCalledTimes(1)

    guard.dispose()
    expect(host.listenerCount('agent/pre-step')).toBe(0)
  })

  it('也能从隔离 realm 的 agent.ctx.get 找到实例', () => {
    const host = createFakeHost()
    const guard = installToolResultPrunerGuard(host.ctx, { skipProviders: ['kimi-code'] })

    const isolated = createPruner()
    const isolatedSpy = vi.spyOn(isolated, 'pruneSession')
    const realmStore: Record<symbol, { name?: string; value?: unknown }> = {}
    const agentCtx = {
      reflect: { store: realmStore },
      get(name: string) {
        return name === PRUNER_SERVICE_NAME ? isolated : undefined
      },
    }

    host.emit('agent/pre-step', { ctx: agentCtx })
    expect(isolated.pruneSession).not.toBe(isolatedSpy)

    const kimi = createMockSession({
      provider: 'kimi-code',
      results: [{ callId: 'isolated-kimi', content: [{ type: 'text', text: 'i'.repeat(200) }] }],
    })
    expect(isolated.pruneSession(kimi.session)).toEqual({ pruned: [], charsRemoved: 0 })
    expect(isolatedSpy).not.toHaveBeenCalled()

    guard.dispose()
    expect(isolated.pruneSession).toBe(isolatedSpy)
  })

  it('既能拒绝非修剪器对象，也能在没有 on/get 的宿主上安静地什么都不做', () => {
    const emptyHost = installToolResultPrunerGuard(undefined)
    expect(emptyHost.wrapPruner({})).toBe(false)
    expect(emptyHost.wrapPruner(null)).toBe(false)
    expect(emptyHost.wrapPruner({ pruneSession: 'not-a-function' })).toBe(false)
    emptyHost.dispose()

    const guard = installToolResultPrunerGuard({})
    expect(guard.wrapPruner(createPruner())).toBe(true)
    guard.dispose()
  })
})
