import { describe, expect, it } from 'vitest'
import { matchTeamPattern, resolveTeamModelRule } from '../src/shared/preferences.ts'
import type { TeamModelRule } from '../src/shared/contracts.ts'

describe('Agent Teams Model Rules', () => {
  it('correctly matches wildcard and exact patterns', () => {
    expect(matchTeamPattern('reviewer', 'reviewer')).toBe(true)
    expect(matchTeamPattern('Reviewer', 'reviewer')).toBe(true)
    expect(matchTeamPattern('reviewer', 'coder')).toBe(false)

    expect(matchTeamPattern('review*', 'reviewer')).toBe(true)
    expect(matchTeamPattern('review*', 'review_bot')).toBe(true)
    expect(matchTeamPattern('review*', 'pre-review')).toBe(false)

    expect(matchTeamPattern('*test', 'qa-test')).toBe(true)
    expect(matchTeamPattern('*test', 'test-runner')).toBe(false)

    expect(matchTeamPattern('*code*', 'expert-coder-agent')).toBe(true)

    expect(matchTeamPattern('*', 'anything')).toBe(true)

    expect(matchTeamPattern('', 'anything')).toBe(false)
    expect(matchTeamPattern('test', '')).toBe(false)
  })

  it('resolves the first matching rule in order of priority', () => {
    const rules: TeamModelRule[] = [
      { id: '1', pattern: 'review*', model: 'gpt-6-astra', reasoningEffort: 'high' },
      { id: '2', pattern: 'code*', model: 'gpt-5.6-sol' },
      { id: '3', pattern: 'fast*', model: 'deepseek/deepseek-v41-flash' },
      { id: '4', pattern: '*', model: 'gpt-5.4-mini' },
    ]

    const matchReviewer = resolveTeamModelRule('reviewer-1', rules)
    expect(matchReviewer?.model).toBe('gpt-6-astra')
    expect(matchReviewer?.reasoningEffort).toBe('high')

    const matchCoder = resolveTeamModelRule('coder-bot', rules)
    expect(matchCoder?.model).toBe('gpt-5.6-sol')

    const matchFast = resolveTeamModelRule('fast-search', rules)
    expect(matchFast?.model).toBe('deepseek/deepseek-v41-flash')

    const matchUnknown = resolveTeamModelRule('unregistered-role', rules)
    expect(matchUnknown?.model).toBe('gpt-5.4-mini')
  })

  it('returns undefined when no rules match', () => {
    const rules: TeamModelRule[] = [
      { id: '1', pattern: 'review*', model: 'gpt-6-astra' },
    ]

    expect(resolveTeamModelRule('coder', rules)).toBeUndefined()
    expect(resolveTeamModelRule('', rules)).toBeUndefined()
  })
})
