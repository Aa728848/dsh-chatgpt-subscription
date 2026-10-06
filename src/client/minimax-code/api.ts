/**
 * The MiniMax Code routes the settings card consumes.
 *
 * This module used to carry its own reader — the last one left after
 * `common/line-api.ts` took the other nine — and it still carried the predicate
 * the shared reader dropped: a 2xx answer of `{ ok: false, error }` with no
 * `value` was handed back as a payload instead of raising. Delegating is
 * therefore not only de-duplication: it is what makes this line answer a
 * failure exactly like its siblings.
 *
 * The names stay as they were so the hook that consumes them does not have to
 * change with the reader.
 */
import { MINIMAX_CODE_ROUTE_PREFIX } from '../../shared/minimax-code-contracts.ts'
import { createLineApi } from '../common/line-api.ts'

const api = createLineApi(MINIMAX_CODE_ROUTE_PREFIX, 'MiniMax Code')

export const request = api.request
export const get = api.get
export const post = api.post

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
