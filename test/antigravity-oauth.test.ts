import { describe, expect, it, vi } from 'vitest'
import {
  defaultUserAgent,
  endpointCandidates,
  loadCodeAssistDetail,
  onboardUser,
} from '../src/host/antigravity/client.ts'
import {
  assertFreeTierEligible,
  discoverAntigravityProject,
  exchangeOAuthCode,
  extractGoogleValidationUrl,
  refreshAntigravityToken,
} from '../src/host/antigravity/oauth.ts'
import {
  DEFAULT_ANTIGRAVITY_CL,
  DEFAULT_ANTIGRAVITY_VERSION,
  FREE_TIER_ID,
} from '../src/host/antigravity/types.ts'

describe('Antigravity OAuth & Client Onboarding', () => {
  it('generates official 2.8.0 user agent format and honors environment overrides', () => {
    const ua = defaultUserAgent()
    expect(ua).toContain(`antigravity/hub/${DEFAULT_ANTIGRAVITY_VERSION}`)
    expect(ua).toContain(`cl=${DEFAULT_ANTIGRAVITY_CL}`)
    expect(ua).toContain('aidev_client')
    // 默认 UA 描述真实运行平台，而不是冒充官方客户端的 darwin/arm64
    const expectedOs = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux'
    const expectedArch = process.arch === 'x64' ? 'amd64' : process.arch
    expect(ua).toContain(`os_type=${expectedOs}`)
    expect(ua).toContain(`arch=${expectedArch}`)

    const previous = {
      version: process.env.DSH_ANTIGRAVITY_VERSION,
      cl: process.env.DSH_ANTIGRAVITY_CL,
      os: process.env.DSH_ANTIGRAVITY_OS,
      arch: process.env.DSH_ANTIGRAVITY_ARCH,
    }
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    try {
      process.env.DSH_ANTIGRAVITY_VERSION = '2.9.1'
      process.env.DSH_ANTIGRAVITY_CL = '123456789'
      process.env.DSH_ANTIGRAVITY_OS = 'darwin'
      process.env.DSH_ANTIGRAVITY_ARCH = 'arm64'
      const customUa = defaultUserAgent()
      expect(customUa).toBe('antigravity/hub/2.9.1 (aidev_client; os_type=darwin; arch=arm64; cl=123456789)')
    } finally {
      restore('DSH_ANTIGRAVITY_VERSION', previous.version)
      restore('DSH_ANTIGRAVITY_CL', previous.cl)
      restore('DSH_ANTIGRAVITY_OS', previous.os)
      restore('DSH_ANTIGRAVITY_ARCH', previous.arch)
    }
  })

  it('directly discovers project for existing active accounts without onboarding', async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.includes('/v1internal:loadCodeAssist')) {
        return new Response(
          JSON.stringify({
            currentTier: { id: FREE_TIER_ID, name: 'Free' },
            cloudaicompanionProject: 'projects/existing-123',
            allowedTiers: [{ id: FREE_TIER_ID }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const progressLogs: string[] = []
    const projectId = await discoverAntigravityProject('token-123', fakeFetch, undefined, (p) => progressLogs.push(p))

    expect(projectId).toBe('projects/existing-123')
    expect(fakeFetch).toHaveBeenCalledTimes(1)
    expect(progressLogs).toContain('正在检查 Cloud Code Assist 账号状态...')
  })

  it('triggers onboarding and LRO polling for brand new accounts', async () => {
    let loadCount = 0
    let pollCount = 0

    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/v1internal:loadCodeAssist')) {
        loadCount++
        if (loadCount === 1) {
          // 首次未开通，无 currentTier
          return new Response(
            JSON.stringify({
              currentTier: null,
              allowedTiers: [{ id: FREE_TIER_ID }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        // 开通后再次加载，返回已分配的 project
        return new Response(
          JSON.stringify({
            currentTier: { id: FREE_TIER_ID },
            cloudaicompanionProject: 'projects/new-project-888',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (url.includes('/v1internal:onboardUser')) {
        const body = JSON.parse(String(init?.body))
        expect(body.tierId).toBe(FREE_TIER_ID)
        return new Response(
          JSON.stringify({
            name: 'operations/onboard-op-42',
            done: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (url.includes('/v1internal/operations/onboard-op-42')) {
        pollCount++
        return new Response(
          JSON.stringify({
            name: 'operations/onboard-op-42',
            done: true,
            response: { '@type': 'type.googleapis.com/google.cloud.cloudaicompanion.v1internal.OnboardUserResponse' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const progressLogs: string[] = []
    const projectId = await discoverAntigravityProject('token-new', fakeFetch, undefined, (p) => progressLogs.push(p))

    expect(projectId).toBe('projects/new-project-888')
    expect(pollCount).toBe(1)
    expect(progressLogs).toContain('正在为新账号开通 Antigravity 免费额度...')
    expect(progressLogs).toContain('正在获取专属项目 (Project ID)...')
  })

  it('surfaces the last failure when every onboarding endpoint fails', async () => {
    const fakeFetch = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch

    await expect(onboardUser('token-fail', fakeFetch)).rejects.toThrow(/onboardUser failed/)
    expect(fakeFetch).toHaveBeenCalledTimes(endpointCandidates().length) // 每个候选端点都尝试过一次
  })

  it('intercepts Google account validation and extracts validationUrl', async () => {
    const validationUrl = 'https://accounts.google.com/check/challenge?continue=...'
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.includes('/v1internal:loadCodeAssist')) {
        return new Response(
          JSON.stringify({
            allowedTiers: [],
            ineligibleTiers: [
              {
                tierId: FREE_TIER_ID,
                reasonMessage: 'User must complete security verification',
                validationUrl,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    await expect(discoverAntigravityProject('token-blocked', fakeFetch)).rejects.toThrow(/User must complete security verification/)

    try {
      await discoverAntigravityProject('token-blocked', fakeFetch)
    } catch (err: any) {
      expect(err.validationUrl).toBe(validationUrl)
      expect(extractGoogleValidationUrl(err.message)).toBe(validationUrl)
    }
  })

  it('preserves projectId during token refresh and attempts discovery if missing', async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'refreshed-access-token',
            expires_in: 3600,
            refresh_token: 'next-refresh-token',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/v1internal:loadCodeAssist')) {
        return new Response(
          JSON.stringify({
            cloudaicompanionProject: 'projects/recovered-project',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    // 1. 已有 projectId 严格保留
    const refreshedWithProj = await refreshAntigravityToken(
      {
        access: 'old-access',
        refresh: 'old-refresh',
        projectId: 'projects/fixed-project',
      },
      fakeFetch,
    )
    expect(refreshedWithProj.access).toBe('refreshed-access-token')
    expect(refreshedWithProj.projectId).toBe('projects/fixed-project')

    // 2. 缺失 projectId 保持原样不额外发网络请求
    const refreshedWithoutProj = await refreshAntigravityToken(
      {
        access: 'old-access',
        refresh: 'old-refresh',
      },
      fakeFetch,
    )
    expect(refreshedWithoutProj.projectId).toBeUndefined()
  })
})
