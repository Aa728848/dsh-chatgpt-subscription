import type { GenerateOptions } from '../../common/llm-compat.ts'
import type { ResolvedRequestImages } from '../../common/request-images.ts'
import type { OpenCodeGoProtocol } from '../../../shared/opencode-go-contracts.ts'
import { buildOpenCodeGoChatRequest } from './mapper.ts'
import { buildOpenCodeGoResponsesRequest } from './mapper-responses.ts'
import { buildOpenCodeGoMessagesRequest } from './mapper-messages.ts'
import { buildOpenCodeGoGeminiRequest } from './mapper-gemini.ts'
import { createOpenCodeGoChatDriver, type OpenCodeGoLineDriver } from './native-shared.ts'
import { createOpenCodeGoMessagesDriver } from './mapper-messages.ts'
import type { OpenCodeGoModelEntry } from './model-catalog.ts'
import type { OpenCodeGoSettings } from './token-store.ts'
import { OPENCODE_GO_CHAT_URL } from './types.ts'

export function openCodeGoProtocolTarget(protocol: OpenCodeGoProtocol, options: GenerateOptions, images: ResolvedRequestImages, entry: OpenCodeGoModelEntry, settings: OpenCodeGoSettings): { url: string; body: Record<string, unknown> } {
  if (protocol === 'responses') return { url: entry.apiBaseUrl + '/responses', body: buildOpenCodeGoResponsesRequest(options, images, entry, settings) }
  if (protocol === 'messages') return { url: entry.apiBaseUrl + '/messages', body: buildOpenCodeGoMessagesRequest(options, images, entry, settings) }
  if (protocol === 'generate-content') return { url: entry.apiBaseUrl + '/models/' + encodeURIComponent(options.model) + ':streamGenerateContent?alt=sse', body: buildOpenCodeGoGeminiRequest(options, images, entry, settings) }
  return { url: OPENCODE_GO_CHAT_URL, body: buildOpenCodeGoChatRequest(options, images, entry, settings) }
}

export function createOpenCodeGoLineDriver(protocol: OpenCodeGoProtocol): OpenCodeGoLineDriver {
  return protocol === 'messages' ? createOpenCodeGoMessagesDriver() : createOpenCodeGoChatDriver()
}

export function isOpenCodeGoProtocolUnsupported(status: number, detail: string): boolean {
  if (status === 404) return !/(?:model|deployment).*(?:not found|does not exist|unknown)|unknown model/i.test(detail)
  if (status === 405 || status === 415) return true
  if (status !== 400 && status !== 422) return false
  if (/context length|maximum context|too many tokens|max_tokens|max_output_tokens/i.test(detail)) return false
  return /unsupported (?:api|protocol|endpoint)|not supported|unknown (?:api|protocol|endpoint)|no route|method not allowed/i.test(detail)
}