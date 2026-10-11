import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { GlmQuotaWindowKey } from '../src/shared/glm-coding-plan-contracts.ts'
import {
  GLM_CODING_PLAN_PROVIDER_ID,
  GLM_CODING_PLAN_PROVIDER_NAME,
  GLM_CODING_PLAN_ROUTE_PREFIX,
  GLM_REASONING_EFFORTS,
  isGlmRegion,
  isGlmWire,
} from '../src/shared/glm-coding-plan-contracts.ts'
import {
  BIZ_TOKEN_REFRESH_MARGIN_SECONDS,
  CHAT_PATH_ANTHROPIC,
  CHAT_PATH_OPENAI,
  CLI_INIT_PATH,
  CLI_POLL_PATH,
  CLI_PROVIDER_BY_REGION,
  DESKTOP_CALLBACK_REDIRECT_URI,
  DESKTOP_LOGIN_RELAY_PATH,
  ERROR_CODE,
  EXCHANGE_PATHS,
  GLM_KEY_NAME,
  OAUTH_FLOW_TIMEOUT_MS,
  PKCE_SUPPORTED,
  POLL_MIN_INTERVAL_MS,
  PROVIDER_ID,
  PROVIDER_NAME,
  QUOTA_PATH,
  QUOTA_ROW_TYPE,
  QUOTA_UNIT_WINDOW,
  QUOTA_WINDOW_MINUTES,
  REGION_HOSTS,
  SUBSCRIPTION_PATH,
  ZCODE_API_BASE,
  apiBaseForRegion,
  authorizeUrl,
  businessHost,
  cliPollUrl,
  convergeGlmEffort,
  isGlmReasoningEffort,
  normalizeRegion,
  regionForHost,
} from '../src/host/glm-coding-plan/types.ts'

describe('线路身份常量', () => {
  it('provider id / 名称与冻结值一致（D1）', () => {
    expect(GLM_CODING_PLAN_PROVIDER_ID).toBe('glm-coding-plan')
    expect(GLM_CODING_PLAN_PROVIDER_NAME).toBe('GLM（ZCode 账号）')
    // host 侧只做 re-export，不得自己另写一份字面量。
    expect(PROVIDER_ID).toBe(GLM_CODING_PLAN_PROVIDER_ID)
    expect(PROVIDER_NAME).toBe(GLM_CODING_PLAN_PROVIDER_NAME)
  })

  it('路由前缀与兄弟线路同构：/<line>/api', () => {
    expect(GLM_CODING_PLAN_ROUTE_PREFIX).toBe('/glm-coding-plan/api')
  })

  it('provider id 不与已退役的 zhipu 线路或用户的 zai/zhipu 兼容路由同名', () => {
    expect(GLM_CODING_PLAN_PROVIDER_ID).not.toBe('zhipu-coding-plan')
    expect(GLM_CODING_PLAN_PROVIDER_ID).not.toBe('zai')
    expect(GLM_CODING_PLAN_PROVIDER_ID).not.toBe('zhipu')
  })
})

describe('类型守卫', () => {
  it('只认 cn 与 intl 两个区域', () => {
    expect(isGlmRegion('cn')).toBe(true)
    expect(isGlmRegion('intl')).toBe(true)
    expect(isGlmRegion('global')).toBe(false)
    expect(isGlmRegion('CN')).toBe(false)
    expect(isGlmRegion('')).toBe(false)
    expect(isGlmRegion(undefined)).toBe(false)
    expect(isGlmRegion(null)).toBe(false)
    expect(isGlmRegion(3)).toBe(false)
  })

  it('只认 anthropic 与 openai 两种协议面', () => {
    expect(isGlmWire('anthropic')).toBe(true)
    expect(isGlmWire('openai')).toBe(true)
    expect(isGlmWire('responses')).toBe(false)
    expect(isGlmWire(undefined)).toBe(false)
  })

  it('档位守卫只认上游那三档', () => {
    expect(isGlmReasoningEffort('low')).toBe(true)
    expect(isGlmReasoningEffort('high')).toBe(true)
    expect(isGlmReasoningEffort('max')).toBe(true)
    expect(isGlmReasoningEffort('medium')).toBe(false)
    expect(isGlmReasoningEffort('xhigh')).toBe(false)
    expect(isGlmReasoningEffort('minimal')).toBe(false)
  })
})

describe('两区 host 表', () => {
  it('国区：业务 bigmodel.cn / 模型 open.bigmodel.cn / 授权 appId=zcode', () => {
    expect(REGION_HOSTS.cn.business).toBe('https://bigmodel.cn')
    expect(REGION_HOSTS.cn.api).toBe('https://open.bigmodel.cn')
    expect(REGION_HOSTS.cn.authorize).toBe('https://bigmodel.cn/login')
    expect(REGION_HOSTS.cn.authorizeParamName).toBe('appId')
    expect(REGION_HOSTS.cn.authorizeParamValue).toBe('zcode')
  })

  it('国际区：业务与模型同为 api.z.ai / 授权 client_id=client_P8X5CMWmlaRO9gyO-KSqtg', () => {
    expect(REGION_HOSTS.intl.business).toBe('https://api.z.ai')
    expect(REGION_HOSTS.intl.api).toBe('https://api.z.ai')
    expect(REGION_HOSTS.intl.authorize).toBe('https://chat.z.ai/api/oauth/authorize')
    expect(REGION_HOSTS.intl.authorizeParamName).toBe('client_id')
    expect(REGION_HOSTS.intl.authorizeParamValue).toBe('client_P8X5CMWmlaRO9gyO-KSqtg')
  })

  it('区域决定开流请求体里的 provider 名', () => {
    expect(CLI_PROVIDER_BY_REGION.cn).toBe('bigmodel')
    expect(CLI_PROVIDER_BY_REGION.intl).toBe('zai')
  })
})

describe('区域解析', () => {
  it('normalizeRegion 接受别名，拒绝认不出的值', () => {
    expect(normalizeRegion('cn')).toBe('cn')
    expect(normalizeRegion(' CN ')).toBe('cn')
    expect(normalizeRegion('china')).toBe('cn')
    expect(normalizeRegion('bigmodel')).toBe('cn')
    expect(normalizeRegion('intl')).toBe('intl')
    expect(normalizeRegion('global')).toBe('intl')
    expect(normalizeRegion('international')).toBe('intl')
    expect(normalizeRegion('mars')).toBeUndefined()
    expect(normalizeRegion(undefined)).toBeUndefined()
    expect(normalizeRegion(7)).toBeUndefined()
  })

  it('regionForHost 认出两区各自的 host', () => {
    expect(regionForHost('https://bigmodel.cn')).toBe('cn')
    expect(regionForHost('https://open.bigmodel.cn/api/coding/paas/v4')).toBe('cn')
    expect(regionForHost('https://bigmodel.cn/login')).toBe('cn')
    expect(regionForHost('https://api.z.ai')).toBe('intl')
    expect(regionForHost('https://chat.z.ai/api/oauth/authorize')).toBe('intl')
    expect(regionForHost('  HTTPS://API.Z.AI/api/anthropic  ')).toBe('intl')
  })

  it('regionForHost 对认不出的 host 回落国际区（凭据没自述区域时的历史默认）', () => {
    expect(regionForHost('https://example.invalid')).toBe('intl')
    expect(regionForHost(undefined)).toBe('intl')
    expect(regionForHost('')).toBe('intl')
  })

  it('apiBaseForRegion / businessHost 给出该区的两个面', () => {
    expect(apiBaseForRegion('cn')).toBe('https://open.bigmodel.cn')
    expect(apiBaseForRegion('intl')).toBe('https://api.z.ai')
    expect(businessHost('cn')).toBe('https://bigmodel.cn')
    expect(businessHost('intl')).toBe('https://api.z.ai')
  })

  it('环境变量可覆盖 host，且覆盖值去掉尾部斜杠', () => {
    expect(apiBaseForRegion('cn', { DSH_GLM_CN_API_HOST: 'https://proxy.invalid/' } as NodeJS.ProcessEnv))
      .toBe('https://proxy.invalid')
    expect(businessHost('intl', { DSH_GLM_INTL_BUSINESS_HOST: 'https://mirror.invalid' } as NodeJS.ProcessEnv))
      .toBe('https://mirror.invalid')
    // 空白覆盖值必须被当作「没设」，否则一次误配就把默认值清空了。
    expect(apiBaseForRegion('cn', { DSH_GLM_CN_API_HOST: '   ' } as NodeJS.ProcessEnv))
      .toBe('https://open.bigmodel.cn')
  })

  it('授权 URL 带上该区的参数名与取值', () => {
    expect(authorizeUrl('cn')).toBe('https://bigmodel.cn/login?appId=zcode')
    expect(authorizeUrl('intl'))
      .toBe('https://chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg')
  })
})

describe('OAuth 控制面', () => {
  it('控制面与路径逐字取自官方源码', () => {
    expect(ZCODE_API_BASE).toBe('https://zcode.z.ai/api/v1')
    expect(CLI_INIT_PATH).toBe('/oauth/cli/init')
    expect(CLI_POLL_PATH).toBe('/oauth/cli/poll')
    expect(cliPollUrl('flow-1')).toBe('https://zcode.z.ai/api/v1/oauth/cli/poll/flow-1')
  })

  it('桌面回调中转的 scheme 与路径', () => {
    expect(DESKTOP_CALLBACK_REDIRECT_URI).toBe('zcode://oauth/callback')
    expect(DESKTOP_LOGIN_RELAY_PATH).toBe('/app/oauth/login')
  })

  it('两个 adapter 都没有 PKCE：授权参数里不得凭空加 code_challenge', () => {
    expect(PKCE_SUPPORTED).toBe(false)
  })

  it('总超时 5 分钟、轮询最小间隔 1 秒', () => {
    expect(OAUTH_FLOW_TIMEOUT_MS).toBe(5 * 60 * 1000)
    expect(POLL_MIN_INTERVAL_MS).toBe(1000)
  })

  it('业务 JWT 提前 120 秒重取（上游没有 refresh_token 交换接口）', () => {
    expect(BIZ_TOKEN_REFRESH_MARGIN_SECONDS).toBe(120)
  })
})

describe('模型面路径', () => {
  it('Anthropic 面是 /api/anthropic', () => {
    expect(CHAT_PATH_ANTHROPIC).toBe('/api/anthropic')
  })

  it('OpenAI 面必须是 Coding Plan 专用面，不能是通用面', () => {
    expect(CHAT_PATH_OPENAI).toBe('/api/coding/paas/v4')
    // 通用面走套餐时额度不生效（官方 QA 文档 Common mistakes 段），所以这里要显式钉死。
    expect(CHAT_PATH_OPENAI).not.toBe('/api/paas/v4')
    expect(CHAT_PATH_OPENAI.startsWith('/api/coding/')).toBe(true)
  })

  it('两个协议面的前缀互不为前缀，避免拼接时撞面', () => {
    expect(CHAT_PATH_OPENAI.startsWith(CHAT_PATH_ANTHROPIC)).toBe(false)
    expect(CHAT_PATH_ANTHROPIC.startsWith(CHAT_PATH_OPENAI)).toBe(false)
  })
})

describe('兑换链与本线路的 Key 名', () => {
  it('四段路径逐字取自三个同构实现', () => {
    expect(EXCHANGE_PATHS.login).toBe('/api/auth/z/login')
    expect(EXCHANGE_PATHS.customerInfo).toBe('/api/biz/customer/getCustomerInfo')
    expect(EXCHANGE_PATHS.apiKeys)
      .toBe('/api/biz/v1/organization/{orgId}/projects/{projectId}/api_keys')
    expect(EXCHANGE_PATHS.apiKeyCopy)
      .toBe('/api/biz/v1/organization/{orgId}/projects/{projectId}/api_keys/copy/{apiKeyId}')
  })

  it('本线路用自己的 Key 名，不复用官方客户端的 zcode-api-key', () => {
    expect(GLM_KEY_NAME).toBe('dsh-glm-coding-plan')
    expect(GLM_KEY_NAME).not.toBe('zcode-api-key')
  })
})

describe('配额与订阅端点', () => {
  it('端点路径逐字一致', () => {
    expect(QUOTA_PATH).toBe('/api/monitor/usage/quota/limit')
    expect(SUBSCRIPTION_PATH).toBe('/api/biz/subscription/list')
  })

  it('unit 映射逐字照抄上游编号：3=5 小时、5=月度、6=周度', () => {
    expect(QUOTA_UNIT_WINDOW[3]).toBe('five-hour')
    expect(QUOTA_UNIT_WINDOW[5]).toBe('monthly')
    expect(QUOTA_UNIT_WINDOW[6]).toBe('weekly')
  })

  it('未知 unit 没有窗口可落：查表得到 undefined，而不是就近发一个窗口', () => {
    expect(QUOTA_UNIT_WINDOW[1]).toBeUndefined()
    expect(QUOTA_UNIT_WINDOW[4]).toBeUndefined()
    expect(QUOTA_UNIT_WINDOW[99]).toBeUndefined()
  })

  it('TIME_LIMIT 是 MCP 请求上限，不是套餐窗口', () => {
    expect(QUOTA_ROW_TYPE.time).toBe('TIME_LIMIT')
    expect(QUOTA_ROW_TYPE.tokens).toBe('TOKENS_LIMIT')
    expect(QUOTA_ROW_TYPE.credit).toBe('CREDIT_LIMIT')
  })
})

describe('窗口长度映射（W6 装配号池配额时要用的那座桥）', () => {
  it('覆盖 GlmQuotaWindowKey 的全部取值', () => {
    // 覆盖性由两处类型保证：types.ts 里这张表的声明本身是 Record<GlmQuotaWindowKey, number>，
    // 加上下面这行赋值——以后往 GlmQuotaWindowKey 加一个 key 却忘了配长度，这两处都会编译失败。
    const cover: Record<GlmQuotaWindowKey, number> = QUOTA_WINDOW_MINUTES
    expect(Object.keys(cover).sort()).toEqual(['five-hour', 'monthly', 'weekly'])
  })

  it('5 小时窗口是 300 分钟（有逐字证据）', () => {
    expect(QUOTA_WINDOW_MINUTES['five-hour']).toBe(300)
  })

  it('周与月按词的通常含义取 7 天 / 30 天（这一档无逐字证据，types.ts 里已标未验证）', () => {
    expect(QUOTA_WINDOW_MINUTES.weekly).toBe(7 * 24 * 60)
    expect(QUOTA_WINDOW_MINUTES.monthly).toBe(30 * 24 * 60)
  })

  it('这张表只给长度不给窗口名：名字由客户端按长度本地化，host 不下发展示文案', () => {
    expect(Object.keys(QUOTA_WINDOW_MINUTES)).not.toContain('label')
    expect(Object.values(QUOTA_WINDOW_MINUTES).every((value) => typeof value === 'number')).toBe(true)
  })
})

describe('业务错误码表', () => {
  it('鉴权与权限类码值逐条一致', () => {
    expect(ERROR_CODE.AUTH_MISSING).toBe(1001)
    expect(ERROR_CODE.AUTH_INVALID).toBe(1000)
    expect(ERROR_CODE.AUTH_EXPIRED).toBe(1003)
    expect(ERROR_CODE.NO_PERMISSION).toBe(1220)
  })

  it('参数与内容类码值逐条一致', () => {
    expect(ERROR_CODE.UNKNOWN_MODEL).toBe(1211)
    expect(ERROR_CODE.WRONG_METHOD).toBe(1212)
    expect(ERROR_CODE.MISSING_PARAM).toBe(1213)
    expect(ERROR_CODE.INVALID_PARAM).toBe(1214)
    expect(ERROR_CODE.PROMPT_TOO_LONG).toBe(1261)
    expect(ERROR_CODE.CONTENT_FILTERED).toBe(1301)
  })

  it('额度与限流类码值逐条一致', () => {
    expect(ERROR_CODE.NO_BALANCE).toBe(1113)
    expect(ERROR_CODE.RATE_LIMITED).toBe(1302)
    expect(ERROR_CODE.OVERLOADED).toBe(1305)
    expect(ERROR_CODE.USAGE_LIMIT).toBe(1308)
    expect(ERROR_CODE.PLAN_EXPIRED).toBe(1309)
    expect(ERROR_CODE.PLAN_LIMIT).toBe(1310)
    expect(ERROR_CODE.MODEL_NOT_IN_PLAN).toBe(1311)
  })

  it('码值互不重复：分类靠正文而不是状态行，撞值会让两个条件无法区分', () => {
    const values = Object.values(ERROR_CODE)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('思考档位收敛', () => {
  const LADDER = ['low', 'high', 'max'] as const

  it('线路级词汇表从低到高且只有三档', () => {
    expect(GLM_REASONING_EFFORTS).toEqual(['low', 'high', 'max'])
  })

  it('minimal 收敛到 low，而不是被抬成 high', () => {
    // 这是本仓库历史记录下来的 bug：只排上游那三档时 minimal 属于「未识别」，
    // 未识别一律落中档，于是用户要的「尽量少想」被发成 high —— 更慢而且多计费。
    expect(convergeGlmEffort('minimal', LADDER)).toBe('low')
    expect(convergeGlmEffort('none', LADDER)).toBe('low')
  })

  it('落在梯子上的档位原样保留', () => {
    expect(convergeGlmEffort('low', LADDER)).toBe('low')
    expect(convergeGlmEffort('high', LADDER)).toBe('high')
    expect(convergeGlmEffort('max', LADDER)).toBe('max')
  })

  it('跨两套词汇表的中间档按就近收敛，平手向上', () => {
    expect(convergeGlmEffort('medium', LADDER)).toBe('high')
    expect(convergeGlmEffort('xhigh', LADDER)).toBe('max')
  })

  it('认不出的档位落中档，绝不取两端', () => {
    expect(convergeGlmEffort('turbo', LADDER)).toBe('high')
    expect(convergeGlmEffort('', LADDER)).toBe('high')
  })

  it('大小写与空白不参与判断', () => {
    expect(convergeGlmEffort(' HIGH ', LADDER)).toBe('high')
    expect(convergeGlmEffort('Minimal', LADDER)).toBe('low')
  })

  it('梯子是模型自己声明的：只有两档的模型不会收到第三档', () => {
    expect(convergeGlmEffort('max', ['low', 'high'])).toBe('high')
    expect(convergeGlmEffort('xhigh', ['low', 'high'])).toBe('high')
    expect(convergeGlmEffort('minimal', ['low', 'high'])).toBe('low')
  })

  it('空梯子返回 null，调用方据此不发档位字段而不是发模型不认的值', () => {
    expect(convergeGlmEffort('high', [])).toBeNull()
    expect(convergeGlmEffort('minimal', [])).toBeNull()
  })

  it('收敛结果永远是线路级词汇表里的值', () => {
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', '???']) {
      for (const ladder of [['low'], ['low', 'high'], ['low', 'high', 'max'], ['high', 'max']]) {
        const converged = convergeGlmEffort(effort, ladder)
        expect(GLM_REASONING_EFFORTS).toContain(converged)
      }
    }
  })
})

describe('契约边界不传凭据', () => {
  const contractsSource = readFileSync(
    new URL('../src/shared/glm-coding-plan-contracts.ts', import.meta.url),
    'utf8',
  )

  /**
   * 凭据形状的字段名。
   *
   * `key` 这一支是为本线路的凭据形态准备的：兑换链换出来的就是一把 Coding Plan Key，
   * 字段叫 `codingPlanKey` / `apiKey` / `secretKey` 都不会被漏掉。
   * 代价是裸 `key` 也会命中（`GlmQuotaWindow.key` 是窗口标识），
   * 那属于下面白名单逐个说明过的情况，而不是正则该放过的。
   */
  const secretish =
    /token|secret|password|credential|key|authorization|bearer|jwt/i

  /**
   * 两个已知的安全名，逐个说明为什么不是凭据。
   *
   * 白名单写死在这里而不是放宽正则：放宽正则等于把 `apiKey`/`accessToken` 这类真凭据
   * 也一起放过，而这两个名字各自只带一个数字或一个布尔。
   */
  const SAFE_FIELD_NAMES = new Set([
    'defaultMaxTokens', // 输出上限，单位是 token 个数，值是一个整数
    'hasCredentials', // 布尔标志，只说「有没有」，不带值；兄弟线路的状态 DTO 同名字段
    'key', // GlmQuotaWindow.key 是窗口标识（five-hour / weekly / monthly），不是凭据
  ])

  function declaredFieldNames(source: string): string[] {
    // 去掉注释后再扫：注释里出现 access_token 之类是解释「为什么不过边界」，不算字段。
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    return code
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Za-z][A-Za-z0-9_]*\??:/.test(line))
      .map((line) => line.split('?')[0]!.split(':')[0]!.trim())
  }

  it('扫描器本身抓得住真凭据名（阳性对照，防止它退化成空转）', () => {
    const planted = ['interface X {', '  accessToken: string', '  codingPlanKey?: string', '}']
      .join('\n')
    expect(declaredFieldNames(planted).filter((name) => secretish.test(name)))
      .toEqual(['accessToken', 'codingPlanKey'])
  })

  it('共享契约里没有任何凭据形状的字段', () => {
    const offenders = declaredFieldNames(contractsSource)
      .filter((name) => secretish.test(name) && !SAFE_FIELD_NAMES.has(name))
    expect(offenders).toEqual([])
  })

  it('共享契约的白名单名字确实在用（否则白名单会变成免检的死条目）', () => {
    const declared = declaredFieldNames(contractsSource)
    for (const name of SAFE_FIELD_NAMES) expect(declared).toContain(name)
  })
});
