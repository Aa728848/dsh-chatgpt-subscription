/**
 * GLM（ZCode 账号）线路的号池。
 *
 * 走共享的 `AccountPoolCore`：存储、序列化、可用性、轮转、429 冷却都��它管，
 * 本文件只回答「GLM 这条线的凭据长什么样、谁能被刷新、配额怎么装配」。
 *
 * 三个与兄弟线路不同的地方，各有理由：
 *
 * 1. **两区可以同时在池里**。区域是凭据的属性（计划 §1、§3.3），一区铸造的 Key 被另一区拒绝，
 *    所以去重键里必须带区域，否则两个部署上同一个邮箱会被合并成一行，
 *    然后那一行的凭据被拿去打另一个区的主机——一次不会被任何本地检查发现的串区。
 * 2. **adopt 来的账号永不可刷新**。它只是本机 ZCode 客户端登录态的一份拷贝，
 *    上游才是权威；计划 §3.6 又没有 refresh 接口。`needsRefresh` 对它恒为 false，
 *    `refresh` 直接拒绝，而卡片上它标记为 `removable: false`——删掉它等于删掉用户的
 *    ZCode 客户端登录态，那不是本插件的文件。
 * 3. **配额装配调用共享的 `quotaWindow()` / `poolQuota()`**，不另写第三份。
 *    窗口长度取 `types.ts` 的 `QUOTA_WINDOW_MINUTES`（共享的窗口 DTO 里没有窗口 key，
 *    那是线路自己的桥），`label` 传空串（窗口名的规范在客户端字典里），
 *    `usedPercent` 为 null 的窗口由 `quotaWindow()` 丢弃（null 不是 0%，是「未说明」）。
 */

import path from 'node:path'
import {
  AccountPoolCore,
  normalizeRotationStrategy,
  type AccountPoolHooks,
  type PoolAccountShape,
  type PoolData,
} from '../common/account-pool.ts'
import { poolQuota, quotaWindow } from '../common/account-quota.ts'
import type { CredentialStore } from '../token-store.ts'
import { dshHomeDir } from '../common/home.ts'
import {
  GlmCodingPlanCredentialStore,
  credentialsFromAdopt,
  isAdoptedCredential,
  parseGlmCodingPlanCredentials as parseStoredCredentials,
  type GlmCodingPlanCredentials,
} from './token-store.ts'
import { exchangeForCodingPlanKey } from './exchange.ts'
import type { GlmAdoptedCredential } from './adopt.ts'
import { getCachedQuotaFor } from './client.ts'
import { PROVIDER_ID, PROVIDER_NAME, QUOTA_WINDOW_MINUTES } from './types.ts'
import type {
  GlmAccountSummaryDto,
  GlmQuotaSnapshotDto,
  GlmRegion,
} from '../../shared/glm-coding-plan-contracts.ts'
import type {
  AccountAuthStatus,
  AccountRotationStrategy,
  PoolAccountQuotaDto,
  PoolAccountQuotaWindowDto,
} from '../../shared/account-pool-contracts.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 一个池内账号行。凭据整个随行存放；其余是卡片渲染用的非机密事实。 */
export interface GlmCodingPlanPoolAccount extends PoolAccountShape<GlmCodingPlanCredentials> {
  /** 账号所属部署；由凭据决定，这里是给它做索引用。 */
  region: GlmRegion
  /** 浏览器登录 / adopt 捡回。 */
  origin: GlmCodingPlanCredentials['origin']
  /** 兑换链解析出的默认机构 id（非机密，用于诊断两区是否串号）。 */
  organizationId?: string
  /** 控制台侧的机构名 / 用户邮箱。 */
  accountName?: string
  email?: string
}

/** 号池切片：共享摘要 + 本线路的区域与来源。 */
export interface GlmCodingPlanAccountSummary extends GlmAccountSummaryDto {
  /** 这份快照是不是从本机 ZCode 客户端捡回来的（捡回来的永不可刷新，也不可删除）。 */
  adopted?: boolean
}

/** 本线路自己拥有的加密号池文件。与凭据文件分开：池可以有多行，凭据文件只有主账号一份。 */
export function glmCodingPlanPoolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'glm-coding-plan-pool.json')
}

/**
 * 身份：两个凭据什么时候是同一个上游账号。
 *
 * 组成是「区域 + 机构 + 上游 user_id」，三段都非机密，且都不随重新兑换而变：
 * `codingPlanKey` 每次兑换都可能换一把新的（同名 Key 被轮转时就换），拿它当键会让
 * 同一个账号在每次轮转后看起来都是新账号，于是号池无限增长。
 *
 * user_id 缺失时退回机构 + 邮箱，再退回机构 + apiKeyId（apiKeyId 是 `{id}.{secret}` 的 id 段，
 * 非机密且由本线路自己建的那把 Key 给出）。三段全空才返回 undefined：那时没有稳定的东西可键，
 * 核心会自己生成 `acc_<random>`，把这一行**新增**而不是与某个无关凭据合并。
 */
export function glmCodingPlanPoolIdentity(credentials: GlmCodingPlanCredentials): string | undefined {
  const plan = credentials.codingPlan
  const who = credentials.userId?.trim()
    ?? credentials.email?.trim()
    ?? (plan.apiKeyId === '' ? '' : plan.apiKeyId)
  if (plan.organizationId === '' && who === '') return undefined
  return plan.region + ':' + plan.organizationId + ':' + who
}

/** 账号没有自带可认名字时的默认别名。 */
function defaultAliasFor(credentials: GlmCodingPlanCredentials, position: number): string {
  const email = credentials.email?.trim()
  if (email !== undefined && email !== '') return email
  const label = credentials.codingPlan.accountName?.trim()
  const suffix = credentials.origin === 'adopt' ? '（来自 ZCode 客户端）' : '账号 ' + position
  return (label === undefined || label === '' ? PROVIDER_NAME + ' · ' + credentials.codingPlan.region : label) + ' · ' + suffix
}

/**
 * 从一次登录或 adopt 造出一行。
 *
 * `createAccount` 与 `legacyAccount` 都走它，所以「新登录造出的行」与「号池出现之前就存在的
 * 凭据投影出来的行」不可能漂移开。
 */
function projectAccount(input: {
  id: string
  alias: string
  credentials: GlmCodingPlanCredentials
  addedAt: number
  isPrimary: boolean
}): GlmCodingPlanPoolAccount {
  const credentials = input.credentials
  const account: GlmCodingPlanPoolAccount = {
    id: input.id,
    alias: input.alias,
    credentials,
    addedAt: input.addedAt,
    isPrimary: input.isPrimary,
    // 区域由凭据自己给出：请求发去哪由它决定，行上的副本只是索引。
    region: credentials.codingPlan.region,
    origin: credentials.origin,
  }
  if (credentials.codingPlan.organizationId !== '') {
    account.organizationId = credentials.codingPlan.organizationId
  }
  const accountName = credentials.codingPlan.accountName?.trim()
  if (accountName !== undefined && accountName !== '') account.accountName = accountName
  const email = credentials.email?.trim()
  if (email !== undefined && email !== '') account.email = email
  return account
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('GLM 号池账号字段无效：' + key)
  return value
}

/**
 * 校验并归一化整份号池文档。
 *
 * 凭据重新过一遍 token-store 的校验器，所以一行不可能装着一份 store 会拒绝写回的形状。
 * `region` / `origin` 必须显式恢复：行上的这两个字段是索引，丢了会让卡片把国区账号画成国际区。
 * 一行凭据读不通就**丢弃这一行**而不是整体报错——`read()` 会吞掉一次加载失败并回落，
 * 抛错等于让一行坏数据带走整个池。
 */
export function parseGlmCodingPlanPoolData(value: unknown): PoolData<GlmCodingPlanPoolAccount> {
  if (!isRecord(value)) throw new Error('GLM 号池载荷无效')
  const accounts: GlmCodingPlanPoolAccount[] = []
  for (const item of Array.isArray(value.accounts) ? value.accounts : []) {
    if (!isRecord(item) || typeof item.id !== 'string') continue
    let credentials: GlmCodingPlanCredentials
    try {
      credentials = parseStoredCredentials(item.credentials)
    } catch {
      continue
    }
    const account = projectAccount({
      id: item.id,
      alias: typeof item.alias === 'string' ? item.alias : defaultAliasFor(credentials, accounts.length + 1),
      credentials,
      addedAt: typeof item.addedAt === 'number' ? item.addedAt : Date.now(),
      isPrimary: item.isPrimary === true,
    })
    // 存下来的展示事实胜过从凭据重算的：那一行是从一份本插件已经读过身份的凭据写出来的。
    const organizationId = optionalString(item, 'organizationId')
    if (organizationId !== undefined) account.organizationId = organizationId
    const accountName = optionalString(item, 'accountName')
    if (accountName !== undefined) account.accountName = accountName
    const email = optionalString(item, 'email')
    if (email !== undefined) account.email = email
    if (typeof item.lastUsedAt === 'number') account.lastUsedAt = item.lastUsedAt
    if (typeof item.cooldownUntil === 'number') account.cooldownUntil = item.cooldownUntil
    if (typeof item.cooldownReason === 'string') account.cooldownReason = item.cooldownReason
    if (item.authStatus === 'expired' || item.authStatus === 'invalid') account.authStatus = item.authStatus
    if (typeof item.authFailedReason === 'string') account.authFailedReason = item.authFailedReason
    accounts.push(account)
  }
  const result: PoolData<GlmCodingPlanPoolAccount> = {
    version: 1,
    rotationStrategy: normalizeRotationStrategy(value.rotationStrategy),
    accounts,
  }
  if (typeof value.activeAccountId === 'string') result.activeAccountId = value.activeAccountId
  return result
}

/**
 * 配额快照 → 号池卡片渲染的形状。
 *
 * 每个窗口**按长度**而不是按一个字符串来标注：窗口名的规范在客户端字典里，host 没有资格
 * 下发展示文案，而知道自己长度的窗口可以让共享卡片直接从长度推出名字。
 * `usedPercent` 为 null 的窗口由 `quotaWindow()` 丢掉——null 不是 0%，是「未说明」，
 * 画成一条进度条等于谎报用量。
 */
export function glmCodingPlanPoolQuota(
  snapshot: GlmQuotaSnapshotDto | null | undefined,
): PoolAccountQuotaDto | undefined {
  if (snapshot === null || snapshot === undefined) return undefined
  const windows: Array<PoolAccountQuotaWindowDto | null> = snapshot.windows.map((window) => quotaWindow(
    '',
    window.usedPercent,
    {
      windowDurationMins: QUOTA_WINDOW_MINUTES[window.key],
      resetsAt: window.resetsAt,
    },
  ))
  return poolQuota(snapshot.fetchedAt, windows)
}

/**
 * 同一行上既有本插件管理的凭据又有 adopt 快照时，保留**受管的**那份。
 *
 * 判据由调用方给出（它看的是既有行）；这里只做形状上的选择：换掉 adopt 判别式三个字段，
 * 其余（账号身份事实）沿用新凭据，因为它们本来就来自同一次登录。
 */
function preferManagedCredentials(
  existing: GlmCodingPlanCredentials,
  incoming: GlmCodingPlanCredentials,
): GlmCodingPlanCredentials {
  const { adopted, source, sourcePath, ...rest } = incoming
  void adopted
  void source
  void sourcePath
  return rest
}
/** 本线路的号池。 */
export interface GlmCodingPlanAccountPoolOptions {
  /** 凭据存储：号池把主账号镜像进去，也在号池为空时用它投影出一个账号。 */
  store?: GlmCodingPlanCredentialStore
  /** 测试缝；生产按池文件路径构造平台后端。 */
  backend?: CredentialStore<PoolData<GlmCodingPlanPoolAccount>>
  /** 本池接受的账号数上限。 */
  maxAccounts?: number
  /** 用户在设置里钉住的账号；钉住的账号冷却时自动让位给轮转（核心自己处理）。 */
  preferAccountId?: () => string | null
}

/**
 * 对一份 adopt 快照的凭据提出的刷新。
 *
 * 它永远不会成功，而**必须**是一个显式错误而不是一次静默的空操作：调用方（核心的刷新路径）
 * 会把这个错误报给用户，而静默返回旧凭据会让一次注定失败的请求看起来像成功了。
 */
export class GlmAdoptedCredentialRefreshError extends Error {
  constructor() {
    super(
      '这个 GLM 账号是从本机 ZCode 客户端捡回来的登录态拷贝，不能刷新。'
      + '请在 ZCode 客户端重新登录后重试 adopt，或改用浏览器登录本线路。',
    )
    this.name = 'GlmAdoptedCredentialRefreshError'
  }
}

export class GlmCodingPlanAccountPool extends AccountPoolCore<
  GlmCodingPlanCredentials,
  GlmCodingPlanPoolAccount,
  GlmCodingPlanAccountSummary
> {
  // 显式声明而不是构造函数参数属性：Node 的类型擦除加载器不接受参数属性。
  private readonly store: GlmCodingPlanCredentialStore

  constructor(options: GlmCodingPlanAccountPoolOptions = {}) {
    const store = options.store ?? new GlmCodingPlanCredentialStore()
    const hooks: AccountPoolHooks<
      GlmCodingPlanCredentials,
      GlmCodingPlanPoolAccount,
      GlmCodingPlanAccountSummary
    > = {
      providerId: PROVIDER_ID,
      displayName: PROVIDER_NAME,
      poolFile: glmCodingPlanPoolPath(),
      keychainService: 'dsh-glm-coding-plan-pool',
      parsePoolData: parseGlmCodingPlanPoolData,
      dedupeKey: glmCodingPlanPoolIdentity,
      defaultAlias: defaultAliasFor,
      createAccount: ({ id, alias, credentials, addedAt, isPrimary, existing }) => projectAccount({
        id,
        alias,
        // 同一次登录与一次 adopt 落在同一行上时，**本插件自己登出来的**那份赢。
        // 否则合并之后留下 `adopted: true`，那会让这个账号永远不再刷新——
        // 而它明明有一份可以自己管理的凭据。判据是既有行是不是本插件管理的。
        credentials: existing === undefined || !isAdoptedCredential(existing.credentials)
          ? credentials
          : preferManagedCredentials(existing.credentials, credentials),
        addedAt,
        isPrimary,
      }),
      // Coding Plan Key 不声明失效时刻，唯一能给的是业务 JWT 的失效时刻（国区为 null）。
      // 它只作诊断展示；真正决定要不要重新兑换的是上游的拒绝，不是这个数。
      expiresAt: (credentials) => credentials.codingPlan.bizTokenExpiresAt ?? undefined,
      // 永不主动刷新：计划 §3.6 明确上游没有 refresh 接口，定时轮换凭据没有任何依据。
      // Coding Plan Key 失效由请求时的鉴权失败触发一次重兑换（见 refresh）。
      needsRefresh: () => false,
      refresh: async (credentials, fetchFn) => {
        // adopt 快照是别人文件的一份拷贝：刷新它等于用本插件去轮换 ZCode 客户端的登录态。
        if (isAdoptedCredential(credentials)) throw new GlmAdoptedCredentialRefreshError()
        const plan = await exchangeForCodingPlanKey(credentials.accessToken, credentials.codingPlan.region, { fetchFn })
        return { ...credentials, codingPlan: plan }
      },
      // 一次刷新失败**不**判死：这个账号没有自己会被轮换的令牌（access_token 只能重登），
      // 所以上游的一次网络故障或 5xx 不足以说明它坏了。真正的处置在适配器：收到 AUTH 就
      // markAuthFailed，那是上游自己说的。
      refreshFailureStatus: () => undefined,
      legacyAccount: async () => {
        const stored = await store.read()
        if (stored === null) return null
        return projectAccount({
          id: 'acc_primary',
          alias: defaultAliasFor(stored, 1),
          credentials: stored,
          addedAt: Date.now(),
          isPrimary: true,
        })
      },
      mirrorPrimary: async (credentials) => {
        if (credentials === null) {
          await store.delete()
          return
        }
        await store.write(credentials)
      },
      extendSummary: (account, base) => {
        const adopted = isAdoptedCredential(account.credentials)
        const email = account.email ?? account.credentials.email ?? undefined
        return {
          ...base,
          region: account.region,
          organizationId: account.organizationId ?? account.credentials.codingPlan.organizationId,
          ...(account.accountName === undefined ? {} : { accountName: account.accountName }),
          ...(email === undefined ? {} : { email }),
          // 卡片只在 adopt 账号上显示来源，让用户知道删不掉它。
          ...(adopted ? { adopted: true } : {}),
          // 捡回来的登录态不是本插件的文件：删除它等于删掉用户的 ZCode 客户端会话。
          removable: !adopted,
          // 这一行**自己**的最新快照。配额跟着账号走，所以查的是读数所属的那一行；
          // 缺省是「从没为这个账号读过」，那与「没花过额度」不是同一句话。
          ...(() => {
            const quota = glmCodingPlanPoolQuota(getCachedQuotaFor(account.id))
            return quota === undefined ? {} : { quota }
          })(),
        }
      },
      emptyMessage: '还没有登录 ' + PROVIDER_NAME + ' 账号。请在设置页点击登录，或先在 ZCode 客户端登录后使用 adopt。',
      allUnavailableMessage: (count, waitMinutes) =>
        '全部 ' + count + ' 个 ' + PROVIDER_NAME + ' 账号都处于配额限制或冷却中（429）。'
        + (waitMinutes === null ? '目前没有处于冷却中的账号。' : '最短预计在 ' + waitMinutes + ' 分钟后解除。'),
      allAuthFailedMessage: (count) =>
        '全部 ' + count + ' 个 ' + PROVIDER_NAME + ' 账号都需要重新登录。',
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      ...(options.maxAccounts === undefined ? {} : { maxAccounts: options.maxAccounts }),
      ...(options.preferAccountId === undefined ? {} : { preferAccountId: options.preferAccountId }),
    }
    super(hooks)
    this.store = store
  }

  /**
   * 把一份 adopt 快照收进号池。
   *
   * 快照本身已经跑过兑换链并验过活，所以这里只做形状转换；账号仍以
   * {@link glmCodingPlanPoolIdentity} 的身份落进池，重复 adopt 同一次登录只会更新同一行。
   */
  async addAdoptedCredential(adopted: GlmAdoptedCredential, alias?: string): Promise<GlmCodingPlanPoolAccount> {
    return this.addAccount(credentialsFromAdopt(adopted), alias)
  }

  /**
   * 移除一个账号（事务内）。
   *
   * adopt 来的账号被拒绝：它对应的是 ZCode 客户端自己的登录态文件，删掉它等于把用户
   * 从那个客户端里登出，而那不是本插件有权做的事。卡片上它是 `removable: false`。
   */
  protected override deleteAccountFromPool(data: PoolData<GlmCodingPlanPoolAccount>, accountId: string): void {
    const target = data.accounts.find((account) => account.id === accountId)
    if (target !== undefined && isAdoptedCredential(target.credentials)) {
      throw new Error(
        '该账号来自本机 ZCode 客户端（~/.zcode 的登录态），本插件只能读取，不能删除。'
        + '请在 ZCode 客户端退出登录，或改用浏览器登录本线路。',
      )
    }
    super.deleteAccountFromPool(data, accountId)
  }

  /**
   * 适配器取下一个账号用的入口。
   *
   * 核心在这里做轮转、冷却、可用性判断与（被拒绝的）刷新；本方法只多给适配器一件事：
   * 一次请求内换过账号时，把试过的账号排除掉。
   */
  async getEffectiveCredential(
    excludeIds?: ReadonlySet<string>,
    fetchFn: typeof fetch = fetch,
  ): Promise<{ account: GlmCodingPlanPoolAccount; credentials: GlmCodingPlanCredentials }> {
    return this.getEffectiveAccount(excludeIds, fetchFn)
  }

  /**
   * 一次配额读属于哪个账号，连同读它用的凭据。
   *
   * 写在这里而不是路由里，是因为它是线路形状的：路由需要的是凭据**和**这次读所属的账号，
   * 这样快照才能记在它描述的那一行上，不会被一次轮转画到另一行名下。
   * 选谁读是核心自己对「没有指名账号的调用方」的规则，这里照抄那三行，
   * 因为核心只通过 `getFreshCredential` 暴露凭据本身。
   */
  async getQuotaReadTarget(fetchFn: typeof fetch = fetch): Promise<{
    accountId: string
    credentials: GlmCodingPlanCredentials
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
    return { accountId: target.id, credentials: await this.getFreshCredential(target.id, fetchFn) }
  }

  /** 本池镜像主账号进去的那份凭据存储。 */
  mirrorStore(): GlmCodingPlanCredentialStore {
    return this.store
  }
}

/** 状态应答里的号池切片。 */
export interface GlmCodingPlanPoolStatus {
  accounts: GlmCodingPlanAccountSummary[]
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
export async function glmCodingPlanPoolStatus(
  pool: GlmCodingPlanAccountPool | undefined,
): Promise<GlmCodingPlanPoolStatus> {
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
