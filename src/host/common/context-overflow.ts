/** Stable code understood by Harness overflow recovery, including older hosts. */
export const CONTEXT_OVERFLOW_CODE = 'CONTEXT_WINDOW_EXCEEDED'

/** Inspect provider error fields only; never classify request bodies or successful output. */
export function isContextOverflow(error: unknown): boolean {
  if (typeof error === 'string') {
    try {
      const parsed: unknown = JSON.parse(error)
      if (typeof parsed === 'object' && parsed !== null) return isContextOverflow(parsed)
    } catch { /* Plain provider diagnostics need no JSON envelope. */ }
    return /\bcontext[_ -](?:length|window)[_ -](?:exceeded|overflow|limit[_ -]exceeded)\b/i.test(error)
      || (/\b(?:maximum|max)(?: allowed| supported)? context (?:length|window)\b/i.test(error)
        && /\b(?:exceed(?:s|ed)?|requested|resulted in|reduce|too (?:long|large))\b/i.test(error))
      || /\b(?:prompt|input|request) (?:is )?too (?:long|large) for (?:the |this )?(?:model(?:'s)? )?context\b/i.test(error)
      || /\b(?:prompt|input) (?:is )?too long:\s*[\d,]+ tokens?\s*>\s*[\d,]+\s*(?:tokens?\s*)?maximum\b/i.test(error)
      || /\brequest exceeded model token limit\b/i.test(error)
      || /\b(?:input|prompt|request|messages?)\b.{0,40}\bexceed(?:s|ed)?\b.{0,40}\b(?:model(?:'s)? )?context (?:length|window)\b/i.test(error)
  }
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return false
  const fields = error as Record<string, unknown>
  return [fields.code, fields.type, fields.message, fields.error].some(value =>
    typeof value === 'string' ? isContextOverflow(value)
      : value !== error && value !== undefined && isContextOverflow(value))
}

/** Only request-rejection statuses can be reclassified as context overflow. */
export function isHttpContextOverflow(status: number, error: unknown): boolean {
  return (status === 400 || status === 413 || status === 422) && isContextOverflow(error)
}
