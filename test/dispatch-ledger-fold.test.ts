import { describe, expect, it } from 'vitest'
import {
  MANDATE_FENCE_CLOSE,
  MANDATE_FENCE_OPEN,
} from '../src/host/dispatch-ledger/header.ts'
import { sha256Hex } from '../src/host/dispatch-ledger/policy.ts'
import {
  DISPATCH_LEDGER_STATE_VERSION,
  MAX_ATTEMPTS_SHOWN,
  MAX_BRIEFS_PER_SESSION,
  MAX_RUNS_PER_SESSION,
  briefIsBusy,
  bindChildMandates,
  dispatchLedgerCapacity,
  SUBAGENT_SELECTION_DENIAL_CODE,
  detectGuardDenialCode,
  foldDispatchLedger,
  foldDispatchLedgerEvents,
  initialDispatchLedgerState,
  isNamespaceClaimedByAnother,
  latestRunNsOfBrief,
  type DispatchLedgerEventLike,
  type DispatchLedgerState,
} from '../src/host/dispatch-ledger/ledger.ts'

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
    policy: { id: 'dsh-dispatch-ledger', version: '1', sha256: '3f9a1c2b3c4d5e6f' },
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
    policy: { id: 'dsh-dispatch-ledger', version: '1', sha256: '3f9a1c2b3c4d5e6f' },
    status: 'ready',
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

/** 一次 PTC 子派发开始。 */
function ptcStart(
  seq: number,
  subCallId: string,
  prompt: string,
  name = 'subagent',
): DispatchLedgerEventLike {
  return {
    type: 'tool/ptc-dispatch-start',
    seq,
    time: 1000 + seq,
    data: {
      rootCallId: 'root',
      parentCallId: 'root',
      subCallId,
      name,
      arguments: { description: 'd', prompt },
    },
  }
}

/** 一次 PTC 子派发结算。 */
function ptcSettle(
  seq: number,
  subCallId: string,
  prompt: string,
  isError: boolean,
  text: string,
  name = 'subagent',
): DispatchLedgerEventLike {
  return {
    type: 'tool/ptc-dispatch',
    seq,
    time: 1000 + seq,
    data: {
      rootCallId: 'root',
      parentCallId: 'root',
      subCallId,
      name,
      arguments: { description: 'd', prompt },
      isError,
      content: [{ type: 'text', text }],
    },
  }
}

/** 一次收件箱投递（报告落在第二个 text block）。 */
function inboxSplice(seq: number, messageText: string): DispatchLedgerEventLike {
  return {
    type: 'agent/inbox/spliced',
    seq,
    time: 1000 + seq,
    data: {
      target: 'next-turn',
      start: 0,
      inserted: [{
        id: 'msg-' + seq,
        role: 'user',
        source: { kind: 'agent-message', form: 'relay', senderSessionId: 'child-1' },
        content: [
          { type: 'text', text: 'Agent child-1 sent a message: ' },
          { type: 'text', text: messageText },
        ],
      }],
    },
  }
}

/** 守卫拒绝文案。 */
function denial(code: string): string {
  return 'Error: DISPATCH_LEDGER_V2:' + code + ': because'
}

/** 折一串事件。 */
function fold(events: DispatchLedgerEventLike[]): DispatchLedgerState {
  return foldDispatchLedgerEvents(events)
}

describe('账本折叠：Native 路径', () => {
  it('一次带头的派发建一条运行，结局成功后聚合为 succeeded', () => {
    const state = fold([
      nativeCall(1, 'call-a', withHeader(dispatchFields())),
      nativeResult(2, 'call-a', false, 'started subagent child-1'),
    ])
    const run = state.runs[nsOf('b-7f', 'r-1', 'i-1')]
    expect(run).toBeDefined()
    expect(run?.state).toBe('booked')
    expect(run?.attemptTotals).toEqual({ total: 1, succeeded: 1, unknown: 0, toolError: 0, guardDenied: 0 })
    expect(run?.attempts).toHaveLength(1)
    expect(run?.attempts[0]?.outcome).toBe('succeeded')
    expect(run?.createdByCallId).toBe('call-a')
    expect(run?.tool).toBe('subagent')
    expect(run?.task).toEqual(['task://req-42'])
    expect(run?.boundary).toEqual(['src/host/dispatch-ledger/**'])
    // 正文哈希由插件自己算：模型给不了也伪造不了
    expect(run?.body_sha256).toBe(sha256Hex('do the work'))
  })

  it('模型在头部里塞正文哈希 → 头部损坏', () => {
    const state = fold([
      nativeCall(1, 'call-a', withHeader(dispatchFields({ body_sha256: 'a'.repeat(64) }))),
    ])
    expect(Object.keys(state.runs)).toHaveLength(0)
    expect(state.counters.malformed).toBe(1)
  })

  it('没有头部的派发只计数，不建运行', () => {
    const state = fold([nativeCall(1, 'call-a', 'plain task')])
    expect(Object.keys(state.runs)).toHaveLength(0)
    expect(state.counters.unmandated).toBe(1)
  })

  it('头部损坏只计数，不建运行', () => {
    const state = fold([nativeCall(1, 'call-a', MANDATE_FENCE_OPEN + '\n{bad}\n' + MANDATE_FENCE_CLOSE)])
    expect(Object.keys(state.runs)).toHaveLength(0)
    expect(state.counters.malformed).toBe(1)
  })

  it('派发工具上出现报告头 → malformed', () => {
    const state = fold([nativeCall(1, 'call-a', withHeader(reportFields()))])
    expect(Object.keys(state.runs)).toHaveLength(0)
    expect(state.counters.malformed).toBe(1)
  })

  it('非派发工具被忽略', () => {
    const state = fold([nativeCall(1, 'call-a', withHeader(dispatchFields()), 'bash')])
    expect(Object.keys(state.runs)).toHaveLength(0)
  })

  it('结果丢失 → unknown → 运行仍未结算', () => {
    const state = fold([nativeCall(1, 'call-a', withHeader(dispatchFields()))])
    const run = state.runs[nsOf('b-7f', 'r-1', 'i-1')]
    expect(run?.state).toBe('booked')
    expect(run?.attemptTotals.unknown).toBe(1)
    expect(state.pending['call-a']).toBe(nsOf('b-7f', 'r-1', 'i-1'))
  })

  it('一般工具失败 → released（派发本身失败）', () => {
    const state = fold([
      nativeCall(1, 'call-a', withHeader(dispatchFields())),
      nativeResult(2, 'call-a', true, 'Error: boom'),
    ])
    const run = state.runs[nsOf('b-7f', 'r-1', 'i-1')]
    expect(run?.state).toBe('released')
    expect(run?.release).toBe('dispatch_failed')
    expect(run?.attemptTotals.toolError).toBe(1)
  })
})

describe('账本折叠：PTC 路径', () => {
  it('start + settle 折成一次尝试', () => {
    const state = fold([
      ptcStart(1, 'call-1:ptc:1', withHeader(dispatchFields())),
      ptcSettle(2, 'call-1:ptc:1', withHeader(dispatchFields()), false, 'started'),
    ])
    const run = state.runs[nsOf('b-7f', 'r-1', 'i-1')]
    expect(run?.attemptTotals).toEqual({ total: 1, succeeded: 1, unknown: 0, toolError: 0, guardDenied: 0 })
    expect(run?.createdByCallId).toBe('call-1:ptc:1')
  })

  it('老代没有 start 时，一条 settle 同时是尝试与结局', () => {
    const state = fold([
      ptcSettle(1, 'call-1:ptc:1', withHeader(dispatchFields()), false, 'started'),
    ])
    const run = state.runs[nsOf('b-7f', 'r-1', 'i-1')]
    expect(run?.attemptTotals).toEqual({ total: 1, succeeded: 1, unknown: 0, toolError: 0, guardDenied: 0 })
    expect(run?.attemptTotals.unknown).toBe(0)
    expect(state.pending).toEqual({})
  })

  it('PTC 的守卫拒绝被识别成 guard_denied', () => {
    const state = fold([
      ptcStart(1, 'call-1:ptc:1', withHeader(dispatchFields())),
      ptcSettle(2, 'call-1:ptc:1', withHeader(dispatchFields()), true, denial('MANDATE_DUPLICATE')),
    ])
    const run = state.runs[nsOf('b-7f', 'r-1', 'i-1')]
    expect(run?.attemptTotals.guardDenied).toBe(1)
    expect(run?.attempts[0]?.denialCode).toBe('MANDATE_DUPLICATE')
    // 唯一一次尝试被守卫拒 → 从未派发出去 → denied
    expect(run?.state).toBe('denied')
  })
})

describe('并发拒绝不释放原来的运行', () => {
  it('第二次同命名空间被守卫拒 → 第一次仍然 booked', () => {
    const prompt = withHeader(dispatchFields())
    const state = fold([
      nativeCall(1, 'call-a', prompt),
      nativeCall(2, 'call-b', prompt),
      nativeResult(3, 'call-b', true, denial('MANDATE_DUPLICATE')),
    ])
    const run = state.runs[nsOf('b-7f', 'r-1', 'i-1')]
    expect(Object.keys(state.runs)).toHaveLength(1)
    expect(run?.state).toBe('booked')
    expect(run?.release).toBeUndefined()
    expect(run?.attemptTotals).toEqual({
      total: 2,
      succeeded: 0,
      unknown: 1,
      toolError: 0,
      guardDenied: 1,
    })
    expect(state.counters.duplicates).toBe(1)
  })

  it('第二次是一般失败也不释放第一次', () => {
    const prompt = withHeader(dispatchFields())
    const state = fold([
      nativeCall(1, 'call-a', prompt),
      nativeCall(2, 'call-b', prompt),
      nativeResult(3, 'call-b', true, 'Error: boom'),
    ])
    const run = state.runs[nsOf('b-7f', 'r-1', 'i-1')]
    expect(run?.state).toBe('booked')
    expect(run?.release).toBeUndefined()
    expect(run?.attemptTotals.unknown).toBe(1)
    expect(run?.attemptTotals.toolError).toBe(1)
  })

  it('全部尝试都被守卫拒 → denied（从未派发出去）', () => {
    const prompt = withHeader(dispatchFields())
    const state = fold([
      nativeCall(1, 'call-a', prompt),
      nativeResult(2, 'call-a', true, denial('MANDATE_DUPLICATE')),
    ])
    const run = state.runs[nsOf('b-7f', 'r-1', 'i-1')]
    expect(run?.state).toBe('denied')
    expect(run?.attemptTotals.guardDenied).toBe(1)
    // 被守卫拒掉的尝试只能审计：命名空间照样永久占着
    expect(isNamespaceClaimedByAnother(state, nsOf('b-7f', 'r-1', 'i-1'), 'someone-else')).toBe(true)
  })

  it('重复判定排除自己：第一次调用不被算成重复', () => {
    const prompt = withHeader(dispatchFields())
    const state = fold([nativeCall(1, 'call-a', prompt)])
    const ns = nsOf('b-7f', 'r-1', 'i-1')
    expect(isNamespaceClaimedByAnother(state, ns, 'call-a')).toBe(false)
    expect(isNamespaceClaimedByAnother(state, ns, 'call-b')).toBe(true)
  })
})

describe('命名空间永久占用', () => {
  it('released 之后同命名空间不会新建运行', () => {
    const prompt = withHeader(dispatchFields())
    const state = fold([
      nativeCall(1, 'call-a', prompt),
      nativeResult(2, 'call-a', true, 'Error: boom'),
      nativeCall(3, 'call-b', prompt),
    ])
    expect(Object.keys(state.runs)).toHaveLength(1)
    const run = state.runs[nsOf('b-7f', 'r-1', 'i-1')]
    expect(run?.createdByCallId).toBe('call-a')
    expect(run?.attemptTotals.total).toBe(2)
    expect(state.counters.duplicates).toBe(1)
  })

  it('同工作项可以开新的一次运行，并记下血缘', () => {
    const first = withHeader(dispatchFields())
    const second = withHeader(dispatchFields({
      run_id: 'r-2',
      idem: 'i-2',
      parent_mandate: { brief_id: 'b-7f', run_id: 'r-1', idem: 'i-1' },
    }))
    const state = fold([
      nativeCall(1, 'call-a', first),
      nativeResult(2, 'call-a', true, 'Error: boom'),
      nativeCall(3, 'call-b', second),
    ])
    expect(Object.keys(state.runs)).toHaveLength(2)
    const second_ = state.runs[nsOf('b-7f', 'r-2', 'i-2')]
    expect(second_?.parent_run).toBe(nsOf('b-7f', 'r-1', 'i-1'))
    expect(latestRunNsOfBrief(state, 'b-7f')).toBe(nsOf('b-7f', 'r-2', 'i-2'))
  })

  it('工作项在有未了结的运行时算被占用', () => {
    const state = fold([nativeCall(1, 'call-a', withHeader(dispatchFields()))])
    expect(briefIsBusy(state, 'b-7f')).toBe(true)
    expect(briefIsBusy(state, 'b-other')).toBe(false)
  })
})

describe('报告状态转移', () => {
  it('ready → completed', () => {
    const state = fold([
      nativeCall(1, 'call-a', withHeader(dispatchFields())),
      nativeResult(2, 'call-a', false, 'started'),
      inboxSplice(3, withHeader(reportFields({ status: 'ready' })) + '\nall done'),
    ])
    const run = state.runs[nsOf('b-7f', 'r-1', 'i-1')]
    expect(run?.state).toBe('completed')
    expect(run?.report?.status).toBe('ready')
  })

  it('hand_back → released，且留下历史', () => {
    const state = fold([
      nativeCall(1, 'call-a', withHeader(dispatchFields())),
      nativeResult(2, 'call-a', false, 'started'),
      inboxSplice(3, withHeader(reportFields({ status: 'hand_back' })) + '\nneed a decision'),
    ])
    const run = state.runs[nsOf('b-7f', 'r-1', 'i-1')]
    expect(run?.state).toBe('released')
    expect(run?.release).toBe('hand_back')
    expect(run?.releasedHistory).toHaveLength(1)
  })

  it('blocked → blocked', () => {
    const state = fold([
      nativeCall(1, 'call-a', withHeader(dispatchFields())),
      inboxSplice(2, withHeader(reportFields({ status: 'blocked' }))),
    ])
    expect(state.runs[nsOf('b-7f', 'r-1', 'i-1')]?.state).toBe('blocked')
  })

  it('找不到对应运行的报告 → orphanReports', () => {
    const state = fold([inboxSplice(1, withHeader(reportFields()))])
    expect(state.counters.orphanReports).toBe(1)
    expect(Object.keys(state.runs)).toHaveLength(0)
  })

  it('版本或提示词引用不匹配 → 不转移，只计数', () => {
    const state = fold([
      nativeCall(1, 'call-a', withHeader(dispatchFields())),
      inboxSplice(2, withHeader(reportFields({ prompt_ref: 'plan-v9' }))),
    ])
    expect(state.runs[nsOf('b-7f', 'r-1', 'i-1')]?.state).toBe('booked')
    expect(state.counters.malformed).toBe(1)
  })
})

describe('重启、压缩与重放', () => {
  it('同一串事件折两次得到同一份状态', () => {
    const events = [
      nativeCall(1, 'call-a', withHeader(dispatchFields())),
      nativeResult(2, 'call-a', false, 'started'),
      inboxSplice(3, withHeader(reportFields({ status: 'ready' }))),
    ]
    expect(JSON.stringify(fold(events))).toBe(JSON.stringify(fold(events)))
  })

  it('压缩事件不影响折叠（日志是 append-only，结局仍在）', () => {
    const events = [
      nativeCall(1, 'call-a', withHeader(dispatchFields())),
      { type: 'compaction/summary', seq: 2, time: 1002, data: { summary: 'x' } },
      nativeResult(3, 'call-a', false, 'started'),
    ]
    const state = fold(events)
    expect(state.runs[nsOf('b-7f', 'r-1', 'i-1')]?.attemptTotals.succeeded).toBe(1)
  })

  it('与本事件无关时返回同一个引用', () => {
    const state = initialDispatchLedgerState()
    const next = foldDispatchLedger(state, { type: 'session/title', seq: 1, time: 1, data: {} })
    expect(next).toBe(state)
  })

  it('状态版本是声明值', () => {
    expect(initialDispatchLedgerState().ledger).toBe(DISPATCH_LEDGER_STATE_VERSION)
  })
})

describe('容量与截断', () => {
  it('attempt 展示被截断，但聚合计数不受影响', () => {
    const prompt = withHeader(dispatchFields())
    const events: DispatchLedgerEventLike[] = []
    for (let index = 0; index < 10; index += 1) {
      events.push(nativeCall(index + 1, 'call-' + index, prompt))
    }
    const run = fold(events).runs[nsOf('b-7f', 'r-1', 'i-1')]
    expect(run?.attempts).toHaveLength(MAX_ATTEMPTS_SHOWN)
    expect(run?.attemptTotals.total).toBe(10)
    expect(run?.attemptTotals.unknown).toBe(10)
    expect(run?.state).toBe('booked')
  })

  it('超过上限时一条都不淘汰：全部幂等事实被忠实保留', () => {
    const events: DispatchLedgerEventLike[] = []
    for (let index = 0; index < MAX_RUNS_PER_SESSION + 20; index += 1) {
      const prompt = withHeader(dispatchFields({
        brief_id: 'b-' + index,
        run_id: 'r-1',
        idem: 'i-1',
      }))
      events.push(nativeCall(index * 2 + 1, 'call-' + index, prompt))
      events.push(nativeResult(index * 2 + 2, 'call-' + index, true, 'Error: boom'))
    }
    const state = fold(events)
    expect(Object.keys(state.runs)).toHaveLength(MAX_RUNS_PER_SESSION + 20)
    // 最老的那条命名空间仍然占着
    const oldest = nsOf('b-0', 'r-1', 'i-1')
    expect(state.runs[oldest]).toBeDefined()
    expect(isNamespaceClaimedByAnother(state, oldest, 'someone-else')).toBe(true)
  })

  it('容量满了也不许靠旧命名空间绕过防重', () => {
    const events: DispatchLedgerEventLike[] = []
    for (let index = 0; index < MAX_RUNS_PER_SESSION + 5; index += 1) {
      const prompt = withHeader(dispatchFields({
        brief_id: 'b-' + index,
        run_id: 'r-1',
        idem: 'i-1',
      }))
      events.push(nativeCall(index * 2 + 1, 'call-' + index, prompt))
      events.push(nativeResult(index * 2 + 2, 'call-' + index, true, 'Error: boom'))
    }
    const oldest = withHeader(dispatchFields({ brief_id: 'b-0', run_id: 'r-1', idem: 'i-1' }))
    events.push(nativeCall(10000, 'call-retry', oldest))
    const state = fold(events)
    expect(state.counters.duplicates).toBe(1)
    expect(state.runs[nsOf('b-0', 'r-1', 'i-1')]?.createdByCallId).toBe('call-0')
    expect(Object.keys(state.runs)).toHaveLength(MAX_RUNS_PER_SESSION + 5)
  })

  it('容量查询是纯的：满了以后由守卫决定拒不拒', () => {
    const events: DispatchLedgerEventLike[] = []
    for (let index = 0; index < MAX_BRIEFS_PER_SESSION + 1; index += 1) {
      const prompt = withHeader(dispatchFields({
        brief_id: 'b-' + index,
        run_id: 'r-1',
        idem: 'i-1',
      }))
      events.push(nativeCall(index * 2 + 1, 'call-' + index, prompt))
      events.push(nativeResult(index * 2 + 2, 'call-' + index, true, 'Error: boom'))
    }
    const state = fold(events)
    const capacity = dispatchLedgerCapacity(state)
    expect(capacity.briefs).toBe(MAX_BRIEFS_PER_SESSION + 1)
    expect(capacity.briefsFull).toBe(true)
    expect(capacity.runsFull).toBe(false)
    expect(capacity.full).toBe(true)
    // 已存在的工作项再开一次运行不占新的工作项名额
    expect(dispatchLedgerCapacity(state, 'b-0').full).toBe(false)
    expect(dispatchLedgerCapacity(state, 'b-0').brief?.runs).toBe(1)
    // 一个全新工作项会被容量挡住
    expect(dispatchLedgerCapacity(state, 'b-brand-new').full).toBe(true)
  })

  it('容量满了也不丢血缘、子代理绑定与未结算表', () => {
    const first = withHeader(dispatchFields())
    const second = withHeader(dispatchFields({
      run_id: 'r-2',
      idem: 'i-2',
      parent_mandate: { brief_id: 'b-7f', run_id: 'r-1', idem: 'i-1' },
    }))
    const events: DispatchLedgerEventLike[] = [
      nativeCall(1, 'call-a', first),
      nativeCall(2, 'call-b', second),
    ]
    for (let index = 0; index < MAX_RUNS_PER_SESSION + 5; index += 1) {
      const prompt = withHeader(dispatchFields({
        brief_id: 'filler-' + index,
        run_id: 'r-1',
        idem: 'i-1',
      }))
      events.push(nativeCall(index * 2 + 3, 'filler-' + index, prompt))
      events.push(nativeResult(index * 2 + 4, 'filler-' + index, true, 'Error: boom'))
    }
    const state = fold(events)
    expect(state.runs[nsOf('b-7f', 'r-2', 'i-2')]?.parent_run).toBe(nsOf('b-7f', 'r-1', 'i-1'))
    expect(state.pending['call-a']).toBe(nsOf('b-7f', 'r-1', 'i-1'))
    expect(state.pending['call-b']).toBe(nsOf('b-7f', 'r-2', 'i-2'))
  })
})

describe('守卫可用的纯接口', () => {
  it('读得出守卫拒绝码', () => {
    expect(detectGuardDenialCode([{ type: 'text', text: denial('MANDATE_DUPLICATE') }])).toBe('MANDATE_DUPLICATE')
    expect(detectGuardDenialCode([{ type: 'text', text: 'Error: boom' }])).toBeUndefined()
    expect(detectGuardDenialCode([])).toBeUndefined()
  })

  it('子代理与它持有的 Mandate 绑定', () => {
    const prompt = withHeader(dispatchFields())
    const state = fold([nativeCall(1, 'call-a', prompt)])
    const parent = {
      id: 'parent-1',
      events: [{
        type: 'subagent/catalog',
        seq: 1,
        time: 1,
        data: { version: 0, childId: 'child-1', childCreatedAt: 1, mode: 'continuable', label: 'work' },
      }],
    }
    const child = {
      id: 'child-1',
      header: { parentSession: 'parent-1' },
      events: [{
        type: 'user/message',
        seq: 1,
        time: 1,
        data: {
          content: [
            { type: 'text', text: prompt },
            { type: 'text', text: 'Your parent agent id is "parent-1".' },
          ],
        },
      }],
    }
    const bound = bindChildMandates(state, parent, () => child)
    expect(bound.children['child-1']?.ns).toBe(nsOf('b-7f', 'r-1', 'i-1'))
    expect(bound.children['child-1']?.prompt_ref).toBe('plan-v3')
    expect(bindChildMandates(state, parent, () => undefined)).toBe(state)
  })

  it('one-shot 子代理没有 catalog 条目时走候选列表', () => {
    const prompt = withHeader(dispatchFields())
    const state = fold([nativeCall(1, 'call-a', prompt)])
    const parent = { id: 'parent-1', events: [] }
    const oneShot = {
      id: 'child-9',
      header: { parentSession: 'parent-1' },
      events: [{
        type: 'user/message',
        seq: 1,
        time: 1,
        data: { content: [{ type: 'text', text: prompt }] },
      }],
    }
    const bound = bindChildMandates(state, parent, () => undefined, [oneShot])
    expect(bound.children['child-9']?.ns).toBe(nsOf('b-7f', 'r-1', 'i-1'))
    expect(bound.children['child-9']?.idem).toBe('i-1')
  })

  it('候选里不是自己孩子的会话不会被绑定', () => {
    const prompt = withHeader(dispatchFields())
    const state = fold([nativeCall(1, 'call-a', prompt)])
    const parent = { id: 'parent-1', events: [] }
    const stranger = {
      id: 'child-8',
      header: { parentSession: 'parent-other' },
      events: [{
        type: 'user/message',
        seq: 1,
        time: 1,
        data: { content: [{ type: 'text', text: prompt }] },
      }],
    }
    expect(bindChildMandates(state, parent, () => undefined, [stranger])).toBe(state)
  })
})

describe('调度账本：派发前被模型选择守卫拒绝的尝试', () => {
  const selectionDenial = 'Error: subagent model selection: "subagent_fork" always runs on the calling agent\'s own route and accepts no provider/model.'

  it('认成 guard_denied：运行落到 denied，而不是自称派发失败', () => {
    const prompt = withHeader(dispatchFields())
    const state = fold([
      nativeCall(1, 'call-fork', prompt, 'subagent_fork'),
      nativeResult(2, 'call-fork', true, selectionDenial),
    ])
    const run = state.runs[nsOf('b-7f', 'r-1', 'i-1')]
    expect(run?.state).toBe('denied')
    expect(run?.attemptTotals.guardDenied).toBe(1)
    expect(run?.attempts[0]?.denialCode).toBe(SUBAGENT_SELECTION_DENIAL_CODE)
  })

  it('同一命名空间的修正后尝试把 denied 带回 booked，正文与工具名以新尝试为准', () => {
    const prompt = withHeader(dispatchFields())
    const corrected = withHeader(dispatchFields(), 'do the corrected work')
    const state = fold([
      nativeCall(1, 'call-fork', prompt, 'subagent_fork'),
      nativeResult(2, 'call-fork', true, selectionDenial),
      nativeCall(3, 'call-sub', corrected),
      nativeResult(4, 'call-sub', false, 'done'),
    ])
    const run = state.runs[nsOf('b-7f', 'r-1', 'i-1')]
    expect(run?.state).toBe('booked')
    expect(run?.tool).toBe('subagent')
    expect(run?.body_sha256).toBe(sha256Hex('do the corrected work'))
  })

  it('只认这族文案：普通工具失败仍记 tool_error', () => {
    expect(detectGuardDenialCode([{ type: 'text', text: selectionDenial }]))
      .toBe(SUBAGENT_SELECTION_DENIAL_CODE)
    expect(detectGuardDenialCode([{ type: 'text', text: 'Error: boom' }])).toBeUndefined()
  })
})
