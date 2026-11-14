import { afterEach, describe, expect, it } from 'vitest'
import {
  renderPollingRepeatReminder,
  renderSameErrorFamilyReminder,
} from '../src/host/common/tool-runaway.ts'
import {
  HANDOFF_VETO_TEXT,
  KIMI_CODE_PROVIDER,
  REMINDER_TEXT_1,
  REMINDER_TEXT_3,
  REPEAT_BREAKER_ENV,
  REPEAT_FORCE_STOP_STREAK,
  canonicalKimiToolCallKey,
  createKimiRepeatBreaker,
  installKimiRepeatBreaker,
  isKimiRepeatBreakerEnabled,
  kimiSessionRouteOf,
  makeReminderText2,
  type KimiRepeatBreakerContext,
  type KimiRepeatBreakerOptions,
} from '../src/host/kimi-code/repeat-breaker.ts'

/** 一条 post-execute 决策。 */
interface Decision {
  kind: 'accept' | 'block'
  value?: unknown
  content?: unknown
  feedback?: unknown
  additionalContexts?: { content: readonly { type: string; text?: string }[]; source: { kind: string } }[]
}

/** 一条守卫。 */
type Guard = (execution: unknown) => string | undefined

/** 一条事件监听器。 */
type Listener = (...args: never[]) => unknown

/** 装完就卸：本模块有单实例挂载守卫，不卸会让下一个用例装不上。 */
const disposers: (() => void)[] = []

afterEach(() => {
  while (disposers.length > 0) {
    disposers.pop()?.()
  }
})

/** 造一台 Kimi Code 会话里的 agent。 */
function kimiAgent(id = 'kimi-session-1'): Record<string, unknown> {
  return {
    id,
    session: {
      header: { id },
      requestHeader: () => ({ config: { provider: KIMI_CODE_PROVIDER } }),
    },
  }
}

/** 造一条别的线路的 agent。 */
function otherAgent(id = 'other-session-1'): Record<string, unknown> {
  return providerAgent('minimax-code', id)
}

function providerAgent(provider: string, id = provider + '-session'): Record<string, unknown> {
  return {
    id,
    session: {
      header: { id },
      requestHeader: () => ({ config: { provider } }),
    },
  }
}

/** 假宿主：记录守卫与事件监听器。 */
function fakeHost(options: KimiRepeatBreakerOptions = {}) {
  const listeners = new Map<string, Listener[]>()
  const guards: Guard[] = []
  const tools = {
    guard: (guard: Guard) => {
      guards.push(guard)
      return () => {
        const index = guards.indexOf(guard)
        if (index >= 0) guards.splice(index, 1)
      }
    },
  }
  const ctx = {
    effect: (execute: () => unknown) => {
      execute()
      return () => undefined
    },
    on: (event: string, listener: Listener) => {
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
  } as unknown as KimiRepeatBreakerContext
  const dispose = installKimiRepeatBreaker(ctx, options)
  disposers.push(dispose)
  return {
    ctx,
    tools,
    guards,
    dispose,
    listenerOf: (event: string) => listeners.get(event)?.[0],
  }
}

/** 造一次工具执行。 */
function toolExec(agent: Record<string, unknown>, name: string, args: unknown): Record<string, unknown> {
  return { name, arguments: args, agent }
}

/** 跑一次守卫链：有人拒绝就返回拒绝理由。 */
function guardReason(host: ReturnType<typeof fakeHost>, exec: Record<string, unknown>): string | undefined {
  for (const guard of host.guards) {
    const reason = guard(exec)
    if (reason !== undefined) return reason
  }
  return undefined
}

/** 跑一次 post-execute 瀑布。 */
async function runPostExecute(
  host: ReturnType<typeof fakeHost>,
  exec: Record<string, unknown>,
  result: unknown = { content: [] },
): Promise<Decision> {
  const listener = host.listenerOf('tools/post-execute')
  expect(listener, 'post-execute listener').toBeTypeOf('function')
  const decision = await (listener as unknown as (
    e: unknown,
    r: unknown,
    next: () => Promise<Decision>,
  ) => Promise<Decision>)(exec, result, async () => ({ kind: 'accept' }))
  return decision
}

/** 跑一次 agent/pre-step。 */
async function runPreStep(
  host: ReturnType<typeof fakeHost>,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const listener = host.listenerOf('agent/pre-step')
  expect(listener, 'pre-step listener').toBeTypeOf('function')
  return (listener as unknown as (
    p: unknown,
    next: () => Promise<unknown>,
  ) => Promise<unknown>)(payload, async () => ({ kind: 'continue' }))
}

/** 跑一次 agent/disposed。 */
function runDisposed(host: ReturnType<typeof fakeHost>, payload: Record<string, unknown>): void {
  const listener = host.listenerOf('agent/disposed')
  expect(listener, 'disposed listener').toBeTypeOf('function')
  ;(listener as unknown as (p: unknown) => void)(payload)
}

/** 取一条决策上的附加上下文正文。 */
function contextTexts(decision: Decision): string[] {
  return (decision.additionalContexts ?? []).map(context =>
    (context.content ?? []).map(block => block.text ?? '').join(''),
  )
}

describe('Kimi 重复刹车：四段提醒', () => {
  it('1-2 次连击不提醒', () => {
    const breaker = createKimiRepeatBreaker()
    expect(breaker.recordAfterExecute('s', 'read', { path: 'a' })).toBeUndefined()
    expect(breaker.recordAfterExecute('s', 'read', { path: 'a' })).toBeUndefined()
  })

  it('3-4 次连击给第一段提醒', () => {
    const breaker = createKimiRepeatBreaker()
    breaker.recordAfterExecute('s', 'read', { path: 'a' })
    breaker.recordAfterExecute('s', 'read', { path: 'a' })
    expect(breaker.recordAfterExecute('s', 'read', { path: 'a' })).toBe(REMINDER_TEXT_1)
    expect(breaker.recordAfterExecute('s', 'read', { path: 'a' })).toBe(REMINDER_TEXT_1)
  })

  it('5-7 次连击给第二段提醒，且带上当前次数', () => {
    const breaker = createKimiRepeatBreaker()
    for (let index = 0; index < 4; index += 1) {
      breaker.recordAfterExecute('s', 'read', { path: 'a' })
    }
    expect(breaker.recordAfterExecute('s', 'read', { path: 'a' })).toBe(makeReminderText2(5))
    expect(breaker.recordAfterExecute('s', 'read', { path: 'a' })).toBe(makeReminderText2(6))
    expect(breaker.recordAfterExecute('s', 'read', { path: 'a' })).toBe(makeReminderText2(7))
  })

  it('8-11 次连击给第三段提醒', () => {
    const breaker = createKimiRepeatBreaker()
    for (let index = 0; index < 7; index += 1) {
      breaker.recordAfterExecute('s', 'read', { path: 'a' })
    }
    expect(breaker.recordAfterExecute('s', 'read', { path: 'a' })).toBe(REMINDER_TEXT_3)
    for (let index = 0; index < 3; index += 1) {
      expect(breaker.recordAfterExecute('s', 'read', { path: 'a' })).toBe(REMINDER_TEXT_3)
    }
  })

  it('第 12 次连击由执行期守卫接管这一轮', () => {
    const breaker = createKimiRepeatBreaker()
    const args = { path: 'a' }
    for (let index = 0; index < REPEAT_FORCE_STOP_STREAK - 1; index += 1) {
      expect(breaker.checkBeforeExecute('s', 'read', args)).toBeUndefined()
      breaker.recordAfterExecute('s', 'read', args)
    }
    // 第 12 次：执行前就被拦下。
    expect(breaker.checkBeforeExecute('s', 'read', args)).toBe(HANDOFF_VETO_TEXT)
    // 锁住之后，无论什么工具、什么参数都是同一句拒绝。
    expect(breaker.checkBeforeExecute('s', 'read', args)).toBe(HANDOFF_VETO_TEXT)
    expect(breaker.checkBeforeExecute('s', 'write', { path: 'b' })).toBe(HANDOFF_VETO_TEXT)
  })

  it('连击到 12 次之后 handoff 锁住这一轮', () => {
    const breaker = createKimiRepeatBreaker()
    const args = { path: 'a' }
    let last: string | undefined
    for (let index = 0; index < REPEAT_FORCE_STOP_STREAK; index += 1) {
      last = breaker.recordAfterExecute('s', 'read', args)
    }
    expect(last).toBe(REMINDER_TEXT_3)
    expect(breaker.checkBeforeExecute('s', 'read', args)).toBe(HANDOFF_VETO_TEXT)
  })

  it('换一个工具就重新开始计数', () => {
    const breaker = createKimiRepeatBreaker()
    breaker.recordAfterExecute('s', 'read', { path: 'a' })
    breaker.recordAfterExecute('s', 'read', { path: 'a' })
    expect(breaker.recordAfterExecute('s', 'write', { path: 'a' })).toBeUndefined()
  })

  it('两个会话各数各的', () => {
    const breaker = createKimiRepeatBreaker()
    breaker.recordAfterExecute('s1', 'read', { path: 'a' })
    breaker.recordAfterExecute('s1', 'read', { path: 'a' })
    expect(breaker.recordAfterExecute('s2', 'read', { path: 'a' })).toBeUndefined()
    expect(breaker.recordAfterExecute('s1', 'read', { path: 'a' })).toBe(REMINDER_TEXT_1)
  })
})

describe('Kimi 重复刹车：规范键', () => {
  it('键序不同也得到同一个键', () => {
    expect(canonicalKimiToolCallKey('read', { a: 1, b: 2 })).toBe(canonicalKimiToolCallKey('read', { b: 2, a: 1 }))
    expect(canonicalKimiToolCallKey('read', { a: 1, b: 2 })).toBe('read {"a":1,"b":2}')
  })

  it('嵌套对象的键序也被规范化', () => {
    expect(canonicalKimiToolCallKey('read', { x: { p: 1, q: 2 } }))
      .toBe(canonicalKimiToolCallKey('read', { x: { q: 2, p: 1 } }))
  })

  it('数组保持原序', () => {
    expect(canonicalKimiToolCallKey('read', { xs: [1, 2] })).not.toBe(canonicalKimiToolCallKey('read', { xs: [2, 1] }))
  })

  it('参数换了就不是同一个键', () => {
    expect(canonicalKimiToolCallKey('read', { a: 1 })).not.toBe(canonicalKimiToolCallKey('read', { a: 2 }))
  })

  it('参数键序换了也算同一个连击', () => {
    const breaker = createKimiRepeatBreaker()
    breaker.recordAfterExecute('s', 'read', { a: 1, b: 2 })
    breaker.recordAfterExecute('s', 'read', { a: 1, b: 2 })
    expect(breaker.recordAfterExecute('s', 'read', { b: 2, a: 1 })).toBe(REMINDER_TEXT_1)
  })
})

describe('Kimi 重复刹车：豁免工具', () => {
  it('进展更新与待办更新不计入连击', () => {
    const breaker = createKimiRepeatBreaker()
    for (let index = 0; index < 20; index += 1) {
      expect(breaker.recordAfterExecute('s', 'progress_update', { title: 'x' })).toBeUndefined()
      expect(breaker.recordAfterExecute('s', 'todo_write', { todos: [] })).toBeUndefined()
      expect(breaker.recordAfterExecute('s', 'ask_user_question', { questions: [] })).toBeUndefined()
      expect(breaker.recordAfterExecute('s', 'present', { files: [] })).toBeUndefined()
    }
  })

  it('豁免工具不打断也不重置连击', () => {
    const breaker = createKimiRepeatBreaker()
    breaker.recordAfterExecute('s', 'read', { path: 'a' })
    breaker.recordAfterExecute('s', 'read', { path: 'a' })
    expect(breaker.recordAfterExecute('s', 'progress_update', { title: 'x' })).toBeUndefined()
    expect(breaker.recordAfterExecute('s', 'read', { path: 'a' })).toBe(REMINDER_TEXT_1)
  })
})

describe('Kimi 重复刹车：开关', () => {
  it('默认开启', () => {
    expect(isKimiRepeatBreakerEnabled({})).toBe(true)
    expect(isKimiRepeatBreakerEnabled({ KIMI_CODE_REPEAT_BREAKER: '1' })).toBe(true)
    expect(isKimiRepeatBreakerEnabled({ KIMI_CODE_REPEAT_BREAKER: 'yes' })).toBe(true)
  })

  it('明确关掉时才关', () => {
    for (const value of ['0', 'false', 'no', 'off', 'OFF', 'False', 'No']) {
      expect(isKimiRepeatBreakerEnabled({ KIMI_CODE_REPEAT_BREAKER: value })).toBe(false)
    }
  })
})

describe('Kimi 重复刹车：线路判定', () => {
  it('请求头的 provider 优先', () => {
    const route = kimiSessionRouteOf({
      session: { requestHeader: () => ({ config: { provider: 'kimi-code' } }) },
      options: { provider: 'minimax-code' },
    })
    expect(route.provider).toBe('kimi-code')
  })

  it('退回模型选择面', () => {
    expect(kimiSessionRouteOf({ model: { current: () => ({ provider: 'kimi-code' }) } }).provider)
      .toBe('kimi-code')
  })

  it('退回 agent 选项', () => {
    expect(kimiSessionRouteOf({ options: { provider: 'kimi-code' } }).provider).toBe('kimi-code')
  })

  it('退回 agent 自身的 provider 字段', () => {
    expect(kimiSessionRouteOf({ provider: 'kimi-code' }).provider).toBe('kimi-code')
  })

  it('会话 id 优先取会话头', () => {
    expect(kimiSessionRouteOf(kimiAgent('kimi-7')).sessionId).toBe('kimi-7')
  })

  it('会话 id 退回 agent 自己的 id', () => {
    expect(kimiSessionRouteOf({ id: 'agent-1', provider: 'kimi-code' }).sessionId).toBe('agent-1')
  })
})

describe('Kimi 重复刹车：宿主接线', () => {
  it('第 12 次连击被守卫拦下，之后的调用全被锁住', async () => {
    const host = fakeHost()
    const agent = kimiAgent()
    const args = { path: 'a.txt' }
    const reminders: string[] = []

    for (let index = 0; index < REPEAT_FORCE_STOP_STREAK - 1; index += 1) {
      expect(guardReason(host, toolExec(agent, 'read', args))).toBeUndefined()
      const decision = await runPostExecute(host, toolExec(agent, 'read', args))
      reminders.push(...contextTexts(decision))
    }

    // 3..11 次一共九次提醒，且按段升级。
    expect(reminders).toHaveLength(9)
    expect(reminders[0]).toBe(REMINDER_TEXT_1)
    expect(reminders[1]).toBe(REMINDER_TEXT_1)
    expect(reminders[2]).toBe(makeReminderText2(5))
    expect(reminders[4]).toBe(makeReminderText2(7))
    expect(reminders[5]).toBe(REMINDER_TEXT_3)
    expect(reminders[8]).toBe(REMINDER_TEXT_3)

    // 第 12 次：守卫拦下，模型看到的就是这一句拒绝理由。
    expect(guardReason(host, toolExec(agent, 'read', args))).toBe(HANDOFF_VETO_TEXT)
    // 锁住之后，无论什么工具都是同一句拒绝。
    expect(guardReason(host, toolExec(agent, 'read', args))).toBe(HANDOFF_VETO_TEXT)
    expect(guardReason(host, toolExec(agent, 'write', { path: 'b.txt' }))).toBe(HANDOFF_VETO_TEXT)
  })

  it('新一轮用户输入把连击清零', async () => {
    const host = fakeHost()
    const agent = kimiAgent()
    const args = { path: 'a.txt' }
    for (let index = 0; index < REPEAT_FORCE_STOP_STREAK - 1; index += 1) {
      guardReason(host, toolExec(agent, 'read', args))
      await runPostExecute(host, toolExec(agent, 'read', args))
    }
    expect(guardReason(host, toolExec(agent, 'read', args))).toBe(HANDOFF_VETO_TEXT)

    await runPreStep(host, { agent, messages: [{ role: 'user', source: { kind: 'user' } }] })

    expect(guardReason(host, toolExec(agent, 'read', args))).toBeUndefined()
    const decision = await runPostExecute(host, toolExec(agent, 'read', args))
    expect(contextTexts(decision)).toHaveLength(0)
  })

  it('尾部不是真人用户发言时不重置连击', async () => {
    const host = fakeHost()
    const agent = kimiAgent()
    const args = { path: 'a.txt' }
    for (let index = 0; index < REPEAT_FORCE_STOP_STREAK - 1; index += 1) {
      guardReason(host, toolExec(agent, 'read', args))
      await runPostExecute(host, toolExec(agent, 'read', args))
    }

    await runPreStep(host, { agent, messages: [{ role: 'user', source: { kind: 'kimi-repeat-breaker' } }] })

    expect(guardReason(host, toolExec(agent, 'read', args))).toBe(HANDOFF_VETO_TEXT)
  })

  it('会话拆除时连击状态一起清掉', async () => {
    const host = fakeHost()
    const agent = kimiAgent()
    const args = { path: 'a.txt' }
    guardReason(host, toolExec(agent, 'read', args))
    await runPostExecute(host, toolExec(agent, 'read', args))

    runDisposed(host, { agent })

    guardReason(host, toolExec(agent, 'read', args))
    const decision = await runPostExecute(host, toolExec(agent, 'read', args))
    expect(contextTexts(decision)).toHaveLength(0)
  })

  it('KIMI_CODE_REPEAT_BREAKER=0 时刹车完全不工作', async () => {
    const previous = process.env[REPEAT_BREAKER_ENV]
    process.env[REPEAT_BREAKER_ENV] = '0'
    try {
      const host = fakeHost()
      const agent = kimiAgent()
      const args = { path: 'a.txt' }
      for (let index = 0; index < REPEAT_FORCE_STOP_STREAK + 3; index += 1) {
        expect(guardReason(host, toolExec(agent, 'read', args))).toBeUndefined()
        const decision = await runPostExecute(host, toolExec(agent, 'read', args))
        expect(contextTexts(decision)).toHaveLength(0)
      }
    } finally {
      if (previous === undefined) delete process.env[REPEAT_BREAKER_ENV]
      else process.env[REPEAT_BREAKER_ENV] = previous
    }
  })

  it('别的线路完全不受影响', async () => {
    const host = fakeHost()
    const agent = otherAgent()
    const args = { path: 'a.txt' }
    for (let index = 0; index < REPEAT_FORCE_STOP_STREAK + 3; index += 1) {
      expect(guardReason(host, toolExec(agent, 'read', args))).toBeUndefined()
      const decision = await runPostExecute(host, toolExec(agent, 'read', args))
      expect(contextTexts(decision)).toHaveLength(0)
    }
  })

  it('卸载之后守卫不再拦调用', async () => {
    const host = fakeHost()
    const agent = kimiAgent()
    const args = { path: 'a.txt' }
    for (let index = 0; index < REPEAT_FORCE_STOP_STREAK - 1; index += 1) {
      guardReason(host, toolExec(agent, 'read', args))
      await runPostExecute(host, toolExec(agent, 'read', args))
    }
    expect(guardReason(host, toolExec(agent, 'read', args))).toBe(HANDOFF_VETO_TEXT)

    host.dispose()

    expect(guardReason(host, toolExec(agent, 'read', args))).toBeUndefined()
  })
})

describe('共享工具失控治理', () => {
  it('其他线路获得递进提醒，但永远不会继承 Kimi 强停', async () => {
    const host = fakeHost({ providers: ['kimi-code', 'codex-chatgpt'] })
    const agent = providerAgent('codex-chatgpt')
    const args = { path: 'same.txt' }
    for (let index = 0; index < REPEAT_FORCE_STOP_STREAK + 3; index += 1) {
      expect(guardReason(host, toolExec(agent, 'read', args))).toBeUndefined()
      const decision = await runPostExecute(host, toolExec(agent, 'read', args))
      if (index < 2) expect(contextTexts(decision)).toHaveLength(0)
      else expect(contextTexts(decision).length).toBeGreaterThan(0)
    }
  })

  it('同一线路接入时 Kimi 仍保留第 12 次强停', async () => {
    const host = fakeHost({ providers: ['kimi-code', 'codex-chatgpt'] })
    const agent = kimiAgent('shared-kimi')
    const exec = toolExec(agent, 'read', { path: 'same.txt' })
    for (let index = 0; index < REPEAT_FORCE_STOP_STREAK - 1; index += 1) {
      expect(guardReason(host, exec)).toBeUndefined()
      await runPostExecute(host, exec)
    }
    expect(guardReason(host, exec)).toBe(HANDOFF_VETO_TEXT)
  })

  it('全局开关关闭时所有 profile 都旁路', async () => {
    const host = fakeHost({ providers: ['kimi-code', 'codex-chatgpt'], globalEnabled: () => false })
    for (const agent of [kimiAgent('off-kimi'), providerAgent('codex-chatgpt', 'off-codex')]) {
      const exec = toolExec(agent, 'read', { path: 'same.txt' })
      for (let index = 0; index < REPEAT_FORCE_STOP_STREAK + 1; index += 1) {
        expect(guardReason(host, exec)).toBeUndefined()
        expect(contextTexts(await runPostExecute(host, exec))).toHaveLength(0)
      }
    }
  })

  it('不同参数但同一工具连续 3 次同族报错时给出 same_error_family 提醒，成功一次后清零', async () => {
    const host = fakeHost({ providers: ['kimi-code', 'codex-chatgpt', 'glm-coding-plan'] })
    for (const agent of [kimiAgent('err-kimi'), providerAgent('glm-coding-plan', 'err-glm')]) {
      // 1-2 次同族报错：数字归一化后相同，尚未到 3 次不提醒。
      expect(contextTexts(await runPostExecute(
        host,
        toolExec(agent, 'read', { path: 'a1.ts' }),
        { isError: true, error: { message: 'ENOENT: no such file at line 10' } },
      ))).toEqual([])
      expect(contextTexts(await runPostExecute(
        host,
        toolExec(agent, 'read', { path: 'a2.ts' }),
        { isError: true, error: { message: 'ENOENT: no such file at line 25' } },
      ))).toEqual([])
      // 第 3 次回退到 content 文本报错同样命中同一族错误。
      const third = await runPostExecute(
        host,
        toolExec(agent, 'read', { path: 'a3.ts' }),
        { isError: true, content: [{ type: 'text', text: 'ENOENT: no such file at line 99' }] },
      )
      expect(contextTexts(third)).toEqual([renderSameErrorFamilyReminder(3)])

      // 不同工具或不同错误族不互相累加，且成功后清零该工具的错误连击。
      expect(contextTexts(await runPostExecute(
        host,
        toolExec(agent, 'read', { path: 'ok.ts' }),
        { isError: false, content: [{ type: 'text', text: 'ok' }] },
      ))).toEqual([])
      expect(contextTexts(await runPostExecute(
        host,
        toolExec(agent, 'read', { path: 'a4.ts' }),
        { isError: true, error: { message: 'ENOENT: no such file at line 1' } },
      ))).toEqual([])
    }
  })

  it('连续 3 次不变的后台任务轮询给出 polling_repeat 提醒，输出变化或 wait:true 时绝不误拦', async () => {
    const host = fakeHost({ providers: ['kimi-code', 'codex-chatgpt'] })
    const agent = kimiAgent('poll-kimi')

    const pollExec = toolExec(agent, 'job_output', { job_id: 'j1' })
    expect(contextTexts(await runPostExecute(host, pollExec, { content: [{ type: 'text', text: 'running' }] }))).toEqual([])
    expect(contextTexts(await runPostExecute(host, pollExec, { content: [{ type: 'text', text: 'running' }] }))).toEqual([])
    const third = await runPostExecute(host, pollExec, { content: [{ type: 'text', text: 'running' }] })
    expect(contextTexts(third)).toEqual([renderPollingRepeatReminder(3)])

    // 只要输出有递增变化或显式 wait:true，即使连跑 15 次也零提醒且永不触发 Kimi 强停。
    for (let index = 0; index < REPEAT_FORCE_STOP_STREAK + 3; index += 1) {
      expect(guardReason(host, pollExec)).toBeUndefined()
      expect(contextTexts(await runPostExecute(
        host,
        pollExec,
        { content: [{ type: 'text', text: `step ${index}` }] },
      ))).toEqual([])
    }
    const waitExec = toolExec(agent, 'job_output', { job_id: 'j1', wait: true })
    for (let index = 0; index < REPEAT_FORCE_STOP_STREAK + 3; index += 1) {
      expect(guardReason(host, waitExec)).toBeUndefined()
      expect(contextTexts(await runPostExecute(
        host,
        waitExec,
        { content: [{ type: 'text', text: 'waiting' }] },
      ))).toEqual([])
    }
  })

  it('正常的连续多轮不同路径只读调查零提醒、零拦截', async () => {
    const host = fakeHost({ providers: ['kimi-code', 'glm-coding-plan'] })
    for (const agent of [kimiAgent('ro-kimi'), providerAgent('glm-coding-plan', 'ro-glm')]) {
      for (let index = 0; index < 10; index += 1) {
        const exec = toolExec(agent, 'read', { path: `src/file-${index}.ts` })
        expect(guardReason(host, exec)).toBeUndefined()
        const decision = await runPostExecute(host, exec, {
          isError: false,
          content: [{ type: 'text', text: `contents ${index}` }],
        })
        expect(contextTexts(decision)).toEqual([])
      }
    }
  })

  it('新一轮真人用户输入重置 same_error_family 与 polling_repeat 计数', async () => {
    const host = fakeHost({ providers: ['kimi-code', 'codex-chatgpt'] })
    const agent = providerAgent('codex-chatgpt', 'reset-other')

    await runPostExecute(host, toolExec(agent, 'read', { path: 'a.ts' }), { isError: true, error: { message: 'EACCES' } })
    await runPostExecute(host, toolExec(agent, 'read', { path: 'b.ts' }), { isError: true, error: { message: 'EACCES' } })
    await runPostExecute(host, toolExec(agent, 'job_output', { job_id: 'j1' }), { content: [{ type: 'text', text: 'same' }] })
    await runPostExecute(host, toolExec(agent, 'job_output', { job_id: 'j1' }), { content: [{ type: 'text', text: 'same' }] })

    await runPreStep(host, { agent, messages: [{ role: 'user', source: { kind: 'user' } }] })

    expect(contextTexts(await runPostExecute(
      host,
      toolExec(agent, 'read', { path: 'c.ts' }),
      { isError: true, error: { message: 'EACCES' } },
    ))).toEqual([])
    expect(contextTexts(await runPostExecute(
      host,
      toolExec(agent, 'job_output', { job_id: 'j1' }),
      { content: [{ type: 'text', text: 'same' }] },
    ))).toEqual([])
  })
})
