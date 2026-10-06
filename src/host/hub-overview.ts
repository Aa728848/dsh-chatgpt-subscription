/**
 * The hub overview route: one read-only answer that summarizes every
 * subscription line, so the settings page's opening screen renders all of its
 * provider cards from a single request instead of fanning out to eight status
 * endpoints.
 *
 * Aggregation is assembled here but the facts are not: each line owns its
 * `read` closure (built in src/index.ts where that line's stores are in
 * scope), so this module never learns how a line stores accounts or what
 * "enabled" means for it. The route is GET-only and carries no secrets, so it
 * needs no same-origin mutation guard.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiEnvelope } from '../shared/contracts.ts'
import { HUB_OVERVIEW_PATH } from '../shared/hub-contracts.ts'
import type { HubOverviewDto, HubProviderSummaryDto } from '../shared/hub-contracts.ts'

export { HUB_OVERVIEW_PATH }

/** One line's contribution to the overview; the read closure is the line's own. */
export interface HubSummarySource {
  /** Client descriptor key the card is rendered from, e.g. 'chatgpt'. */
  id: string
  providerId: string
  canToggle: boolean
  read(): Promise<Omit<HubProviderSummaryDto, 'id' | 'providerId' | 'canToggle'>>
}

export function registerHubOverviewRoutes(ctx: Context, sources: readonly HubSummarySource[]): () => void {
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // The overview is a read. Rejecting every other method keeps it that way even
    // though the harness routes an exact path regardless of method.
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET', 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: { code: 'bad-request', message: 'Method not allowed.' } }))
      return
    }
    // A line whose store cannot be read must not take the whole overview down
    // with it: it degrades to a placeholder card the UI marks as unreadable,
    // and every other card still answers.
    const settled = await Promise.allSettled(sources.map(async (source) => ({
      id: source.id,
      providerId: source.providerId,
      canToggle: source.canToggle,
      ...(await source.read()),
    } satisfies HubProviderSummaryDto)))
    const providers: HubProviderSummaryDto[] = settled.map((result, index) => {
      if (result.status === 'fulfilled') return result.value
      const source = sources[index]
      return {
        id: source.id,
        providerId: source.providerId,
        canToggle: source.canToggle,
        enabled: false,
        accountCount: 0,
        authenticated: false,
        enabledModelCount: null,
        totalModelCount: null,
        error: true,
      }
    })
    const envelope: ApiEnvelope<HubOverviewDto> = { ok: true, value: { providers } }
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(JSON.stringify(envelope))
  }
  return ctx.webServer.register({ kind: 'exact', path: HUB_OVERVIEW_PATH, handler })
}
