/**
 * Timeline 规划段前缀缓存守卫的单元测试。
 *
 * 实验性 Timeline 插件把显示语言拼进 `timeline:planning` 系统段、把写作提示词挂在
 * `timeline_tasks` 的描述 getter 上。两者都会在会话中途变化，而 Kimi/MiniMax 的
 * system prompt 只能作为请求头送出新版本——改一次就是整段前缀重建。
 *
 * 守卫用结构探测接在 `system-prompt/assemble`、`agent/pre-step` 与
 * `tools.definitions` 三处，因此这里用假上下文代替真实 harness 服务。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TIMELINE_CACHE_PROVIDERS,
  TIMELINE_SECTION,
  TIMELINE_TASK_TOOL,
  installTimelineCacheGuard,
  resolveTimelineCacheGuardEnabled,
  timelineGuidanceUpdateText,
} from '../src/host/timeline-cache-guard.ts'

/** 宿主事件监听器。 */
type HostListener = (...args: any[]) => any

/**
 * 造一个装配 scope。
 * @param provider - provider id。
 * @returns scope 对象。
 */
function scopeOf(provider: string): Record<string, unknown> {
  return { session: { requestHeader: () => ({ config: { provider, model: 'k3' } }) } }
}

/**
 * 造一个假宿主上下文。
 * @param tools - `ctx.get('tools')` 要返回的工具层。
 * @returns 上下文、监听器表与告警列表。
 */
function createHost(tools?: unknown): {
  ctx: Record<string, unknown>
  listeners: Map<string, HostListener>
  warnings: string[]
} {
  const listeners = new Map<string, HostListener>()
  const warnings: string[] = []
  const ctx: Record<string, unknown> = {
    get(name: string): unknown {
      return name === 'tools' ? tools : undefined
    },
    on(event: string, listener: HostListener): () => void {
      listeners.set(event, listener)
      return () => {
        listeners.delete(event)
      }
    },
    logger: { warn: (message: string) => { warnings.push(message) } },
  }
  return { ctx, listeners, warnings }
}

/**
 * 跑一次 `system-prompt/assemble` 瀑布。
 * @param listeners - 监听器表。
 * @param scope - 装配 scope。
 * @param sections - 下一棒要交回的段。
 * @returns 装配结果。
 */
async function assemble(
  listeners: Map<string, HostListener>,
  scope: unknown,
  sections: { name: string; text: string }[],
): Promise<{ sections: { name?: unknown; text?: unknown }[] }> {
  const listener = listeners.get('system-prompt/assemble')
  expect(listener).toBeDefined()
  return await listener!({}, { scope }, async () => ({ sections })) as
    { sections: { name?: unknown; text?: unknown }[] }
}

/**
 * 取一次装配结果里 `timeline:planning` 的正文。
 * @param result - 装配结果。
 * @returns 段正文。
 */
function planningText(result: { sections: { name?: unknown; text?: unknown }[] }): string {
  const section = result.sections.find(entry => entry.name === TIMELINE_SECTION)
  return typeof section?.text === 'string' ? section.text : ''
}

/**
 * 跑一次 `agent/pre-step` 瀑布。
 * @param listeners - 监听器表。
 * @param agent - 本步 agent（守卫的桶键）。
 * @param messages - 下一棒给出的本步消息。
 * @returns 决策。
 */
async function preStep(
  listeners: Map<string, HostListener>,
  agent: unknown,
  messages: unknown[] = [],
): Promise<{ kind?: unknown; messages?: unknown[] }> {
  const listener = listeners.get('agent/pre-step')
  expect(listener).toBeDefined()
  return await listener!({ agent }, async () => ({ kind: 'enter', messages })) as
    { kind?: unknown; messages?: unknown[] }
}

describe('resolveTimelineCacheGuardEnabled', () => {
  it('defaults to on and only an explicit false disables it', () => {
    expect(resolveTimelineCacheGuardEnabled(undefined)).toBe(true)
    expect(resolveTimelineCacheGuardEnabled({})).toBe(true)
    expect(resolveTimelineCacheGuardEnabled({ timelineCacheGuard: true })).toBe(true)
    expect(resolveTimelineCacheGuardEnabled({ timelineCacheGuard: false })).toBe(false)
  })

  it('protects both lines that bill for prefix cache', () => {
    expect([...DEFAULT_TIMELINE_CACHE_PROVIDERS]).toEqual(['kimi-code', 'minimax-code'])
  })
})

describe('installTimelineCacheGuard', () => {
  it('freezes the planning section at the first text it sees', async () => {
    const { ctx, listeners } = createHost()
    const guard = installTimelineCacheGuard(ctx)
    const scope = scopeOf('kimi-code')

    const first = await assemble(listeners, scope, [
      { name: 'other', text: 'stable' },
      { name: TIMELINE_SECTION, text: 'guidance in Chinese' },
    ])
    expect(planningText(first)).toBe('guidance in Chinese')

    // 浏览器上报了另一种语言：段正文变了，但请求头必须还是第一份。
    const second = await assemble(listeners, scope, [
      { name: 'other', text: 'stable' },
      { name: TIMELINE_SECTION, text: 'guidance in English' },
    ])
    expect(planningText(second)).toBe('guidance in Chinese')
    expect(second.sections[0]).toEqual({ name: 'other', text: 'stable' })
    guard.dispose()
  })

  it('delivers the new guidance once, at the tail, instead of dropping it', async () => {
    const { ctx, listeners } = createHost()
    const guard = installTimelineCacheGuard(ctx)
    const scope = scopeOf('kimi-code')

    await assemble(listeners, scope, [{ name: TIMELINE_SECTION, text: 'v1' }])
    await assemble(listeners, scope, [{ name: TIMELINE_SECTION, text: 'v2' }])

    const first = await preStep(listeners, scope)
    expect(first.kind).toBe('enter')
    expect(first.messages).toHaveLength(1)
    const notice = first.messages![0] as { content: { text: string }[], source: { kind: string } }
    expect(notice.source.kind).toBe('timeline-cache-notice')
    expect(notice.content[0]!.text).toBe(timelineGuidanceUpdateText('v2'))

    // 同一次变更只投一次。
    const second = await preStep(listeners, scope)
    expect(second.messages).toHaveLength(0)
    guard.dispose()
  })

  it('keeps each session on its own frozen copy', async () => {
    const { ctx, listeners } = createHost()
    const guard = installTimelineCacheGuard(ctx)
    const a = scopeOf('kimi-code')
    const b = scopeOf('kimi-code')

    await assemble(listeners, a, [{ name: TIMELINE_SECTION, text: 'session A guidance' }])
    const forB = await assemble(listeners, b, [{ name: TIMELINE_SECTION, text: 'session B guidance' }])
    expect(planningText(forB)).toBe('session B guidance')
    guard.dispose()
  })

  it('leaves providers outside the list untouched', async () => {
    const { ctx, listeners } = createHost()
    const guard = installTimelineCacheGuard(ctx)
    const scope = scopeOf('claude')

    await assemble(listeners, scope, [{ name: TIMELINE_SECTION, text: 'v1' }])
    const second = await assemble(listeners, scope, [{ name: TIMELINE_SECTION, text: 'v2' }])
    // 不在名单内：不冻结（这条线路自己处理系统提示）。
    expect(planningText(second)).toBe('v2')
    guard.dispose()
  })

  it('is inert and warns once when no Timeline section ever appears', async () => {
    const { ctx, listeners, warnings } = createHost()
    const guard = installTimelineCacheGuard(ctx)
    await assemble(listeners, scopeOf('kimi-code'), [{ name: 'other', text: 'x' }])
    await assemble(listeners, scopeOf('kimi-code'), [{ name: 'other', text: 'x' }])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(TIMELINE_SECTION)
    guard.dispose()
  })

  it('does nothing at all when disabled', async () => {
    const { ctx, listeners } = createHost()
    const guard = installTimelineCacheGuard(ctx, { enabled: () => false })
    const scope = scopeOf('kimi-code')
    await assemble(listeners, scope, [{ name: TIMELINE_SECTION, text: 'v1' }])
    const second = await assemble(listeners, scope, [{ name: TIMELINE_SECTION, text: 'v2' }])
    expect(planningText(second)).toBe('v2')
    guard.dispose()
  })

  it('freezes the timeline_tasks description so a taskPrompt edit cannot rewrite the tool table', () => {
    let description = 'write tasks with guidance A'
    const definition = {
      name: TIMELINE_TASK_TOOL,
      get description(): string {
        return description
      },
    }
    const tools = {
      definitions: () => [definition],
    }
    const { ctx } = createHost(tools)
    const guard = installTimelineCacheGuard(ctx)
    const list = (scope: unknown): readonly { description?: unknown }[] =>
      (tools.definitions as unknown as (scope?: unknown) => readonly { description?: unknown }[])(
        scope,
      )

    const scope = scopeOf('kimi-code')
    expect(list(scope)[0]!.description).toBe('write tasks with guidance A')

    // 设置里改了 taskPrompt：注册表里的 getter 换成新文本。
    description = 'write tasks with guidance B'
    expect(list(scope)[0]!.description).toBe('write tasks with guidance A')
    // 冻结只影响受保护线路。
    expect(list(scopeOf('claude'))[0]!.description).toBe('write tasks with guidance B')

    guard.dispose()
    expect(list(scope)[0]!.description).toBe('write tasks with guidance B')
  })

  it('restores the tool registry it wrapped when disposed', () => {
    const original = () => [{ name: TIMELINE_TASK_TOOL, description: 'a' }]
    const tools = { definitions: original }
    const { ctx } = createHost(tools)
    const guard = installTimelineCacheGuard(ctx)
    expect(tools.definitions).not.toBe(original)
    guard.dispose()
    expect(tools.definitions).toBe(original)
  })

  it('keeps each scope on its own frozen task description', () => {
    // 两个部署/两个 scope 共用同一个工具注册表时，描述快照必须是 per-scope 的：
    // 进程级单例会让后一个 scope 拿到前一个的文案，表现成「换了提示词却没生效」。
    let description = 'deployment A guidance'
    const definition = {
      name: TIMELINE_TASK_TOOL,
      get description(): string {
        return description
      },
    }
    const tools = { definitions: () => [definition] }
    const { ctx } = createHost(tools)
    const guard = installTimelineCacheGuard(ctx)
    const read = (scope: unknown): unknown =>
      (tools.definitions as unknown as (scope?: unknown) => { description?: unknown }[])(scope)[0]!.description

    const a = scopeOf('kimi-code')
    const b = scopeOf('kimi-code')
    expect(read(a)).toBe('deployment A guidance')

    // 第二个 scope 首次见到的是另一份文案：它应当以那一份为基线，而不是被 A 冻结。
    description = 'deployment B guidance'
    expect(read(b)).toBe('deployment B guidance')

    // 此后两者各自冻结，互不影响。
    description = 'deployment A guidance v2'
    expect(read(a)).toBe('deployment A guidance')
    expect(read(b)).toBe('deployment B guidance')
    guard.dispose()
    expect(read(a)).toBe('deployment A guidance v2')
  })

  it('wraps a tool registry that only appears through the injection surface', () => {
    // Cordis 里工具服务常常晚于本守卫就绪：ctx.get('tools') 当场读不到，只能靠
    // inject(['tools']) 等它出现。包不上就等于描述冻结完全失效。
    let description = 'guidance A'
    const definition = {
      name: TIMELINE_TASK_TOOL,
      get description(): string {
        return description
      },
    }
    const tools = { definitions: () => [definition] }
    const injected: Array<(scope: unknown) => void> = []
    const ctx: Record<string, unknown> = {
      get: () => undefined,
      on: () => () => undefined,
      logger: { warn: () => undefined },
      inject: (_services: string[], callback: (scope: unknown) => void) => {
        injected.push(callback)
      },
    }
    const guard = installTimelineCacheGuard(ctx)
    expect(injected).toHaveLength(1)

    // 工具服务现在才出现；注入回调拿到的 scope 上能读到它。
    injected[0]!({ get: (name: string) => (name === 'tools' ? tools : undefined) })
    const scope = scopeOf('kimi-code')
    const read = (): unknown => (tools.definitions as unknown as (scope?: unknown) => { description?: unknown }[])(scope)[0]!.description
    expect(read()).toBe('guidance A')
    description = 'guidance B'
    expect(read()).toBe('guidance A')
    guard.dispose()
    expect(read()).toBe('guidance B')
  })

  it('never throws when the host has no event bus', () => {
    expect(() => installTimelineCacheGuard({}).dispose()).not.toThrow()
  })

  it('passes the pre-step decision through unchanged on reject', async () => {
    const { ctx, listeners } = createHost()
    const guard = installTimelineCacheGuard(ctx)
    const listener = listeners.get('agent/pre-step')!
    const reject = { kind: 'reject' }
    const result = await listener({ agent: {} }, async () => reject)
    expect(result).toBe(reject)
    guard.dispose()
  })
})
