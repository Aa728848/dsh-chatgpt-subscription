import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { CODEX_IMAGE_TOOL_NAME } from '../compat.ts'
import { CodexComposerQuota } from './CodexComposerQuota.tsx'
import { CodexImageToolView, type ImageLoader } from './CodexImageToolView.tsx'
import { ProviderHubSection } from './ProviderHubSection.tsx'
import { SubscriptionApi } from './api.ts'
import { dictionaries, NS, type LocaleKey } from './locales.ts'
import { installStyles } from './styles.ts'
import { installAntigravityStyles } from './antigravity/styles.ts'
import { dictionaries as antigravityDicts, NS_ANTIGRAVITY } from './antigravity/locales.ts'
import { AntigravityComposerQuota } from './antigravity/AntigravityComposerQuota.tsx'
import { CommandCodeComposerQuota } from './command-code/CommandCodeComposerQuota.tsx'
import { dictionaries as commandCodeDicts, NS_COMMAND_CODE } from './command-code/locales.ts'
import { KimiCodeComposerQuota } from './kimi-code/KimiCodeComposerQuota.tsx'
import { dictionaries as kimiCodeDicts, NS_KIMI_CODE } from './kimi-code/locales.ts'
import { installKimiCodeStyles } from './kimi-code/styles.ts'
import { setupMermaidObserver } from './mermaid/renderer.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-chatgpt-subscription': LocaleKey
    'dsh-antigravity': any
    'dsh-command-code': any
    'dsh-kimi-code': any
  }
}

export const inject = ['slots', 'locale', 'modelDirectories', 'conversation']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-chatgpt-subscription: dictionaries')
  ctx.effect(() => installStyles(), 'dsh-chatgpt-subscription: styles')
  ctx.effect(() => ctx.locale.register(NS_ANTIGRAVITY, antigravityDicts), 'dsh-antigravity: dictionaries')
  ctx.effect(() => {
    installAntigravityStyles()
    return () => {}
  }, 'dsh-antigravity: styles')
  ctx.effect(() => ctx.locale.register(NS_COMMAND_CODE, commandCodeDicts), 'dsh-command-code: dictionaries')
  ctx.effect(() => ctx.locale.register(NS_KIMI_CODE, kimiCodeDicts), 'dsh-kimi-code: dictionaries')
  ctx.effect(() => {
    installKimiCodeStyles()
    return () => {}
  }, 'dsh-kimi-code: styles')
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
    name: 'conversation.input.right',
    id: 'codex-subscription-quota',
    order: 35,
    locale: NS,
    inject: (sessionId) => {
      const directory = ctx.modelDirectories.directoryFor(sessionId)
      return {
        api: new SubscriptionApi(),
        directory: directory.store,
        loadModelDirectory: () => {
          void directory.load().catch(() => undefined)
        },
      }
    },
  }, CodexComposerQuota))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'antigravity-quota',
    order: 36,
    locale: NS_ANTIGRAVITY,
    inject: (sessionId) => {
      const directory = ctx.modelDirectories.directoryFor(sessionId)
      return {
        directory: directory.store,
        loadModelDirectory: () => {
          void directory.load().catch(() => undefined)
        },
      }
    },
  }, AntigravityComposerQuota))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'command-code-quota',
    order: 37,
    locale: NS_COMMAND_CODE,
    inject: (sessionId) => {
      const directory = ctx.modelDirectories.directoryFor(sessionId)
      return {
        directory: directory.store,
        loadModelDirectory: () => {
          void directory.load().catch(() => undefined)
        },
      }
    },
  }, CommandCodeComposerQuota))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'kimi-code-quota',
    order: 38,
    locale: NS_KIMI_CODE,
    inject: (sessionId) => {
      const directory = ctx.modelDirectories.directoryFor(sessionId)
      return {
        directory: directory.store,
        loadModelDirectory: () => {
          void directory.load().catch(() => undefined)
        },
      }
    },
  }, KimiCodeComposerQuota))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: CODEX_IMAGE_TOOL_NAME,
    locale: NS,
    inject: (sessionId) => ({
      loadImage: imageLoader(ctx, sessionId),
    }),
  }, CodexImageToolView))
}

function imageLoader(ctx: ClientContext, sessionId: string): ImageLoader {
  const conversation = ctx.conversation as unknown as {
    resolveImage(sessionId: string, attachment: ImageAttachmentRef): Promise<string>
  }
  return (attachment) => conversation.resolveImage(sessionId, attachment)
}
