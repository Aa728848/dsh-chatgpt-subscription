/**
 * Qoder 输入框额度胶囊的挑选口径（纯函数，不挂载）。
 *
 * 钉的是：只按有总额的桶选已用比例最高的那只；没有可计量的桶时**不渲染**——
 * 装一个占位数字比不显示更像坏了。
 */
import { describe, expect, it } from 'vitest'
import { selectBadgeFacts } from '../src/client/qoder/QoderComposerQuota.tsx'
import type { QoderStatusDto } from '../src/shared/qoder-contracts.ts'

function status(quota: QoderStatusDto['quota']): QoderStatusDto {
  return {
    authenticated: true,
    hasCredentials: true,
    providerId: 'qoder',
    storagePath: '',
    region: 'global',
    account: null,
    quota,
    lastFetchedAt: null,
    models: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    serving: true,
    conflict: null,
  }
}

describe('selectBadgeFacts（Qoder 胶囊）', () => {
  it('选已用比例最高的桶，显示它的剩余百分比', () => {
    const facts = selectBadgeFacts(status({
      buckets: [
        { kind: 'personal', total: 1000, used: 200, remaining: 800, unit: 'Credits' },
        { kind: 'add-on', total: 500, used: 450, remaining: 50, unit: 'Credits' },
      ],
      expiresAt: null,
      fetchedAt: Date.now(),
      region: 'global',
    }))
    // 加购桶已用 90%，比个人桶的 20% 更紧。
    expect(facts).toMatchObject({ text: '10%' })
    expect(facts!.tooltip).toContain('10%')
    expect(facts!.tooltip).toContain('50')
    expect(facts!.tooltip).toContain('Credits')
  })

  it('没有快照 / 没有桶 / 桶都没有总额时返回 null（不渲染）', () => {
    expect(selectBadgeFacts(null)).toBeNull()
    expect(selectBadgeFacts(status(null))).toBeNull()
    expect(selectBadgeFacts(status({ buckets: [], expiresAt: null, fetchedAt: 1, region: 'global' }))).toBeNull()
    // 总额缺失或归 0：「上游没报」不是「用完了」。
    expect(selectBadgeFacts(status({
      buckets: [{ kind: 'personal', total: null, used: 5, remaining: 5, unit: null }],
      expiresAt: null,
      fetchedAt: 1,
      region: 'global',
    }))).toBeNull()
    expect(selectBadgeFacts(status({
      buckets: [{ kind: 'personal', total: 0, used: 0, remaining: 0, unit: 'Credits' }],
      expiresAt: null,
      fetchedAt: 1,
      region: 'global',
    }))).toBeNull()
  })
})
