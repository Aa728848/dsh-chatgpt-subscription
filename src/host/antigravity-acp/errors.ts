/**
 * This line's own failure vocabulary.
 *
 * ACP failures used to come back as the harness's generic codes (`TRANSPORT`,
 * `UNSUPPORTED_OPTION`, `ACCOUNT_SIGN_IN_REQUIRED`). That reads fine in a
 * sentence and badly everywhere else: a user reporting "it says TRANSPORT" cannot
 * be helped, a log search cannot find "the agent exited", and the card cannot
 * branch on which of six very different things went wrong.
 *
 * Each code below names exactly one actionable condition, and each carries the
 * sentence that tells the user what to do. The table is duplicated in
 * `docs/antigravity-acp-line-plan.md` §8 so a support conversation and the
 * codebase use the same words.
 *
 * @module dsh-chatgpt-subscription/host/antigravity-acp/errors
 */

import { LlmError } from '../common/llm-compat.ts'

/** Every failure code this line raises. */
export const ACP_ERROR_CODES = {
  /** No cached credentials; the official process asked for a sign-in. */
  ACP_AUTH_REQUIRED: 'The Antigravity CLI is not signed in. Run `agy acp --login` or use the sign-in button in this card.',
  /** The executable is missing or cannot be started. */
  ACP_BINARY_UNAVAILABLE: 'No usable Antigravity CLI (agy) was found. Install it, or let this line download the official ACP server.',
  /** The agent process exited mid-turn. */
  ACP_DISCONNECTED: 'The Antigravity agent process ended mid-turn. Retry to reconnect.',
  /** A JSON-RPC error the line has no specific handling for. */
  ACP_RPC_ERROR: 'The Antigravity ACP server returned a JSON-RPC error.',
  /** The server rejected the request parameters or the model id. */
  ACP_INVALID_PARAMS: 'The Antigravity ACP server rejected the request parameters or the model id.',
  /** The server does not implement the method this client called. */
  ACP_METHOD_UNSUPPORTED: 'The installed Antigravity version does not support a method this line needs. Update the Antigravity CLI.',
  /** The agent ran one of its own tools instead of the DSH bridge. */
  ACP_NATIVE_TOOLS_UNSUPPORTED: 'Antigravity ran its own tool outside this harness. The turn was cancelled because that action did not pass through DSH permissions.',
  /** The agent refused the prompt. */
  ACP_REFUSAL: 'The Antigravity agent refused this prompt.',
  /** The server stopped for a reason this line does not recognise. */
  ACP_UNKNOWN_STOP: 'The Antigravity agent stopped for an unrecognised reason.',
  /** A tool result the harness produced could not be matched to its call. */
  ACP_TOOL_RESULTS_MISSING: 'A tool result was missing or duplicated when resuming this turn. Retry from the saved history.',
  /** Too many turns in flight at once. */
  ACP_SESSION_LIMIT: 'Too many Antigravity turns are running at once. Finish or cancel one and retry.',
  /** The caller asked for a sampling control ACP cannot express. */
  ACP_UNSUPPORTED_OPTION: 'ACP cannot express this sampling control. This line rejects it rather than silently ignoring it.',
  /** Cleanup could not be verified. */
  ACP_TEARDOWN_FAILED: 'The Antigravity process could not be cleaned up. Restart the profile.',
} as const

/** One code from {@link ACP_ERROR_CODES}. */
export type AcpErrorCode = keyof typeof ACP_ERROR_CODES

/**
 * Build one line-specific failure.
 *
 * @param code - The condition being reported.
 * @param detail - Optional extra fact appended after the standard sentence.
 * @returns An {@link LlmError} carrying that code.
 */
export function acpError(code: AcpErrorCode, detail?: string): LlmError {
  const base = ACP_ERROR_CODES[code]
  // LlmError's constructor is typed against the harness's built-in vocabulary;
  // this line's codes are deliberately outside it (they are more specific, and
  // the retry policy above opts into them by name). The cast is the one place
  // that boundary is crossed.
  return new LlmError(detail === undefined ? base : `${base} ${detail}`, code)
}

/** Whether a string is one of this line's codes. */
export function isAcpErrorCode(value: string): value is AcpErrorCode {
  return Object.prototype.hasOwnProperty.call(ACP_ERROR_CODES, value)
}
