import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'
import { buildResponsesPayload } from '../src/host/responses-mapper.ts'
import { codexToolUpdateMode, disableCodexToolUpdate, resetCodexToolUpdateLatch } from '../src/host/model-catalog.ts'
import { withoutCodexToolChanges } from '../src/host/responses-mapper.ts'

const unusedAttachments = () => ({
  readImage: async () => { throw new Error('unused') },
})

// The standard (non-Lite) shape is the one that carries a top-level `tools`
// array, so the assertions below have to see it. Lite folds every declaration
// into one namespace item and states no top-level list at all.
const payloadFor = (options: Record<string, unknown>) => buildResponsesPayload(
  { provider: 'codex-chatgpt', model: 'gpt-6-sol', messages: [], ...options } as unknown as GenerateOptions,
  unusedAttachments(),
  {},
  null,
  false,
  null,
  undefined,
  { useResponsesLite: false },
)

const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
  ...extra,
})

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })

/**
 * The whole point of `toolUpdate: 'in-history'` on this line: the head is the
 * prefix every request is cached against, so a mid-conversation tool change must
 * never touch it. These assertions are the regression guard for that.
 */
describe('codex tool changes stay out of the request head', () => {
  afterEach(() => {
    delete process.env.DSH_CODEX_TOOL_UPDATE
    resetCodexToolUpdateLatch()
  })

  it('latches a refused backend off for the rest of the process', () => {
    expect(codexToolUpdateMode()).toBe('in-history')

    // One 400 while carrying a tool change must not become the same 400 on
    // every later turn.
    disableCodexToolUpdate()
    expect(codexToolUpdateMode()).toBeUndefined()
  })

  it('falls back to the pre-capability shape when stripped', async () => {
    const stripped = withoutCodexToolChanges({
      provider: 'codex-chatgpt',
      model: 'gpt-6-sol',
      messages: [user('first'), {
        role: 'developer',
        content: [{ type: 'tool-addition', toolName: 'added' }],
      }],
      tools: [tool('base'), tool('added', { deferLoading: true })],
    } as unknown as GenerateOptions)

    // No change messages, no deferred markers: the shape this line sent before
    // the capability existed.
    expect(stripped.messages).toHaveLength(1)
    expect((stripped.tools as { deferLoading?: true }[]).every((entry) => entry.deferLoading === undefined)).toBe(true)

    const payload = await payloadFor({
      messages: stripped.messages,
      tools: stripped.tools,
    })
    expect((payload.input as Record<string, unknown>[]).some((item) => item['type'] === 'additional_tools')).toBe(false)
    expect((payload.tools as { name: string }[]).map((entry) => entry.name)).toEqual(['base', 'added'])
  })

  it('declares the capability by default and honours the escape hatch', () => {
    expect(codexToolUpdateMode()).toBe('in-history')

    process.env.DSH_CODEX_TOOL_UPDATE = '0'
    expect(codexToolUpdateMode()).toBeUndefined()
  })

  it('keeps a deferred declaration out of the head', async () => {
    const payload = await payloadFor({
      tools: [tool('base'), tool('added', { deferLoading: true })],
    })

    const names = (payload.tools as { name: string }[]).map((entry) => entry.name)
    expect(names).toEqual(['base'])
  })

  it('carries an addition as an additional_tools item at its position', async () => {
    const payload = await payloadFor({
      messages: [user('first'), {
        role: 'developer',
        content: [{ type: 'tool-addition', toolName: 'added' }],
      }, user('next')],
      tools: [tool('base'), tool('added', { deferLoading: true })],
    })

    const items = payload.input as Record<string, unknown>[]
    const at = items.findIndex((item) => item['type'] === 'additional_tools')
    expect(at).toBeGreaterThan(0)
    const addition = items[at] as { tools: { name: string }[] }
    expect(addition.tools.map((entry) => entry.name)).toEqual(['added'])
    // The item lands where the change happened, not at the head: everything
    // before it keeps the prefix it was cached under.
    expect(at).toBeGreaterThan(items.findIndex((item) => item['role'] === 'user'))
  })

  it('states a removal as a note and keeps the declaration', async () => {
    const payload = await payloadFor({
      messages: [user('first'), {
        role: 'developer',
        content: [{ type: 'tool-removal', toolName: 'withdrawn' }],
      }],
      tools: [tool('base'), tool('withdrawn')],
    })

    // Dropping the declaration would shorten the head and invalidate the prefix.
    const names = (payload.tools as { name: string }[]).map((entry) => entry.name)
    expect(names).toContain('withdrawn')

    const items = payload.input as Record<string, unknown>[]
    const note = items.find((item) => {
      const content = item['content']
      return item['role'] === 'developer'
        && Array.isArray(content)
        && String((content[0] as { text?: string } | undefined)?.text ?? '').includes('no longer available')
    })
    expect(note).toBeDefined()
  })

  it('renders a developer message that mixes text and a change', async () => {
    const payload = await payloadFor({
      messages: [{
        role: 'developer',
        content: [
          { type: 'text', text: 'Permissions changed.' },
          { type: 'tool-addition', toolName: 'added' },
        ],
      }],
      tools: [tool('added', { deferLoading: true })],
    })

    const items = payload.input as Record<string, unknown>[]
    expect(items.some((item) => item['type'] === 'additional_tools')).toBe(true)
    // The prose survives as its own developer item; only the change block is
    // consumed by the item above.
    expect(items.some((item) => item['role'] === 'developer' && item['type'] !== 'additional_tools')).toBe(true)
  })
})
