import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import PlanModeController, {
  APPROVE_LABEL,
  EXIT_PLAN_MODE,
  KEEP_PLANNING_LABEL,
  LEGACY_PLAN_STATE_VERSION,
  PLAN_POLICY_SECTION,
  PLAN_STATE_VERSION,
  REVIEW_ID,
  createPlanProjectionDefinition,
  planProjectionDefinition,
  resolveConfig,
} from '../src/entry-plan-mode.ts'
import { installPlanModeCacheGuard } from '../src/host/plan-mode-cache-guard.ts'
import { installPtcSdkCacheGuard } from '../src/host/ptc-sdk-cache-guard.ts'

/**
 * fork 版计划模式服务与宿主级缓存守卫的行为面。
 *
 * 这一份用例的全部意义是钉住「进出计划模式不重建前缀缓存」的三条机制，以及它们在
 * 三种 harness 代次上的降级：
 *
 * 1. system 段**恒定** —— fork 一个 plan:policy 段都不注册（内置 preset 由守卫从
 *    system-prompt/assemble 里摘掉）；
 * 2. 工具表**恒定** —— exit_plan_mode 无条件注册（内置 preset 由守卫摘掉它的 when）；
 * 3. 指引走**末尾追加** —— /plan 与进入那一步的通知携带部署 section，pre-step 把它
 *    接在 decision.messages 末尾（追加不改变已发前缀）。
 *
 * 假宿主只提供真实代码会读的那几个面（get / on / effect / reflect.provide），服务名
 * 一律走 get()：与真实 Cordis 对没写进静态 inject 的服务行为一致，也让「服务缺席就
 * 安静降级」这条路径可以被真正跑到。
 */

/** 记录一次工具注册。 */
interface RegisteredTool {
  /** 工具定义。 */
  definition: { name?: string }
  /** 可选参数（只用来证明 fork 一条都没传）。 */
  options?: unknown
}

/** 假宿主：ctx 本身，加上断言要读回的探针。 */
interface FakeHost {
  /** 传给服务的 ctx。 */
  ctx: unknown
  /** ctx.get() 背后那张服务表。 */
  table: Record<string, unknown>
  /** 按事件名收集的监听器。 */
  listeners: Map<string, ((...args: never[]) => unknown)[]>
  /** 一条条 info 日志。 */
  infos: string[]
  /** 一条条 warn 日志。 */
  warns: string[]
  /** 装进服务表的一项。 */
  put(service: string, value: unknown): void
}

/**
 * 造一个假宿主上下文。
 * @param services - 初始服务表。
 * @param options - 是否提供 ctx.inject。
 * @returns 假宿主与探针。
 */
function fakeHost(
  services: Record<string, unknown> = {},
  options: { inject?: (deps: string[], callback: (scope: unknown) => void) => void } = {},
): FakeHost {
  const table: Record<string, unknown> = { ...services }
  const listeners = new Map<string, ((...args: never[]) => unknown)[]>()
  const infos: string[] = []
  const warns: string[] = []
  const host: FakeHost = {
    ctx: undefined,
    table,
    listeners,
    infos,
    warns,
    put(service: string, value: unknown): void {
      table[service] = value
    },
  }
  host.ctx = {
    reflect: { provide: () => () => {} },
    get: (serviceName: string): unknown => table[serviceName],
    effect: (body: () => () => void): (() => void) => body(),
    on: (eventName: string, listener: (...args: never[]) => unknown): (() => void) => {
      const list = listeners.get(eventName) ?? []
      list.push(listener)
      listeners.set(eventName, list)
      return () => {
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
      }
    },
    logger: {
      info: (message: string): void => { infos.push(message) },
      warn: (message: string): void => { warns.push(message) },
    },
    ...options.inject === undefined ? {} : { inject: options.inject },
  }
  return host
}

/**
 * 跑一条 listener 链（waterfall 形状：每个监听器包住 rest）。
 * @param host - 假宿主。
 * @param event - 事件名。
 * @param args - 除 next 之外的实参。
 * @param base - 链条跑到底时的返回值。
 * @returns 最外层监听器的返回值。
 */
async function runChain(
  host: FakeHost,
  event: string,
  args: unknown[],
  base: unknown,
): Promise<unknown> {
  const list = host.listeners.get(event) ?? []
  let index = 0
  const next = async (): Promise<unknown> => {
    const listener = list[index]
    index += 1
    if (listener === undefined) return base
    return (listener as unknown as (...params: unknown[]) => unknown)(...args, next)
  }
  return next()
}

/**
 * 跑一次 agent/pre-step。
 * @param host - 假宿主。
 * @param payload - pre-step 载荷。
 * @param base - 链条跑到底时的决策。
 * @returns 最外层的决策。
 */
async function runPreStep(
  host: FakeHost,
  payload: unknown,
  base: unknown = { kind: 'enter', messages: [] },
): Promise<{ kind?: string, messages?: unknown[] }> {
  return await runChain(host, 'agent/pre-step', [payload], base) as { kind?: string, messages?: unknown[] }
}

/**
 * 读一条消息的正文。
 * @param value - 消息。
 * @returns 所有文本块拼起来的正文。
 */
function messageText(value: unknown): string {
  const content = (value as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const text = (block as { text?: unknown } | undefined)?.text
      return typeof text === 'string' ? text : ''
    })
    .join('\n')
}

/** 一份投影状态的默认值。 */
const STATE_TEMPLATE = {
  active: false,
  wanted: null as boolean | null,
  running: null as { commandId: string, wanted: boolean } | null,
  activeAtLastHeader: null as boolean | null,
  entered: false,
}

/**
 * 一个「可调用 + 可断言」的假函数。
 *
 * 直接写 vi.fn() 的返回类型是 Mock<Procedure | Constructable>：它带着 mock 探针，但
 * 在严格类型下**不可调用**，于是假 agent 传不进 AgentLike、假 tools 的 register 也
 * 调不动。这里保留调用签名，另把探针收窄成用例真正用到的两个成员。
 */
interface FakeFn {
  (...args: unknown[]): unknown
  mock: { calls: unknown[][], mockReturnValue(value: unknown): void }
}

/**
 * 造一个假函数。
 * @param impl - 真实实现。
 * @returns 可调用、可断言的假函数。
 */
function fakeFn(impl: (...args: unknown[]) => unknown = () => undefined): FakeFn {
  return vi.fn(impl) as unknown as FakeFn
}

/** 假会话的 append 签名。 */
type AppendFn = ((type: string, data: unknown) => void) & { mock: { calls: unknown[][] } }

/** 假 userQuestions 的 ask 签名。 */
type AskFn = ((request: unknown) => Promise<unknown>) & { mock: { calls: unknown[][] } }

/** 一个假会话。 */
function fakeSession(): { append: AppendFn } {
  return { append: fakeFn() as unknown as AppendFn }
}

/** 一个假 agent。 */
function fakeAgent(session: unknown): {
  session: unknown
  inject: FakeFn
  steer: FakeFn
} {
  return { session, inject: fakeFn(), steer: fakeFn() }
}

/**
 * 一个假 tools 服务（记录每次注册的入参）。
 * @param existing - 安装守卫时「已经注册过」的那条定义，用来覆盖守卫来晚的分支。
 * @returns 探针。
 */
function fakeTools(existing?: unknown): {
  register: FakeFn
  get: FakeFn
  calls(): RegisteredTool[]
} {
  const calls: RegisteredTool[] = []
  const register = fakeFn((...args: unknown[]) => {
    calls.push({ definition: args[0] as { name?: string }, options: args[1] })
    return () => {}
  })
  const get = fakeFn(() => existing)
  return { register, get, calls: () => calls }
}

/** 一个假 userQuestions 通道。 */
function fakeQuestions(ask: (request: unknown) => Promise<unknown>): { ask: AskFn } {
  return { ask: vi.fn(ask) as unknown as AskFn }
}

/** 一个「什么都不做」的投影服务。 */
function idleProjections(stateOf?: (session: unknown, key: string) => unknown): Record<string, unknown> {
  const service: Record<string, unknown> = {
    register: vi.fn(() => Promise.resolve({ stateOf: () => ({ ...STATE_TEMPLATE }) })),
  }
  if (stateOf !== undefined) service.stateOf = stateOf
  return service
}

/**
 * 调一次服务的 init 钩子（真实路径：cordis 在实例构造之后跑它）。
 * @param controller - 控制器。
 */
async function mount(controller: PlanModeController): Promise<void> {
  const init = (controller as unknown as Record<symbol, () => Promise<void>>)[Service.init]
  await init.call(controller)
}

/**
 * 造一个已挂载的控制器。
 * @param options - 服务表、section 与初始计划状态。
 * @returns 假宿主、控制器与可变的状态对象。
 */
async function mountedController(options: {
  services?: Record<string, unknown>
  inject?: (deps: string[], callback: (scope: unknown) => void) => void
  section?: string
  state?: Partial<typeof STATE_TEMPLATE>
} = {}): Promise<{
    host: FakeHost
    controller: PlanModeController
    state: typeof STATE_TEMPLATE
    tools: ReturnType<typeof fakeTools>
  }> {
  const tools = fakeTools()
  const state = { ...STATE_TEMPLATE, ...options.state }
  const services: Record<string, unknown> = {
    tools,
    sessionProjections: {
      register: vi.fn(() => Promise.resolve({ stateOf: () => state })),
    },
    ...options.services,
  }
  const host = fakeHost(services, { inject: options.inject })
  const controller = new PlanModeController(host.ctx as never, { section: options.section ?? 'PLAN GUIDANCE' })
  await mount(controller)
  return { host, controller, state, tools }
}

describe('the config contract', () => {
  it('accepts a non-empty section and returns a detached copy', () => {
    const config = { section: 'Guidance.' }
    const resolved = resolveConfig(config)
    expect(resolved).toEqual({ section: 'Guidance.' })
    expect(resolved).not.toBe(config)
  })

  it('rejects a missing, non-string, blank, or unknown-keyed config', () => {
    expect(() => resolveConfig({} as never)).toThrow('needs a string')
    expect(() => resolveConfig({ section: 1 } as never)).toThrow('needs a string')
    expect(() => resolveConfig({ section: '   ' })).toThrow('needs a non-empty')
    expect(() => resolveConfig({ section: 'x', extra: true } as never)).toThrow('unknown key(s) extra')
  })
})

describe('the plan projection definition', () => {
  it('folds the plan command lifecycle, plan/mode, and request headers', () => {
    const definition = createPlanProjectionDefinition()
    expect(definition.key).toBe('plan')
    expect(definition.stateVersion).toBe(PLAN_STATE_VERSION)
    let state = definition.init()
    expect(state).toEqual(STATE_TEMPLATE)

    // /plan 命令开始 -> 记下目标；结束 -> 还是没和 active 一致就留成 wanted。
    state = definition.apply(state, { type: 'command/run', data: { name: 'plan', args: '', commandId: 'c1' } })
    expect(state.running).toEqual({ commandId: 'c1', wanted: true })
    expect(definition.wire.view(state)).toEqual({ active: false, pending: true })
    state = definition.apply(state, { type: 'command/done', data: { commandId: 'c1', kind: 'success' } })
    expect(state.wanted).toBe(true)
    expect(state.running).toBeNull()

    // plan/mode 是整值记录：写 active、清 wanted、记 entered。
    state = definition.apply(state, { type: 'plan/mode', data: { active: true } })
    expect(state.active).toBe(true)
    expect(state.entered).toBe(true)
    expect(state.wanted).toBeNull()
    expect(definition.wire.view(state)).toEqual({ active: true, pending: false })

    // request/header 记下「上一次告诉模型的模式」。
    state = definition.apply(state, { type: 'request/header', data: {} })
    expect(state.activeAtLastHeader).toBe(true)

    // 无关事件原样返回同一个引用（零下游工作）。
    const same = definition.apply(state, { type: 'turn/start', data: { turn: 1 } })
    expect(same).toBe(state)
  })

  it('accepts a legacy stateVersion-3 row that has no entered field', () => {
    const definition = createPlanProjectionDefinition(LEGACY_PLAN_STATE_VERSION)
    expect(definition.stateVersion).toBe(LEGACY_PLAN_STATE_VERSION)
    const parsed = definition.stateSchema.parse({
      active: true,
      wanted: null,
      running: null,
      activeAtLastHeader: true,
    })
    expect(parsed.active).toBe(true)
    expect(parsed.entered).toBe(false)
  })

  it('exports a ready-to-register definition for the newest generation', () => {
    expect(planProjectionDefinition.key).toBe('plan')
    expect(planProjectionDefinition.stateVersion).toBeGreaterThanOrEqual(LEGACY_PLAN_STATE_VERSION)
    expect(typeof planProjectionDefinition.wire.view).toBe('function')
  })
})

describe('the tool and prompt surfaces (no dynamic rebuilds)', () => {
  it('registers exit_plan_mode with no registration options at all', async () => {
    const { tools } = await mountedController()
    expect(tools.calls()).toHaveLength(1)
    expect(tools.calls()[0].definition.name).toBe(EXIT_PLAN_MODE)
    // 关键：没有第二个参数，也就没有 { when } —— 工具表在进出计划模式时不变。
    expect(tools.calls()[0].options).toBeUndefined()
    expect(tools.register.mock.calls[0]).toHaveLength(1)
  })

  it('never registers a plan:policy section and does not depend on systemPrompt', async () => {
    const section = vi.fn()
    const { host, controller } = await mountedController({
      services: { systemPrompt: { section, getSectionOrder: vi.fn(() => 500) } },
    })
    expect(section).not.toHaveBeenCalled()
    expect([...host.listeners.keys()]).not.toContain('system-prompt/assemble')
    // 静态 inject 里没有 systemPrompt：这个 fork 一个 prompt 段都不注册。
    expect((PlanModeController as unknown as { inject: string[] }).inject).not.toContain('systemPrompt')
    expect((controller as unknown as { inject?: unknown }).inject).toBeUndefined()
  })

  it('subscribes to agent/pre-step and exit_plan_mode survives a missing tools service', async () => {
    const host = fakeHost({ sessionProjections: idleProjections() })
    const controller = new PlanModeController(host.ctx as never, { section: 'G' })
    await mount(controller)
    expect([...host.listeners.keys()]).toContain('agent/pre-step')
    expect(host.warns).toEqual([])
    expect(host.infos.join('\n')).toContain('exit_plan_mode was not registered')
  })
})

describe('stateVersion negotiation with an already-registered plan projection', () => {
  it('retries with the version the existing registration reports', async () => {
    const seen: number[] = []
    const state = { ...STATE_TEMPLATE, active: true, entered: true }
    const register = vi.fn((definition: { stateVersion: number }) => {
      seen.push(definition.stateVersion)
      if (definition.stateVersion !== LEGACY_PLAN_STATE_VERSION) {
        return Promise.reject(new Error('session projection key "plan" is already registered at stateVersion 3; '
          + 'refusing to share it with stateVersion 4'))
      }
      return Promise.resolve({ stateOf: () => state })
    })
    const host = fakeHost({ tools: fakeTools(), sessionProjections: { register } })
    const controller = new PlanModeController(host.ctx as never, { section: 'G' })
    await mount(controller)

    expect(seen).toEqual([PLAN_STATE_VERSION, LEGACY_PLAN_STATE_VERSION])
    // 协商成功后状态来自共享的那个折叠单元。
    expect(controller.loggedActive('session')).toBe(true)
  })

  it('gives up quietly when the collision is not a version mismatch', async () => {
    const register = vi.fn(() => Promise.reject(new Error('something else went wrong')))
    const host = fakeHost({ tools: fakeTools(), sessionProjections: { register } })
    const controller = new PlanModeController(host.ctx as never, { section: 'G' })
    await mount(controller)

    expect(register).toHaveBeenCalledTimes(1)
    expect(host.warns.join('\n')).toContain('could not register the plan projection')
    // 没有投影也要能用：状态退回内存兜底。
    expect(controller.loggedActive('session')).toBe(false)
  })

  it('reads state through the legacy registry-level stateOf when register is synchronous', async () => {
    const register = vi.fn(() => () => {})
    const stateOf = vi.fn((_session: unknown, key: string) => key === 'plan'
      ? { ...STATE_TEMPLATE, active: true }
      : undefined)
    const host = fakeHost({ tools: fakeTools(), sessionProjections: { register, stateOf } })
    const controller = new PlanModeController(host.ctx as never, { section: 'G' })
    await mount(controller)

    expect(controller.loggedActive('session')).toBe(true)
    expect(stateOf).toHaveBeenCalledWith('session', 'plan')
  })
})
/**
 * 一个会随 append 折叠的假会话：模拟 plan 投影对 plan/mode 的整值记录。
 * @param state - 共享的状态对象。
 * @returns 假会话。
 */
function foldingSession(state: typeof STATE_TEMPLATE): { append: AppendFn } {
  const append = fakeFn((type: unknown, data: unknown) => {
    if (type === 'plan/mode') {
      const active = (data as { active?: unknown } | undefined)?.active === true
      state.active = active
      state.entered = state.entered || active
      state.wanted = null
    }
  })
  return { append: append as unknown as AppendFn }
}

describe('the tail narration carries the deployment section', () => {
  it('commits between turns and delivers the section in one tail message', async () => {
    const { controller, state } = await mountedController()
    const session = foldingSession(state)
    const agent = fakeAgent(session)

    expect(controller.set(agent, true)).toBe('committed')

    expect(session.append).toHaveBeenCalledWith('plan/mode', { active: true })
    expect(agent.inject).toHaveBeenCalledTimes(1)
    const text = messageText(agent.inject.mock.calls[0][0])
    expect(text).toContain('switched this session to plan mode')
    // 关键在于 section 也在这条尾部消息里：system 段因此可以恒定。
    expect(text).toContain('PLAN GUIDANCE')
  })

  it('narrates the way back without the section', async () => {
    const { controller, state } = await mountedController({ state: { active: true, activeAtLastHeader: true } })
    const session = foldingSession(state)
    const agent = fakeAgent(session)

    expect(controller.set(agent, false)).toBe('committed')

    expect(agent.inject).toHaveBeenCalledTimes(1)
    const text = messageText(agent.inject.mock.calls[0][0])
    expect(text).toContain('back to the default mode')
    expect(text).not.toContain('PLAN GUIDANCE')
  })

  it('stays quiet once the last request header already told the model', async () => {
    const { controller, state } = await mountedController({ state: { activeAtLastHeader: true } })
    const session = foldingSession(state)
    expect(controller.narration(session, true)).toBeUndefined()
    expect(controller.narration(session, false)).toBeDefined()
  })

  it('speaks on entry even before the first request header (told === undefined)', async () => {
    const { controller } = await mountedController()
    const session = foldingSession({ ...STATE_TEMPLATE })
    expect(controller.narration(session, true)).toBeDefined()
    // 但离开方向上「还没讲过」就没有可讲的东西。
    expect(controller.narration(session, false)).toBeUndefined()
  })
})

describe('an in-turn selection waits for the next accepted pre-step', () => {
  it('queues the selection and appends it — with the section — at pre-step', async () => {
    const { host, controller, state } = await mountedController({
      services: { agents: { turnBoundaryOf: () => ({ openTurnStartSeq: 3 }) } },
    })
    const session = foldingSession(state)
    const agent = fakeAgent(session)

    expect(controller.set(agent, true)).toBe('queued')
    expect(session.append).not.toHaveBeenCalled()
    expect(agent.inject).not.toHaveBeenCalled()

    const decision = await runPreStep(host, { agent })

    expect(session.append).toHaveBeenCalledWith('plan/mode', { active: true })
    expect(decision.messages).toHaveLength(1)
    expect(messageText(decision.messages?.[0])).toContain('PLAN GUIDANCE')

    // 一次进入只讲一次：再走一步什么都不追加。
    const again = await runPreStep(host, { agent })
    expect(again.messages).toHaveLength(0)
  })

  it('leaves the selection pending when the step is rejected', async () => {
    const { host, controller, state } = await mountedController({
      services: { agents: { turnBoundaryOf: () => ({ openTurnStartSeq: 1 }) } },
    })
    const session = foldingSession(state)
    const agent = fakeAgent(session)
    controller.set(agent, true)

    const decision = await runPreStep(host, { agent }, { kind: 'reject', messages: [] })

    expect(decision.kind).toBe('reject')
    expect(session.append).not.toHaveBeenCalled()
  })

  it('treats a cancelled selection as cancelled, not as a new entry', async () => {
    const { controller, state } = await mountedController({
      services: { agents: { turnBoundaryOf: () => ({ openTurnStartSeq: 1 }) } },
      state: { active: true },
    })
    const session = foldingSession(state)
    const agent = fakeAgent(session)
    // 先排一个「离开」，再排一个「进入」：目标是回到已记录状态，所以是 cancelled。
    expect(controller.set(agent, false)).toBe('queued')
    expect(controller.set(agent, true)).toBe('cancelled')
  })
})

describe('exit_plan_mode', () => {
  /**
   * 取出已注册的 exit_plan_mode 定义。
   * @param tools - 假 tools 服务。
   * @returns 定义。
   */
  function definitionOf(tools: ReturnType<typeof fakeTools>): {
    execute(args: unknown, exec: unknown): Promise<{ approved: boolean }>
    output: { render(args: unknown, value: unknown): { text: string }[] }
  } {
    return tools.calls()[0].definition as never
  }

  it('refuses to run outside plan mode (the only admission gate it has)', async () => {
    const { tools } = await mountedController()
    const definition = definitionOf(tools)
    await expect(definition.execute({ plan: '# P' }, { agent: fakeAgent(fakeSession()) }))
      .rejects.toThrow(EXIT_PLAN_MODE + ' is only available in plan mode')
    await expect(definition.execute({ plan: '# P' }, {}))
      .rejects.toThrow('is only available in plan mode')
  })

  it('refuses a plan that does not start with a markdown heading', async () => {
    const { tools } = await mountedController({ state: { active: true } })
    const definition = definitionOf(tools)
    const questions = fakeQuestions(async () => ({ answers: [] }))
    const exec = { agent: fakeAgent(fakeSession()), callId: 'c1' }
    await expect(definition.execute({ plan: 'no heading' }, exec)).rejects.toThrow('starting with a # heading')
    expect(questions.ask).not.toHaveBeenCalled()
  })

  it('refuses when no user-questions channel exists', async () => {
    const { tools } = await mountedController({ state: { active: true } })
    const definition = definitionOf(tools)
    await expect(definition.execute({ plan: '# P' }, { agent: fakeAgent(fakeSession()) }))
      .rejects.toThrow('no user-questions channel')
  })

  it('asks with the frozen review contract and, on approval, exits silently', async () => {
    const questions = fakeQuestions(async () => ({
      answers: [{ id: REVIEW_ID, selected: [APPROVE_LABEL] }],
    }))
    const { host, tools, state } = await mountedController({
      services: { userQuestions: questions },
      state: { active: true },
    })
    const definition = definitionOf(tools)
    const session = foldingSession(state)
    const agent = fakeAgent(session)

    await expect(definition.execute({ plan: '# The plan' }, { agent, callId: 'call-1', signal: 'sig' }))
      .resolves.toEqual({ approved: true })

    const request = questions.ask.mock.calls[0][0] as {
      questions: { id: string, options: { label: string }[], intent: { kind: string, callId: string } }[]
      agent: unknown
      signal: unknown
    }
    expect(request.questions[0].id).toBe(REVIEW_ID)
    expect(request.questions[0].options.map(option => option.label)).toEqual([APPROVE_LABEL, KEEP_PLANNING_LABEL])
    expect(request.questions[0].intent).toEqual({ kind: 'plan-review', approve: APPROVE_LABEL, callId: 'call-1' })
    expect(request.agent).toBe(agent)

    // 批准后是静默选择：pre-step 落日志，但不再补一条通知。
    const decision = await runPreStep(host, { agent })
    expect(session.append).toHaveBeenCalledWith('plan/mode', { active: false })
    expect(decision.messages).toHaveLength(0)
    // 渲染文本说明「批准即离开」。
    expect(definition.output.render({ plan: '# P' }, { approved: true })[0].text).toContain('Plan approved')
    expect(definition.output.render({ plan: '# P' }, { approved: false })[0].text).toContain('remains active')
  })

  it('keeps planning and hands the user feedback back as an error', async () => {
    const questions = fakeQuestions(async () => ({
      answers: [{ id: REVIEW_ID, selected: [KEEP_PLANNING_LABEL], custom: 'add a rollback step' }],
    }))
    const { tools } = await mountedController({
      services: { userQuestions: questions },
      state: { active: true },
    })
    const definition = definitionOf(tools)
    await expect(definition.execute({ plan: '# P' }, { agent: fakeAgent(fakeSession()) }))
      .rejects.toThrow('their feedback: add a rollback step')
  })

  it('keeps planning with a generic message when the user gave no feedback', async () => {
    const questions = fakeQuestions(async () => ({ answers: [{ id: REVIEW_ID, selected: [KEEP_PLANNING_LABEL] }] }))
    const { tools } = await mountedController({
      services: { userQuestions: questions },
      state: { active: true },
    })
    await expect(definitionOf(tools).execute({ plan: '# P' }, { agent: fakeAgent(fakeSession()) }))
      .rejects.toThrow('revise the plan and present it again')
  })

  it('concludes the turn when the review is dismissed and the harness can do it', async () => {
    const questions = fakeQuestions(async () => {
      throw Object.assign(new Error('cancelled'), { code: 'ASK_CANCELLED' })
    })
    const { tools } = await mountedController({
      services: { userQuestions: questions },
      state: { active: true },
    })
    const concludeTurn = vi.fn()
    await expect(definitionOf(tools).execute({ plan: '# P' }, { agent: fakeAgent(fakeSession()), concludeTurn }))
      .resolves.toEqual({ approved: false })
    expect(concludeTurn).toHaveBeenCalledTimes(1)
  })

  it('names the missing capability when an older harness cannot conclude a turn', async () => {
    const questions = fakeQuestions(async () => {
      throw Object.assign(new Error('cancelled'), { code: 'ASK_CANCELLED' })
    })
    const { tools } = await mountedController({
      services: { userQuestions: questions },
      state: { active: true },
    })
    await expect(definitionOf(tools).execute({ plan: '# P' }, { agent: fakeAgent(fakeSession()) }))
      .rejects.toThrow('cannot conclude the turn')
  })

  it('keeps a non-cancellation failure as itself', async () => {
    const questions = fakeQuestions(async () => {
      throw new Error('the channel went away')
    })
    const { tools } = await mountedController({
      services: { userQuestions: questions },
      state: { active: true },
    })
    await expect(definitionOf(tools).execute({ plan: '# P' }, { agent: fakeAgent(fakeSession()) }))
      .rejects.toThrow('the channel went away')
  })
})

describe('the host-level cache guard', () => {
  /**
   * 装一台守卫。
   * @param services - 初始服务表。
   * @param options - 注入行为。
   * @returns 假宿主、守卫与 tools 探针。
   */
  function guardHost(
    services: Record<string, unknown> = {},
    options: { inject?: (deps: string[], callback: (scope: unknown) => void) => void } = {},
  ): { host: FakeHost; guard: { dispose(): void }; tools: ReturnType<typeof fakeTools> } {
    const tools = (services.tools as ReturnType<typeof fakeTools> | undefined) ?? fakeTools()
    const host = fakeHost({ tools, ...services }, options)
    const guard = installPlanModeCacheGuard(host.ctx)
    return { host, guard, tools: host.table.tools as ReturnType<typeof fakeTools> }
  }

  it('strips plan:policy from the assembled presentation and keeps the rest intact', async () => {
    const { host } = guardHost()
    const agent = fakeAgent(fakeSession())
    const assembly = {
      sections: [
        { name: 'harness:identity', text: 'You are an AI agent.' },
        { name: PLAN_POLICY_SECTION, text: 'POLICY TEXT' },
      ],
      contexts: [],
      variables: {},
    }

    const result = await runChain(host, 'system-prompt/assemble', [assembly, { scope: agent }], assembly)

    expect(PLAN_POLICY_SECTION).toBe('plan:policy')
    expect((result as { sections: { name: string }[] }).sections.map(section => section.name))
      .toEqual(['harness:identity'])
    // 其余字段原样带过去（它只是摘掉一个段）。
    expect((result as { contexts: unknown }).contexts).toEqual([])
  })

  it('leaves an assembly without the section untouched by reference', async () => {
    const { host } = guardHost()
    const assembly = { sections: [{ name: 'x', text: 'y' }] }
    const result = await runChain(host, 'system-prompt/assemble', [assembly, {}], assembly)
    expect(result).toBe(assembly)
  })

  it('delivers the stripped policy once per activation as a tail message', async () => {
    const { host } = guardHost()
    const agent = fakeAgent(fakeSession())
    const enter = { sections: [{ name: PLAN_POLICY_SECTION, text: 'POLICY TEXT' }] }

    await runChain(host, 'system-prompt/assemble', [enter, { scope: agent }], enter)
    const first = await runPreStep(host, { agent })
    expect(first.messages).toHaveLength(1)
    expect(messageText(first.messages?.[0])).toBe('POLICY TEXT')

    // 同一次激活里不再重复。
    const second = await runPreStep(host, { agent })
    expect(second.messages).toHaveLength(0)

    // 离开（官方段变空）之后重新进入 = 新的一次激活，再讲一次。
    const leave = { sections: [{ name: PLAN_POLICY_SECTION, text: '' }] }
    await runChain(host, 'system-prompt/assemble', [leave, { scope: agent }], leave)
    await runChain(host, 'system-prompt/assemble', [enter, { scope: agent }], enter)
    const third = await runPreStep(host, { agent })
    expect(third.messages).toHaveLength(1)
  })

  it('re-arms through the plan projection when the session left plan mode', async () => {
    const projection = { active: true }
    const stateOf = vi.fn((_session: unknown, key: string) => key === 'plan' ? projection : undefined)
    const { host } = guardHost({ sessionProjections: { stateOf } })
    const agent = fakeAgent(fakeSession())
    const enter = { sections: [{ name: PLAN_POLICY_SECTION, text: 'POLICY TEXT' }] }

    await runChain(host, 'system-prompt/assemble', [enter, { scope: agent }], enter)
    expect((await runPreStep(host, { agent })).messages).toHaveLength(1)

    // 投影说已经离开计划模式：下一次 pre-step 复位，这个激活结束。
    projection.active = false
    expect((await runPreStep(host, { agent })).messages).toHaveLength(0)

    // 复位之后重新进入会再讲一次。
    await runChain(host, 'system-prompt/assemble', [enter, { scope: agent }], enter)
    expect((await runPreStep(host, { agent })).messages).toHaveLength(1)
  })

  it('neutralizes the conditional admission of exit_plan_mode and nothing else', () => {
    const { tools } = guardHost()
    const when = (): boolean => false

    tools.register({ name: EXIT_PLAN_MODE }, { when })
    tools.register({ name: 'some_other_tool' }, { when })

    const exitOptions = tools.calls()[0].options as Record<string, unknown>
    expect('when' in exitOptions).toBe(false)
    expect(exitOptions).toEqual({})
    // 别的工具保留它自己的准入条件。
    expect((tools.calls()[1].options as Record<string, unknown>).when).toBe(when)
  })

  it('wraps the registry that arrives after the guard was installed', () => {
    const tools = fakeTools()
    let host: FakeHost | undefined
    host = fakeHost({}, {
      inject: (_deps: string[], callback: (scope: unknown) => void) => {
        host?.put('tools', tools)
        callback(host?.ctx)
      },
    })
    installPlanModeCacheGuard(host.ctx)

    tools.register({ name: EXIT_PLAN_MODE }, { when: () => false })

    expect('when' in (tools.calls()[0].options as Record<string, unknown>)).toBe(false)
  })

  it('warns when it was installed after exit_plan_mode already existed', () => {
    const tools = fakeTools({ name: EXIT_PLAN_MODE })
    const { host } = guardHost({ tools })
    expect(host.warns.join('\n')).toContain('installed after exit_plan_mode')
  })

  it('dispose restores the registry and unsubscribes both listeners', async () => {
    const { host, guard, tools } = guardHost()
    const when = (): boolean => false

    guard.dispose()
    guard.dispose()

    tools.register({ name: EXIT_PLAN_MODE }, { when })
    expect((tools.calls()[0].options as Record<string, unknown>).when).toBe(when)
    expect(host.listeners.get('agent/pre-step') ?? []).toHaveLength(0)
    expect(host.listeners.get('system-prompt/assemble') ?? []).toHaveLength(0)
  })

  it('does not disturb a host whose presentation has no sections', async () => {
    const { host } = guardHost()
    const assembly = { contexts: [] }
    const result = await runChain(host, 'system-prompt/assemble', [assembly, {}], assembly)
    expect(result).toBe(assembly)
  })
})

/**
 * 真实 Cordis 服务上的多作用域回归。
 *
 * Cordis 的 `Service` 代理在读属性时会把方法**绑定到读取它的那一层作用域**，于是
 * `const original = tools.register` 拿到的是一份绑到**根作用域**的函数；守卫再
 * `original.call(tools, …)`，每一个 preset 的注册都被塞回根作用域，全局层于是撞上
 * `tool "list_subagent_models" is already registered`。
 *
 * 这里用真实的 `Context` / `Service` 钉住那条规则：包装必须把**调用方自己的
 * receiver** 传下去，服务里的 `this.ctx` 留在调用方那一层作用域里。
 */

/** 作用域标签：子上下文用自有属性标出自己的作用域。 */
const SCOPE_KEY = Symbol('dsh-chatgpt-subscription.test.scope')

/** 一次工具注册留下的痕迹。 */
interface ScopeRegistration {
  /** 工具名。 */
  name: string
  /** 注册选项。 */
  options: unknown
  /** register 里的 this.ctx —— 必须是调用方那一层作用域。 */
  ctx: unknown
  /** this.ctx 上的作用域标签。 */
  scope: unknown
}

/**
 * 一个真实 Cordis 服务：工具按作用域分桶，同名工具只在同一层撞车。
 *
 * 这复刻 `ToolsService.register` 的作用域语义（`scopeOf(this.ctx)` 决定落在全局层
 * 还是该 agent 的层），所以「两个子作用域注册同名工具」在守卫装错时必然撞车。
 */
class ScopedToolsService extends Service {
  /** 每次注册留下的痕迹。 */
  readonly registrations: ScopeRegistration[] = []
  /** 每次 definitions 留下的痕迹。 */
  readonly definitionCalls: { ctx: unknown; scope: unknown }[] = []
  /** 全局层已注册的工具名。 */
  readonly globalNames = new Set<string>()
  /** 每个作用域已注册的工具名。 */
  readonly scopedNames = new Map<unknown, Set<string>>()

  /**
   * @param ctx - 宿主上下文。
   * @param name - 服务名。
   */
  constructor(ctx: Context, name: string) {
    super(ctx, name)
  }

  /**
   * @param definition - 工具定义。
   * @param options - 注册选项。
   * @returns 注销动作。
   */
  register(definition: { name: string }, options?: unknown): () => void {
    const scope = (this.ctx as unknown as Record<symbol, unknown>)[SCOPE_KEY]
    this.registrations.push({ name: definition.name, options, ctx: this.ctx, scope })
    const names = scope === undefined ? this.globalNames : this.scopedNamesOf(scope)
    if (names.has(definition.name)) {
      throw new Error(scope === undefined
        ? `tool "${definition.name}" is already registered (for a per-agent variant, register through that agent's agent.ctx instead)`
        : `tool "${definition.name}" is already registered in this scope`)
    }
    names.add(definition.name)
    return () => { names.delete(definition.name) }
  }

  /**
   * @param _scope - 视图片段。
   * @param _toolSet - 步骤准入集。
   * @returns 可见定义。
   */
  definitions(_scope?: unknown, _toolSet?: unknown): readonly { name: string }[] {
    this.definitionCalls.push({
      ctx: this.ctx,
      scope: (this.ctx as unknown as Record<symbol, unknown>)[SCOPE_KEY],
    })
    return [{ name: 'list_subagent_models' }]
  }

  /**
   * @param scope - 作用域键。
   * @returns 该作用域已注册的工具名。
   */
  private scopedNamesOf(scope: unknown): Set<string> {
    let names = this.scopedNames.get(scope)
    if (names === undefined) {
      names = new Set<string>()
      this.scopedNames.set(scope, names)
    }
    return names
  }
}

/**
 * 从一个上下文里读出工具服务。
 *
 * cordis 的 `ctx.get` 是运行期 mixin，类型声明上没有，所以这里显式收窄。
 * @param ctx - 上下文。
 * @returns 工具服务。
 */
function toolsOf(ctx: Context): {
  register(definition: { name: string }, options?: unknown): unknown
  definitions(scope?: unknown, toolSet?: unknown): readonly { name: string }[]
} {
  return (ctx as unknown as { get(name: string): unknown }).get('tools') as never
}

describe('the cache guards on a real Cordis service', () => {
  it('keeps the calling scope, so two child scopes can register the same tool', () => {
    const root = new Context()
    const tools = new ScopedToolsService(root, 'tools')
    const childA = root.extend({ [SCOPE_KEY]: 'A' })
    const childB = root.extend({ [SCOPE_KEY]: 'B' })

    const planGuard = installPlanModeCacheGuard(root)
    const sdkGuard = installPtcSdkCacheGuard(root)
    try {
      // 同一个工具名，两个子作用域：修好之前第二次会撞上「already registered」。
      toolsOf(childA).register({ name: 'list_subagent_models' })
      toolsOf(childB).register({ name: 'list_subagent_models' })

      expect(tools.registrations).toHaveLength(2)
      expect(tools.registrations[0].scope).toBe('A')
      expect(tools.registrations[1].scope).toBe('B')
      // this.ctx 是调用方那一层作用域的影子（它的原型就是那个子上下文），
      // 不是根上下文。
      expect(Object.getPrototypeOf(tools.registrations[0].ctx)).toBe(childA)
      expect(Object.getPrototypeOf(tools.registrations[1].ctx)).toBe(childB)
      // 全局层始终是空的：两次注册没有落到根作用域上去撞车。
      expect(tools.globalNames.size).toBe(0)
    } finally {
      planGuard.dispose()
      sdkGuard.dispose()
    }
  })

  it('still strips the conditional admission, and definitions keeps the scope too', () => {
    const root = new Context()
    const tools = new ScopedToolsService(root, 'tools')
    const childA = root.extend({ [SCOPE_KEY]: 'A' })

    const planGuard = installPlanModeCacheGuard(root)
    const sdkGuard = installPtcSdkCacheGuard(root)
    try {
      const when = (): boolean => false
      toolsOf(childA).register({ name: EXIT_PLAN_MODE }, { when })
      expect('when' in (tools.registrations[0].options as Record<string, unknown>)).toBe(false)
      expect(tools.registrations[0].scope).toBe('A')

      // tools.definitions 走的是同一个接缝：作用域也不能丢。
      toolsOf(childA).definitions({ options: { provider: 'kimi-code' } }, { admitted: ['a'] })
      expect(tools.definitionCalls).toHaveLength(1)
      expect(tools.definitionCalls[0].scope).toBe('A')
      expect(Object.getPrototypeOf(tools.definitionCalls[0].ctx)).toBe(childA)
    } finally {
      planGuard.dispose()
      sdkGuard.dispose()
    }
  })

  it('restores the prototype methods on dispose', () => {
    const root = new Context()
    const tools = new ScopedToolsService(root, 'tools')
    const originalRegister = ScopedToolsService.prototype.register
    const originalDefinitions = ScopedToolsService.prototype.definitions

    const planGuard = installPlanModeCacheGuard(root)
    const sdkGuard = installPtcSdkCacheGuard(root)
    expect(ScopedToolsService.prototype.register).not.toBe(originalRegister)
    expect(ScopedToolsService.prototype.definitions).not.toBe(originalDefinitions)

    planGuard.dispose()
    sdkGuard.dispose()
    expect(ScopedToolsService.prototype.register).toBe(originalRegister)
    expect(ScopedToolsService.prototype.definitions).toBe(originalDefinitions)
    expect(tools.registrations).toHaveLength(0)
  })
})
