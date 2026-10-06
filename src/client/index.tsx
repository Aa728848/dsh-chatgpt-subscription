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
import { CODEX_IMAGE_TOOL_NAME } from '../compat.ts'
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
import { dictionaries as minimaxCodeDicts, NS_MINIMAX_CODE, type MinimaxCodeLocaleKey } from './minimax-code/locales.ts'
import { installMinimaxCodeStyles } from './minimax-code/styles.ts'
import { WorkBuddyComposerQuota } from './workbuddy/WorkBuddyComposerQuota.tsx'
import { dictionaries as workBuddyDicts, NS_WORKBUDDY, type WorkBuddyLocaleKey } from './workbuddy/locales.ts'
import { installWorkBuddyStyles } from './workbuddy/styles.ts'
import { dictionaries as ollamaDicts, NS_OLLAMA, type OllamaLocaleKey } from './ollama/locales.ts'
import { setupMermaidObserver } from './mermaid/renderer.ts'

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
    'dsh-ollama': OllamaLocaleKey
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
  ctx.effect(() => ctx.locale.register(NS_OLLAMA, ollamaDicts), 'dsh-ollama: dictionaries')
  ctx.effect(() => {
    installWorkBuddyStyles()
    return () => {}
  }, 'dsh-workbuddy: styles')
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
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: CODEX_IMAGE_TOOL_NAME,
    locale: NS,
    inject: (sessionId) => ({
      loadImage: imageLoader(ctx, sessionId),
    }),
  }, CodexImageToolView))
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
