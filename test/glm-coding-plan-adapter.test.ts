import { describe, expect, it, beforeEach } from 'vitest'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'
import {
  GLM_CODING_PLAN_RETRY_POLICY_CONFIG,
  GLM_POOL_COOLDOWN_MS,
  buildGlmRequestPlan,
  glmCooldownDecision,
  readGlmResetAt,
} from '../src/host/glm-coding-plan/adapter.ts'
import { resolveGlmModel, undeclaredGlmModelEntry, type GlmModelEntry } from '../src/host/glm-coding-plan/model-catalog.ts'
import { classifyGlmOpenAiFailure } from '../src/host/glm-coding-plan/mapper-openai.ts'
import { glmAnthropicHeaders } from '../src/host/glm-coding-plan/mapper-anthropic.ts'
import {
  GlmAdoptedCredentialRefreshError,
  GlmCodingPlanAccountPool,
  glmCodingPlanPoolQuota,
} from '../src/host/glm-coding-plan/account-pool.ts'
import {
  credentialsFromAdopt,
  credentialsFromCliLogin,
  isAdoptedCredential,
  type GlmCodingPlanCredentials,
} from '../src/host/glm-coding-plan/token-store.ts'
import { QUOTA_WINDOW_MINUTES } from '../src/host/glm-coding-plan/types.ts'
import { isAdoptedZcodeCredential, ZCODE_CREDENTIAL_SOURCE } from '../src/host/glm-coding-plan/adopt.ts'
import { resetWebLogins } from '../src/host/glm-coding-plan/oauth.ts'
import { resetInFlightBizTokenFetches } from '../src/host/glm-coding-plan/biz-token-cache.ts'
import { clearCachedQuota } from '../src/host/glm-coding-plan/client.ts'
import type { GlmCliCredentials } from '../src/host/glm-coding-plan/oauth.ts'
import type { GlmCodingPlanKey } from '../src/host/glm-coding-plan/exchange.ts'
import type { GlmQuotaSnapshotDto } from '../src/shared/glm-coding-plan-contracts.ts'
import type { CredentialStore } from '../src/host/token-store.ts'

function options(model: string, extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    model,
    messages: [{ role: 'user', content: '你好' }],
    ...extra,
  } as GenerateOptions
}

function codingPlan(region: 'cn' | 'intl' = 'intl'): GlmCodingPlanKey {
  return {
    region,
    codingPlanKey: 'ak_1.sk_1',
    apiKeyId: 'ak_1',
    secretKey: 'sk_1',
    keyName: 'dsh-glm-coding-plan',
    keyCreated: false,
    organizationId: 'org_1',
    projectId: 'proj_1',
    accountName: '测试机构',
    bizToken: region === 'intl' ? 'biz.jwt' : null,
    bizTokenExpiresAt: region === 'intl' ? Date.now() + 3_600_000 : null,
    planLevel: 'pro',
  }
}

function browserCredentials(region: 'cn' | 'intl' = 'intl'): GlmCodingPlanCredentials {
  const session: GlmCliCredentials = {
    region,
    accessToken: 'access-token',
    refreshToken: null,
    zcodeToken: null,
    userId: 'user_1',
    email: 'a@example.com',
    displayName: 'A',
    hasAvatar: false,
    authenticatedAt: 1_700_000_000_000,
  }
  return credentialsFromCliLogin(session, codingPlan(region))
}

function adoptedCredentials(): GlmCodingPlanCredentials {
  return credentialsFromAdopt({
    adopted: true,
    source: ZCODE_CREDENTIAL_SOURCE,
    sourcePath: '/tmp/.zcode/credentials.json',
    region: 'intl',
    accessToken: 'access-token',
    refreshToken: null,
    zcodeJwtToken: null,
    userId: 'user_1',
    email: 'a@example.com',
    displayName: 'A',
    hasAvatar: false,
    authenticatedAt: 1_700_000_000_000,
    codingPlan: codingPlan(),
  })
}

/** 内存号池后端：平台后端在无 keyring 的 CI 上不可用。 */
function memoryPoolBackend<T>(): CredentialStore<T> {
  let data: T | null = null
  return {
    async load() { return data === null ? null : JSON.parse(JSON.stringify(data)) as T },
    async save(next: T) { data = JSON.parse(JSON.stringify(next)) as T },
    async clear() { data = null },
  }
}

describe('GLM 适配器：按 wire 路由两个 mapper', () => {
  it('anthropic 面打 Messages 线，并发双认证头', () => {
    const entry = resolveGlmModel('GLM-5.3')
    const plan = buildGlmRequestPlan(options('GLM-5.3'), { region: 'intl', entry })
    expect(plan.wire).toBe('anthropic')
    expect(plan.url).toBe('https://api.z.ai/api/anthropic/v1/messages')
    // 认证头由 mapper 构造：双头且同值（官方注释：兼容网关同时读两者）。
    const headers = glmAnthropicHeaders('ak_1.sk_1', plan.headers)
    expect(headers['x-api-key']).toBe('ak_1.sk_1')
    expect(headers.authorization).toBe('Bearer ak_1.sk_1')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(plan.body.stream).toBe(true)
  })

  it('国区打国区的模型面主机，两区不串', () => {
    const entry = resolveGlmModel('GLM-5.3')
    const plan = buildGlmRequestPlan(options('GLM-5.3'), { region: 'cn', entry })
    expect(plan.url).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages')
  })

  it('openai 面打 Coding Plan 专用前缀，且只发 Bearer', () => {
    // 随包目录四行全是 anthropic（计划 §6.1 的注记），所以这里用一行自造能力行。
    const entry: GlmModelEntry = {
      ...undeclaredGlmModelEntry('glm-openai-row'),
      wire: 'openai',
      reasoningEfforts: ['low', 'high', 'max'],
      supportsImages: true,
      defaultMaxTokens: 32_768,
    }
    const plan = buildGlmRequestPlan(options('glm-openai-row'), { region: 'intl', entry })
    expect(plan.wire).toBe('openai')
    expect(plan.url).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions')
    expect(plan.url).not.toContain('/api/paas/v4')
    const headers: Record<string, string> = { ...plan.headers, authorization: 'Bearer ak_1.sk_1' }
    expect(headers['x-api-key']).toBeUndefined()
  })

  it('目录没有转录过的模型被拒绝，而不是替它挑一个面', () => {
    const entry = resolveGlmModel('glm-brand-new')
    expect(entry.wire).toBeNull()
    expect(() => buildGlmRequestPlan(options('glm-brand-new'), { region: 'intl', entry }))
      .toThrow(/模型目录/)
  })
})

describe('GLM 适配器：ladder 由装配层传入', () => {
  it('三档梯子把 minimal 收敛成 low（不是未识别档的中档）', () => {
    const entry = resolveGlmModel('GLM-5.3')
    const plan = buildGlmRequestPlan(
      options('GLM-5.3', { reasoningEffort: 'minimal' as never }),
      { region: 'intl', entry },
    )
    expect(plan.body.reasoning_effort).toBe('low')
    // 恒常发的一半：上游把 thinking.type=disabled 当错误拒绝，所以不发关闭值。
    expect(plan.body.thinking).toEqual({ type: 'enabled' })
  })

  it('两档模型用两档梯子收敛', () => {
    const entry = resolveGlmModel('GLM-5.2')
    expect([...entry.reasoningEfforts]).toEqual(['high', 'max'])
    const plan = buildGlmRequestPlan(
      options('GLM-5.2', { reasoningEffort: 'low' as never }),
      { region: 'intl', entry },
    )
    expect(plan.body.reasoning_effort).toBe('high')
  })

  it('空梯子 = 该模型完全不发思考控制（有意语义）', () => {
    const entry = resolveGlmModel('GLM-5-Turbo')
    expect([...entry.reasoningEfforts]).toEqual([])
    const plan = buildGlmRequestPlan(
      options('GLM-5-Turbo', { reasoningEffort: 'high' as never }),
      { region: 'intl', entry },
    )
    expect(plan.body.reasoning_effort).toBeUndefined()
    expect(plan.body.thinking).toBeUndefined()
  })

  it('openai 面同样吃装配层传入的梯子', () => {
    const entry: GlmModelEntry = {
      ...undeclaredGlmModelEntry('glm-openai-row'),
      wire: 'openai',
      reasoningEfforts: ['low', 'high', 'max'],
    }
    const plan = buildGlmRequestPlan(
      options('glm-openai-row', { reasoningEffort: 'medium' as never }),
      { region: 'intl', entry },
    )
    expect(plan.body.reasoning_effort).toBe('high')
  })
})

describe('GLM 适配器：冷却键看 429，而不是只看 code', () => {
  it('额度用尽的 429（code 1308）判成 QUOTA，但仍然冷却该账号', () => {
    const failure = classifyGlmOpenAiFailure(429, JSON.stringify({ code: 1308, message: '用量窗口已用尽' }))
    expect(failure.code).toBe('QUOTA')
    // 这就是本条规则的全部要点：只看 code 的话这里永远不会冷却，
    // 号池会一遍又一遍把同一个已用尽账号派出去。
    const decision = glmCooldownDecision({ status: 429, body: { code: 1308 } })
    expect(decision.cooldown).toBe(true)
    expect(decision.durationMs).toBe(GLM_POOL_COOLDOWN_MS)
  })

  it('正文给了重置时刻就用它，而不是默认 5 分钟', () => {
    const resetsAt = Date.now() + 45 * 60_000
    const decision = glmCooldownDecision({
      status: 429,
      body: { code: 1310, data: { nextResetTime: resetsAt } },
    })
    expect(decision.cooldown).toBe(true)
    expect(decision.durationMs).toBeGreaterThanOrEqual(45 * 60_000 - 2_000)
    expect(decision.durationMs).toBeLessThanOrEqual(45 * 60_000)
    expect(decision.reason).toContain('重置')
  })

  it('Retry-After 在没有重置时刻时接管', () => {
    const headers = new Headers({ 'retry-after': '120' })
    const decision = glmCooldownDecision({ status: 429, headers, body: { code: 1302 } })
    expect(decision.cooldown).toBe(true)
    expect(decision.durationMs).toBe(120_000)
  })

  it('非 429 不冷却', () => {
    expect(glmCooldownDecision({ status: 500 }).cooldown).toBe(false)
    expect(glmCooldownDecision({ status: 401 }).cooldown).toBe(false)
  })

  it('重置时刻的字段名认不出时返回 undefined，由调用方回落', () => {
    expect(readGlmResetAt({ code: 1308 })).toBeUndefined()
    expect(readGlmResetAt({ resetTime: 1_800_000_000 })).toBe(1_800_000_000_000)
  })
})

describe('GLM 适配器：重试策略', () => {
  it('可重试集合与兄弟线路一致，额度类不在其中', () => {
    expect(GLM_CODING_PLAN_RETRY_POLICY_CONFIG.retryableCodes)
      .toEqual(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
    expect(GLM_CODING_PLAN_RETRY_POLICY_CONFIG.retryableCodes).not.toContain('QUOTA')
    expect(GLM_CODING_PLAN_RETRY_POLICY_CONFIG.retryableCodes).not.toContain('AUTH')
  })
})

describe('GLM 号池：adopt 账号永不可刷新', () => {
  beforeEach(() => {
    resetWebLogins()
    resetInFlightBizTokenFetches()
    clearCachedQuota()
  })

  it('落盘的 adopt 凭据带着 adopt.ts 自己的判别式', () => {
    const adopted = adoptedCredentials()
    expect(isAdoptedCredential(adopted)).toBe(true)
    // 用 adopt.ts 自己的判别函数判同一份值：两条判断必须是同一个答案。
    expect(isAdoptedZcodeCredential(adopted)).toBe(true)
    expect(adopted.source).toBe(ZCODE_CREDENTIAL_SOURCE)
    expect(adopted.sourcePath).toBe('/tmp/.zcode/credentials.json')
  })

  it('浏览器登录的凭据不带 adopt 判别式', () => {
    const browser = browserCredentials()
    expect(isAdoptedCredential(browser)).toBe(false)
    expect(isAdoptedZcodeCredential(browser)).toBe(false)
  })

  it('强制续期 adopt 凭据被拒绝，浏览器登录的可以重跑兑换链', async () => {
    const pool = new GlmCodingPlanAccountPool({ backend: memoryPoolBackend() })
    const adopted = adoptedCredentials()
    await pool.addAccount(adopted)
    const rows = await pool.listAccounts()
    expect(rows[0]?.adopted).toBe(true)
    expect(rows[0]?.removable).toBe(false)
    const stored = (await pool.read()).accounts[0]!.credentials
    await expect(pool.renewCredential(rows[0]!.id)).rejects.toBeInstanceOf(GlmAdoptedCredentialRefreshError)
    // 判别式在**写回与读回之后**仍在：这是「永不可刷新」跨重启成立的全部原因。
    expect(isAdoptedZcodeCredential(stored)).toBe(true)

    const browserPool = new GlmCodingPlanAccountPool({ backend: memoryPoolBackend() })
    await browserPool.addAccount(browserCredentials())
    const browserRow = (await browserPool.listAccounts())[0]!
    expect(browserRow.adopted).toBeUndefined()
    expect(browserRow.removable).toBe(true)
  })

  it('adopt 账号不可删除，浏览器登录的可以', async () => {
    const pool = new GlmCodingPlanAccountPool({ backend: memoryPoolBackend() })
    const adopted = await pool.addAdoptedCredential(
      {
        adopted: true,
        source: ZCODE_CREDENTIAL_SOURCE,
        sourcePath: '/tmp/.zcode/credentials.json',
        region: 'intl',
        accessToken: 'access-token',
        refreshToken: null,
        zcodeJwtToken: null,
        userId: 'user_1',
        email: 'a@example.com',
        displayName: 'A',
        hasAvatar: false,
        authenticatedAt: 1_700_000_000_000,
        codingPlan: codingPlan(),
      },
    )
    await expect(pool.deleteAccount(adopted.id)).rejects.toThrow(/ZCode 客户端/)

    const browserPool = new GlmCodingPlanAccountPool({ backend: memoryPoolBackend() })
    const browser = await browserPool.addAccount(browserCredentials())
    await browserPool.deleteAccount(browser.id)
    expect(await browserPool.listAccounts()).toEqual([])
  })

  it('两区账号同时在池里，去重键不把它们合并', async () => {
    const pool = new GlmCodingPlanAccountPool({ backend: memoryPoolBackend() })
    await pool.addAccount(browserCredentials('cn'))
    await pool.addAccount(browserCredentials('intl'))
    const rows = await pool.listAccounts()
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.region).sort()).toEqual(['cn', 'intl'])
  })
})

describe('GLM 号池：配额装配调用共享 helper', () => {
  it('窗口名传空串、长度来自 types.ts 的表、null 百分比被丢弃', () => {
    const snapshot: GlmQuotaSnapshotDto = {
      planName: 'Pro',
      planLevel: 'pro',
      windows: [
        { key: 'five-hour', usedPercent: 25, resetsAt: 1_800_000_000_000 },
        { key: 'weekly', usedPercent: null, resetsAt: null },
        { key: 'monthly', usedPercent: 90, resetsAt: null },
      ],
      renewsAt: null,
      fetchedAt: 1_700_000_000_000,
      sources: ['/api/monitor/usage/quota/limit'],
    }
    const quota = glmCodingPlanPoolQuota(snapshot)
    expect(quota?.fetchedAt).toBe(1_700_000_000_000)
    // usedPercent 为 null 的那一行被 quotaWindow() 丢掉：null 不是 0%。
    expect(quota?.windows).toHaveLength(2)
    expect(quota?.windows[0]).toEqual({
      label: '',
      usedPercent: 25,
      windowDurationMins: QUOTA_WINDOW_MINUTES['five-hour'],
      resetsAt: 1_800_000_000_000,
    })
    expect(quota?.windows[1]?.windowDurationMins).toBe(QUOTA_WINDOW_MINUTES.monthly)
  })

  it('没有快照时返回 undefined（读不出来的账号不是 0% 用量）', () => {
    expect(glmCodingPlanPoolQuota(null)).toBeUndefined()
  })
})

