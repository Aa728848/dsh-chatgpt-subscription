import { describe, expect, it } from 'vitest'
import type { Message } from '../src/host/common/llm-compat.ts'
import {
  classifyPrefixDrift,
  orderStaticPrefixMessages,
  withStaticPrefixOrdering,
} from '../src/host/common/prefix-stability.ts'

function textMessage(text: string, kind?: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    ...(kind === undefined ? {} : { source: { kind } }),
  }
}

const language = () => textMessage('Progress update output language override: use Chinese', 'progress-updates-language')
const instructions = () => textMessage('<system-reminder>\nThe following workspace instructions\n</system-reminder>', 'agent-instructions')
const skills = () => textMessage('<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>', 'skill-catalog')

describe('static prefix ordering', () => {
  it('moves bootstrap tiers ahead of the dynamic task and is idempotent', () => {
    const input = [textMessage('do the task'), skills(), instructions(), language()]
    const once = orderStaticPrefixMessages(input)
    expect(once.map(message => message.source?.kind)).toEqual([
      'progress-updates-language', 'agent-instructions', 'skill-catalog', undefined,
    ])
    expect(orderStaticPrefixMessages(once)).toEqual(once)
  })

  it('leaves mid-conversation instruction deltas at their history position', () => {
    const delta = textMessage('<system-reminder>\nUpdated instructions from: AGENTS.md\n</system-reminder>', 'agent-instructions')
    const input = [textMessage('first'), delta]
    expect(orderStaticPrefixMessages(input)).toEqual(input)
  })

  it('recovers static bootstrap messages after a compaction checkpoint', () => {
    const checkpoint = textMessage('This is an automatically generated checkpoint condensing the conversation', 'compact-checkpoint')
    const input = [checkpoint, textMessage('tail'), skills(), instructions(), language()]
    const ordered = orderStaticPrefixMessages(input)
    expect(ordered.slice(0, 3).map(message => message.source?.kind)).toEqual([
      'progress-updates-language', 'agent-instructions', 'skill-catalog',
    ])
    expect(ordered[3]).toBe(checkpoint)
  })

  it('respects the provider policy and preserves object identity when off', () => {
    const options = { provider: 'codex-chatgpt', model: 'm', messages: [textMessage('task'), instructions()] }
    expect(withStaticPrefixOrdering('ollama', options)).toBe(options)
    expect(withStaticPrefixOrdering('codex-chatgpt', options)).not.toBe(options)
    expect(withStaticPrefixOrdering('codex-chatgpt', options, { staticPrefix: false })).toBe(options)
  })
})

describe('prefix drift classifier', () => {
  const current = { systemPromptHash: 'system', toolsHash: 'tools', cacheKey: 'key' }
  it('classifies lifecycle and each changed input', () => {
    expect(classifyPrefixDrift(undefined, current)).toBe('first-request')
    expect(classifyPrefixDrift(current, current)).toBe('stable')
    expect(classifyPrefixDrift(current, { ...current, cacheKey: null })).toBe('cold-key')
    expect(classifyPrefixDrift(current, { ...current, cacheKey: 'next' })).toBe('cache-key')
    expect(classifyPrefixDrift(current, { ...current, systemPromptHash: 'next' })).toBe('system-prompt')
    expect(classifyPrefixDrift(current, { ...current, toolsHash: 'next' })).toBe('tools')
  })
})
