/**
 * Qoder 模型目录的测试：上游目录解析、随包兜底表、未声明行、档位收敛。
 *
 * 字段语义逐字对照 pi-provider \`catalog.ts\`：\`max_input_tokens\` 是陈旧的 180K 地板
 * （不可信），窗口只信 \`context_config\` 的最大 \`token_count\`。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearCachedQoderModelCatalog,
  loadQoderModelCatalog,
  qoderCatalogFetchedAt,
  qoderCatalogIsLive,
  qoderCatalogNeedsRefresh,
  type QoderUpstreamCredential,
} from '../src/host/qoder/client.ts'
import { CATALOG_CACHE_TTL_MS } from '../src/host/qoder/types.ts'
import {
  QODER_MODEL_CATALOG_CN,
  QODER_MODEL_CATALOG_GLOBAL,
  bundledQoderCatalog,
  catalogModelOptions,
  contextWindowFromRecord,
  convergeQoderEnabledModelIds,
  parseQoderModelListing,
  parsePersistedQoderModelEntries,
  persistedQoderModelRecord,
  readQoderThinkingConfig,
  resolveQoderModel,
  toQoderModelId,
  undeclaredQoderModelEntry,
} from '../src/host/qoder/model-catalog.ts'
import { convergeQoderEffort, QODER_MAX_OUTPUT_TOKENS } from '../src/host/qoder/types.ts'

/**
 * 一份只答「模型目录」的假 fetch。
 *
 * 别的 URL（COSY 版本跟随走的是 GitHub releases）一律回 404——那条路径是
 * 尽力而为的，404 会被安静地吞掉，正好让这里只数真正关心的那一次请求。
 */
function mockCatalogFetch(modelIds: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/model/list')) {
      return Response.json({
        chat: modelIds.map((id) => ({ key: id.toLowerCase(), display_name: id, enable: true })),
      })
    }
    return new Response('', { status: 404 })
  }) as unknown as typeof fetch
}

describe('parseQoderModelListing', () => {
  it('读 { chat: [...] } 形状；缺 key / 缺 display_name / enable:false 的条目被丢弃', () => {
    const entries = parseQoderModelListing({
      chat: [
        {
          key: 'lite',
          display_name: 'Lite',
          enable: true,
          is_vl: false,
          is_reasoning: false,
          context_config: { low: { token_count: 200_000 }, high: { token_count: 1_000_000, is_default: true } },
        },
        { key: 'broken-no-name', enable: true },
        { display_name: 'No Key', enable: true },
        { key: 'disabled', display_name: 'Disabled', enable: false },
      ],
    }, 'global')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: 'Lite',
      upstreamKey: 'lite',
      supportsImages: false,
      reasoning: false,
      defaultContextWindow: 1_000_000,
      defaultMaxTokens: QODER_MAX_OUTPUT_TOKENS,
    })
  })

  it('display_name 去空白成为公开 id（pi-provider toQoderModelId 同一规则）', () => {
    expect(toQoderModelId('Qwen3.8-Max')).toBe('Qwen3.8-Max')
    expect(toQoderModelId('Qwen3.7 Plus')).toBe('Qwen3.7Plus')
    const entries = parseQoderModelListing({
      chat: [{ key: 'qmodel', display_name: 'Qwen3.7 Plus', enable: true }],
    }, 'cn')
    expect(entries[0]).toMatchObject({ id: 'Qwen3.7Plus', name: 'Qwen3.7 Plus', upstreamKey: 'qmodel', regions: ['cn'] })
  })

  it('context_config 缺省时走区域兜底（global 1M / cn 200K），绝不读 max_input_tokens 那个陈旧地板', () => {
    expect(contextWindowFromRecord({ max_input_tokens: 180_000 }, 'global')).toBe(1_000_000)
    expect(contextWindowFromRecord({ max_input_tokens: 180_000 }, 'cn')).toBe(200_000)
    expect(contextWindowFromRecord({ context_config: { a: { token_count: 256_000 } } }, 'cn')).toBe(256_000)
  })

  it('thinking_config 的两种形态：effort 梯子与 toggle 开关', () => {
    // effort 形态：enabled.efforts 的键集是完整梯子。
    const efforts = readQoderThinkingConfig({
      thinking_config: { disabled: {}, enabled: { efforts: { low: {}, high: {}, xhigh: {} } } },
    })
    expect(efforts).toEqual({ efforts: ['low', 'high', 'xhigh'], thinkingDisableable: true, isReasoning: true })
    // toggle 形态：只有开关，没有档位。
    const toggle = readQoderThinkingConfig({ thinking_config: { enabled: {} } })
    expect(toggle).toEqual({ efforts: [], thinkingDisableable: false, isReasoning: true })
    // 没有 thinking_config：看 is_reasoning。
    expect(readQoderThinkingConfig({ is_reasoning: true })).toMatchObject({ efforts: [], isReasoning: true })
    expect(readQoderThinkingConfig({})).toMatchObject({ efforts: [], isReasoning: false })
  })

  it('认不出的形状给空目录而不是抛错', () => {
    expect(parseQoderModelListing(undefined, 'global')).toEqual([])
    expect(parseQoderModelListing({ notchat: true }, 'global')).toEqual([])
    expect(parseQoderModelListing({ chat: 'nope' }, 'global')).toEqual([])
  })
})

describe('随包兜底表与未声明行', () => {
  it('两区各有一张表，公开 id 与上行 key 分开', () => {
    expect(QODER_MODEL_CATALOG_GLOBAL.length).toBeGreaterThan(0)
    expect(QODER_MODEL_CATALOG_CN.length).toBeGreaterThan(0)
    const lite = QODER_MODEL_CATALOG_GLOBAL.find((entry) => entry.id === 'Lite')!
    expect(lite.upstreamKey).toBe('lite')
    expect(lite.regions).toEqual(['global'])
    // CN 的 Auto 保守 200K（pi-provider 注释：未在 1M 实测过）。
    expect(QODER_MODEL_CATALOG_CN.find((entry) => entry.id === 'Auto')!.defaultContextWindow).toBe(200_000)
    expect(bundledQoderCatalog('cn')).toBe(QODER_MODEL_CATALOG_CN)
  })

  it('未声明行什么都不主张：不发档位、不认图、窗口走区域兜底', () => {
    const entry = undeclaredQoderModelEntry('future-model', { region: 'cn' })
    expect(entry).toMatchObject({
      reasoning: false,
      reasoningEfforts: [],
      supportsImages: false,
      defaultContextWindow: 200_000,
    })
    expect(entry.hint).toContain('未声明模型')
    // resolve 找不到时回落未声明行；按上游 key 也能找到（请求面拿的是 key）。
    // CN 兜底表的 id 逐字照录 pi-provider staticCnModels（带连字符，与全球区不同）。
    const resolved = resolveQoderModel('qmodel', QODER_MODEL_CATALOG_CN, 'cn')
    expect(resolved.id).toBe('Qwen3.7-Plus')
    expect(resolveQoderModel('nope', QODER_MODEL_CATALOG_CN, 'cn').hint).toContain('未声明模型')
  })

  it('catalogModelOptions：null/缺省 = 不过滤；覆盖窗口生效', () => {
    const options = catalogModelOptions(QODER_MODEL_CATALOG_GLOBAL, {})
    expect(options.every((model) => model.enabled)).toBe(true)
    const explicitNull = catalogModelOptions(QODER_MODEL_CATALOG_GLOBAL, { enabledModelIds: null })
    expect(explicitNull.every((model) => model.enabled)).toBe(true)
    const picked = catalogModelOptions(QODER_MODEL_CATALOG_GLOBAL, {
      enabledModelIds: ['Lite'],
      contextWindowOverrides: { Lite: 512_000 },
    })
    expect(picked.find((model) => model.id === 'Lite')).toMatchObject({ enabled: true, contextWindow: 512_000 })
    expect(picked.find((model) => model.id !== 'Lite')?.enabled).toBe(false)
  })

  it('catalogModelOptions：空勾选是「全关」而不是「不过滤」（三态的 []）', () => {
    const options = catalogModelOptions(QODER_MODEL_CATALOG_GLOBAL, { enabledModelIds: [] })
    // 目录非空，却一行都不勾：这正是旧语义里点不出来的那个状态。
    expect(options.length).toBeGreaterThan(0)
    expect(options.every((model) => model.enabled)).toBe(false)
  })
})

describe('convergeQoderEnabledModelIds（白名单收敛到当前目录）', () => {
  it('null 原样返回 null：不过滤不是一张空表', () => {
    expect(convergeQoderEnabledModelIds(null, ['a', 'b'])).toBeNull()
    // 目录为空时也一样：null 依旧是 null，不会被折成「全关」。
    expect(convergeQoderEnabledModelIds(null, [])).toBeNull()
  })

  it('空数组原样返回空数组：用户明确全关', () => {
    expect(convergeQoderEnabledModelIds([], ['a', 'b'])).toEqual([])
  })

  it('只留下目录里真实存在的 id，并保持 stored 的顺序', () => {
    expect(convergeQoderEnabledModelIds(['b', 'gone', 'a'], ['a', 'b', 'c'])).toEqual(['b', 'a'])
    // 全部残留 = 收敛成空表（此刻确实一个都不可用，而不是回到不过滤）。
    expect(convergeQoderEnabledModelIds(['gone', 'also-gone'], ['a', 'b'])).toEqual([])
  })

  it('去重，且不改动 stored 本身', () => {
    const stored = ['a', 'b', 'a', 'b']
    expect(convergeQoderEnabledModelIds(stored, ['a', 'b'])).toEqual(['a', 'b'])
    expect(stored).toEqual(['a', 'b', 'a', 'b'])
  })
})

/**
 * 目录缓存「该不该拉一次」的判定。
 *
 * 这条判定是 host 在 GET /status 应答背后是否启动刷新的**唯一**口径，所以三态
 * 必须逐条钉住：空缓存要拉、未过期不拉、过期要拉。判错的方向只有两种，两种都
 * 很难在界面上看出来——把「该拉」判成「不拉」，选择器就永远停在随包兜底表上；
 * 把「不该拉」判成「该拉」，每一次 60 秒轮询都是一次上游请求。
 */
/** 一份够用的上游凭据切片：这条判定只看区域，其余字段按契约补齐即可。 */
function catalogCredential(region: 'global' | 'cn' = 'global'): QoderUpstreamCredential {
  return { accessToken: 'jt-1', region, uid: null, email: null, accountName: null }
}

/**
 * 拉一次真实目录并留下缓存，返回**缓存建立之后**的时刻。
 *
 * 这个顺序是要紧的：缓存里的 `fetchedAt` 是拉取落地的那一刻，只有在它之后取的
 * now 才一定满足 `now >= fetchedAt`。反过来先取 now 再去拉，fetchedAt 会比 now
 * 晚几毫秒，「now + TTL」就落在 TTL 之内，一条本该证明「过期了」的断言会安静地
 * 变成「还没过期」——这一条正是这么红过两次的。
 */
async function warmCatalog(region: 'global' | 'cn' = 'global'): Promise<number> {
  await loadQoderModelCatalog(catalogCredential(region), { fetchFn: mockCatalogFetch(['Lite']) })
  return Date.now()
}

describe('qoderCatalogNeedsRefresh（答复背后要不要拉目录）', () => {
  beforeEach(() => {
    clearCachedQoderModelCatalog()
  })

  it('空缓存：需要拉（冷启动的第一条 status 就该触发）', () => {
    expect(qoderCatalogNeedsRefresh('global')).toBe(true)
  })

  it('刚拉到的缓存：不需要拉（60 秒轮询在 TTL 内绝大多数拍都走这条）', async () => {
    // 目录取不到时 loadQoderModelCatalog 走空目录、不写缓存，所以假 fetch 必须
    // 供一份真能被解析的载荷，缓存才会真的被建立起来。
    await warmCatalog()
    // 基准取缓存**自己**记下的 fetchedAt：拿 await 返回后的 Date.now() 去推边界，
    // 两次读时钟之间的毫秒差会让下面这条「差一毫秒仍新鲜」偶发翻车。
    const fetchedAt = qoderCatalogFetchedAt('global')!
    expect(qoderCatalogNeedsRefresh('global', fetchedAt)).toBe(false)
    // 差一毫秒到期：仍然算新鲜（判定是 >= TTL 才算过期）。
    expect(qoderCatalogNeedsRefresh('global', fetchedAt + CATALOG_CACHE_TTL_MS - 1)).toBe(false)
  })

  it('过了 TTL：需要拉（这是「进页面能自动更新」的那一半）', async () => {
    await warmCatalog()
    const fetchedAt = qoderCatalogFetchedAt('global')!
    expect(qoderCatalogNeedsRefresh('global', fetchedAt + CATALOG_CACHE_TTL_MS)).toBe(true)
  })

  it('别的区域的缓存不算数：目录是区域的属性', async () => {
    await warmCatalog('global')
    expect(qoderCatalogNeedsRefresh('cn')).toBe(true)
  })
})


/**
 * 兜底表阶段不做白名单过滤的那条规则的**词汇表证据**与判定本身。
 *
 * 这一组钉的是缺陷 1 的前提：用户的白名单来自实时目录（上游 `display_name` 去空白），
 * 随包兜底表来自 pi-provider 的静态表，同一批模型在两边**叫法不同**。只要这条前提
 * 还在，「用白名单筛兜底表」就必然收敛成空集。
 */
describe('qoderCatalogIsLive（这一份目录是实时的还是兜底表）', () => {
  beforeEach(() => {
    clearCachedQoderModelCatalog()
  })

  it('冷启动：进程里没有实时目录 → false（调用方据此不做白名单过滤）', () => {
    expect(qoderCatalogIsLive('global')).toBe(false)
    expect(qoderCatalogIsLive('cn')).toBe(false)
  })

  it('实时目录落地之后 → true；别的区域仍然 false（目录是区域的属性）', async () => {
    await loadQoderModelCatalog(catalogCredential('global'), { fetchFn: mockCatalogFetch(['Lite']) })
    expect(qoderCatalogIsLive('global')).toBe(true)
    expect(qoderCatalogIsLive('cn')).toBe(false)
  })

  it('与 qoderCatalogNeedsRefresh 同一条口径：说「不是实时」就等于说「该拉一次」', async () => {
    // 冷启动：两者是同一个判断的两面，不可能出现「不需要拉但又没有实时目录」。
    expect(qoderCatalogIsLive('global')).toBe(false)
    expect(qoderCatalogNeedsRefresh('global')).toBe(true)
    const after = await warmCatalog()
    expect(qoderCatalogIsLive('global')).toBe(true)
    expect(qoderCatalogNeedsRefresh('global', after)).toBe(false)
  })
})

/**
 * 两套 id 词汇表的证据（就写在测试里，别只写在注释里）。
 *
 * 实时目录的公开 id 是上游 `display_name` 去空白，兜底表照录 pi-provider 的静态表：
 * `DeepSeek-Flash` / `Qwen3.8-Flash` 这种名字只存在于实时目录那一套，兜底表里
 * 对应的一行叫 `DeepSeek-V4-Flash` / `Qwen3.8-Max`。所以白名单里出现前者时，
 * 拿它去筛后者一定是空集。
 */
describe('两套 id 词汇表（白名单来自实时目录，兜底表是另一套名字）', () => {
  it('实时目录词汇里的 id 在兜底表里根本不存在', () => {
    const liveIds = ['DeepSeek-Flash', 'Qwen3.8-Flash']
    const bundledIds = bundledQoderCatalog('global').map((entry) => entry.id)
    for (const id of liveIds) expect(bundledIds).not.toContain(id)
    // 而旧实现正是拿这份白名单去 converge 这份兜底表——必然收敛成空表。
    expect(convergeQoderEnabledModelIds(liveIds, bundledIds)).toEqual([])
    // 兜底表里与之对应的行叫另一个名字（同一个模型，两种词汇）。
    expect(bundledIds).toContain('DeepSeek-V4-Flash')
  })
})

describe('convergeQoderEffort（档位收敛到模型真实梯子）', () => {
  it('空梯子 = 不发任何思考控制字段', () => {
    expect(convergeQoderEffort('high', [])).toBeNull()
  })

  it('平手向上取；未知档位按中档处理', () => {
    expect(convergeQoderEffort('medium', ['low', 'high'])).toBe('high')
    expect(convergeQoderEffort('bogus', ['low', 'high'])).toBe('high')
    expect(convergeQoderEffort('low', ['low', 'high'])).toBe('low')
    expect(convergeQoderEffort('max', ['low', 'high'])).toBe('high')
  })
})

describe('落盘快照必须带回档位梯子', () => {
  it('写入侧写出的 thinking_config 能被读取侧解析回同一套能力', () => {
    // 上游 effort 形态：五档 + 可关闭；另一个 toggle 形态：能推理但没有档位。
    const [ladder, toggle] = parseQoderModelListing({
      chat: [
        {
          key: 'umodel',
          display_name: 'Ultimate',
          enable: true,
          source: 'system',
          is_vl: true,
          is_reasoning: true,
          context_config: { default: { token_count: 1_048_576, is_default: true } },
          thinking_config: { enabled: { efforts: { low: {}, medium: {}, high: {}, max: {} } }, disabled: {} },
        },
        {
          key: 'cmodel',
          display_name: 'Cantus',
          enable: true,
          source: 'system',
          is_vl: false,
          is_reasoning: true,
          context_config: { default: { token_count: 200_000, is_default: true } },
          thinking_config: { enabled: {} },
        },
      ],
    }, 'global')

    // 生产写入侧 → 生产读取侧。
    const restored = parsePersistedQoderModelEntries(
      [ladder!, toggle!].map(persistedQoderModelRecord),
      'global',
    )
    expect(restored).toHaveLength(2)
    const [restoredLadder, restoredToggle] = restored
    expect(restoredLadder!.reasoning).toBe(true)
    expect(restoredLadder!.reasoningEfforts).toEqual(['low', 'medium', 'high', 'max'])
    expect(restoredLadder!.thinkingDisableable).toBe(true)
    expect(restoredLadder!.supportsImages).toBe(true)
    expect(restoredLadder!.defaultContextWindow).toBe(1_048_576)
    // toggle 形态：推理仍在，但没有档位——不能被回读成「不推理」。
    expect(restoredToggle!.reasoning).toBe(true)
    expect(restoredToggle!.reasoningEfforts).toEqual([])
    // 上游那条 toggle 形态没写 disabled：不可关闭这件事同样必须原样回读。
    expect(restoredToggle!.thinkingDisableable).toBe(false)
    expect(restoredToggle!.supportsImages).toBe(false)
    expect(restoredToggle!.defaultContextWindow).toBe(200_000)
  })

  it('不可关闭的模型回读后仍然不可关闭', () => {
    const [entry] = parseQoderModelListing({
      chat: [{
        key: 'kmodel',
        display_name: 'Kimi-K3',
        enable: true,
        is_vl: true,
        is_reasoning: true,
        context_config: { default: { token_count: 1_000_000, is_default: true } },
        thinking_config: { enabled: { efforts: { low: {}, high: {} } } },
      }],
    }, 'global')
    const [restored] = parsePersistedQoderModelEntries([persistedQoderModelRecord(entry!)], 'global')
    expect(restored!.thinkingDisableable).toBe(false)
    expect(restored!.reasoningEfforts).toEqual(['low', 'high'])
  })
})
