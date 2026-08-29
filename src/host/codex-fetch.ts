import { WebError, type WebFetchProvider, type WebFetchRequest, type WebFetchResult } from '@deepseek-ai/dsh-web'
import { CODEX_FETCH_PROVIDER_ID } from '../compat.ts'

type FetchLike = typeof fetch

export interface CodexFetchProviderOptions {
  fetchFn?: FetchLike
  maxBodyLength?: number
}

const DEFAULT_MAX_BODY_LENGTH = 2 * 1024 * 1024 // 2MB

export function createCodexFetchProvider(
  options: CodexFetchProviderOptions = {},
): WebFetchProvider {
  const fetchFn = options.fetchFn ?? fetch
  const maxBodyLength = options.maxBodyLength ?? DEFAULT_MAX_BODY_LENGTH

  return {
    id: CODEX_FETCH_PROVIDER_ID,
    available: () => true,
    async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
      const targetUrl = request.url?.trim() ?? ''
      if (!isHttpUrl(targetUrl)) {
        throw new WebError(`Invalid or unsupported URL: "${targetUrl}"`, 'WEB_PROVIDER_INVALID_URL')
      }

      let response: Response
      try {
        response = await fetchFn(targetUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          },
          redirect: 'follow',
          signal,
        })
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw new WebError('Web fetch request was aborted.', 'WEB_PROVIDER_CANCELLED', { cause: error })
        }
        throw new WebError(`Failed to fetch web page: ${error instanceof Error ? error.message : String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
      }

      const finalUrl = response.url || targetUrl
      const statusCode = response.status
      const contentType = (response.headers?.get?.('content-type') ?? '').toLowerCase()
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml')
      const kind = isHtml ? 'html' as const : 'text' as const

      let rawText = ''
      try {
        rawText = await response.text()
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw new WebError('Web fetch body reading was aborted.', 'WEB_PROVIDER_CANCELLED', { cause: error })
        }
        throw new WebError(`Failed to read response body: ${error instanceof Error ? error.message : String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
      }

      const truncated = rawText.length > maxBodyLength
      const content = truncated ? rawText.slice(0, maxBodyLength) : rawText

      return {
        url: finalUrl,
        statusCode,
        body: {
          kind,
          content,
        },
        truncated,
      }
    },
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
