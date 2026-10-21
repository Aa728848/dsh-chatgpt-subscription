/**
 * Qoder 模型勾选的**三态**（`null` = 不过滤 / `[]` = 全关 / 非空 = 白名单）。
 *
 * 钉的是这条线路曾经真出过的 bug：schemastery 把缺省的 `z.array(z.string())`
 * 归一化成 `[]`，于是「空数组」同时表示「没挑过」，卡片上的「全不选」提交 `[]`
 * 与「全选」完全等价——一个点不出效果的按钮。所以这里逐条验证三种状态都能
 * 原样穿过解析、合并、落盘与 register 接缝。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  QODER_SELECTION_VERSION,
  QoderModelSettingsStore,
  defaultQoderModelSettings,
  mergeQoderSettings,
  needsQoderSelectionMigration,
  parseQoderModelSettings,
  registerQoderPreferenceStore,
  type QoderModelSettings,
} from '../src/host/qoder/token-store.ts'

function settings(overrides: Partial<QoderModelSettings> = {}): QoderModelSettings {
  return { ...defaultQoderModelSettings(), ...overrides }
}

describe('parseQoderModelSettings（三态解析）', () => {
  it('出厂是 null：不过滤，而不是一份写死的白名单', () => {
    expect(defaultQoderModelSettings().enabledModelIds).toBeNull()
    expect(parseQoderModelSettings({}).enabledModelIds).toBeNull()
    expect(parseQoderModelSettings(undefined).enabledModelIds).toBeNull()
  })

  it('空数组如实保留：用户明确全关，不许被读成缺省', () => {
    // 带着迁移标记的文档：`[]` 就是用户按下的「全不选」。
    // （没有标记的 `[]` 是旧版本出厂值，读成 null——见下面「一次性迁移」那组。）
    expect(parseQoderModelSettings({
      enabledModelIds: [],
      selectionVersion: QODER_SELECTION_VERSION,
    }).enabledModelIds).toEqual([])
  })

  it('非数组（字符串 / 数字 / 对象）一律回落成 null', () => {
    expect(parseQoderModelSettings({ enabledModelIds: 'Lite' }).enabledModelIds).toBeNull()
    expect(parseQoderModelSettings({ enabledModelIds: 3 }).enabledModelIds).toBeNull()
    expect(parseQoderModelSettings({ enabledModelIds: { a: 1 } }).enabledModelIds).toBeNull()
    expect(parseQoderModelSettings({ enabledModelIds: null }).enabledModelIds).toBeNull()
  })

  it('数组里混进来的非字符串被丢掉，剩下的顺序不变', () => {
    expect(parseQoderModelSettings({ enabledModelIds: [1, 'Lite', null, 'Ultimate'] }).enabledModelIds)
      .toEqual(['Lite', 'Ultimate'])
  })
})

describe('mergeQoderSettings（三态补丁）', () => {
  it('null 与 [] 都是真实值，只有 undefined 才是「没带这个字段」', () => {
    expect(mergeQoderSettings(settings({ enabledModelIds: ['Lite'] }), { enabledModelIds: [] }).enabledModelIds)
      .toEqual([])
    expect(mergeQoderSettings(settings({ enabledModelIds: [] }), { enabledModelIds: null }).enabledModelIds)
      .toBeNull()
    expect(mergeQoderSettings(settings({ enabledModelIds: ['Lite'] }), {}).enabledModelIds)
      .toEqual(['Lite'])
    expect(mergeQoderSettings(settings({ enabledModelIds: null }), { enabled: false }).enabledModelIds)
      .toBeNull()
  })
})

describe('QoderModelSettingsStore（落盘往返）', () => {
  it('三种状态都能写进去再原样读回来（写后回读校验不会把 null 折成 []）', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-settings-'))
    const store = new QoderModelSettingsStore(path.join(dir, 'models.json'))

    const cleared = await store.updateSettings({ enabledModelIds: [] })
    expect(cleared.enabledModelIds).toEqual([])
    expect((await store.read()).enabledModelIds).toEqual([])
    // 文件里真的写着 []，不是被省略成一个「缺省」。
    expect(JSON.parse(readFileSync(store.path(), 'utf8')).enabledModelIds).toEqual([])

    const whitelisted = await store.updateSettings({ enabledModelIds: ['Lite'] })
    expect(whitelisted.enabledModelIds).toEqual(['Lite'])

    const unfiltered = await store.updateSettings({ enabledModelIds: null })
    expect(unfiltered.enabledModelIds).toBeNull()
    expect((await store.read()).enabledModelIds).toBeNull()
    expect(JSON.parse(readFileSync(store.path(), 'utf8')).enabledModelIds).toBeNull()
  })
})

describe('旧版本 \`[]\` 的一次性迁移（selectionVersion）', () => {
  // 旧版本的出厂值就是 []：defaultQoderModelSettings() 返回
  // [...DEFAULT_VISIBLE_MODEL_IDS]，而 qoder 的 DEFAULT_VISIBLE_MODEL_IDS === []。
  // 所以每一个老用户的落盘文件里都写着 "enabledModelIds": []，旧语义下那是
  // 「不过滤」。没有迁移的话，升级后这些人会一个模型都不剩。
  function legacyDocument(): Record<string, unknown> {
    return {
      enabled: true,
      enabledModelIds: [],
      contextWindowOverrides: {},
      defaultReasoningEffort: null,
      selectedAccountId: null,
    }
  }

  it('无标记 + [] → 读成 null（不过滤），并且落盘后带上标记', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-migrate-'))
    const store = new QoderModelSettingsStore(path.join(dir, 'models.json'))
    await fs.writeFile(store.path(), JSON.stringify(legacyDocument(), null, 2) + '\n', 'utf8')

    // 内存里的结果：旧版本的「没挑过」= 不过滤。
    expect((await store.read()).enabledModelIds).toBeNull()

    // 落盘后的结果：标记补上了，空数组也真的被改写成 null。
    const onDisk = JSON.parse(readFileSync(store.path(), 'utf8')) as Record<string, unknown>
    expect(onDisk.selectionVersion).toBe(QODER_SELECTION_VERSION)
    expect(onDisk.enabledModelIds).toBeNull()
  })

  it('迁移后用户点「全不选」写入 [] → 再读仍然是 []（不被二次迁移翻回 null）', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-migrate2-'))
    const store = new QoderModelSettingsStore(path.join(dir, 'models.json'))
    await fs.writeFile(store.path(), JSON.stringify(legacyDocument(), null, 2) + '\n', 'utf8')

    // 第一次读：旧文档被迁移成 null。
    expect((await store.read()).enabledModelIds).toBeNull()

    // 用户真的点了「全不选」。
    const cleared = await store.updateSettings({ enabledModelIds: [] })
    expect(cleared.enabledModelIds).toEqual([])

    // 再读：必须还是 []，而不是被迁移逻辑当成旧版本默认值翻回 null。
    expect((await store.read()).enabledModelIds).toEqual([])
    const onDisk = JSON.parse(readFileSync(store.path(), 'utf8')) as Record<string, unknown>
    expect(onDisk.enabledModelIds).toEqual([])
    expect(onDisk.selectionVersion).toBe(QODER_SELECTION_VERSION)
  })

  it('有标记 + [] → 如实保留 []（这就是用户明确全关）', () => {
    expect(parseQoderModelSettings({
      enabled: true,
      enabledModelIds: [],
      contextWindowOverrides: {},
      defaultReasoningEffort: null,
      selectedAccountId: null,
      selectionVersion: QODER_SELECTION_VERSION,
    }).enabledModelIds).toEqual([])
  })

  it('幂等：连续解析两次结果相同，迁移判据在第二次就是 false', () => {
    const legacy = legacyDocument()
    const once = parseQoderModelSettings(legacy)
    const twice = parseQoderModelSettings(legacy)
    expect(twice).toEqual(once)
    // 第一次：旧文档要迁移；解析结果已经带上标记，再拿它当文档就不再迁移。
    expect(needsQoderSelectionMigration(legacy)).toBe(true)
    expect(needsQoderSelectionMigration(once)).toBe(false)
    expect(parseQoderModelSettings(once).enabledModelIds).toBeNull()
  })

  it('无标记但非空白名单不迁移：那本来就是显式选择', () => {
    expect(parseQoderModelSettings({ enabledModelIds: ['Lite'] }).enabledModelIds).toEqual(['Lite'])
    expect(needsQoderSelectionMigration({ enabledModelIds: ['Lite'] })).toBe(false)
  })

  it('无标记且缺字段 → null（缺失本来就不是「全关」）', () => {
    expect(parseQoderModelSettings({ enabled: true }).enabledModelIds).toBeNull()
    expect(needsQoderSelectionMigration({ enabled: true })).toBe(false)
  })

  it('写出去的文档一定带标记：merge 与 store 两条路径都不例外', async () => {
    expect(mergeQoderSettings(defaultQoderModelSettings(), { enabledModelIds: [] }).selectionVersion)
      .toBe(QODER_SELECTION_VERSION)

    const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-migrate3-'))
    const store = new QoderModelSettingsStore(path.join(dir, 'models.json'))
    await store.updateSettings({ enabledModelIds: [] })
    expect(JSON.parse(readFileSync(store.path(), 'utf8')).selectionVersion).toBe(QODER_SELECTION_VERSION)
  })
})

describe('registerQoderPreferenceStore（register 接缝上的三态）', () => {
  /** 一个把值放在内存里的最小 settings 服务；schema 只用来暴露它的 default。 */
  function memorySettings(initial: Record<string, unknown> = {}): {
    service: unknown
    written: Record<string, unknown>[]
  } {
    let value: Record<string, unknown> = { ...initial }
    const written: Record<string, unknown>[] = []
    const scope = {
      get: () => value,
      update: async (patch: Record<string, unknown>) => {
        written.push(patch)
        value = { ...value, ...patch }
      },
      watch: () => () => undefined,
    }
    return {
      service: { register: () => scope },
      written,
    }
  }

  it('null 写进去还是 null，不会被折成 []', async () => {
    const { service, written } = memorySettings()
    const store = registerQoderPreferenceStore(service, new QoderModelSettingsStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'qoder-reg-')), 'models.json')))
    await store.update({ enabledModelIds: null })
    expect(written[written.length - 1]?.enabledModelIds).toBeNull()
    expect(store.status().enabledModelIds).toBeNull()
  })

  it('[] 读回来还是 []（旧实现在这里把空数组当缺省丢掉了）', async () => {
    const { service } = memorySettings()
    const store = registerQoderPreferenceStore(service, new QoderModelSettingsStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'qoder-reg2-')), 'models.json')))
    await store.update({ enabledModelIds: [] })
    expect(store.status().enabledModelIds).toEqual([])
  })

  it('白名单原样往返', async () => {
    const { service } = memorySettings()
    const store = registerQoderPreferenceStore(service, new QoderModelSettingsStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'qoder-reg3-')), 'models.json')))
    await store.update({ enabledModelIds: ['Lite', 'Ultimate'] })
    expect(store.status().enabledModelIds).toEqual(['Lite', 'Ultimate'])
  })

  it('缺省时读出来是 null（不过滤），不是 []', () => {
    const { service } = memorySettings()
    const store = registerQoderPreferenceStore(service, new QoderModelSettingsStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'qoder-reg4-')), 'models.json')))
    expect(store.status().enabledModelIds).toBeNull()
  })

  it('旧版 register 文档（无标记 + []）也迁移成 null：两条后端同一套规则', async () => {
    // 旧代码的 update() 写的是 `enabledModelIds: normalized.enabledModelIds ?? []`，
    // 所以 register 文档里同样会留下没有标记的 []。schema 的缺省值必须是 0（旧版），
    // 否则这些文档会被读成「全关」——文件后端修好了、register 还坏着的经典来路。
    const { service, written } = memorySettings({ enabledModelIds: [] })
    const store = registerQoderPreferenceStore(service, new QoderModelSettingsStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'qoder-reg5-')), 'models.json')))
    expect(store.status().enabledModelIds).toBeNull()

    // 写回时盖上新标记：此后这份文档里的 [] 才是「用户点了全不选」。
    await store.update({ enabled: true })
    expect(written[written.length - 1]?.selectionVersion).toBe(QODER_SELECTION_VERSION)

    // 用户真的点了「全不选」之后，再读就是 []（不会被二次迁移翻回 null）。
    await store.update({ enabledModelIds: [] })
    expect(store.status().enabledModelIds).toEqual([])
  })
})
