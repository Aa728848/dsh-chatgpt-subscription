import { describe, expect, it } from 'vitest'
import {
  classifyGoalIntake,
  isContinuationOnly,
  isRealUserMessage,
} from '../../src/host/runtime/deepseek-v41-flash/goal-intake.ts'
import { installDeepSeekV41FlashStateAnchor } from '../../src/host/runtime/deepseek-v41-flash/state-anchor.ts'
import { installOpenModelStateAnchor } from '../../src/host/runtime/open-models/index.ts'

type Listener = (...args: unknown[]) => unknown

function createHost() {
  const listeners = new Map<string, Listener[]>()
  const ctx = {
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => {}
    },
  }
  const run = async (event: string, args: unknown[], terminal: () => unknown): Promise<unknown> => {
    const chain = listeners.get(event) ?? []
    let index = 0
    const dispatch = (): unknown => index >= chain.length ? terminal() : chain[index++]!(...args, dispatch)
    return await dispatch()
  }
  return { ctx, run }
}

function agentOf(provider: string, model: string, sessionId: string) {
  return { id: sessionId, model: { current: () => ({ provider, model }) }, session: { header: { id: sessionId }, events: [] } }
}

const text = (value: string) => [{ type: 'text', text: value }]
const user = (value: string) => ({ role: 'user', content: text(value), source: { kind: 'user' } })
const goalRound = (objective: string, round: number) => ({
  role: 'user',
  content: text(`<goal_round>\nObjective: ${JSON.stringify(objective)}\nRound: ${round}/8\n\nContinue working toward the objective in this same session.\n</goal_round>`),
  source: { kind: 'goal', goalId: 'g1', revision: 1, round },
})
const agentMessage = (body: string) => ({
  role: 'user',
  content: [{ type: 'text', text: 'Agent lead sent a message: ' }, { type: 'text', text: body }],
  source: { kind: 'agent-message', form: 'relay', senderSessionId: 'parent' },
})

/** 驱动一个回合：先投递消息，再空跑若干步，返回最后一次锚点里的 GOAL/EARLIER 行。 */
async function anchorLines(host: ReturnType<typeof createHost>, agent: unknown, turn: number, messages: unknown[], steps = 1) {
  await host.run('agent/pre-step', [{ agent, turn, messages }], () => ({ kind: 'enter', messages }))
  let anchor = ''
  for (let step = 0; step < steps; step += 1) {
    const result = await host.run('agent/pre-step', [{ agent, turn, messages: [] }], () => ({ kind: 'enter', messages: [] })) as {
      messages: Array<{ content: Array<{ text: string }> }>
    }
    if (result.messages.length > 0) anchor = result.messages[0]!.content[0]!.text
  }
  const lines = anchor.split('\n')
  return {
    anchor,
    goal: lines.find(line => line.startsWith('GOAL')) ?? '',
    earlier: lines.find(line => line.startsWith('EARLIER')) ?? '',
  }
}

describe('状态锚目标采集：只有真人指令能改写 GOAL', () => {
  it('按消息来源分类，未知来源一律忽略', () => {
    expect(classifyGoalIntake(user('修复 auth.ts 的解析器'))).toEqual({ kind: 'instruction', text: '修复 auth.ts 的解析器' })
    // 旧代宿主不写 source：按真人输入处理。
    expect(classifyGoalIntake({ role: 'user', content: 'Fix parser' }).kind).toBe('instruction')
    expect(classifyGoalIntake({ role: 'user', content: text('ship it'), source: { kind: 'webhook' } }).kind).toBe('instruction')
    expect(classifyGoalIntake(goalRound('把 auth.ts 修好', 2))).toEqual({ kind: 'objective', text: '把 auth.ts 修好' })
    expect(classifyGoalIntake(agentMessage('Review src/a.ts'))).toEqual({ kind: 'agent', text: 'Review src/a.ts' })
    expect(classifyGoalIntake({ role: 'user', content: text('Option A'), source: { kind: 'user-question-reply' } }).kind).toBe('reply')
    for (const kind of ['schedule', 'team-message', 'subagent-settled', 'tool-jobs', 'skill-invocation', 'some-future-kind']) {
      expect(classifyGoalIntake({ role: 'user', content: text('Continue please'), source: { kind } }).kind).toBe('ignore')
    }
    expect(classifyGoalIntake({ role: 'user', content: text('x'), source: { kind: 'user', form: 'notice' } }).kind).toBe('ignore')
    expect(classifyGoalIntake(user('<system-reminder>\nworkspace rules\n</system-reminder>')).kind).toBe('ignore')
    expect(classifyGoalIntake(user('[Open-Model State Anchor | step=8]\nGOAL: x')).kind).toBe('ignore')
  })

  it('识别纯接续短句，带实际要求的消息不算', () => {
    for (const value of ['继续', '继续。', '好的，继续', '可以，就这样改', 'OK, go on', 'Continue', 'keep going!', 'продолжай', '👍']) {
      expect(isContinuationOnly(value), value).toBe(true)
    }
    for (const value of ['继续写测试', '不行，换方案 B', '继续，但别改 config', 'continue with the migration', 'fix it']) {
      expect(isContinuationOnly(value), value).toBe(false)
    }
    expect(classifyGoalIntake(user('继续')).kind).toBe('continue')
  })

  it('只有人或上级代理的消息才算新信息', () => {
    expect(isRealUserMessage(user('继续'))).toBe(true)
    expect(isRealUserMessage(agentMessage('re-scope'))).toBe(true)
    expect(isRealUserMessage(goalRound('x', 3))).toBe(false)
    expect(isRealUserMessage({ role: 'user', content: text('reminder'), source: { kind: 'schedule' } })).toBe(false)
  })

  it('开源模型：继续、目标续跑与子代理汇报都不会顶掉原目标', async () => {
    const host = createHost()
    installOpenModelStateAnchor(host.ctx, { stepIntervalOverride: 1, minPeriodicTokensOverride: 0, estimateContextTokens: () => 0 })
    const agent = agentOf('kimi-code', 'k3.1-pro', 'open-goal')
    const goal = 'GOAL: 把 auth.ts 的解析器边界问题修好并补测试'

    expect((await anchorLines(host, agent, 1, [user('把 auth.ts 的解析器边界问题修好并补测试')])).goal).toBe(goal)
    const continued = await anchorLines(host, agent, 2, [user('继续')])
    expect(continued.goal).toBe(goal)
    expect(continued.earlier).toBe('')
    expect((await anchorLines(host, agent, 3, [goalRound('把 auth.ts 的解析器边界问题修好并补测试', 2)])).goal).toBe(goal)
    expect((await anchorLines(host, agent, 4, [goalRound('把 auth.ts 的解析器边界问题修好并补测试', 3)])).goal).toBe(goal)
    const reported = await anchorLines(host, agent, 5, [agentMessage('继续，按上面的方案改')])
    expect(reported.goal).toBe(goal)
    expect(reported.anchor).not.toContain('Continue working')
  })

  it('V4.1 Flash：目标续跑不会把用户目标挤出，子代理以任务说明为目标', async () => {
    const host = createHost()
    installDeepSeekV41FlashStateAnchor(host.ctx, { stepInterval: 1, minPeriodicTokens: 0, contextWatermarks: [], estimateContextTokens: () => 0 })
    const agent = agentOf('opendesign', 'deepseek-v4.1-flash-1017', 'flash-goal')

    await anchorLines(host, agent, 1, [user('Migrate settings storage')])
    for (let round = 1; round <= 4; round += 1) {
      const lines = await anchorLines(host, agent, 1 + round, [goalRound('Migrate settings storage and keep old keys readable', round)])
      expect(lines.goal).toBe('GOAL: Migrate settings storage and keep old keys readable')
      expect(lines.earlier).toBe('EARLIER (context only): Migrate settings storage')
    }
    expect((await anchorLines(host, agent, 9, [user('继续')])).goal).toBe('GOAL: Migrate settings storage and keep old keys readable')

    const child = agentOf('opendesign', 'deepseek-v4.1-flash-1017', 'flash-child')
    expect((await anchorLines(host, child, 1, [agentMessage('Review src/a.ts for races')])).goal).toBe('GOAL: Review src/a.ts for races')
    expect((await anchorLines(host, child, 2, [agentMessage('继续')])).goal).toBe('GOAL: Review src/a.ts for races')
  })

  it('没有目标时不做周期注入', async () => {
    const host = createHost()
    installOpenModelStateAnchor(host.ctx, { stepIntervalOverride: 1, estimateContextTokens: () => 0 })
    const agent = agentOf('kimi-code', 'k3.1-pro', 'open-empty')
    const lines = await anchorLines(host, agent, 1, [{ role: 'user', content: text('tick'), source: { kind: 'schedule' } }], 3)
    expect(lines.anchor).toBe('')
  })
})
