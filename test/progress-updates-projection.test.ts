import { describe, expect, it } from 'vitest'
import {
  PROGRESS_UPDATES_PROJECTION_KEY,
  PROGRESS_UPDATES_STATE_VERSION,
  mergeProjectedUpdates,
  progressUpdatesProjection,
  progressUpdatesStateSchema,
  readProjectedUpdates,
  type ProgressUpdatesProjectionState,
} from '../src/host/progress-updates/projection.ts'
import { MAX_UPDATES, type ProgressUpdate } from '../src/host/progress-updates/store.ts'
import { NOTIFY_USER_TOOL } from '../src/host/progress-updates/tool.ts'

/**
 * 会话投影单元：把日志里的 `progress_update` 调用折叠成进展。
 *
 * 这是**持久化**的落点 —— 面板重开对话、刷新页面、宿主重启之后还能看到历史，
 * 全靠这里折得对。所以这份测试钉两类东西：
 *
 * 1. 折叠出来的东西对（字段、顺序、id 稳定、环形缓冲截断）；
 * 2. 折叠**绝不抛错**，且对无关事件返回**同一个引用** —— `apply` 跑在日志重放
 *    路径上，抛一次就毁掉整条折叠链，而引用变了会让下游白白算一遍。
 */

/** 造一条会话事件（形状取自 `SessionEventMap` 的 `tool/call`）。 */
function toolCall(seq: number, name: string, args: unknown, time = 1_000 + seq) {
  return {
    type: 'tool/call',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      callId: 'call-' + seq,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  }
}

/** 造一条 `progress_update` 的 tool/call。 */
function progressCall(seq: number, payload: unknown, time?: number) {
  return toolCall(seq, NOTIFY_USER_TOOL, payload, time)
}

/** 从空日志起折一段事件。 */
function fold(
  events: readonly unknown[],
  header: { id?: string } = { id: 'root' },
): ProgressUpdatesProjectionState {
  const unit = progressUpdatesProjection()
  let state = unit.init(header, 0)
  for (const event of events) state = unit.apply(state, event as never)
  return state
}

describe('投影单元：折叠 tool/call 事件', () => {
  it('一条 progress_update 折出一条进展，字段来自事件本身', () => {
    const state = fold([progressCall(7, { title: '  定位到根因  ', message: '正文一' }, 1_700_000_000_000)])
    expect(state.updates).toHaveLength(1)
    const update = state.updates[0]!
    expect(update.title).toBe('定位到根因')
    expect(update.message).toBe('正文一')
    expect(update.at).toBe(1_700_000_000_000)
    // id 来自 seq，不是时间戳：重放必须得到完全相同的 id。
    expect(update.id).toBe('pu-7-root')
    // source 是会话头里的 id：合并整棵委派树时靠它区分各会话的进展。
    expect(update.source).toBe('root')
  })

  it('没有标题（或标题全是空白）时进展不带 title 字段', () => {
    const state = fold([progressCall(1, { message: '只有正文' }), progressCall(2, { title: '   ', message: '空白标题' })])
    expect(state.updates).toHaveLength(2)
    expect('title' in state.updates[0]!).toBe(false)
    expect('title' in state.updates[1]!).toBe(false)
  })

  it('多条进展按事件顺序累积', () => {
    const state = fold([
      progressCall(1, { message: '第一条' }, 10),
      toolCall(2, 'read', { file_path: 'x' }),
      progressCall(3, { message: '第二条' }, 30),
    ])
    expect(state.updates.map(update => update.message)).toEqual(['第一条', '第二条'])
  })

  it('PTC 形态：run_code 里发出的 progress_update（tool/ptc-dispatch）也折得出来', () => {
    // 线上默认是 PTC 模式：模型只看得见 run_code，progress_update 作为程序里的
    // 子调用发出，日志里落的是 tool/ptc-dispatch（参数**已解析成对象**）。
    // 只认 tool/call 的话，最常见的那条路径会一条都折不出来。
    const unit = progressUpdatesProjection()
    const event = {
      type: 'tool/ptc-dispatch',
      seq: 42,
      time: 1_700_000_000_000,
      data: {
        rootCallId: 'root',
        parentCallId: 'root',
        subCallId: 'root:ptc:1',
        name: NOTIFY_USER_TOOL,
        arguments: { title: '  阶段结论  ', message: '正文' },
        isError: false,
        content: [],
      },
    }
    const state = unit.apply(unit.init({ id: 'root' }, 0), event as never)
    expect(state.updates).toHaveLength(1)
    expect(state.updates[0]).toMatchObject({
      id: 'pu-42-root',
      title: '阶段结论',
      message: '正文',
      at: 1_700_000_000_000,
      source: 'root',
    })
  })

  it('PTC 形态：arguments 不是对象 / message 不是字符串时返回同一引用且不抛错', () => {
    const unit = progressUpdatesProjection()
    const base = unit.init({ id: 'root' }, 0)
    const bad = [
      { type: 'tool/ptc-dispatch', seq: 1, time: 1, data: { name: NOTIFY_USER_TOOL, arguments: '{"message":"x"}' } },
      { type: 'tool/ptc-dispatch', seq: 2, time: 1, data: { name: NOTIFY_USER_TOOL, arguments: null } },
      { type: 'tool/ptc-dispatch', seq: 3, time: 1, data: { name: NOTIFY_USER_TOOL, arguments: { message: 42 } } },
      { type: 'tool/ptc-dispatch', seq: 4, time: 1, data: { name: NOTIFY_USER_TOOL, arguments: [{ message: 'x' }] } },
      { type: 'tool/ptc-dispatch', seq: 5, time: 1, data: { name: 'run_code', arguments: { message: 'x' } } },
    ]
    for (const event of bad) {
      expect(() => unit.apply(base, event as never)).not.toThrow()
      expect(unit.apply(base, event as never)).toBe(base)
    }
  })

  it('投影键与状态版本是冻结契约（缓存按这两个值寻址）', () => {
    const unit = progressUpdatesProjection()
    expect(unit.key).toBe(PROGRESS_UPDATES_PROJECTION_KEY)
    expect(unit.key).toBe('progressUpdates')
    expect(unit.stateVersion).toBe(PROGRESS_UPDATES_STATE_VERSION)
    // 2：多认了 PTC 的 tool/ptc-dispatch 形状。这个数字只在折叠语义真的变了时
    // 才该动 —— 它同时是缓存里那一行的失效开关（版本不符会被丢弃重折）。
    expect(unit.stateVersion).toBe(2)
  })

  it('init 从会话头取 source；没有会话头时也能折（只是没有 source）', () => {
    const unit = progressUpdatesProjection()
    expect(unit.init({ id: 'child' }, 0).source).toBe('child')
    expect(unit.init({}, 0).source).toBeUndefined()
    expect(unit.init({}, 0).updates).toEqual([])
  })

  it('wire 交出的是现有的 ProgressUpdate[] 形状（客户端渲染组件不改）', () => {
    const unit = progressUpdatesProjection()
    const state = fold([progressCall(1, { title: 't', message: 'm' })])
    expect(unit.wire.view(state)).toBe(state.updates)
    expect(unit.wire.viewSchema.parse(state.updates)).toEqual(state.updates)
  })
})

describe('投影单元：无关事件返回同一个引用', () => {
  it('非 tool/call 的事件原样返回', () => {
    const unit = progressUpdatesProjection()
    const state = unit.init({ id: 'root' }, 0)
    const events = [
      { type: 'user/message', seq: 1, time: 1, data: { text: 'hi' } },
      { type: 'tool/result', seq: 2, time: 2, data: { message: {} } },
      { type: 'turn/end', seq: 3, time: 3, data: {} },
      undefined,
      null,
      {},
    ]
    for (const event of events) expect(Object.is(unit.apply(state, event as never), state)).toBe(true)
  })

  it('别的工具的 tool/call 原样返回（同一个 name 才算进展）', () => {
    const unit = progressUpdatesProjection()
    const state = unit.init({ id: 'root' }, 0)
    const other = toolCall(1, 'read', { file_path: 'x' })
    expect(Object.is(unit.apply(state, other as never), state)).toBe(true)
    // 大小写不同、前缀相同的名字都不算。
    expect(Object.is(unit.apply(state, toolCall(2, 'progress_update_v2', { message: 'm' }) as never), state)).toBe(true)
  })

  it('arguments 是坏 JSON、或不是对象、或 message 缺失时都不抛错且返回同一引用', () => {
    const unit = progressUpdatesProjection()
    const state = unit.init({ id: 'root' }, 0)
    const broken = [
      toolCall(1, NOTIFY_USER_TOOL, '{ not json'),
      toolCall(2, NOTIFY_USER_TOOL, '"just a string"'),
      toolCall(3, NOTIFY_USER_TOOL, '[1,2,3]'),
      toolCall(4, NOTIFY_USER_TOOL, 'null'),
      toolCall(5, NOTIFY_USER_TOOL, { title: '没有正文' }),
      toolCall(6, NOTIFY_USER_TOOL, { message: 42 }),
      // data 本身不是对象
      { type: 'tool/call', seq: 7, time: 7, data: null },
      { type: 'tool/call', seq: 8, time: 8 },
    ]
    for (const event of broken) {
      expect(() => unit.apply(state, event as never)).not.toThrow()
      expect(Object.is(unit.apply(state, event as never), state)).toBe(true)
    }
  })

  it('缺 seq 或 time 的事件不折：没有稳定 id、也排不进委派树', () => {
    const unit = progressUpdatesProjection()
    const state = unit.init({ id: 'root' }, 0)
    const noSeq = { type: 'tool/call', time: 5, data: { name: NOTIFY_USER_TOOL, arguments: '{"message":"m"}' } }
    const noTime = { type: 'tool/call', seq: 5, data: { name: NOTIFY_USER_TOOL, arguments: '{"message":"m"}' } }
    expect(Object.is(unit.apply(state, noSeq as never), state)).toBe(true)
    expect(Object.is(unit.apply(state, noTime as never), state)).toBe(true)
  })
})

describe('投影单元：环形缓冲与 id 稳定性', () => {
  it('超过 MAX_UPDATES 时截断，保留最新的那一批', () => {
    const events = Array.from({ length: MAX_UPDATES + 7 }, (_, index) =>
      progressCall(index + 1, { message: '第 ' + (index + 1) + ' 条' }))
    const state = fold(events)
    expect(state.updates).toHaveLength(MAX_UPDATES)
    // 最新一条留下，最早的那 7 条被丢掉。
    expect(state.updates[MAX_UPDATES - 1]!.message).toBe('第 ' + (MAX_UPDATES + 7) + ' 条')
    expect(state.updates[0]!.message).toBe('第 8 条')
    expect(state.updates.map(update => update.id)).not.toContain('pu-1-root')
  })

  it('同一段事件重放两次得到完全相同的 updates（id 用 seq，不用时钟）', () => {
    const events = [
      progressCall(3, { title: 'A', message: 'a' }, 111),
      progressCall(9, { message: 'b' }, 222),
      progressCall(12, { title: 'C', message: 'c' }, 333),
    ]
    expect(fold(events)).toEqual(fold(events))
    expect(fold(events).updates.map(update => update.id)).toEqual(['pu-3-root', 'pu-9-root', 'pu-12-root'])
  })

  it('不同会话里同一个 seq 折出来的 id 不同（合并委派树时不会撞 key）', () => {
    const event = progressCall(3, { message: 'm' })
    expect(fold([event], { id: 'root' }).updates[0]!.id).toBe('pu-3-root')
    expect(fold([event], { id: 'child' }).updates[0]!.id).toBe('pu-3-child')
  })
})

describe('投影读取与合并', () => {
  it('stateOf 优先；值过一遍 schema，形状不对就当投影不可用', () => {
    const state = fold([progressCall(1, { message: 'm' })])
    const service = { stateOf: () => state }
    expect(readProjectedUpdates(service, {})).toEqual(state.updates)

    const bad = { stateOf: () => ({ updates: [{ id: 1 }] }) }
    expect(readProjectedUpdates(bad, {})).toBeUndefined()
  })

  it('没有 stateOf 时退回 snapshot 的 wire 切面', () => {
    const state = fold([progressCall(1, { message: 'm' })])
    const service = { snapshot: (_session: unknown, keys?: readonly string[]) => {
      expect(keys).toEqual([PROGRESS_UPDATES_PROJECTION_KEY])
      return { values: { [PROGRESS_UPDATES_PROJECTION_KEY]: state.updates } }
    } }
    expect(readProjectedUpdates(service, {})).toEqual(state.updates)
  })

  it('服务抛错或没有登记本单元时返回 undefined（调用方据此回退内存）', () => {
    const throwing = { stateOf: () => { throw new Error('session not attached') } }
    expect(() => readProjectedUpdates(throwing, {})).not.toThrow()
    expect(readProjectedUpdates(throwing, {})).toBeUndefined()
    expect(readProjectedUpdates({}, {})).toBeUndefined()
    expect(readProjectedUpdates({ stateOf: () => undefined }, {})).toBeUndefined()
  })

  it('合并按 at 升序，同一毫秒保持传入顺序（被查询的会话自己排在最前）', () => {
    const own: ProgressUpdate[] = [{ id: 'pu-1-own', message: 'own', at: 200, source: 'own' }]
    const child: ProgressUpdate[] = [
      { id: 'pu-1-child', message: 'child-early', at: 100, source: 'child' },
      { id: 'pu-2-child', message: 'child-late', at: 300, source: 'child' },
    ]
    const sameMs: ProgressUpdate[] = [{ id: 'pu-3-own', message: 'own-same-ms', at: 200, source: 'own' }]
    expect(mergeProjectedUpdates([own, child]).map(update => update.message))
      .toEqual(['child-early', 'own', 'child-late'])
    expect(mergeProjectedUpdates([own, sameMs]).map(update => update.message))
      .toEqual(['own', 'own-same-ms'])
  })

  it('合并后仍然受 MAX_UPDATES 限制（整棵树共用一份进展）', () => {
    const many = (prefix: string, at: number): ProgressUpdate[] =>
      Array.from({ length: MAX_UPDATES }, (_, index) => ({ id: prefix + index, message: prefix + index, at: at + index }))
    const merged = mergeProjectedUpdates([many('a', 0), many('b', 0)])
    expect(merged).toHaveLength(MAX_UPDATES)
    // 留下的是 at 最大的那批。
    expect(merged[merged.length - 1]!.at).toBe(MAX_UPDATES - 1)
  })

  it('状态 schema 认得折叠出来的状态，也拒绝形状不对的缓存', () => {
    const state = fold([progressCall(1, { message: 'm' })])
    expect(progressUpdatesStateSchema.parse(state)).toEqual(state)
    expect(progressUpdatesStateSchema.safeParse({ updates: 'nope' }).success).toBe(false)
    expect(progressUpdatesStateSchema.safeParse({ updates: [{ message: 'm' }] }).success).toBe(false)
  })
})
