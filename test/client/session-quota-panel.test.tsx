// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { ComposerQuotaBadge } from '../../src/client/common/ComposerQuotaBadge.tsx'
import type { SnapshotStore } from '../../src/client/providers/codex-chatgpt/store.ts'
import {
  antigravityToSnapshot,
  claudeToSnapshot,
  codexToSnapshot,
  type SessionQuotaAdapter,
} from '../../src/client/features/session-quota/adapters.ts'
import {
  installSessionQuotaPanel,
  SESSION_QUOTA_SECTION_ID,
} from '../../src/client/features/session-quota/index.ts'
import { zh } from '../../src/client/features/session-quota/locales.ts'
import {
  acquireSessionPanelQuota,
  isSessionPanelQuotaActive,
  resetSessionPanelQuotaForTest,
} from '../../src/client/features/session-quota/panel-availability.ts'
import {
  SessionQuotaReading,
  SessionQuotaSection,
} from '../../src/client/features/session-quota/SessionQuotaSection.tsx'
import { resetSessionQuotaCacheForTest } from '../../src/client/features/session-quota/session-quota-store.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function createDirectoryStore(provider?: string, model?: string): SnapshotStore<ModelDirectoryState> {
  const state = {
    current: provider ? { provider, model: model ?? 'default' } : undefined,
  } as unknown as ModelDirectoryState
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
  }
}

describe('session quota panel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    resetSessionPanelQuotaForTest()
    resetSessionQuotaCacheForTest()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    resetSessionPanelQuotaForTest()
    resetSessionQuotaCacheForTest()
  })

  it('activates panel availability when session panel slot is provided and restores on dispose', () => {
    const disposers: Array<() => void> = []
    const registeredSlots: Array<{ name: string; id?: string; key?: string }> = []
    const ctx = {
      locale: { bind: () => (k: keyof typeof zh) => zh[k] },
      modelDirectories: {
        directoryFor: () => ({ store: createDirectoryStore(), load: async () => {} }),
      },
      slots: {
        inject(name: string, cb: () => (() => void) | void) {
          const dispose = cb()
          if (typeof dispose === 'function') disposers.push(dispose)
        },
        register(options: { name: string; id?: string; key?: string }) {
          registeredSlots.push({ name: options.name, id: options.id, key: options.key })
          return () => {}
        },
      },
    }

    expect(isSessionPanelQuotaActive()).toBe(false)
    installSessionQuotaPanel(ctx as any)
    expect(isSessionPanelQuotaActive()).toBe(true)
    expect(registeredSlots).toEqual([
      { name: 'conversation.session.panel.section', id: SESSION_QUOTA_SECTION_ID, key: undefined },
      { name: 'conversation.session.panel.section.actions', id: undefined, key: SESSION_QUOTA_SECTION_ID },
    ])

    for (const dispose of disposers) dispose()
    expect(isSessionPanelQuotaActive()).toBe(false)
  })

  it('keeps panel availability false when host does not provide the session panel slot', () => {
    const ctx = {
      locale: { bind: () => (k: keyof typeof zh) => zh[k] },
      slots: {
        inject() {
          // older harness never invokes callback for unknown slot
        },
        register: vi.fn(),
      },
    }
    installSessionQuotaPanel(ctx as any)
    expect(isSessionPanelQuotaActive()).toBe(false)
    expect(ctx.slots.register).not.toHaveBeenCalled()
  })

  it('automatically hides ComposerQuotaBadge and skips polling when session panel slot is active', async () => {
    const readStatus = vi.fn(async () => ({ authenticated: true, remaining: 56 }))
    const release = acquireSessionPanelQuota()

    await act(async () => {
      root.render(
        <ComposerQuotaBadge
          directory={createDirectoryStore('claude-subscription')}
          loadModelDirectory={() => {}}
          providerId="claude-subscription"
          label="Claude"
          readStatus={readStatus}
          selectFacts={() => ({ text: '56%', tooltip: '56% left', level: 'normal' })}
        />,
      )
    })

    expect(container.querySelector('.dsha-composer-quota')).toBeNull()
    expect(readStatus).not.toHaveBeenCalled()

    await act(async () => {
      release()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(readStatus).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.dsha-composer-quota')?.textContent).toContain('56%')
  })

  it('renders horizontal bars, reset countdowns, and folded summary for windowed providers', async () => {
    const now = Date.UTC(2026, 10, 24, 10, 0, 0)
    const snapshot = claudeToSnapshot({
      authenticated: true,
      account: { subscriptionType: 'Pro' } as any,
      quota: {
        windows: [
          {
            id: 'five_hour',
            label: '5-hour',
            windowMinutes: 300,
            usedFraction: 0.44,
            usedPercent: 44,
            remainingPercent: 56,
            resetsAt: new Date(now + 3 * 3_600_000 + 45 * 60_000).toISOString(),
            source: 'usage',
          },
          {
            id: 'seven_day',
            label: 'Weekly',
            windowMinutes: 10_080,
            usedFraction: 0.59,
            usedPercent: 59,
            remainingPercent: 41,
            resetsAt: new Date(now + 6 * 86_400_000 + 12 * 3_600_000).toISOString(),
            source: 'usage',
          },
        ],
      } as any,
    } as any, 'claude-sonnet', zh, now)

    expect(snapshot).not.toBeNull()
    expect(snapshot?.planBadge).toBe('Pro')
    expect(snapshot?.summaryText).toBe('41%')
    expect(snapshot?.bars).toHaveLength(2)
    expect(snapshot?.bars[0]?.resetText).toBe('3 小时 45 分钟后重置')
    expect(snapshot?.bars[1]?.resetText).toBe('6 天 12 小时后重置')

    const readStatus = vi.fn(async () => ({ ok: true }))
    const adapters = new Map<string, SessionQuotaAdapter>([
      ['claude-subscription', {
        providerId: 'claude-subscription',
        readStatus,
        toSnapshot: () => snapshot,
      }],
    ])

    await act(async () => {
      root.render(
        <>
          <SessionQuotaSection
            directory={createDirectoryStore('claude-subscription')}
            loadModelDirectory={() => {}}
            adapters={adapters}
          />
          <SessionQuotaReading
            directory={createDirectoryStore('claude-subscription')}
            loadModelDirectory={() => {}}
            adapters={adapters}
          />
        </>,
      )
    })

    // Section and Reading share one single provider fetch
    expect(readStatus).toHaveBeenCalledTimes(1)
    expect(container.querySelectorAll('.dsh-sq-bar-item')).toHaveLength(2)
    expect(container.querySelector('.dsh-sq-tier')?.textContent).toBe('Pro')
    expect(container.querySelector('.dsh-sq-reading')?.textContent).toContain('41%')
    expect(container.querySelector('.dsh-sq-reading-mini')).not.toBeNull()

    // Clicking refresh triggers forced refresh
    const refreshBtn = container.querySelector<HTMLButtonElement>('.dsh-sq-refresh')
    expect(refreshBtn).not.toBeNull()
    await act(async () => {
      refreshBtn?.click()
    })
    expect(readStatus).toHaveBeenCalledWith(true)
  })

  it('renders Antigravity (ACP) tier and last-turn token usage without fabricated percentage bars', async () => {
    const snapshot = antigravityToSnapshot({
      auth: { authenticated: true, tier: { id: 'ultra', name: 'Google AI Ultra' } },
      usage: { inputTokens: 12_400, outputTokens: 3_200 },
    } as any, 'gemini-4-neon', zh)

    expect(snapshot).not.toBeNull()
    expect(snapshot?.planBadge).toBe('Google AI Ultra')
    expect(snapshot?.summaryText).toBe('Google AI Ultra')
    expect(snapshot?.summaryPercent).toBeNull()
    expect(snapshot?.bars).toHaveLength(0)
    expect(snapshot?.facts.map((f) => [f.label, f.value])).toEqual([
      [zh.planTier, 'Google AI Ultra'],
      [zh.lastInput, '12K'],
      [zh.lastOutput, '3.2K'],
    ])

    const adapters = new Map<string, SessionQuotaAdapter>([
      ['antigravity-acp', {
        providerId: 'antigravity-acp',
        readStatus: async () => ({}),
        toSnapshot: () => snapshot,
      }],
    ])

    await act(async () => {
      root.render(
        <>
          <SessionQuotaSection
            directory={createDirectoryStore('antigravity-acp')}
            loadModelDirectory={() => {}}
            adapters={adapters}
          />
          <SessionQuotaReading
            directory={createDirectoryStore('antigravity-acp')}
            loadModelDirectory={() => {}}
            adapters={adapters}
          />
        </>,
      )
    })

    expect(container.querySelectorAll('.dsh-sq-bar-item')).toHaveLength(0)
    expect(container.querySelectorAll('.dsh-sq-fact')).toHaveLength(3)
    expect(container.querySelector('.dsh-sq-reading')?.textContent).toBe('Google AI Ultra')
    expect(container.querySelector('.dsh-sq-reading-mini')).toBeNull()
  })

  it('returns null for non-subscription providers so host hides the section', async () => {
    await act(async () => {
      root.render(
        <SessionQuotaSection
          directory={createDirectoryStore('deepseek-official')}
          loadModelDirectory={() => {}}
        />,
      )
    })
    expect(container.innerHTML).toBe('')
  })

  it('formats Codex windows sorted shortest-first with Unix-second resetsAt', () => {
    const now = Date.UTC(2026, 10, 24, 10, 0, 0)
    const snapshot = codexToSnapshot({
      preferences: { quickQuotaVisible: true },
      quota: {
        buckets: [{
          id: 'codex',
          name: 'Codex',
          planType: 'Plus',
          primary: null,
          secondary: null,
          windows: [
            { usedPercent: 59, windowDurationMins: 10_080, resetsAt: Math.floor((now + 2 * 86_400_000) / 1000) },
            { usedPercent: 18, windowDurationMins: 300, resetsAt: Math.floor((now + 2 * 3_600_000) / 1000) },
          ],
        }],
        credits: null,
        resetCredits: null,
      },
    } as any, 'gpt-5-codex', zh, now)

    expect(snapshot?.bars.map((b) => b.label)).toEqual([zh.windowFiveHour, zh.windowWeekly])
    expect(snapshot?.summaryText).toBe('41%')
  })
})
