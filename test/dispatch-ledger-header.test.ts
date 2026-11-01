import { describe, expect, it } from 'vitest'
import {
  MANDATE_FENCE_CLOSE,
  MANDATE_FENCE_OPEN,
  MANDATE_HEADER_MAX_BYTES,
  MANDATE_HEADER_VERSION,
  MANDATE_PROTOCOL_ID,
  MANDATE_SUPPORTED_MANDATE_VERSION,
  mandateBodyOf,
  mandateNamespaceKey,
  parseMandateHeader,
} from '../src/host/dispatch-ledger/header.ts'
import {
  mandateFromTextBlocks,
  textBlocksOf,
} from '../src/host/dispatch-ledger/binding.ts'
import {
  DISPATCH_MANDATE_PROTOCOL,
  DISPATCH_MANDATE_PROTOCOL_MAX_CHARS,
} from '../src/host/dispatch-ledger/protocol.ts'
import {
  DISPATCH_POLICY_ID,
  canonicalPolicyJson,
  dispatchPolicyDescriptor,
  policyDescriptorsMatch,
  promptRefDescriptor,
  sha256Hex,
} from '../src/host/dispatch-ledger/policy.ts'

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
    policy: { id: 'dsh-dispatch-ledger', version: '1', sha256: '3f9a1c2b3c4d5e6f' },
    grant: { context: ['ctx://plan-v3'] },
    ...overrides,
  }
}

/** 把字段包成一段带头部的文本。 */
function withHeader(fields: Record<string, unknown>, body = 'do the work'): string {
  return MANDATE_FENCE_OPEN + '\n' + JSON.stringify(fields) + '\n' + MANDATE_FENCE_CLOSE + '\n' + body
}

describe('mandate v2 头部文法', () => {
  it('解析一份合法的派发头', () => {
    const parsed = parseMandateHeader(withHeader(dispatchFields()))
    expect(parsed.state).toBe('ok')
    expect(parsed.header?.kind).toBe('dispatch')
    expect(parsed.header?.brief_id).toBe('b-7f')
    expect(parsed.header?.mandate_version).toBe(MANDATE_SUPPORTED_MANDATE_VERSION)
    expect(parsed.header?.v).toBe(MANDATE_HEADER_VERSION)
    expect(parsed.body).toBe('do the work')
  })

  it('没有围栏的文本是"没有头部"，不是损坏', () => {
    expect(parseMandateHeader('just a task').state).toBe('none')
    expect(parseMandateHeader('').state).toBe('none')
    expect(parseMandateHeader(undefined).state).toBe('none')
    expect(parseMandateHeader(42).state).toBe('none')
  })

  it('围栏在但 JSON 非法 → 损坏', () => {
    const text = MANDATE_FENCE_OPEN + '\n{not json}\n' + MANDATE_FENCE_CLOSE
    expect(parseMandateHeader(text).state).toBe('invalid')
  })

  it('围栏没闭合 → 损坏', () => {
    expect(parseMandateHeader(MANDATE_FENCE_OPEN + '\n{}').state).toBe('invalid')
  })

  it('未知版本 → 损坏', () => {
    expect(parseMandateHeader(withHeader(dispatchFields({ v: 3 }))).state).toBe('invalid')
    expect(parseMandateHeader(withHeader(dispatchFields({ mandate_version: 2 }))).state).toBe('invalid')
  })

  it('未知字段 → 损坏（严格 schema）', () => {
    expect(parseMandateHeader(withHeader(dispatchFields({ extra: 1 }))).state).toBe('invalid')
  })

  it('模型自带正文哈希 → 损坏（哈希只由插件算）', () => {
    expect(parseMandateHeader(withHeader(dispatchFields({ body_sha256: 'a'.repeat(64) }))).state).toBe('invalid')
    expect(parseMandateHeader(withHeader(reportFields({ body_sha256: 'a'.repeat(64) }))).state).toBe('invalid')
    expect(parseMandateHeader(withHeader(steerFields({ body_sha256: 'a'.repeat(64) }))).state).toBe('invalid')
  })

  it('id 越界或字符集不合法 → 损坏', () => {
    expect(parseMandateHeader(withHeader(dispatchFields({ brief_id: 'a b' }))).state).toBe('invalid')
    expect(parseMandateHeader(withHeader(dispatchFields({ brief_id: '' }))).state).toBe('invalid')
    expect(parseMandateHeader(withHeader(dispatchFields({ brief_id: 'x'.repeat(65) }))).state).toBe('invalid')
  })

  it('超过字节预算 → 损坏', () => {
    const huge = dispatchFields({ task: ['t'.repeat(400)] })
    expect(parseMandateHeader(withHeader(huge)).state).toBe('invalid')
    expect(MANDATE_HEADER_MAX_BYTES).toBe(4096)
  })

  it('kind 与字段的组合受约束', () => {
    // dispatch 必须带 task/boundary/followup/parent_mandate
    const missingTask = dispatchFields()
    delete missingTask['task']
    expect(parseMandateHeader(withHeader(missingTask)).state).toBe('invalid')
    // report 必须带 status，且不得带 task
    expect(parseMandateHeader(withHeader(reportFields({ status: undefined }))).state).toBe('invalid')
    expect(parseMandateHeader(withHeader(reportFields({ task: ['x'] }))).state).toBe('invalid')
    // steer 必须带 grant，且不得带 status
    expect(parseMandateHeader(withHeader(steerFields({ grant: undefined }))).state).toBe('invalid')
    expect(parseMandateHeader(withHeader(steerFields({ status: 'ready' }))).state).toBe('invalid')
    // dispatch 不得带 status/grant
    expect(parseMandateHeader(withHeader(dispatchFields({ status: 'ready' }))).state).toBe('invalid')
    expect(parseMandateHeader(withHeader(dispatchFields({ grant: { context: [] } }))).state).toBe('invalid')
  })

  it('null 与字段缺失同义', () => {
    // schema 把 parent_mandate / grant 声明成 nullable，模型也习惯把用不到的
    // 字段写成 null：把 null 当成"携带了这个字段"，等于拒绝一个语义上完全
    // 正确、只是写法啰嗦的头部。
    expect(parseMandateHeader(withHeader(dispatchFields({ grant: null }))).state).toBe('ok')
    expect(parseMandateHeader(withHeader(reportFields({ parent_mandate: null, grant: null }))).state).toBe('ok')
    expect(parseMandateHeader(withHeader(steerFields({ grant: null }))).state).toBe('ok')
    // 真的带了值仍然被拒
    const withParent = reportFields({ parent_mandate: { brief_id: 'b-7f', run_id: 'r-1', idem: 'i-1' } })
    expect(parseMandateHeader(withHeader(withParent)).state).toBe('invalid')
  })

  it('kind 违规的说明里带着该方向的字段集', () => {
    // 只说"不许带 X"时，模型只能逐个字段试错——这正是它反复写不对的原因。
    const report = parseMandateHeader(withHeader(reportFields({ task: ['task://req-42'] })))
    expect(report.state).toBe('invalid')
    expect(report.reason).toContain('a report header must not carry task')
    expect(report.reason).toContain('carries exactly')
    expect(report.reason).toContain('status')
    const dispatch = parseMandateHeader(withHeader(dispatchFields({ grant: { context: [] } })))
    expect(dispatch.reason).toContain('a dispatch header must not carry grant')
    expect(dispatch.reason).toContain('parent_mandate')
  })

  it('数组条目有上限', () => {
    expect(parseMandateHeader(withHeader(dispatchFields({ task: Array.from({ length: 5 }, (_, i) => 't' + i) }))).state).toBe('invalid')
    expect(parseMandateHeader(withHeader(dispatchFields({ boundary: Array.from({ length: 17 }, (_, i) => 'b' + i) }))).state).toBe('invalid')
    expect(parseMandateHeader(withHeader(dispatchFields({ followup: Array.from({ length: 9 }, (_, i) => 'c' + i) }))).state).toBe('invalid')
  })

  it('命名空间键由三元组拼成', () => {
    const parsed = parseMandateHeader(withHeader(dispatchFields()))
    expect(mandateNamespaceKey(parsed.header!)).toBe('b-7f\u0000r-1\u0000i-1')
  })

  it('正文从收尾围栏之后取', () => {
    expect(mandateBodyOf(withHeader(dispatchFields(), 'the body'))).toBe('the body')
    expect(mandateBodyOf('no header')).toBeUndefined()
  })
})

describe('Mandate 在文本块里的位置', () => {
  it('第一个块就是头部时找得到', () => {
    const blocks = [{ type: 'text', text: withHeader(dispatchFields()) }]
    expect(mandateFromTextBlocks(blocks).state).toBe('ok')
  })

  it('头部在第二个块时也找得到（投递消息的形状）', () => {
    const blocks = [
      { type: 'text', text: 'Agent parent-1 sent a message: ' },
      { type: 'text', text: withHeader(reportFields()) },
    ]
    const parsed = mandateFromTextBlocks(blocks)
    expect(parsed.state).toBe('ok')
    expect(parsed.header?.kind).toBe('report')
    expect(parsed.header?.status).toBe('ready')
  })

  it('只有前缀块时是"没有头部"', () => {
    const blocks = [{ type: 'text', text: 'Agent parent-1 sent a message: ' }]
    expect(mandateFromTextBlocks(blocks).state).toBe('none')
  })

  it('损坏的头部不会被当成没有头部', () => {
    const blocks = [
      { type: 'text', text: 'prefix' },
      { type: 'text', text: MANDATE_FENCE_OPEN + '\n{bad}\n' + MANDATE_FENCE_CLOSE },
    ]
    expect(mandateFromTextBlocks(blocks).state).toBe('invalid')
  })

  it('非文本块被跳过', () => {
    expect(textBlocksOf([{ type: 'image', data: 'x' }, { type: 'text', text: 'hi' }])).toEqual(['hi'])
    expect(textBlocksOf('not an array')).toEqual([])
  })
})

describe('协议正文', () => {
  it('在字符预算内', () => {
    expect(DISPATCH_MANDATE_PROTOCOL.length).toBeLessThanOrEqual(DISPATCH_MANDATE_PROTOCOL_MAX_CHARS)
    expect(DISPATCH_MANDATE_PROTOCOL_MAX_CHARS).toBe(4096)
  })

  it('每一段样板头部都能被真解析器判 ok', () => {
    // 正文里的围栏是模型会**照抄**的样板：样板一旦不合文法，模型抄一次被拒
    // 一次，而它没有别的依据可循。v2 首版就踩过这个坑——样板带着 `grant:null`，
    // 被自己的 kind 校验判成"抄错角色"。
    const blocks = [...DISPATCH_MANDATE_PROTOCOL.matchAll(/```dsh-mandate-v2\n([\s\S]*?)\n```/g)]
    expect(blocks.length, '协议里一段样板都没有').toBeGreaterThan(0)
    for (const block of blocks) {
      const text = MANDATE_FENCE_OPEN + '\n' + block[1] + '\n' + MANDATE_FENCE_CLOSE + '\nbody'
      const parsed = parseMandateHeader(text)
      expect(parsed.state, '样板不是合法头部：' + block[1]).toBe('ok')
    }
  })

  it('包含完整的拒绝码表与字段说明', () => {
    for (const code of [
      'MANDATE_MALFORMED',
      'MANDATE_KIND',
      'MANDATE_DUPLICATE',
      'MANDATE_BRIEF_BUSY',
      'MANDATE_LINEAGE_REQUIRED',
      'MANDATE_LINEAGE',
      'MANDATE_POLICY_STALE',
      'MANDATE_VERSION',
      'MANDATE_NOT_PARENT',
      'MANDATE_NOT_CHILD',
      'MANDATE_GRANT_EXCEEDS',
      'MANDATE_NOT_HELD',
    ]) {
      expect(DISPATCH_MANDATE_PROTOCOL).toContain(code)
    }
    expect(DISPATCH_MANDATE_PROTOCOL).toContain(MANDATE_PROTOCOL_ID)
    expect(DISPATCH_MANDATE_PROTOCOL).toContain('dispatch_ledger')
  })
})

describe('策略与提示词引用描述符', () => {
  it('规范化 JSON 与键序、数组序无关', () => {
    const left = canonicalPolicyJson({
      tools: ['subagent_fork', 'subagent'],
      routes: [{ provider: 'b', model: 'm2' }, { provider: 'a', model: 'm1' }],
    })
    const right = canonicalPolicyJson({
      tools: ['subagent', 'subagent_fork'],
      routes: [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }],
    })
    expect(left).toBe(right)
    expect(left).toContain('"id":"dsh-dispatch-ledger"')
    expect(left.indexOf('"id"')).toBeLessThan(left.indexOf('"routes"'))
    expect(left.indexOf('"routes"')).toBeLessThan(left.indexOf('"tools"'))
    expect(left.indexOf('"tools"')).toBeLessThan(left.indexOf('"version"'))
  })

  it('描述符可复现，摘要是内容的函数', () => {
    const descriptor = dispatchPolicyDescriptor({ tools: ['subagent'] })
    expect(descriptor.id).toBe(DISPATCH_POLICY_ID)
    expect(descriptor.sha256).toBe(sha256Hex(canonicalPolicyJson({ tools: ['subagent'] })))
    expect(dispatchPolicyDescriptor({ tools: ['subagent'] })).toEqual(descriptor)
  })

  it('两份描述符按摘要前缀比较', () => {
    const descriptor = dispatchPolicyDescriptor({ tools: ['subagent'] })
    const same = { ...descriptor, sha256: descriptor.sha256.slice(0, 12) + '0'.repeat(52) }
    expect(policyDescriptorsMatch(descriptor, same)).toBe(true)
    expect(policyDescriptorsMatch(descriptor, { ...descriptor, sha256: 'f'.repeat(64) })).toBe(false)
    expect(policyDescriptorsMatch(descriptor, { ...descriptor, version: '2' })).toBe(false)
    expect(policyDescriptorsMatch(descriptor, { ...descriptor, id: 'other' })).toBe(false)
  })

  it('提示词引用是内容寻址的短版本号', () => {
    const descriptor = promptRefDescriptor('the prompt body')
    expect(descriptor.ref.startsWith('p-')).toBe(true)
    expect(descriptor.ref.length).toBeLessThanOrEqual(64)
    expect(descriptor.sha256).toBe(sha256Hex('the prompt body'))
    expect(promptRefDescriptor('the prompt body')).toEqual(descriptor)
    expect(promptRefDescriptor('other body').ref).not.toBe(descriptor.ref)
  })
})
