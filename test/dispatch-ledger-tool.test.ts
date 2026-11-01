import { describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  DISPATCH_LEDGER_DESCRIPTION,
  DISPATCH_LEDGER_MAX_LIMIT,
  DISPATCH_LEDGER_TOOL,
  createDispatchLedgerTool,
} from '../src/host/dispatch-ledger/tool.ts'
import {
  createDispatchLedgerCache,
  type DispatchLedgerSessionLike,
  type DispatchLedgerSessions,
} from '../src/host/dispatch-ledger/guard.ts'
import { installDispatchLedger } from '../src/host/dispatch-ledger/index.ts'
import { DISPATCH_MANDATE_PROTOCOL } from '../src/host/dispatch-ledger/protocol.ts'
import { dispatchPolicyDescriptor } from '../src/host/dispatch-ledger/policy.ts'
import {
  MANDATE_FENCE_CLOSE,
  MANDATE_FENCE_OPEN,
  parseMandateHeader,
} from '../src/host/dispatch-ledger/header.ts'
import type { DispatchLedgerEventLike } from '../src/host/dispatch-ledger/ledger.ts'

const POLICY = dispatchPolicyDescriptor({ tools: ['subagent', 'subagent_fork'], routes: [] })

/** 一份合法的派发头字段。 */
function dispatchFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 2,
    kind: 'dispatch',
    brief_id: 'b-7f',
    run_id: 'r-1',
    idem: 'i-1',
    mandate_version: 1,
    prompt_ref: 'plan-v3',
    policy: { id: POLICY.id, version: POLICY.version, sha256: POLICY.sha256 },
    task: ['task://req-42'],
    boundary: ['src/host/dispatch-ledger/**'],
    followup: ['ctx://plan-v3'],
    parent_mandate: null,
    ...overrides,
  }
}

/** 把字段包成一段带头部的文本。 */
function withHeader(fields: Record<string, unknown>, body = 'do the work'): string {
  return MANDATE_FENCE_OPEN + '\n' + JSON.stringify(fields) + '\n' + MANDATE_FENCE_CLOSE + '\n' + body
}

/** 一次原生工具调用。 */
function nativeCall(seq: number, callId: string, prompt: string): DispatchLedgerEventLike {
  return {
    type: 'tool/call',
    seq,
    time: 1000 + seq,
    data: { turn: 1, step: 1, callId, name: 'subagent', arguments: JSON.stringify({ description: 'd', prompt }) },
  }
}

/** 一次原生工具结果。 */
function nativeResult(seq: number, callId: string, isError: boolean, text: string): DispatchLedgerEventLike {
  return {
    type: 'tool/result',
    seq,
    time: 1000 + seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'm' + seq,
        role: 'tool',
        source: { kind: 'tool' },
        toolCallId: callId,
        isError,
        content: [{ type: 'text', text }],
      },
    },
  }
}

/** 造一个会话。 */
function makeSession(
  id: string,
  events: DispatchLedgerEventLike[],
  parentSession?: string,
): DispatchLedgerSessionLike {
  return {
    id,
    header: parentSession === undefined ? {} : { parentSession },
    events,
    snapshotEvents: () => events,
  }
}

/** 造一个执行上下文。 */
function execFor(session: DispatchLedgerSessionLike): ToolRunContext {
  return { agent: { session } } as unknown as ToolRunContext
}

/** 读一次工具执行的结果。 */
async function run(
  tool: ReturnType<typeof createDispatchLedgerTool>,
  args: Record<string, unknown>,
  session: DispatchLedgerSessionLike,
): Promise<Record<string, unknown>> {
  const value = await tool.execute(args as never, execFor(session))
  return value as unknown as Record<string, unknown>
}

/** 渲染一次工具结果。 */
function render(
  tool: ReturnType<typeof createDispatchLedgerTool>,
  args: Record<string, unknown>,
  value: Record<string, unknown>,
): string {
  const output = tool.output as unknown as {
    render?: (args: unknown, value: unknown) => { type: string; text?: string }[]
  }
  const blocks = output.render?.(args, value) ?? []
  return blocks.map(block => block.text ?? '').join('')
}

describe('dispatch_ledger 工具：静态性', () => {
  it('工具名是契约常量', () => {
    expect(DISPATCH_LEDGER_TOOL).toBe('dispatch_ledger')
    expect(createDispatchLedgerTool({ cache: createDispatchLedgerCache() }).name).toBe('dispatch_ledger')
  })

  it('描述是编译期常量且不超过 240 字符', () => {
    expect(DISPATCH_LEDGER_DESCRIPTION.length).toBeLessThanOrEqual(240)
    const tool = createDispatchLedgerTool({ cache: createDispatchLedgerCache() })
    expect(tool.description).toBe(DISPATCH_LEDGER_DESCRIPTION)
    const again = createDispatchLedgerTool({ cache: createDispatchLedgerCache() })
    expect(again.description).toBe(tool.description)
    expect(again.parameters).toEqual(tool.parameters)
  })

  it('参数表是静态的：action 必填，其余可选', () => {
    const tool = createDispatchLedgerTool({ cache: createDispatchLedgerCache() })
    const parameters = tool.parameters as unknown as {
      properties: Record<string, unknown>
      required?: string[]
    }
    expect(parameters.required).toEqual(['action'])
    expect(Object.keys(parameters.properties).sort()).toEqual([
      'action', 'brief_id', 'idem', 'limit', 'run_id', 'scope', 'state',
    ])
  })
})

describe('dispatch_ledger 工具：action=self', () => {
  it('返回会话、父会话、策略、自身 Mandate 与开放状态', async () => {
    const prompt = withHeader(dispatchFields())
    const session = makeSession('child-1', [nativeCall(1, 'call-a', prompt)], 'dispatcher-1')
    const tool = createDispatchLedgerTool({
      cache: createDispatchLedgerCache(),
      policyFor: () => POLICY,
    })
    const value = await run(tool, { action: 'self' }, session)
    expect(value['action']).toBe('self')
    expect(value['sessionId']).toBe('child-1')
    expect(value['parentSessionId']).toBe('dispatcher-1')
    expect(value['policy']).toEqual({ id: POLICY.id, version: POLICY.version, sha256: POLICY.sha256 })
    expect((value['open'] as Record<string, unknown>)['runs']).toBe(1)
  })

  it('协议正文在返回值的最后一个键', async () => {
    const session = makeSession('dispatcher-1', [])
    const tool = createDispatchLedgerTool({ cache: createDispatchLedgerCache(), policyFor: () => POLICY })
    const value = await run(tool, { action: 'self' }, session)
    const keys = Object.keys(value)
    expect(keys[keys.length - 1]).toBe('protocol')
    expect(value['protocol']).toBe(DISPATCH_MANDATE_PROTOCOL)
  })

  it('协议正文在渲染文本的尾部', async () => {
    const session = makeSession('dispatcher-1', [])
    const tool = createDispatchLedgerTool({ cache: createDispatchLedgerCache(), policyFor: () => POLICY })
    const args = { action: 'self' }
    const value = await run(tool, args, session)
    const text = render(tool, args, value)
    expect(text.endsWith(DISPATCH_MANDATE_PROTOCOL)).toBe(true)
  })

  it('会话缺席时不报错，只是没有父会话', async () => {
    const tool = createDispatchLedgerTool({ cache: createDispatchLedgerCache(), policyFor: () => POLICY })
    const value = await run(tool, { action: 'self' }, makeSession('x', []))
    expect(value['sessionId']).toBe('x')
    expect(value['parentSessionId']).toBeUndefined()
  })
})

describe('dispatch_ledger 工具：action=ledger', () => {
  it('列出账本条目', async () => {
    const prompt = withHeader(dispatchFields())
    const session = makeSession('dispatcher-1', [
      nativeCall(1, 'call-a', prompt),
      nativeResult(2, 'call-a', false, 'started'),
    ])
    const tool = createDispatchLedgerTool({ cache: createDispatchLedgerCache(), policyFor: () => POLICY })
    const value = await run(tool, { action: 'ledger' }, session)
    const entries = value['entries'] as Record<string, unknown>[]
    expect(entries).toHaveLength(1)
    expect(entries[0]?.['brief_id']).toBe('b-7f')
    expect(entries[0]?.['state']).toBe('booked')
    expect(value['truncated']).toBe(false)
  })

  it('支持按工作项与状态过滤', async () => {
    const prompt = withHeader(dispatchFields())
    const other = withHeader(dispatchFields({ brief_id: 'b-other', run_id: 'r-2', idem: 'i-2' }))
    const session = makeSession('dispatcher-1', [
      nativeCall(1, 'call-a', prompt),
      nativeCall(2, 'call-b', other),
      nativeResult(3, 'call-b', true, 'Error: boom'),
    ])
    const tool = createDispatchLedgerTool({ cache: createDispatchLedgerCache(), policyFor: () => POLICY })
    const filtered = await run(tool, { action: 'ledger', brief_id: 'b-other' }, session)
    expect((filtered['entries'] as unknown[])).toHaveLength(1)
    const byState = await run(tool, { action: 'ledger', state: 'released' }, session)
    expect((byState['entries'] as Record<string, unknown>[])[0]?.['brief_id']).toBe('b-other')
    const unsettled = await run(tool, { action: 'ledger', state: 'unsettled' }, session)
    expect((unsettled['entries'] as Record<string, unknown>[])[0]?.['brief_id']).toBe('b-7f')
  })

  it('limit 生效并报告截断', async () => {
    const events: DispatchLedgerEventLike[] = []
    for (let index = 0; index < 5; index += 1) {
      const prompt = withHeader(dispatchFields({ brief_id: 'b-' + index, run_id: 'r-1', idem: 'i-1' }))
      events.push(nativeCall(index * 2 + 1, 'call-' + index, prompt))
      events.push(nativeResult(index * 2 + 2, 'call-' + index, false, 'started'))
    }
    const session = makeSession('dispatcher-1', events)
    const tool = createDispatchLedgerTool({ cache: createDispatchLedgerCache(), policyFor: () => POLICY })
    const value = await run(tool, { action: 'ledger', limit: 2 }, session)
    expect((value['entries'] as unknown[])).toHaveLength(2)
    expect(value['truncated']).toBe(true)
  })

  it('limit 被夹在 1..200 之间', async () => {
    const session = makeSession('dispatcher-1', [])
    const tool = createDispatchLedgerTool({ cache: createDispatchLedgerCache(), policyFor: () => POLICY })
    const value = await run(tool, { action: 'ledger', limit: 5000 }, session)
    expect(value['truncated']).toBe(false)
    expect(DISPATCH_LEDGER_MAX_LIMIT).toBe(200)
  })

  it('tree 范围把后代子代理的条目也带上', async () => {
    const prompt = withHeader(dispatchFields())
    const parent = makeSession('dispatcher-1', [nativeCall(1, 'call-a', prompt)])
    const child = makeSession('child-1', [], 'dispatcher-1')
    const sessions: DispatchLedgerSessions = {
      get: (id: string) => (id === 'dispatcher-1' ? parent : child),
      list: () => [parent, child],
    }
    const tool = createDispatchLedgerTool({
      cache: createDispatchLedgerCache(),
      sessions: () => sessions,
      policyFor: () => POLICY,
    })
    const scoped = await run(tool, { action: 'ledger', scope: 'session' }, parent)
    expect((scoped['entries'] as unknown[])).toHaveLength(1)
    const tree = await run(tool, { action: 'ledger', scope: 'tree' }, parent)
    expect(tree['scope']).toBe('tree')
  })
})

describe('dispatch_ledger 工具：只读与装配', () => {
  it('查询不追加任何会话事件', async () => {
    const prompt = withHeader(dispatchFields())
    const events: DispatchLedgerEventLike[] = [nativeCall(1, 'call-a', prompt)]
    const session = makeSession('dispatcher-1', events)
    const tool = createDispatchLedgerTool({ cache: createDispatchLedgerCache(), policyFor: () => POLICY })
    await run(tool, { action: 'self' }, session)
    await run(tool, { action: 'ledger' }, session)
    expect(events).toHaveLength(1)
    expect(session.snapshotEvents?.()).toHaveLength(1)
  })

  it('装配：一次性注册一个工具并装一台守卫', () => {
    const registered: unknown[] = []
    const guards: unknown[] = []
    const ctx = {
      tools: {
        register: (definition: unknown) => {
          registered.push(definition)
          return () => undefined
        },
        guard: (guard: unknown) => {
          guards.push(guard)
          return () => undefined
        },
      },
    }
    const dispose = installDispatchLedger(ctx, {})
    expect(registered).toHaveLength(1)
    expect(guards).toHaveLength(1)
    expect(typeof dispose).toBe('function')
  })

  it('宿主没有 tools 服务时装配是空操作', () => {
    const dispose = installDispatchLedger({}, {})
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
  })
})

describe('dispatch_ledger 工具：safe sessions resolver', () => {
  it('sessions 解析器抛错时被统一兜住：工具与守卫照常工作', async () => {
    const registered: Record<string, unknown>[] = []
    const guards: ((execution: Record<string, unknown>) => string | undefined)[] = []
    const ctx = {
      tools: {
        register: (definition: Record<string, unknown>) => {
          registered.push(definition)
          return () => undefined
        },
        guard: (guard: (execution: Record<string, unknown>) => string | undefined) => {
          guards.push(guard)
          return () => undefined
        },
      },
    }
    const dispose = installDispatchLedger(ctx, {
      sessions: () => {
        throw new Error('old host has no sessions service')
      },
    })
    const tool = registered[0] as unknown as ReturnType<typeof createDispatchLedgerTool>
    const session = makeSession('dispatcher-1', [])
    const value = await run(tool, { action: 'self' }, session)
    expect(value['sessionId']).toBe('dispatcher-1')
    const denial = guards[0]?.({
      name: 'subagent',
      arguments: { prompt: MANDATE_FENCE_OPEN + '\n{bad}\n' + MANDATE_FENCE_CLOSE },
      agent: { session },
      callId: 'call-a',
    })
    expect(denial).toContain('MANDATE_MALFORMED')
    dispose()
  })

  it('sessions 解析器返回 undefined 时同样照常工作', async () => {
    const registered: Record<string, unknown>[] = []
    const ctx = {
      tools: {
        register: (definition: Record<string, unknown>) => {
          registered.push(definition)
          return () => undefined
        },
        guard: () => () => undefined,
      },
    }
    installDispatchLedger(ctx, { sessions: () => undefined })
    const tool = registered[0] as unknown as ReturnType<typeof createDispatchLedgerTool>
    const value = await run(tool, { action: 'self' }, makeSession('dispatcher-1', []))
    expect(value['sessionId']).toBe('dispatcher-1')
  })
})

describe('dispatch_ledger 工具：环境 prompt_ref', () => {
  it('self 的返回值带 prompt_ref，且排在协议之前', async () => {
    const tool = createDispatchLedgerTool({
      cache: createDispatchLedgerCache(),
      policyFor: () => POLICY,
      promptRef: 'p-abc123def456',
    })
    const value = await run(tool, { action: 'self' }, makeSession('dispatcher-1', []))
    expect(value['prompt_ref']).toBe('p-abc123def456')
    const keys = Object.keys(value)
    expect(keys.indexOf('prompt_ref')).toBeGreaterThanOrEqual(0)
    expect(keys.indexOf('prompt_ref')).toBeLessThan(keys.length - 1)
    expect(keys[keys.length - 1]).toBe('protocol')
  })

  it('render 里 prompt_ref 排在协议之前', async () => {
    const tool = createDispatchLedgerTool({
      cache: createDispatchLedgerCache(),
      policyFor: () => POLICY,
      promptRef: 'p-abc123def456',
    })
    const args = { action: 'self' }
    const value = await run(tool, args, makeSession('dispatcher-1', []))
    const text = render(tool, args, value)
    expect(text).toContain('p-abc123def456')
    expect(text.indexOf('p-abc123def456')).toBeLessThan(text.indexOf(DISPATCH_MANDATE_PROTOCOL))
    expect(text.endsWith(DISPATCH_MANDATE_PROTOCOL)).toBe(true)
  })

  it('output schema 声明 prompt_ref', () => {
    const tool = createDispatchLedgerTool({
      cache: createDispatchLedgerCache(),
      policyFor: () => POLICY,
      promptRef: 'p-abc123def456',
    })
    const schema = tool.output?.schema as unknown as {
      properties: Record<string, unknown>
    }
    expect(schema.properties['prompt_ref']).toEqual({ type: 'string' })
  })

  it('未注入 prompt_ref 时降级：字段缺省而不是瞎编', async () => {
    const tool = createDispatchLedgerTool({
      cache: createDispatchLedgerCache(),
      policyFor: () => POLICY,
    })
    const value = await run(tool, { action: 'self' }, makeSession('dispatcher-1', []))
    expect(value['prompt_ref']).toBeUndefined()
  })
})

/** 抽出一段文本里的全部 mandate 围栏块（不含围栏本身）。 */
function fencesOf(text: string): string[] {
  return [...text.matchAll(/```dsh-mandate-v2\n([\s\S]*?)\n```/g)].map(match => match[1] ?? '')
}

/** 把一段围栏内容还原成解析结果。 */
function parseFence(json: string) {
  return parseMandateHeader(MANDATE_FENCE_OPEN + '\n' + json + '\n' + MANDATE_FENCE_CLOSE + '\nbody')
}

/** 子代理自己的提示词事件（Mandate 就藏在这里）。 */
function childPrompt(seq: number, prompt: string): DispatchLedgerEventLike {
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    data: { content: [{ type: 'text', text: prompt }] },
  }
}

describe('dispatch_ledger 工具：可复制的头部骨架', () => {
  it('协调者拿到 dispatch 骨架，且它就是一份合法头部', async () => {
    const tool = createDispatchLedgerTool({
      cache: createDispatchLedgerCache(),
      policyFor: () => POLICY,
      promptRef: 'p-abc123def456',
    })
    const args = { action: 'self' }
    const value = await run(tool, args, makeSession('dispatcher-1', []))
    const text = render(tool, args, value)
    const parsed = fencesOf(text).map(parseFence)
    expect(parsed.length, 'self 没有给出可复制的骨架').toBeGreaterThan(0)
    for (const entry of parsed) expect(entry.state).toBe('ok')
    expect(parsed[0]?.header?.kind).toBe('dispatch')
    expect(parsed[0]?.header?.prompt_ref).toBe('p-abc123def456')
    expect(parsed[0]?.header?.policy?.sha256).toBe(POLICY.sha256)
    expect(text.endsWith(DISPATCH_MANDATE_PROTOCOL)).toBe(true)
  })

  it('每次渲染都现造 ids：照抄两次也不会撞命名空间', async () => {
    const tool = createDispatchLedgerTool({
      cache: createDispatchLedgerCache(),
      policyFor: () => POLICY,
      promptRef: 'p-abc123def456',
    })
    const args = { action: 'self' }
    const first = fencesOf(render(tool, args, await run(tool, args, makeSession('dispatcher-1', []))))
    const second = fencesOf(render(tool, args, await run(tool, args, makeSession('dispatcher-1', []))))
    expect(first[0]).not.toBe(second[0])
  })

  it('子代理拿到 report 骨架，ids 就是它自己那份 mandate 的', async () => {
    const prompt = withHeader(dispatchFields())
    const session = makeSession('child-1', [childPrompt(1, prompt)], 'dispatcher-1')
    const tool = createDispatchLedgerTool({
      cache: createDispatchLedgerCache(),
      policyFor: () => POLICY,
      promptRef: 'plan-v3',
    })
    const args = { action: 'self' }
    const value = await run(tool, args, session)
    const parsed = fencesOf(render(tool, args, value)).map(parseFence)
    const report = parsed.find(entry => entry.header?.kind === 'report')
    expect(report?.state, 'self 没有给出合法的 report 骨架').toBe('ok')
    expect(report?.header?.brief_id).toBe('b-7f')
    expect(report?.header?.run_id).toBe('r-1')
    expect(report?.header?.idem).toBe('i-1')
    expect(report?.header?.status).toBe('ready')
  })

  it('宿主没给 policy / prompt_ref 时不硬造骨架', () => {
    const tool = createDispatchLedgerTool({ cache: createDispatchLedgerCache() })
    const text = render(tool, { action: 'self' }, {
      action: 'self',
      sessionId: 's-1',
      open: { runs: 0, briefs: 0, runsFull: false, briefsFull: false },
      protocol: DISPATCH_MANDATE_PROTOCOL,
    })
    // 协议正文自带一段样板，所以只看骨架区（协议之前）有没有多出来的围栏。
    const head = text.split(DISPATCH_MANDATE_PROTOCOL)[0] ?? ''
    expect(fencesOf(head)).toHaveLength(0)
    expect(text.endsWith(DISPATCH_MANDATE_PROTOCOL)).toBe(true)
  })
})
