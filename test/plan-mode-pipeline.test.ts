import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APPROVAL_EXIT_TOOL,
  ENTER_DESCRIPTION,
  ENTER_PLAN_MODE_TOOL,
  LEAVE_DESCRIPTION,
  LEAVE_PLAN_MODE_TOOL,
  PlanModePipelineError,
  apply,
  attachPlanModePipelineSettings,
  enterResultText,
  leaveResultText,
  readPlanModePipelineEnabled,
  type PlanModeTransitionResult,
} from '../src/entry-plan-mode-pipeline.ts'

/**
 * 计划模式管线这一行的行为面：注册时机、开关、三级存活根降级、两个工具的返回值。
 *
 * 全部用假 ctx 驱动真实的 `apply()`：不连网络、不读 `~/.dsh`、不需要真实
 * `planMode`/`agents` 服务。假 ctx 只暴露 `get()` 与 `inject()`——服务名**不作为
 * 属性**挂在 ctx 上，与真实 Cordis 对没写进静态 `inject` 的服务所做的一致（这一行
 * 故意不写静态 `inject`，缺服务必须能安静降级）。
 *
 * 注册时机是这份用例的重点：这一行不再在 `apply()` 里探测一次，而是
 * `ctx.inject(['planMode'], …)`，服务到达才注册。三种宿主都要覆盖——
 * 服务已在（live，回调立即触发）、服务晚到（deferred，由 `deliver()` 触发）、
 * 以及没有 `ctx.inject` 的老代 cordis（absent，退回 apply 时探测）。
 */

/** 一次注册：工具定义，以及新代才有的一步一准入开关。 */
interface RegisteredTool {
  definition: ToolDefinition
  options?: { when?: () => boolean }
}

/**
 * 注入行为：
 * - `live`（默认）：服务已在该服务表里就立即触发回调，否则挂起（等价于真实 cordis
 *   「依赖未满足时回调不跑」）；
 * - `deferred`：一律挂起，由 `deliver()` 触发（模拟服务晚到）；
 * - `absent`：ctx 上没有 `inject` 方法（老代 cordis），本行应退回 apply 时探测。
 */
type InjectMode = 'live' | 'deferred' | 'absent'

/** 假宿主：ctx 本身，加上断言要读回的探针。 */
interface FakeHost {
  ctx: Context
  /** 这一行注册的工具，按工具名索引。 */
  tools: Map<string, RegisteredTool>
  /** effect 交回的 disposer。 */
  disposers: (() => void)[]
  /** 一条条 info 日志。 */
  infos: string[]
  /** 每次 `ctx.inject` 收到的服务名。 */
  requested: string[][]
  /** 还挂着的注入回调个数（0 表示服务已到或从未订上）。 */
  parked(): number
  /** 触发所有挂起的注入回调；可重复调用，模拟服务变化后 cordis 重跑回调。 */
  deliver(): void
  /** 让一个服务消失（模拟这一行挂载之后 plan-mode 被拆掉）。 */
  drop(service: string): void
}

/** 假宿主的可选服务与注入行为。 */
interface FakeHostOptions {
  /** 计划模式服务替身。 */
  planMode?: unknown
  /** agent 登记表替身。 */
  agents?: unknown
  /** 注入行为，默认 live。 */
  inject?: InjectMode
}

/**
 * 造一个假宿主上下文。
 * @param options - 要挂到 `get()` 后面的可选服务，以及注入行为。
 * @returns 假 ctx 与探针。
 */
function fakeHost(options: FakeHostOptions = {}): FakeHost {
  const registered = new Map<string, RegisteredTool>()
  const disposers: (() => void)[] = []
  const infos: string[] = []
  const requested: string[][] = []
  const queue: (() => void)[] = []
  const registry = {
    register(definition: ToolDefinition, toolOptions?: { when?: () => boolean }): () => void {
      registered.set(definition.name, { definition, options: toolOptions })
      const dispose = (): void => { registered.delete(definition.name) }
      disposers.push(dispose)
      return dispose
    },
  }
  const table: Record<string, unknown> = { tools: registry }
  if (options.planMode !== undefined) table.planMode = options.planMode
  if (options.agents !== undefined) table.agents = options.agents

  /** 一个上下文面：服务只在 `get()` 后面，不挂成属性。 */
  const face = {
    get: (name: string): unknown => table[name],
    logger: { info: (message: string): void => { infos.push(message) } },
    effect: (body: () => () => void): (() => void) => body(),
  }

  const mode: InjectMode = options.inject ?? 'live'
  const ctx = {
    ...face,
    ...(mode === 'absent' ? {} : {
      inject: (deps: string[], callback: (scope: Context) => void): void => {
        requested.push(deps)
        const fire = (): void => { callback(face as unknown as Context) }
        if (mode === 'live' && deps.every((name) => table[name] !== undefined)) fire()
        else queue.push(fire)
      },
    }),
  } as unknown as Context

  return {
    ctx,
    tools: registered,
    disposers,
    infos,
    requested,
    parked: () => queue.length,
    deliver: () => { for (const fire of queue) fire() },
    drop: (service: string) => { delete table[service] },
  }
}

/** 计划模式服务的替身：记录 `set` 的入参，按顺序回放给定的返回值。 */
function fakePlanMode(...reported: unknown[]): { service: { set: (agent: unknown, active: boolean) => unknown }, set: ReturnType<typeof vi.fn> } {
  let index = 0
  const set = vi.fn((_agent: unknown, _active: boolean): unknown => {
    const value = reported[Math.min(index, reported.length - 1)]
    index += 1
    return value
  })
  return { service: { set }, set }
}

/**
 * 调一次工具。
 * @param host - 假宿主。
 * @param name - 工具名。
 * @param exec - 工具执行上下文（这里只带 agent）。
 * @returns 工具的返回值。
 */
async function callTool(
  host: FakeHost,
  name: string,
  exec: { agent?: unknown },
): Promise<PlanModeTransitionResult> {
  const registered = host.tools.get(name)
  if (registered === undefined) throw new Error(`the row registered no "${name}" tool`)
  const execute = registered.definition.execute as unknown as (
    args: Record<string, unknown>,
    execution: { agent?: unknown },
  ) => Promise<PlanModeTransitionResult>
  return execute({}, exec)
}

/** 一个存活的根 agent。 */
const ROOT = { id: 'root' }

/** 同一会话里被派出去的子代理：活着，但不是根。 */
const CHILD = { id: 'child' }

/**
 * 一个 agent 登记表：`roots` 可选，因为老代没有它。
 * @param live - 按 id 能查到的存活 agent。
 * @param roots - 存活根集合；`undefined` 表示这一代没有 roots。
 * @returns 假的 agents 服务。
 */
function fakeAgents(live: Record<string, unknown>, roots?: readonly unknown[]) {
  const service: { get: (id: string) => unknown, roots?: () => readonly unknown[] } = {
    get: (id: string) => live[id],
  }
  if (roots !== undefined) service.roots = () => roots
  return service
}

// 开关走进程级 symbol 槽位，用例之间必须复位，否则一条关闭的用例会污染后面。
beforeEach(() => { attachPlanModePipelineSettings(() => true) })
afterEach(() => { attachPlanModePipelineSettings(() => true) })

describe('when the row registers its tools', () => {
  it('waits for the planMode service instead of probing once at apply time', () => {
    // 行序 ≠ apply 顺序：apply 时 planMode 可能还没到。这里模拟「先 apply、服务后到」，
    // 注册必须发生在注入回调触发之后。
    const host = fakeHost({ planMode: fakePlanMode('committed').service, inject: 'deferred' })

    apply(host.ctx)

    expect(host.requested).toEqual([['planMode']])
    expect(host.tools.size).toBe(0)
    expect(host.disposers).toEqual([])

    host.deliver()

    expect([...host.tools.keys()]).toEqual([ENTER_PLAN_MODE_TOOL, LEAVE_PLAN_MODE_TOOL])
    expect(host.disposers).toHaveLength(2)
  })

  it('registers nothing and does not throw where the planMode service never arrives', async () => {
    // 老代 harness、或部署方没在这一行所在组里装 plan-mode：安静降级，绝不抛错。
    const host = fakeHost()

    expect(() => { apply(host.ctx) }).not.toThrow()
    expect(host.tools.size).toBe(0)
    expect(host.disposers).toEqual([])
    expect(host.parked()).toBe(1)

    // 那一条对账日志是延到微任务才写的：服务确实没来才记。
    await Promise.resolve()
    expect(host.infos.join('\n')).toContain('waiting for the planMode service')
  })

  it('registers both tools on an old-generation context without ctx.inject when planMode is already there', () => {
    // 老代 cordis 没有 ctx.inject：退回 apply 时探测，探到就注册。
    const host = fakeHost({ planMode: fakePlanMode('committed').service, inject: 'absent' })

    apply(host.ctx)

    expect(host.requested).toEqual([])
    expect([...host.tools.keys()]).toEqual([ENTER_PLAN_MODE_TOOL, LEAVE_PLAN_MODE_TOOL])
  })

  it('logs the old-generation degradation where ctx.inject is missing and planMode never appears', () => {
    const host = fakeHost({ inject: 'absent' })

    expect(() => { apply(host.ctx) }).not.toThrow()
    expect(host.tools.size).toBe(0)
    expect(host.disposers).toEqual([])
    expect(host.infos.join('\n')).toContain('plan-mode pipeline inactive')
  })

  it('registers exactly enter_plan_mode and leave_plan_mode when planMode is already present', () => {
    const host = fakeHost({ planMode: fakePlanMode('committed').service })

    apply(host.ctx)

    expect(host.requested).toEqual([['planMode']])
    expect([...host.tools.keys()]).toEqual([ENTER_PLAN_MODE_TOOL, LEAVE_PLAN_MODE_TOOL])
    expect(ENTER_PLAN_MODE_TOOL).toBe('enter_plan_mode')
    expect(LEAVE_PLAN_MODE_TOOL).toBe('leave_plan_mode')
    expect(host.infos).toEqual([])
  })

  it('does not register twice when the injection callback runs again after a service change', () => {
    // cordis 在依赖服务变化时会拆掉注入回调再跑一遍：重复 register 同名工具会让宿主报错。
    const host = fakeHost({ planMode: fakePlanMode('committed').service, inject: 'deferred' })

    apply(host.ctx)
    host.deliver()
    host.deliver()

    expect(host.tools.size).toBe(2)
    expect(host.disposers).toHaveLength(2)
  })

  it('unregisters both tools through the disposer it registered with ctx.effect', () => {
    const host = fakeHost({ planMode: fakePlanMode('committed').service })

    apply(host.ctx)
    expect(host.disposers).toHaveLength(2)
    for (const dispose of host.disposers) dispose()
    expect(host.tools.size).toBe(0)
  })
})

describe('the planModePipeline switch', () => {
  it('treats a failing settings read as "still on" instead of dropping the tools', () => {
    // 读设置本身出错不是「用户关了」：缺省按开启工作，否则一次读失败就会静默
    // 吃掉两个工具，而面板上那个开关还显示为开。
    attachPlanModePipelineSettings(() => { throw new Error('the settings store is unavailable') })
    expect(readPlanModePipelineEnabled()).toBe(true)
  })

  it('reports disabled and never touches the service when it is off', async () => {
    attachPlanModePipelineSettings(() => false)
    const planMode = fakePlanMode('committed')
    const host = fakeHost({ planMode: planMode.service, agents: fakeAgents({ root: ROOT }, [ROOT]) })

    apply(host.ctx)
    const entered = await callTool(host, ENTER_PLAN_MODE_TOOL, { agent: ROOT })
    const left = await callTool(host, LEAVE_PLAN_MODE_TOOL, { agent: ROOT })

    expect(entered).toEqual({ active: false, transition: 'disabled' })
    expect(left).toEqual({ active: false, transition: 'disabled' })
    expect(planMode.set).not.toHaveBeenCalled()
  })

  it('keeps the tools out of a step through the admission gate it registers with', () => {
    const host = fakeHost({ planMode: fakePlanMode('committed').service })

    apply(host.ctx)
    const admission = host.tools.get(ENTER_PLAN_MODE_TOOL)?.options?.when
    expect(admission).toBeTypeOf('function')
    expect(admission!()).toBe(true)
    attachPlanModePipelineSettings(() => false)
    expect(admission!()).toBe(false)
  })

  it('keeps the admission gate and the execute fallback tied to the switch when the tools arrive late', async () => {
    const planMode = fakePlanMode('committed')
    const host = fakeHost({ planMode: planMode.service, agents: fakeAgents({ root: ROOT }, [ROOT]), inject: 'deferred' })

    apply(host.ctx)
    host.deliver()

    const admission = host.tools.get(ENTER_PLAN_MODE_TOOL)?.options?.when
    expect(admission).toBeTypeOf('function')
    expect(admission!()).toBe(true)
    attachPlanModePipelineSettings(() => false)
    expect(admission!()).toBe(false)
    expect(await callTool(host, ENTER_PLAN_MODE_TOOL, { agent: ROOT })).toEqual({ active: false, transition: 'disabled' })
    expect(planMode.set).not.toHaveBeenCalled()
  })
})

describe('the live-root check, in the three levels the hosts offer', () => {
  it('rejects a live child where the host can read its root set', async () => {
    // 第一级：agents 在、roots 可用，且不含调用方 —— 这是 DELEGATED_CALLER
    // 唯一的抛出点。
    const planMode = fakePlanMode('committed')
    const host = fakeHost({ planMode: planMode.service, agents: fakeAgents({ root: ROOT, child: CHILD }, [ROOT]) })

    apply(host.ctx)
    const call = callTool(host, ENTER_PLAN_MODE_TOOL, { agent: CHILD })

    await expect(call).rejects.toBeInstanceOf(PlanModePipelineError)
    await expect(call).rejects.toMatchObject({ code: 'DELEGATED_CALLER' })
    expect(planMode.set).not.toHaveBeenCalled()
  })

  it('lets the call through where agents has no roots function (old generation)', async () => {
    // 第二级：只判存活。判不了根不等于确认是子代理，而 set() 本身不需要根身份。
    const planMode = fakePlanMode('committed')
    const host = fakeHost({ planMode: planMode.service, agents: fakeAgents({ root: ROOT, child: CHILD }) })

    apply(host.ctx)
    const result = await callTool(host, ENTER_PLAN_MODE_TOOL, { agent: CHILD })

    expect(result).toEqual({ active: true, transition: 'committed' })
    expect(planMode.set).toHaveBeenCalledWith(CHILD, true)
  })

  it('lets the call through where the host exposes no agents service at all', async () => {
    // 第三级：存活与根都无从判定 —— 放行，否则切换会在整个老代上永久失败。
    const planMode = fakePlanMode('committed')
    const host = fakeHost({ planMode: planMode.service })

    apply(host.ctx)
    const result = await callTool(host, ENTER_PLAN_MODE_TOOL, { agent: ROOT })

    expect(result).toEqual({ active: true, transition: 'committed' })
    expect(planMode.set).toHaveBeenCalledWith(ROOT, true)
  })

  it('rejects a call that carries no agent at all', async () => {
    const planMode = fakePlanMode('committed')
    const host = fakeHost({ planMode: planMode.service, agents: fakeAgents({ root: ROOT }, [ROOT]) })

    apply(host.ctx)
    await expect(callTool(host, ENTER_PLAN_MODE_TOOL, {})).rejects.toMatchObject({ code: 'CALLER_MISSING' })
    expect(planMode.set).not.toHaveBeenCalled()
  })

  it('rejects a caller the session no longer owns', async () => {
    // 会话已结束或已被替换：登记表里同 id 的那个对象已经不是调用方。
    const planMode = fakePlanMode('committed')
    const stale = { id: 'root' }
    const host = fakeHost({ planMode: planMode.service, agents: fakeAgents({ root: stale }, [stale]) })

    apply(host.ctx)
    await expect(callTool(host, ENTER_PLAN_MODE_TOOL, { agent: ROOT })).rejects.toMatchObject({ code: 'CALLER_NOT_LIVE' })
    expect(planMode.set).not.toHaveBeenCalled()
  })
})

describe('what the two tools report', () => {
  it('enters plan mode for a root caller and passes the reported transition through', async () => {
    for (const transition of ['committed', 'noop']) {
      const planMode = fakePlanMode(transition)
      const host = fakeHost({ planMode: planMode.service, agents: fakeAgents({ root: ROOT }, [ROOT]) })
      apply(host.ctx)

      const result = await callTool(host, ENTER_PLAN_MODE_TOOL, { agent: ROOT })

      expect(result).toEqual({ active: true, transition })
      expect(planMode.set).toHaveBeenCalledTimes(1)
      expect(planMode.set).toHaveBeenCalledWith(ROOT, true)
    }
  })

  it('leaves plan mode through leave_plan_mode, reporting active false', async () => {
    const planMode = fakePlanMode('committed')
    const host = fakeHost({ planMode: planMode.service, agents: fakeAgents({ root: ROOT }, [ROOT]) })

    apply(host.ctx)
    const result = await callTool(host, LEAVE_PLAN_MODE_TOOL, { agent: ROOT })

    expect(result).toEqual({ active: false, transition: 'committed' })
    expect(planMode.set).toHaveBeenCalledWith(ROOT, false)
  })

  it('enters and leaves for calls that arrive after a late registration', async () => {
    const planMode = fakePlanMode('committed', 'noop')
    const host = fakeHost({ planMode: planMode.service, agents: fakeAgents({ root: ROOT }, [ROOT]), inject: 'deferred' })

    apply(host.ctx)
    host.deliver()

    expect(await callTool(host, ENTER_PLAN_MODE_TOOL, { agent: ROOT })).toEqual({ active: true, transition: 'committed' })
    expect(await callTool(host, LEAVE_PLAN_MODE_TOOL, { agent: ROOT })).toEqual({ active: false, transition: 'noop' })
    expect(planMode.set.mock.calls).toEqual([[ROOT, true], [ROOT, false]])
  })

  it('reports PLAN_MODE_UNAVAILABLE where the service leaves after the tools were registered', async () => {
    // 工具挂在行上（不是挂在注入 scope 上），所以服务走了工具还在，调用时报这个码。
    const host = fakeHost({ planMode: fakePlanMode('committed').service, agents: fakeAgents({ root: ROOT }, [ROOT]) })

    apply(host.ctx)
    host.drop('planMode')

    expect(host.tools.size).toBe(2)
    await expect(callTool(host, ENTER_PLAN_MODE_TOOL, { agent: ROOT })).rejects.toMatchObject({ code: 'PLAN_MODE_UNAVAILABLE' })
    await expect(callTool(host, LEAVE_PLAN_MODE_TOOL, { agent: ROOT })).rejects.toMatchObject({ code: 'PLAN_MODE_UNAVAILABLE' })
  })
})

/**
 * 这一段是「缓存成本」的自动护栏，不是文案欣赏。
 *
 * Kimi 线路按请求内容前缀命中：system 或工具列表一变，整个前缀缓存归零。进入计划
 * 模式那一步两样都变（section 换新、exit_plan_mode 首次进工具表），那一次重建无法
 * 避免；能压的是**重建之后每一步都还要重发的字节**——两个工具描述（常驻）与 section
 * （常驻）。详细的计划指引因此搬到工具返回里：工具结果是末尾追加，不破坏前缀。
 *
 * 下面同时钉住「压缩没有削弱规则」：三条护栏在 section 里（手动 /plan 路径唯一的
 * 兜底），决策完备清单/唯一最后调用/打回循环/批准前不实施在 enter 返回里。
 */
describe('the plan-mode texts: resident budgets and the rules they still carry', () => {
  it('keeps both tool descriptions inside their resident budgets', () => {
    expect(ENTER_DESCRIPTION.length).toBeLessThanOrEqual(380)
    expect(LEAVE_DESCRIPTION.length).toBeLessThanOrEqual(220)
  })

  it('keeps the trigger conditions in the enter description', () => {
    expect(ENTER_DESCRIPTION).toContain('Dispatch mode only')
    expect(ENTER_DESCRIPTION).toContain('triaged L2')
    expect(ENTER_DESCRIPTION).toContain('R-G interview has converged')
    expect(ENTER_DESCRIPTION).toContain('frontier empty')
    expect(ENTER_DESCRIPTION).toContain('user confirmed shared understanding')
    // 本步只完成进入；探索与出计划在下一步——这是 R9 的两条底线。
    expect(ENTER_DESCRIPTION).toContain('This step completes only the entry')
    expect(ENTER_DESCRIPTION).toContain('exploring and writing the plan happen in your next step')
    // 两个否定触发条件。
    expect(ENTER_DESCRIPTION).toContain('Never call it for L0/L1')
    expect(ENTER_DESCRIPTION).toContain('while a frontier question is open')
  })

  it('keeps the leave description from being read as an approval path', () => {
    expect(LEAVE_DESCRIPTION).toContain('without submitting a plan')
    expect(LEAVE_DESCRIPTION).toContain('It is NOT the approval exit')
    expect(LEAVE_DESCRIPTION).toContain('exit_plan_mode')
    expect(LEAVE_DESCRIPTION).toContain('use it only when the user explicitly says no plan is wanted')
  })

  it('carries the decision-complete manual in the enter result instead of the description', () => {
    const text = enterResultText({ active: true, transition: 'committed' })
    expect(text.length).toBeLessThanOrEqual(1400)
    // 只读探索：不写文件、不跑会重写工作区文件的命令。
    expect(text).toContain('explore read-only')
    expect(text).toContain('never edit or write files, mutate config')
    expect(text).toContain('any command that rewrites tracked files')
    expect(text).toContain('list_subagent_models')
    // 决策完备清单：七项一个不少。
    for (const item of [
      'goal and success criteria',
      'changes grouped by subsystem',
      'public API, schema and data-flow changes',
      'boundaries and failure modes',
      'test strategy',
      'acceptance criteria',
      'explicit assumptions',
    ]) {
      expect(text).toContain(item)
    }
    // 唯一且最后的调用，且不得用散文问「是否继续」。
    expect(text).toContain('as the sole and final tool call of that turn')
    expect(text).toContain('never ask "should I proceed?" in prose or via ask_user_question')
    // 打回循环：按反馈修订后再呈交，不退出计划模式。
    expect(text).toContain('If the plan is rejected, fold the feedback in and submit it again')
    expect(text).toContain('a rejection keeps you in Plan Mode, it is not an exit')
    // 批准前不实施、不派发。
    expect(text).toContain('implement nothing and dispatch nothing before approval')
    expect(text).toContain('abandons planning without approving anything')
    // 非首次进入的分支带着同一套指引：它不是只给第一次进入看的。
    const already = enterResultText({ active: true, transition: 'queued' })
    expect(already.length).toBeLessThanOrEqual(1400)
    expect(already).toContain('implement nothing and dispatch nothing before approval')
  })

  it('keeps the leave result pointing at the approval exit without describing an approval', () => {
    const text = leaveResultText({ active: false, transition: 'committed' })
    expect(text).toContain('Left plan mode without submitting a plan')
    expect(text).toContain('this is the abandon path, not the approval exit')
    expect(text).toContain(APPROVAL_EXIT_TOOL + ' is the only way to present a plan')
    expect(text).toContain('re-enter with ' + ENTER_PLAN_MODE_TOOL)
  })
})
