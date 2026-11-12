import { adoptSessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  FIXED_LANGUAGE_DIRECTIVE,
  createLanguageNotice,
  progressSectionText,
  resolveLanguageNotice,
} from '../src/host/progress-updates/prompt.ts'

describe('progressSectionText', () => {
  it('takes no switch input, so the system prompt cannot change with the feature flag', () => {
    // The switch used to be read here, which rewrote the prompt section — and
    // with it the cached prefix — every time the user toggled the feature.
    const text = progressSectionText()
    expect(text()).toBe(text())
    expect(text().length).toBeGreaterThan(0)
  })

  it('is byte-identical whatever the language setting says', () => {
    // The language used to be read here too: changing it rewrote the section,
    // and the harness replaces the oldest system message in place when the
    // rendered prompt changes — the whole content prefix dies with it.
    const text = progressSectionText()
    expect(text()).toBe(progressSectionText()())
    expect(text()).toContain(FIXED_LANGUAGE_DIRECTIVE)
    expect(text()).toContain('the language the user is writing in')
    expect(text()).not.toContain('Simplified Chinese')
    expect(text()).not.toContain('every progress update in English')
  })

  it('pins the anti-loop rule without making the section dynamic', () => {
    const text = progressSectionText()
    expect(text()).toContain('Use exactly one opening and one closing update per multi-step task')
    expect(text()).toContain('L0 single-point work does not require opening or closing updates')
    expect(text()).toContain('Never announce an intended tool call instead of making it')
    expect(text()).toContain('repeat-tool reminder names `progress_update`')
    expect(text()).toContain('do not answer with another progress update')
    expect(text()).toBe(progressSectionText()())
  })
})

describe('resolveLanguageNotice', () => {
  it('says nothing while the model already knows the language', () => {
    expect(resolveLanguageNotice('auto', undefined).notice).toBeUndefined()
    expect(resolveLanguageNotice('auto', 'auto').notice).toBeUndefined()
    expect(resolveLanguageNotice('zh', 'zh').notice).toBeUndefined()
    expect(resolveLanguageNotice('en', 'en').notice).toBeUndefined()
  })

  it('notifies once when a fixed language is first needed', () => {
    const outcome = resolveLanguageNotice('zh', undefined)
    expect(outcome.notice?.text).toContain('Simplified Chinese')
    expect(outcome.remembered).toBe('zh')
  })

  it('notifies when the fixed language changes', () => {
    const outcome = resolveLanguageNotice('en', 'zh')
    expect(outcome.notice?.text).toContain('every progress update in English')
    expect(outcome.remembered).toBe('en')
  })

  it('notifies when the setting goes back to auto', () => {
    // The model still remembers "always Chinese"; without this notice it would
    // keep writing Chinese forever.
    const outcome = resolveLanguageNotice('auto', 'zh')
    expect(outcome.notice?.text).toContain('override ended')
    expect(outcome.remembered).toBe('auto')
  })
})

describe('createLanguageNotice', () => {
  it('builds an identified user message with the plugin source kind', () => {
    const message = createLanguageNotice('body', 'summary')
    expect(message.role).toBe('user')
    expect(message.id).toBeTruthy()
    expect(message.source.kind).toBe('progress-updates-language')
    const block = message.content[0] as { type?: string, text?: string } | undefined
    expect(block?.type).toBe('text')
    expect(block?.text).toBe('body')
  })

  it('is admitted by the real session boundary', () => {
    // The factory-built message has to survive the harness's own admission
    // check: the session validates the id, the role, the source and the
    // content before it logs a user message, and a hand-written literal is
    // refused exactly there. Exercise that boundary with the message the
    // factory produced instead of asserting a hand-written shape.
    const message = createLanguageNotice('body', 'summary')
    expect(() => adoptSessionEvent({
      type: 'user/message', seq: 0 as never, time: 0, surfaceOp: 'append', data: message as never,
    } as never)).not.toThrow()
    const adopted = adoptSessionEvent({
      type: 'user/message', seq: 0 as never, time: 0, surfaceOp: 'append', data: message as never,
    } as never)
    expect((adopted as { data?: unknown }).data).toBe(message)
  })
})
