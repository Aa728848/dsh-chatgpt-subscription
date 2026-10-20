/**
 * Qoder 号池的测试：身份去重、活的刷新钩子、失败分类。
 *
 * 与 step-code 号池相反的部分正是本文件存在的理由：这条线路的凭据**会过期、
 * 可刷新**，所以 needsRefresh / refresh / refreshFailureStatus 三个钩子逐个钉住。
 */
import { describe, expect, it } from 'vitest'
import {
  QoderAccountPool,
  parseQoderPoolData,
  qoderPoolIdentity,
  qoderPoolQuota,
  qoderRefreshFailureStatus,
} from '../src/host/qoder/account-pool.ts'
import {
  qoderCredentialsNeedRefresh,
  type QoderCredentials,
} from '../src/host/qoder/token-store.ts'
import type { QoderQuotaSnapshotDto } from '../src/shared/qoder-contracts.ts'

/** 一份内存后端（生产是 DPAPI / Keychain / Secret Service；测试只要形状）。 */
class MemoryBackend<T> {
  private data: T | null = null
  async load(): Promise<T | null> { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) as T }
  async save(data: T): Promise<void> { this.data = JSON.parse(JSON.stringify(data)) }
  async clear(): Promise<void> { this.data = null }
}

function credentials(overrides: Partial<QoderCredentials> = {}): QoderCredentials {
  return {
    accessToken: 'jt-1',
    refreshToken: 'jrt-1',
    expiresAt: Date.now() + 24 * 3_600_000,
    region: 'global',
    origin: 'device',
    uid: 'u-1',
    email: 'me@qoder.com',
    accountName: 'Me',
    personalToken: null,
    organizationId: null,
    organizationTags: [],
    dataPolicyAgreed: false,
    authenticatedAt: Date.now(),
    ...overrides,
  }
}

describe('号池身份与文档解析', () => {
  it('去重键是「区域 + uid」：同 uid 同区合并，跨区不合并', () => {
    expect(qoderPoolIdentity(credentials())).toBe('global:u-1')
    expect(qoderPoolIdentity(credentials({ region: 'cn' }))).toBe('cn:u-1')
    // 没有 uid 时退回 token 指纹；两个都空才交给核心生成随机 id。
    const fingerprint = qoderPoolIdentity(credentials({ uid: null }))
    expect(fingerprint).toMatch(/^global:token:[0-9a-f]{16}$/)
    expect(qoderPoolIdentity(credentials({ uid: null, accessToken: '' }))).toBeUndefined()
  })

  it('一行坏凭据只丢那一行，不带倒整份池文档', () => {
    const data = parseQoderPoolData({
      version: 1,
      rotationStrategy: 'round-robin',
      accounts: [
        { id: 'a1', alias: 'good', credentials: credentials(), addedAt: 1, isPrimary: true },
        { id: 'a2', alias: 'bad', credentials: { accessToken: '' }, addedAt: 2, isPrimary: false },
      ],
    })
    expect(data.accounts).toHaveLength(1)
    expect(data.accounts[0]!.id).toBe('a1')
    expect(data.rotationStrategy).toBe('round-robin')
  })
})

describe('刷新钩子（这条线路的凭据会过期）', () => {
  it('needsRefresh：expiresAt - 1h < now 才刷新（逐字 docs/oauth.md §3）', () => {
    const now = Date.now()
    expect(qoderCredentialsNeedRefresh(credentials({ expiresAt: now + 2 * 3_600_000 }), now)).toBe(false)
    expect(qoderCredentialsNeedRefresh(credentials({ expiresAt: now + 30 * 60_000 }), now)).toBe(true)
    // expiresAt 缺 0 时按「接管时刻 + 24h」补兜底（token-store 的 qoderCredentialsExpireAt）。
    expect(qoderCredentialsNeedRefresh(credentials({ expiresAt: 0, authenticatedAt: now }), now)).toBe(false)
  })

  it('refreshFailureStatus：401/403 → expired；其余 → undefined（瞬时故障不判死）', () => {
    expect(qoderRefreshFailureStatus(Object.assign(new Error('nope'), { status: 401 }))).toBe('expired')
    expect(qoderRefreshFailureStatus(Object.assign(new Error('nope'), { status: 403 }))).toBe('expired')
    expect(qoderRefreshFailureStatus(new Error('Qoder（订阅） 令牌刷新失败（HTTP 401）'))).toBe('expired')
    expect(qoderRefreshFailureStatus(new Error('Qoder（订阅） 的这份凭据没有刷新令牌，只有重新登录才能续期。'))).toBe('expired')
    expect(qoderRefreshFailureStatus(Object.assign(new Error('boom'), { status: 500 }))).toBeUndefined()
    expect(qoderRefreshFailureStatus(new Error('network down'))).toBeUndefined()
  })

  it('号池取凭据：空池给明确的空池文案', async () => {
    const pool = new QoderAccountPool({ backend: new MemoryBackend() as never })
    await expect(pool.getEffectiveCredential()).rejects.toThrow(/还没有登录/)
  })

  it('加账号、读取、删除走完一轮（adopt 快照可删，理由同 step-code）', async () => {
    const pool = new QoderAccountPool({ backend: new MemoryBackend() as never })
    const account = await pool.addAccount(credentials())
    expect(account.region).toBe('global')
    expect(account.source).toBe('device')
    const read = await pool.getEffectiveCredential()
    expect(read.credentials.accessToken).toBe('jt-1')
    await pool.deleteAccount(account.id)
    await expect(pool.getEffectiveCredential()).rejects.toThrow(/还没有登录/)
  })
})

describe('qoderPoolQuota（账号卡的进度条只装个人桶）', () => {
  const fetchedAt = Date.now()
  const snapshot = (buckets: QoderQuotaSnapshotDto['buckets']): QoderQuotaSnapshotDto => ({
    buckets,
    expiresAt: null,
    fetchedAt,
    region: 'global',
  })

  it('个人桶 total>0 时按 used/total 画百分比；缺总额的桶不下发', () => {
    const quota = qoderPoolQuota(snapshot([
      { kind: 'personal', total: 1000, used: 250, remaining: 750, unit: 'Credits' },
      { kind: 'add-on', total: null, used: null, remaining: 5, unit: null },
    ]))
    expect(quota?.windows).toHaveLength(1)
    expect(quota!.windows[0]!.usedPercent).toBe(25)
    expect(quota!.fetchedAt).toBe(fetchedAt)
  })

  it('没有个人桶（或它不可计量）时不下发——「没读到」与「用完了」是两件事', () => {
    expect(qoderPoolQuota(snapshot([{ kind: 'add-on', total: 100, used: 10, remaining: 90, unit: null }]))).toBeUndefined()
    expect(qoderPoolQuota(snapshot([]))).toBeUndefined()
    expect(qoderPoolQuota(null)).toBeUndefined()
  })
})
