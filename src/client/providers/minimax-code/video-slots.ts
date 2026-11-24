/**
 * 本线路用到的槽位声明与浏览器侧服务面。
 *
 * `tool.call.toolview` 不在这里重复声明：它由本插件已安装的 ui-tool 合并进
 * `SlotMap`，同一格写两次形状不同就是编译错误。
 *
 * `sidebar.right.tab.document` 由 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`
 * 提供，而那个包**不是本插件的依赖**（`package.json` 的 `dsh.client.inject` 只声明
 * 运行期顺序，不是编译期依赖）。为了两行注册去依赖整个文档预览包，等于把一个可选
 * 能力变成硬依赖，所以这里按平台同形把它**声明**出来——运行语义完全由平台的槽位
 * 注册表决定，这里只是让 `register` / `inject` 的实参过类型检查。
 * 这与 `../progress-updates/contracts.ts` 对 `sidebar.right.pane.tab` 的处理一致。
 *
 * 刻意**不**合并 cordis 的 `Context`：只要 `src/client/**` 里出现一条那样的
 * augmentation，cordis 自己的 `interface Context extends Pick<Fiber, 'effect'>`
 * 就会整片失效（`../progress-updates/contracts.ts` 末尾记了这个坑）。
 * 所以 `documentPreviews` / `remote` 一律经 `ctx.get(name)` 取回再窄化。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/video-slots
 */

/** 一份 `DocumentPreviewDefinition` 在运行期的形状（宿主 `document/registry.ts` 同形）。 */
export interface DocumentPreviewRegistration {
  /** 唯一实现名，同时是文档槽的键。 */
  readonly id: string
  /** 认领的文件后缀（不带点）。 */
  readonly extensions: readonly string[]
  /** 其中字节不可当文本读的后缀，必须是 `extensions` 的子集。 */
  readonly binaryExtensions?: readonly string[]
  /** 外部实现优先于内置实现。 */
  readonly priority?: 'builtin' | 'extension'
  /** 页签上的实现名，渲染时求值。 @returns 可见名称。 */
  readonly title: () => string
  /** 内容下发方式。 */
  readonly loading: 'text-pages' | 'bytes-complete' | 'renderer'
  /** 是否消费文档的换行偏好。 */
  readonly wrap?: boolean
}

/** `ctx.documentPreviews` 的注册面。 */
export interface DocumentPreviewRegistryService {
  /**
   * 注册一个实现。
   * @param definition - 静态声明；`binaryExtensions` 越界或 id 重复都会抛。
   * @returns 幂等卸载函数。
   */
  register(definition: DocumentPreviewRegistration): () => void
}

/**
 * 一次远端调用声明的失败。
 *
 * 形状与宿主的 `RemoteError` 一致：稳定的 `code`、一句 `message`，以及该码
 * 专属的结构化 `details`。判定只看 `code`，不看 `message` 里的英文。
 */
export interface RemoteFailure {
  /** 稳定的失败码，如 `workspace-file/too-large`。 */
  readonly code: string
  /** 人读的诊断信息。 */
  readonly message?: string
  /** 该码专属的结构化载荷（如 too-large 的 `limit`）。 */
  readonly details?: unknown
}

/**
 * 一次远端调用的结果：**成功给值，失败给原因**。
 *
 * 远端调用不抛异常——宿主把它声明的失败装进结果里（见
 * `@deepseek-ai/dsh-typert-protocol` 的 `RemoteResult`）。所以读字节的人
 * 必须先看 `ok`，再去 `value`；直接读 `(await call()).data` 拿到的是
 * `undefined`，而界面会把「没拿到字节」显示成「一直在读」。
 */
export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteFailure }

/**
 * 宿主交回来的字节载荷。
 *
 * **两代形状**：≤0.1.6 的宿主把字节编成 base64 字符串（宿主
 * `readAll`/`readBytes` 返回 `data: string`），≥0.1.7 的宿主直接给
 * `Uint8Array`（`packages/api/workspace-files/src/types.ts` 的
 * `WorkspaceFileBytes.data`）。本插件支持两代，所以两种都认。
 */
export type RemoteBytes = Uint8Array | string

/**
 * 本插件用到的 `remote.workspaceFiles` 面。
 *
 * 与宿主 `ui-sidebar-documentpreview/src/client/rpc.ts` 的
 * `WorkspaceFilesReadRemote` 同形：不传 `range` 就是整文件读取（上限由宿主
 * `maxFileBytes` 决定），`baseFile` 用于把相对路径解析到基准文件目录。
 *
 * `readAll` 是 **≤0.1.6 那一代**的整文件读取法（宿主在 0.1.7 把它并进了
 * `readBytes` 的 `options` 形态）。留着它是为了旧世代仍能整文件取字节：
 * 那一代的 `readBytes` 收的是**字节窗口**而不是 `options`，拿它读整文件
 * 只会读到 `maxBytes` 那么多。
 */
export interface WorkspaceFilesRemote {
  readonly workspaceFiles: {
    /**
     * 读整段文件字节（≥0.1.7 那一代的形态）。
     * @param sessionId - 决定工作区根的会话 id。
     * @param path - 绝对路径，或相对该会话工作区根的路径。
     * @param options - 可选的字节窗口与基准文件；本实现不传。
     * @param signal - 取消信号。
     * @returns 结果：成功时 `value.data` 是字节，失败时 `error` 带原因码。
     */
    readBytes(
      sessionId: string,
      path: string,
      options: { readonly baseFile?: string, readonly range?: { readonly offset?: number, readonly length?: number } },
      signal?: AbortSignal,
    ): Promise<RemoteResult<{ readonly data: RemoteBytes }>>
    /**
     * 读整段文件字节（≤0.1.6 那一代的形态；≥0.1.7 已无此方法）。
     * @param sessionId - 决定工作区根的会话 id。
     * @param path - 绝对路径，或相对该会话工作区根的路径。
     * @param signal - 取消信号。
     * @returns 结果：成功时 `value.data` 是 base64 字符串，失败时带原因码。
     */
    readAll?(
      sessionId: string,
      path: string,
      signal?: AbortSignal,
    ): Promise<RemoteResult<{ readonly data: RemoteBytes }>>
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * 文档正文，按注册的实现 id 分发。本渲染器只消费地址与注入的取字节通道，
     * 所以只声明驱动 `register` / `inject` 过类型检查的这两轴。
     */
    'sidebar.right.tab.document': { kind: 'keyed', scope: 'session' }
  }
}
