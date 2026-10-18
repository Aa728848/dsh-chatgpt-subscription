import { describe, expect, it } from 'vitest'
import { NUDGE_TEXT, counterSessionIdOf, createNudgeContext } from '../src/host/progress-updates/nudge.ts'
import type { NudgeSessionLookup } from '../src/host/progress-updates/nudge.ts'

/** 一张最小的会话表：id -> lineage。 */
function lookup(table: Record<string, { origin?: string, parentSession?: string }>): NudgeSessionLookup & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    get(id: string) {
      asked.push(id)
      const entry = table[id]
      return entry === undefined ? undefined : { header: entry }
    },
  }
}

describe('counterSessionIdOf', () => {
  it('顶层会话用自己的 id 计数', () => {
    const sessions = lookup({ root: {} })
    expect(counterSessionIdOf({ id: 'root', session: { header: { id: 'root' } } }, sessions)).toBe('root')
  })

  it('subagent 归并到顶层祖先，整棵委派树共用一个计数器', () => {
    const sessions = lookup({
      root: {},
      child: { origin: 'subagent', parentSession: 'root' },
      grandchild: { origin: 'subagent', parentSession: 'child' },
    })
    expect(counterSessionIdOf({ session: { header: { id: 'child', origin: 'subagent', parentSession: 'root' } } }, sessions))
      .toBe('root')
    expect(counterSessionIdOf({ session: { header: { id: 'grandchild', origin: 'subagent', parentSession: 'child' } } }, sessions))
      .toBe('root')
  })

  it('带着自己的 header 时不必回表查自己', () => {
    const sessions = lookup({ root: {}, child: { origin: 'subagent', parentSession: 'root' } })
    counterSessionIdOf({ session: { header: { id: 'child', origin: 'subagent', parentSession: 'root' } } }, sessions)
    expect(sessions.asked).toEqual(['root'])
  })

  it('父会话查不到时退回自己能确认的最上层', () => {
    const sessions = lookup({ child: { origin: 'subagent', parentSession: 'gone' } })
    expect(counterSessionIdOf({ session: { header: { id: 'child', origin: 'subagent', parentSession: 'gone' } } }, sessions))
      .toBe('child')
  })

  it('没有会话表时只认自己的会话 id', () => {
    expect(counterSessionIdOf({ id: 'root', session: { header: { id: 'root' } } })).toBe('root')
    expect(counterSessionIdOf({ session: { header: { id: 'child', origin: 'subagent', parentSession: 'root' } } }))
      .toBe('child')
  })

  it('判定不出来时返回 undefined（调用方归入默认桶）', () => {
    expect(counterSessionIdOf(undefined)).toBeUndefined()
    expect(counterSessionIdOf({})).toBeUndefined()
  })

  it('血缘成环时不会死循环', () => {
    const sessions = lookup({
      a: { origin: 'subagent', parentSession: 'b' },
      b: { origin: 'subagent', parentSession: 'a' },
    })
    expect(counterSessionIdOf({ session: { header: { id: 'a', origin: 'subagent', parentSession: 'b' } } }, sessions))
      .toBeDefined()
  })
})

describe('createNudgeContext', () => {
  it('造出的是一条 user 角色的消息', () => {
    const context = createNudgeContext(1)
    expect(context.role).toBe('user')
    expect(context.content).toEqual([{ type: 'text', text: NUDGE_TEXT }])
    expect(typeof context.id).toBe('string')
  })

  it('来源可辨认，并带上第几次催促', () => {
    const context = createNudgeContext(3)
    expect(context.source).toMatchObject({ kind: 'progress-updates-nudge', form: 'notice' })
    expect((context.source as { summary?: string }).summary).toContain('#3')
  })

  it('催促正文点名 progress_update 工具', () => {
    expect(NUDGE_TEXT).toContain('progress_update')
    expect(NUDGE_TEXT).toContain('one short title line')
    expect(createNudgeContext(1).content).toEqual([{ type: 'text', text: NUDGE_TEXT }])
  })
})
