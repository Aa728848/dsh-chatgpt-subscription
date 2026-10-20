/**
 * Qoder 模型目录的测试：上游目录解析、随包兜底表、未声明行、档位收敛。
 *
 * 字段语义逐字对照 pi-provider \`catalog.ts\`：\`max_input_tokens\` 是陈旧的 180K 地板
 * （不可信），窗口只信 \`context_config\` 的最大 \`token_count\`。
 */
import { describe, expect, it } from 'vitest'
import {
  QODER_MODEL_CATALOG_CN,
  QODER_MODEL_CATALOG_GLOBAL,
  bundledQoderCatalog,
  catalogModelOptions,
  contextWindowFromRecord,
  parseQoderModelListing,
  readQoderThinkingConfig,
  resolveQoderModel,
  toQoderModelId,
  undeclaredQoderModelEntry,
} from '../src/host/qoder/model-catalog.ts'
import { convergeQoderEffort, QODER_MAX_OUTPUT_TOKENS } from '../src/host/qoder/types.ts'

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

  it('catalogModelOptions：空勾选 = 不过滤；覆盖窗口生效', () => {
    const options = catalogModelOptions(QODER_MODEL_CATALOG_GLOBAL, {})
    expect(options.every((model) => model.enabled)).toBe(true)
    const picked = catalogModelOptions(QODER_MODEL_CATALOG_GLOBAL, {
      enabledModelIds: ['Lite'],
      contextWindowOverrides: { Lite: 512_000 },
    })
    expect(picked.find((model) => model.id === 'Lite')).toMatchObject({ enabled: true, contextWindow: 512_000 })
    expect(picked.find((model) => model.id !== 'Lite')?.enabled).toBe(false)
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
