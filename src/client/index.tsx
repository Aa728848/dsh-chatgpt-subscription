import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { ANTIGRAVITY_IMAGE_TOOL_NAME, CODEX_IMAGE_TOOL_NAME } from '../compat.ts'
import { CodexComposerQuota } from './CodexComposerQuota.tsx'
import { CodexImageToolView, type ImageLoader } from './CodexImageToolView.tsx'
import { ProviderHubSection } from './ProviderHubSection.tsx'
import { SubscriptionApi } from './api.ts'
import { dictionaries, NS, type LocaleKey } from './locales.ts'
import { installStyles } from './styles.ts'
import { installHubStyles } from './hub/hub-styles.ts'
import { installModelChecklistStyles } from './common/model-checklist-styles.ts'
import { installAntigravityStyles } from './antigravity/styles.ts'
import { installPoolStyles } from './common/styles.ts'
import { dictionaries as antigravityDicts, NS_ANTIGRAVITY, type AntigravityLocaleKey } from './antigravity/locales.ts'
import { AntigravityComposerQuota } from './antigravity/AntigravityComposerQuota.tsx'
import { ClaudeComposerQuota } from './claude/ClaudeComposerQuota.tsx'
import { dictionaries as claudeDicts, NS_CLAUDE, type ClaudeLocaleKey } from './claude/locales.ts'
import { installClaudeStyles } from './claude/styles.ts'
import { CommandCodeComposerQuota } from './command-code/CommandCodeComposerQuota.tsx'
import { dictionaries as commandCodeDicts, NS_COMMAND_CODE, type CommandCodeLocaleKey } from './command-code/locales.ts'
import { KimiCodeComposerQuota } from './kimi-code/KimiCodeComposerQuota.tsx'
import { dictionaries as kimiCodeDicts, NS_KIMI_CODE, type KimiCodeLocaleKey } from './kimi-code/locales.ts'
import { installKimiCodeStyles } from './kimi-code/styles.ts'
import { MinimaxCodeComposerQuota } from './minimax-code/MinimaxCodeComposerQuota.tsx'
import { MinimaxVideoDocumentBody } from './minimax-code/MinimaxVideoDocumentBody.tsx'
import { MinimaxVideoToolView } from './minimax-code/MinimaxVideoToolView.tsx'
import { MINIMAX_VIDEO_PREVIEW_ID, minimaxVideoPreviewDefinition } from './minimax-code/document-preview.ts'
import { dictionaries as minimaxCodeDicts, NS_MINIMAX_CODE, type MinimaxCodeLocaleKey } from './minimax-code/locales.ts'
import { installMinimaxCodeStyles } from './minimax-code/styles.ts'
import { MINIMAX_VIDEO_TOOL_NAME, type ReadVideoBytes } from './minimax-code/video-contract.ts'
import type { DocumentPreviewRegistryService, WorkspaceFilesRemote } from './minimax-code/video-slots.ts'
import { WorkBuddyComposerQuota } from './workbuddy/WorkBuddyComposerQuota.tsx'
import { dictionaries as workBuddyDicts, NS_WORKBUDDY, type WorkBuddyLocaleKey } from './workbuddy/locales.ts'
import { installWorkBuddyStyles } from './workbuddy/styles.ts'
import { GlmCodingPlanComposerQuota } from './glm-coding-plan/GlmCodingPlanComposerQuota.tsx'
import { dictionaries as glmCodingPlanDicts, NS_GLM_CODING_PLAN, type GlmCodingPlanLocaleKey } from './glm-coding-plan/locales.ts'
import { installGlmCodingPlanStyles } from './glm-coding-plan/styles.ts'
import { dictionaries as ollamaDicts, NS_OLLAMA, type OllamaLocaleKey } from './ollama/locales.ts'
import { StepCodeComposerQuota } from './step-code/StepCodeComposerQuota.tsx'
import { dictionaries as stepCodeDicts, NS_STEP_CODE, type StepCodeLocaleKey } from './step-code/locales.ts'
import { installStepCodeStyles } from './step-code/styles.ts'
import { setupMermaidObserver } from './mermaid/renderer.ts'
import { createVideoCommandHost, installVideoCommand } from './minimax-code/video-command-host.tsx'
import { installProgressUpdatesClient } from './progress-updates/index.ts'
import { installProgressUpdatesStyles } from './progress-updates/styles.ts'
import { dictionaries as progressUpdatesDicts, NS_PROGRESS_UPDATES, type ProgressUpdatesLocaleKey } from './progress-updates/locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /**
   * Every namespace this plugin registers, typed by that line's own dictionary.
   *
   * These were `any`, which made a renamed or misspelled key invisible to the
   * compiler: the card rendered the key name itself and only a human noticed.
   * Each line exports its key union beside its dictionaries, so this map is now
   * the compile-time half of the locale contract.
   */
  interface LocaleNamespaceMap {
    'dsh-chatgpt-subscription': LocaleKey
    'dsh-antigravity': AntigravityLocaleKey
    'dsh-claude': ClaudeLocaleKey
    'dsh-command-code': CommandCodeLocaleKey
    'dsh-kimi-code': KimiCodeLocaleKey
    'dsh-minimax-code': MinimaxCodeLocaleKey
    'dsh-workbuddy': WorkBuddyLocaleKey
    'dsh-glm-coding-plan': GlmCodingPlanLocaleKey
    'dsh-ollama': OllamaLocaleKey
    'dsh-step-code': StepCodeLocaleKey
    'dsh-progress-updates': ProgressUpdatesLocaleKey
  }
}

export const inject = [
  'slots',
  'locale',
  'modelDirectories',
  'conversation',
  'sessions',
  'remote',
  'remote.session',
]

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-chatgpt-subscription: dictionaries')
  ctx.effect(() => installStyles(), 'dsh-chatgpt-subscription: styles')
  ctx.effect(() => {
    installHubStyles()
    installModelChecklistStyles()
    return () => {}
  }, 'dsh-chatgpt-subscription: hub styles')
  ctx.effect(() => ctx.locale.register(NS_ANTIGRAVITY, antigravityDicts), 'dsh-antigravity: dictionaries')
  ctx.effect(() => {
    installAntigravityStyles()
    return () => {}
  }, 'dsh-antigravity: styles')
  ctx.effect(() => ctx.locale.register(NS_CLAUDE, claudeDicts), 'dsh-claude: dictionaries')
  ctx.effect(() => {
    installClaudeStyles()
    return () => {}
  }, 'dsh-claude: styles')
  ctx.effect(() => ctx.locale.register(NS_COMMAND_CODE, commandCodeDicts), 'dsh-command-code: dictionaries')
  ctx.effect(() => ctx.locale.register(NS_KIMI_CODE, kimiCodeDicts), 'dsh-kimi-code: dictionaries')
  ctx.effect(() => {
    installKimiCodeStyles()
    return () => {}
  }, 'dsh-kimi-code: styles')
  ctx.effect(() => ctx.locale.register(NS_MINIMAX_CODE, minimaxCodeDicts), 'dsh-minimax-code: dictionaries')
  ctx.effect(() => {
    installMinimaxCodeStyles()
    return () => {}
  }, 'dsh-minimax-code: styles')
  ctx.effect(() => ctx.locale.register(NS_WORKBUDDY, workBuddyDicts), 'dsh-workbuddy: dictionaries')
  ctx.effect(() => ctx.locale.register(NS_GLM_CODING_PLAN, glmCodingPlanDicts), 'dsh-glm-coding-plan: dictionaries')
  ctx.effect(() => {
    installGlmCodingPlanStyles()
    return () => {}
  }, 'dsh-glm-coding-plan: styles')
  ctx.effect(() => ctx.locale.register(NS_OLLAMA, ollamaDicts), 'dsh-ollama: dictionaries')
  ctx.effect(() => {
    installWorkBuddyStyles()
    return () => {}
  }, 'dsh-workbuddy: styles')
  ctx.effect(() => ctx.locale.register(NS_PROGRESS_UPDATES, progressUpdatesDicts), 'dsh-progress-updates: dictionaries')
  ctx.effect(() => {
    installProgressUpdatesStyles()
    return () => {}
  }, 'dsh-progress-updates: styles')
  ctx.effect(() => ctx.locale.register(NS_STEP_CODE, stepCodeDicts), 'dsh-step-code: dictionaries')
  ctx.effect(() => {
    installStepCodeStyles()
    return () => {}
  }, 'dsh-step-code: styles')
  // Badge variants the shared account-pool card adds on top of each provider's
  // own stylesheet; additive, so it never restyles an existing tab.
  ctx.effect(() => {
    installPoolStyles()
    return () => {}
  }, 'dsh-chatgpt-subscription: pool styles')
  ctx.effect(() => setupMermaidObserver(), 'dsh-mermaid: observer')

  const t = ctx.locale.bind(NS)

  const handleModelDirectoryReload = () => {
    try {
      const conv = ctx.conversation as unknown as { activeSessionId?: string; currentSessionId?: string; activeId?: string }
      const activeSessionId = conv?.activeSessionId || conv?.currentSessionId || conv?.activeId
      if (activeSessionId && ctx.modelDirectories) {
        const dir = ctx.modelDirectories.directoryFor(activeSessionId as any)
        void dir?.load?.().catch?.(() => undefined)
      }
    } catch {
      // best-effort
    }
  }

  // One sidebar entry hosts every subscription provider behind tabs instead
  // of registering a separate settings page per provider.
  const ProviderHubSectionWrapper: React.FC<React.ComponentProps<typeof ProviderHubSection>> = (props) => {
    // The hub reuses the refresh callback contract so a model toggle in any
    // provider tab repaints the conversation model picker.
    return <ProviderHubSection {...props} onModelChange={handleModelDirectoryReload} />
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'subscription-hub',
    order: 45,
    label: () => t('hubTitle'),
    locale: NS,
  }, ProviderHubSectionWrapper))

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'codex-subscription-quota', order: 35, locale: NS,
    inject: (sessionId) => composerBadgeInject(ctx, sessionId, { withApi: true }),
  }, CodexComposerQuota))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'antigravity-quota', order: 36, locale: NS_ANTIGRAVITY,
    inject: (sessionId) => composerBadgeInject(ctx, sessionId),
  }, AntigravityComposerQuota))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'command-code-quota', order: 37, locale: NS_COMMAND_CODE,
    inject: (sessionId) => composerBadgeInject(ctx, sessionId),
  }, CommandCodeComposerQuota))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'kimi-code-quota', order: 38, locale: NS_KIMI_CODE,
    inject: (sessionId) => composerBadgeInject(ctx, sessionId),
  }, KimiCodeComposerQuota))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'workbuddy-quota', order: 39, locale: NS_WORKBUDDY,
    inject: (sessionId) => composerBadgeInject(ctx, sessionId),
  }, WorkBuddyComposerQuota))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'minimax-code-quota', order: 40, locale: NS_MINIMAX_CODE,
    inject: (sessionId) => composerBadgeInject(ctx, sessionId),
  }, MinimaxCodeComposerQuota))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'claude-quota', order: 41, locale: NS_CLAUDE,
    inject: (sessionId) => composerBadgeInject(ctx, sessionId),
  }, ClaudeComposerQuota))
  // 顺序 42：接在 claude-quota(41) 之后顺延，而不是插进 38/39 之间。
  // 这串 order 只要求互不撞号且保持递增；给新线路重排既有线路的号，会让一条已经
  // 上线的线路的槽位位置无谓地变一次，顺延则旧号全部不动。
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'glm-coding-plan-quota', order: 42, locale: NS_GLM_CODING_PLAN,
    inject: (sessionId) => composerBadgeInject(ctx, sessionId),
  }, GlmCodingPlanComposerQuota))
  // 顺序 43：接在 glm-coding-plan-quota(42) 之后顺延，理由与 42 那条注释相同——
  // 既有槽位一个 order 都不动，新线路只往后拿号。
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'step-code-quota', order: 43, locale: NS_STEP_CODE,
    inject: (sessionId) => composerBadgeInject(ctx, sessionId),
  }, StepCodeComposerQuota))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: CODEX_IMAGE_TOOL_NAME,
    locale: NS,
    inject: (sessionId) => ({
      loadImage: imageLoader(ctx, sessionId),
    }),
  }, CodexImageToolView))
  // Antigravity 生图工具的结果与 Codex 生图同形（prompt 参数 + 图片块），复用同一张卡片。
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: ANTIGRAVITY_IMAGE_TOOL_NAME,
    locale: NS,
    inject: (sessionId) => ({
      loadImage: imageLoader(ctx, sessionId),
    }),
  }, CodexImageToolView))
  // MiniMax 生成视频：与上面两张生图卡片同一种解剖结构，只是媒体区换成 16:9 视频台。
  // 视频读不出来时卡片照常显示，只有视频台退回虚线占位——所以这里即使取字节日志
  // 通道缺席也不影响注册。
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: MINIMAX_VIDEO_TOOL_NAME,
    locale: NS_MINIMAX_CODE,
    inject: (sessionId) => ({
      sessionId,
      readVideo: videoBytesLoader(ctx),
    }),
  }, MinimaxVideoToolView))

  // MiniMax 视频的侧边栏渲染器：两段注册（定义 + keyed 正文），id 是同一个字符串。
  // 形状照抄宿主 ui-sidebar-documentpreview 的 image/index.ts。
  installVideoDocumentPreview(ctx)

  // 「进展更新」客户端半边：对话流进展行、侧栏面板、以及它自己的设置分区。
  // 单独一个子模块（./progress-updates/），与 kimi-code / workbuddy 这些线路同一种
  // 组织方式：入口只负责调用，注册细节留在子模块里。
  installProgressUpdatesClient(ctx)

  // MiniMax 视频的第二个用户入口：`/video` 斜杠命令 + 参数弹窗。
  //
  // 视频工具是模型自主调用的，用户唯一的入口是自然语言，于是他既不知道有哪些参数，
  // 也无从知道那些参数会怎么被联动规则改写。命令给出参数，弹窗给出表单，提交只把
  // 参数**填进输入框**——用户看一眼再发送（详见 ./minimax-code/video-command.ts）。
  //
  // 两段分开注册，理由与「进展更新」那段相同：命令挂在宿主的 commandUi 上，弹窗
  // 容器挂在 conversation.input.overlay 上，任何一段缺席都只该少一个功能，而不是
  // 让整个插件 apply 失败。
  ctx.effect(() => installVideoCommand(ctx), 'dsh-minimax-code: /video command')
  const VideoCommandHost = createVideoCommandHost(ctx)
  ctx.slots.inject('conversation.input.overlay', () => {
    try {
      return ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'minimax-video-form',
        order: 3,
        locale: NS_MINIMAX_CODE,
      }, VideoCommandHost)
    } catch {
      return () => {}
    }
  })
}

type ImageUrlResolver = (sessionId: string, attachment: ImageAttachmentRef) => Promise<string>

/**
 * The seats every composer badge is handed.
 *
 * Seven registrations each repeated this eight-line factory verbatim, and the
 * only difference between them was whether ChatGPT's own badge also reads the
 * subscription API directly. It lives here so a badge added later cannot forget
 * the directory seat (the badge resolves the session's model list through it) or
 * the reload callback that keeps that list fresh.
 *
 * The session id arrives as a plain string while the directory service takes the
 * branded one, so the cast lives here rather than at seven call sites.
 */
function composerBadgeInject(ctx: ClientContext, sessionId: string, options: { withApi?: boolean } = {}) {
  const directory = ctx.modelDirectories.directoryFor(sessionId as SessionId)
  return {
    ...(options.withApi === true ? { api: new SubscriptionApi() } : {}),
    directory: directory.store,
    loadModelDirectory: () => {
      void directory.load().catch(() => undefined)
    },
  }
}

/**
 * Why the seven registrations below are spelled out rather than driven from a
 * table.
 *
 * `ctx.slots.register` is generic over the slot key *and* the locale namespace,
 * and it is overloaded; the component's props are composed from both. A table
 * would have to hold components of different namespaces, so the correlation
 * between a row's `locale` and its `component` would be erased — and a helper
 * that keeps the correlation generically fails overload resolution inside its
 * own body, because the namespace parameter is still unresolved there. Both
 * roads end in a cast against the harness's composed-props internals, which is a
 * version-sensitive seam this plugin does not add. What each row repeats is only
 * the registration object; the eight-line seat factory is
 * {@link composerBadgeInject}.
 */

/**
 * Resolve one session-authorized image URL.
 *
 * Harness 0.1.2 moved this from `resolveImage` on `conversation` to `imageUrl`
 * on `uiConversation`, so both shapes stay supported.
 */
function imageLoader(ctx: ClientContext, sessionId: string): ImageLoader {
  const current = ctx.get('uiConversation') as unknown as { imageUrl?: ImageUrlResolver } | undefined
  const currentResolve = current?.imageUrl?.bind(current)
  if (currentResolve !== undefined) return (attachment) => currentResolve(sessionId, attachment)
  const legacy = ctx.get('conversation') as unknown as { resolveImage?: ImageUrlResolver } | undefined
  const legacyResolve = legacy?.resolveImage?.bind(legacy)
  if (legacyResolve !== undefined) return (attachment) => legacyResolve(sessionId, attachment)
  return () => Promise.reject(new Error('no client service resolves an image URL'))
}

/**
 * 从上下文里读一个**可选**的浏览器服务，读不到就当作没有。
 *
 * 只有 `get` 是 Cordis 的基础成员；没写进 `inject` 的服务名直接当属性读会抛错。
 * 而本文件要读的这几个（`remote` 的命名空间、宿主的 `documentPreviews`）都属于
 * 「装了才有」：文档预览插件不是本插件的依赖。
 *
 * 与 `./progress-updates/index.ts` 的 `serviceOf` 同形——那边这么写是因为
 * `sidebarRight*` 可选，这边同理。测试里的上下文替身没有 `get`，所以取值本身
 * 也必须包在 try 里，而不是只包 `ctx.get` 的调用。
 *
 * @param ctx - 浏览器根上下文。
 * @param name - 服务名。
 * @returns 服务实例，或 undefined。
 */
function optionalService(ctx: ClientContext, name: string): unknown {
  try {
    return (ctx as unknown as { get?: (service: string) => unknown }).get?.(name)
  } catch {
    // 上下文拒绝查询（服务不存在或已卸载）：按缺失处理。
    return undefined
  }
}

/**
 * 取视频字节：把 `ctx.remote.workspaceFiles.readBytes` 收成一条窄通道。
 *
 * 视频在浏览器里**没有别的取字节方式**：`loadImage` 是附件专用的，`<video src>`
 * 也读不到工作区。宿主侧边栏的图像预览走的正是这条远端
 * （`ui-sidebar-documentpreview/src/client/rpc.ts` 的 `ReadDocumentBytes`），
 * 这里照抄同一调用：不传 `range` 即整文件，上限由宿主 `maxFileBytes` 决定。
 *
 * 远端是**可选的**：本插件的 `inject` 只声明了 `remote`，没有声明
 * `remote.workspaceFiles` 这个命名空间，而那个命名空间由客户端装配决定装不装。
 * 取不到就交回一条恒失败的通道——两个界面都会把它显示成占位块，而不是崩掉。
 *
 * @param ctx - 浏览器根上下文。
 * @returns 与 `readBytes` 同形的取字节通道。
 */
function videoBytesLoader(ctx: ClientContext): ReadVideoBytes {
  const remote = optionalService(ctx, 'remote') as WorkspaceFilesRemote | undefined
  const workspaceFiles = remote?.workspaceFiles
  if (typeof workspaceFiles?.readBytes !== 'function') {
    return () => Promise.reject(new Error('no remote workspaceFiles reader is mounted'))
  }
  const readBytes = workspaceFiles.readBytes.bind(workspaceFiles)
  return async (sessionId, path, signal) => (await readBytes(sessionId, path, {}, signal)).data
}

/**
 * 挂载 MiniMax 视频的侧边栏渲染器。
 *
 * 两个注册各管一半，形状逐字照抄宿主
 * `ui-sidebar-documentpreview/src/client/image/index.ts`：
 *
 * 1. `documentPreviews.register` 声明「mp4/webm/mov/m4v 归我」，`priority: 'extension'`
 *    让外部实现排在内置实现之前（`document/registry.ts` 的排序规则）；
 * 2. `sidebar.right.tab.document` 的 keyed 槽用**同一个 id** 注册正文。
 *
 * 两段都包在 `ctx.effect` 里，返回注册器给的幂等卸载函数：插件行被禁用时定义与
 * 正文一起消失，不会留下一个注册了却渲染不出的实现。
 *
 * `documentPreviews` 是宿主文档预览插件通过 `ctx.reflect.provide` 给的服务，而那个
 * 包不是本插件的编译期依赖。**它缺席时正文那一段仍然注册**：槽位键是任意的，
 * 命中不了只是没人渲染；而定义缺席时多注册一段也无害。把两者绑在一起反而会让
 * 「宿主还没装好」和「本插件坏了」变成同一件事。
 *
 * @param ctx - 浏览器根上下文。
 */
function installVideoDocumentPreview(ctx: ClientContext): void {
  const registry = optionalService(ctx, 'documentPreviews') as DocumentPreviewRegistryService | undefined
  const readVideo = videoBytesLoader(ctx)
  if (typeof registry?.register === 'function') {
    const t = ctx.locale.bind(NS_MINIMAX_CODE)
    ctx.effect(
      () => registry.register(minimaxVideoPreviewDefinition(() => t('videoTitle'))),
      'dsh-minimax-code: video preview definition',
    )
  }
  ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document',
    key: MINIMAX_VIDEO_PREVIEW_ID,
    locale: NS_MINIMAX_CODE,
    inject: () => ({ readVideo }),
  }, MinimaxVideoDocumentBody))
}

