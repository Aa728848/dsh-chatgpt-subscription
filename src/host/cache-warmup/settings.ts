/**
 * 「缓存预热」宿主集成的设置面。
 *
 * 这个文件**刻意不 import 核心**：设置解析必须在这个宿主上的任何状态都能跑——
 * 包括结果投影因为任何原因不可用的时候，设置卡那一行仍然要读得回来。
 *
 * 字段是 volatile 的（见 `src/index.ts` 的 `Config`）：loader 把它解析成活引用交进
 * `apply`，设置卡保存时就地写新值、**不**重挂插件行。所以
 * {@link resolveCacheWarmupSettings} 必须每次用到都重新调，而不是在 apply 时求值
 * 一次存下来——存下来的那一份会让开关在同一个会话里彻底失效。
 *
 * 语义上只有一条保守规则：开关**只影响之后产生的新结果**。已经进入历史的结果，
 * 它的 preview 与 refId 是历史的一部分，不随开关、也不随存储过期而改变
 * （见 `install.ts` 的 post-execute 说明）。
 *
 * @module dsh-chatgpt-subscription/host/cache-warmup/settings
 */

/**
 * profile 里的设置字段名。
 *
 * 设置卡按这个键读写，改名等于让老配置整体失效；测试也用它拼配置对象，避免
 * 「设置里叫 A、解析时读 B」这种只在线上才发现的错位。
 */
export const CACHE_WARMUP_SETTING = 'cacheWarmup'

/**
 * 设置卡上这一行的说明文字。
 *
 * schema（`src/index.ts` 的 `Config`）与设置卡共用同一份文案：两处各写一份，
 * 迟早变成「卡片说只影响新结果、schema 说立刻生效」这种自相矛盾。
 */
export const CACHE_WARMUP_SETTING_DESCRIPTION =
  '启用缓存预热的结果投影：Kimi 线路上可以可靠结构化提取的超大工具结果会被替换成带 ref:// 引用的预览，'
  + '需要原文时由 cache_warmup_result 精确补读。关闭只影响之后产生的新结果，已进入历史的内容不变。'

/** 一次挂载读到的有效设置。 */
export interface CacheWarmupSettings {
  /** 总开关。关闭后新的工具结果原样返回，已有结果与引用不动。 */
  enabled: boolean
}

/** 缺省设置：开启。 */
export const DEFAULT_CACHE_WARMUP_SETTINGS: CacheWarmupSettings = { enabled: true }

/**
 * 设置字段在运行时可能是活引用（volatile）或普通值（手工构造的上下文、测试）。
 *
 * loader 把声明为 `volatile()` 的字段解析成一个 `{ get() }` 活引用，设置保存时
 * 就地写新值并广播 `loader/volatile-update`，**不**重挂插件行；所以这里必须能
 * 跟着引用读到当前值，而不是拿到一份快照。
 */
interface ConfigRef<T> {
  /** 读取当前已提交的值。 */
  get(): T | undefined
}

/** 一个配置字段：活引用或普通值。 */
export type CacheWarmupConfigField<T> = ConfigRef<T> | T | undefined

/** 主入口交给本模块的配置形状（只取本模块认识的那一个字段）。 */
export interface CacheWarmupConfigFields {
  /** 总开关字段。 */
  cacheWarmup?: CacheWarmupConfigField<boolean>
}

/**
 * 读取一个配置字段，沿着 volatile 活引用取当前值。
 * @param field - 字段本身。
 * @returns 当前值，或字段缺失时的 undefined。
 */
export function readCacheWarmupConfigField<T>(field: CacheWarmupConfigField<T>): T | undefined {
  if (field === undefined || field === null) return undefined
  if (typeof field === 'object' && typeof (field as ConfigRef<T>).get === 'function') {
    return (field as ConfigRef<T>).get()
  }
  return field as T
}

/**
 * 解析一次读取的有效设置。
 *
 * 每次调用都重读活引用，因此设置保存后立刻生效（对**之后**的新结果生效；历史
 * 结果不重新投影，见模块说明）。
 * @param config - 主入口收到的插件配置（活引用或普通值）。
 * @returns 生效的开关。
 */
export function resolveCacheWarmupSettings(config?: CacheWarmupConfigFields): CacheWarmupSettings {
  const enabled = readCacheWarmupConfigField(config?.cacheWarmup)
  // 只有明确的 `false` 才关：字段缺失、形状不认识（比如配置里写了字符串）都按
  // 缺省处理。一个存心写错的配置值不该静默关掉一个默认开启的功能。
  return { enabled: enabled !== false }
}
