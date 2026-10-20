/** Stable code understood by Harness overflow recovery, including older hosts. */
export const CONTEXT_OVERFLOW_CODE = 'CONTEXT_WINDOW_EXCEEDED'

/** Inspect provider error fields only; never classify request bodies or successful output. */
export function isContextOverflow(error: unknown): boolean {
  if (typeof error === 'string') {
    try {
      const parsed: unknown = JSON.parse(error)
      if (typeof parsed === 'object' && parsed !== null) return isContextOverflow(parsed)
    } catch { /* Plain provider diagnostics need no JSON envelope. */ }
    // The provider wording, in four shapes.
    //
    // The MiniMax ones are the service's own: the upstream client records
    // that MiniMax reports an over-window prompt as
    // `invalid params, context window exceeds limit (2013)`, and the bare
    // 2013 is a generic invalid-params code - this plugin uses 2013 for two
    // OTHER things (the reset-card route and the Files API upload), so the
    // code is deliberately NOT the judge here, only the words are.
    //
    // Before this list, every one of these four strings read as "not an
    // overflow", so a real overflow on this line fell through to the plain 400
    // branch: no CONTEXT_WINDOW_EXCEEDED, no compaction recovery, and a
    // session that cannot continue.
    return /\bcontext[_ -](?:length|window)[_ -](?:exceeded|overflow|limit[_ -]exceeded)\b/i.test(error)
      || /\bcontext window exceeds limit\b/i.test(error)
      || (/\b(?:maximum|max)(?: allowed| supported)? context (?:length|window)\b/i.test(error)
        && /\b(?:exceed(?:s|ed)?|requested|resulted in|reduce|too (?:long|large))\b/i.test(error))
      || /\b(?:prompt|input|request) (?:is )?too (?:long|large) for (?:the |this )?(?:model(?:'s)? )?context\b/i.test(error)
      || /\b(?:prompt|input) (?:is )?too long:\s*[\d,]+ tokens?\s*>\s*[\d,]+\s*(?:tokens?\s*)?maximum\b/i.test(error)
      // "prompt is too long" is the canonical over-window wording, but "prompt
      // is too long IN BYTES" is a byte ceiling - a different refusal that
      // compaction does not answer. The lookahead keeps the two apart.
      || /\bprompt is too long\b(?!\s+in\s+bytes)/i.test(error)
      || /\binput is too long\b(?!\s+in\s+bytes)/i.test(error)
      || /\brequest exceeded model token limit\b/i.test(error)
      || /\b(?:input|prompt|request|messages?)\b.{0,40}\bexceed(?:s|ed)?\b.{0,40}\b(?:model(?:'s)? )?context (?:length|window)\b/i.test(error)
  }
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return false
  const fields = error as Record<string, unknown>
  // The field names are not one envelope's. MiniMax puts the same verdict in
  // two different places - `errorReason` on one, `base_resp.status_msg` on
  // the other - so a detector that only reads `code`/`message` sees a
  // MiniMax overflow as an ordinary error, and the compaction recovery never
  // runs. The values still have to match the words above; only the places
  // being read widened.
  return [fields.code, fields.type, fields.message, fields.error, fields.errorReason, fields.status_msg, fields.base_resp]
    .some(value =>
      typeof value === 'string' ? isContextOverflow(value)
        : value !== error && value !== undefined && isContextOverflow(value))
}

/** Only request-rejection statuses can be reclassified as context overflow. */
export function isHttpContextOverflow(status: number, error: unknown): boolean {
  return (status === 400 || status === 413 || status === 422) && isContextOverflow(error)
}
