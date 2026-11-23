/**
 * 开源模型家族专属静态尾部纪律注入器。
 *
 * 与 `deepseek-v41-flash/discipline.ts` 保持完全一致的缓存与隔离不变量：
 * 1. 仅在 `matchOpenModelScope(scope, context.modelSelection)` 命中且该画像声明了
 *    `disciplineText` 时注入；DeepSeek V4.1 Flash 与全部闭源模型收到原引用，0 字节改动；
 * 2. 正文为编译期常量（`interpolate: false`），同一会话逐字节恒定，0% 破前缀缓存；
 * 3. 始终追加在系统提示词**最末尾**（紧跟 `tools:sdk` 之后），不移动前方人设与工具表。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/open-models/discipline
 */
import { matchOpenModelScope } from './profiles.ts'

interface AssembledSectionLike {
  readonly name?: unknown
  readonly text?: unknown
  readonly interpolate?: unknown
}

interface PresentationLike {
  readonly sections?: readonly AssembledSectionLike[]
  readonly [key: string]: unknown
}

interface AssembleContextLike {
  readonly scope?: unknown
  readonly agent?: unknown
  readonly modelSelection?: unknown
}

interface EventHostLike {
  on?(name: string, listener: (...args: never[]) => unknown, options?: unknown): unknown
  off?(name: string, listener: (...args: never[]) => unknown): unknown
}

export interface OpenModelDisciplineOptions {
  /** 活引用读取器；返回 false 时彻底旁路。默认 true。 */
  readonly enabled?: () => boolean
}

function isEnabled(read: (() => boolean) | undefined): boolean {
  if (read === undefined) return true
  try {
    return read() !== false
  } catch {
    return false
  }
}

function subscribeAssemble(
  host: EventHostLike | undefined,
  listener: (
    assembly: PresentationLike,
    context: AssembleContextLike,
    next: () => Promise<PresentationLike>,
  ) => Promise<PresentationLike>,
): (() => void) | undefined {
  if (typeof host?.on !== 'function') return undefined
  const attempts: readonly unknown[] = [{ global: true }, undefined]
  for (const options of attempts) {
    try {
      const handle = options === undefined
        ? host.on('system-prompt/assemble', listener as never)
        : host.on('system-prompt/assemble', listener as never, options)
      if (typeof handle === 'function') return handle as () => void
      if (handle !== null && typeof handle === 'object' && typeof (handle as { dispose?: unknown }).dispose === 'function') {
        return () => { (handle as { dispose(): void }).dispose() }
      }
      return () => {
        try {
          host.off?.('system-prompt/assemble', listener as never)
        } catch {
          // 忽略已移除监听器。
        }
      }
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * 安装面向各开源模型家族的静态尾部纪律注入器。
 */
export function installOpenModelDiscipline(
  ctx: unknown,
  options: OpenModelDisciplineOptions = {},
): () => void {
  const host = typeof ctx === 'object' && ctx !== null ? (ctx as EventHostLike) : undefined
  let disposed = false

  const onAssemble = async (
    _assembly: PresentationLike,
    context: AssembleContextLike,
    next: () => Promise<PresentationLike>,
  ): Promise<PresentationLike> => {
    const result = await next()
    if (disposed || !isEnabled(options.enabled)) return result
    const scope = context?.scope ?? context?.agent
    const matched = matchOpenModelScope(scope, context?.modelSelection)
    if (matched === undefined) return result
    const { disciplineSectionName, disciplineText } = matched.profile
    if (disciplineSectionName === undefined || disciplineText === undefined) return result

    const sections = Array.isArray(result?.sections) ? result.sections : undefined
    if (sections === undefined) return result
    if (sections.some(section => section?.name === disciplineSectionName)) return result

    const entry: AssembledSectionLike = {
      name: disciplineSectionName,
      text: disciplineText,
      interpolate: false,
    }
    return { ...result, sections: [...sections, entry] }
  }

  const off = subscribeAssemble(host, onAssemble)
  return () => {
    if (disposed) return
    disposed = true
    try {
      off?.()
    } catch {
      // 卸载期忽略单点失败。
    }
  }
}
