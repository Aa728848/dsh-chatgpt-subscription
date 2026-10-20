/**
 * 「/video 命令 + 参数面板」的挂载点，由 `src/client/index.tsx` 调用。
 *
 * 挂两样东西：
 *
 * 1. **面板的渲染座位**：一个客户端容器，portal 到 `document.body`。它不挂在任何
 *    会话槽位上——面板是**全局**的，而 `/video` 命令的回调在一段没有 React 树的
 *    代码里；把两者连起来的是这个容器持有的 `open` 状态加一个模块级句柄。
 * 2. **命令本体**：`createVideoCommand` 产出的 action 贡献，注册到
 *    `ctx.commandUi`，与宿主 `ui-message-feedback` 的 `/feedback` 装饰同一形状。
 *
 * ## 为什么命令回调要经过一个句柄
 *
 * 命令的回调是普通函数，不是 React 组件，拿不到 setState。所以容器把自己的
 * `openForm` 登记到一个模块级的可变引用上，命令回调通过它打开面板。容器卸载时
 * 把这个引用清掉（只清自己那一个），回调因此永远调不到一个已卸载的组件。
 *
 * ## 打开面板时顺手读一次输入框
 *
 * 用户常常先写了一句话才想起要用面板。命令回调在这里取一次
 * {@link composerDraftOf}，交给面板当初始的「画面描述」——省掉一次抄写。读不到
 * 就是空串，面板照常以空白打开。
 *
 * ## 注册失败了怎么办
 *
 * 与家族其它模块一致：吞掉、不抛。web shell 在插件 apply 抛错时整页启动失败，
 * 一个外部插件不能因为「宿主这一版没有 commandUi」就把 GUI 带下水。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/video-command-host
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { VideoFormDialog } from './VideoFormDialog.tsx'
import { composerDraftOf, createVideoCommand, fillComposer, fallbackTranslate } from './video-command.ts'
import { workspaceListerFor } from './video-workspace.ts'
import { readVideoDefaults } from './video-defaults-store.ts'
import { normalizeVideoDefaults, type VideoDefaults } from './video-form-rules.ts'

/** 一次「打开表单」请求。 */
interface OpenRequest {
  readonly defaults: VideoDefaults
  readonly seedPrompt: string
}

/** 容器登记给命令回调的那个句柄。 */
type OpenFormHandle = (sessionId: string, defaults: VideoDefaults) => void

/**
 * 当前挂着的容器句柄。
 *
 * 模块级的可变引用是刻意的：命令回调由宿主持有，它没有别的通道能碰到 React 树。
 * 只允许一个值，因为一个浏览器页只有一棵树、一个面板。
 */
let activeHandle: OpenFormHandle | undefined

/**
 * 打开参数面板。
 *
 * 没有容器挂着时什么也不做——插件被禁用、或页面还没挂载时调到这里，静默即可；
 * 抛错只会让一次斜杠菜单点击变成控制台里的一条异常。
 *
 * @param sessionId - 会话 id。
 * @param defaults - 表单起手值。
 */
export function openVideoForm(sessionId: string, defaults: VideoDefaults): void {
  activeHandle?.(sessionId, defaults)
}

/**
 * 构造面板容器。
 *
 * 常驻挂载、`open` 为 false 时渲染出 null，而不是按需创建：请求来自命令回调，
 * 那时组件树已经渲染完了，没有第二次渲染去创建它。
 *
 * @param ctx - 浏览器根上下文；提交时用它把文本写进对应会话的输入框。
 * @returns 一个不需要 props 的组件。
 */
export function createVideoCommandHost(ctx: ClientContext): () => React.JSX.Element | null {
  return function VideoCommandHost(): React.JSX.Element | null {
    const [request, setRequest] = useState<OpenRequest | null>(null)
    // 提交时要知道往哪个会话写；面板只拿到文本，会话 id 留在这里。
    const sessionRef = useRef<string | null>(null)

    const handle = useCallback<OpenFormHandle>((sessionId, defaults) => {
      sessionRef.current = sessionId
      setRequest({
        defaults: normalizeVideoDefaults(defaults),
        // 先写一句话、再叫面板：那句话就是画面描述。
        seedPrompt: composerDraftOf(ctx, sessionId),
      })
    }, [])

    useEffect(() => {
      activeHandle = handle
      return () => {
        // 只清自己那一个：另一次挂载已经换了人，清掉会把新的也一起废掉。
        if (activeHandle === handle) activeHandle = undefined
      }
    }, [handle])

    const close = useCallback(() => { setRequest(null) }, [])

    const submit = useCallback((text: string): boolean => {
      const sessionId = sessionRef.current
      if (sessionId === null) return false
      return fillComposer(ctx, sessionId, text)
    }, [])

    // 目录补全按会话取：工作区根由会话决定，换个会话就是另一棵树。每次打开面板
    // 现取一次，宿主没装 remote 时拿到 undefined，媒体块退回纯手填。
    const listWorkspace = useMemo(
      () => (request === null || sessionRef.current === null
        ? undefined
        : workspaceListerFor(ctx, sessionRef.current)),
      [request],
    )

    return (
      <VideoFormDialog
        open={request !== null}
        onClose={close}
        onSubmit={submit}
        defaults={request?.defaults ?? normalizeVideoDefaults({})}
        seedPrompt={request?.seedPrompt ?? ''}
        listWorkspace={listWorkspace}
        t={fallbackTranslate}
      />
    )
  }
}

/** 宿主 `ctx.commandUi` 的最小注册面。 */
interface CommandUiRegistry {
  register?: (contribution: unknown) => () => void
}

/**
 * 从上下文里取 `commandUi`。
 *
 * 属性读只在 `'commandUi'` 已写进当前 scope 的 `inject` 名单时合法；本插件的静态
 * `inject` 不包含它（以免无 `ui-commands` 的旧宿主卡在 pending），直接读
 * `ctx.commandUi` 会被 Cordis 的属性守卫当场抛错、使整个插件 fiber 落入
 * `failed`。因此这里先试属性（供 `ctx.inject(['commandUi'], scope => …)` 的子
 * scope 与测试替身使用）、失败再退回 `get('commandUi')`。
 */
function commandUiOf(scope: ClientContext): CommandUiRegistry | undefined {
  try {
    const direct = (scope as unknown as { commandUi?: CommandUiRegistry }).commandUi
    if (direct !== undefined) return direct
  } catch {
    // Cordis 拒绝未声明 inject 的属性读：退回 get('commandUi')。
  }
  try {
    return (scope as unknown as { get?: (name: string) => unknown }).get?.('commandUi') as CommandUiRegistry | undefined
  } catch {
    return undefined
  }
}

/**
 * 把 `/video` 命令挂到宿主的命令服务上。
 *
 * 与宿主 `ui-message-feedback` 的 `/feedback` 装饰同一种接线方式：若 `commandUi`
 * 已经在位（或当前是无 `inject` 能力的测试替身），就地注册；若 `commandUi` 晚于
 * 本插件激活，则经 `ctx.inject(['commandUi'], scope => …)` 在它上线时补注册。
 *
 * 注册失败只吞掉：宿主这一版可能没有 `commandUi`（它由 `ui-commands` 提供），一个
 * 可选依赖缺席不该让整个插件 apply 失败。
 *
 * @param ctx - 浏览器根上下文。
 * @returns 卸载函数；服务缺席时是一个空操作。
 */
export function installVideoCommand(ctx: ClientContext): () => void {
  const registerOn = (scope: ClientContext): (() => void) => {
    const commandUi = commandUiOf(scope)
    if (typeof commandUi?.register !== 'function') return () => {}
    try {
      return commandUi.register(createVideoCommand(ctx, {
        openForm: openVideoForm,
        // 每次打开菜单现读：用户可能刚在设置页改过。
        defaults: () => readVideoDefaults(),
        translate: fallbackTranslate,
      }))
    } catch {
      // 一个命令名撞车（宿主已有 /video）就是这里抛的；吞掉比整页启动失败好。
      return () => {}
    }
  }
  const immediate = commandUiOf(ctx)
  const injectService = (ctx as unknown as {
    inject?: (deps: readonly string[], callback: (scope: ClientContext) => void) => { dispose?: () => void } | undefined
  }).inject
  if (typeof immediate?.register === 'function' || typeof injectService !== 'function') {
    return registerOn(ctx)
  }
  const child = injectService.call(ctx, ['commandUi'], (scope) => {
    scope.effect(() => registerOn(scope), 'dsh-minimax-code: /video command')
  })
  return () => {
    child?.dispose?.()
  }
}
