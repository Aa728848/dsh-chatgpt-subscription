/**
 * Step Code 线路的号池：共享 `AccountPoolCore` 之上的薄封装。
 *
 * 存储、序列化、可用性、轮转、429 冷却都由 `src/host/common/account-pool.ts` 管；
 * 本文件只回答「Step 这条线的凭据长什么样、谁能被刷新、身份怎么算、卡片怎么装配」。
 *
 * 四个与兄弟线路不同的地方，各有理由：
 *
 * 1. **两区可以同时在池里。** 区域是凭据的属性（计划 §1），一区铸造的 Key 被另一区拒绝，
 *    所以去重键里必须带区域：否则同一个账号名在两个部署上会被合并成一行，
 *    然后那一行的凭据被拿去打另一个区的主机——一次不会被任何本地检查发现的串区。
 * 2. **凭据永不过期、永不刷新。** `needsRefresh` 恒为 false，`refresh` **一定抛错**；
 *    `expiresAt` 恒为 `STATIC_EXPIRES_AT`（Number.MAX_SAFE_INTEGER）且刻意**不**实现
 *    `expiresAt` 钩子——把一个「永不过期」写成卡片上的 expiresAt 会让人以为它会过期。
 *    适配器收到 401 时 markAuthFailed，那才是上游自己说的失效。
 * 3. **adopt 快照可删。** 与 codex/claude/glm 不同：本插件只读 `~/.stepcode/auth.json`，
 *    从不写它；删掉池里的一行只是删掉本插件自己的加密记录，用户的 stepcode 会话不动。
 *    所以这里没有 glm 那条「adopt 账号不可删」的规则。
 * 4. **额度装配复用共享的 `quotaWindow()` / `poolQuota()`**，不另写第三份。
 *    窗口长度取 types.ts 的 QUOTA_WINDOW_MINUTES（共享窗口 DTO 里没有窗口 key，
 *    那是线路自己的桥），`label` 传空串（窗口名的规范在客户端字典里），
 *    `usedPercent` 为 null 的窗口由 `quotaWindow()` 丢弃（null 不是 0%，是「未说明」）。
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
import {
  stepCodeRegionOf as regionOf,
  type StepCodeAccountSummaryDto,
  type StepCodeProfile,
  type StepCodeQuotaSnapshotDto,
  type StepCodeRegion,
  type StepCodeStatusDto,
} from '../../shared/step-code-contracts.ts'
import { getCachedStepQuotaFor } from './client.ts'
import {
  PROVIDER_ID,
  PROVIDER_NAME,
  QUOTA_WINDOW_MINUTES,
  STATIC_EXPIRES_AT,
  STATIC_REFRESH_TOKEN,
  UID_MAX_LENGTH,
  UID_PATTERN,
  normalizeProfile,
} from './types.ts'
import {
  STEP_CODE_CREDENTIAL_NOT_REFRESHABLE,
  type StepCodeStoredCredential,
} from './oauth.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 号池里存的一份凭据。
 *
 * 它是 `oauth.ts` 的 `StepCodeStoredCredential` 加两个**来源**标记：
 *
 * - `adopted`：这一份是本机 stepcode 登录态的拷贝（卡片的来源标记）。
 * - `sourcePath`：读到它的确切文件，卡片可以显示给用户。
 *
 * 凭据本身（access / refresh / expires / profile / uid）与 OAuth 模块装配的完全一致，
 * 因为它们**就是**同一个东西：Step 的 api_key 不分来源，池里也不该分。
 */
export interface StepCodeCredentials extends StepCodeStoredCredential {
  adopted?: true
  sourcePath?: string
}

/** 一个池内账号行。凭据整个随行存放；其余是卡片渲染用的非机密事实。 */
export interface StepCodePoolAccount extends PoolAccountShape<StepCodeCredentials> {
  /** 账号所属区域；由凭据的 profile 决定，这里是给它做索引用。 */
  region: StepCodeRegion
  /** 这份凭据的来源（浏览器授权 / 手动粘贴 / adopt），供卡片显示。 */
  source: StepCodeCredentialSource
  /** 控制台侧的账号显示名（非机密）。 */
  accountName?: string
}

/** 凭据来源，逐字取自 types.ts 的 PROFILE_HOSTS[].credentialSource 之外的用户动作。 */
export type StepCodeCredentialSource = 'browser' | 'apiKey' | 'adopt'

/** 号池切片：共享摘要 + 本线路的 profile 与区域。 */
export type StepCodeAccountSummary = StepCodeAccountSummaryDto

/** 本线路自己的加密号池文件。与凭据文件分开：池可以有多行，凭据文件只有主账号一份。 */
export function stepCodePoolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'step-code-pool.json')
}

/** keychain / Secret Service 的服务名。与其它线路各用各的，互不相干。 */
export const STEP_CODE_POOL_KEYCHAIN_SERVICE = 'dsh-step-code-pool'

/**
 * 身份：两个凭据什么时候是同一个上游账号。
 *
 * 组成是「区域 + uid」，两段都非机密，也都不随重新登录而变（Step 的 api_key 每次登录
 * 都可能换一把新的，拿 api_key 当键会让同一个账号每次登录都长成新账号，号池无限增长）。
 *
 * 没有 uid 时退回「区域 + api_key 的 SHA-256 前 16 字节」：那是**指纹**，不是身份，
 * 但它至少保证同一把 Key 落到同一行；两段全空才返回 undefined，那时核心自己生成
 * `acc_<random>`，把这一行**新增**而不是与某个无关凭据合并。
 */
export function stepCodePoolIdentity(credentials: StepCodeCredentials): string | undefined {
  const uid = (credentials.uid ?? '').trim()
  if (uid !== '') return credentials.profile + ':' + uid
  const key = credentials.access.trim()
  if (key === '') return undefined
  return credentials.profile + ':key:' + createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** 账号没有自带可认名字时的默认别名。 */
function defaultAliasFor(credentials: StepCodeCredentials, position: number): string {
  const uid = (credentials.uid ?? '').trim()
  const suffix = credentials.adopted === true ? '（来自 stepcode 客户端）' : '账号 ' + position
  return (uid === '' ? PROVIDER_NAME + ' · ' + regionOf(credentials.profile) : uid) + ' · ' + suffix
}

/**
 * 从一次登录、一次粘贴或一次 adopt 造出一行。
 *
 * `createAccount` 与 `legacyAccount` 都走它，所以「新登录造出的行」与「号池出现之前就存在的
 * 凭据投影出来的行」不可能漂移开。
 */
function projectAccount(input: {
  id: string
  alias: string
  credentials: StepCodeCredentials
  addedAt: number
  isPrimary: boolean
}): StepCodePoolAccount {
  const credentials = input.credentials
  return {
    id: input.id,
    alias: input.alias,
    credentials,
    addedAt: input.addedAt,
    isPrimary: input.isPrimary,
    // 区域由凭据自己给出：请求发去哪由它决定，行上的副本只是索引。
    region: regionOf(credentials.profile),
    source: credentials.adopted === true ? 'adopt' : 'browser',
  }
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(PROVIDER_NAME + ' 号池账号字段无效：' + key)
  return value
}

/**
 * 校验并归一化一份凭据。
 *
 * 规则刻意收得比 OAuth 模块更紧（`access` 必须非空、`expires` 必须等于静态值），
 * 因为池里的一行是**要被直接发去上游**的：一份半截的凭据会让号池把一个必然 401 的请求
 * 当成可路由的账号打出去。
 */
export function parseStepCodeCredentials(value: unknown): StepCodeCredentials {
  if (!isRecord(value)) throw new Error(PROVIDER_NAME + ' 号池凭据无效')
  const access = typeof value.access === 'string' ? value.access.trim() : ''
  if (access === '') throw new Error(PROVIDER_NAME + ' 号池凭据缺少 access')
  const profile = normalizeProfile(value.profile)
  if (profile === undefined) throw new Error(PROVIDER_NAME + ' 号池凭据的 profile 无效')
  const uidRaw = typeof value.uid === 'string' ? value.uid.trim() : ''
  const uid = uidRaw.length > UID_MAX_LENGTH || !UID_PATTERN.test(uidRaw) ? '' : uidRaw
  return {
    type: 'oauth',
    access,
    refresh: STATIC_REFRESH_TOKEN,
    expires: STATIC_EXPIRES_AT,
    profile,
    ...(uid === '' ? {} : { uid }),
    ...(value.adopted === true ? { adopted: true as const } : {}),
    ...(typeof value.sourcePath === 'string' && value.sourcePath !== ''
      ? { sourcePath: value.sourcePath }
      : {}),
  }
}

/**
 * 校验并归一化整份号池文档。
 *
 * 凭据重新过一遍 `parseStepCodeCredentials`，所以一行不可能装着一份 store 会拒绝写回的形状。
 * `region` / `source` 必须显式恢复：行上的这两个字段是索引，丢了会让卡片把国区账号画成国际区。
 * 一行凭据读不通就**丢弃这一行**而不是整体报错——`read()` 会吞掉一次加载失败并回落，
 * 抛错等于让一行坏数据带走整个池。
 */
export function parseStepCodePoolData(value: unknown): PoolData<StepCodePoolAccount> {
  if (!isRecord(value)) throw new Error(PROVIDER_NAME + ' 号池载荷无效')
  const accounts: StepCodePoolAccount[] = []
  for (const item of Array.isArray(value.accounts) ? value.accounts : []) {
    if (!isRecord(item) || typeof item.id !== 'string') continue
    let credentials: StepCodeCredentials
    try {
      credentials = parseStepCodeCredentials(item.credentials)
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
    const accountName = optionalString(item, 'accountName')
    if (accountName !== undefined && accountName !== '') account.accountName = accountName
    if (typeof item.lastUsedAt === 'number') account.lastUsedAt = item.lastUsedAt
    if (typeof item.cooldownUntil === 'number') account.cooldownUntil = item.cooldownUntil
    if (typeof item.cooldownReason === 'string') account.cooldownReason = item.cooldownReason
    if (item.authStatus === 'expired' || item.authStatus === 'invalid') {
      account.authStatus = item.authStatus
    }
    if (typeof item.authFailedReason === 'string') account.authFailedReason = item.authFailedReason
    accounts.push(account)
  }
  const result: PoolData<StepCodePoolAccount> = {
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
 * 每个窗口**按长度**而不是按一个字符串来标注：窗口名的规范在客户端字典里，host 没有
 * 资格下发展示文案，而知道自己长度的窗口可以让共享卡片直接从长度推出名字。
 * `usedPercent` 为 null 的窗口由 `quotaWindow()` 丢掉——null 不是 0%，是「未说明」，
 * 画成一条进度条等于谎报用量。
 */
export function stepCodePoolQuota(
  snapshot: StepCodeQuotaSnapshotDto | null | undefined,
): PoolAccountQuotaDto | undefined {
  if (snapshot === null || snapshot === undefined) return undefined
  const windows = snapshot.windows.map((window) => quotaWindow(
    '',
    window.usedPercent,
    {
      windowDurationMins: QUOTA_WINDOW_MINUTES[window.key],
      resetsAt: window.resetsAt,
    },
  ))
  return poolQuota(snapshot.fetchedAt, windows)
}

// ---------------------------------------------------------------------------
// 号池
// ---------------------------------------------------------------------------

/** 本线路号池的构造选项。全部可选：生产按池文件路径构造平台后端。 */
export interface StepCodeAccountPoolOptions {
  /** 测试缝；生产按池文件路径构造平台后端（DPAPI / Keychain / SecretService）。 */
  backend?: CredentialStore<PoolData<StepCodePoolAccount>>
  /** 本池接受的账号数上限。 */
  maxAccounts?: number
  /** 用户在设置里钉住的账号；钉住的账号冷却时自动让位给轮转（核心自己处理）。 */
  preferAccountId?: () => string | null
}

/**
 * 对一份凭据提出的刷新。
 *
 * 它**永远不会成功**，而**必须**是一个显式错误而不是一次静默的空操作：核心的刷新路径
 * 会把这个错误报给用户，而静默返回旧凭据会让一次注定失败的请求看起来像成功了。
 * 逐字照抄官方 refreshStepOAuth（index.ts:316-321）的拒绝语义。
 */
export class StepCodeCredentialRefreshError extends Error {
  constructor() {
    super(STEP_CODE_CREDENTIAL_NOT_REFRESHABLE)
    this.name = 'StepCodeCredentialRefreshError'
  }
}

/** 本线路的号池。凭据类型是本线路自己的，静态凭据不刷新。 */
export class StepCodeAccountPool extends AccountPoolCore<
  StepCodeCredentials,
  StepCodePoolAccount,
  StepCodeAccountSummary
> {
  constructor(options: StepCodeAccountPoolOptions = {}) {
    const hooks: AccountPoolHooks<
      StepCodeCredentials,
      StepCodePoolAccount,
      StepCodeAccountSummary
    > = {
      providerId: PROVIDER_ID,
      displayName: PROVIDER_NAME,
      poolFile: stepCodePoolPath(),
      keychainService: STEP_CODE_POOL_KEYCHAIN_SERVICE,
      parsePoolData: parseStepCodePoolData,
      dedupeKey: stepCodePoolIdentity,
      defaultAlias: defaultAliasFor,
      createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => projectAccount({
        id,
        alias,
        credentials,
        addedAt,
        isPrimary,
      }),
      // **刻意不实现 expiresAt**：Step 的 api_key 永不过期，而 expires = MAX_SAFE_INTEGER
      // 在卡片上会长成一条「expiresAt: 9007199254740991」，让人以为它会过期。
      // 「上游什么时候不再认这把 Key」只有上游知道，适配器收到 401 时 markAuthFailed 才是答案。
      //
      // **不实现 needsRefresh**：没有 expiresAt 时核心本来就不会主动刷新，而显式写成
      // `() => false` 会在将来有人补上 expiresAt 之后悄悄变成一句谎话。
      //
      // **refresh 一定抛错**：任何「续期」路径在这里都得到一句明确的拒绝，
      // 而不是一次拿哨兵去换新凭据的徒劳请求。
      refresh: async () => { throw new StepCodeCredentialRefreshError() },
      // 一次失败**不**判死：这个账号没有自己会被轮换的令牌（api_key 只能重新授权），
      // 所以上游的一次网络故障或 5xx 不足以说明它坏了。真正的处置在适配器。
      refreshFailureStatus: () => undefined,
      extendSummary: (account, base) => {
        const uid = account.credentials.uid
        return {
          ...base,
          profile: account.credentials.profile,
          region: account.region,
          ...(uid === undefined ? {} : { accountName: uid }),
          ...(account.accountName === undefined ? {} : { accountName: account.accountName }),
          ...(() => {
            const quota = stepCodePoolQuota(getCachedStepQuotaFor(account.id))
            return quota === undefined ? {} : { quota }
          })(),
        }
      },
      emptyMessage: '还没有登录 ' + PROVIDER_NAME
        + ' 账号。请在设置页点击登录、在 stepcode 客户端登录后使用导入，或粘贴一个 Platform API Key。',
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
   * 快照已经跑过 `adopt.ts` 的解析（形状、占位符、profile 都已确认），这里只补来源标记；
   * 账号仍以 `stepCodePoolIdentity` 的身份落进池，重复 adopt 同一次登录只会更新同一行。
   */
  async addAdoptedCredential(
    adopted: { readonly credentials: StepCodeStoredCredential; readonly sourcePath?: string },
    alias?: string,
  ): Promise<StepCodePoolAccount> {
    const credentials: StepCodeCredentials = {
      ...adopted.credentials,
      adopted: true,
      ...(adopted.sourcePath === undefined ? {} : { sourcePath: adopted.sourcePath }),
    }
    return this.addAccount(credentials, alias)
  }

  /**
   * 手动粘贴 Platform API Key 的入口（形状与登录完全一致，见 `stepCodeCredentialFromApiKey`）。
   */
  async addApiKeyCredential(
    credentials: StepCodeStoredCredential,
    alias?: string,
  ): Promise<StepCodePoolAccount> {
    return this.addAccount(credentials, alias)
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
  ): Promise<{ account: StepCodePoolAccount; credentials: StepCodeCredentials }> {
    return this.getEffectiveAccount(excludeIds, fetchFn)
  }

  /**
   * 一次额度读属于哪个账号，连同读它用的凭据。
   *
   * 写在这里而不是路由里，是因为它是线路形状的：路由需要的是凭据**和**这次读所属的账号，
   * 这样快照才能记在它描述的那一行上，不会被一次轮转画到另一行名下。
   * 选谁读是核心自己对「没有指名账号的调用方」的规则，这里照抄那三行，
   * 因为核心只通过 `getFreshCredential` 暴露凭据本身。
   */
  async getQuotaReadTarget(fetchFn: typeof fetch = fetch): Promise<{
    accountId: string
    profile: StepCodeProfile
    region: StepCodeRegion
    credentials: StepCodeCredentials
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
      profile: target.credentials.profile,
      region: target.region,
      credentials: await this.getFreshCredential(target.id, fetchFn),
    }
  }
}

/** 状态应答里的号池切片。 */
export interface StepCodePoolStatus {
  accounts: StepCodeAccountSummary[]
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
export async function stepCodePoolStatus(
  pool: StepCodeAccountPool | undefined,
): Promise<StepCodePoolStatus> {
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
 * 把池状态装配成 `StepCodeStatusDto` 的号池切片。
 *
 * 这是**唯一**装配号池切片的地方（照抄 glm 的 `glmCodingPlanPoolStatus` + 同族先例）：
 * 一旦卡片、hub 汇总与适配器各装配一次，三处就会在「activeAccountId 缺失时给不给"
 * activeAccountId: undefined"」这种细节上漂移。
 *
 * 两个刻意的省略：
 *
 * - `activeAccountId` 只在**真的读到**时下发（共享 DTO 的 enabledModelIds 语义同源：
 *   缺省 = 没有钉住，而不是「钉住了 undefined」）。
 * - 读不出来的池给空列表而不是抛错：连接那一半仍然值得渲染。
 */
export async function stepCodePoolStatusSlice(
  pool: StepCodeAccountPool | undefined,
): Promise<Pick<StepCodeStatusDto, 'accounts' | 'rotationStrategy' | 'activeAccountId'>> {
  const status = await stepCodePoolStatus(pool)
  return {
    accounts: status.accounts,
    rotationStrategy: status.rotationStrategy,
    ...(status.activeAccountId === undefined ? {} : { activeAccountId: status.activeAccountId }),
  }
}