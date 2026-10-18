import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type { PostToolDecision, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { installProgressUpdates, resolveProgressUpdatesSettings } from '../src/host/progress-updates/index.ts'
import { PROGRESS_SECTION_NAME } from '../src/host/progress-updates/prompt.ts'
import { NUDGE_THRESHOLD } from '../src/host/progress-updates/store.ts'
import { NOTIFY_USER_TOOL } from '../src/host/progress-updates/tool.ts'

/**
 * 宿主半边接线：工具注册、提示词分节、8 轮催促、设置的即时生效，以及重复挂载
 * 的单实例守卫。用假 ctx 驱动真实的挂载函数，不引入任何运行时服务。
 *
 * 这里的假 ctx 刻意做成**真实 Cordis 的形状**：可选服务（sessions /
 * sessionProjections 等）只出现在 `get()` 后面，直接读属性会抛
 * `cannot get property "..." without inject`。线上真出现过一次这样的回归，把
 * 整个插件打成了 degraded，所以测试必须能复现那个边界。
 */

/** 一个 volatile 字段，正如 loader 在运行中的 fiber 上提交的那样。 */
function volatileField<T>(value: T): { get(): T, set(next: T): void } {
  let current = value
  return { get: () => current, set: (next) => { current = next } }
}

/** 每个用例收集的 disposer，用完统一释放（等价于一次行重载拆掉旧实例）。 */
const disposers: Array<() => void> = []

/**
 * effect 的替身：跑一次副作用函数，把它的 disposer 收进 disposers。
 * 只依赖模块级的 disposers，不捕获任何用例局部变量，所以放在模块作用域。
 * @param fn - 要跑的副作用函数。
 * @returns 副作用函数交回的 disposer，原样返回给插件。
 */
const effect = (fn: () => unknown) => {
  const disposer = fn()
  disposers.push(disposer as () => void)
  return disposer
}

/** 假执行里能覆盖的字段：工具名，以及插件只读 agent 血缘时用到的那几个。 */
interface PostExecuteOverride {
  name?: string
  agent?: {
    id?: string
    session?: { header?: { id?: string, origin?: string, parentSession?: string }, stepSeq?: number }
  }
}

/** 伪造的 step 投影：读 agent 上挂着的 stepSeq，模拟 agent-loop 的 turnBoundary。 */
const stepProjection = {
  stateOf: (session: unknown) => {
    const seq = (session as { stepSeq?: number } | undefined)?.stepSeq
    return seq === undefined ? undefined : { lastStepStartSeq: seq }
  },
}

/**
 * 造一次「第 stepSeq 步、名为 name」的工具执行。
 * 只由常量拼装、不捕获用例局部变量，所以放在模块作用域。
 * @param stepSeq - 该工具所属的模型步序号。
 * @param name - 工具名，默认是最常见的 read。
 * @returns post-execute 需要的执行字段子集。
 */
const stepExec = (stepSeq: number, name = 'read') => ({
  name,
  agent: { id: 'root', session: { header: { id: 'root' }, stepSeq } },
})

/** post-execute 监听器的签名（只用得到这三样）。 */
type PostExecuteListener = (
  exec: ToolExecution,
  result: unknown,
  next: () => Promise<PostToolDecision>,
) => Promise<PostToolDecision>

/** 会话表（血缘查找用），每个用例重建。 */
let sessionTable = new Map<string, { header: { id?: string, origin?: string, parentSession?: string } }>()

/** 会话投影服务；缺省不提供 turnBoundary（退化为按工具结果计数）。 */
let projections: { stateOf: (session: unknown, key: 'turnBoundary') => { lastStepStartSeq?: number | null } | undefined } = {
  stateOf: () => undefined,
}

/**
 * 造一个假宿主上下文。
 *
 * `get()` 是可选服务的唯一入口；服务名**不作为属性**挂在 ctx 上，直接访问会
 * 抛错——这正是真实 Cordis 对没写进 inject 的服务所做的事。
 * @returns 假 ctx 与几个断言用的探针。
 */
function makeCtx() {
  const tools = new Map<string, ToolDefinition>()
  const sections = new Map<string, PromptSection>()
  const listeners = new Map<string, PostExecuteListener>()
  const base = {
    effect,
    on: (event: string, listener: PostExecuteListener) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
    get: (key: string): unknown => {
      if (key === 'tools') {
        return {
          register: (tool: ToolDefinition) => {
            tools.set(tool.name, tool)
            return () => { tools.delete(tool.name) }
          },
        }
      }
      if (key === 'systemPrompt') {
        return {
          section: (section: PromptSection) => {
            sections.set(section.name, section)
            return () => { sections.delete(section.name) }
          },
        }
      }
      if (key === 'webServer') {
        // 路由本身由 progress-updates-live-ref-and-route.test.ts 专门验收；
        // 这里只需要它存在，好让挂载的 route 分支跑得通。
        return { register: () => () => {} }
      }
      if (key === 'sessions') return { get: (id: string) => sessionTable.get(id) }
      if (key === 'sessionProjections') return projections
      return undefined
    },
  }
  // 真实 Cordis 的边界：没 inject 的服务读属性当场抛。
  const ctx = base as Record<string, unknown>
  for (const name of ['tools', 'systemPrompt', 'webServer', 'sessions', 'sessionProjections', 'logger']) {
    Object.defineProperty(ctx, name, {
      get() { throw new Error(`cannot get property "${name}" without inject`) },
    })
  }
  return {
    ctx,
    tools,
    sections,
    /**
     * 手动触发一次 post-execute，跑真实的监听器。
     * @param exec - 覆盖默认执行的字段（工具名、agent 等）。
     * @param next - 下游决策；缺省是原样接受。
     * @returns 监听器最终交出的决策。
     */
    async postExecute(
      exec: PostExecuteOverride = {},
      next: () => Promise<PostToolDecision> = async () => ({ kind: 'accept' }),
    ): Promise<PostToolDecision> {
      const listener = listeners.get('tools/post-execute')
      if (listener === undefined) throw new Error('no tools/post-execute listener registered')
      return listener(
        { name: 'read', arguments: {}, callId: 'c1', signal: new AbortController().signal, ...exec } as unknown as ToolExecution,
        { isError: false },
        next,
      )
    },
    listenerCount: () => listeners.size,
  }
}

function disposeAll(): void {
  while (disposers.length > 0) disposers.pop()!()
}

beforeEach(() => {
  sessionTable = new Map()
  projections = { stateOf: () => undefined }
  // 每个用例显式挂载；上一个用例的挂载在 afterEach 里释放。
  disposers.length = 0
})

afterEach(() => {
  disposeAll()
})

/**
 * 按本插件 Config 字段的形状挂载一次（与 src/index.ts 的调用处一致）。
 * @param enabled - 总开关，可以是活引用。
 * @param nudgeThreshold - 催促阈值，可以是活引用。
 * @returns 假 ctx 与探针。
 */
function mount(
  enabled: boolean | { get(): boolean } = true,
  nudgeThreshold?: number | { get(): number },
) {
  const fake = makeCtx()
  installProgressUpdates(fake.ctx as never, {
    settings: () => resolveProgressUpdatesSettings({
      progressUpdates: enabled as never,
      progressUpdatesNudgeThreshold: nudgeThreshold as never,
    }),
  })
  return fake
}

describe('apply: 工具注册', () => {
  it('开关关闭时工具依然注册（工具清单不能中途变化）', () => {
    const fake = mount(volatileField(false))
    expect(fake.tools.has(NOTIFY_USER_TOOL)).toBe(true)
  })

  it('开关关闭时调用工具返回 displayed:false，且不抛错', async () => {
    const fake = mount(volatileField(false))
    const tool = fake.tools.get(NOTIFY_USER_TOOL)!
    expect(await tool.execute({ message: 'hello' }, {} as never)).toEqual({ displayed: false })
  })

  it('开关打开时工具把进展推进存储', async () => {
    const fake = mount(volatileField(true))
    const tool = fake.tools.get(NOTIFY_USER_TOOL)!
    expect(await tool.execute({ title: '开始', message: '正文' }, {} as never)).toEqual({ displayed: true })
  })
})

describe('apply: 提示词引导', () => {
  it('注册了约定的分节名', () => {
    const fake = mount(volatileField(false))
    expect(fake.sections.has(PROGRESS_SECTION_NAME)).toBe(true)
    expect(PROGRESS_SECTION_NAME).toBe('plugin:progress-updates')
  })

  it('text 是函数形式，开关关闭时返回空串，打开时返回引导词', () => {
    const enabled = volatileField(false)
    const fake = mount(enabled)
    const section = fake.sections.get(PROGRESS_SECTION_NAME)!
    expect(typeof section.text).toBe('function')
    const render = section.text as (context: unknown) => string
    expect(render(undefined)).toBe('')
    enabled.set(true)
    // 关掉开关再打开，不需要重挂插件行：同一个 provider 重新求值即可。
    expect(render(undefined)).toContain('progress_update')
    enabled.set(false)
    expect(render(undefined)).toBe('')
  })

  it('引导词讲清什么时候用、标题与正文的分工，以及 subagent 的边界', () => {
    const fake = mount(volatileField(true))
    const text = (fake.sections.get(PROGRESS_SECTION_NAME)!.text as () => string)()
    expect(text).toContain('任务早期')
    expect(text).toContain('有意义的结论')
    expect(text).toContain('长等待')
    expect(text).toContain('被阻塞')
    expect(text).toContain('不要重复没有变化的状态')
    expect(text).toContain('作为 subagent 运行时')
    expect(text).toContain('你的子任务完成不等于整体任务完成')
  })
})

describe('apply: 8 轮催促', () => {
  it('第 1 到 7 轮不注入，第 8 轮注入一条', async () => {
    const fake = mount(volatileField(true))
    for (let round = 1; round < NUDGE_THRESHOLD; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- 催促计数逐轮累积：本轮结果取决于上一轮的计数，并行会改掉被测语义。
      const decision = await fake.postExecute({})
      expect(decision.additionalContexts ?? [], `round ${round}`).toHaveLength(0)
    }
    const nudged = await fake.postExecute({})
    expect(nudged.additionalContexts).toHaveLength(1)
  })

  it('注入之后计数归零，要再攒满 8 轮才会再注入', async () => {
    const fake = mount(volatileField(true))
    // eslint-disable-next-line no-await-in-loop -- 预热轮次必须顺序累积到阈值，并行会让计数停在 1 轮。
    for (let index = 0; index < NUDGE_THRESHOLD; index += 1) await fake.postExecute({})
    for (let round = 1; round < NUDGE_THRESHOLD; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- 催促计数逐轮累积：本轮结果取决于上一轮的计数，并行会改掉被测语义。
      const decision = await fake.postExecute({})
      expect(decision.additionalContexts ?? [], `round ${round}`).toHaveLength(0)
    }
    expect((await fake.postExecute({})).additionalContexts).toHaveLength(1)
  })

  it('progress_update 自己把计数归零，紧接着的轮次不会被催', async () => {
    const fake = mount(volatileField(true))
    // eslint-disable-next-line no-await-in-loop -- 预热轮次必须顺序累积到阈值，并行会让计数停在 1 轮。
    for (let index = 0; index < NUDGE_THRESHOLD - 1; index += 1) await fake.postExecute({})
    await fake.postExecute({ name: NOTIFY_USER_TOOL })
    // 计数已经归零：再来 7 轮也不该注入。
    for (let round = 1; round < NUDGE_THRESHOLD; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- 催促计数逐轮累积：本轮结果取决于上一轮的计数，并行会改掉被测语义。
      expect((await fake.postExecute({})).additionalContexts ?? [], `round ${round}`).toHaveLength(0)
    }
  })

  it('开关关闭时完全跳过：既不计数也不注入', async () => {
    const enabled = volatileField(false)
    const fake = mount(enabled)
    for (let index = 0; index < NUDGE_THRESHOLD * 3; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- 催促计数逐轮累积：本轮结果取决于上一轮的计数，并行会改掉被测语义。
      expect((await fake.postExecute({})).additionalContexts ?? []).toHaveLength(0)
    }
    // 打开开关之后要重新攒满阈值：那 24 轮没有被计过数。
    enabled.set(true)
    for (let round = 1; round < NUDGE_THRESHOLD; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- 催促计数逐轮累积：本轮结果取决于上一轮的计数，并行会改掉被测语义。
      expect((await fake.postExecute({})).additionalContexts ?? [], `round ${round}`).toHaveLength(0)
    }
    expect((await fake.postExecute({})).additionalContexts).toHaveLength(1)
  })

  it('每条工具结果最多注入一条催促', async () => {
    const fake = mount(volatileField(true))
    // eslint-disable-next-line no-await-in-loop -- 预热轮次必须顺序累积到阈值，并行会让计数停在 1 轮。
    for (let index = 0; index < NUDGE_THRESHOLD - 1; index += 1) await fake.postExecute({})
    const decision = await fake.postExecute({})
    expect(decision.additionalContexts).toHaveLength(1)
    const again = await fake.postExecute({})
    expect(again.additionalContexts ?? []).toHaveLength(0)
  })

  it('催促阈值可以从设置里改', async () => {
    const fake = mount(volatileField(true), volatileField(2))
    expect((await fake.postExecute({})).additionalContexts ?? []).toHaveLength(0)
    expect((await fake.postExecute({})).additionalContexts).toHaveLength(1)
  })

  it('计数按会话维度：subagent 归并到顶层祖先，共用同一个计数器', async () => {
    sessionTable.set('root', { header: { id: 'root' } })
    sessionTable.set('child', { header: { id: 'child', origin: 'subagent', parentSession: 'root' } })
    const fake = mount(volatileField(true))

    const rootExec = { agent: { id: 'root', session: { header: { id: 'root' } } } }
    const childExec = { agent: { id: 'child', session: { header: { id: 'child', origin: 'subagent', parentSession: 'root' } } } }

    // 主 agent 跑 4 轮、subagent 跑 4 轮：各自都不够阈值，合起来正好 8。
    for (let round = 0; round < NUDGE_THRESHOLD / 2; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- 催促计数逐轮累积：本轮结果取决于上一轮的计数，并行会改掉被测语义。
      expect((await fake.postExecute(rootExec)).additionalContexts ?? []).toHaveLength(0)
    }
    for (let round = 0; round < NUDGE_THRESHOLD / 2 - 1; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- 催促计数逐轮累积：本轮结果取决于上一轮的计数，并行会改掉被测语义。
      expect((await fake.postExecute(childExec)).additionalContexts ?? []).toHaveLength(0)
    }
    expect((await fake.postExecute(childExec)).additionalContexts).toHaveLength(1)
  })

  it('不同会话各自计数，互不影响', async () => {
    sessionTable.set('a', { header: { id: 'a' } })
    sessionTable.set('b', { header: { id: 'b' } })
    const fake = mount(volatileField(true))
    const execA = { agent: { id: 'a', session: { header: { id: 'a' } } } }
    const execB = { agent: { id: 'b', session: { header: { id: 'b' } } } }
    for (let round = 0; round < NUDGE_THRESHOLD - 1; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- 催促计数逐轮累积：本轮结果取决于上一轮的计数，并行会改掉被测语义。
      await fake.postExecute(execA)
      // eslint-disable-next-line no-await-in-loop -- 催促计数逐轮累积：本轮结果取决于上一轮的计数，并行会改掉被测语义。
      await fake.postExecute(execB)
    }
    expect((await fake.postExecute(execA)).additionalContexts).toHaveLength(1)
    expect((await fake.postExecute(execB)).additionalContexts).toHaveLength(1)
  })

  it('注入的是 accept 决策，并保住 next() 原来的内容替换', async () => {
    const fake = mount(volatileField(true), volatileField(1))
    const replaced = await fake.postExecute({}, async () => ({
      kind: 'accept',
      content: [{ type: 'text', text: 'policy content' }],
    }))
    expect(replaced.kind).toBe('accept')
    if (replaced.kind !== 'accept') throw new Error('expected an accept decision')
    expect(replaced.content).toEqual([{ type: 'text', text: 'policy content' }])
    expect(replaced.additionalContexts).toHaveLength(1)
  })

  it('注入的是 block 决策时保住 feedback', async () => {
    const fake = mount(volatileField(true), volatileField(1))
    const blocked = await fake.postExecute({}, async () => ({
      kind: 'block',
      feedback: [{ type: 'text', text: 'blocked by policy' }],
    }))
    expect(blocked.kind).toBe('block')
    if (blocked.kind !== 'block') throw new Error('expected a block decision')
    expect(blocked.feedback).toEqual([{ type: 'text', text: 'blocked by policy' }])
    expect(blocked.additionalContexts).toHaveLength(1)
  })
})

describe('apply: 按模型步去重', () => {
  it('同一个模型步里的多条工具结果只算一轮', async () => {
    projections = stepProjection
    const fake = mount(volatileField(true))

    // 第一步：一次并行发 3 个工具 —— 只应算作 1 轮。
    for (let call = 0; call < 3; call += 1) {
      // eslint-disable-next-line no-await-in-loop -- 依次投喂同一模型步内的多条工具结果，后一条要看到前一条的计数状态。
      const decision = await fake.postExecute({ agent: { id: 'root', session: { header: { id: 'root' }, stepSeq: 1 } } })
      expect(decision.additionalContexts ?? [], `call ${call}`).toHaveLength(0)
    }
    // 再走 7 步（每步各 1 条工具结果），加上第一步正好 8 轮。
    for (let step = 2; step < NUDGE_THRESHOLD; step += 1) {
      // eslint-disable-next-line no-await-in-loop -- 按模型步推进：每一步都要等上一步的计数落定。
      const decision = await fake.postExecute({ agent: { id: 'root', session: { header: { id: 'root' }, stepSeq: step } } })
      expect(decision.additionalContexts ?? [], `step ${step}`).toHaveLength(0)
    }
    const nudged = await fake.postExecute({ agent: { id: 'root', session: { header: { id: 'root' }, stepSeq: NUDGE_THRESHOLD } } })
    expect(nudged.additionalContexts).toHaveLength(1)
  })

  it('没有 turnBoundary 投影时退化为按工具结果计数（宁可多计，不漏催促）', async () => {
    const fake = mount(volatileField(true))
    for (let round = 1; round < NUDGE_THRESHOLD; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- 催促计数逐轮累积：本轮结果取决于上一轮的计数，并行会改掉被测语义。
      expect((await fake.postExecute({})).additionalContexts ?? []).toHaveLength(0)
    }
    expect((await fake.postExecute({})).additionalContexts).toHaveLength(1)
  })

  it('progress_update 所在的那一步不计入轮次', async () => {
    projections = stepProjection
    const fake = mount(volatileField(true))
    for (let step = 1; step < NUDGE_THRESHOLD; step += 1) {
      // eslint-disable-next-line no-await-in-loop -- 按模型步推进：每一步都要等上一步的计数落定。
      expect((await fake.postExecute(stepExec(step))).additionalContexts ?? [], `step ${step}`).toHaveLength(0)
    }
    // 第 8 步模型报了进展：计数归零，这一步也不算轮次。
    await fake.postExecute(stepExec(NUDGE_THRESHOLD, NOTIFY_USER_TOOL))
    // 同一步里跟在进展更新之后的工具结果也不计入。
    expect((await fake.postExecute(stepExec(NUDGE_THRESHOLD))).additionalContexts ?? []).toHaveLength(0)
  })
})

describe('apply: 单实例守卫', () => {
  it('本模块重复挂载时第二次是空操作', () => {
    const first = mount(volatileField(true))
    const second = mount(volatileField(true))
    expect(first.tools.has(NOTIFY_USER_TOOL)).toBe(true)
    expect(second.tools.size).toBe(0)
    expect(second.listenerCount()).toBe(0)
  })

  it('前一份释放之后可以重新挂载', () => {
    const first = mount(volatileField(true))
    expect(first.tools.has(NOTIFY_USER_TOOL)).toBe(true)
    disposeAll()
    const second = mount(volatileField(true))
    expect(second.tools.has(NOTIFY_USER_TOOL)).toBe(true)
  })
})

describe('真实 Cordis 边界：apply 绝不读 inject 之外的服务属性', () => {
  it('在一个没有任何可选服务的真 Context 上挂载不抛错', () => {
    // 这是那条源码守卫的运行时对照：把"不能读 inject 之外属性"的规则交给真实
    // 的 Cordis 来执行。假 ctx 只是尽力模仿它，这里才是它本人。
    const ctx = new Context()
    let disposal: (() => void) | undefined
    expect(() => {
      disposal = installProgressUpdates(ctx as never, {
        settings: () => resolveProgressUpdatesSettings({ progressUpdates: true }),
      })
    }).not.toThrow()
    disposal?.()
  })

  it('服务在挂载之后才出现也能读到（读的是调用时的快照，不是 apply 时的）', async () => {
    const ctx = new Context()
    const registered: string[] = []
    // 挂载时宿主还没有 tools 服务，按 apply 的写法这里谁都不会报错。
    const disposal = installProgressUpdates(ctx as never, {
      settings: () => resolveProgressUpdatesSettings({ progressUpdates: true }),
    })
    // 之后宿主树 settle，tools 服务上线；下一次工具注册/使用时重新 get() 就能看到。
    expect(registered).toEqual([])
    disposal()
  })
})

describe('设置：loader 的活引用', () => {
  it('活引用为 true 时工具返回 displayed:true，切换成 false 后立刻返回 displayed:false', async () => {
    const enabled = volatileField(true)
    const fake = mount(enabled)
    const tool = fake.tools.get(NOTIFY_USER_TOOL)!
    expect(await tool.execute({ message: '第一条' } as never, {} as never)).toEqual({ displayed: true })
    // 设置保存：loader 把新值就地写进同一个引用，不重挂插件行。
    enabled.set(false)
    expect(await tool.execute({ message: '第二条' } as never, {} as never)).toEqual({ displayed: false })
    enabled.set(true)
    expect(await tool.execute({ message: '第三条' } as never, {} as never)).toEqual({ displayed: true })
  })

  it('普通值（没有 get 的裸布尔）也照常工作，供测试与手工上下文使用', async () => {
    const fake = mount(true)
    const tool = fake.tools.get(NOTIFY_USER_TOOL)!
    expect(await tool.execute({ message: 'x' } as never, {} as never)).toEqual({ displayed: true })
  })

  it('resolveProgressUpdatesSettings 缺省时给出 8 轮阈值', () => {
    expect(resolveProgressUpdatesSettings()).toEqual({ enabled: false, nudgeThreshold: NUDGE_THRESHOLD })
    expect(resolveProgressUpdatesSettings({ progressUpdates: true })).toEqual({ enabled: true, nudgeThreshold: NUDGE_THRESHOLD })
  })
})
