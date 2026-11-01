import { describe, expect, it } from 'vitest'
import {
  MANDATE_FENCE_CLOSE,
  MANDATE_FENCE_OPEN,
} from '../src/host/dispatch-ledger/header.ts'
import {
  createDispatchLedgerCache,
  createDispatchLedgerGuard,
  installDispatchLedgerGuard,
  type DispatchGuardExecution,
  type DispatchLedgerSessionLike,
  type DispatchLedgerSessions,
} from '../src/host/dispatch-ledger/guard.ts'
import { dispatchPolicyDescriptor } from '../src/host/dispatch-ledger/policy.ts'
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

/** 一份合法的报告头字段。 */
function reportFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 2,
    kind: 'report',
    brief_id: 'b-7f',
    run_id: 'r-1',
    idem: 'i-1',
    mandate_version: 1,
    prompt_ref: 'plan-v3',
    policy: { id: POLICY.id, version: POLICY.version, sha256: POLICY.sha256 },
    status: 'ready',
    ...overrides,
  }
}

/** 一份合法的续派头字段。 */
function steerFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 2,
    kind: 'steer',
    brief_id: 'b-7f',
    run_id: 'r-1',
    idem: 'i-1',
    mandate_version: 1,
    prompt_ref: 'plan-v3',
    policy: { id: POLICY.id, version: POLICY.version, sha256: POLICY.sha256 },
    grant: { context: ['ctx://plan-v3'] },
    ...overrides,
  }
}

/** 把字段包成一段带头部的文本。 */
function withHeader(fields: Record<string, unknown>, body = 'do the work'): string {
  return MANDATE_FENCE_OPEN + '\n' + JSON.stringify(fields) + '\n' + MANDATE_FENCE_CLOSE + '\n' + body
}

/** 命名空间键。 */
function nsOf(brief_id: string, run_id: string, idem: string): string {
  return brief_id + '\u0000' + run_id + '\u0000' + idem
}

/** 一次原生工具调用。 */
function nativeCall(
  seq: number,
  callId: string,
  prompt: string,
  name = 'subagent',
): DispatchLedgerEventLike {
  return {
    type: 'tool/call',
    seq,
    time: 1000 + seq,
    data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify({ description: 'd', prompt }) },
  }
}

/** 一次原生工具结果。 */
function nativeResult(
  seq: number,
  callId: string,
  isError: boolean,
  text: string,
): DispatchLedgerEventLike {
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

/** 一次子代理收到的派发提示词事件。 */
function childPromptEvent(seq: number, prompt: string): DispatchLedgerEventLike {
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    data: {
      content: [
        { type: 'text', text: prompt },
        { type: 'text', text: 'Your parent agent id is "dispatcher-1".' },
      ],
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

/** 造一台守卫与它的会话注册表。 */
function harness(sessions: Record<string, DispatchLedgerSessionLike> = {}) {
  const registry: DispatchLedgerSessions = {
    get: (id: string) => sessions[id],
    list: () => Object.values(sessions),
  }
  const cache = createDispatchLedgerCache()
  const guard = createDispatchLedgerGuard({
    cache,
    sessions: () => registry,
    policyFor: () => POLICY,
  })
  return { registry, cache, guard }
}

/** 一条执行。 */
function dispatch(prompt: string, session: DispatchLedgerSessionLike, callId: string): DispatchGuardExecution {
  return { name: 'subagent', arguments: { prompt }, agent: { session }, callId }
}

describe('调度账本守卫：派发', () => {
  it('没有头部 → 放行（旧消息降级审计）', () => {
    const { guard } = harness()
    const session = makeSession('dispatcher-1', [])
    expect(guard(dispatch('just a task', session, 'call-a'))).toBeUndefined()
  })

  it('头部显式损坏 → 拒 MANDATE_MALFORMED', () => {
    const { guard } = harness()
    const session = makeSession('dispatcher-1', [])
    const denial = guard(dispatch(MANDATE_FENCE_OPEN + '\n{bad}\n' + MANDATE_FENCE_CLOSE, session, 'call-a'))
    expect(denial).toContain('MANDATE_MALFORMED')
    expect(denial?.startsWith('DISPATCH_LEDGER_V2:MANDATE_MALFORMED:')).toBe(true)
  })

  it('第一次派发 → 放行', () => {
    const { guard } = harness()
    const prompt = withHeader(dispatchFields())
    const session = makeSession('dispatcher-1', [nativeCall(1, 'call-a', prompt)])
    expect(guard(dispatch(prompt, session, 'call-a'))).toBeUndefined()
  })

  it('并行同命名空间：第二次被拒，原运行仍 booked', () => {
    const { guard, cache } = harness()
    const prompt = withHeader(dispatchFields())
    const session = makeSession('dispatcher-1', [
      nativeCall(1, 'call-a', prompt),
      nativeCall(2, 'call-b', prompt),
    ])
    const denial = guard(dispatch(prompt, session, 'call-b'))
    expect(denial).toContain('MANDATE_DUPLICATE')
    expect(denial?.startsWith('DISPATCH_LEDGER_V2:MANDATE_DUPLICATE:')).toBe(true)
    const state = cache.fold(session)
    expect(state.runs[nsOf('b-7f', 'r-1', 'i-1')]?.state).toBe('booked')
  })

  it('released 之后同命名空间仍然被拒', () => {
    const { guard } = harness()
    const prompt = withHeader(dispatchFields())
    const session = makeSession('dispatcher-1', [
      nativeCall(1, 'call-a', prompt),
      nativeResult(2, 'call-a', true, 'Error: boom'),
    ])
    const denial = guard(dispatch(prompt, session, 'call-b'))
    expect(denial).toContain('MANDATE_DUPLICATE')
  })

  it('released 之后同 brief 可以开新的一次运行（换新 run_id 与 idem，并声明血缘）', () => {
    const { guard } = harness()
    const first = withHeader(dispatchFields())
    const second = withHeader(dispatchFields({
      run_id: 'r-2',
      idem: 'i-2',
      parent_mandate: { brief_id: 'b-7f', run_id: 'r-1', idem: 'i-1' },
    }))
    const session = makeSession('dispatcher-1', [
      nativeCall(1, 'call-a', first),
      nativeResult(2, 'call-a', true, 'Error: boom'),
      nativeCall(3, 'call-b', second),
    ])
    expect(guard(dispatch(second, session, 'call-b'))).toBeUndefined()
  })

  it('同 brief 已有历史运行却没写 parent_mandate → MANDATE_LINEAGE_REQUIRED', () => {
    const { guard } = harness()
    const first = withHeader(dispatchFields())
    const second = withHeader(dispatchFields({ run_id: 'r-2', idem: 'i-2' }))
    const session = makeSession('dispatcher-1', [
      nativeCall(1, 'call-a', first),
      nativeResult(2, 'call-a', true, 'Error: boom'),
      nativeCall(3, 'call-b', second),
    ])
    const denial = guard(dispatch(second, session, 'call-b'))
    expect(denial).toContain('MANDATE_LINEAGE_REQUIRED')
  })

  it('parent_mandate 指错了运行 → MANDATE_LINEAGE', () => {
    const { guard } = harness()
    const first = withHeader(dispatchFields())
    const second = withHeader(dispatchFields({
      run_id: 'r-2',
      idem: 'i-2',
      parent_mandate: { brief_id: 'b-7f', run_id: 'r-9', idem: 'i-9' },
    }))
    const session = makeSession('dispatcher-1', [
      nativeCall(1, 'call-a', first),
      nativeResult(2, 'call-a', true, 'Error: boom'),
      nativeCall(3, 'call-b', second),
    ])
    const denial = guard(dispatch(second, session, 'call-b'))
    expect(denial).toContain('MANDATE_LINEAGE')
  })

  it('策略快照过期 → MANDATE_POLICY_STALE', () => {
    const { guard } = harness()
    const prompt = withHeader(dispatchFields({
      policy: { id: POLICY.id, version: POLICY.version, sha256: 'f'.repeat(64) },
    }))
    const session = makeSession('dispatcher-1', [nativeCall(1, 'call-a', prompt)])
    const denial = guard(dispatch(prompt, session, 'call-a'))
    expect(denial).toContain('MANDATE_POLICY_STALE')
  })

  it('账本满了 → MANDATE_LEDGER_FULL', () => {
    const { guard } = harness()
    const events: DispatchLedgerEventLike[] = []
    for (let index = 0; index < 256; index += 1) {
      const prompt = withHeader(dispatchFields({ brief_id: 'b-' + index, run_id: 'r-1', idem: 'i-1' }))
      events.push(nativeCall(index * 2 + 1, 'call-' + index, prompt))
      events.push(nativeResult(index * 2 + 2, 'call-' + index, true, 'Error: boom'))
    }
    const prompt = withHeader(dispatchFields({ brief_id: 'b-new', run_id: 'r-1', idem: 'i-1' }))
    events.push(nativeCall(1000, 'call-new', prompt))
    const session = makeSession('dispatcher-1', events)
    const denial = guard(dispatch(prompt, session, 'call-new'))
    expect(denial).toContain('MANDATE_LEDGER_FULL')
  })
})

describe('调度账本守卫：报告与续派', () => {
  it('兄弟会话之间互报 → MANDATE_NOT_PARENT', () => {
    const { guard } = harness()
    const child = makeSession('child-1', [childPromptEvent(1, withHeader(dispatchFields()))], 'parent-1')
    const denial = guard({
      name: 'send_message',
      arguments: { agent_id: 'sibling-1', message: withHeader(reportFields()) },
      agent: { session: child },
      callId: 'call-a',
    })
    expect(denial).toContain('MANDATE_NOT_PARENT')
  })

  it('向 durable 父会话报告 → 放行', () => {
    const { guard } = harness()
    const child = makeSession('child-1', [childPromptEvent(1, withHeader(dispatchFields()))], 'parent-1')
    const denial = guard({
      name: 'send_message',
      arguments: { agent_id: 'parent-1', message: withHeader(reportFields()) },
      agent: { session: child },
      callId: 'call-a',
    })
    expect(denial).toBeUndefined()
  })

  it('报告的提示词引用与账本不符 → MANDATE_VERSION', () => {
    const prompt = withHeader(dispatchFields())
    const parent = makeSession('parent-1', [nativeCall(1, 'call-a', prompt)])
    const child = makeSession('child-1', [childPromptEvent(1, prompt)], 'parent-1')
    const { guard } = harness({ 'parent-1': parent, 'child-1': child })
    const denial = guard({
      name: 'send_message',
      arguments: { agent_id: 'parent-1', message: withHeader(reportFields({ prompt_ref: 'plan-v9' })) },
      agent: { session: child },
      callId: 'call-a',
    })
    expect(denial).toContain('MANDATE_VERSION')
  })

  it('持有的是别的 Mandate → MANDATE_NOT_HELD', () => {
    const { guard } = harness()
    const other = withHeader(dispatchFields({ brief_id: 'b-other', run_id: 'r-9', idem: 'i-9' }))
    const child = makeSession('child-1', [childPromptEvent(1, other)], 'parent-1')
    const denial = guard({
      name: 'send_message',
      arguments: { agent_id: 'parent-1', message: withHeader(reportFields()) },
      agent: { session: child },
      callId: 'call-a',
    })
    expect(denial).toContain('MANDATE_NOT_HELD')
  })

  it('续派不是自己的孩子 → MANDATE_NOT_CHILD', () => {
    const prompt = withHeader(dispatchFields())
    const dispatcher = makeSession('dispatcher-1', [nativeCall(1, 'call-a', prompt)])
    const stranger = makeSession('other-1', [], 'someone-else')
    const { guard } = harness({ 'dispatcher-1': dispatcher, 'other-1': stranger })
    const denial = guard({
      name: 'send_message',
      arguments: { agent_id: 'other-1', message: withHeader(steerFields()) },
      agent: { session: dispatcher },
      callId: 'call-a',
    })
    expect(denial).toContain('MANDATE_NOT_CHILD')
    expect(stranger.id).toBe('other-1')
  })

  it('扩权超出 followup → MANDATE_GRANT_EXCEEDS', () => {
    const prompt = withHeader(dispatchFields({ followup: ['ctx://plan-v3'] }))
    const dispatcher = makeSession('dispatcher-1', [nativeCall(1, 'call-a', prompt)])
    const child = makeSession('child-1', [childPromptEvent(1, prompt)], 'dispatcher-1')
    const { guard } = harness({ 'dispatcher-1': dispatcher, 'child-1': child })
    const denial = guard({
      name: 'send_message',
      arguments: { agent_id: 'child-1', message: withHeader(steerFields({ grant: { context: ['ctx://other'] } })) },
      agent: { session: dispatcher },
      callId: 'call-a',
    })
    expect(denial).toContain('MANDATE_GRANT_EXCEEDS')
  })

  it('扩权在 followup 之内 → 放行', () => {
    const prompt = withHeader(dispatchFields({ followup: ['ctx://plan-v3'] }))
    const dispatcher = makeSession('dispatcher-1', [nativeCall(1, 'call-a', prompt)])
    const child = makeSession('child-1', [childPromptEvent(1, prompt)], 'dispatcher-1')
    const { guard } = harness({ 'dispatcher-1': dispatcher, 'child-1': child })
    const denial = guard({
      name: 'send_message',
      arguments: { agent_id: 'child-1', message: withHeader(steerFields({ grant: { context: ['ctx://plan-v3'] } })) },
      agent: { session: dispatcher },
      callId: 'call-a',
    })
    expect(denial).toBeUndefined()
  })

  it('派发头出现在 send_message → MANDATE_KIND', () => {
    const { guard } = harness()
    const child = makeSession('child-1', [], 'parent-1')
    const denial = guard({
      name: 'send_message',
      arguments: { agent_id: 'parent-1', message: withHeader(dispatchFields()) },
      agent: { session: child },
      callId: 'call-a',
    })
    expect(denial).toContain('MANDATE_KIND')
  })
})

describe('调度账本守卫：装配与缓存', () => {
  it('开关关闭时守卫不拦', () => {
    const guard = createDispatchLedgerGuard({ enabled: () => false, policyFor: () => POLICY })
    const session = makeSession('dispatcher-1', [])
    expect(guard(dispatch(MANDATE_FENCE_OPEN + '\n{bad}\n' + MANDATE_FENCE_CLOSE, session, 'call-a'))).toBeUndefined()
  })

  it('装到 ctx.tools.guard 上，返回注销器', () => {
    const registered: ((execution: DispatchGuardExecution) => string | undefined)[] = []
    const ctx = {
      tools: {
        guard: (guard: (execution: DispatchGuardExecution) => string | undefined) => {
          registered.push(guard)
          return () => undefined
        },
      },
    }
    const dispose = installDispatchLedgerGuard(ctx, { policyFor: () => POLICY })
    expect(registered).toHaveLength(1)
    expect(typeof dispose).toBe('function')
  })

  it('缓存按会话分键，增量折叠后状态一致', () => {
    const cache = createDispatchLedgerCache()
    const prompt = withHeader(dispatchFields())
    const events = [nativeCall(1, 'call-a', prompt)]
    const session = makeSession('dispatcher-1', events)
    const first = cache.fold(session)
    expect(Object.keys(first.runs)).toHaveLength(1)
    events.push(nativeResult(2, 'call-a', false, 'started'))
    const second = cache.fold(session)
    expect(second.runs[nsOf('b-7f', 'r-1', 'i-1')]?.attemptTotals.succeeded).toBe(1)
    expect(cache.size()).toBe(1)
  })

  it('缓存有容量上限', () => {
    const cache = createDispatchLedgerCache(2)
    for (let index = 0; index < 5; index += 1) {
      cache.fold(makeSession('s-' + index, []))
    }
    expect(cache.size()).toBe(2)
  })
})

describe('调度账本守卫：容量边界（排除本次调用自己）', () => {
  /** 造 n 条已释放的运行，分布在 briefs 个工作项里。 */
  function releasedRuns(count: number, briefs: number): DispatchLedgerEventLike[] {
    const events: DispatchLedgerEventLike[] = []
    for (let index = 0; index < count; index += 1) {
      const prompt = withHeader(dispatchFields({
        brief_id: 'b-' + (index % briefs),
        run_id: 'r-' + index,
        idem: 'i-' + index,
      }))
      events.push(nativeCall(index * 2 + 1, 'call-' + index, prompt))
      events.push(nativeResult(index * 2 + 2, 'call-' + index, true, 'Error: boom'))
    }
    return events
  }

  it('原先 255 run：第 256 条放行', () => {
    const { guard } = harness()
    const events = releasedRuns(255, 1)
    const prompt = withHeader(dispatchFields({ brief_id: 'b-new', run_id: 'r-new', idem: 'i-new' }))
    events.push(nativeCall(1000, 'call-new', prompt))
    const session = makeSession('dispatcher-1', events)
    expect(guard(dispatch(prompt, session, 'call-new'))).toBeUndefined()
  })

  it('原先 256 run：真正 MANDATE_LEDGER_FULL', () => {
    const { guard } = harness()
    const events = releasedRuns(256, 1)
    const prompt = withHeader(dispatchFields({ brief_id: 'b-new', run_id: 'r-new', idem: 'i-new' }))
    events.push(nativeCall(1000, 'call-new', prompt))
    const session = makeSession('dispatcher-1', events)
    const denial = guard(dispatch(prompt, session, 'call-new'))
    expect(denial).toContain('MANDATE_LEDGER_FULL')
  })

  it('原先 63 brief：第 64 个工作项放行', () => {
    const { guard } = harness()
    const events = releasedRuns(63, 63)
    const prompt = withHeader(dispatchFields({ brief_id: 'b-new', run_id: 'r-new', idem: 'i-new' }))
    events.push(nativeCall(1000, 'call-new', prompt))
    const session = makeSession('dispatcher-1', events)
    expect(guard(dispatch(prompt, session, 'call-new'))).toBeUndefined()
  })

  it('原先 64 brief：真正 MANDATE_LEDGER_FULL', () => {
    const { guard } = harness()
    const events = releasedRuns(64, 64)
    const prompt = withHeader(dispatchFields({ brief_id: 'b-new', run_id: 'r-new', idem: 'i-new' }))
    events.push(nativeCall(1000, 'call-new', prompt))
    const session = makeSession('dispatcher-1', events)
    const denial = guard(dispatch(prompt, session, 'call-new'))
    expect(denial).toContain('MANDATE_LEDGER_FULL')
  })
})

describe('调度账本守卫：预约兜底（老代没有 ptc-start）', () => {
  it('本次调用还没入账时，并行同命名空间的第二次被拒', () => {
    const { guard } = harness()
    // 日志里**没有**这次调用：模拟老代没有 ptc-dispatch-start 的窗口。
    const session = makeSession('dispatcher-1', [])
    const prompt = withHeader(dispatchFields())
    expect(guard(dispatch(prompt, session, 'call-a'))).toBeUndefined()
    const denial = guard(dispatch(prompt, session, 'call-b'))
    expect(denial).toContain('MANDATE_DUPLICATE')
  })

  it('预约 30 分钟后过期：只剩持久账本说话', () => {
    let clock = 1_000_000
    const guard = createDispatchLedgerGuard({ policyFor: () => POLICY, now: () => clock })
    const session = makeSession('dispatcher-1', [])
    const prompt = withHeader(dispatchFields())
    expect(guard(dispatch(prompt, session, 'call-a'))).toBeUndefined()
    expect(guard(dispatch(prompt, session, 'call-b'))).toContain('MANDATE_DUPLICATE')
    clock += 30 * 60 * 1000 + 1
    expect(guard(dispatch(prompt, session, 'call-b'))).toBeUndefined()
  })

  it('被拒的调用不占预约', () => {
    const guard = createDispatchLedgerGuard({ policyFor: () => POLICY })
    const session = makeSession('dispatcher-1', [])
    const stale = withHeader(dispatchFields({
      policy: { id: POLICY.id, version: POLICY.version, sha256: 'f'.repeat(64) },
    }))
    expect(guard(dispatch(stale, session, 'call-a'))).toContain('MANDATE_POLICY_STALE')
    // 先前那次被拒，没有留下预约：合法调用仍然放行。
    expect(guard(dispatch(withHeader(dispatchFields()), session, 'call-b'))).toBeUndefined()
  })
})

describe('调度账本守卫：prompt_ref 快照校验', () => {
  it('prompt_ref 与当前环境一致 → 放行', () => {
    const guard = createDispatchLedgerGuard({ policyFor: () => POLICY, promptRef: 'plan-v3' })
    const prompt = withHeader(dispatchFields())
    const session = makeSession('dispatcher-1', [nativeCall(1, 'call-a', prompt)])
    expect(guard(dispatch(prompt, session, 'call-a'))).toBeUndefined()
  })

  it('prompt_ref 不一致 → MANDATE_VERSION（带期望值）', () => {
    const guard = createDispatchLedgerGuard({ policyFor: () => POLICY, promptRef: 'plan-v3' })
    const prompt = withHeader(dispatchFields({ prompt_ref: 'plan-v9' }))
    const session = makeSession('dispatcher-1', [nativeCall(1, 'call-a', prompt)])
    const denial = guard(dispatch(prompt, session, 'call-a'))
    expect(denial).toContain('MANDATE_VERSION')
    expect(denial).toContain('plan-v3')
    expect(denial?.startsWith('DISPATCH_LEDGER_V2:MANDATE_VERSION:')).toBe(true)
  })

  it('未注入 prompt_ref 时降级：不校验这一条', () => {
    const guard = createDispatchLedgerGuard({ policyFor: () => POLICY })
    const prompt = withHeader(dispatchFields({ prompt_ref: 'plan-v9' }))
    const session = makeSession('dispatcher-1', [nativeCall(1, 'call-a', prompt)])
    expect(guard(dispatch(prompt, session, 'call-a'))).toBeUndefined()
  })
})
