/**
 * Registers the subscription quota card into DSH's native session details panel
 * (`conversation.session.panel.section` and `.section.actions`).
 *
 * On older harnesses that do not declare those slots, `slots.inject` never
 * invokes the callback, `isSessionPanelQuotaActive()` stays false, and the
 * bottom `conversation.input.right` composer capsules remain visible as before.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { NS_SESSION_QUOTA, zh } from './locales.ts'
import { acquireSessionPanelQuota } from './panel-availability.ts'
import { SessionQuotaReading, SessionQuotaSection, type SessionQuotaSlotProps } from './SessionQuotaSection.tsx'

export const SESSION_QUOTA_SECTION_ID = 'dsh-subscription-quota'
export const SESSION_QUOTA_SECTION_ORDER = 35

const SECTION_SLOT = 'conversation.session.panel.section'
const SECTION_ACTIONS_SLOT = 'conversation.session.panel.section.actions'

interface DynamicSlotsService {
  inject(name: string, callback: () => (() => void) | void): unknown
  register(options: Record<string, unknown>, component: unknown): () => void
}

function injectSessionSeats(ctx: ClientContext, sessionId: unknown): SessionQuotaSlotProps {
  const id = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
  if (id === undefined || !ctx.modelDirectories) return {}
  const directory = ctx.modelDirectories.directoryFor(id as SessionId)
  return {
    directory: directory.store,
    loadModelDirectory: () => {
      void directory.load().catch(() => undefined)
    },
  }
}

export function installSessionQuotaPanel(ctx: ClientContext): void {
  const slots = ctx.slots as unknown as DynamicSlotsService | undefined
  if (typeof slots?.inject !== 'function' || typeof slots?.register !== 'function') return

  const t = ctx.locale?.bind?.(NS_SESSION_QUOTA)

  slots.inject(SECTION_SLOT, () => {
    try {
      const disposeSlot = slots.register({
        name: SECTION_SLOT,
        id: SESSION_QUOTA_SECTION_ID,
        order: SESSION_QUOTA_SECTION_ORDER,
        label: () => (typeof t === 'function' ? t('sectionTitle') : zh.sectionTitle),
        locale: NS_SESSION_QUOTA,
        inject: (sessionId: unknown) => injectSessionSeats(ctx, sessionId),
      }, SessionQuotaSection)
      const releaseAvailability = acquireSessionPanelQuota()
      return () => {
        releaseAvailability()
        if (typeof disposeSlot === 'function') disposeSlot()
      }
    } catch {
      return () => {}
    }
  })

  slots.inject(SECTION_ACTIONS_SLOT, () => {
    try {
      return slots.register({
        name: SECTION_ACTIONS_SLOT,
        key: SESSION_QUOTA_SECTION_ID,
        locale: NS_SESSION_QUOTA,
        inject: (sessionId: unknown) => injectSessionSeats(ctx, sessionId),
      }, SessionQuotaReading)
    } catch {
      return () => {}
    }
  })
}
