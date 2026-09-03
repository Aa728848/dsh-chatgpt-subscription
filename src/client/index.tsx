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
import { CodexSubscriptionSection } from './CodexSubscriptionSection.tsx'
import { SubscriptionApi } from './api.ts'
import { dictionaries, NS, type LocaleKey } from './locales.ts'
import { installStyles } from './styles.ts'
import { AntigravitySection } from './antigravity/AntigravitySection.tsx'
import { installAntigravityStyles } from './antigravity/styles.ts'
import { dictionaries as antigravityDicts, NS_ANTIGRAVITY } from './antigravity/locales.ts'
import { AntigravityComposerQuota } from './antigravity/AntigravityComposerQuota.tsx'
import { setupMermaidObserver } from './mermaid/renderer.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-chatgpt-subscription': LocaleKey
    'dsh-antigravity': any
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
  ctx.effect(() => setupMermaidObserver(), 'dsh-mermaid: observer')

  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'codex-subscription',
    order: 45,
    label: () => t('title'),
    locale: NS,
  }, CodexSubscriptionSection))

  const AntigravitySectionWrapper: React.FC = () => {
    const handleModelChange = () => {
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
    return <AntigravitySection onModelChange={handleModelChange} />
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'antigravity',
    order: 46,
    label: () => 'Antigravity',
    locale: NS_ANTIGRAVITY,
  }, AntigravitySectionWrapper))
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
