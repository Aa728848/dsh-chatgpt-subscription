/**
 * 工作区目录列表：给媒体块里的 `@` 补全用。
 *
 * ## 为什么这里能列目录
 *
 * 宿主的 `remote.workspaceFiles` 除了 `readBytes` 还有一个 `list(sessionId, path, signal)`
 * （`api/workspace-files/src/index.ts:304`，生成的客户端声明在
 * `lib/typert.remote-client.d.ts:15`），返回该目录的直接子项与**工作区相对路径**。
 * 那正是对话框里 `@` 引用文件时用的那套坐标，所以拿去补全不用做任何换算。
 *
 * 与取字节一样，这个服务按需解析、**可选**：宿主没装、或 remote 尚未挂载时返回
 * `undefined`，媒体块会退化成「只能手填路径」，而不是报错。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/video-workspace
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { RemoteResult } from './video-slots.ts'

/** 目录里的一项（`WorkspaceDirectoryEntry` 的窄化副本）。 */
export interface WorkspaceEntry {
  /** 文件名或目录名。 */
  readonly name: string
  /** 相对工作区根的路径；拼在已列出的目录后面。 */
  readonly path: string
  /** 是否目录；目录在补全里带一个尾斜杠，便于继续下钻。 */
  readonly directory: boolean
}

/** 列一个目录的直接子项；路径相对工作区根，空串是工作区根。 */
export type WorkspaceLister = (path: string) => Promise<readonly WorkspaceEntry[]>

/** `remote.workspaceFiles.list` 的最小形状（两代宿主同名同参）。 */
interface WorkspaceFilesListFace {
  readonly list?: (
    sessionId: string,
    path: string,
    signal?: AbortSignal,
  ) => Promise<RemoteResult<{ readonly path: string, readonly entries: readonly { name: string, type: string }[] }>>
}

/** 从上下文里取 `remote.workspaceFiles`；取不到就是 undefined。 */
function resolveWorkspaceFiles(ctx: ClientContext): WorkspaceFilesListFace | undefined {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get?.bind(ctx)
  if (get === undefined) {
    // 测试替身没有 `get`：退回到普通属性读。
    try {
      const remote = (ctx as unknown as { remote?: { workspaceFiles?: WorkspaceFilesListFace } }).remote
      return typeof remote?.workspaceFiles?.list === 'function' ? remote.workspaceFiles : undefined
    } catch {
      return undefined
    }
  }
  try {
    const direct = get('remote.workspaceFiles') as WorkspaceFilesListFace | undefined
    if (typeof direct?.list === 'function') return direct
  } catch {
    // Cordis 拒绝未声明的属性读：继续试下一条路径。
  }
  try {
    const remote = get('remote') as { workspaceFiles?: WorkspaceFilesListFace } | undefined
    return typeof remote?.workspaceFiles?.list === 'function' ? remote.workspaceFiles : undefined
  } catch {
    return undefined
  }
}

/**
 * 为一条会话准备目录列表器。
 *
 * 返回的列表器**不抛异常**：远端失败、服务缺席、目录不存在都收敛成空数组——补全
 * 少几行是可接受的，让一次按键变成一条控制台异常不是。
 *
 * @param ctx - 浏览器根上下文。
 * @param sessionId - 决定工作区根的会话 id。
 * @returns 列表器；宿主没有这个能力时为 undefined。
 */
export function workspaceListerFor(ctx: ClientContext, sessionId: string): WorkspaceLister | undefined {
  const workspaceFiles = resolveWorkspaceFiles(ctx)
  const list = workspaceFiles?.list?.bind(workspaceFiles)
  if (list === undefined) return undefined
  return async (path: string): Promise<readonly WorkspaceEntry[]> => {
    try {
      const result = await list(sessionId, path)
      if (result.ok !== true) return []
      const base = result.value.path
      return result.value.entries.map(entry => ({
        name: entry.name,
        path: base === '' ? entry.name : base + '/' + entry.name,
        directory: entry.type === 'directory',
      }))
    } catch {
      return []
    }
  }
}

/** 在一条已命中的路径后面拼一个子项，处理根目录那一档。 */
export function joinWorkspacePath(base: string, name: string): string {
  return base === '' ? name : base + '/' + name
}
