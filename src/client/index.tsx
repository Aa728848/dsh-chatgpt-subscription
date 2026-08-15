import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { CodexSubscriptionSection } from './CodexSubscriptionSection.tsx'
import { dictionaries, NS, type LocaleKey } from './locales.ts'
import { installProcessFolding } from './process-folding.ts'
import { installStyles } from './styles.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-chatgpt-subscription': LocaleKey
  }
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-chatgpt-subscription: dictionaries')
  ctx.effect(() => installStyles(), 'dsh-chatgpt-subscription: styles')
  ctx.effect(() => installProcessFolding(), 'dsh-chatgpt-subscription: process folding')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'codex-subscription',
    order: 45,
    label: 'Codex 订阅',
    locale: NS,
  }, CodexSubscriptionSection))
}
