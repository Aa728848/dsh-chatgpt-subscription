/**
 * Qoder 线路的号池：共享 \`AccountPoolCore\` 之上的薄封装。
 *
 * 存储、序列化、可用性、轮转、429 冷却都由 \`src/host/common/account-pool.ts\` 管；
 * 本文件只回答「Qoder 这条线的凭据长什么样、怎么刷新、身份怎么算、卡片怎么装配」。
 *
 * 与 step-code 号池的三处不同，各有理由：
 *
 * 1. **刷新钩子是活的。** Qoder 的 token 会过期（types.ts 文件头第 2 条），所以
 *    \`expiresAt\` / \`needsRefresh\` / \`refresh\` 三个钩子全部如实实现；
 *    刷新失败按 401/403 → expired（这个账号要重登）、其余 → undefined（瞬时故障不判死）。
 * 2. **两区可以同时在池里。** 区域是凭据的属性（计划 §1），去重键里必须带区域：
 *    否则同一个 uid 在两个部署上会被合并成一行，然后那一行的凭据被拿去打另一个区的主机。
 * 3. **adopt 快照可删。** 本插件只读 \`~/.qoder/.auth/user\`，从不写它；
 *    删掉池里的一行只是删掉本插件自己的加密记录，用户的 qodercli 会话不动。
 */

import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  AccountPoolCore,
  normalizeRotationStrategy,
  type AccountPoolHooks,
  type PoolAccountShape,
  type PoolData,
} from '../common/account-pool.ts'
import { poolQuota, quotaWindow } from '../common/account-quota.ts'
import { dshHomeDir } from '../common/home.ts'
import type { CredentialStore } from '../token-store.ts'
import type {
  AccountRotationStrategy,
  PoolAccountQuotaDto,
} from '../../shared/account-pool-contracts.ts'
import type {
  QoderAccountSummaryDto,
  QoderQuotaSnapshotDto,
  QoderRegion,
  QoderStatusDto,
} from '../../shared/qoder-contracts.ts'
import { getCachedQoderQuotaFor } from './client.ts'
import { PROVIDER_ID, PROVIDER_NAME } from './types.ts'
import { refreshQoderCredential } from './oauth.ts'
import {
  QODER_CLI_CREDENTIAL_SOURCE,
  parseQoderCredentials,
  qoderCredentialsExpireAt,
  qoderCredentialsNeedRefresh,
  type QoderCredentials,
  type QoderCredentialOrigin,
} from './token-store.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 一个池内账号行。凭据整个随行存放；其余是卡片渲染用的非机密事实。 */
export interface QoderPoolAccount extends PoolAccountShape<QoderCredentials> {
  /** 账号所属区域；由凭据自述，这里是给它做索引用。 */
  region: QoderRegion
  /** 这份凭据的来源（设备流 / PAT / adopt），供卡片显示。 */
  source: QoderCredentialOrigin
}

/** 号池切片：共享摘要 + 本线路的区域与来源。 */
export type QoderAccountSummary = QoderAccountSummaryDto

/** 本线路自己的加密号池文件。与凭据文件分开：池可以有多行，凭据文件只有主账号一份。 */
export function qoderPoolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'qoder-pool.json')
}

/** keychain / Secret Service 的服务名。与其它线路各用各的，互不相干。 */
export const QODER_POOL_KEYCHAIN_SERVICE = 'dsh-qoder-pool'

/**
 * 身份：两个凭据什么时候是同一个上游账号。
 *
 * 组成是「区域 + uid」，两段都非机密，也都不随重新登录而变（Qoder 的 token 每次
 * 兑换都可能换一把新的，拿 token 当键会让同一个账号每次登录都长成新账号，号池无限增长）。
 *
 * 没有 uid 时退回「区域 + accessToken 的 SHA-256 前 16 字节」：那是**指纹**，不是身份，
 * 但它至少保证同一把 token 落到同一行；两段全空才返回 undefined，那时核心自己生成
 * \`acc_<random>\`，把这一行**新增**而不是与某个无关凭据合并。
 */
export function qoderPoolIdentity(credentials: QoderCredentials): string | undefined {
  const uid = (credentials.uid ?? '').trim()
  if (uid !== '') return credentials.region + ':' + uid
  const token = credentials.accessToken.trim()
  if (token === '') return undefined
  return credentials.region + ':token:' + createHash('sha256').update(token).digest('hex').slice(0, 16)
}

/** 账号没有自带可认名字时的默认别名。 */
function defaultAliasFor(credentials: QoderCredentials, position: number): string {
  const name = (credentials.accountName ?? '').trim() || (credentials.email ?? '').trim() || (credentials.uid ?? '').trim()
  const suffix = credentials.adopted === true ? '（来自 qodercli 客户端）' : '账号 ' + position
  return (name === '' ? PROVIDER_NAME + ' · ' + credentials.region : name) + ' · ' + suffix
}

/**
 * 从一次登录、一次粘贴或一次 adopt 造出一行。
 *
 * \`createAccount\` 与 \`legacyAccount\` 都走它，所以「新登录造出的行」与「号池出现之前
 * 就存在的凭据投影出来的行」不可能漂移开。
 */
function projectAccount(input: {
  id: string
  alias: string
  credentials: QoderCredentials
  addedAt: number
  isPrimary: boolean
}): QoderPoolAccount {
  const credentials = input.credentials
  return {
    id: input.id,
    alias: input.alias,
    credentials,
    addedAt: input.addedAt,
    isPrimary: input.isPrimary,
    region: credentials.region,
    source: credentials.origin,
  }
}

/**
 * 校验并归一化整份号池文档。
 *
 * 凭据重新过一遍 \`parseQoderCredentials\`，所以一行不可能装着一份 store 会拒绝写回的形状。
 * 一行凭据读不通就**丢弃这一行**而不是整体报错——\`read()\` 会吞掉一次加载失败并回落，
 * 抛错等于让一行坏数据带走整个池。
 */
export function parseQoderPoolData(value: unknown): PoolData<QoderPoolAccount> {
  if (!isRecord(value)) throw new Error(PROVIDER_NAME + ' 号池载荷无效')
  const accounts: QoderPoolAccount[] = []
  for (const item of Array.isArray(value.accounts) ? value.accounts : []) {
    if (!isRecord(item) || typeof item.id !== 'string') continue
    let credentials: QoderCredentials
    try {
      credentials = parseQoderCredentials(item.credentials)
    } catch {
      continue
    }
    const account = projectAccount({
      id: item.id,
      alias: typeof item.alias === 'string' && item.alias !== ''
        ? item.alias
        : defaultAliasFor(credentials, accounts.length + 1),
      credentials,
      addedAt: typeof item.addedAt === 'number' ? item.addedAt : Date.now(),
      isPrimary: item.isPrimary === true,
    })
    if (typeof item.lastUsedAt === 'number') account.lastUsedAt = item.lastUsedAt
    if (typeof item.cooldownUntil === 'number') account.cooldownUntil = item.cooldownUntil
    if (typeof item.cooldownReason === 'string') account.cooldownReason = item.cooldownReason
    if (item.authStatus === 'expired' || item.authStatus === 'invalid') {
      account.authStatus = item.authStatus
    }
    if (typeof item.authFailedReason === 'string') account.authFailedReason = item.authFailedReason
    accounts.push(account)
  }
  const result: PoolData<QoderPoolAccount> = {
    version: 1,
    rotationStrategy: normalizeRotationStrategy(value.rotationStrategy),
    accounts,
  }
  if (typeof value.activeAccountId === 'string') result.activeAccountId = value.activeAccountId
  return result
}

/**
 * 额度快照 → 号池卡片渲染的形状。
 *
 * 只有 \`personal\` 桶进入账号卡的进度条：加购包与组织包是另一条性质的量
 * （它们出现在线路级额度卡里，不在账号卡上）。桶是绝对量，卡片只认得百分比，
 * 换算只在 \`total > 0\` 时做——total 为 0 或缺失的桶**不下发**，而不是画成 0%
 * （「上游没报」与「一点没花」必须长得不一样）。
 *
 * \`windowDurationMins\` 传 null：Qoder 的额度是账号周期余额，没有一个诚实的
 * 「窗口长度」可填，卡片按通用名渲染。\`resetsAt\` 用账号周期截止 \`expiresAt\`。
 */
export function qoderPoolQuota(
  snapshot: QoderQuotaSnapshotDto | null | undefined,
): PoolAccountQuotaDto | undefined {
  if (snapshot === null || snapshot === undefined) return undefined
  const personal = snapshot.buckets.find((bucket) => bucket.kind === 'personal')
  if (personal === undefined || personal.total === null || personal.total <= 0 || personal.used === null) {
    return undefined
  }
  const window = quotaWindow('', (personal.used / personal.total) * 100, {
    windowDurationMins: null,
    resetsAt: snapshot.expiresAt,
  })
  return poolQuota(snapshot.fetchedAt, [window])
}

// ---------------------------------------------------------------------------
// 号池
// ---------------------------------------------------------------------------

/** 本线路号池的构造选项。全部可选：生产按池文件路径构造平台后端。 */
export interface QoderAccountPoolOptions {
  /** 测试缝；生产按池文件路径构造平台后端（DPAPI / Keychain / SecretService）。 */
  backend?: CredentialStore<PoolData<QoderPoolAccount>>
  /** 本池接受的账号数上限。 */
  maxAccounts?: number
  /** 用户在设置里钉住的账号；钉住的账号冷却时自动让位给轮转（核心自己处理）。 */
  preferAccountId?: () => string | null
}

/**
 * 刷新失败的分类。
 *
 * 401/403 → \`'expired'\`（上游明说这把 token 不行了，这个账号要重登）；
 * 其余（网络故障、5xx、形状变了）→ undefined：瞬时故障不该把一个账号判死。
 */
export function qoderRefreshFailureStatus(error: unknown): 'expired' | 'invalid' | undefined {
  const status = (error as { status?: unknown } | null)?.status
  if (status === 401 || status === 403) return 'expired'
  const message = error instanceof Error ? error.message : ''
  if (/HTTP (401|403)/.test(message) || /没有刷新令牌/.test(message)) return 'expired'
  return undefined
}

/** 本线路的号池。凭据类型是本线路自己的，刷新钩子全部如实实现。 */
export class QoderAccountPool extends AccountPoolCore<
  QoderCredentials,
  QoderPoolAccount,
  QoderAccountSummary
> {
  constructor(options: QoderAccountPoolOptions = {}) {
    const hooks: AccountPoolHooks<
      QoderCredentials,
      QoderPoolAccount,
      QoderAccountSummary
    > = {
      providerId: PROVIDER_ID,
      displayName: PROVIDER_NAME,
      poolFile: qoderPoolPath(),
      keychainService: QODER_POOL_KEYCHAIN_SERVICE,
      parsePoolData: parseQoderPoolData,
      dedupeKey: qoderPoolIdentity,
      defaultAlias: defaultAliasFor,
      createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => projectAccount({
        id,
        alias,
        credentials,
        addedAt,
        isPrimary,
      }),
      // 三个钩子都是活的（types.ts 文件头第 2 条：凭据会过期、可刷新）。
      expiresAt: (credentials) => qoderCredentialsExpireAt(credentials),
      needsRefresh: (credentials, now) => qoderCredentialsNeedRefresh(credentials, now),
      refresh: (credentials, fetchFn) => refreshQoderCredential(credentials, fetchFn),
      refreshFailureStatus: qoderRefreshFailureStatus,
      extendSummary: (account, base) => {
        const email = account.credentials.email
        const name = account.credentials.accountName
        return {
          ...base,
          region: account.region,
          origin: account.source,
          ...(email === null || email === '' ? {} : { email }),
          ...(name === null || name === '' ? {} : { accountName: name }),
          ...(() => {
            const quota = qoderPoolQuota(getCachedQoderQuotaFor(account.id))
            return quota === undefined ? {} : { quota }
          })(),
        }
      },
      emptyMessage: '还没有登录 ' + PROVIDER_NAME
        + ' 账号。请在设置页点击登录（全球区）、粘贴 PAT，或在本机 qodercli 登录后使用导入。',
      allUnavailableMessage: (count, waitMinutes) =>
        '全部 ' + count + ' 个 ' + PROVIDER_NAME
        + ' 账号都处于配额限制或冷却中（429）。'
        + (waitMinutes === null ? '目前没有处于冷却中的账号。' : '最短预计在 ' + waitMinutes + ' 分钟后解除。'),
      allAuthFailedMessage: (count) =>
        '全部 ' + count + ' 个 ' + PROVIDER_NAME + ' 账号都需要重新登录。',
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      ...(options.maxAccounts === undefined ? {} : { maxAccounts: options.maxAccounts }),
      ...(options.preferAccountId === undefined ? {} : { preferAccountId: options.preferAccountId }),
    }
    super(hooks)
  }

  /**
   * 把一份 adopt 快照收进号池。
   *
   * 快照已经跑过 \`adopt.ts\` 的解析（解密、字段、区域探测都已确认），这里只补来源标记；
   * 账号仍以 \`qoderPoolIdentity\` 的身份落进池，重复 adopt 同一次登录只会更新同一行。
   */
  async addAdoptedCredential(
    adopted: { readonly credentials: QoderCredentials; readonly sourcePath?: string },
    alias?: string,
  ): Promise<QoderPoolAccount> {
    return this.addAccount(adopted.credentials, alias)
  }

  /**
   * 适配器取下一个账号用的入口。
   *
   * 核心在这里做轮转、冷却、可用性判断与刷新；本方法只多给适配器一件事：
   * 一次请求内换过账号时，把试过的账号排除掉。
   */
  async getEffectiveCredential(
    excludeIds?: ReadonlySet<string>,
    fetchFn: typeof fetch = fetch,
  ): Promise<{ account: QoderPoolAccount; credentials: QoderCredentials }> {
    return this.getEffectiveAccount(excludeIds, fetchFn)
  }

  /**
   * 一次额度读属于哪个账号，连同读它用的凭据。
   *
   * 写在这里而不是路由里，是因为它是线路形状的（同 step-code 的同名方法的理由）：
   * 快照要记在它描述的那一行名下，不会被一次轮转画到另一行名下。
   */
  async getQuotaReadTarget(fetchFn: typeof fetch = fetch): Promise<{
    accountId: string
    region: QoderRegion
    credentials: QoderCredentials
  }> {
    const data = await this.read()
    const target = data.accounts.find((account) => account.id === data.activeAccountId)
      ?? data.accounts.find((account) => account.isPrimary)
      ?? data.accounts[0]
    if (target === undefined) {
      // 空池：仍然问核心要一次凭据，好让抛出的错误与其它调用方收到的完全一致。
      await this.getFreshCredential(undefined, fetchFn)
      throw new Error(PROVIDER_NAME + ' 号池中没有账号。')
    }
    return {
      accountId: target.id,
      region: target.region,
      credentials: await this.getFreshCredential(target.id, fetchFn),
    }
  }
}

/** 状态应答里的号池切片。 */
export interface QoderPoolStatus {
  accounts: QoderAccountSummary[]
  activeAccountId?: string
  rotationStrategy: AccountRotationStrategy
  /** 本进程是否装上了号池。 */
  poolInstalled: boolean
}

/**
 * 读状态应答的号池切片。
 *
 * 读不出来的号池不能带倒整张卡：连接那一半仍然值得渲染，只是账号列表是空的。
 */
export async function qoderPoolStatus(
  pool: QoderAccountPool | undefined,
): Promise<QoderPoolStatus> {
  if (pool === undefined) {
    return { accounts: [], rotationStrategy: 'sequential', poolInstalled: false }
  }
  const data = await pool.read().catch(() => null)
  const accounts = await pool.listAccounts().catch(() => [])
  return {
    accounts,
    ...(data?.activeAccountId === undefined ? {} : { activeAccountId: data.activeAccountId }),
    rotationStrategy: data?.rotationStrategy ?? 'sequential',
    poolInstalled: true,
  }
}

/**
 * 把池状态装配成 \`QoderStatusDto\` 的号池切片（**唯一**装配它的地方，
 * 理由同 step-code 的 \`stepCodePoolStatusSlice\`）。
 */
export async function qoderPoolStatusSlice(
  pool: QoderAccountPool | undefined,
): Promise<Pick<QoderStatusDto, 'accounts' | 'rotationStrategy' | 'activeAccountId'>> {
  const status = await qoderPoolStatus(pool)
  return {
    accounts: status.accounts,
    rotationStrategy: status.rotationStrategy,
    ...(status.activeAccountId === undefined ? {} : { activeAccountId: status.activeAccountId }),
  }
}

export { QODER_CLI_CREDENTIAL_SOURCE }
