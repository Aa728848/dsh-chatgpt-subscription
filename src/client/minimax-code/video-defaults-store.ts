/**
 * 「视频默认参数」的浏览器侧存储。
 *
 * ## 为什么存在浏览器里，而不是 `$DSH_HOME/storages`
 *
 * 这份数据是**表单的初始值**，不是凭据、不是配额、也不影响任何一次请求的内容：
 * 用户没打开设置页时它什么也不做，打开 `/video` 时它只决定三个下拉框的起手值。
 * 存到宿主就要新开一条路由、一个新文件和一套平台加密后端，而那条路由的每一个
 * 读者都是同一个浏览器的同一个页面。
 *
 * 对照的是**生成历史**：那个必须落在宿主，因为写它的是宿主（视频工具在生成成功
 * 之后落一行），浏览器根本没有那次事件。默认参数相反，它是纯 UI 偏好。
 *
 * ## 读不到就当没有
 *
 * localStorage 在三种情况下会抛或返回垃圾：隐私模式下禁用、被别的代码写坏、以及
 * 存储配额满。三种都退化成「一份出厂默认」，而不是让设置页打不开——这是整个仓库
 * 对可选依赖的一贯处理（见 `progress-updates/index.ts` 的 `serviceOf`）。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/video-defaults-store
 */

import { normalizeVideoDefaults, type VideoDefaults } from './video-form-rules.ts'

/** localStorage 的键。带命名空间前缀，避免与宿主其它插件的键撞名。 */
export const VIDEO_DEFAULTS_STORAGE_KEY = 'dsh-minimax-code.video-defaults'

/** 最小可用的 storage 形状：测试注入一个假的，不必造整个 window。 */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * 取浏览器 localStorage，取不到就是 undefined。
 *
 * 走 `globalThis` 而不是直接写 `localStorage`：这段代码也会在 jsdom 与 SSR 风格的
 * 渲染里跑，那种环境下这个全局可能根本不存在。
 *
 * @returns storage，或 undefined。
 */
export function browserStorage(): KeyValueStorage | undefined {
  try {
    const storage = (globalThis as { localStorage?: KeyValueStorage }).localStorage
    return typeof storage?.getItem === 'function' ? storage : undefined
  } catch {
    // Safari 隐私模式在这里就抛 SecurityError。
    return undefined
  }
}

/**
 * 读一份默认参数。
 *
 * 任何解析失败都退化成出厂默认，并且**不写回**：一个被写坏的值留在原处，用户下一次
 * 保存就覆盖掉它了，中途重建一份没有意义。
 *
 * @param storage - 存储；缺省取浏览器 localStorage。
 * @returns 自洽的默认参数（见 `normalizeVideoDefaults`）。
 */
export function readVideoDefaults(storage: KeyValueStorage | undefined = browserStorage()): VideoDefaults {
  if (storage === undefined) return normalizeVideoDefaults({})
  try {
    const raw = storage.getItem(VIDEO_DEFAULTS_STORAGE_KEY)
    if (raw === null || raw.trim() === '') return normalizeVideoDefaults({})
    return normalizeVideoDefaults(JSON.parse(raw) as unknown)
  } catch {
    return normalizeVideoDefaults({})
  }
}

/**
 * 写一份默认参数。
 *
 * 写入被拒绝（配额满、隐私模式）时**返回 false 而不是抛**：设置页要把这件事显示成
 * 一句提示，而不是让一次点击把整页带崩。
 *
 * @param defaults - 要保存的值。
 * @param storage - 存储；缺省取浏览器 localStorage。
 * @returns 是否真的写进去了。
 */
export function writeVideoDefaults(
  defaults: VideoDefaults,
  storage: KeyValueStorage | undefined = browserStorage(),
): boolean {
  if (storage === undefined) return false
  try {
    storage.setItem(VIDEO_DEFAULTS_STORAGE_KEY, JSON.stringify(defaults))
    return true
  } catch {
    return false
  }
}
