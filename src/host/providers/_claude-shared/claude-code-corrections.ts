/** Shared, deliberately narrow recognizers for pre-output protocol corrections. */
export function isClaudeSpeedUnsupported(bodyText: string): boolean {
  const text = bodyText.toLowerCase()
  return text.includes('speed') && text.includes('does not support')
}

export function isClaudeSpeedNeedsBeta(bodyText: string): boolean {
  const text = bodyText.toLowerCase()
  return text.includes('speed') && text.includes('anthropic-beta') && text.includes('fast-mode')
}

export function isClaudeSystemRoleUnsupported(bodyText: string): boolean {
  const text = bodyText.toLowerCase()
  return text.includes("role 'system'") && text.includes('is not supported')
}

export function isClaudeThinkingTokenCountUnsupported(bodyText: string): boolean {
  const text = bodyText.toLowerCase()
  return text.includes('thinking-token-count-2026-05-13')
    && (text.includes('unexpected value') || text.includes('not supported') || text.includes('does not support') || text.includes('unknown'))
}
