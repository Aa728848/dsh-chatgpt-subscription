/**
 * `team-policy-cache-guard` 的单元测试。
 *
 * 它守着内置 Agent Teams 的那处前缀重建：`team:policy` 段在开关关闭时是空串、
 * 打开时是整段指引。守卫把段从装配结果里摘掉、改为 `agent/pre-step` 的尾部用户
 * 消息投递一次，并在关闭时补一条撤销通知。
 *
 * 与其它守卫一样只做结构探测，所以这里用假的事件宿主，不引 harness 服务。
 */
import { describe, expect, it } from 'vitest'
import {
  TEAM_POLICY_SECTION,
  installTeamPolicyCacheGuard,
  resolveTeamPolicyCacheGuardEnabled,
} from '../src/host/team-policy-cache-guard.ts'

/** 事件监听器的宽松形状。 */
type HostListener = (...args: never[]) => unknown

/** 一段装配出来的系统段。 */
interface FakeSection {
  name: string
  text: string
}

/** 一次装配结果。 */
interface FakeAssembly {
  sections: FakeSection[]
}

/** 一条 pre-step 决策。 */
interface FakeDecision {
  kind?: string
  messages: unknown[]
}

/**
 * 造一个假宿主。
 * @returns 上下文、监听器表与告警记录。
 */
function createHost(): {
  ctx: Record<string, unknown>
  listeners: Map<string, HostListener>
  warnings: string[]
} {
  const listeners = new Map<string, HostListener>()
  const warnings: string[] = []
  const ctx: Record<string, unknown> = {
    on(event: string, listener: HostListener): () => void {
      listeners.set(event, listener)
      return () => {
        listeners.delete(event)
      }
    },
    logger: {
      warn(message: string): void {
        warnings.push(message)
      },
    },
  }
  return { ctx, listeners, warnings }
}

/**
 * 跑一次 `system-prompt/assemble` 瀑布。
 * @param listeners - 监听器表。
 * @param scope - 装配 scope（会话装配时就是 agent）。
 * @param sections - 下游产出的段。
 * @returns 最终装配结果。
 */
async function runAssemble(
  listeners: Map<string, HostListener>,
  scope: unknown,
  sections: FakeSection[],
): Promise<FakeAssembly> {
  const listener = listeners.get('system-prompt/assemble')
  expect(listener).toBeDefined()
  return await (listener as unknown as (
    payload: unknown,
    context: unknown,
    next: () => Promise<FakeAssembly>,
  ) => Promise<FakeAssembly>)({}, { scope }, async () => ({ sections }))
}

/**
 * 跑一次 `agent/pre-step` 瀑布。
 * @param listeners - 监听器表。
 * @param agent - 本步 agent。
 * @param messages - 本步已有的消息。
 * @returns 最终决策。
 */
async function runPreStep(
  listeners: Map<string, HostListener>,
  agent: unknown,
  messages: unknown[] = [],
): Promise<FakeDecision> {
  const listener = listeners.get('agent/pre-step')
  expect(listener).toBeDefined()
  return await (listener as unknown as (
    payload: unknown,
    next: () => Promise<FakeDecision>,
  ) => Promise<FakeDecision>)({ agent }, async () => ({ messages }))
}

/**
 * 读一条尾部通知的正文。
 * @param message - 投递出去的消息。
 * @returns 第一段文本。
 */
function noticeText(message: unknown): string {
  const content = (message as { content?: { type?: unknown, text?: unknown }[] }).content
  const first = Array.isArray(content) ? content[0] : undefined
  return typeof first?.text === 'string' ? first.text : ''
}

describe('resolveTeamPolicyCacheGuardEnabled', () => {
  it('defaults to on, and only an explicit false turns it off', () => {
    expect(resolveTeamPolicyCacheGuardEnabled(undefined)).toBe(true)
    expect(resolveTeamPolicyCacheGuardEnabled({})).toBe(true)
    expect(resolveTeamPolicyCacheGuardEnabled({ teamPolicyCacheGuard: true })).toBe(true)
    expect(resolveTeamPolicyCacheGuardEnabled({ teamPolicyCacheGuard: 'yes' })).toBe(true)
    expect(resolveTeamPolicyCacheGuardEnabled({ teamPolicyCacheGuard: false })).toBe(false)
  })
})

describe('installTeamPolicyCacheGuard', () => {
  it('does nothing while the setting is off', async () => {
    const { ctx, listeners } = createHost()
    const guard = installTeamPolicyCacheGuard(ctx, { enabled: () => false })
    try {
      const agent = { id: 'a' }
      const sections = [{ name: TEAM_POLICY_SECTION, text: 'board guidance' }, { name: 'other', text: 'x' }]
      const assembly = await runAssemble(listeners, agent, sections)
      // 段原样留下：关掉的守卫不该改变装配结果。
      expect(assembly.sections.map(entry => entry.name)).toEqual([TEAM_POLICY_SECTION, 'other'])
      const decision = await runPreStep(listeners, agent)
      expect(decision.messages).toHaveLength(0)
    } finally {
      guard.dispose()
    }
  })

  it('strips the section from the assembly and delivers it once, at the tail', async () => {
    const { ctx, listeners } = createHost()
    const guard = installTeamPolicyCacheGuard(ctx, { enabled: () => true })
    try {
      const agent = { id: 'a' }
      const assembly = await runAssemble(listeners, agent, [
        { name: 'before', text: 'b' },
        { name: TEAM_POLICY_SECTION, text: 'board guidance' },
        { name: 'after', text: 'a' },
      ])
      // system 段逐字节恒定：团队段被摘掉，其余段顺序不变。
      expect(assembly.sections.map(entry => entry.name)).toEqual(['before', 'after'])

      const first = await runPreStep(listeners, agent, [{ role: 'user' }])
      expect(first.messages).toHaveLength(2)
      expect(noticeText(first.messages[1])).toBe('board guidance')

      // 同一次激活只投一次：再装配、再走一步都不重复。
      await runAssemble(listeners, agent, [{ name: TEAM_POLICY_SECTION, text: 'board guidance' }])
      const second = await runPreStep(listeners, agent)
      expect(second.messages).toHaveLength(0)
    } finally {
      guard.dispose()
    }
  })

  it('treats the empty text as the end of an activation and delivers again on the next one', async () => {
    const { ctx, listeners } = createHost()
    const guard = installTeamPolicyCacheGuard(ctx, { enabled: () => true })
    try {
      const agent = { id: 'a' }
      await runAssemble(listeners, agent, [{ name: TEAM_POLICY_SECTION, text: 'first' }])
      await runPreStep(listeners, agent)
      // 关闭：官方段回到空串。
      await runAssemble(listeners, agent, [{ name: TEAM_POLICY_SECTION, text: '' }])
      // 重新打开：给的是新正文，必须再投一次。
      await runAssemble(listeners, agent, [{ name: TEAM_POLICY_SECTION, text: 'second' }])
      const decision = await runPreStep(listeners, agent)
      const texts = decision.messages.map(noticeText)
      expect(texts.some(text => text.includes('second'))).toBe(true)
    } finally {
      guard.dispose()
    }
  })

  it('announces the board going off so the stale guidance does not keep pointing at it', async () => {
    const { ctx, listeners } = createHost()
    const guard = installTeamPolicyCacheGuard(ctx, { enabled: () => true })
    try {
      const agent = { id: 'a' }
      await runAssemble(listeners, agent, [{ name: TEAM_POLICY_SECTION, text: 'board guidance' }])
      await runPreStep(listeners, agent)
      await runAssemble(listeners, agent, [{ name: TEAM_POLICY_SECTION, text: '' }])
      const off = await runPreStep(listeners, agent)
      expect(off.messages).toHaveLength(1)
      expect(noticeText(off.messages[0])).toContain('was turned off')
      // 撤销只补一次。
      const again = await runPreStep(listeners, agent)
      expect(again.messages).toHaveLength(0)
    } finally {
      guard.dispose()
    }
  })

  it('warns once when the section never appears, instead of failing silently', async () => {
    const { ctx, listeners, warnings } = createHost()
    const guard = installTeamPolicyCacheGuard(ctx, { enabled: () => true })
    try {
      await runAssemble(listeners, {}, [{ name: 'other', text: 'x' }])
      await runAssemble(listeners, {}, [{ name: 'other', text: 'x' }])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(TEAM_POLICY_SECTION)
    } finally {
      guard.dispose()
    }
  })

  it('never delivers an empty body', async () => {
    const { ctx, listeners } = createHost()
    const guard = installTeamPolicyCacheGuard(ctx, { enabled: () => true })
    try {
      const agent = { id: 'a' }
      await runAssemble(listeners, agent, [{ name: TEAM_POLICY_SECTION, text: '   ' }])
      const decision = await runPreStep(listeners, agent)
      expect(decision.messages).toHaveLength(0)
    } finally {
      guard.dispose()
    }
  })

  it('stops touching the assembly and the pre-step after dispose', async () => {
    const { ctx, listeners } = createHost()
    const guard = installTeamPolicyCacheGuard(ctx, { enabled: () => true })
    guard.dispose()
    // dispose 摘掉监听器：瀑布里已经没有人，装配由下游直接决定。
    expect(listeners.has('system-prompt/assemble')).toBe(false)
    expect(listeners.has('agent/pre-step')).toBe(false)
  })
})
