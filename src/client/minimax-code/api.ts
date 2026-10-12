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
import {
  MINIMAX_CODE_ROUTE_PREFIX,
  type MinimaxCodeResetCardsDto,
  type MinimaxCodeResetResultDto,
} from '../../shared/minimax-code-contracts.ts'
import { createLineApi } from '../common/line-api.ts'

const api = createLineApi(MINIMAX_CODE_ROUTE_PREFIX, 'MiniMax Code')

export const request = api.request
export const get = api.get
export const post = api.post

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * The reset-card panel: the cards still held, plus the recent flow.
 *
 * Goes through the shared reader, so a host half that is older than this one
 * produces the reader's "restart DSH" sentence rather than a bare parse crash.
 */
export function fetchResetCards(): Promise<MinimaxCodeResetCardsDto> {
  return get<MinimaxCodeResetCardsDto>('/reset-cards')
}

/**
 * Spend one card.
 *
 * The body carries the `cardId` and nothing else — deliberately. The card's
 * idempotency key is a field the service de-duplicates on, so letting the
 * browser supply one would let a client spend a card it never read. The host
 * looks the card up and sends the key it found.
 */
export function useResetCard(cardId: string): Promise<MinimaxCodeResetResultDto> {
  return post<MinimaxCodeResetResultDto>('/reset-cards/use', { cardId })
}
