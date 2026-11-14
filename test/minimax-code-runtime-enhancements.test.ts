import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REMIND_AFTER_OCCURRENCES,
  DIRECT_CALL_REMINDER_TOOLS,
  MINIMAX_CODE_PROVIDER,
  createMinimaxRunawayGuard,
  installMinimaxRuntimeEnhancements,
  isPtcSessionOf,
  minimaxSessionRouteOf,
  renderDirectCallReminder,
  renderExactActionRepeatReminder,
  renderPollingRepeatReminder,
  renderSameErrorFamilyReminder,
  repairMinimaxToolArguments,
  type MinimaxRuntimeEnhancementsContext,
} from '../src/host/minimax-code/runtime-enhancements.ts'

/** 一条 post-execute 决策。 */
interface Decision {
  kind: 'accept' | 'block'
  value?: unknown
  content?: unknown
  feedback?: unknown
  additionalContexts?: { content: readonly { type: string; text?: string }[]; source: { kind: string } }[]
}

/** 造一台 MiniMax Code 会话里的 agent。 */
function minimaxAgent(id = 'session-1'): Record<string, unknown> {
  return {
    id,
    session: {
      header: { id },
      requestHeader: () => ({ config: { provider: MINIMAX_CODE_PROVIDER } }),
    },
  }
}

/** 造一条别的线路的 agent。 */
function otherAgent(id = 'session-2'): Record<string, unknown> {
  return {
    id,
    session: {
      header: { id },
      requestHeader: () => ({ config: { provider: 'kimi-code' } }),
    },
  }
}

/** 假宿主：记录守卫与事件监听器。 */
function fakeHost(options: { ptc?: boolean; schemas?: Record<string, unknown>; runawayEnabled?: () => boolean } = {}) {
  const listeners = new Map<string, ((...args: never[]) => unknown)[]>()
  const guards: ((execution: unknown) => string | undefined)[] = []
  const tools = {
    guard: (guard: (execution: unknown) => string | undefined) => {
      guards.push(guard)
      return () => undefined
    },
    get: (name: string) => {
      if (name === 'run_code') return options.ptc === true ? { name: 'run_code' } : undefined
      return options.schemas?.[name]
    },
  }
  const ctx = {
    effect: (execute: () => unknown) => {
      execute()
      return () => undefined
    },
    on: (event: string, listener: (...args: never[]) => unknown) => {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      return () => {
        const current = listeners.get(event) ?? []
        listeners.set(event, current.filter(entry => entry !== listener))
      }
    },
    get: (name: string) => (name === 'tools' ? tools : undefined),
    tools,
  } as unknown as MinimaxRuntimeEnhancementsContext
  const dispose = installMinimaxRuntimeEnhancements(ctx, {
    ...(options.runawayEnabled === undefined ? {} : { runawayEnabled: options.runawayEnabled }),
  })
  return {
    ctx,
    tools,
    guards,
    dispose,
    listenerOf: (event: string) => listeners.get(event)?.[0],
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
  }
}

/** 跑一次 post-execute 瀑布。 */
async function runPostExecute(
  host: ReturnType<typeof fakeHost>,
  exec: Record<string, unknown>,
  result: Record<string, unknown> = {},
): Promise<Decision> {
  const listener = host.listenerOf('tools/post-execute')
  expect(listener, 'post-execute 监听器').toBeTypeOf('function')
  const decision = await (listener as unknown as (
    e: unknown,
    r: unknown,
    next: () => Promise<Decision>,
  ) => Promise<Decision>)(exec, result, async () => ({ kind: 'accept' }))
  return decision
}

/** 取一条决策上的附加上下文正文。 */
function contextTexts(decision: Decision): string[] {
  return (decision.additionalContexts ?? []).map(context =>
    (context.content ?? []).map(block => block.text ?? '').join(''),
  )
}

describe('MiniMax 运行时增强：线路判定', () => {
  it('请求头的 provider 优先', () => {
    const route = minimaxSessionRouteOf({
      session: { requestHeader: () => ({ config: { provider: 'minimax-code' } }) },
      options: { provider: 'kimi-code' },
    })
    expect(route.provider).toBe('minimax-code')
  })

  it('请求头没有 provider 时退回模型选择面', () => {
    const route = minimaxSessionRouteOf({
      session: { requestHeader: () => ({ config: {} }) },
      model: { current: () => ({ provider: 'minimax-code' }) },
      options: { provider: 'kimi-code' },
    })
    expect(route.provider).toBe('minimax-code')
  })

  it('再退回 agent 选项', () => {
    const route = minimaxSessionRouteOf({ options: { provider: 'minimax-code' } })
    expect(route.provider).toBe('minimax-code')
  })

  it('最后退回 agent 自身的 provider 字段', () => {
    const route = minimaxSessionRouteOf({ provider: 'minimax-code' })
    expect(route.provider).toBe('minimax-code')
  })

  it('请求头抛错不影响其余来源', () => {
    const route = minimaxSessionRouteOf({
      session: {
        requestHeader: () => {
          throw new Error('session is closing')
        },
      },
      options: { provider: 'minimax-code' },
    })
    expect(route.provider).toBe('minimax-code')
  })

  it('会话 id 认会话头，没有时用 agent 自己的 id', () => {
    expect(minimaxSessionRouteOf({ session: { header: { id: 'from-header' } }, id: 'from-agent' }).sessionId)
      .toBe('from-header')
    expect(minimaxSessionRouteOf({ id: 'from-agent' }).sessionId).toBe('from-agent')
  })
})

describe('MiniMax 运行时增强：参数修复', () => {
  it('edits 是 JSON 字符串时解析回数组', () => {
    const repaired = repairMinimaxToolArguments('edit', {
      file_path: 'a.ts',
      edits: '[{"oldText":"a","newText":"b"}]',
    })
    expect(repaired.fixes).toEqual(['edits_json_string'])
    expect((repaired.value as { edits: unknown }).edits).toEqual([{ oldText: 'a', newText: 'b' }])
  })

  it('edits 的 JSON 解析失败时原样留着', () => {
    const args = { file_path: 'a.ts', edits: 'not json' }
    const repaired = repairMinimaxToolArguments('edit', args)
    expect(repaired.fixes).toEqual([])
    expect((repaired.value as { edits: unknown }).edits).toBe('not json')
  })

  it('edits 解析出来不是数组时不改', () => {
    const repaired = repairMinimaxToolArguments('edit', { edits: '{"a":1}' })
    expect(repaired.fixes).toEqual([])
    expect((repaired.value as { edits: unknown }).edits).toBe('{"a":1}')
  })

  it('schema 说数组而值是 { item: [...] } 时拆包', () => {
    const repaired = repairMinimaxToolArguments('edit', {
      edits: { item: [{ oldText: 'a', newText: 'b' }] },
    }, {
      type: 'object',
      properties: { edits: { type: 'array' } },
    })
    expect(repaired.fixes).toEqual(['item_wrapper'])
    expect((repaired.value as { edits: unknown }).edits).toEqual([{ oldText: 'a', newText: 'b' }])
  })

  it('schema 说数组而值是 { item: X }（X 不是数组）时包成单元素数组', () => {
    const repaired = repairMinimaxToolArguments('edit', {
      edits: { item: { oldText: 'a', newText: 'b' } },
    }, {
      type: 'object',
      properties: { edits: { type: 'array' } },
    })
    expect(repaired.fixes).toEqual(['item_wrapper'])
    expect((repaired.value as { edits: unknown }).edits).toEqual([{ oldText: 'a', newText: 'b' }])
  })

  it('schema 说 number 时把数字字符串转成数字', () => {
    const repaired = repairMinimaxToolArguments('read', { offset: '42' }, {
      type: 'object',
      properties: { offset: { type: 'number' } },
    })
    expect(repaired.fixes).toEqual(['number_string'])
    expect((repaired.value as { offset: unknown }).offset).toBe(42)
  })

  it('schema 说 integer 时无损的整数才转', () => {
    const repaired = repairMinimaxToolArguments('read', { offset: '2.5' }, {
      type: 'object',
      properties: { offset: { type: 'integer' } },
    })
    expect(repaired.fixes).toEqual([])
    expect((repaired.value as { offset: unknown }).offset).toBe('2.5')
  })

  it('schema 说 boolean 时把 true/false 字符串转成布尔', () => {
    const repaired = repairMinimaxToolArguments('edit', { replace_all: 'true' }, {
      type: 'object',
      properties: { replace_all: { type: 'boolean' } },
    })
    expect(repaired.fixes).toEqual(['boolean_string'])
    expect((repaired.value as { replace_all: unknown }).replace_all).toBe(true)
  })

  it('递归进 properties 与 items', () => {
    const repaired = repairMinimaxToolArguments('edit', {
      outer: { inner: '7' },
      list: ['1', '2'],
    }, {
      type: 'object',
      properties: {
        outer: { type: 'object', properties: { inner: { type: 'number' } } },
        list: { type: 'array', items: { type: 'number' } },
      },
    })
    expect(repaired.fixes).toEqual(['number_string', 'number_string', 'number_string'])
    const value = repaired.value as { outer: { inner: unknown }; list: unknown[] }
    expect(value.outer.inner).toBe(7)
    expect(value.list).toEqual([1, 2])
  })

  it('没有 schema 时按字段名强转顶层数字字段', () => {
    const repaired = repairMinimaxToolArguments('read', { offset: '10', limit: '20' })
    expect(repaired.fixes).toEqual(['number_string', 'number_string'])
    const value = repaired.value as { offset: unknown; limit: unknown }
    expect(value.offset).toBe(10)
    expect(value.limit).toBe(20)
  })

  it('没有 schema 时按字段名强转顶层布尔字段', () => {
    const repaired = repairMinimaxToolArguments('edit', { replace_all: 'false' })
    expect(repaired.fixes).toEqual(['boolean_string'])
    expect((repaired.value as { replace_all: unknown }).replace_all).toBe(false)
  })

  it('入参不被修改', () => {
    const args = { edits: '[1,2]' }
    repairMinimaxToolArguments('edit', args)
    expect(args.edits).toBe('[1,2]')
  })

  it('非对象参数原样返回', () => {
    expect(repairMinimaxToolArguments('edit', 'not an object')).toEqual({ value: 'not an object', fixes: [] })
    expect(repairMinimaxToolArguments('edit', [1, 2]).fixes).toEqual([])
  })
})

describe('MiniMax 运行时增强：PTC 直调提醒', () => {
  it('单个工具名用 it', () => {
    const text = renderDirectCallReminder(['read'])
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('Do not call read directly in this turn.')
    expect(text).toContain('Call it inside run_code:')
    expect(text).toContain('await tools.read(')
    expect(text).toContain('Put your next tool calls in one run_code program.')
    expect(text.endsWith('</system-reminder>')).toBe(true)
  })

  it('多个工具名用 them', () => {
    const text = renderDirectCallReminder(['read', 'edit'])
    expect(text).toContain('Do not call read, edit directly in this turn.')
    expect(text).toContain('Call them inside run_code:')
  })

  it('空名单也给出可读提醒', () => {
    const text = renderDirectCallReminder([])
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('run_code')
  })
})

describe('MiniMax 运行时增强：工具级失控守卫', () => {
  it('默认三次连击', () => {
    expect(DEFAULT_REMIND_AFTER_OCCURRENCES).toBe(3)
  })

  it('三次同样的动作给出 exact_action_repeat 提醒', () => {
    const guard = createMinimaxRunawayGuard()
    expect(guard.observe({ toolName: 'read', arguments: { file_path: 'a.ts' } })).toBeUndefined()
    expect(guard.observe({ toolName: 'read', arguments: { file_path: 'a.ts' } })).toBeUndefined()
    const reminder = guard.observe({ toolName: 'read', arguments: { file_path: 'a.ts' } })
    expect(reminder?.kind).toBe('exact_action_repeat')
    expect(reminder?.occurrences).toBe(3)
    expect(reminder?.text).toBe(renderExactActionRepeatReminder(3))
    expect(reminder?.text).toContain('[runaway guard] The immediately repeated tool action has now occurred 3 times')
  })

  it('参数变了就不算连击', () => {
    const guard = createMinimaxRunawayGuard()
    guard.observe({ toolName: 'read', arguments: { file_path: 'a.ts' } })
    guard.observe({ toolName: 'read', arguments: { file_path: 'b.ts' } })
    expect(guard.observe({ toolName: 'read', arguments: { file_path: 'a.ts' } })).toBeUndefined()
  })

  it('同一个工具连续三次同族错误给出 same_error_family 提醒', () => {
    const guard = createMinimaxRunawayGuard()
    const failure = { isError: true, errorText: 'Error: file not found' }
    guard.observe({ toolName: 'read', ...failure })
    guard.observe({ toolName: 'read', ...failure })
    const reminder = guard.observe({ toolName: 'read', ...failure })
    expect(reminder?.kind).toBe('same_error_family')
    expect(reminder?.text).toBe(renderSameErrorFamilyReminder(3))
    expect(reminder?.text).toContain('[runaway guard] The same tool error family has now occurred 3 times in a row.')
  })

  it('工具成功一次后错误连击归零', () => {
    const guard = createMinimaxRunawayGuard()
    const failure = { isError: true, errorText: 'Error: file not found' }
    guard.observe({ toolName: 'read', ...failure })
    guard.observe({ toolName: 'read', ...failure })
    guard.observe({ toolName: 'read' })
    guard.observe({ toolName: 'read', ...failure })
    expect(guard.observe({ toolName: 'read', ...failure })).toBeUndefined()
  })

  it('三次不变的轮询给出 polling_repeat 提醒', () => {
    const guard = createMinimaxRunawayGuard()
    const poll = { toolName: 'job_output', arguments: { job_id: 'j1' }, resultText: 'running' }
    guard.observe(poll)
    guard.observe(poll)
    const reminder = guard.observe(poll)
    expect(reminder?.kind).toBe('polling_repeat')
    expect(reminder?.text).toBe(renderPollingRepeatReminder(3))
    expect(reminder?.text).toContain('Three task_output reads for the same task')
  })

  it('wait: true 是等它结束，不算轮询', () => {
    const guard = createMinimaxRunawayGuard()
    const poll = { toolName: 'job_output', arguments: { job_id: 'j1', wait: true }, resultText: 'running' }
    guard.observe(poll)
    guard.observe(poll)
    expect(guard.observe(poll)).toBeUndefined()
  })

  it('每轮至多一条提醒', () => {
    const guard = createMinimaxRunawayGuard()
    const call = { toolName: 'read', arguments: { file_path: 'a.ts' } }
    guard.observe(call)
    guard.observe(call)
    expect(guard.observe(call)).toBeDefined()
    expect(guard.observe(call)).toBeUndefined()
  })

  it('reset 之后可以再提醒一次', () => {
    const guard = createMinimaxRunawayGuard()
    const call = { toolName: 'read', arguments: { file_path: 'a.ts' } }
    guard.observe(call)
    guard.observe(call)
    guard.observe(call)
    guard.reset()
    guard.observe(call)
    guard.observe(call)
    expect(guard.observe(call)).toBeDefined()
  })

  it('A B A B 的循环只记录不提醒', () => {
    const guard = createMinimaxRunawayGuard()
    const a = { toolName: 'read', arguments: { file_path: 'a.ts' } }
    const b = { toolName: 'read', arguments: { file_path: 'b.ts' } }
    guard.observe(a)
    guard.observe(b)
    guard.observe(a)
    const reminder = guard.observe(b)
    expect(guard.signals.some(signal => signal.kind === 'abab_action_cycle')).toBe(true)
    // A B A B 之后是两次 b 连击，还差一次才到阈值。
    expect(reminder).toBeUndefined()
  })
})

describe('MiniMax 运行时增强：装配', () => {
  it('非 MiniMax 线路的调用一律不碰', async () => {
    const host = fakeHost()
    const agent = otherAgent()
    expect(host.guards[0]?.({ name: 'edit', arguments: { edits: '[1]' }, agent })).toBeUndefined()
    const decision = await runPostExecute(host, { name: 'read', arguments: {}, agent })
    expect(contextTexts(decision)).toEqual([])
  })

  it('MiniMax 线路的守卫修参数但绝不拦', () => {
    const host = fakeHost()
    const agent = minimaxAgent()
    const args: Record<string, unknown> = { edits: '[{"oldText":"a","newText":"b"}]' }
    const reason = host.guards[0]?.({ name: 'edit', arguments: args, agent })
    expect(reason).toBeUndefined()
    expect((args.edits as unknown[])).toEqual([{ oldText: 'a', newText: 'b' }])
  })

  it('runawayEnabled 返回 false 时旁路失控提醒但保留参数修复', async () => {
    const host = fakeHost({ runawayEnabled: () => false })
    const agent = minimaxAgent()
    const args: Record<string, unknown> = { edits: '[{"oldText":"a","newText":"b"}]' }
    expect(host.guards[0]?.({ name: 'edit', arguments: args, agent })).toBeUndefined()
    expect((args.edits as unknown[])).toEqual([{ oldText: 'a', newText: 'b' }])

    const call = { name: 'read', arguments: { file_path: 'a.ts' }, agent }
    for (let index = 0; index < 4; index += 1) {
      const decision = await runPostExecute(host, call)
      expect(contextTexts(decision)).toEqual([])
    }
  })

  it('PTC 会话里直接调原生工具时注入直调提醒', async () => {
    const host = fakeHost({ ptc: true })
    const agent = minimaxAgent()
    const decision = await runPostExecute(host, { name: 'read', arguments: { file_path: 'a.ts' }, agent })
    const texts = contextTexts(decision)
    expect(texts.some(text => text.includes('Do not call read directly in this turn.'))).toBe(true)
  })

  it('嵌套调用（run_code 里的子调用）不注入直调提醒', async () => {
    const host = fakeHost({ ptc: true })
    const agent = minimaxAgent()
    const decision = await runPostExecute(host, {
      name: 'read',
      arguments: { file_path: 'a.ts' },
      agent,
      parent: {},
    })
    expect(contextTexts(decision).some(text => text.includes('Do not call read directly'))).toBe(false)
  })

  it('非 PTC 会话不注入直调提醒', async () => {
    const host = fakeHost({ ptc: false })
    const agent = minimaxAgent()
    const decision = await runPostExecute(host, { name: 'read', arguments: { file_path: 'a.ts' }, agent })
    expect(contextTexts(decision).some(text => text.includes('Do not call read directly'))).toBe(false)
  })

  it('三次同样的调用注入失控守卫提醒', async () => {
    const host = fakeHost()
    const agent = minimaxAgent()
    const call = { name: 'read', arguments: { file_path: 'a.ts' }, agent }
    await runPostExecute(host, call)
    await runPostExecute(host, call)
    const decision = await runPostExecute(host, call)
    const texts = contextTexts(decision)
    expect(texts.some(text => text.includes('[runaway guard] The immediately repeated tool action'))).toBe(true)
  })

  it('新的用户输入把连击计数归零', async () => {
    const host = fakeHost()
    const agent = minimaxAgent()
    const call = { name: 'read', arguments: { file_path: 'a.ts' }, agent }
    await runPostExecute(host, call)
    await runPostExecute(host, call)
    const preStep = host.listenerOf('agent/pre-step')
    expect(preStep).toBeTypeOf('function')
    await (preStep as unknown as (
      payload: unknown,
      next: () => Promise<unknown>,
    ) => Promise<unknown>)(
      { agent, messages: [{ role: 'user', source: { kind: 'user' } }] },
      async () => ({ kind: 'accept' }),
    )
    const decision = await runPostExecute(host, call)
    expect(contextTexts(decision)).toEqual([])
  })

  it('agent/disposed 把这台会话的守卫带走', async () => {
    const host = fakeHost()
    const agent = minimaxAgent()
    const disposed = host.listenerOf('agent/disposed')
    expect(disposed).toBeTypeOf('function')
    ;(disposed as unknown as (payload: unknown) => void)({ agent })
  })

  it('卸载后监听器被注销', () => {
    const host = fakeHost()
    expect(host.listenerCount('tools/post-execute')).toBe(1)
    host.dispose()
    expect(host.listenerCount('tools/post-execute')).toBe(0)
    expect(host.listenerCount('agent/pre-step')).toBe(0)
    expect(host.listenerCount('agent/disposed')).toBe(0)
  })
})

describe('MiniMax 运行时增强：PTC 判定', () => {
  it('保留通道可见时算 PTC', () => {
    const tools = { get: (name: string) => (name === 'run_code' ? { name } : undefined) }
    expect(isPtcSessionOf(minimaxAgent(), tools)).toBe(true)
  })

  it('保留通道不可见时不算 PTC', () => {
    const tools = { get: () => undefined }
    expect(isPtcSessionOf(minimaxAgent(), tools)).toBe(false)
  })

  it('注册表自己的判定面优先', () => {
    const tools = {
      modeFor: () => 'ptc',
      get: () => undefined,
    }
    expect(isPtcSessionOf(minimaxAgent(), tools)).toBe(true)
  })

  it('读不出任何信息时按不是 PTC 处理', () => {
    expect(isPtcSessionOf(minimaxAgent(), undefined)).toBe(false)
  })
})
