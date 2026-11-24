/**
 * 「子智能体」设置卡的客户端入口：注册进插件页的 plugins.item 槽位。
 *
 * ## 为什么既设 priority: -10 又包一层 entries('plugins.item') 去重
 *
 * 1. `entriesOfSlot('plugins.item')`（渲染器实际绘制组件时用的投影）会按同一 `id`
 *    选 `priority` 最小的那一条，因此 `priority: -10` 让本卡覆盖宿主自带的 `priority: 0`。
 * 2. 但 `ui-plugin-manager` 的 `configLedgerSource` 在生成「内置插件配置」卡片列表时，
 *    调用的是未做 cell 去重的原始账本 `ctx.slots.entries('plugins.item')`！如果账本里
 *    同时存在两条 `id: 'subagent'`，列表页就会画出两张「子智能体」入口卡片。
 * 3. 因此这里在槽位服务实例（或其原型）上对 `entries('plugins.item')` 做一层幂等去重包装：
 *    当同一个 `id` 有多条注册时，只保留赢下该 cell 的第一条（由于 `rec.entries` 已按
 *    `priority` 升序排好，第一条就是 `priority` 最低的胜出者），并在本插件卸载时原样还原。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/subagent
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { SubagentCard } from './SubagentCard.tsx'
import { NS_SUBAGENT } from './locales.ts'
import {
  SUBAGENT_LIMITS_NS,
  SUBAGENT_MODEL_SELECTION_NS,
  SubagentSettingsController,
  readSubagentCatalog,
  readSubagentPreferences,
  writeSubagentPreferences,
  type SubagentConfigForms,
  type SubagentLimitsSettings,
  type SubagentModelSelectionSettings,
} from './subagent-card-controller.ts'

/** 本卡在插件页里的槽位 id；与宿主同名，这是遮蔽的前提。 */
export const SUBAGENT_SLOT_ID = 'subagent'

/** 在 plugins.item 里的排序位。 */
export const SUBAGENT_SLOT_ORDER = 10

/** 遮蔽宿主同 id 卡片的优先级（list 槽位：同一 cell 上最低的那条渲染）。 */
export const SUBAGENT_SLOT_PRIORITY = -10

function serviceOf(ctx: ClientContext, name: string): unknown {
  try {
    return (ctx as unknown as { get?: (service: string) => unknown }).get?.(name)
  } catch {
    return undefined
  }
}

function isConfigForms(value: unknown): value is SubagentConfigForms {
  if (typeof value !== 'object' || value === null) return false
  return typeof (value as { get?: unknown }).get === 'function'
}

interface StoredSlotEntryLike {
  readonly options?: { readonly id?: string; readonly priority?: number; readonly order?: number }
}

/**
 * 为 `ctx.slots.entries('plugins.item')` 安装按 `id` 的 cell 去重视图，
 * 避免 `configLedgerSource` 读原始账本时把被遮蔽的同 id 卡片也列出来。
 */
function installPluginsItemLedgerDedup(slots: unknown): () => void {
  if (typeof slots !== 'object' || slots === null) return () => {}
  const target = slots as {
    entries?: (key: string) => readonly StoredSlotEntryLike[]
    entriesOfSlot?: (key: string) => readonly StoredSlotEntryLike[]
  }
  if (typeof target.entries !== 'function') return () => {}
  const originalEntries = target.entries
  let holder: object = target
  let descriptor = Object.getOwnPropertyDescriptor(holder, 'entries')
  while (descriptor === undefined) {
    const proto = Object.getPrototypeOf(holder) as object | null
    if (proto === null) break
    holder = proto
    descriptor = Object.getOwnPropertyDescriptor(holder, 'entries')
  }
  if (descriptor !== undefined && !descriptor.configurable && !descriptor.writable) {
    return () => {}
  }

  let cachedRaw: readonly StoredSlotEntryLike[] | undefined
  let cachedDeduped: readonly StoredSlotEntryLike[] = []

  const wrapped = function (this: unknown, key: string): readonly StoredSlotEntryLike[] {
    const raw = originalEntries.call(this ?? slots, key)
    if (key !== 'plugins.item' || !Array.isArray(raw) || raw.length <= 1) return raw
    if (raw === cachedRaw) return cachedDeduped
    const seenIds = new Set<string>()
    const deduped: StoredSlotEntryLike[] = []
    for (const entry of raw) {
      const id = entry?.options?.id
      if (typeof id === 'string' && id.length > 0) {
        if (seenIds.has(id)) continue
        seenIds.add(id)
      }
      deduped.push(entry)
    }
    deduped.sort((a, b) => (a.options?.order ?? 0) - (b.options?.order ?? 0))
    cachedRaw = raw
    cachedDeduped = deduped
    return cachedDeduped
  }

  try {
    Object.defineProperty(target, 'entries', {
      value: wrapped,
      configurable: true,
      writable: true,
    })
  } catch {
    return () => {}
  }

  return () => {
    try {
      if ((target as { entries?: unknown }).entries === wrapped) {
        delete (target as { entries?: unknown }).entries
        if ((target as { entries?: unknown }).entries !== originalEntries) {
          Object.defineProperty(target, 'entries', {
            value: originalEntries,
            configurable: true,
            writable: true,
          })
        }
      }
    } catch {
      // ignore restore failure
    }
  }
}

/**
 * 把本卡注册进插件页。
 */
export function installSubagentSettingsCard(ctx: ClientContext): () => void {
  const forms = serviceOf(ctx, 'configForms')
  if (!isConfigForms(forms)) return () => {}

  const limits = forms.get<SubagentLimitsSettings>(SUBAGENT_LIMITS_NS)
  const modelSelection = forms.get<SubagentModelSelectionSettings>(SUBAGENT_MODEL_SELECTION_NS)
  const controller = new SubagentSettingsController({
    limits,
    modelSelection,
    loadCatalog: () => readSubagentCatalog(ctx as unknown as { get(name: string): unknown }),
    loadPreferences: readSubagentPreferences,
    savePreferences: writeSubagentPreferences,
  })
  ctx.effect(() => () => { controller.dispose() }, 'dsh-subagent-settings: form subscriptions')

  const remote = serviceOf(ctx, 'remote') as { $on?: (event: string, cb: () => void) => () => void } | undefined
  if (typeof remote?.$on === 'function') {
    const $on = remote.$on.bind(remote)
    ctx.effect(() => $on('llm/adapters-updated', () => { controller.refreshCatalog() }), 'dsh-subagent-settings: adapter invalidations')
    ctx.effect(() => $on('settings/document-updated', () => { controller.refreshCatalog() }), 'dsh-subagent-settings: settings invalidations')
  }
  const on = (ctx as unknown as { on?: (event: string, cb: () => void) => () => void }).on
  if (typeof on === 'function') {
    ctx.effect(() => on.call(ctx, 'connection/reset', () => { controller.resetConnection() }), 'dsh-subagent-settings: connection reset')
  }

  const face = controller.inject()

  const register = (): () => void => {
    try {
      const restoreEntries = installPluginsItemLedgerDedup(ctx.slots)
      const disposeInject = ctx.slots.inject('plugins.item', () => {
        try {
          return ctx.slots.register({
            name: 'plugins.item',
            id: SUBAGENT_SLOT_ID,
            order: SUBAGENT_SLOT_ORDER,
            priority: SUBAGENT_SLOT_PRIORITY,
            label: () => {
              try {
                return ctx.locale.bind(NS_SUBAGENT)('subagentTitle')
              } catch {
                return '子智能体'
              }
            },
            locale: NS_SUBAGENT,
            inject: () => face,
          }, SubagentCard as never)
        } catch {
          return () => {}
        }
      })
      return () => {
        disposeInject()
        restoreEntries()
      }
    } catch {
      return () => {}
    }
  }

  if (typeof forms.whileServed === 'function') {
    try {
      return forms.whileServed(
        [SUBAGENT_LIMITS_NS, SUBAGENT_MODEL_SELECTION_NS],
        () => register(),
      )
    } catch {
      // fallback
    }
  }
  return register()
}
