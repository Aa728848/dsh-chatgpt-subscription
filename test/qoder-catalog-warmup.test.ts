/**
 * Qoder 目录的**启动预热**回归：重启之后，模型选择器不该先看到随包兜底表。
 *
 * 缺陷的形状（这一组用例钉的就是它）：进程内的 `cachedCatalog` 随宿主重启清空，
 * 而磁盘快照 `<DSH_HOME>/storages/qoder-global-catalog.json` 里躺着上一次的真实目录。
 * 快照原先只由 `loadQoderModelCatalog` 懒加载回填，而它唯一的调用方是设置页那几条
 * 路由（`GET /status` / 登录 / adopt / `POST /catalog/refresh`）——于是「重启之后、
 * 第一次打开设置页之前」，`adapter.listModels` 读到的是随包兜底表（全球区 15 条），
 * 选择器把这一大片缺省模型摊出来，用户点一下设置页它才恢复正常。
 *
 * 这一组用例全部用假 fetch + 私有 `DSH_HOME`（`test/setup/isolated-home.ts`），
 * 不碰真实凭据与网络。
 */
import fs from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  catalogSnapshotName,
  catalogSnapshotPath,
  flushCatalogSnapshots,
  writeCatalogSnapshot,
} from '../src/host/common/catalog-snapshot.ts'
import {
  clearCachedQoderModelCatalog,
  getCachedQoderModelCatalog,
  loadQoderModelCatalog,
  qoderCatalogIsLive,
  type QoderUpstreamCredential,
} from '../src/host/qoder/client.ts'
import { parseQoderModelListing, persistedQoderModelRecord } from '../src/host/qoder/model-catalog.ts'
import { warmQoderCatalogOnStartup } from '../src/host/qoder/routes.ts'
import { QoderAccountPool } from '../src/host/qoder/account-pool.ts'
import type { QoderCredentials } from '../src/host/qoder/token-store.ts'

const REGION = 'global'
const SNAPSHOT = catalogSnapshotName('qoder', REGION)

/** 本文件写的那份快照文件（与生产同一个文件名：`qoder-global-catalog.json`）。 */
function snapshotFile(): string {
  return catalogSnapshotPath(SNAPSHOT)
}

/**
 * 一份**新鲜**快照的写入时刻：落在 TTL 之内，于是回填之后不会再去打上游
 * （「重启后选择器第一眼看到的就是它」的那个场景）。
 */
function freshAt(): number {
  return Date.now()
}

/** 一份**过期**快照的写入时刻：过了 TTL，回填之后会顺手在背后刷新一次上游。 */
function staleAt(): number {
  return Date.now() - 31 * 60 * 1000
}

/**
 * 一份落在磁盘上的快照，**用生产写入侧的同一个序列化器**写出去。
 *
 * 用 `persistedQoderModelRecord` 而不是手搓一份 JSON：快照的写入侧与读取侧必须互为
 * 反函数，手搓的形状只能证明「我自己写的能读回来」，证明不了生产写出去的那一份能读回来。
 */
function snapshotRecords(...names: string[]) {
  const live = parseQoderModelListing({
    chat: names.map((name) => ({
      key: name.toLowerCase(),
      display_name: name,
      enable: true,
      source: 'system',
      is_vl: true,
      is_reasoning: true,
      context_config: { default: { token_count: 1_000_000, is_default: true } },
    })),
  }, REGION)
  return live.map(persistedQoderModelRecord)
}

function upstreamCredential(): QoderUpstreamCredential {
  return { accessToken: 'jt-secret', region: REGION, uid: 'u-1', email: null, accountName: null }
}

function credentials(overrides: Partial<QoderCredentials> = {}): QoderCredentials {
  return {
    accessToken: 'jt-secret',
    refreshToken: 'jrt-1',
    expiresAt: Date.now() + 24 * 3_600_000,
    region: REGION,
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

class MemoryBackend<T> {
  private data: unknown = null
  async load(): Promise<T | null> { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) as T }
  async save(data: T): Promise<void> { this.data = JSON.parse(JSON.stringify(data)) }
  async clear(): Promise<void> { this.data = null }
}

/**
 * 一个「闸住」的假 fetch：目录请求被挂住，只有 `releaseAll` 才让它 resolve。
 *
 * 于是「预热返回时上游请求还没落地」是一个可以断言的事实，而不是靠时间猜出来的。
 * COSY 版本跟随（GitHub releases）走 404，被安静吞掉，不计入目录请求的次数。
 */
function gatedCatalogFetch(answer: () => string[] = () => ['Lite', 'Ultimate']) {
  let calls = 0
  let settled = 0
  const pending: Array<() => void> = []
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!url.includes('/model/list')) return new Response('', { status: 404 })
    calls += 1
    return new Promise<Response>((resolve) => {
      pending.push(() => {
        settled += 1
        resolve(Response.json({
          chat: answer().map((name) => ({
            key: name.toLowerCase(),
            display_name: name,
            enable: true,
            source: 'system',
          })),
        }))
      })
    })
  }) as unknown as typeof fetch
  return {
    fetchFn,
    catalogCalls: () => calls,
    catalogSettled: () => settled,
    releaseAll: () => pending.splice(0).forEach((release) => release()),
  }
}

function newPool(): QoderAccountPool {
  return new QoderAccountPool({ backend: new MemoryBackend() as never })
}

function fakeContext(): Context {
  return { emit: vi.fn() } as unknown as Context
}

function emitCount(ctx: Context): number {
  return (ctx.emit as unknown as { mock: { calls: unknown[][] } }).mock.calls.length
}

/** 等到条件成立（或超时）。 */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 给后台刷新与那一次指纹比对留出落地的机会。 */
function settle(ms = 300): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 每个用例都从「进程刚刚重启」开始：内存目录空、快照文件由用例自己写。
 *
 * 收尾时先清内存再删文件：还在飞的后台刷新（这些用例的假 fetch 故意不放行，会一直
 * 挂到 DISCOVERY_TIMEOUT_MS）因此发布不了结果，也写不出快照——用例不必等一次注定
 * 超时的网络请求。
 */
beforeEach(async () => {
  clearCachedQoderModelCatalog()
  await flushCatalogSnapshots()
  await fs.rm(snapshotFile(), { force: true })
})

afterEach(async () => {
  clearCachedQoderModelCatalog()
  await flushCatalogSnapshots()
  await fs.rm(snapshotFile(), { force: true })
  vi.restoreAllMocks()
})

describe('Qoder 目录的启动预热', () => {
  /**
   * 最重要的一条：冷启动（进程内无缓存 + 磁盘有快照）。
   *
   * 预热返回的那一刻，进程内缓存必须**已经是快照里的真实目录**，而不是随包兜底表。
   * 这是「重启后选择器先看到 15 条假模型」这个缺陷的直接反面。
   */
  it('冷启动有快照时，预热返回即拿到真实目录，不等网络', async () => {
    await writeCatalogSnapshot(SNAPSHOT, snapshotRecords('Qwen3.8-Flash', 'DeepSeek-Flash'), freshAt())
    const gated = gatedCatalogFetch()
    const ctx = fakeContext()
    const pool = newPool()
    await pool.addAccount(credentials())

    // 重启后的真实状态：内存里什么都没有（选择器此刻会读到随包兜底表）。
    expect(getCachedQoderModelCatalog(REGION)).toEqual([])

    await warmQoderCatalogOnStartup(ctx, { fetchFn: gated.fetchFn, accountPool: pool })

    // 快照里的真实目录立刻就在了，而且上游一次都没有答过。
    expect(getCachedQoderModelCatalog(REGION).map((entry) => entry.id))
      .toEqual(['Qwen3.8-Flash', 'DeepSeek-Flash'])
    expect(qoderCatalogIsLive(REGION)).toBe(true)
    expect(gated.catalogSettled()).toBe(0)
  })

  /**
   * 任务 B：同一个性质在 `loadQoderModelCatalog` 上的那一半。
   *
   * 快照回填之后必须**立刻返回旧值并把刷新丢到背后**（第 446-449 行那段），而不是
   * await 网络——否则冷启动的第一拍仍然要等一次上游。
   */
  it('loadQoderModelCatalog 在快照回填后立刻返回旧值、刷新跑在背后', async () => {
    // 过期的快照：回填之后**一定会**触发一次后台刷新，才谈得上「不等它」。
    await writeCatalogSnapshot(SNAPSHOT, snapshotRecords('Qwen3.8-Flash'), staleAt())
    const gated = gatedCatalogFetch()

    const entries = await loadQoderModelCatalog(upstreamCredential(), { fetchFn: gated.fetchFn })

    expect(entries.map((entry) => entry.id)).toEqual(['Qwen3.8-Flash'])
    // 这次读**没有**等上游：刷新已经发出，但还挂在闸上没有 settle。
    await waitFor(() => gated.catalogCalls() === 1)
    expect(gated.catalogSettled()).toBe(0)
    expect(getCachedQoderModelCatalog(REGION).map((entry) => entry.id)).toEqual(['Qwen3.8-Flash'])
  })

  it('没有号池或池里没有账号时安静返回：不抛错、不联网、不发事件', async () => {
    const gated = gatedCatalogFetch()
    const ctx = fakeContext()

    // 没有装号池。
    await expect(warmQoderCatalogOnStartup(ctx, { fetchFn: gated.fetchFn })).resolves.toBeUndefined()
    // 装了号池但池是空的：getQuotaReadTarget 会抛，这里必须被吞掉。
    await expect(warmQoderCatalogOnStartup(ctx, { fetchFn: gated.fetchFn, accountPool: newPool() }))
      .resolves.toBeUndefined()

    await settle(50)
    expect(gated.catalogCalls()).toBe(0)
    expect(getCachedQoderModelCatalog(REGION)).toEqual([])
    expect(emitCount(ctx)).toBe(0)
  })

  /**
   * 目录真的变了 → 发一次事件；没变 → 一次都不发。
   *
   * 这条不是洁癖：`llm/adapters-updated` 是 DSH 重建模型选择器的唯一信号，无脑发
   * 就等于每次启动都让正在跑的选择器重建一遍。
   */
  it('预热让目录变化时发出 llm/adapters-updated（变化由后台刷新带来）', async () => {
    // 过期的快照里是一条旧目录，上游答的是另一批 id：这是一次真实的变化。
    await writeCatalogSnapshot(SNAPSHOT, snapshotRecords('Qwen3.7-Max'), staleAt())
    const gated = gatedCatalogFetch(() => ['Lite', 'Ultimate'])
    const ctx = fakeContext()
    const pool = newPool()
    await pool.addAccount(credentials())

    // 预热本身不等网络：它返回时缓存里还是快照那一份，事件也还没发。
    await warmQoderCatalogOnStartup(ctx, { fetchFn: gated.fetchFn, accountPool: pool })
    expect(getCachedQoderModelCatalog(REGION).map((entry) => entry.id)).toEqual(['Qwen3.7-Max'])
    expect(gated.catalogSettled()).toBe(0)
    expect(emitCount(ctx)).toBe(0)

    // 后台刷新落地：目录真的换了，事件随之发出（且只发一次）。
    await waitFor(() => gated.catalogCalls() === 1)
    gated.releaseAll()
    await waitFor(() => emitCount(ctx) > 0)
    expect(getCachedQoderModelCatalog(REGION).map((entry) => entry.id)).toEqual(['Lite', 'Ultimate'])
    expect(ctx.emit).toHaveBeenCalledWith('llm/adapters-updated')
    expect(emitCount(ctx)).toBe(1)
  })

  it('目录没有变化时一次都不发 llm/adapters-updated', async () => {
    // 过期的快照 + 上游答同一批 id：会真的刷新一次，但目录没变，所以一次事件都不发。
    await writeCatalogSnapshot(SNAPSHOT, snapshotRecords('Lite', 'Ultimate'), staleAt())
    const gated = gatedCatalogFetch(() => ['Lite', 'Ultimate'])
    const ctx = fakeContext()
    const pool = newPool()
    await pool.addAccount(credentials())

    await warmQoderCatalogOnStartup(ctx, { fetchFn: gated.fetchFn, accountPool: pool })
    await waitFor(() => gated.catalogCalls() === 1)
    gated.releaseAll()

    await waitFor(() => gated.catalogSettled() === 1)
    await settle()
    expect(emitCount(ctx)).toBe(0)
  })

  it('没有磁盘快照时只打一次上游，且失败被吞掉', async () => {
    let calls = 0
    const failing = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.includes('/model/list')) return new Response('', { status: 404 })
      calls += 1
      throw new Error('network down')
    }) as unknown as typeof fetch
    const ctx = fakeContext()
    const pool = newPool()
    await pool.addAccount(credentials())

    await expect(warmQoderCatalogOnStartup(ctx, { fetchFn: failing, accountPool: pool })).resolves.toBeUndefined()

    await settle(50)
    expect(calls).toBe(1)
    // 目录取不到：缓存仍然是空的（调用方走随包兜底表），并且没有发出任何事件。
    expect(getCachedQoderModelCatalog(REGION)).toEqual([])
    expect(emitCount(ctx)).toBe(0)
  })
})
