// @vitest-environment jsdom
/**
 * The MiniMax Code reset-card panel.
 *
 * The panel is the one place in this card where a wrong sentence costs the user
 * a card, so the outcome mapping is tested twice: once as a pure function over
 * all six outcomes, and once through the rendered card, where the two
 * uncertain outcomes must keep the spent row on screen (it is the row the user
 * is told to retry with).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MinimaxCodeSection } from '../src/client/minimax-code/MinimaxCodeSection.tsx'
import { outcomeIsDecided, resetOutcomeNotice } from '../src/client/minimax-code/useMinimaxCodeSection.ts'
import { zh } from '../src/client/minimax-code/locales.ts'
import type { MinimaxCodeResetOutcome } from '../src/shared/minimax-code-contracts.ts'

const FETCHED_AT = Date.parse('2030-06-15T12:00:00Z')

const CARD_A = { cardId: 'card_a', sourceType: 'subscribe', expiresAtMs: FETCHED_AT + 86_400_000, createdAtMs: FETCHED_AT - 86_400_000, outBizNo: 'biz_a' }
const CARD_B = { cardId: 'card_b', sourceType: 'activity', expiresAtMs: FETCHED_AT + 172_800_000, createdAtMs: FETCHED_AT - 43_200_000, outBizNo: 'biz_b' }

function panel(cards: unknown[], flows: unknown[] = []) {
  return { cards, flows, fetchedAtMs: FETCHED_AT }
}

function statusPayload() {
  return {
    enabled: true,
    authenticated: true,
    account: { id: 'acc_a', label: 'me@example.com', generation: 1, expiresAtMs: FETCHED_AT },
    region: 'cn',
    storage: { kind: 'file', path: '/tmp/c.json' },
    models: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    serving: true,
    conflict: null,
    ownedByPlugin: true,
    // The card fills an absent usage read in by itself; carrying one here keeps
    // that automatic call out of the call log these tests assert on.
    quota: { label: 'Token Plan', usedPercent: 10, fetchedAtMs: FETCHED_AT },
  }
}

describe('reset-card outcome wording', () => {
  const t = (key: keyof typeof zh): string => zh[key]

  it('gives every outcome its own sentence', () => {
    const outcomes: MinimaxCodeResetOutcome[] = ['SUCCESS', 'REPLAYED', 'LOCK_BUSY', 'RETRYABLE_FAIL', 'EXPIRED', 'NOT_FOUND']
    const sentences = outcomes.map((outcome) => resetOutcomeNotice(outcome, t))
    // Six outcomes, five sentences: the two "I did not find out" answers are the
    // same sentence on purpose, because they ask for the same action.
    expect(new Set(sentences).size).toBe(5)
    expect(sentences[0]).toBe(zh.resetOutcomeSuccess)
    expect(sentences[1]).toBe(zh.resetOutcomeReplayed)
    expect(sentences[2]).toBe(zh.resetOutcomeUncertain)
    expect(sentences[3]).toBe(zh.resetOutcomeUncertain)
    expect(sentences[4]).toBe(zh.resetOutcomeExpired)
    expect(sentences[5]).toBe(zh.resetOutcomeNotFound)
  })

  it('tells the user to retry the SAME card when the outcome is uncertain', () => {
    const uncertain = resetOutcomeNotice('LOCK_BUSY', t)
    expect(uncertain).toContain('同一张卡')
    expect(resetOutcomeNotice('RETRYABLE_FAIL', t)).toBe(uncertain)
    expect(outcomeIsDecided('LOCK_BUSY')).toBe(false)
    expect(outcomeIsDecided('RETRYABLE_FAIL')).toBe(false)
  })

  it('treats every other outcome as decided, so the list is re-read', () => {
    const decidedOutcomes: MinimaxCodeResetOutcome[] = ['SUCCESS', 'REPLAYED', 'EXPIRED', 'NOT_FOUND']
    expect(decidedOutcomes.every(outcomeIsDecided)).toBe(true)
  })
})

describe('MiniMax Code reset-card panel', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const originalFetch = globalThis.fetch
  const originalConfirm = window.confirm

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    window.confirm = vi.fn(() => true)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = originalFetch
    window.confirm = originalConfirm
  })

  interface Harness {
    calls: Array<{ url: string; method: string; body?: unknown }>
    panels: number[]
  }

  function mockFetch(options: { cards?: unknown[]; flows?: unknown[]; outcome?: MinimaxCodeResetOutcome; afterCards?: unknown[] } = {}): Harness {
    const calls: Harness['calls'] = []
    const panels: number[] = []
    // The list the host serves AFTER a spend: the re-read the card performs must
    // answer with the spent card gone, or the assertion about it proves nothing.
    let served = options.cards ?? []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({
        url,
        method: init?.method ?? 'GET',
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      })
      if (url.includes('/reset-cards/use')) {
        panels.push(1)
        served = options.afterCards ?? []
        return Response.json({ ok: true, value: {
          outcome: options.outcome ?? 'SUCCESS',
          cards: panel(served),
        } })
      }
      if (url.includes('/reset-cards')) {
        panels.push(1)
        return Response.json({ ok: true, value: panel(served, options.flows ?? []) })
      }
      if (url.includes('/accounts')) {
        return Response.json({ ok: true, value: { accounts: [], rotationStrategy: 'sequential' } })
      }
      return Response.json({ ok: true, value: statusPayload() })
    }) as typeof fetch
    return { calls, panels }
  }

  async function render() {
    await act(async () => root.render(createElement(MinimaxCodeSection, {})))
  }

  function button(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find((el) => el.textContent === label)
    if (found === undefined) throw new Error(`no button labelled ${label} in: ${container.textContent}`)
    return found as HTMLButtonElement
  }

  it('shows the card count, each card expiry and the 30-day flow', async () => {
    mockFetch({
      cards: [CARD_A, CARD_B],
      flows: [
        { cardId: 'card_a', eventType: 'GRANT', createdAtMs: FETCHED_AT - 86_400_000 },
        { cardId: 'card_a', eventType: 'USE', createdAtMs: FETCHED_AT - 3_600_000 },
      ],
    })
    await render()

    const text = container.textContent ?? ''
    expect(text).toContain(zh.resetSection)
    expect(text).toContain(zh.resetAvailable.replace('{count}', '2'))
    expect(text).toContain(zh.resetConfirm)
    expect(text).toContain('card_a')
    expect(text).toContain('card_b')
    // Both event kinds of the 30-day list are drawn, not just the cards.
    expect(text).toContain(zh.resetFlowGrant)
    expect(text).toContain(zh.resetFlowUse)
    expect(text).toContain(zh.resetFlowTitle)
    // Each card's expiry, formatted by the shared helper every other line uses.
    expect(text).toContain(zh.resetExpires.replace('{time}', new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(CARD_A.expiresAtMs)))
  })

  it('disables the use button when no card is available', async () => {
    mockFetch({ cards: [] })
    await render()

    const useButton = button(zh.resetUse)
    expect(useButton.disabled).toBe(true)
    expect(container.textContent).toContain(zh.resetNone)
    // And with nothing to pick there is no card row to press either.
    expect(container.querySelectorAll('.dshm-reset-pick')).toHaveLength(0)
  })

  it('keeps the use button disabled until a card is picked', async () => {
    mockFetch({ cards: [CARD_A, CARD_B] })
    await render()

    expect(button(zh.resetUse).disabled).toBe(true)
    const picks = [...container.querySelectorAll('.dshm-reset-pick')] as HTMLButtonElement[]
    expect(picks).toHaveLength(2)
    await act(async () => picks[1]!.click())
    expect(button(zh.resetUse).disabled).toBe(false)
    expect(picks[1]!.getAttribute('aria-pressed')).toBe('true')
    expect(picks[0]!.getAttribute('aria-pressed')).toBe('false')
  })

  it('sends nothing when the confirmation is cancelled', async () => {
    const harness = mockFetch({ cards: [CARD_A] })
    window.confirm = vi.fn(() => false)
    await render()

    const pick = container.querySelector('.dshm-reset-pick') as HTMLButtonElement
    await act(async () => pick.click())
    await act(async () => button(zh.resetUse).click())

    expect(window.confirm).toHaveBeenCalledWith(zh.resetConfirm)
    expect(harness.calls.some((call) => call.url.includes('/reset-cards/use'))).toBe(false)
    expect(container.textContent).not.toContain(zh.resetOutcomeSuccess)
  })

  it('confirms with the official sentence, posts the card id and re-reads the panel', async () => {
    const harness = mockFetch({ cards: [CARD_A, CARD_B], afterCards: [CARD_B] })
    await render()

    const pick = container.querySelector('.dshm-reset-pick') as HTMLButtonElement
    await act(async () => pick.click())
    await act(async () => button(zh.resetUse).click())

    expect(window.confirm).toHaveBeenCalledWith(zh.resetConfirm)
    const use = harness.calls.find((call) => call.url.includes('/reset-cards/use'))
    expect(use?.method).toBe('POST')
    // Only the id travels: the idempotency key stays on the card the host read.
    expect(use?.body).toEqual({ cardId: 'card_a' })
    // The panel is read again after a decided outcome.
    expect(harness.calls.filter((call) => call.url.endsWith('/reset-cards'))).toHaveLength(2)
    // And the usage is re-read, which is what the confirmation sentence promises.
    expect(harness.calls.some((call) => call.url.endsWith('/quota'))).toBe(true)
    expect(container.textContent).toContain(zh.resetOutcomeSuccess)
    expect(container.textContent).toContain(zh.resetAvailable.replace('{count}', '1'))
  })

  const decided: Array<[MinimaxCodeResetOutcome, string]> = [
    ['SUCCESS', zh.resetOutcomeSuccess],
    ['REPLAYED', zh.resetOutcomeReplayed],
    ['EXPIRED', zh.resetOutcomeExpired],
    ['NOT_FOUND', zh.resetOutcomeNotFound],
  ]

  for (const [outcome, expected] of decided) {
    it(`renders the ${outcome} sentence`, async () => {
      mockFetch({ cards: [CARD_A], afterCards: [], outcome })
      await render()
      const pick = container.querySelector('.dshm-reset-pick') as HTMLButtonElement
      await act(async () => pick.click())
      await act(async () => button(zh.resetUse).click())
      const text = container.textContent ?? ''
      expect(text).toContain(expected)
      // No other outcome's sentence leaks into the panel.
      for (const [other, otherText] of decided) {
        if (other !== outcome) expect(text).not.toContain(otherText)
      }
    })
  }

  for (const outcome of ['LOCK_BUSY', 'RETRYABLE_FAIL'] as MinimaxCodeResetOutcome[]) {
    it(`keeps the ${outcome} card on screen so the SAME card can be retried`, async () => {
      // The card is still listed afterwards: the sentence tells the user to retry
      // it, so re-reading the panel here would delete the row it points at.
      const harness = mockFetch({ cards: [CARD_A, CARD_B], afterCards: [CARD_A, CARD_B], outcome })
      await render()
      const pick = container.querySelector('.dshm-reset-pick') as HTMLButtonElement
      await act(async () => pick.click())
      await act(async () => button(zh.resetUse).click())

      const text = container.textContent ?? ''
      expect(text).toContain(zh.resetOutcomeUncertain)
      expect(text).toContain('同一张卡')
      // No re-read of the panel and no usage refresh on an undecided outcome.
      expect(harness.calls.filter((call) => call.url.endsWith('/reset-cards'))).toHaveLength(1)
      expect(harness.calls.some((call) => call.url.endsWith('/quota'))).toBe(false)
      // The row survives, so pressing the same card again is possible.
      expect(container.querySelectorAll('.dshm-reset-pick')).toHaveLength(2)
    })
  }

  it('survives a host that answers the panel route with something else', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/reset-cards')) return Response.json({ ok: true, value: { cards: null, flows: null } })
      if (url.includes('/accounts')) return Response.json({ ok: true, value: { accounts: [], rotationStrategy: 'sequential' } })
      return Response.json({ ok: true, value: statusPayload() })
    }) as typeof fetch
    await render()
    expect(container.querySelectorAll('.dshm-reset-pick')).toHaveLength(0)
    expect(button(zh.resetUse).disabled).toBe(true)
  })
})
